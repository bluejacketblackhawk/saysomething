#!/bin/bash
# One-command notarized macOS release for Say Something.
#
#   bash scripts/notarize-mac.sh
#
# Prompts for the Apple ID email and its app-specific password (input hidden,
# nothing stored), auto-detects the Developer ID Application certificate in the
# keychain, builds + signs + notarizes + staples all four artifacts, then
# verifies them with spctl and stapler. Run it from anywhere; it locates the
# repo from its own path. Requires: the repo on a real disk (not FAT/USB),
# node_modules installed, bin/ binaries built, and the Developer ID cert
# installed (Xcode > Settings > Accounts > Manage Certificates).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Node: use whatever's in PATH, else the known local toolchain drop.
if ! command -v npm >/dev/null 2>&1; then
  for cand in /private/tmp/claude-501/*/*/scratchpad/tools/node/bin; do
    [ -x "$cand/npm" ] && export PATH="$cand:$PATH" && break
  done
fi
command -v npm >/dev/null 2>&1 || { echo "ERROR: node/npm not found in PATH." >&2; exit 1; }
[ -d node_modules ] || { echo "ERROR: run 'npm install' in $REPO first." >&2; exit 1; }

# Auto-detect the Developer ID Application identity.
IDENT="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
[ -n "$IDENT" ] || { echo "ERROR: no Developer ID Application certificate in the keychain." >&2; exit 1; }
TEAM_ID="$(printf '%s' "$IDENT" | sed -n 's/.*(\(.*\))$/\1/p')"
# electron-builder wants the name WITHOUT the "Developer ID Application:" prefix;
# codesign (the after-pack hook) is happy with the full string.
IDENT_NAME="${IDENT#Developer ID Application: }"
echo "Signing as: $IDENT  (team $TEAM_ID)"

read -r -p "Apple ID email: " APPLE_ID
read -r -s -p "App-specific password (input hidden): " APPLE_APP_SPECIFIC_PASSWORD
echo

export APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
export APPLE_TEAM_ID="$TEAM_ID"
export SS_MAC_SIGN_IDENTITY="$IDENT"

echo "Building, signing, and notarizing (the notary upload takes a few minutes; it is not stuck)..."
# electron-builder is silent during the notarize step (upload + Apple's scan can
# take from minutes to, for a team's first-ever submission, hours). DEBUG makes
# @electron/notarize narrate so the terminal never looks frozen at "signing".
export DEBUG="electron-notarize*${DEBUG:+,$DEBUG}"
npm run prep
npx electron-builder --mac --config.mac.identity="$IDENT_NAME"

echo
echo "=== Notarizing + stapling the disk images themselves ==="
# electron-builder notarizes the .app inside; stapling the dmg container too
# means even a fully offline Mac validates the download instantly. The inner
# content is already scanned, so these submissions are quick.
for DMG in dist/SaySomething-*.dmg; do
  [ -f "$DMG" ] || continue
  if xcrun stapler validate "$DMG" >/dev/null 2>&1; then echo "already stapled: $DMG"; continue; fi
  echo "notarizing $DMG ..."
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$DMG"
done

echo
echo "=== Verification ==="
for APPDIR in "dist/mac-arm64/Say Something.app" "dist/mac/Say Something.app"; do
  [ -d "$APPDIR" ] || continue
  spctl --assess --type exec "$APPDIR" && echo "spctl accepted: $APPDIR"
done
for DMG in dist/SaySomething-*-arm64.dmg dist/SaySomething-*-x64.dmg; do
  [ -f "$DMG" ] || continue
  xcrun stapler validate "$DMG" >/dev/null && echo "stapled: $DMG"
done
echo
echo "Done. Ship the four files in dist/ (two .dmg, two .zip)."
