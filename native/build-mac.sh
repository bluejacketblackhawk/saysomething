#!/bin/bash
# Build SaySomethingHelper (macOS) from native/SaySomethingHelper.swift.
#
# Produces bin/helper/SaySomethingHelper: a single-file, dependency-free
# command-line tool (no app bundle) compiled with the swiftc that ships with
# Xcode, then ad-hoc codesigned so it has a stable identity for TCC (Input
# Monitoring / Accessibility grants attach to a code identity).
#
# Arch policy: on an arm64 host this builds a UNIVERSAL (arm64 + x86_64) binary
# by compiling each slice separately (xcrun swiftc -target <arch>-apple-macos13.0)
# and joining them with `lipo -create`. The `extraResources` bin/ tree is copied
# verbatim into BOTH the arm64 and the x64 .app, so the one helper that ships must
# run on Intel and Apple Silicon alike — hence universal, not per-arch. If the
# x86_64 slice fails to compile (e.g. the Intel Swift SDK is unavailable) the
# build FALLS BACK to a host-arch-only binary and logs that it did, so a dev
# checkout still gets a working helper. On a non-arm64 host it builds host-arch
# only (that host can't reliably cross-produce the arm64 slice from here).
#
# Dependency-free (xcrun/swiftc/lipo/codesign only) and re-runnable: each run
# recompiles into a fresh temp dir and atomically replaces the output.
#
# Invoked by src/main/helper.js when the binary is missing (dev checkout) and by
# scripts/setup.js. Self-locating via the script's own directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/SaySomethingHelper.swift"
OUTDIR="$HERE/../bin/helper"
OUT="$OUTDIR/SaySomethingHelper"
DEPLOY_TARGET="13.0"

if [ ! -f "$SRC" ]; then
  echo "build-mac.sh: source not found at $SRC" 1>&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "build-mac.sh: xcrun not found (install Xcode / Command Line Tools)" 1>&2
  exit 1
fi

mkdir -p "$OUTDIR"

HOST_ARCH="$(uname -m)"

TMP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/ss-helper-build.XXXXXX")"
cleanup() { rm -rf "$TMP_BUILD"; }
trap cleanup EXIT

# Compile a single arch slice to $2. Returns swiftc's exit status.
compile_slice() {
  arch="$1"; out="$2"
  xcrun swiftc -O -target "${arch}-apple-macos${DEPLOY_TARGET}" -o "$out" "$SRC"
}

if [ "$HOST_ARCH" = "arm64" ]; then
  echo "build-mac.sh: arm64 host — building a universal (arm64 + x86_64) helper"

  ARM_SLICE="$TMP_BUILD/helper-arm64"
  X64_SLICE="$TMP_BUILD/helper-x86_64"

  echo "build-mac.sh: compiling arm64 slice"
  compile_slice arm64 "$ARM_SLICE"

  echo "build-mac.sh: compiling x86_64 slice"
  if compile_slice x86_64 "$X64_SLICE" 2>"$TMP_BUILD/x64.log"; then
    echo "build-mac.sh: lipo -create arm64 + x86_64 -> $OUT"
    lipo -create "$ARM_SLICE" "$X64_SLICE" -output "$OUT"
  else
    echo "build-mac.sh: WARNING: x86_64 slice failed to compile — falling back to arm64-only" 1>&2
    sed 's/^/build-mac.sh:   x86_64: /' "$TMP_BUILD/x64.log" 1>&2 || true
    cp -f "$ARM_SLICE" "$OUT"
  fi
else
  echo "build-mac.sh: $HOST_ARCH host — building host-arch-only helper"
  compile_slice "$HOST_ARCH" "$OUT"
fi

chmod 0755 "$OUT"

# Ad-hoc sign so the binary keeps a stable identity across runs; without this the
# TCC database would re-prompt on every rebuild. --force replaces any prior sig.
# Sign AFTER lipo — a fat binary is signed as a whole, not per-slice.
echo "build-mac.sh: ad-hoc codesigning $OUT"
codesign -s - --force "$OUT"

echo "build-mac.sh: built $OUT ($(lipo -archs "$OUT" 2>/dev/null || echo '?'))"
