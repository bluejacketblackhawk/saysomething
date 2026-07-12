'use strict';

/* SaySomething first-run welcome + (on macOS) the permissions onboarding.
 *
 * ONE renderer, two modes, chosen by the preload's platform flag:
 *   - no bridge / non-darwin -> the plain intro card. The button just closes the
 *     window; main marks the welcome seen. (Unchanged Windows behaviour.)
 *   - darwin                 -> the TCC permissions onboarding: three rows
 *     (Microphone, Input Monitoring, Accessibility) with live status lights fed by
 *     perms:changed, a Grant button per row (perms:request), and a "Start
 *     dictating" button that stays disabled until all three grants are in place.
 *
 * All state is display-only; the authoritative grant tracking lives in
 * src/main/permissions.js. This renderer never sees any transcript or key data.
 */

(function () {
  var api = window.saysomething || null;
  var darwin = !!(api && api.platform === 'darwin');

  var intro = document.getElementById('intro');
  var perms = document.getElementById('perms');
  var KINDS = ['mic', 'listen', 'ax'];

  if (!darwin) {
    initIntro();
    return;
  }

  // ---- darwin: swap to the permissions onboarding ----
  if (intro) intro.hidden = true;
  if (perms) perms.hidden = false;
  initPerms();

  // -------------------------------------------------------------------------

  function initIntro() {
    if (perms) perms.hidden = true;
    if (intro) intro.hidden = false;
    var go = document.getElementById('go');
    if (go) {
      go.addEventListener('click', closeWin);
    }
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Enter') closeWin();
    });
  }

  function initPerms() {
    var startBtn = document.getElementById('start');

    KINDS.forEach(function (kind) {
      var btn = document.getElementById('grant-' + kind);
      if (btn) btn.addEventListener('click', function () { request(kind); });
    });

    if (startBtn) {
      startBtn.addEventListener('click', function () {
        if (!startBtn.disabled) closeWin();
      });
    }

    // Live updates pushed from main whenever a grant flips.
    if (api && api.on) {
      try { api.on('perms:changed', function (p) { render(p); }); } catch (e) { /* ignore */ }
    }

    // Re-pull when the window regains focus: the user typically grants in System
    // Settings and tabs back. main also re-checks mic on focus and pushes
    // perms:changed, but pulling here refreshes the instant we return.
    window.addEventListener('focus', refresh);

    refresh();

    // Debug hook (harmless in production; used by test/welcome-perms-check.js).
    window.__saysomethingWelcome = { render: render, refresh: refresh };
  }

  function request(kind) {
    if (!api || !api.invoke) return;
    var btn = document.getElementById('grant-' + kind);
    if (btn && !btn.disabled) btn.textContent = 'Opening…';
    api.invoke('perms:request', kind).then(function (p) {
      if (p) render(p);
    }, function () { /* ignore */ }).then(function () {
      // If the grant didn't land immediately (listen/ax need a manual toggle),
      // restore the button label so the row stays actionable.
      var row = document.getElementById('row-' + kind);
      if (btn && row && row.getAttribute('data-granted') !== 'true') {
        btn.textContent = 'Grant';
      }
    });
  }

  function refresh() {
    if (!api || !api.invoke) return;
    api.invoke('perms:get').then(function (p) { if (p) render(p); }, function () { /* ignore */ });
  }

  function render(p) {
    p = p || {};
    var all = true;
    for (var i = 0; i < KINDS.length; i++) {
      var kind = KINDS[i];
      var granted = !!p[kind];
      if (!granted) all = false;
      var row = document.getElementById('row-' + kind);
      if (row) row.setAttribute('data-granted', granted ? 'true' : 'false');
      var btn = document.getElementById('grant-' + kind);
      if (btn) {
        btn.disabled = granted;
        btn.textContent = granted ? 'Granted' : 'Grant';
      }
    }
    var startBtn = document.getElementById('start');
    if (startBtn) startBtn.disabled = !all;
  }

  function closeWin() {
    try { window.close(); } catch (e) { /* ignore */ }
  }
})();
