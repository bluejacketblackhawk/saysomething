#!/usr/bin/env bash
#
# SaySomething e2e transcription proof (macOS) — bash port of e2e-transcribe.ps1
#
# Synthesizes a known sentence to a 16 kHz mono 16-bit WAV using macOS' `say` +
# `afconvert`, POSTs it to the local whisper-server /inference endpoint, and
# asserts the expected keywords appear in the transcript.
#
# Starts whisper-server itself if one is not already listening on --port (this
# needs the binary at bin/whisper/whisper-server and a downloaded model). If no
# model is present it prints a clear SKIP message and exits 0.
#
# Usage:
#   test/e2e-transcribe.sh [-p|--port PORT]
#
# Exit codes: 0 = pass or clean SKIP, 1 = fail.

set -euo pipefail

PORT=8737

usage() {
  cat <<'USAGE'
Usage: e2e-transcribe.sh [-p|--port PORT]

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
# Mirrors src/main/config.js resolveUserData() on darwin: Electron's
# app.getPath('appData') is ~/Library/Application Support, joined with APP_NAME.
MODELS_DIR="$HOME/Library/Application Support/SaySomething/models"

echo ''
echo '== SaySomething e2e transcription test (macOS) =='

# --- Is a TCP port accepting connections? (server readiness / reachability) ---
test_port() {
  local port="$1"
  ( exec 3<>"/dev/tcp/127.0.0.1/$port" ) 2>/dev/null
}

# --- 1. Locate a model (clear skip if none) -----------------------------------
MODEL=""
if [[ -d "$MODELS_DIR" ]]; then
  MODEL="$(find "$MODELS_DIR" -maxdepth 1 -type f -name 'ggml-*.bin' -print -quit 2>/dev/null || true)"
fi
if [[ -z "$MODEL" ]]; then
  echo "SKIP: no whisper model found in $MODELS_DIR"
  echo '      Download one first, e.g.:  node scripts/setup.js --model small.en'
  exit 0
fi
echo "Model: $MODEL"

# --- 2. Ensure a reachable server (start one if needed) -----------------------
STARTED_PID=""
if test_port "$PORT"; then
  echo "Using already-running whisper-server on port $PORT"
else
  if [[ ! -x "$BIN_SERVER" ]]; then
    echo "SKIP: whisper-server not found (or not executable) at $BIN_SERVER"
    echo '      Run:  scripts/build-whisper-mac.sh'
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
    echo "FAIL: whisper-server did not become ready on port $PORT"
    if kill -0 "$STARTED_PID" 2>/dev/null; then
      kill -9 "$STARTED_PID" 2>/dev/null || true
    fi
    exit 1
  fi
  echo 'Server ready.'
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saysomething-e2e.XXXXXX")"
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

# --- 3. Synthesize a known sentence to a 16 kHz mono 16-bit WAV ----------------
SENTENCE='The quick brown fox jumps over the lazy dog.'
AIFF_PATH="$TMP_DIR/audio.aiff"
WAV_PATH="$TMP_DIR/audio.wav"

say -o "$AIFF_PATH" "$SENTENCE"
afconvert -f WAVE -d LEI16@16000 -c 1 "$AIFF_PATH" "$WAV_PATH"
echo "Synthesized: '$SENTENCE'"

# --- 4. POST multipart/form-data to /inference ---------------------------------
URL="http://127.0.0.1:$PORT/inference"
echo "POST $URL"

RESP_PATH="$TMP_DIR/response.json"
set +e
HTTP_CODE=$(curl -sS -o "$RESP_PATH" -w '%{http_code}' \
  -F "file=@${WAV_PATH};type=audio/wav" \
  -F 'response_format=json' \
  -F 'temperature=0' \
  -F 'language=en' \
  "$URL")
CURL_STATUS=$?
set -e

BODY=""
[[ -f "$RESP_PATH" ]] && BODY="$(cat "$RESP_PATH")"

if [[ $CURL_STATUS -ne 0 || "$HTTP_CODE" != "200" ]]; then
  echo "FAIL: inference returned HTTP ${HTTP_CODE:-000}"
  echo "$BODY"
  EXIT_CODE=1
else
  TEXT="$(node -e '
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
  ' <<< "$BODY")"
  echo "Transcript: $TEXT"

  LC="$(printf '%s' "$TEXT" | tr '[:upper:]' '[:lower:]')"
  MISSING=()
  for w in quick brown fox; do
    if [[ "$LC" != *"$w"* ]]; then
      MISSING+=("$w")
    fi
  done

  if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo 'PASS: transcript contains the expected keywords.'
    EXIT_CODE=0
  else
    IFS=', '
    echo "FAIL: missing expected keywords: ${MISSING[*]}"
    unset IFS
    EXIT_CODE=1
  fi
fi

exit "$EXIT_CODE"
