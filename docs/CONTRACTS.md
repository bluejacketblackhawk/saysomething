# Say Something — module contracts & file ownership

Read `docs/SPEC.md` first. This file is the integration authority: exact file map, module interfaces, IPC channels, helper protocol, settings schema. If you must deviate, note it in your report; do not silently change a contract.

## File ownership map

| Owner | Files |
|---|---|
| **S** scaffold | `package.json`, `.gitignore`, `README.md`, `assets/wisp.svg`, `src/main/main.js` (boot skeleton), `src/main/config.js`, `src/main/log.js`, `src/main/ipc.js`, `src/preload/overlay.js`, `src/preload/settings.js`, stubs for all module files below |
| **A** native helper | `native/SaySomethingHelper.cs`, `native/build.cmd`, `src/main/helper.js`, `test/helper-selftest.js` |
| **B** audio | `src/renderer/overlay/audio.js`, `src/renderer/overlay/worklet.js`, `src/main/audio-session.js`, `test/wav-test.js` |
| **C** whisper engine | `src/main/whisper/models.js`, `src/main/whisper/binaries.js`, `src/main/whisper/server.js`, `src/main/whisper/client.js`, `src/main/whisper/formatter.js`, `scripts/setup.js`, `test/formatter-test.js`, `test/e2e-transcribe.ps1` |
| **D** overlay UI | `src/renderer/overlay/index.html`, `src/renderer/overlay/overlay.css`, `src/renderer/overlay/overlay.js`, `src/renderer/shared/theme.css` |
| **E** settings/tray/stores | `src/main/stores/settings.js`, `src/main/stores/history.js`, `src/main/tray.js`, `src/main/windows.js`, `src/renderer/settings/index.html`, `src/renderer/settings/settings.css`, `src/renderer/settings/settings.js`, `scripts/gen-icon.js`, `scripts/make-shortcut.ps1` |
| **I** integrator | `src/main/state.js`, final `src/main/main.js` (incl. `--smoke`), fixes anywhere |

Rules for module agents: write ONLY your files (replacing scaffold stubs is expected). Do not run `npm install`. Do not add dependencies — report needs instead. Windows paths via `path.join`; CommonJS (`require`) in main/preload; renderers are plain browser JS loaded via `<script>` tags (no modules needed; if used, `type="module"` with relative paths).

## Paths & constants (src/main/config.js — scaffold provides, everyone imports)

```js
module.exports = {
  APP_NAME: 'Say Something',
  USER_DATA: ..,            // app.getPath('userData')  (%APPDATA%/Say Something)
  MODELS_DIR: ..,           // <USER_DATA>/models
  LOGS_DIR: ..,             // <USER_DATA>/logs
  BIN_WHISPER: ..,          // <repo>/bin/whisper  (whisper-server.exe, whisper-cli.exe, *.dll)
  BIN_HELPER: ..,           // <repo>/bin/helper/SaySomethingHelper.exe
  HELPER_SRC: ..,           // <repo>/native/SaySomethingHelper.cs
  THIRD_PARTY: ..,          // <repo>/third_party
  WHISPER_ZIP_CACHE: 'whisper-bin-x64-v1.9.1.zip',
  WHISPER_ZIP_URL: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip',
  MODEL_BASE_URL: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
  DEFAULT_PORT: 8737,
  CSC: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  TAR: 'C:\\Windows\\System32\\tar.exe',
}
```

`bin/`, `third_party/*.zip`, `node_modules/`, `%APPDATA%` are gitignored (scaffold: `.gitignore` = node_modules, bin, third_party/*.zip, logs, *.log).

## Settings schema (defaults — stores/settings.js validates & deep-merges saved JSON over these)

```json
{
  "hotkey": { "vk": 163, "name": "Right Ctrl" },
  "padHotkey": { "vk": 165, "name": "Right Alt" },
  "pad": { "enabled": true },
  "mic": { "deviceId": "default", "warm": true, "preRollMs": 800 },
  "model": "small.en",
  "language": "en",
  "format": { "fillerRemoval": true, "voiceCommands": true, "trailingSpace": true, "autoCapitalize": true, "artifactStrip": true },
  "dictionary": [],
  "inject": { "mode": "paste", "restoreClipboardMs": 300 },
  "streaming": { "enabled": true },
  "autoStop": { "enabled": true, "silenceMs": 2000 },
  "overlay": { "chime": true, "offsetY": 48 },
  "history": { "enabled": true, "max": 200 },
  "launchAtLogin": false,
  "paused": false,
  "whisperPort": 8737,
  "maxUtteranceSec": 300
}
```

`settings.js` API: `get()` (whole object), `set(partial)` (deep-merge, persist, emit), `onChange(cb)`. Stored at `<USER_DATA>/settings.json`.
`history.js` API: `add({text, ms, app})`, `list()`, `remove(id)`, `clear()`. Stored at `<USER_DATA>/history.json`, capped at `history.max`, no-op when disabled.

## Helper protocol (JSON lines over stdio, UTF-8)

Electron → helper (`{"cmd": ...}` one per line):
- `{"cmd":"watch","vks":[163]}` — replace the FULL watched set (state machine adds 27 only while recording)
- `{"cmd":"capture"}` — one-shot: report next keydown (any VK) as `captured`, then revert to watch set
- `{"cmd":"paste","text":"...","restoreMs":300}` — clipboard-swap + Ctrl+V
- `{"cmd":"type","text":"..."}` — SendInput KEYEVENTF_UNICODE
- `{"cmd":"clipboard","text":"..."}` — set the clipboard WITHOUT pasting (drop-pad auto-copy)
- `{"cmd":"placeAt","text":"...","x":N,"y":N,"restoreMs":300}` — SetCursorPos + left-click + paste at a screen point
- `{"cmd":"pickPoint"}` — arm the one-shot `WH_MOUSE_LL`: the next left-click reports its coords as `picked` (then disarms). `{"cmd":"pick-cancel"}` disarms.
- `{"cmd":"foreground"}` · `{"cmd":"ping"}` · `{"cmd":"quit"}`

Helper → Electron (`{"evt": ...}`):
- `{"evt":"ready"}` (once, after hook installed) · `{"evt":"pong"}`
- `{"evt":"key","vk":163,"down":true}` — watched VKs only, never injected input
- `{"evt":"captured","vk":112,"name":"F1"}`
- `{"evt":"pasted","ok":true}` / `{"evt":"typed","ok":true}` / `{"evt":"copied","ok":true}` / `{"evt":"placed","ok":true}` (`"ok":false,"err":"..."` on failure)
- `{"evt":"picked","x":N,"y":N}` — one-shot mouse pick result (armed by `pickPoint`)
- `{"evt":"foreground","exe":"notepad.exe","title":"..."}`
- `{"evt":"log","msg":"..."}` (helper-internal warnings; must never contain keystrokes or clipboard/injected text)

`src/main/helper.js` API: `start()` (compiles via `native/build.cmd` if exe missing, spawns, resolves on `ready`), `stop()`, `watch(vks)`, `capture()`, `paste(text)`, `type(text)`, `foreground()`, `ping()`, events via `.on('key'|'crash'|...)`. Auto-restart w/ backoff on crash.

## IPC channels (names exported from src/main/ipc.js; preloads whitelist exactly these)

Overlay renderer — incoming (main→renderer): `overlay:state` `{state, detail}` where state ∈ `hidden|listening|transcribing|rewriting|success|cancelled|error|nothing-heard` (detail: `{t0}` for listening, `{text}` for success, `{message}` for error); `overlay:partial` `{sessionId, text}` (live interim transcript, shown in the `listening` pill as `has-partial`, display-only — never injected/stored; `overlay.js` writes it via `textContent` and ignores partials outside the `listening` state); `audio:start` `{deviceId, preRollMs, warm}`; `audio:stop` `{sessionId}`; `audio:abort` `{sessionId}`; `audio:vad` `{sessionId, enabled, silenceMs}` (arm/disarm latched auto-stop — main sends `enabled:true` only when a tap latches AND `autoStop.enabled`).
Outgoing (renderer→main): `audio:chunk` `{sessionId, buf /* ArrayBuffer PCM16 16k mono */}`; `audio:started` `{sessionId}`; `audio:stopped` `{sessionId}`; `audio:error` `{message}`; `audio:silence` `{sessionId}` (VAD detected end-of-speech; main treats it exactly like a second tap, ONLY if that session is still recording+latched and auto-stop is enabled — stray/late events ignored).
Note: main assigns `sessionId` and includes it in `audio:start`. Levels never cross IPC — `audio.js` dispatches `window` CustomEvent `saysomething:level` `{detail:{rms}}` ~30/s while capturing; `overlay.js` listens. The latched auto-stop VAD (`src/renderer/overlay/vad.js`, a pure module also unit-tested in `test/vad-test.js`) consumes those same worklet levels — no second analysis path — and, while armed, `audio.js` dispatches `saysomething:vad` `{detail:{active, progress /*0..1*/}}` so `overlay.js` dims the pill toward the cutoff (the `listening` pill gets `data-vad="on"` + a `--vad` var; opacity-only, no new overlay state). `audio.js` also handles chime playback (WebAudio synth, respects `overlay.chime` passed in `audio:start` as `{chime}`); two-tone up = start, down = stop, low = cancel.

Drop pad renderer — main→pad: `pad:show` `{text}` (show the pad with this text). pad→main: `pad:drop` (place it — main arms `helper.pickPoint()` then `helper.placeAt`), `pad:copy` (re-copy), `pad:dismiss` (close). Preload `src/preload/pad.js` exposes `window.saysomething` whitelisting exactly these (ipc.js `PAD`). The pad window (`windows.createPad`/`showPad`/`hidePad`/`getPadWC`) is focusable + movable (unlike the click-through overlay).

Settings renderer — `invoke` style: `settings:get` · `settings:set(partial)` · `models:list` → `[{name, sizeMB, note, recommended, downloaded, active}]` (`note` = plain-English pick guidance, `recommended` = the first-day default small.en) · `models:download(name)` / `models:cancel(name)` · `history:list` / `history:remove(id)` / `history:clear` · `app:info` → `{version, whisper:{running, model, port}, helper:{running}}` · `hotkey:capture` → resolves `{vk, name}` · `whisper:restart`.
Events (main→settings): `models:progress` `{name, pct, bytes, total}` · `whisper:status` `{running, model, port}` · `settings:changed` `{settings}`.
Preload bridge shape (both preloads): `window.saysomething = { send(ch,p), on(ch,cb), invoke(ch,p) }` — each whitelists only its channels.

## Whisper module APIs

- `models.js`: `catalog()` (names/sizes/lang), `listLocal()`, `download(name, onProgress)` (to `MODELS_DIR`, `.part` then rename; verify byte size), `cancel(name)`, `pathFor(name)`.
- `binaries.js`: `ensure()` — bin/whisper ready? else unzip from third_party cache (via TAR) or download zip first. Copies only whisper-server.exe, whisper-cli.exe, and all `*.dll` EXCEPT SDL2-dependent extras it doesn't need (keep ggml*.dll, whisper.dll, SDL2.dll not needed — verify whisper-server runs without SDL2.dll; if it fails to start, include SDL2.dll).
- `server.js`: `start(modelName, port)` (spawn `whisper-server.exe -m <model> --host 127.0.0.1 --port <p> -t <threads>`; probe port upward if busy; poll until HTTP responds; timeout 60s), `stop()`, `status()`, `restart(model)`, crash auto-restart w/ backoff, `.on('status', cb)`. Verify actual flags with `whisper-server.exe --help` during setup; adjust flags if names differ.
- `client.js`: `transcribe(wavBuffer, {prompt, language})` → `{text, ms}` — POST multipart to `/inference` (`file` = WAV blob, `response_format=json`, `temperature=0`, plus `prompt`/`language` if the server supports those fields — check `--help`/README; if per-request prompt unsupported, pass `--prompt` at server start and note restart-on-dictionary-change). FIFO queue: one in-flight request. Also `transcribePartial(wavBuffer, {prompt, language, signal})` → `{text, ms}` — same POST but BYPASSES the FIFO and takes an external `AbortSignal` so live-partial interims can be cancelled the instant the user releases; best-effort (rejects on abort/error, caller ignores).
- `streaming.js`: live-partial interim driver. `start({sessionId, prompt, language, onPartial})` windows the growing `audio-session.snapshot()` buffer through `client.transcribePartial` (one in-flight, throttled on new-audio, capped at ~45s of audio) and calls `onPartial(sessionId, text)`; `stop(sessionId?)` aborts the in-flight interim. Partials are DISPLAY-ONLY — the authoritative injected text is always state.js's final pass. whisper-server v1.9.1 has NO streaming endpoint, so this is client-side windowed re-transcription on the warm server.
- `formatter.js`: pure `format(text, settings.format, /*extension point*/)` → string ('' means "nothing heard"). Also `formatPartial(text)` → light single-line clean (artifact-strip + collapse + capitalize; no filler/voice-command/trailing-space) for live previews. Exported for tests.

## audio-session.js (main)

`begin({sessionId, deviceId, preRollMs, warm, chime})` (sends `audio:start` to overlay WC), `collect(sessionId, chunk)`, `finish(sessionId)` → resolves complete WAV Buffer (16k/16-bit/mono, correct RIFF header), `snapshot(sessionId)` → `{wav, samples}|null` (WAV of audio-so-far WITHOUT ending the session — feeds the live-partial driver), `abort(sessionId)`. Handles chunk buffering + WAV encode; tolerates chunks arriving briefly after stop.

## Windows/tray/overlay creation (E: windows.js, tray.js)

`windows.js`: `createOverlay()` — frameless, transparent, alwaysOnTop('screen-saver'), `focusable:false`, `skipTaskbar`, click-through (`setIgnoreMouseEvents(true)`), sized ~320×72, positioned bottom-center of primary display minus `overlay.offsetY`, hidden by `showInactive()`/`hide()` from state (`overlay:state` hidden ⇒ hide window; anything else ⇒ showInactive). The overlay window ALWAYS exists (hosts mic/worklet even when hidden — `show:false` at create). `createSettings()` — normal window 900×640, dark bg, opened from tray; single instance. `getOverlayWC()`/`getSettingsWC()` accessors.
`tray.js`: programmatic RGBA `nativeImage` (16/32px cyan-violet wisp dot; use `scripts/gen-icon.js` PNG if present), menu: Paused ✓toggle / Settings… / Start with Windows ✓ / Quit. Tooltip "Say Something — hold Right Ctrl to dictate" (live hotkey name).

## main.js + state.js (integrator)

main.js: single-instance lock, `--smoke` branch before window creation, boot order: settings → log → helper.start() + binaries.ensure() + server.start() (parallel, tolerate whisper failure w/ status) → createOverlay → tray → watch(hotkey) → wire state machine. `app.setLoginItemSettings` sync with setting. state.js implements SPEC's machine; owns sessionId allocation; adds/removes Esc(27) from watch set on recording start/stop; ignores hotkey while `paused`; foreground() captured at finalize for history `app` field.

## Testing hooks

`test/formatter-test.js` + `test/wav-test.js`: plain Node scripts, `node test/x.js`, exit non-zero on failure, no frameworks. `test/helper-selftest.js`: spawns helper, ping/pong, paste into nothing (expects `ok` or clean `err`), watch+captured round-trip is manual-only (document). `e2e-transcribe.ps1`: PS 5.1-safe (no `&&`, no ternary), `-Port` param, starts server itself if not running (needs model + binaries).
