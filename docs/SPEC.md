# Say Something — product & technical spec

**Say Something** is a local-first voice dictation app for Windows: hold a key anywhere, speak, release — your words appear in whatever app has focus. A free, private remake of Wispr Flow. Everything runs on-device; no accounts, no API keys, no cloud, no telemetry. Ever.

## Product experience

- **Hold Right Ctrl** (default, rebindable) anywhere in Windows → a small glowing pill appears bottom-center, a soft chime plays, and Say Something is listening. Release → pill switches to "thinking", then your transcribed, cleaned-up text is inserted into the focused app at the cursor. Total feel: release-to-text under ~2s for a typical sentence.
- **Tap** (< 250 ms) the same hotkey → hands-free latched recording; tap again to finish. **Esc** while recording cancels (nothing inserted).
- **Drop pad** (hold **Right Alt**, default `padHotkey`): speak → a small draggable pad appears with your text, **auto-copied** to the clipboard. Click **Drop here** then click any spot to place it there (the C# helper picks the click point via a one-shot `WH_MOUSE_LL` hook, then clicks + pastes), drag the pad wherever you want, or just **Ctrl+V**. For when you're not sure which field has focus. Toggle: `pad.enabled`. Never injects at the caret — it hands off to the pad instead.
- **Never clips your first word**: with "warm mic" on (default), a rolling ~800 ms pre-roll buffer means speech that starts a beat before the keypress is still captured.
- **Live preview** (default on): words appear in the pill as you speak. whisper-server has no streaming endpoint, so this is windowed interim re-transcription on the already-warm server (`src/main/whisper/streaming.js`) — display-only, never injected or stored, and aborted the instant you release so the authoritative final pass owns the engine with no added latency. Toggle: `streaming.enabled`.
- **Smart formatting**: whisper's punctuation, plus filler-word removal ("um", "uh"), spoken commands ("new line", "new paragraph"), auto-capitalization, whisper-artifact stripping ("[BLANK_AUDIO]" etc.). If nothing intelligible was heard, nothing is inserted and the pill shows a subtle "didn't catch that" state.
- **Custom dictionary**: user-provided words/names (e.g. "Kubernetes", "PostgreSQL", jargon) are fed to whisper as an initial prompt so they transcribe correctly.
- **History**: last 200 transcriptions with timestamps in the settings window; click to copy; toggleable; delete/clear. Local JSON only.
- **Tray app**: Say Something lives in the system tray (pause/resume, settings, quit). Settings window: hotkey rebind (press-to-capture), mic picker, model manager (download/switch with progress), language, formatting toggles, dictionary editor, history, launch-at-login, overlay/chime options.
- **Overlay** is click-through, non-focusable, never steals focus. States: listening (animated waveform + timer), transcribing (wisp spinner), success flash (last few words inserted), cancelled, error, nothing-heard. Hidden when idle.

## Visual identity — "aurora wisp"

Dark, ethereal, premium. **Absolutely no orange, no Anthropic-terracotta.** Ink backgrounds (#0B0E14, panels #10141D, borders #1E2430), soft light text (#E6EAF2, muted #8B93A7), and an aurora accent spectrum: cyan **#67E8F9** → teal **#5EEAD4** → violet **#A78BFA**. Accent gradients, soft outer glows, rounded (12–16px) surfaces, smooth 150–250 ms ease-out transitions. The logo/motif is an aurora voice waveform — five rounded gradient bars, an abstract sound mark (deliberately NOT a letterform: the name abbreviates to "SS", so any monogram/initials treatment is off-limits). Typeface: system stack (`Segoe UI Variable`, `Segoe UI`, sans-serif). The overlay pill glows faintly cyan while listening; the waveform bars use the aurora gradient. Design tokens live in `src/renderer/shared/theme.css` and both renderers must consume them.

## Architecture

Electron shell (main = CommonJS, renderers = vanilla HTML/CSS/JS, **no bundler, no framework**) + two local native pieces:

1. **SaySomethingHelper.exe** — a tiny C# executable compiled at setup time by the .NET Framework compiler that ships with Windows (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). Runs as a persistent child process speaking JSON-lines over stdin/stdout. Responsibilities:
   - Low-level keyboard hook (`WH_KEYBOARD_LL`) that reports **only the watched VKs** (hotkey + Esc) — see privacy rules below.
   - Text injection: clipboard-swap paste (save clipboard → set text → SendInput Ctrl+V → restore after delay) and a fallback "type" mode (SendInput `KEYEVENTF_UNICODE`).
   - Foreground-window info (exe name, title) on request.
2. **whisper-server.exe** — from the whisper.cpp v1.9.1 release (`whisper-bin-x64.zip`, cached at `third_party/whisper-bin-x64-v1.9.1.zip`, else downloaded from GitHub). Started at app boot on `127.0.0.1:8737` with the selected ggml model; kept warm; restarted with backoff on crash. Transcription = POST WAV to `/inference`.

Audio capture happens in the (hidden-capable) overlay renderer: `getUserMedia` → AudioWorklet → downsample to 16 kHz mono PCM16 → chunks over IPC to main → WAV assembly → whisper client → formatter → helper paste → history. Models (ggml, from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin`) download to `%APPDATA%/SaySomething/models` with progress UI. Default model: **small.en** (466 MB); catalog: tiny.en, base.en, small.en, medium.en, large-v3-turbo, plus multilingual tiny/base/small/medium for non-English. Threads for whisper: `max(4, cpuCount - 2)`.

**Zero runtime npm dependencies.** `electron` is the only devDependency. Downloads use Node's built-in `fetch`; unzipping uses `C:\Windows\System32\tar.exe` (bsdtar — handles zip; do NOT use bare `tar`, Git Bash's GNU tar fails on zips).

### Dictation state machine (src/main/state.js)

`idle → recording → transcribing → injecting → idle`, with:
- hotkey **down** (idle): start session — overlay `listening`, `audio:start`, note t0.
- hotkey **up**: if held < 250 ms → latch (stay recording); else finalize.
- hotkey **down** (latched recording): finalize. hotkey **down** (transcribing): start a *new* overlapping session (transcriptions queue FIFO; injections happen in session-start order).
- **Esc** (recording): cancel — `audio:abort`, overlay `cancelled`, nothing inserted. Esc is only watched while recording.
- Auto-finalize at `maxUtteranceSec` (default 300).
- Finalize: `audio:stop` → WAV from buffered chunks → transcribe (with dictionary prompt, temperature 0) → format → if empty: overlay `nothing-heard`, stop → else helper `paste` (or `type` per settings) → history add → overlay `success` flash.
- Any failure → overlay `error` with short human message + log; never crash the app; recover to idle.

### Text formatter (pure function, unit-testable)

Order: strip whisper artifacts (`[BLANK_AUDIO]`, `[Music]`, `(silence)`, `[inaudible]`, `♪`, etc.) → trim → voice commands (standalone case-insensitive phrases "new line" → `\n`, "new paragraph" → `\n\n`, cleaning adjacent punctuation/spacing) → filler removal (conservative: `\b(um+|uh+|erm|uhm|ahem)\b` with punctuation/space cleanup) → collapse repeated whitespace → auto-capitalize first alphabetical char → if `trailingSpace` and result doesn't end in whitespace/newline, append one space. Every step behind its settings toggle (`format.*`).

### Setup & run

- `npm install` then `node scripts/setup.js` — idempotent; steps: (1) unpack whisper binaries from `third_party/` cache or download; keep only the files whisper-server/whisper-cli need, into `bin/whisper/`; (2) compile SaySomethingHelper.exe into `bin/helper/`; (3) download the default model (or `--model <name>`) with a console progress bar; (4) run a self-check (server boots with model, helper answers ping) and print a status matrix.
- `npm start` → `electron .` — tray appears, whisper server warms, ready chime is NOT played (silent start), overlay hidden until first use.
- `npx electron . --smoke` → headless self-test mode: **no windows shown**; checks settings load, helper compile/spawn/ping, binaries present, server boot + `/inference` reachability (skip gracefully with a warning if no model downloaded yet); prints one JSON line per check + a final summary JSON; exits 0 if all present checks pass, 1 otherwise. Must run before `app.whenReady` window creation is triggered.
- `test/e2e-transcribe.ps1` — full-loop proof without a microphone: PowerShell `System.Speech` TTS synthesizes a known sentence to a 16 kHz WAV, POSTs it to the running (or self-started) whisper server, asserts key words appear in the response.
- `scripts/make-shortcut.ps1` — creates Start Menu + Desktop shortcuts targeting `node_modules\electron\dist\electron.exe` with the repo path as argument and `assets/SaySomething.ico` as icon. Launch-at-login uses `app.setLoginItemSettings` with the same target (best-effort).

### Privacy & security rules (hard requirements)

- The keyboard hook must **only ever emit watched VKs** (the configured hotkey; Esc only while recording; plus a one-shot "capture next key" mode for rebinding). It must never buffer, log, or transmit any other keystroke. No keystroke contents in logs.
- Injected input (`LLKHF_INJECTED`) must be ignored by the hook (prevents feedback from our own Ctrl+V/typing).
- Clipboard restore after paste (default 300 ms); best-effort restore of text-format clipboard content; if the clipboard held a non-text format, skip the swap and warn once (still paste, then leave our text — document this).
- Audio: pre-roll ring buffer lives only in renderer memory, is discarded unless a session starts, and audio is never written to disk (WAV exists only as an in-memory buffer for the POST). whisper-server binds 127.0.0.1 only.
- No network calls at runtime except localhost whisper; the only internet access is `scripts/setup.js`/model downloads (GitHub + Hugging Face) and it must say so on the console.
- **Runtime-network exception (v0.2 AI rewrite):** when — and only when — the user has enabled AI rewrite, Say Something may make localhost requests to a local Ollama daemon at `http://127.0.0.1:11434` (`GET /api/tags` to list installed models, `POST /api/chat` to rewrite the transcript). The host is a hard-coded constant (`127.0.0.1:11434`); there is no setting, env var, or code path that can point it at any other machine. Nothing is sent when rewrite is disabled. This is still fully on-device — no data leaves the machine.
- Helper compile source is checked into the repo (auditable); the exe is never downloaded.

### Error handling & resilience

Helper or whisper-server crash → auto-restart with exponential backoff (max 3 rapid retries, then tray/notification + overlay error). Mic permission denied → overlay error and settings hint linking `ms-settings:privacy-microphone`. Port 8737 busy → probe upward (8738…8747) and pass along. Single-instance lock (`app.requestSingleInstanceLock`). All logs to `%APPDATA%/SaySomething/logs/SaySomething.log` (size-capped ~1 MB, rotated once) with a `log.js` module — no `console.log` spray in main.

### C# constraints (SaySomethingHelper.cs)

`csc.exe` v4.0.30319 compiles **C# 5 only**: no string interpolation (`$"..."`), no null-conditional `?.`, no `nameof`, no expression-bodied members, no `out var`, no pattern matching, no tuples. `async/await` IS available. Target: `/target:winexe` (no console window), x64/AnyCPU, reference System.Windows.Forms (clipboard needs an STA thread — clipboard ops must run on an STA thread; the hook needs a message loop). Keep it in ONE file. JSON: hand-roll minimal JSON emit/parse for the fixed protocol (no external libs); protocol strings must be UTF-8 with `Console.OutputEncoding`/`InputEncoding` set accordingly.

### Non-goals for v1

No true server-side streaming endpoint (v0.3 ships display-only windowed live partials instead — see "Live preview" above; a real streaming decode remains out of scope), no per-app profiles, no auto-updates, no installer/code-signing (shortcut script instead), no macOS/Linux.

**Update (v0.2): local LLM rewriting is now a shipped feature** — an optional pipeline stage after the formatter that rewrites the transcript via a **local Ollama daemon only** (`http://127.0.0.1:11434`), never any other host, off by default, and always falls back to the un-rewritten text so a dictation is never lost. See the runtime-network exception in the privacy rules.
