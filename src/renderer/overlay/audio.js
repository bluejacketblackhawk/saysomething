'use strict';

/*
 * SaySomething audio capture — owned by agent B (audio). Runs in the overlay renderer
 * (a page script; window.saysomething is provided by src/preload/overlay.js).
 *
 * Responsibilities:
 *  - getUserMedia with the selected deviceId, falling back to the default device.
 *  - Feed the mic into the AudioWorklet (worklet.js) which downsamples to 16 kHz
 *    mono PCM16 and posts ~100 ms chunks + ~30/s RMS levels.
 *  - Warm-mic pre-roll: a rolling ring buffer (renderer memory only, never disk)
 *    of the most recent idle audio; flushed FIRST when a session starts so the
 *    first word is never clipped.
 *  - Forward chunks to main over IPC as `audio:chunk` {sessionId, buf}.
 *  - Dispatch a `saysomething:level` window CustomEvent {detail:{rms}} while capturing.
 *  - Start / stop / cancel chimes via WebAudio oscillators (two-tone), gated on
 *    the per-session `chime` flag.
 *  - Mic failures surface as `audio:error` {message} with a human message.
 *
 * The overlay window is created hidden and always exists; the mic is requested
 * lazily on the first `audio:start` and the stream is kept open only while warm.
 */

(function () {
  var TARGET_RATE = 16000;
  var bridge = (typeof window !== 'undefined') ? window.saysomething : null;

  // --- WebAudio / capture graph ---
  var audioCtx = null;      // shared AudioContext (capture + chimes)
  var sinkNode = null;      // gain-0 sink so the worklet graph is pulled
  var moduleAdded = false;  // worklet module added to this context?
  var mediaStream = null;   // active MediaStream (or null)
  var sourceNode = null;    // MediaStreamAudioSourceNode
  var workletNode = null;   // AudioWorkletNode ('saysomething-downsampler')
  var streamDeviceId = null;// deviceId the current stream was opened with
  var opening = null;       // in-flight open promise (concurrency guard)

  // --- session / forwarding state ---
  var activeSessionId = null; // session currently being captured (or null = idle)
  var chimeOn = false;        // chime flag for the current session
  var keepWarm = false;       // keep the stream open after stop?

  // --- latched auto-stop VAD (armed by main via audio:vad after a tap latches) ---
  var vad = null;             // SaySomethingVad instance, or null when disarmed
  var vadSessionId = null;    // session the VAD is armed for
  var vadLastAt = 0;          // timestamp of the last level fed to the VAD

  // --- pre-roll ring buffer (idle audio only) ---
  var ring = [];              // array of Int16Array chunks
  var ringSamples = 0;        // total samples buffered in `ring`
  var preRollSamples = 0;     // target ring capacity in samples

  // ------------------------------------------------------------------ helpers

  function safeSend(channel, payload) {
    try {
      if (bridge && typeof bridge.send === 'function') bridge.send(channel, payload);
    } catch (e) { /* never let IPC issues crash capture */ }
  }

  function warn(msg) {
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[SaySomething audio] ' + msg); } catch (e) { /* ignore */ }
  }

  function humanMicError(err) {
    var name = (err && err.name) ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return 'Microphone access is blocked. Enable it in Windows Settings › Privacy › Microphone.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'No microphone was found. Connect a mic and try again.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The microphone is in use by another app. Close it and try again.';
    }
    return 'Could not start the microphone.';
  }

  function reportError(err) {
    warn('error: ' + ((err && err.message) ? err.message : String(err)));
    activeSessionId = null;
    clearVad();
    safeSend('audio:error', { message: humanMicError(err) });
  }

  // --------------------------------------------------------------- WebAudio

  function workletUrl() {
    // worklet.js is a sibling of the overlay HTML document.
    try { return new URL('worklet.js', document.baseURI).toString(); } catch (e) { return 'worklet.js'; }
  }

  function ensureContext() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) { /* ignore */ } }
      return moduleAdded ? Promise.resolve() : addWorkletModule();
    }
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctor();
    } catch (e) {
      return Promise.reject(new Error('Audio system unavailable'));
    }
    // Silent sink keeps the (output-less) worklet in the render graph.
    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;
    sinkNode.connect(audioCtx.destination);
    return addWorkletModule();
  }

  function addWorkletModule() {
    if (!audioCtx || !audioCtx.audioWorklet) {
      return Promise.reject(new Error('AudioWorklet unavailable'));
    }
    return audioCtx.audioWorklet.addModule(workletUrl()).then(function () { moduleAdded = true; });
  }

  function onWorkletMessage(e) {
    var d = e && e.data;
    if (!d) return;
    if (d.type === 'chunk') {
      handleChunk(new Int16Array(d.buf));
    } else if (d.type === 'level') {
      if (activeSessionId != null) dispatchLevel(d.rms);
      // Feed the SAME level into the VAD (no second analysis path) when armed for
      // the currently-capturing session.
      if (vad && vadSessionId != null && vadSessionId === activeSessionId) feedVad(d.rms);
    }
  }

  function getUserMediaWithFallback(deviceId) {
    return navigator.mediaDevices.getUserMedia(constraintsFor(deviceId)).catch(function (err) {
      var name = err && err.name;
      var denied = (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError');
      // Fall back to the default device if a *specific* one could not open, but
      // never retry on a permission denial (default would fail the same way).
      if (deviceId && deviceId !== 'default' && !denied) {
        warn('device open failed (' + name + '); falling back to default');
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      throw err;
    });
  }

  function openStream(deviceId) {
    return ensureContext()
      .then(function () { return getUserMediaWithFallback(deviceId); })
      .then(function (stream) {
        mediaStream = stream;
        streamDeviceId = deviceId;
        sourceNode = audioCtx.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(audioCtx, 'saysomething-downsampler');
        workletNode.port.onmessage = onWorkletMessage;
        sourceNode.connect(workletNode);
        workletNode.connect(sinkNode); // pulled by the graph; silent
      });
  }

  function constraintsFor(deviceId) {
    if (deviceId && deviceId !== 'default') {
      return { audio: { deviceId: { exact: deviceId } }, video: false };
    }
    return { audio: true, video: false };
  }

  function ensureStream(deviceId) {
    if (mediaStream && streamDeviceId === deviceId && workletNode) {
      return Promise.resolve();
    }
    if (opening) {
      return opening.then(function () { return ensureStream(deviceId); });
    }
    if (mediaStream) teardownStream(); // device changed — reopen
    opening = openStream(deviceId).then(
      function () { opening = null; },
      function (err) { opening = null; throw err; }
    );
    return opening;
  }

  function teardownStream() {
    try { if (sourceNode) sourceNode.disconnect(); } catch (e) { /* ignore */ }
    try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch (e) { /* ignore */ }
    if (mediaStream) {
      try {
        var tracks = mediaStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (e2) { /* ignore */ } }
      } catch (e) { /* ignore */ }
    }
    sourceNode = null;
    workletNode = null;
    mediaStream = null;
    streamDeviceId = null;
    ring = [];
    ringSamples = 0;
    // audioCtx + sinkNode are kept for reuse (and for chimes).
  }

  // ------------------------------------------------------------ ring buffer

  function trimRing() {
    while (ring.length > 0 && (ringSamples - ring[0].length) >= preRollSamples) {
      ringSamples -= ring.shift().length;
    }
  }

  function handleChunk(int16arr) {
    if (activeSessionId != null) {
      sendChunk(activeSessionId, int16arr);
    } else {
      // Idle: accumulate pre-roll (only meaningful while warm).
      ring.push(int16arr);
      ringSamples += int16arr.length;
      trimRing();
    }
  }

  function sendChunk(sessionId, int16arr) {
    // Structured-clone copies the buffer across IPC, so `ring` references stay valid.
    safeSend('audio:chunk', { sessionId: sessionId, buf: int16arr.buffer });
  }

  function flushPreRoll(sessionId) {
    for (var i = 0; i < ring.length; i++) sendChunk(sessionId, ring[i]);
    ring = [];
    ringSamples = 0;
  }

  function dispatchLevel(rms) {
    try { window.dispatchEvent(new CustomEvent('saysomething:level', { detail: { rms: rms } })); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------- auto-stop VAD

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // overlay.js listens for this to dim the pill toward the auto-stop cutoff.
  function dispatchVad(active, progress) {
    try {
      window.dispatchEvent(new CustomEvent('saysomething:vad', { detail: { active: !!active, progress: progress || 0 } }));
    } catch (e) { /* ignore */ }
  }

  function clearVad(silent) {
    var wasArmed = !!vad;
    vad = null;
    vadSessionId = null;
    vadLastAt = 0;
    if (wasArmed && !silent) dispatchVad(false, 0);
  }

  // main -> overlay: arm (enabled) or disarm the latched auto-stop detector.
  function onVad(p) {
    var sid = p && p.sessionId;
    if (sid == null) return;
    if (!p.enabled) { if (vadSessionId === sid) clearVad(); return; }
    var VadLib = (typeof window !== 'undefined') ? window.SaySomethingVad : null;
    if (!VadLib || typeof VadLib.createVad !== 'function') { warn('VAD library unavailable'); return; }
    var ms = (typeof p.silenceMs === 'number' && p.silenceMs > 0) ? p.silenceMs : 2000;
    try {
      vad = VadLib.createVad({ silenceMs: ms });
      vadSessionId = sid;
      vadLastAt = 0;
    } catch (e) {
      warn('VAD create failed: ' + ((e && e.message) || e));
      vad = null;
      vadSessionId = null;
    }
  }

  function feedVad(rms) {
    var t = nowMs();
    var dt = vadLastAt ? (t - vadLastAt) : 0;
    vadLastAt = t;
    // Guard against pauses/hitches so a stalled render thread can't inflate silence.
    if (!(dt > 0) || dt > 1000) dt = 1000 / 30;
    var r;
    try {
      r = vad.push(rms, dt);
    } catch (e) {
      warn('VAD push failed: ' + ((e && e.message) || e));
      clearVad();
      return;
    }
    if (r && r.fire) {
      var sid = vadSessionId;
      clearVad(true);            // fire exactly once; stop feeding this session
      dispatchVad(false, 0);
      safeSend('audio:silence', { sessionId: sid });
    } else {
      dispatchVad(true, r ? r.progress : 0);
    }
  }

  // ---------------------------------------------------------------- chimes

  function playChime(kind) {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') { audioCtx.resume(); }
      var now = audioCtx.currentTime;
      var tones;
      if (kind === 'start') tones = [587.33, 880.0];       // up  (D5 → A5)
      else if (kind === 'stop') tones = [880.0, 587.33];   // down (A5 → D5)
      else tones = [440.0, 293.66];                         // cancel: low (A4 → D4)

      var toneDur = 0.085;
      var gap = 0.075;
      for (var i = 0; i < tones.length; i++) {
        var t0 = now + i * gap;
        var osc = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(tones[i], t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.13, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + toneDur);
        osc.connect(g);
        g.connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + toneDur + 0.02);
      }
    } catch (e) { /* a chime must never crash capture */ }
  }

  // --------------------------------------------------------- IPC handlers

  function onStart(p) {
    var sessionId = p && p.sessionId;
    if (sessionId == null) { warn('audio:start without sessionId'); return; }
    if (activeSessionId != null) {
      warn('audio:start while session ' + activeSessionId + ' active; replacing');
    }

    // A fresh session starts un-latched: any prior VAD arming is void.
    clearVad(true);

    chimeOn = !!(p && p.chime);
    keepWarm = !!(p && p.warm);
    var preRollMs = (p && typeof p.preRollMs === 'number') ? p.preRollMs : 0;
    preRollSamples = Math.max(0, Math.round(preRollMs / 1000 * TARGET_RATE));
    var deviceId = (p && p.deviceId) || 'default';

    if (chimeOn) playChime('start'); // immediate; independent of stream readiness

    ensureStream(deviceId).then(function () {
      // Set active then flush pre-roll synchronously so buffered idle audio is
      // delivered BEFORE any live chunk (no interleaving is possible here).
      activeSessionId = sessionId;
      flushPreRoll(sessionId);
      safeSend('audio:started', { sessionId: sessionId });
    }).catch(function (err) {
      reportError(err);
    });
  }

  function onStop(p) {
    var sessionId = p && p.sessionId;
    var wasActive = (activeSessionId != null && sessionId === activeSessionId);
    if (wasActive) {
      activeSessionId = null;
      if (chimeOn) playChime('stop');
    }
    if (vadSessionId === sessionId) clearVad();
    safeSend('audio:stopped', { sessionId: sessionId });
    if (wasActive && !keepWarm) teardownStream();
  }

  function onAbort(p) {
    var sessionId = p && p.sessionId;
    var wasActive = (activeSessionId != null && (sessionId == null || sessionId === activeSessionId));
    if (wasActive) {
      activeSessionId = null;
      if (chimeOn) playChime('cancel');
      if (!keepWarm) teardownStream();
    }
    if (sessionId == null || vadSessionId === sessionId) clearVad();
    // No outgoing ack for abort (no such channel); cancellation is silent to main.
  }

  // ------------------------------------------------------------------- init

  function init() {
    if (!bridge || typeof bridge.on !== 'function') {
      warn('window.saysomething bridge unavailable; audio disabled');
      return;
    }
    bridge.on('audio:start', onStart);
    bridge.on('audio:stop', onStop);
    bridge.on('audio:abort', onAbort);
    bridge.on('audio:vad', onVad);
  }

  init();
})();
