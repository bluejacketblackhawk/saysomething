# Contributing to SaySomething

Thanks for your interest in SaySomething — a local-first, on-device voice dictation app for Windows. Contributions are welcome. Please read the hard constraints below before you start; they are not stylistic preferences, they are load-bearing to the project's design and privacy promises.

## Dev setup

SaySomething targets **Windows** and **Node.js >= 24**.

```sh
npm install          # installs electron (the only devDependency)
node scripts/setup.js  # unpacks whisper binaries, compiles the native helper, downloads the default model
npm start            # electron . — tray app, overlay hidden until first use
```

`scripts/setup.js` is idempotent and safe to re-run. It is the **only** part of SaySomething that touches the network (whisper binaries from GitHub, models from Hugging Face). Useful flags: `--model <name>`, `--no-model`, `-h`.

## Tests

```sh
npm test                      # unit tests: formatter + WAV assembly
npm run smoke                 # electron . --smoke — headless self-test (settings, helper, binaries, server boot)
node test/helper-selftest.js  # compiles + drives the real SaySomethingHelper.exe end to end
test/e2e-transcribe.ps1       # full loop w/o a mic: TTS -> WAV -> POST to whisper -> assert words (PowerShell)
```

Run `npm test` before opening a PR. If you touch the native helper, also run `node test/helper-selftest.js`. If you touch the audio/whisper path, run `test/e2e-transcribe.ps1`.

## Hard constraints

These are enforced by the spec (`docs/SPEC.md`). PRs that violate them will not be merged.

- **Zero runtime npm dependencies.** `electron` is the only devDependency. Do not add runtime deps. Downloads use Node's built-in `fetch`; unzipping uses `C:\Windows\System32\tar.exe` (bsdtar).
- **No bundler, no framework.** Main process is CommonJS; renderers are vanilla HTML/CSS/JS. No webpack/vite/React/etc.
- **C# 5 only for `native/SaySomethingHelper.cs`.** It is compiled by the .NET Framework `csc.exe` (`v4.0.30319`) that ships with Windows, which only supports C# 5: no string interpolation (`$"..."`), no null-conditional (`?.`), no `nameof`, no expression-bodied members, no `out var`, no pattern matching, no tuples. `async/await` is fine. Keep it in ONE file; hand-roll JSON (no external libs). The helper source is committed and auditable; the exe is never downloaded.
- **Privacy rules (non-negotiable):**
  - The keyboard hook must **only ever emit the watched VKs** (the configured hotkey; Esc only while recording; plus one-shot "capture next key" for rebinding). It must never buffer, log, or transmit any other keystroke. Injected input (`LLKHF_INJECTED`) is ignored.
  - **Audio never touches disk.** The pre-roll ring buffer lives in renderer memory and is discarded unless a session starts; WAV exists only as an in-memory buffer for the POST.
  - **localhost only.** whisper-server binds `127.0.0.1`. No runtime network calls except that localhost server. The only internet access is `scripts/setup.js` / model downloads, and it must say so on the console.

## Module ownership

See **`docs/CONTRACTS.md`** for module boundaries and ownership before changing cross-cutting behavior.
