'use strict';

/*
 * SaySomething VAD — energy-based voice-activity detector for latched auto-stop.
 * Owned by agent B (audio); consumed by audio.js in the overlay renderer, and
 * unit-tested in plain node (test/vad-test.js) — hence the dual UMD-lite export.
 *
 * This is a PURE state machine: it takes a stream of RMS levels (the same levels
 * the worklet already computes for the waveform — no second analysis path) plus
 * the milliseconds elapsed since the previous sample, and reports when the user
 * has stopped speaking. It never touches the DOM, the mic, or IPC.
 *
 * Algorithm (see docs/SPEC.md v0.2 auto-stop):
 *   - Noise floor is adaptive: seeded from the first ~calibMs of audio, then it
 *     tracks the quietest recent level (drops instantly to a new minimum, drifts
 *     up only very slowly) so it follows the room's ambient noise, not speech.
 *   - Two hysteresis thresholds derived from the floor: a higher `speechThresh`
 *     to confirm speech, a lower `silenceThresh` to confirm silence. The gap
 *     between them keeps quiet speech tails and breaths from reading as silence.
 *   - Speech must be sustained above `speechThresh` for `speechOnMs` before the
 *     session is marked as "has spoken". Auto-stop NEVER fires before that — a
 *     session where the user never speaks is left for the max-utterance timer.
 *   - Once speech has occurred, contiguous time below `silenceThresh` accumulates.
 *     Any energy back above `silenceThresh` resets the accumulator, so a mid-
 *     sentence pause shorter than `silenceMs` can never cut the user off.
 *   - When the accumulator reaches `silenceMs`, `fire` is reported exactly once.
 *
 * push(rms, dtMs) -> {
 *   fire, hasSpoken, speaking, progress /* 0..1 toward cutoff *\/, floor,
 *   speechThresh, silenceThresh
 * }
 */

(function (root) {
  var DEFAULTS = {
    silenceMs: 2000,     // silence needed to auto-stop (settings range 1000..5000)
    calibMs: 300,        // initial noise-floor calibration window
    levelHz: 30,         // nominal level cadence (used only if dt is omitted)
    floorInit: 0.01,     // pre-calibration floor guess
    floorRise: 0.0025,   // slow upward floor adaptation, per sample
    speechMult: 3.0,     // speechThresh = floor*speechMult + speechAbs
    speechAbs: 0.006,
    silenceMult: 1.8,    // silenceThresh = floor*silenceMult + silenceAbs
    silenceAbs: 0.003,
    speechOnMs: 120,     // sustained speech required before "has spoken"
  };

  function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
  }

  function createVad(opts) {
    opts = opts || {};
    var cfg = {};
    for (var k in DEFAULTS) { cfg[k] = num(opts[k], DEFAULTS[k]); }
    if (cfg.silenceMs < 1) cfg.silenceMs = DEFAULTS.silenceMs;

    var floor = cfg.floorInit;
    var calibMin = 0;       // quietest sample seen during calibration (floor seed)
    var calibN = 0;
    var calibElapsed = 0;

    var aboveMs = 0;        // contiguous ms above speechThresh (onset debounce)
    var silenceAccum = 0;   // contiguous ms below silenceThresh (after speech)
    var hasSpoken = false;
    var done = false;       // latched true after firing — never fires twice

    function verdict(fire, speaking, speechThresh, silenceThresh) {
      var progress = (hasSpoken && cfg.silenceMs > 0)
        ? Math.min(1, silenceAccum / cfg.silenceMs) : 0;
      return {
        fire: !!fire,
        hasSpoken: hasSpoken,
        speaking: !!speaking,
        progress: progress,
        floor: floor,
        speechThresh: speechThresh,
        silenceThresh: silenceThresh,
      };
    }

    function push(rms, dtMs) {
      var dt = (typeof dtMs === 'number' && dtMs > 0) ? dtMs : (1000 / cfg.levelHz);
      // Defense-in-depth dt clamp: audio.js already clamps before calling, but the
      // pure module must not trust its caller. A single huge dt (a stalled render
      // thread) could otherwise inflate the silence accumulator past silenceMs and
      // auto-stop on one sample. Bound one step to [1, 1000] ms.
      if (dt < 1) dt = 1; else if (dt > 1000) dt = 1000;
      var r = (typeof rms === 'number' && isFinite(rms) && rms >= 0) ? rms : 0;

      // --- calibration: seed the floor from the QUIETEST sample in the first
      // calibMs, NOT the average. If the user is already speaking when the session
      // latches, an average would seed the floor partway up to the speech level and
      // silenceThresh would sit above the room noise, so auto-stop could never fire
      // until the first real pause (finding #2). The minimum ignores the loud
      // samples: a single quiet moment anywhere in the window seeds a correct floor.
      // A window that is speech end-to-end still seeds high, but the instant-down
      // adaptation below re-seeds the floor on the first pause and rescues it.
      if (calibElapsed < cfg.calibMs) {
        calibMin = (calibN === 0 || r < calibMin) ? r : calibMin;
        calibN += 1;
        calibElapsed += dt;
        floor = calibMin;
        return verdict(false, false, floor * cfg.speechMult + cfg.speechAbs,
                       floor * cfg.silenceMult + cfg.silenceAbs);
      }

      // Derive the two hysteresis thresholds from the CURRENT floor BEFORE adapting,
      // so classification and floor adaptation agree on what counts as silence.
      var speechThresh = floor * cfg.speechMult + cfg.speechAbs;
      var silenceThresh = floor * cfg.silenceMult + cfg.silenceAbs;
      if (silenceThresh >= speechThresh) silenceThresh = speechThresh * 0.85;

      // --- adapt floor: instant DOWN to a new minimum; rise slowly ONLY from
      // samples that read as silence (below silenceThresh). A steady level held
      // ABOVE the silence band — a sustained vowel, a hum, a machine tone — must
      // never drag the floor upward (finding #1). The old unconditional EWMA rise
      // let the floor climb toward any level above it, so a perfectly steady input
      // (which never dips to re-seed a low floor) pushed silenceThresh up until it
      // crossed the live level and auto-stop fired mid-utterance. Adapting upward
      // only from silence keeps the floor an estimate of the room, not of speech.
      if (r < floor) {
        floor = r;
      } else if (r < silenceThresh) {
        floor = floor + (r - floor) * cfg.floorRise;
      }

      var speaking = false;
      if (r > speechThresh) {
        // confirmed speech energy
        aboveMs += dt;
        if (aboveMs >= cfg.speechOnMs) hasSpoken = true;
        speaking = true;
        silenceAccum = 0;
      } else if (r > silenceThresh) {
        // hysteresis band: not loud enough to (re)confirm onset, but too loud to
        // count as silence — hold steady, don't accumulate silence.
        aboveMs = 0;
        speaking = hasSpoken;
        silenceAccum = 0;
      } else {
        // below the silence floor
        aboveMs = 0;
        speaking = false;
        if (hasSpoken) silenceAccum += dt;
      }

      var fire = false;
      if (hasSpoken && !done && silenceAccum >= cfg.silenceMs) {
        fire = true;
        done = true;
      }
      return verdict(fire, speaking, speechThresh, silenceThresh);
    }

    function reset() {
      floor = cfg.floorInit;
      calibMin = 0;
      calibN = calibElapsed = 0;
      aboveMs = silenceAccum = 0;
      hasSpoken = false;
      done = false;
    }

    return {
      push: push,
      reset: reset,
      config: cfg,
    };
  }

  var api = { createVad: createVad, DEFAULTS: DEFAULTS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SaySomethingVad = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
