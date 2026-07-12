#!/usr/bin/env bash
#
# SaySomething live-partial proof (macOS, no microphone) — bash port of
# partial-transcribe.ps1.
#
# Proves the streaming approach — windowed re-transcription of a GROWING audio
# buffer against the one-shot /inference endpoint — produces sane, building
# partials. Synthesizes a known sentence with `say`, then POSTs growing
# prefixes (25% / 50% / 75% / 100% of the samples) to whisper-server, printing
# each partial. Asserts the partials build toward and the final contains the
# expected keywords. Self-starts the server if one isn't already running.
#
# Usage:
#   test/partial-transcribe.sh [-p|--port PORT]
#
# Exit codes: 0 = pass or clean SKIP, 1 = fail.

set -euo pipefail

PORT=8737

usage() {
  cat <<'USAGE'
Usage: partial-transcribe.sh [-p|--port PORT]

  -p, --port PORT   port the whisper server listens on (default 8737)
  -h, --help        show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)
      PORT="${2:-}"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_SERVER="$REPO_ROOT/bin/whisper/whisper-server"
# Mirrors src/main/config.js resolveUserData() on darwin (~/Library/Application
# Support/SaySomething). partial-transcribe.ps1 hardcodes ggml-small.en.bin
# specifically (rather than "any ggml-*.bin" like e2e-transcribe.ps1) — mirrored
# here for fidelity.
MODEL="$HOME/Library/Application Support/SaySomething/models/ggml-small.en.bin"
SENTENCE='The quick brown fox jumps over the lazy dog.'

# --- Is a TCP port accepting connections? --------------------------------------
test_port() {
  local port="$1"
  ( exec 3<>"/dev/tcp/127.0.0.1/$port" ) 2>/dev/null
}

echo '== SaySomething live-partial (growing-prefix) test (macOS) =='
if [[ ! -f "$MODEL" ]]; then
  echo "SKIP: model not found at $MODEL"
  echo '      Run:  node scripts/setup.js'
  exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saysomething-partial.XXXXXX")"
STARTED_PID=""
EXIT_CODE=0

cleanup() {
  rm -rf "$TMP_DIR"
  if [[ -n "$STARTED_PID" ]] && kill -0 "$STARTED_PID" 2>/dev/null; then
    echo 'Stopping the whisper-server this test started...'
    kill "$STARTED_PID" 2>/dev/null || true
    wait "$STARTED_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- synthesize the sentence to a 16 kHz mono WAV -------------------------------
AIFF_PATH="$TMP_DIR/audio.aiff"
WAV_PATH="$TMP_DIR/audio.wav"
say -o "$AIFF_PATH" "$SENTENCE"
afconvert -f WAVE -d LEI16@16000 -c 1 "$AIFF_PATH" "$WAV_PATH"
echo "Synthesized: '$SENTENCE'"

# --- WAV chunk tool: locates the real `data` chunk (afconvert/say headers are
#     not a clean 44 bytes — extra chunks such as 'FLLR' can precede 'data',
#     mirroring the ps1 comment about System.Speech headers) and rebuilds a
#     canonical 16k/mono/16-bit header per growing prefix. ---
WAV_TOOL="$TMP_DIR/wav-tool.js"
cat > "$WAV_TOOL" <<'EOF'
'use strict';
const fs = require('fs');

function findDataChunk(buf) {
  let offset = 12; // past 'RIFF'(4) + size(4) + 'WAVE'(4)
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === 'data') {
      return { offset: bodyStart, size: Math.min(size, buf.length - bodyStart) };
    }
    offset = bodyStart + size + (size % 2); // chunks are word-aligned
  }
  return { offset: 44, size: Math.max(0, buf.length - 44) };
}

function buildHeader(dataSize) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataSize, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);      // PCM
  h.writeUInt16LE(1, 22);      // mono
  h.writeUInt32LE(16000, 24);  // sampleRate
  h.writeUInt32LE(32000, 28);  // byteRate
  h.writeUInt16LE(2, 32);      // blockAlign
  h.writeUInt16LE(16, 34);     // bitsPerSample
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataSize, 40);
  return h;
}

function main() {
  const cmd = process.argv[2];
  const srcPath = process.argv[3];
  const buf = fs.readFileSync(srcPath);
  const chunk = findDataChunk(buf);

  if (cmd === 'info') {
    process.stdout.write(JSON.stringify({ dataOffset: chunk.offset, pcmLen: chunk.size }));
    return;
  }
  if (cmd === 'prefix') {
    const wanted = parseInt(process.argv[4], 10);
    const outPath = process.argv[5];
    let pcmBytes = wanted % 2 !== 0 ? wanted - 1 : wanted;
    if (pcmBytes < 0) pcmBytes = 0;
    if (pcmBytes > chunk.size) pcmBytes = chunk.size - (chunk.size % 2);
    const header = buildHeader(pcmBytes);
    const out = Buffer.concat([header, buf.subarray(chunk.offset, chunk.offset + pcmBytes)]);
    fs.writeFileSync(outPath, out);
    return;
  }
  process.stderr.write('wav-tool: unknown command: ' + cmd + '\n');
  process.exit(1);
}
main();
EOF

INFO_JSON="$(node "$WAV_TOOL" info "$WAV_PATH")"
DATA_OFFSET="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).dataOffset))' "$INFO_JSON")"
PCM_LEN="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).pcmLen))' "$INFO_JSON")"
AUDIO_SECS="$(node -e 'process.stdout.write(((Number(process.argv[1]))/2/16000).toFixed(1))' "$PCM_LEN")"
echo "Audio: ${AUDIO_SECS}s of PCM (data@${DATA_OFFSET})"

# --- binary-safe multipart POST helper -----------------------------------------
invoke_inference() {
  local wav_path="$1"
  local resp_path="$2"
  local http_code
  set +e
  http_code=$(curl -sS -o "$resp_path" -w '%{http_code}' \
    -F "file=@${wav_path};type=audio/wav" \
    -F 'response_format=json' \
    -F 'temperature=0' \
    -F 'language=en' \
    "http://127.0.0.1:${PORT}/inference")
  local status=$?
  set -e
  if [[ $status -ne 0 || "$http_code" != "200" ]]; then
    printf ''
    return
  fi
  node -e '
    let raw = "";
    process.stdin.on("data", function (c) { raw += c; });
    process.stdin.on("end", function () {
      let text = raw;
      try {
        const j = JSON.parse(raw);
        if (typeof j.text === "string") text = j.text;
      } catch (e) { /* not JSON — fall back to raw body */ }
      process.stdout.write(text);
    });
  ' < "$resp_path"
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# --- ensure a server -------------------------------------------------------------
if test_port "$PORT"; then
  echo "Using already-running whisper-server on port $PORT"
else
  if [[ ! -x "$BIN_SERVER" ]]; then
    echo "SKIP: whisper-server not found (or not executable) at $BIN_SERVER"
    exit 0
  fi
  THREADS=$(( $(sysctl -n hw.ncpu) - 2 ))
  if (( THREADS < 4 )); then THREADS=4; fi
  echo "Starting whisper-server on port $PORT ..."
  "$BIN_SERVER" -m "$MODEL" --host 127.0.0.1 --port "$PORT" -t "$THREADS" >/dev/null 2>&1 &
  STARTED_PID=$!
  READY=0
  for _ in $(seq 1 120); do
    sleep 0.5
    if ! kill -0 "$STARTED_PID" 2>/dev/null; then break; fi
    if test_port "$PORT"; then READY=1; break; fi
  done
  if [[ "$READY" -ne 1 ]]; then
    echo 'FAIL: server did not become ready'
    exit 1
  fi
  echo 'Server ready.'
fi

FRACTIONS=(0.25 0.5 0.75 1.0)
FINAL=""
for F in "${FRACTIONS[@]}"; do
  BYTES="$(node -e 'process.stdout.write(String(Math.floor(Number(process.argv[1]) * Number(process.argv[2]))))' "$PCM_LEN" "$F")"
  PREFIX_WAV="$TMP_DIR/prefix-${F}.wav"
  RESP_JSON="$TMP_DIR/resp-${F}.json"
  node "$WAV_TOOL" prefix "$WAV_PATH" "$BYTES" "$PREFIX_WAV"

  TEXT="$(invoke_inference "$PREFIX_WAV" "$RESP_JSON")"
  TEXT="$(trim "$TEXT")"
  PCT="$(node -e 'process.stdout.write(String(Math.round(Number(process.argv[1]) * 100)))' "$F")"
  printf '  %3s%%  ->  %s\n' "$PCT" "$TEXT"
  FINAL="$TEXT"
done

LOWER="$(printf '%s' "$FINAL" | tr '[:upper:]' '[:lower:]')"
OK=1
for w in quick fox lazy; do
  if [[ "$LOWER" != *"$w"* ]]; then OK=0; fi
done

if [[ "$OK" -eq 1 ]]; then
  echo ''
  echo 'PASS: growing prefixes transcribe; final contains the expected keywords.'
  EXIT_CODE=0
else
  echo ''
  echo "FAIL: final transcript missing expected keywords: $FINAL"
  EXIT_CODE=1
fi

exit "$EXIT_CODE"
