'use strict';

/* =============================================================================
 * SaySomething — drop pad driver (plain browser script; no modules).
 * Shows the transcribed text (auto-copied), and lets the user place it:
 *   - drag the pad -> pad:move (follow the cursor), then pad:place (drop at the
 *     release point; main hides the pad and pastes at that screen point)
 *   - "Copy"       -> pad:copy   (re-copy to clipboard)
 *   - "✕" / Esc    -> pad:dismiss
 * Text is set via textContent ONLY (transcripts are untrusted input).
 * ========================================================================== */

(function () {
  var pad = document.getElementById('pad');
  var textEl = document.getElementById('text');
  var hint = document.getElementById('hint');
  var copyBtn = document.getElementById('copy');
  var dismissBtn = document.getElementById('dismiss');

  var api = window.saysomething;

  function send(ch, payload) {
    try { if (api && api.send) api.send(ch, payload); } catch (e) { /* ignore */ }
  }

  var DEFAULT_HINT = 'Grab me and drag onto a text box to drop it in. Or just paste, already copied.';

  function resetHint() {
    if (hint) { hint.textContent = DEFAULT_HINT; hint.classList.remove('armed'); }
  }

  function show(text) {
    if (textEl) textEl.textContent = (text == null ? '' : String(text));
    resetHint();
    if (pad) pad.classList.add('show');
  }

  // ---- drag-to-drop --------------------------------------------------------
  // Grab the pad, drag it over a text box, release to drop. The window follows
  // the cursor (pad:move); on release the text is placed at the release point
  // (pad:place). A move threshold means a plain click is never treated as a drop.
  var dragging = false, moved = false, grabDX = 0, grabDY = 0, startSX = 0, startSY = 0;

  function isButton(el) {
    while (el && el !== pad) {
      if (el.tagName === 'BUTTON') return true;
      el = el.parentNode;
    }
    return false;
  }

  function endDrag(e, place) {
    if (!dragging) return;
    dragging = false;
    try { pad.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pad.classList.remove('dragging');
    if (place && moved) send('pad:place', { x: Math.round(e.screenX), y: Math.round(e.screenY) });
    else resetHint();
  }

  if (pad) {
    pad.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || isButton(e.target)) return; // primary button only; let buttons work
      dragging = true;
      moved = false;
      grabDX = e.clientX;   // pointer offset within the window (frameless => window origin)
      grabDY = e.clientY;
      startSX = e.screenX;
      startSY = e.screenY;
      try { pad.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pad.classList.add('dragging');
      if (hint) { hint.textContent = 'Let go over a text box…'; hint.classList.add('armed'); }
    });
    pad.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      if (Math.abs(e.screenX - startSX) > 3 || Math.abs(e.screenY - startSY) > 3) moved = true;
      // window top-left = cursor screen pos - cursor offset within the window
      send('pad:move', { x: Math.round(e.screenX - grabDX), y: Math.round(e.screenY - grabDY) });
    });
    pad.addEventListener('pointerup', function (e) { endDrag(e, true); });
    pad.addEventListener('pointercancel', function (e) { endDrag(e, false); });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      send('pad:copy', { text: textEl ? textEl.textContent : '' });
      if (hint) { hint.textContent = 'Copied. Paste anywhere.'; hint.classList.remove('armed'); }
    });
  }
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function () { send('pad:dismiss'); });
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') send('pad:dismiss');
  });

  if (api && api.on) {
    api.on('pad:show', function (payload) {
      payload = payload || {};
      show(payload.text);
    });
  }

  // Standalone/debug hook (harmless in production).
  window.__saysomethingPad = { show: show };
})();
