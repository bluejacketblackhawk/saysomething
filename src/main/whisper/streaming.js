'use strict';

/**
 * Live partial-transcript driver (main process).
 *
 * whisper-server v1.9.1 has no streaming endpoint — it only serves one-shot POST
 * /inference. So "words as you speak" is produced here by WINDOWED interim
 * re-transcription: while a session records, this driver periodically snapshots
 * the audio captured so far (audio-session.snapshot) and transcribes the growing
 * buffer on the already-warm server, pushing each interim result to the overlay.
 *
 * Hard invariants (these are what make it safe + trustworthy, not flickery):
 *  - Partials are DISPLAY-ONLY: never injected, never written to history. The
 *    authoritative text always comes from state.js's final pass on release.
 *  - ONE interim in flight at a time; ticks that land while one is running skip.
 *  - Cancellable DELIVERY: stop() aborts the in-flight fetch so no stale partial
 *    is shown after release. NOTE: whisper-server v1.9.1 decodes synchronously
 *    under its context mutex and does NOT cancel on client disconnect, so an
 *    already-running decode still finishes server-side. To bound how long that
 *    can delay the authoritative final pass, each interim decodes only a bounded
 *    TRAILING window (WINDOW_SAMPLES), not the whole growing buffer.
 *  - Bounded cost: interims stop being scheduled past MAX_STREAM_MS of audio
 *    (partials matter for short/medium dictation; long dictation still finalizes
 *    normally, just without live preview past the cap).
 *  - Throttled: a new interim only fires when at least MIN_NEW_SAMPLES of fresh
 *    audio arrived since the last one, so we don't re-decode an unchanged buffer.
 *
 * One driver instance per app; only one recording session exists at a time, so a
 * single active-session slot is sufficient. start()/stop() are keyed by sessionId
 * to defend against stale stop() calls from an older session.
 */

const audioSession = require('../audio-session');
const client = require('./client');
const log = require('../log');

const INTERVAL_MS = 900;          // cadence between interim passes
const MIN_NEW_SAMPLES = 16000 * 0.4; // ≥0.4 s of new audio before re-transcribing
const MIN_FIRST_SAMPLES = 16000 * 0.5; // wait for ≥0.5 s before the first partial
const MAX_STREAM_MS = 45000;      // stop scheduling interims past this much audio
const WINDOW_SAMPLES = 16000 * 12; // decode only the trailing ~12 s per interim, so
                                   // an un-cancellable in-flight decode stays cheap

let active = null; // { sessionId, prompt, language, onPartial, timer, controller, inflight, lastSamples, startedAt }

function schedule() {
  if (!active) return;
  active.timer = setTimeout(tick, INTERVAL_MS);
  if (active.timer.unref) active.timer.unref();
}

function tick() {
  const a = active;
  if (!a) return;
  a.timer = null;

  // Past the cost cap: stop scheduling (leave any last partial on screen).
  if (Date.now() - a.startedAt > MAX_STREAM_MS) {
    log.debug('streaming: interim cap reached (session ' + a.sessionId + ')');
    return;
  }
  // An interim is still running — don't pile up; re-check next tick.
  if (a.inflight) { schedule(); return; }

  const snap = audioSession.snapshot(a.sessionId, WINDOW_SAMPLES);
  if (!snap) { schedule(); return; } // session gone or no audio yet
  // Throttle on TOTAL captured audio (keeps growing) — not the capped window
  // count, which plateaus at WINDOW_SAMPLES and would otherwise freeze the gate.
  const enough = a.lastSamples === 0
    ? snap.totalSamples >= MIN_FIRST_SAMPLES
    : snap.totalSamples - a.lastSamples >= MIN_NEW_SAMPLES;
  if (!enough) { schedule(); return; }

  a.lastSamples = snap.totalSamples;
  a.inflight = true;
  a.controller = new AbortController();
  const forSession = a.sessionId;

  client.transcribePartial(snap.wav, {
    prompt: a.prompt,
    language: a.language,
    signal: a.controller.signal,
  }).then(function (res) {
    // Only deliver if THIS session is still the active one (not stopped/replaced).
    if (active && active.sessionId === forSession) {
      const text = (res && res.text) || '';
      try { a.onPartial(forSession, text); } catch (e) { log.error('streaming: onPartial threw', e); }
    }
  }, function () {
    // Aborted / timed out / server busy — partials are best-effort; ignore.
  }).then(function () {
    if (active && active.sessionId === forSession) {
      active.inflight = false;
      active.controller = null;
      schedule();
    }
  });
}

/**
 * Begin driving live partials for a recording session.
 * @param {{sessionId:number, prompt?:string, language?:string,
 *          onPartial:(sessionId:number, text:string)=>void}} opts
 */
function start(opts) {
  opts = opts || {};
  if (opts.sessionId == null || typeof opts.onPartial !== 'function') return;
  stop(); // never run two drivers at once
  active = {
    sessionId: opts.sessionId,
    prompt: opts.prompt || '',
    language: opts.language,
    onPartial: opts.onPartial,
    timer: null,
    controller: null,
    inflight: false,
    lastSamples: 0,
    startedAt: Date.now(),
  };
  schedule();
}

/**
 * Stop driving partials. If a sessionId is given, only stops when it matches the
 * active session (guards against a stale stop from an older session). Aborts any
 * in-flight interim so the final pass gets the server immediately.
 * @param {number} [sessionId]
 */
function stop(sessionId) {
  if (!active) return;
  if (sessionId != null && active.sessionId !== sessionId) return;
  if (active.timer) { clearTimeout(active.timer); active.timer = null; }
  if (active.controller) { try { active.controller.abort(); } catch (e) { /* ignore */ } }
  active = null;
}

module.exports = {
  start: start,
  stop: stop,
};
