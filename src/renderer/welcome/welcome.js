'use strict';

/* SaySomething first-run welcome. No IPC — the button just closes the window; main
 * marks the welcome as seen when it shows this window. */

(function () {
  var go = document.getElementById('go');
  if (go) {
    go.addEventListener('click', function () {
      try { window.close(); } catch (e) { /* ignore */ }
    });
  }
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Enter') {
      try { window.close(); } catch (err) { /* ignore */ }
    }
  });
})();
