'use strict';

/* =============================================================================
 * SaySomething — drop pad driver (plain browser script; no modules).
 * Shows the transcribed text (auto-copied), and lets the user place it:
 *   - "Drop here"  -> pad:drop  (main arms a one-shot click pick, then pastes there)
 *   - "Copy"       -> pad:copy  (re-copy to clipboard)
 *   - "✕" / Esc    -> pad:dismiss
 * Text is set via textContent ONLY (transcripts are untrusted input).
 * ========================================================================== */

(function () {
  var pad = document.getElementById('pad');
  var textEl = document.getElementById('text');
  var hint = document.getElementById('hint');
  var dropBtn = document.getElementById('drop');
  var copyBtn = document.getElementById('copy');
  var dismissBtn = document.getElementById('dismiss');

  var api = window.saysomething;

  function send(ch, payload) {
    try { if (api && api.send) api.send(ch, payload); } catch (e) { /* ignore */ }
  }

  var DEFAULT_HINT = 'Copied. Paste anywhere, or hit “Drop here” then click a spot.';

  function show(text) {
    if (textEl) textEl.textContent = (text == null ? '' : String(text));
    if (hint) { hint.textContent = DEFAULT_HINT; hint.classList.remove('armed'); }
    if (pad) pad.classList.add('show');
  }

  if (dropBtn) {
    dropBtn.addEventListener('click', function () {
      if (hint) { hint.textContent = 'Click where you want the text…'; hint.classList.add('armed'); }
      send('pad:drop');
    });
  }
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      send('pad:copy', { text: textEl ? textEl.textContent : '' });
      if (hint) { hint.textContent = 'Copied to clipboard.'; hint.classList.remove('armed'); }
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
