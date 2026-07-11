# Security policy

Say Something is local-first by design: your audio, keystrokes, clipboard, and
transcripts never leave your machine. There are no runtime network calls except
the local whisper server on `127.0.0.1` — and, only if you turn it on, a local
Ollama on `127.0.0.1`. The only time the app touches the internet is when you
download a model, and downloaded binaries/models are checked against pinned
SHA-256 digests.

## Reporting a vulnerability

Please **don't open a public issue for security problems.** Instead, use GitHub's
private **"Report a vulnerability"** button under this repository's **Security**
tab (Settings → Security → enable it if you're the maintainer). I'll acknowledge
within a few days.

Especially interested in anything that could:

- send a user's audio, keystrokes, clipboard, or text off the device;
- escape the renderer sandbox or the IPC channel whitelists;
- abuse the native helper (keyboard/mouse hooks, clipboard, input injection);
- undermine the integrity of the downloaded model or whisper binaries.
