#!/bin/bash
# Notarize + staple the already-built dmgs in dist/ (the apps inside are already
# notarized; this staples the containers too so offline Macs validate instantly).
#   bash scripts/staple-dmgs.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

TEAM_ID="$(security find-identity -v -p codesigning | sed -n 's/.*Developer ID Application: .*(\(.*\))".*/\1/p' | head -1)"
[ -n "$TEAM_ID" ] || { echo "ERROR: no Developer ID Application certificate found." >&2; exit 1; }
read -r -p "Apple ID email: " APPLE_ID
read -r -s -p "App-specific password (input hidden): " PW
echo

for DMG in dist/SaySomething-*.dmg; do
  [ -f "$DMG" ] || continue
  if xcrun stapler validate "$DMG" >/dev/null 2>&1; then echo "already stapled: $DMG"; continue; fi
  echo "notarizing $DMG (quick; content already scanned) ..."
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$PW" --team-id "$TEAM_ID" --wait
  xcrun stapler staple "$DMG"
  echo "stapled: $DMG"
done
echo "Done."
