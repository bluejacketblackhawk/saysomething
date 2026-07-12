<div align="center">

# Say Something

*You're sitting there quiet all day. Say Something.*

### Hold a key, talk, your words show up. Anywhere in Windows.

**Say Something** lets you talk instead of type. Hold **Right Ctrl** in any app, say your thing, let go, and the cleaned-up text drops in at your cursor about a second later. It runs 100% on your machine. Free, open-source, no account, no cloud, no subscription, no telemetry. None of that.

[![CI](https://github.com/bluejacketblackhawk/saysomething/actions/workflows/ci.yml/badge.svg)](https://github.com/bluejacketblackhawk/saysomething/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-5EEAD4.svg)](LICENSE)
[![100% local](https://img.shields.io/badge/100%25-local-67E8F9.svg)](#privacy)
[![No cloud](https://img.shields.io/badge/cloud-none-A78BFA.svg)](#privacy)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-8B93A7.svg)](#requirements)

<br />

<img src="assets/screenshots/overlay-listening.png" alt="Say Something overlay pill, listening, with a live aurora waveform" width="620" />

<em>The little pill while it's listening. Live waveform and a timer, so you know it's actually on.</em>

<br /><br />

<img src="assets/screenshots/settings.png" alt="Say Something settings window, General tab" width="760" />

<em>Settings: rebind the hotkey, grab models, dictionary, history, formatting. All local.</em>

<br /><br />

<img src="assets/screenshots/settings-rewrite.png" alt="Say Something settings window, Rewrite tab, with the local Ollama model picker" width="760" />

<em>The Rewrite tab: optional AI polish that runs locally through Ollama. Off by default, and if it flakes it just gives you your original words back.</em>

</div>

---

## The drop pad: catch your words, drag them where you want

Not sure which box has focus? Don't want it typing into the wrong window? Hold **Right Alt** instead of the main key and your words land in a little floating pad, already copied. Then just **grab the pad and drag it onto the field you want**, let go, and the text drops right there. Or hit **Ctrl+V** anywhere, it's copied either way. You catch your words and carry them exactly where they go. Every other dictation tool just fires text at whatever window's focused and hopes. This is the only one I've found that lets you aim. Wispr Flow doesn't.

## What it does

- **Hold to talk.** Hold the key (default **Right Ctrl**, you can rebind it), a glowing pill pops up, talk, let go, text drops in at your cursor.
- **Tap to go hands-free.** Quick tap (under 250 ms) and it keeps listening so you don't have to hold anything. Tap again to finish. **Esc** bails, nothing gets inserted.
- **Auto-stop when you stop.** In hands-free mode it notices when you go quiet and finishes on its own (silence window is adjustable, 1 to 5 seconds). The pill dims as the pause builds so it never feels random. Hold-to-talk never auto-stops.
- **Live preview.** Words show up in the pill while you're still talking. It's just a preview though. The final accurate pass on release is what actually gets inserted.
- **The drop pad.** See above. It's the good part.
- **Optional AI cleanup.** Off by default. Flip it on and every dictation gets polished by a local [Ollama](https://ollama.com) model first (Clean up, Professional, Casual, or Bullets). Runs on your box, no cloud. If it's slow or dies, you just get your plain text, nothing lost.
- **Warm mic.** Keeps a tiny rolling buffer so if you start talking a beat before you hit the key, your first word still makes it.
- **Smart formatting.** Punctuation, filler removal (um, uh), spoken commands (say "new line" or "new paragraph"), auto-caps, and it strips the junk Whisper sometimes emits. All toggleable.
- **Custom dictionary.** Feed it names and jargon so it stops mangling them.
- **Local history.** Last 200 transcriptions, click to copy, stored as a local JSON file. Turn it off if you want.
- **Private because of how it's built,** not because of a checkbox. Audio stays in memory, Whisper runs on `127.0.0.1` only, zero network calls at runtime.

## Say Something vs Wispr Flow

Straight up: Wispr Flow is a polished paid product and it does some things Say Something doesn't chase. The whole point here is it runs entirely on your machine and you can read every line of it.

| | **Say Something** | **Wispr Flow** |
|---|---|---|
| Price | Free, open-source (MIT) | Subscription |
| Transcription | On your machine (whisper.cpp) | Their cloud |
| Account | None | Required |
| Privacy | You can read the source; audio never leaves | Trust their policy |
| Works offline | Yes | No, needs the cloud |
| Platforms | Windows 10/11 | Windows and macOS |
| AI cleanup | Yes, local and free (optional, via Ollama) | Yes, cloud (part of the sub) |
| Live preview while talking | Yes, in the pill; inserted on release | Yes, streams into the field |
| Drop pad (catch text, place it with a click) | Yes | No |
| Custom dictionary | Yes | Yes |

If you want text streaming straight into the field as you talk, or you're on a Mac, Wispr Flow is the more complete thing today. If you want dictation that never phones home and that you fully own, that's this.

## The optional AI cleanup

You can have it hand each finished dictation to a local model for one last polish before it lands. Fix grammar, tighten it up, or turn a rambling thought into bullets. Four styles: **Clean up**, **Professional**, **Casual**, **Bullet points**.

- **Off by default.** None of this happens until you turn it on in **Settings → Rewrite**.
- **Runs on [Ollama](https://ollama.com),** a free local model runner you install once. Pull a model (`ollama pull llama3.2`) and it shows up in the picker.
- **Stays on your machine.** It talks to Ollama on `127.0.0.1:11434` and nowhere else. That address is hard-coded, not a setting. Nothing hits any cloud, and no network call happens at all unless you turn rewrite on.
- **Never loses your words.** Each rewrite gets 10 seconds. If the model is slow, down, or spits out garbage, you just get your original text.

## Requirements

- Windows 10/11 (x64)
- Node.js 24+
- The C# compiler that already ships with Windows (`csc.exe`). Used once at setup to build the tiny helper. Nothing gets downloaded to build it.

## Setup and run

```powershell
npm install            # installs Electron (the only devDependency)
node scripts/setup.js  # unpacks whisper, compiles the helper, grabs the default model
npm start              # launches, shows up in your system tray
```

- `npm start` runs the app.
- `npm run smoke` is a headless self-check (no windows, prints JSON, exits non-zero if something's off).
- `npm run setup` re-runs setup (add `--model <name>` for a specific model).
- `npm test` runs the unit tests.

Default model is **small.en** (466 MB). Smaller ones (`tiny.en`, `base.en`) and bigger ones (`medium.en`, `large-v3-turbo`), plus multilingual, are one click away in the Model tab.

## Building a release

Both of these bundle Whisper, the helper, and the default `small.en` model right into the package, so whoever runs it gets zero setup and no download.

```powershell
npm run dist:dir   # portable app -> dist\win-unpacked\  (also zipped)
npm run dist       # installer   -> dist\SaySomething-Setup-<version>.exe
```

Heads up: `npm run dist` (the installer) needs **Windows Developer Mode** on (Settings → Privacy & security → For developers → Developer Mode). electron-builder unpacks a signing toolkit that has some macOS symlinks in it, and making symlinks on Windows needs that permission. The portable `dist:dir` build doesn't need it. Builds are unsigned, so first launch you'll get a SmartScreen "unknown publisher" nag (More info → Run anyway) until it's code-signed.

## How it's built

An Electron shell (main is CommonJS, the windows are plain HTML/CSS/JS, no bundler, no framework) plus two small local native bits:

- **SaySomethingHelper.exe.** A tiny C# helper compiled at setup by Windows' own `csc.exe`. It sets a low-level keyboard hook (watched keys only), does the clipboard-swap paste and unicode typing, and reports the foreground window. Talks JSON over stdio. Source is right here in [`native/SaySomethingHelper.cs`](native/SaySomethingHelper.cs). You can read it. It's never downloaded.
- **whisper-server.exe.** From whisper.cpp v1.9.1, kept warm on `127.0.0.1:8737`. Transcription is a local `POST` to `/inference`.

**Zero runtime npm dependencies.** Downloads use Node's built-in `fetch`, unzipping uses Windows' own `tar.exe`.

Full spec is in [`docs/SPEC.md`](docs/SPEC.md), module layout in [`docs/CONTRACTS.md`](docs/CONTRACTS.md). Those are the source of truth.

## Privacy

Privacy here isn't a setting, it's how the thing is built.

- **The keyboard hook only ever reports your hotkey** (and Esc while recording). It never buffers, logs, or sends any other keystroke, and it ignores injected input so it can't feed on its own typing.
- **Audio only lives in memory** and never hits disk. The WAV exists just long enough to POST to the local server.
- **Whisper binds `127.0.0.1` only.** With AI rewrite off (the default), there are zero network calls at runtime, period.
- **The optional rewrite only talks to localhost.** If (and only if) you turn it on, it POSTs to Ollama on `127.0.0.1:11434`. That address is hard-coded. No cloud, ever.
- **The only time it uses the internet** is grabbing models and binaries at setup (GitHub and Hugging Face), and it tells you on the console.
- **The helper is compiled on your machine** from source that's checked in. The exe is never downloaded.

## Troubleshooting and FAQ

**Mic permission denied.** Windows can block mic access per app. Open **Settings → Privacy & security → Microphone** (or paste `ms-settings:privacy-microphone` into Run) and make sure desktop apps can use the mic. Restart the app.

**Port 8737 is busy.** It binds the whisper server to `127.0.0.1:8737`, and if that's taken it probes up through **8747** and grabs the first free one. Nothing for you to do unless all of them are busy, then free one up and restart.

**My first word gets clipped.** Turn on **Warm mic (pre-roll)** in Settings → General → Microphone (it's on by default). It keeps a short buffer so speech that starts right before the keypress still lands. Bump the slider up if you tend to jump the gun.

**A model download got interrupted.** Downloads go to a `.part` file and only get renamed once the full size checks out, so a half-download won't get mistaken for a real one. Just re-run it (Model tab, or `node scripts/setup.js --model <name>`).

**My antivirus flagged SaySomethingHelper.exe.** False positive. Some AVs freak out at any freshly compiled, unsigned exe that sets a keyboard hook. The full source is in [`native/SaySomethingHelper.cs`](native/SaySomethingHelper.cs) and it's compiled **on your machine** by Windows' own `csc.exe`, nothing downloaded. Read it, then allow-list `bin/helper/SaySomethingHelper.exe` if your AV keeps eating it.

**Hands-free stopped while I was still thinking.** In tap-to-latch mode it auto-stops when you go quiet. If it's cutting you off, bump the silence window up in **Settings → Hotkey** (up to 5 s) or just turn auto-stop off there. Hold-to-talk never auto-stops, hold as long as you want.

**It never stops in a loud room.** Constant background noise can keep the level above the quiet threshold so it never hears the pause. Just tap the key again to finish it yourself (and there's a max-length backstop for really long ones).

**Rewrite tab says "Ollama not detected."** The optional AI cleanup needs [Ollama](https://ollama.com) running. Install it, start it, pull a model (`ollama pull llama3.2`), then hit **Refresh**. It's off by default so this only matters if you want it, and if Ollama's ever unreachable you just get your plain text.

**Nothing happens when I hold the key.** Check the tray menu isn't **Paused**, confirm your hotkey in Settings → Hotkey, and make sure the helper's running (Settings → About → Input helper). If it keeps crashing, restarting the app reinstalls the hook.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code's laid out, who owns what, and the C# / no-dependency rules to keep.

> Regenerating the screenshots: `npx electron scripts/capture-screens.js` renders the pill and both settings tabs to `assets/screenshots/`.

## Support

Say Something is free forever, but you can [buy me a coffee ☕](https://ko-fi.com/bluejacketblackhawk). It's not actually coffee. It's a secret second thing.

## License

[MIT](LICENSE) © Say Something contributors.
