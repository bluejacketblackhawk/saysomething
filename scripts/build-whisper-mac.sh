#!/usr/bin/env bash
#
# build-whisper-mac.sh — build whisper.cpp's whisper-server for macOS and stage
# the resulting binary at bin/whisper/whisper-server for the "Say Something" port.
#
# This is the ONLY producer of bin/whisper/whisper-server on macOS (see
# docs/MAC-PORT-ADDENDUM.md — "whisper-build" lane). binaries.js on darwin does
# NOT download a prebuilt server; it just checks this file exists.
#
# Arch policy (--arch flag; default = universal on arm64 hosts, host arch else):
#   arm64      Metal-accelerated slice (GGML_METAL=ON, GGML_METAL_EMBED_LIBRARY=ON).
#   x86_64     CPU / Accelerate slice (GGML_METAL=OFF) — Intel Macs run whisper on
#              the CPU here (MAC-PORT.md §7); ggml links Accelerate.framework, a
#              system lib, so the slice stays self-contained. GGML_NATIVE=OFF so no
#              `-march=native` is emitted (wrong when cross-compiling x86_64 from an
#              arm64 host).
#   universal  both of the above, joined with `lipo -create`.
#
# The extraResources bin/ tree is copied verbatim into BOTH the per-arch .apps, so
# on an arm64 host the default is a single universal binary that runs on Intel and
# Apple Silicon alike (not per-arch staging).
#
# Each arch builds in its OWN cmake build dir (arm64 -> build, x86_64 ->
# build-x86_64) so the two configs never clobber each other's cache: an existing
# arm64 build is reused as-is, and adding the x86_64 slice does not force the arm64
# tree to reconfigure.
#
# Usage:
#   scripts/build-whisper-mac.sh [--arch arm64|x86_64|universal]
#
# Re-running is safe: an existing source clone at the right tag is reused, and
# cmake/build/stage steps are idempotent.
#
# Env overrides (all optional):
#   WHISPER_CPP_REPO_URL   git remote to clone (default: upstream ggml-org repo)
#   WHISPER_CPP_TAG        tag to build (default: v1.9.1)
#   WHISPER_CPP_SRC_DIR    where to clone/reuse the whisper.cpp source tree
#                           (default: ~/Library/Caches/SaySomething/whisper-build/whisper.cpp)
#   JOBS                   parallel build jobs (default: hw.ncpu)

set -euo pipefail

REPO_URL="${WHISPER_CPP_REPO_URL:-https://github.com/ggml-org/whisper.cpp}"
TAG="${WHISPER_CPP_TAG:-v1.9.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="${WHISPER_CPP_SRC_DIR:-$HOME/Library/Caches/SaySomething/whisper-build/whisper.cpp}"
STAGE_DIR="$WORKSPACE_ROOT/bin/whisper"
STAGE_BIN="$STAGE_DIR/whisper-server"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

log() { printf '[build-whisper-mac] %s\n' "$*" >&2; }
die() { printf '[build-whisper-mac] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO (see above for the command that failed)"' ERR

# ---------------------------------------------------------------------------
# 0. Args + arch resolution
# ---------------------------------------------------------------------------
ARCH_MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)   ARCH_MODE="${2:-}"; shift 2 ;;
    --arch=*) ARCH_MODE="${1#--arch=}"; shift ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

HOST_ARCH="$(uname -m)"
if [[ -z "$ARCH_MODE" ]]; then
  if [[ "$HOST_ARCH" == "arm64" ]]; then ARCH_MODE="universal"; else ARCH_MODE="$HOST_ARCH"; fi
fi
case "$ARCH_MODE" in
  arm64)     SLICES=(arm64) ;;
  x86_64)    SLICES=(x86_64) ;;
  universal) SLICES=(arm64 x86_64) ;;
  *) die "invalid --arch '$ARCH_MODE' (want arm64|x86_64|universal)" ;;
esac

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "this script only builds on macOS (got $(uname -s))"
command -v git      >/dev/null 2>&1 || die "git not found on PATH"
command -v cmake    >/dev/null 2>&1 || die "cmake not found on PATH"
command -v clang    >/dev/null 2>&1 || die "clang not found on PATH — install Xcode / Xcode Command Line Tools"
command -v lipo     >/dev/null 2>&1 || die "lipo not found on PATH"
command -v codesign >/dev/null 2>&1 || die "codesign not found on PATH"
command -v otool    >/dev/null 2>&1 || die "otool not found on PATH"

log "repo=$REPO_URL tag=$TAG src=$SRC_DIR jobs=$JOBS arch=$ARCH_MODE (host=$HOST_ARCH)"

# ---------------------------------------------------------------------------
# 2. Clone (shallow, pinned to tag) or reuse an existing clone at that tag
# ---------------------------------------------------------------------------
if [[ -d "$SRC_DIR/.git" ]]; then
  current_tag="$(git -C "$SRC_DIR" describe --tags --exact-match 2>/dev/null || true)"
  if [[ "$current_tag" == "$TAG" ]]; then
    log "reusing existing clone at $SRC_DIR (already at $TAG)"
  else
    log "existing clone at $SRC_DIR is at '${current_tag:-<detached, no tag>}', re-pointing to $TAG"
    git -C "$SRC_DIR" fetch --depth 1 origin "tag" "$TAG" || die "failed to fetch tag $TAG"
    git -C "$SRC_DIR" checkout --force "tags/$TAG" || die "failed to checkout tag $TAG"
  fi
else
  [[ -e "$SRC_DIR" ]] && die "$SRC_DIR exists but is not a git repo — remove it and re-run"
  log "cloning $REPO_URL @ $TAG (shallow) into $SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --branch "$TAG" --depth 1 "$REPO_URL" "$SRC_DIR" || die "clone failed"
fi

actual_tag="$(git -C "$SRC_DIR" describe --tags --exact-match 2>/dev/null || echo '<none>')"
[[ "$actual_tag" == "$TAG" ]] || die "checked-out tag is '$actual_tag', expected '$TAG'"
log "source tree confirmed at tag $actual_tag"

# ---------------------------------------------------------------------------
# 3. Build each requested arch slice into its own cmake build dir
# ---------------------------------------------------------------------------
SLICE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/ss-whisper-slices.XXXXXX")"
cleanup() { rm -rf "$SLICE_TMP"; }
trap 'cleanup; die "failed at line $LINENO (see above for the command that failed)"' ERR
trap cleanup EXIT

build_dir_for() {
  case "$1" in
    arm64)  echo "$SRC_DIR/build" ;;         # reuse the existing arm64 cache
    x86_64) echo "$SRC_DIR/build-x86_64" ;;  # separate, so arm64 isn't clobbered
  esac
}
slice_bin() { echo "$SLICE_TMP/whisper-server-$1"; }

build_slice() {
  local arch="$1"
  local build_dir; build_dir="$(build_dir_for "$arch")"
  local backend_flags
  if [[ "$arch" == "arm64" ]]; then
    backend_flags=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
  else
    # Intel: no Metal (CPU + Accelerate). GGML_NATIVE=OFF avoids -march=native,
    # which is meaningless/wrong when cross-compiling x86_64 from an arm64 host.
    backend_flags=(-DGGML_METAL=OFF -DGGML_NATIVE=OFF)
  fi

  log "[$arch] configuring cmake in $build_dir"
  cmake -S "$SRC_DIR" -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
    "${backend_flags[@]}" \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_SERVER=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_SDL2=OFF \
    -DWHISPER_CURL=OFF \
    || die "[$arch] cmake configure failed"
  # NOTE: in whisper.cpp v1.9.1, WHISPER_BUILD_SERVER is an option() that
  # examples/CMakeLists.txt does NOT actually gate the add_subdirectory(server)
  # on — the server always builds when WHISPER_BUILD_EXAMPLES is ON (default ON
  # for a standalone/top-level build, which this is). We pass it for clarity.

  log "[$arch] building whisper-server ($JOBS jobs)"
  cmake --build "$build_dir" --config Release --target whisper-server -j "$JOBS" \
    || die "[$arch] build failed"

  local built="$build_dir/bin/whisper-server"
  if [[ ! -f "$built" ]]; then
    built="$(find "$build_dir" -type f -name whisper-server -perm -u+x 2>/dev/null | head -1)"
  fi
  [[ -n "${built:-}" && -f "$built" ]] || die "[$arch] could not locate built whisper-server under $build_dir"

  local file_out; file_out="$(file "$built")"
  echo "$file_out" | grep -q "$arch" || die "[$arch] built binary is not $arch: $file_out"
  log "[$arch] built: $built"
  cp -f "$built" "$(slice_bin "$arch")"
}

for arch in "${SLICES[@]}"; do
  build_slice "$arch"
done

# ---------------------------------------------------------------------------
# 4. lipo (or copy) into the staged binary, verify arches present
# ---------------------------------------------------------------------------
mkdir -p "$STAGE_DIR"
STAGED_TMP="$STAGE_BIN.tmp.$$"

if [[ "$ARCH_MODE" == "universal" ]]; then
  lipo_inputs=()
  for arch in "${SLICES[@]}"; do lipo_inputs+=("$(slice_bin "$arch")"); done
  log "lipo -create ${SLICES[*]} -> $STAGE_BIN"
  lipo -create "${lipo_inputs[@]}" -output "$STAGED_TMP" || die "lipo -create failed"
else
  cp -f "$(slice_bin "${SLICES[0]}")" "$STAGED_TMP"
fi

archs_present="$(lipo -archs "$STAGED_TMP")"
log "lipo -archs: $archs_present"
for arch in "${SLICES[@]}"; do
  echo "$archs_present" | tr ' ' '\n' | grep -qx "$arch" \
    || die "expected arch '$arch' missing from staged binary (got: $archs_present)"
done

# ---------------------------------------------------------------------------
# 5. Verify each slice is self-contained (system libs only) — otool per slice
# ---------------------------------------------------------------------------
for arch in "${SLICES[@]}"; do
  log "[$arch] otool -L:"
  otool -arch "$arch" -L "$STAGED_TMP" | sed 's/^/[build-whisper-mac]   /' >&2
  non_system="$(otool -arch "$arch" -L "$STAGED_TMP" | tail -n +2 | awk '{print $1}' | \
    grep -Ev '^(/usr/lib/|/System/Library/)' || true)"
  if [[ -n "$non_system" ]]; then
    die "[$arch] slice links non-system libraries (not self-contained — check GGML_METAL_EMBED_LIBRARY / BUILD_SHARED_LIBS):
$non_system"
  fi
  log "[$arch] self-contained: only system libraries linked"
done

# ---------------------------------------------------------------------------
# 6. Move into place, ad-hoc codesign (a fat binary is signed as a whole)
# ---------------------------------------------------------------------------
mv -f "$STAGED_TMP" "$STAGE_BIN"
chmod 755 "$STAGE_BIN"

log "ad-hoc codesigning $STAGE_BIN"
codesign -s - --force "$STAGE_BIN" || die "codesign failed"
codesign -dv "$STAGE_BIN" 2>&1 | sed 's/^/[build-whisper-mac]   /' >&2

[[ -x "$STAGE_BIN" ]] || die "staged binary is not executable: $STAGE_BIN"
codesign -v "$STAGE_BIN" || die "staged binary failed signature verification"

log "staged: $STAGE_BIN [$(lipo -archs "$STAGE_BIN")] ($(du -h "$STAGE_BIN" | awk '{print $1}'))"
log "done."
