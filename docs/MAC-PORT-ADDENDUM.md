# macOS port — coordination addendum (binding contracts for this port)

This file pins decisions that cross module boundaries so parallel work stays coherent.
It supplements `docs/MAC-PORT.md` and `docs/CONTRACTS.md`. Where they conflict, THIS file wins.

## File ownership for the port (do not edit outside your lane)

| Lane | Files |
|---|---|
| **helper** | `native/SaySomethingHelper.swift` (new), `native/build-mac.sh` (new), `test/helper-selftest.js` (mac-compat edits) |
| **whisper-build** | `scripts/build-whisper-mac.sh` (new), stages `bin/whisper/whisper-server` (gitignored) |
| **js-platform** | `src/main/config.js`, `src/main/helper.js`, `src/main/whisper/binaries.js`, `src/main/whisper/server.js`, `src/main/tray.js`, `src/main/windows.js`, `src/main/stores/settings.js`, `scripts/setup.js`, `src/renderer/settings/settings.js` (only if VK/mod display needs platform names) |
| **permissions** | `src/main/permissions.js` (new), `src/main/main.js`, `src/main/ipc.js`, `src/preload/welcome.js` (new or edit), `src/renderer/welcome/*` |
| **packaging** | `package.json`, `build-resources/entitlements.mac.plist` (new), `build-resources/entitlements.mac.inherit.plist` (new), `scripts/stage-bundle.js`, `scripts/gen-icns.js` (new), `assets/SaySomething.icns` (generated) |
| **tests-scripts** | `test/e2e-transcribe.sh` (new), `test/partial-transcribe.sh` (new), other `test/*.js` mac-compat, but NOT `package.json` and NOT `test/helper-selftest.js` |

Nobody runs `git commit`. Nobody touches the USB original under `/Volumes/NO NAME`.

## Added helper stdio protocol (mac only, additive — Windows helper unchanged)

- Helper → Electron: `{"evt":"perms","listen":true|false,"ax":true|false}`
  Emitted once immediately after `ready`, again whenever status changes (helper polls
  every 2 s while any grant is missing), and in reply to `{"cmd":"perms"}`.
- Electron → helper: `{"cmd":"perms"}` — request a fresh `perms` event.
- Electron → helper: `{"cmd":"perms-request","kind":"listen"|"ax"}` — trigger the OS
  prompt (`CGRequestListenEventAccess()` / `AXIsProcessTrustedWithOptions` with prompt).
- Mic permission is Electron-side (`systemPreferences`), NOT the helper's job.

Helper behavior without grants: it MUST still print `ready` (so `helper.js` resolves
start()) and report `perms`. If the event tap cannot be created it retries when perms
flip to granted. `paste`/`type`/`placeAt` without Accessibility reply
`{"evt":"pasted","ok":false,"err":"accessibility not granted"}` (same shape for
`typed`/`placed`). `clipboard` needs no TCC and must always work.

## VK boundary translation (helper-internal; JS layer stays Windows-VK)

The helper translates CGKeyCode ↔ Windows VK at the boundary. Physical modifier map:

| Windows VK | Key | mac CGKeyCode |
|---|---|---|
| 160 LShift | Shift | 56 (0x38) |
| 161 RShift | Right Shift | 60 (0x3C) |
| 162 LCtrl | Control | 59 (0x3B) |
| 163 RCtrl | Right Ctrl | 62 (0x3E) |
| 164 LAlt | Option | 58 (0x3A) |
| 165 RAlt | Right Option | 61 (0x3D) |
| 91 LWin | Command | 55 (0x37) |
| 92 RWin | Right Command | 54 (0x36) |
| 27 Esc | Esc | 53 (0x35) |

Generic modifier VKs in `watch`/`mods` remain 16 Shift / 17 Ctrl / 18 Alt / 91 Win;
`hotkey-match.js` already expands generics to L/R variants — unchanged.
Friendly names on mac say **Option** (not Alt) and **Cmd** (not Win):
"Right Cmd", "Right Option", "Option + T", etc. Letters/digits/F-keys/punctuation
map via the ANSI keycode table (mirror the ~90-case `VkName()` in the C# helper).

## macOS default hotkeys (stores/settings.js, darwin only)

MacBook keyboards have no Right Ctrl, so darwin defaults are:
- `hotkey`: `{ vk: 92, name: "Right Cmd", mods: [] }`
- `padHotkey`: `{ vk: 165, name: "Right Option", mods: [] }`
Windows defaults unchanged. Saved settings still deep-merge over these.

## Binary names / layout on mac

- Helper: `bin/helper/SaySomethingHelper` (no .exe), built by `native/build-mac.sh`
  from `native/SaySomethingHelper.swift` (swiftc, single file, arm64, no app bundle).
- Whisper: `bin/whisper/whisper-server` (static, Metal-embedded, arm64,
  MACOSX_DEPLOYMENT_TARGET=13.0), built by `scripts/build-whisper-mac.sh`.
  No `.dll`s; static link means whisper-server is the ONLY file needed in bin/whisper.
- `config.js` exposes the same constant names (`BIN_HELPER`, `BIN_WHISPER`, …) with
  platform-appropriate values. User data on mac: `~/Library/Application Support/SaySomething`.
- On darwin, `binaries.ensure()` does NOT download (no official mac server binaries);
  it verifies `bin/whisper/whisper-server` exists and is executable, else errors with
  "run scripts/build-whisper-mac.sh".
- `helper.js` on darwin: no compile-on-demand via cmd.exe. If `BIN_HELPER` is missing
  and `native/build-mac.sh` exists (dev checkout), run it via `/bin/bash`; in a
  packaged app the helper ships prebuilt.

## Injection semantics on mac

- `paste` = clipboard-swap + synthesized **Cmd+V** (kVK_ANSI_V=9 + maskCommand), restore after `restoreMs`.
- `type` = `CGEventKeyboardSetUnicodeString` chunked ≤20 UTF-16 units per event pair.
- `placeAt` = `CGWarpMouseCursorPosition` + `CGAssociateMouseAndMouseCursorPosition(true)`
  + synthesized left click at the point + Cmd+V paste. Coordinates arrive in the same
  global top-left-origin space Electron reports (`screen` coords) — CG global coords match.
- Self-injected events are tagged via `eventSourceUserData` (magic value) and ignored by the taps.
- `foreground` replies `{"evt":"foreground","exe":"<localizedName or bundle id>","title":""}` (no TCC needed).

## Dev-mode TCC caveat (affects everyone's testing)

In this headless session no TCC grants exist: event taps can't be created and
CGEvent.post won't deliver. Everything must degrade gracefully and be verifiable at
the protocol level (ping/pong, clipboard, foreground, perms reporting). Interactive
hotkey/paste testing happens later, by a human, after granting Input Monitoring +
Accessibility + Microphone.
