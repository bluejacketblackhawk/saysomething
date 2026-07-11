'use strict';

/* =============================================================================
 * SaySomething — overlay pill driver
 * -----------------------------------------------------------------------------
 * Plain browser script (loaded via <script>, no modules). Responsibilities:
 *   - subscribe to overlay:state (main -> renderer) and switch the pill state
 *   - render a liquid 24-bar waveform driven by the saysomething:level CustomEvent
 *     (detail.rms) dispatched ~30/s by audio.js, interpolated to 60fps
 *   - run the mm:ss elapsed timer from detail.t0 while listening
 *   - show a short message for transcribing / success / cancelled /
 *     nothing-heard / error
 *
 * All visual state lives in CSS ([data-state] on .pill). This file only sets the
 * state, feeds the waveform, and writes text. Animation touches transform/opacity
 * only. Nothing here throws to the point of breaking the page.
 * ========================================================================== */

(function () {
  var NUM_BARS = 24;

  // Aurora stops for the per-bar horizontal sweep: cyan -> teal -> violet.
  var STOP_CYAN = [103, 232, 249];
  var STOP_TEAL = [94, 234, 212];
  var STOP_VIOLET = [167, 139, 250];

  var pill = document.getElementById('pill');
  var wave = document.getElementById('wave');
  var msg = document.getElementById('msg');
  var partialEl = document.getElementById('partial');
  var timerEl = document.getElementById('timer');

  // ---- waveform state ------------------------------------------------------
  var bars = [];          // DOM nodes
  var cur = [];           // current displayed scale (0..1), smoothed
  var level = 0;          // smoothed overall loudness (0..1)
  var targetLevel = 0;    // latest mapped rms (0..1)
  var lastLevelAt = 0;    // timestamp of last saysomething:level event
  var phase = 0;          // traveling-wave phase

  var rafId = 0;
  var running = false;
  var t0 = 0;
  var lastShownSec = -1;

  // -------------------------------------------------------------------------
  // Build the 24 bars once, colouring each along the aurora sweep.
  // -------------------------------------------------------------------------
  function lerp(a, b, t) { return a + (b - a) * t; }

  function barColor(t) {
    var from, to, tt;
    if (t < 0.5) { from = STOP_CYAN; to = STOP_TEAL; tt = t / 0.5; }
    else { from = STOP_TEAL; to = STOP_VIOLET; tt = (t - 0.5) / 0.5; }
    var r = Math.round(lerp(from[0], to[0], tt));
    var g = Math.round(lerp(from[1], to[1], tt));
    var b = Math.round(lerp(from[2], to[2], tt));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function buildBars() {
    if (!wave || bars.length) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < NUM_BARS; i++) {
      var b = document.createElement('i');
      b.className = 'bar';
      b.style.background = barColor(i / (NUM_BARS - 1));
      frag.appendChild(b);
      bars.push(b);
      cur.push(0.08);
    }
    wave.appendChild(frag);
  }

  function resetWave() {
    for (var i = 0; i < cur.length; i++) cur[i] = 0.08;
    level = 0;
    targetLevel = 0;
    phase = 0;
  }

  // -------------------------------------------------------------------------
  // Map an incoming rms (~0..0.4 for speech) to a perceptual 0..1 level.
  // -------------------------------------------------------------------------
  function mapRms(rms) {
    if (typeof rms !== 'number' || !isFinite(rms) || rms < 0) return 0;
    var v = Math.sqrt(rms) * 1.9;      // sqrt curve = livelier at low volume
    if (v > 1) v = 1;
    return v;
  }

  // -------------------------------------------------------------------------
  // 60fps render loop (active only while listening).
  // -------------------------------------------------------------------------
  function frame(now) {
    if (!running) return;

    // Decay the target when level events go stale (mic silent / stream gone).
    if (now - lastLevelAt > 180) targetLevel *= 0.9;

    // Attack fast, release slow — feels responsive but settles smoothly.
    var k = targetLevel > level ? 0.4 : 0.12;
    level += (targetLevel - level) * k;

    phase += 0.09;

    for (var i = 0; i < NUM_BARS; i++) {
      // centre bars a touch taller (hann-ish envelope)
      var env = 0.6 + 0.4 * Math.sin(Math.PI * (i + 0.5) / NUM_BARS);
      // two offset sines -> liquid traveling shimmer
      var wob = 0.5 + 0.5 * Math.sin(phase * 1.7 + i * 0.55)
                    * Math.cos(phase * 0.6 - i * 0.22);
      var target = level * env * (0.55 + 0.45 * wob);

      // gentle idle baseline so the wave never goes flat/dead
      var base = 0.07 + 0.03 * Math.sin(phase * 0.9 + i * 0.7);
      if (target < base) target = base;
      if (target > 1) target = 1;

      // liquid interpolation: quick to rise, slow to fall
      var speed = target > cur[i] ? 0.5 : 0.2;
      cur[i] += (target - cur[i]) * speed;

      var s = cur[i] < 0.04 ? 0.04 : cur[i];
      bars[i].style.transform = 'scaleY(' + s.toFixed(3) + ')';
    }

    updateTimer();
    rafId = requestAnimationFrame(frame);
  }

  function startLoop() {
    if (running) return;
    running = true;
    lastLevelAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  // -------------------------------------------------------------------------
  // Timer
  // -------------------------------------------------------------------------
  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function updateTimer() {
    if (!t0) return;
    var elapsed = Date.now() - t0;
    if (elapsed < 0) elapsed = 0;
    var sec = Math.floor(elapsed / 1000);
    if (sec !== lastShownSec) {
      lastShownSec = sec;
      if (timerEl) timerEl.textContent = fmt(sec);
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  function tail(text, n) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    return '…' + t.slice(t.length - n);
  }

  function setMsg(html) {
    if (msg) msg.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Live partial transcript (display-only). textContent — NEVER innerHTML:
  // transcripts are untrusted input. Shows the tail so growing text stays readable.
  function clearPartial() {
    if (partialEl) partialEl.textContent = '';
    if (pill) pill.classList.remove('has-partial');
  }

  function showPartial(text) {
    // Only meaningful while actually listening; ignore late/stray partials.
    if (!pill || pill.getAttribute('data-state') !== 'listening') return;
    var t = tail(text, 46);
    if (!t) { clearPartial(); return; }
    if (partialEl) partialEl.textContent = t;
    pill.classList.add('has-partial');
  }

  // -------------------------------------------------------------------------
  // State machine entry point
  // -------------------------------------------------------------------------
  function applyState(state, detail) {
    detail = detail || {};
    if (!pill) return;

    // Any state transition clears a stale partial; it only reappears when a fresh
    // overlay:partial arrives during 'listening'.
    clearPartial();

    switch (state) {
      case 'listening':
        t0 = (typeof detail.t0 === 'number' && isFinite(detail.t0)) ? detail.t0 : Date.now();
        lastShownSec = -1;
        if (timerEl) timerEl.textContent = '0:00';
        resetWave();
        clearVad();
        setMsg('');
        pill.setAttribute('data-state', 'listening');
        startLoop();
        break;

      case 'transcribing':
        stopLoop();
        setMsg('<span class="label">Transcribing…</span>');
        pill.setAttribute('data-state', 'transcribing');
        break;

      // Optional AI-rewrite stage (v0.2). Reuses the transcribing visual — same
      // spinner, distinct label — so no new overlay CSS/redesign is needed.
      case 'rewriting':
        stopLoop();
        setMsg('<span class="label">Polishing…</span>');
        pill.setAttribute('data-state', 'transcribing');
        break;

      case 'success':
        stopLoop();
        setMsg(escapeHtml(tail(detail.text, 40)) || '<span class="label">Inserted</span>');
        pill.setAttribute('data-state', 'success');
        break;

      case 'cancelled':
        stopLoop();
        setMsg('<span class="label">Cancelled</span>');
        pill.setAttribute('data-state', 'cancelled');
        break;

      case 'nothing-heard':
        stopLoop();
        setMsg('<span class="label">Didn’t catch that</span>');
        pill.setAttribute('data-state', 'nothing-heard');
        break;

      case 'error':
        stopLoop();
        setMsg(escapeHtml(tail(detail.message || 'Something went wrong', 44)));
        pill.setAttribute('data-state', 'error');
        break;

      case 'hidden':
      default:
        stopLoop();
        clearVad();
        t0 = 0;
        setMsg('');
        pill.setAttribute('data-state', 'hidden');
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-stop (VAD) feedback: as silence accumulates while latched, dim the pill
  // toward the cutoff so the auto-stop never feels random. Driven by the
  // saysomething:vad CustomEvent from audio.js (detail.progress 0..1). Opacity-only.
  // -------------------------------------------------------------------------
  function clearVad() {
    if (!pill) return;
    pill.removeAttribute('data-vad');
    pill.style.removeProperty('--vad');
  }

  function applyVad(active, progress) {
    if (!pill) return;
    // Only meaningful while the pill is actually listening (latched recording).
    if (!active || pill.getAttribute('data-state') !== 'listening') { clearVad(); return; }
    var p = (typeof progress === 'number' && isFinite(progress)) ? progress : 0;
    if (p < 0) p = 0; else if (p > 1) p = 1;
    pill.style.setProperty('--vad', p.toFixed(3));
    pill.setAttribute('data-vad', 'on');
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  buildBars();

  // level feed from audio.js (window CustomEvent, never crosses IPC)
  window.addEventListener('saysomething:level', function (e) {
    var d = e && e.detail;
    if (!d) return;
    targetLevel = mapRms(d.rms);
    lastLevelAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  });

  // auto-stop countdown feed from audio.js (window CustomEvent, never IPC)
  window.addEventListener('saysomething:vad', function (e) {
    var d = e && e.detail;
    if (!d) return;
    applyVad(d.active, d.progress);
  });

  // state feed from main
  if (window.saysomething && typeof window.saysomething.on === 'function') {
    window.saysomething.on('overlay:state', function (payload) {
      payload = payload || {};
      applyState(payload.state, payload.detail);
    });
    // live partial transcript feed from main (display-only)
    window.saysomething.on('overlay:partial', function (payload) {
      payload = payload || {};
      showPartial(payload.text);
    });
  }

  // Debug/standalone hook (harmless in production): lets a harness drive states
  // and levels without the IPC bridge.
  window.__saysomethingOverlay = {
    applyState: applyState,
    partial: showPartial,
    level: function (rms) {
      window.dispatchEvent(new CustomEvent('saysomething:level', { detail: { rms: rms } }));
    },
    vad: function (active, progress) {
      window.dispatchEvent(new CustomEvent('saysomething:vad', { detail: { active: active, progress: progress } }));
    }
  };
})();
