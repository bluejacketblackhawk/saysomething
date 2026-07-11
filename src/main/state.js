'use strict';

/**
 * Dictation state machine (agent I — integrator).
 *
 * Implements the SPEC machine: idle -> recording -> transcribing -> injecting ->
 * idle, with tap-to-latch, hold-to-dictate, Esc-to-cancel, overlapping sessions,
 * and all overlay:state transitions.
 *
 * Key rules (docs/SPEC.md "Dictation state machine"):
 *  - hotkey DOWN (idle / transcribing): start a NEW session — overlay `listening`,
 *    audio:start, note t0.
 *  - hotkey UP: held < 250 ms => latch (stay recording, hands-free); else finalize.
 *  - hotkey DOWN (latched): finalize.
 *  - Esc DOWN (recording only): cancel — audio:abort, overlay `cancelled`, nothing
 *    inserted. Esc(27) is added to the watched set only while recording.
 *  - Auto-finalize at maxUtteranceSec (default 300 s).
 *  - Finalize: audio:stop -> WAV -> transcribe (dictionary prompt, temperature 0)
 *    -> format -> empty => overlay `nothing-heard`; else paste/type -> history add
 *    -> overlay `success` flash -> auto-hide.
 *  - Any failure => overlay `error` with a short human message + log; never crash;
 *    recover to idle.
 *
 * Overlapping sessions: only one session is ever in the RECORDING phase at a time
 * (you cannot press the hotkey again while physically holding it, and a latched
 * session already released). Overlap happens when a prior session is still
 * transcribing/injecting while a new one records. The visible overlay is owned by
 * the most-recently-started session; older sessions inject their text silently.
 * Injection order is guaranteed to match session-start order via a FIFO chain
 * (transcription is already FIFO one-in-flight in the whisper client).
 */

const ipc = require('./ipc');
const log = require('./log');
const settingsStore = require('./stores/settings');
const helper = require('./helper');
const hotkeyMatch = require('./hotkey-match');
const audioSession = require('./audio-session');
const client = require('./whisper/client');
const streaming = require('./whisper/streaming');
const formatter = require('./whisper/formatter');
const rewriter = require('./whisper/rewrite');
const history = require('./stores/history');
const windows = require('./windows');

const TAP_MS = 250;          // < this held-duration => latch (tap), else finalize
const ESC_VK = 27;

// Overlay display durations (ms) before auto-hiding back to `hidden`.
const SUCCESS_MS = 1200;     // matches overlay.css successFade
const NOTHING_MS = 1500;
const CANCELLED_MS = 900;
const ERROR_MS = 2500;

// --- machine state ---------------------------------------------------------
let started = false;
let hotkeyVk = 163;          // main (inject-at-caret) hotkey — kept in sync w/ settings
let hotkeyMods = [];         // modifier VKs that must be held with hotkeyVk (issue #1)
let padHotkeyVk = 165;       // drop-pad hotkey (Right Alt by default)
let padHotkeyMods = [];      // modifier VKs that must be held with padHotkeyVk
let padEnabled = true;       // whether the pad hotkey is watched/active
let heldVk = 0;              // which gesture (trigger) key is physically down; 0 = none
let heldKeys = Object.create(null); // all physically-held watched VKs, for combo matching
let recording = null;        // the session currently RECORDING, or null (max one)
let sessionSeq = 0;          // monotonic session id source
let padText = null;          // text currently held by the open drop pad, or null

// Overlay ownership: the session id currently controlling the visible pill.
let overlayOwner = null;
let hideTimer = null;

// FIFO chain so injections land in session-start order regardless of timing.
let injectChain = Promise.resolve();

// Count of authoritative final passes currently outstanding (finalize → transcribe
// → inject). Live partials for a NEW overlapping session are suppressed while > 0
// so their FIFO-bypassing interim POSTs can't delay a prior session's final pass.
let pendingFinals = 0;

// Last-seen auto-stop enabled state, so onChange can detect the OFF transition and
// disarm the renderer VAD for a session that is already latched and recording.
let autoStopEnabled = false;

// ---------------------------------------------------------------------------
// overlay helpers
// ---------------------------------------------------------------------------

function sendOverlayState(state, detail) {
  const wc = windows.getOverlayWC();
  if (!wc) return;
  try {
    wc.send(ipc.OVERLAY_STATE, { state: state, detail: detail || {} });
  } catch (e) {
    log.error('state: overlay send failed', e);
  }
}

function sendOverlayPartial(sessionId, text) {
  const wc = windows.getOverlayWC();
  if (!wc) return;
  try {
    wc.send(ipc.OVERLAY_PARTIAL, { sessionId: sessionId, text: text });
  } catch (e) {
    log.error('state: overlay partial send failed', e);
  }
}

// Deliver a live interim transcript to the pill — display-only. Guarded so a
// partial that resolves after the session finalized (or after a newer session
// took the overlay) is dropped rather than shown stale.
function onPartial(sessionId, rawText) {
  if (!recording || recording.id !== sessionId) return; // finalized / different session
  if (overlayOwner !== sessionId) return;                // a newer session owns the pill
  const text = formatter.formatPartial(rawText);
  if (!text) return;
  sendOverlayPartial(sessionId, text);
}

// Begin live partials for a session when the feature is enabled. Best-effort:
// failure here must never affect the authoritative capture/transcribe path.
function startStreaming(session, st) {
  if (!(st.streaming && st.streaming.enabled)) return;
  // Don't contend with a prior session's still-running authoritative pass — the
  // overlapping session records + finalizes normally, just without live preview.
  if (pendingFinals > 0) {
    log.debug('state: live partials suppressed — a final pass is in flight (session ' + session.id + ')');
    return;
  }
  try {
    streaming.start({
      sessionId: session.id,
      prompt: buildPrompt(st.dictionary),
      language: languageFor(st),
      onPartial: onPartial,
    });
  } catch (e) {
    log.error('state: streaming.start failed', e);
  }
}

// ---------------------------------------------------------------------------
// latched auto-stop (VAD)
// ---------------------------------------------------------------------------

// Read the auto-stop config, normalising to the settings range (1000–5000 ms).
function autoStopCfg(st) {
  const a = st && st.autoStop;
  const enabled = !!(a && a.enabled);
  let ms = (a && typeof a.silenceMs === 'number') ? a.silenceMs : 2000;
  if (ms < 1000) ms = 1000; else if (ms > 5000) ms = 5000;
  return { enabled: enabled, silenceMs: ms };
}

// Arm (or disarm) the renderer-side VAD for a specific session. The renderer only
// runs the detector while the session is capturing; held sessions are never armed.
function sendAudioVad(sessionId, enabled, silenceMs) {
  const wc = windows.getOverlayWC();
  if (!wc) return;
  try {
    wc.send(ipc.AUDIO_VAD, { sessionId: sessionId, enabled: !!enabled, silenceMs: silenceMs || 0 });
  } catch (e) {
    log.error('state: audio:vad send failed', e);
  }
}

function clearHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function scheduleHide(session, ms) {
  clearHide();
  hideTimer = setTimeout(function () {
    hideTimer = null;
    if (overlayOwner === session.id) {
      overlayOwner = null;
      try { windows.hideOverlay(); } catch (e) { /* ignore */ }
      sendOverlayState('hidden', {});
    }
  }, ms);
}

// A session takes over the overlay when it starts recording.
function overlayListening(session) {
  overlayOwner = session.id;
  clearHide();
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('listening', { t0: session.t0 });
}

// The remaining transitions only touch the overlay if the session still owns it.
function overlayTranscribing(session) {
  if (overlayOwner !== session.id) return;
  clearHide();
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('transcribing', {});
}

// Rewriting reuses the transcribing visual (overlay.js maps 'rewriting' onto the
// same spinner) with a distinct label — no overlay redesign, just a new label.
function overlayRewriting(session) {
  if (overlayOwner !== session.id) return;
  clearHide();
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('rewriting', {});
}

function overlaySuccess(session, text) {
  if (overlayOwner !== session.id) return;
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('success', { text: text });
  scheduleHide(session, SUCCESS_MS);
}

function overlayNothingHeard(session) {
  if (overlayOwner !== session.id) return;
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('nothing-heard', {});
  scheduleHide(session, NOTHING_MS);
}

function overlayCancelled(session) {
  if (overlayOwner !== session.id) return;
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('cancelled', {});
  scheduleHide(session, CANCELLED_MS);
}

function overlayError(session, message) {
  if (overlayOwner !== session.id) return;
  try { windows.showOverlay(); } catch (e) { /* ignore */ }
  sendOverlayState('error', { message: message || 'Something went wrong' });
  scheduleHide(session, ERROR_MS);
}

// ---------------------------------------------------------------------------
// watch set (hotkey always; Esc only while recording)
// ---------------------------------------------------------------------------

function sameVks(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function updateWatch(isRecording) {
  const set = Object.create(null);
  function add(vk) { set[vk] = true; }
  // A combo binding watches its trigger AND every physical variant of each
  // modifier, so their up/down events populate heldKeys for matching (issue #1).
  const mainKeys = hotkeyMatch.watchKeysFor(hotkeyVk, hotkeyMods);
  for (let i = 0; i < mainKeys.length; i++) add(mainKeys[i]);
  if (padEnabled && padHotkeyVk) {
    // Not gated on padHotkeyVk !== hotkeyVk: a combo may share a trigger vk with the
    // main hotkey but differ by modifier, and both modifier sets must be watched.
    // The set de-dupes (issue #1 review).
    const padKeys = hotkeyMatch.watchKeysFor(padHotkeyVk, padHotkeyMods);
    for (let i = 0; i < padKeys.length; i++) add(padKeys[i]);
  }
  if (isRecording) add(ESC_VK);
  const vks = Object.keys(set).map(Number);
  try { helper.watch(vks); } catch (e) { log.error('state: watch failed', e); }
}

// ---------------------------------------------------------------------------
// transcription helpers
// ---------------------------------------------------------------------------

function buildPrompt(dictionary) {
  if (!Array.isArray(dictionary) || dictionary.length === 0) return '';
  return dictionary.filter(function (w) { return typeof w === 'string' && w.trim(); }).join(', ');
}

// English-only models must be given 'en' (or nothing). Multilingual models honour
// the chosen language; 'auto' means let whisper detect (omit the field).
function languageFor(st) {
  const model = (st && st.model) || '';
  if (/\.en$/.test(model)) return 'en';
  const lang = st && st.language;
  if (!lang || lang === 'auto') return undefined;
  return lang;
}

// ---------------------------------------------------------------------------
// session lifecycle
// ---------------------------------------------------------------------------

function maxUtteranceMs(st) {
  const secs = (st && typeof st.maxUtteranceSec === 'number') ? st.maxUtteranceSec : 300;
  return Math.max(1, secs) * 1000;
}

function startRecording(vk, isPad) {
  const st = settingsStore.get();
  const mode = (isPad && padEnabled) ? 'pad' : 'inject';
  const s = { id: ++sessionSeq, t0: Date.now(), phase: 'pressing', vk: vk, mode: mode, maxTimer: null, aborted: false };
  recording = s;

  // A new dictation supersedes any open pad.
  try { windows.hidePad(); } catch (e) { /* ignore */ }
  padText = null;

  updateWatch(true);
  overlayListening(s);

  try {
    audioSession.begin({
      sessionId: s.id,
      deviceId: (st.mic && st.mic.deviceId) || 'default',
      preRollMs: (st.mic && typeof st.mic.preRollMs === 'number') ? st.mic.preRollMs : 0,
      warm: !!(st.mic && st.mic.warm),
      chime: !!(st.overlay && st.overlay.chime),
    });
  } catch (e) {
    log.error('state: audioSession.begin failed', e);
  }

  startStreaming(s, st);

  s.maxTimer = setTimeout(function () {
    if (recording === s && !s.aborted) {
      if (settingsStore.get().paused) {
        // Paused mid-recording: never inject while paused — discard instead.
        log.info('state: max-utterance reached while paused — cancelling (session ' + s.id + ')');
        cancel(s);
        return;
      }
      log.info('state: auto-finalize at maxUtteranceSec (session ' + s.id + ')');
      finalize(s);
    }
  }, maxUtteranceMs(st));
}

function finalize(session) {
  if (recording !== session) return;
  recording = null;
  if (session.maxTimer) { clearTimeout(session.maxTimer); session.maxTimer = null; }
  session.phase = 'finalizing';

  // Abort any in-flight interim NOW so the authoritative final pass owns the
  // warm server with no contention.
  streaming.stop(session.id);

  updateWatch(false);
  overlayTranscribing(session);

  // Capture the focused window now (before transcription latency) for history.
  const fgPromise = helper.foreground().then(
    function (fg) { return fg; },
    function () { return null; }
  );

  // audio:stop + assemble WAV. finish() always resolves (never rejects).
  const wavPromise = audioSession.finish(session.id);

  // Chain so injection order == finalize order == session-start order. Each link
  // isolates its own failure so one bad session cannot stall the queue.
  // pendingFinals gates live partials for any overlapping session (see
  // startStreaming) — bumped now, cleared when this pass fully settles.
  pendingFinals++;
  injectChain = injectChain.then(function () {
    return processSession(session, wavPromise, fgPromise);
  }).then(function () {
    pendingFinals--;
  }, function (e) {
    pendingFinals--;
    log.error('state: process chain error', e);
  });
}

function cancel(session) {
  if (recording !== session) return;
  recording = null;
  session.aborted = true;
  if (session.maxTimer) { clearTimeout(session.maxTimer); session.maxTimer = null; }

  streaming.stop(session.id);
  updateWatch(false);
  try { audioSession.abort(session.id); } catch (e) { log.error('state: abort failed', e); }
  overlayCancelled(session);
  log.info('state: session ' + session.id + ' cancelled');
}

function processSession(session, wavPromise, fgPromise) {
  return wavPromise.then(function (wav) {
    const st = settingsStore.get();
    const opts = { prompt: buildPrompt(st.dictionary), language: languageFor(st) };
    return client.transcribe(wav, opts).then(function (result) {
      const raw = (result && result.text) || '';
      const text = formatter.format(raw, st.format);
      if (!text) {
        log.info('state: nothing heard (session ' + session.id + ')');
        overlayNothingHeard(session);
        return;
      }
      // Optional AI-rewrite stage: AFTER the formatter, BEFORE delivery. Always
      // resolves to deliverable text — never loses the dictation.
      return maybeRewrite(session, st, text).then(function (finalText) {
        if (session.mode === 'pad') {
          return padDeliver(session, finalText, (result && result.ms) || 0, fgPromise);
        }
        return inject(session, st, finalText, (result && result.ms) || 0, fgPromise);
      });
    }, function (err) {
      log.error('state: transcribe failed (session ' + session.id + ')', err);
      overlayError(session, 'Transcription failed');
    });
  });
}

// Optional local AI-rewrite stage. Resolves to the text to inject: the sanitised
// rewrite when enabled + Ollama reachable + output usable, otherwise the original
// formatted `text`. NEVER rejects — a rewrite failure must never lose a dictation.
function maybeRewrite(session, st, text) {
  const rw = st && st.rewrite;
  if (!rw || !rw.enabled || !rw.model) return Promise.resolve(text);

  overlayRewriting(session);
  return rewriter.rewrite(text, {
    model: rw.model,
    style: rw.style,
    timeoutMs: rw.timeoutMs,
    endpoint: rw.endpoint,
    api: rw.api,
  }).then(function (res) {
    if (res && typeof res.text === 'string' && res.text) {
      // Re-apply the trailing-space rule so injection spacing matches the
      // formatter's contract (the model trims; sanitize trims too).
      let out = res.text;
      const wantSpace = !(st.format && st.format.trailingSpace === false);
      if (wantSpace && !/\s$/.test(out)) out += ' ';
      log.info('state: rewrite applied (' + rw.style + ' / ' + rw.model + ', session ' + session.id + ')');
      return out;
    }
    log.info('state: rewrite skipped, using original — ' + (res && res.reason || 'unknown') + ' (session ' + session.id + ')');
    return text;
  }, function (err) {
    // rewriter.rewrite is contracted never to reject; this is belt-and-braces.
    log.warn('state: rewrite errored, using original — ' + (err && err.message || err));
    return text;
  });
}

function inject(session, st, text, ms, fgPromise) {
  const mode = (st.inject && st.inject.mode === 'type') ? 'type' : 'paste';
  const restoreMs = (st.inject && typeof st.inject.restoreClipboardMs === 'number')
    ? st.inject.restoreClipboardMs : 300;

  const op = (mode === 'type') ? helper.type(text) : helper.paste(text, restoreMs);

  return op.then(function (res) {
    if (!res || !res.ok) {
      log.warn('state: injection reported failure: ' + (res && res.err));
      overlayError(session, 'Could not insert text');
      return;
    }
    return fgPromise.then(function (fg) {
      try {
        history.add({ text: text, ms: ms, app: (fg && fg.exe) || '' });
      } catch (e) {
        log.error('state: history.add failed', e);
      }
      overlaySuccess(session, text);
    });
  }, function (err) {
    log.error('state: injection failed (session ' + session.id + ')', err);
    overlayError(session, 'Could not insert text');
  });
}

// ---------------------------------------------------------------------------
// drop pad delivery + actions (pad-mode sessions)
// ---------------------------------------------------------------------------

// A pad-mode session: auto-copy the text, record history, hand the overlay off to
// the floating pad. The user then places it (padDrop) or just pastes (Ctrl+V).
function padDeliver(session, text, ms, fgPromise) {
  return helper.copy(text).then(function () {}, function () {}).then(function () {
    return fgPromise.then(function (fg) {
      try { history.add({ text: text, ms: ms, app: (fg && fg.exe) || '' }); }
      catch (e) { log.error('state: history.add failed', e); }
    }, function () {});
  }).then(function () {
    padText = text;
    // The pad supersedes the pill for this session.
    if (overlayOwner === session.id) {
      overlayOwner = null;
      try { windows.hideOverlay(); } catch (e) { /* ignore */ }
      sendOverlayState('hidden', {});
    }
    const wc = windows.getPadWC();
    if (wc) { try { wc.send(ipc.PAD_SHOW, { text: text }); } catch (e) { /* ignore */ } }
    try { windows.showPad(); } catch (e) { /* ignore */ }
    log.info('state: drop pad shown (session ' + session.id + ')');
  });
}

/** Pad "Drop here": pick a click point, then place the text there. */
function padDrop() {
  if (!padText) return;
  const st = settingsStore.get();
  const restoreMs = (st.inject && typeof st.inject.restoreClipboardMs === 'number')
    ? st.inject.restoreClipboardMs : 300;
  const text = padText;
  try { windows.hidePad(); } catch (e) { /* ignore */ } // get out of the way for the click
  helper.pickPoint().then(function (pt) {
    return helper.placeAt(text, pt.x, pt.y, restoreMs);
  }).then(function () {
    padText = null; // placed successfully; pad stays hidden
    log.info('state: drop pad placed text');
  }, function (err) {
    log.warn('state: drop pad place cancelled/failed — ' + (err && err.message));
    // Re-show the pad so the user can retry or just paste.
    if (padText) {
      const wc = windows.getPadWC();
      if (wc) { try { wc.send(ipc.PAD_SHOW, { text: padText }); } catch (e) { /* ignore */ } }
      try { windows.showPad(); } catch (e) { /* ignore */ }
    }
  });
}

/** Pad "Copy": re-copy the current text to the clipboard. */
function padCopy() {
  if (!padText) return;
  helper.copy(padText).then(function () {}, function () {});
}

/** Pad dismiss (✕ / Esc): close the pad and forget its text. */
function padDismiss() {
  padText = null;
  try { windows.hidePad(); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// input handlers
// ---------------------------------------------------------------------------

function onGestureDown(vk, isPad) {
  if (heldVk === vk) return; // OS key-repeat while physically held — ignore
  if (heldVk !== 0) return;  // another gesture key already held — ignore the second
  heldVk = vk;

  if (settingsStore.get().paused) return;

  if (recording) {
    // A latched (hands-free) session is ended by pressing ITS OWN hotkey again. A
    // 'pressing' session cannot receive another DOWN without an UP first.
    if (recording.phase === 'latched' && recording.vk === vk) finalize(recording);
    return;
  }

  // idle, or a previous session is still transcribing/injecting => new session.
  startRecording(vk, isPad);
}

function onGestureUp(vk) {
  if (heldVk !== vk) return;
  heldVk = 0;

  if (settingsStore.get().paused) return;
  if (!recording || recording.phase !== 'pressing' || recording.vk !== vk) return;

  const held = Date.now() - recording.t0;
  if (held < TAP_MS) {
    recording.phase = 'latched'; // tap => hands-free latch; keep recording
    // Auto-stop applies ONLY to latched sessions. Arm the renderer VAD now (a
    // held session reaches finalize() above and is never armed).
    const cfg = autoStopCfg(settingsStore.get());
    if (cfg.enabled) {
      sendAudioVad(recording.id, true, cfg.silenceMs);
      log.info('state: auto-stop armed (session ' + recording.id + ', silence ' + cfg.silenceMs + 'ms)');
    }
  } else {
    finalize(recording);         // hold => finish and transcribe
  }
}

function onKey(info) {
  if (!info || typeof info.vk !== 'number') return;
  const vk = info.vk;
  // Prefer the helper's authoritative physical-key snapshot (immune to key-ups
  // missed across a UAC / lock-screen transition, issue #1 review); fall back to
  // incremental tracking when an older helper sends no snapshot.
  if (Array.isArray(info.held)) {
    const next = Object.create(null);
    for (let i = 0; i < info.held.length; i++) next[info.held[i] | 0] = true;
    heldKeys = next;
  }
  // Apply the current event authoritatively (the snapshot can lag an in-flight up).
  if (info.down) heldKeys[vk] = true; else delete heldKeys[vk];

  if (vk === ESC_VK) {
    if (info.down && recording) cancel(recording);
    return;
  }

  const isMainVk = (vk === hotkeyVk);
  const isPadVk = (padEnabled && vk === padHotkeyVk);
  if (!isMainVk && !isPadVk) return; // a watched modifier — tracked only, never a gesture

  if (info.down) {
    // A trigger vk may be shared between the main and pad bindings (differing only
    // by modifier), so resolve WHICH binding fired by its modifiers, preferring the
    // more specific one on a tie (issue #1 review).
    const mainOk = isMainVk && hotkeyMatch.modsSatisfied(hotkeyMods, heldKeys);
    const padOk = isPadVk && hotkeyMatch.modsSatisfied(padHotkeyMods, heldKeys);
    let asPad;
    if (mainOk && padOk) asPad = (padHotkeyMods.length > hotkeyMods.length);
    else if (padOk) asPad = true;
    else if (mainOk) asPad = false;
    else return; // required modifiers not held
    onGestureDown(vk, asPad);
  } else {
    onGestureUp(vk);
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Surface a renderer-reported mic/audio failure. Aborts any active recording and
 * shows the human-readable message on the overlay.
 * @param {string} message
 */
function audioError(message) {
  log.warn('state: audio error: ' + (message || ''));
  const s = recording;
  if (!s) return;
  recording = null;
  s.aborted = true;
  if (s.maxTimer) { clearTimeout(s.maxTimer); s.maxTimer = null; }
  streaming.stop(s.id);
  updateWatch(false);
  try { audioSession.abort(s.id); } catch (e) { /* ignore */ }
  overlayError(s, message || 'Microphone error');
}

/**
 * The renderer VAD reported end-of-speech for a latched session. Treat it exactly
 * like the second tap (finalize) — but ONLY if that exact session is still the
 * one recording AND latched AND auto-stop is still enabled. Stray/late events
 * (idle, transcribing, hold-mode, wrong session, paused) are ignored.
 * @param {number} sessionId
 */
function silence(sessionId) {
  const s = recording;
  if (!s || s.id !== sessionId) return;      // idle, or a different/newer session
  if (s.phase !== 'latched') return;         // hold-mode / still pressing — never auto-stop
  if (settingsStore.get().paused) return;    // paused: don't inject
  if (!autoStopCfg(settingsStore.get()).enabled) return; // toggled off mid-session
  log.info('state: auto-stop on silence (session ' + s.id + ')');
  finalize(s);
}

/**
 * Wire the state machine to helper key events and keep the watched hotkey in sync
 * with settings. Idempotent. main.js sets the initial watch([hotkey]).
 */
function init() {
  if (started) return;
  started = true;

  try {
    const s0 = settingsStore.get();
    hotkeyVk = s0.hotkey.vk;
    hotkeyMods = Array.isArray(s0.hotkey.mods) ? s0.hotkey.mods.slice() : [];
    if (s0.padHotkey && typeof s0.padHotkey.vk === 'number') padHotkeyVk = s0.padHotkey.vk;
    padHotkeyMods = (s0.padHotkey && Array.isArray(s0.padHotkey.mods)) ? s0.padHotkey.mods.slice() : [];
    padEnabled = !!(s0.pad && s0.pad.enabled);
  } catch (e) { /* defaults */ }
  try { autoStopEnabled = autoStopCfg(settingsStore.get()).enabled; } catch (e) { /* default false */ }

  helper.on('key', onKey);

  helper.on('crash', function (info) {
    log.warn('state: helper crashed (code=' + (info && info.code) + ') — supervisor will restart');
    // The physical key-up that would end an in-flight session is lost across the
    // crash window, so reset input state: abort any active recording and clear the
    // held flag so the next real press starts a fresh session (otherwise
    // hotkeyDown stays true forever and the hotkey goes dead).
    if (recording) {
      try { cancel(recording); } catch (e) { log.error('state: crash cleanup failed', e); }
    }
    heldVk = 0;
    heldKeys = Object.create(null);
    updateWatch(false); // re-assert the idle watch set once the helper is back
  });

  settingsStore.onChange(function (s) {
    try {
      const vk = s.hotkey.vk;
      const mods = Array.isArray(s.hotkey.mods) ? s.hotkey.mods : [];
      const pvk = s.padHotkey && s.padHotkey.vk;
      const pmods = (s.padHotkey && Array.isArray(s.padHotkey.mods)) ? s.padHotkey.mods : [];
      const pen = !!(s.pad && s.pad.enabled);
      let rewatch = false;
      if (typeof vk === 'number' && (vk !== hotkeyVk || !sameVks(mods, hotkeyMods))) {
        hotkeyVk = vk; hotkeyMods = mods.slice(); rewatch = true;
        log.info('state: hotkey re-bound to vk ' + vk + ' (' + s.hotkey.name + ')');
      }
      if ((typeof pvk === 'number' && (pvk !== padHotkeyVk || !sameVks(pmods, padHotkeyMods))) || pen !== padEnabled) {
        if (typeof pvk === 'number') { padHotkeyVk = pvk; padHotkeyMods = pmods.slice(); }
        padEnabled = pen; rewatch = true;
        log.info('state: pad hotkey ' + (pen ? 'vk ' + padHotkeyVk : 'disabled'));
      }
      // A rebind can change which physical keys populate heldKeys; drop stale
      // state so a modifier held during the settings change can't linger.
      if (rewatch) { heldKeys = Object.create(null); updateWatch(!!recording); }
      // Pausing must never leave an in-flight session to auto-finalize and inject
      // later — kill it now. Idempotent: no-op when nothing is recording.
      if (s.paused && recording) {
        log.info('state: paused during recording — cancelling session ' + recording.id);
        cancel(recording);
      }
      // Turning auto-stop OFF mid-session must stop the renderer VAD's countdown:
      // otherwise the pill keeps dimming toward a cutoff that silence() now ignores
      // (finding #3). Only a latched, still-recording session is ever armed.
      const nowAutoStop = autoStopCfg(s).enabled;
      if (autoStopEnabled && !nowAutoStop && recording && recording.phase === 'latched') {
        log.info('state: auto-stop disabled mid-session — disarming VAD (session ' + recording.id + ')');
        sendAudioVad(recording.id, false, 0);
      }
      autoStopEnabled = nowAutoStop;
    } catch (e) {
      log.error('state: onChange handling failed', e);
    }
  });

  updateWatch(false); // set the initial watched set (main hotkey + pad hotkey)
  log.info('state: initialized (hotkey vk ' + hotkeyVk + ', pad vk ' + (padEnabled ? padHotkeyVk : 'off') + ')');
}

module.exports = {
  init: init,
  audioError: audioError,
  silence: silence,
  padDrop: padDrop,
  padCopy: padCopy,
  padDismiss: padDismiss,
};
