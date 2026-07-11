'use strict';

/**
 * Helper self-test (agent A). Run manually:  node test/helper-selftest.js
 *
 * Exercises the real SaySomethingHelper.exe end to end (compiling it first via
 * native/build.cmd if the exe is missing):
 *   1. start()  — compile-if-missing + spawn + wait for 'ready'
 *   2. ping()   — must resolve true (pong round-trip)
 *   3. paste()  — clipboard-swap + Ctrl+V; must report ok:true (SendInput
 *                 succeeds even if the pasted text lands nowhere)
 *   4. type('') — empty unicode send; must report ok:true (no-op)
 *   5. foreground() — must resolve an object (exe/title may be empty)
 *
 * The watch + captured round-trip needs a real human keypress, so it is
 * manual-only and NOT asserted here. To try it by hand, uncomment the block
 * near the end and press any key within the timeout.
 *
 * Exits 0 on success, non-zero on failure. Not part of `npm test`.
 */

const helper = require('../src/main/helper');

const RESULTS = [];
let failed = false;

function check(name, ok, extra) {
  RESULTS.push({ name: name, ok: ok, extra: extra });
  if (!ok) failed = true;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(tag + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function fail(msg) {
  failed = true;
  console.log('FAIL  ' + msg);
}

async function run() {
  // 1. start (compiles if the exe is missing)
  try {
    await helper.start();
    check('start -> ready', true);
  } catch (e) {
    check('start -> ready', false, e && e.message);
    return; // nothing else can run
  }

  // 2. ping / pong
  try {
    const pong = await helper.ping();
    check('ping -> pong', pong === true, 'pong=' + pong);
  } catch (e) {
    check('ping -> pong', false, e && e.message);
  }

  // 3. paste round-trip (restore clipboard quickly)
  try {
    const res = await helper.paste('SaySomething selftest ', 120);
    check('paste -> ok', res && res.ok === true, res && res.err ? res.err : '');
  } catch (e) {
    check('paste -> ok', false, e && e.message);
  }

  // 4. type empty string (no-op, must still succeed)
  try {
    const res = await helper.type('');
    check('type("") -> ok', res && res.ok === true, res && res.err ? res.err : '');
  } catch (e) {
    check('type("") -> ok', false, e && e.message);
  }

  // 5. foreground query
  try {
    const fg = await helper.foreground();
    const ok = fg && typeof fg.exe === 'string' && typeof fg.title === 'string';
    check('foreground -> {exe,title}', ok, ok ? ('exe=' + (fg.exe || '<none>')) : '');
  } catch (e) {
    check('foreground -> {exe,title}', false, e && e.message);
  }

  // 6. copy (drop-pad auto-copy): the command must report ok. The clipboard
  //    READ-BACK is asserted only outside CI — headless CI runners often have no
  //    usable clipboard session, which would flake this check (the helper itself
  //    is fine). Locally it verifies the bytes actually landed on the clipboard.
  try {
    const cp = require('child_process');
    const sentinel = 'saysomething-selftest-clip-' + process.pid;
    const res = await helper.copy(sentinel);
    if (process.env.CI) {
      check('copy -> ok (clipboard read-back skipped in CI)', res && res.ok === true, res && res.err ? res.err : '');
    } else {
      let clip = '';
      try { clip = cp.execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).trim(); }
      catch (e) { clip = '(read failed)'; }
      check('copy -> clipboard set', res && res.ok === true && clip.indexOf(sentinel) !== -1,
        res && res.err ? res.err : ('clip=' + clip.slice(0, 32)));
    }
  } catch (e) {
    check('copy -> clipboard set', false, e && e.message);
  }

  // --- MANUAL ONLY: watch + captured round-trip -------------------------
  // Requires a physical keypress; left disabled so the suite stays headless.
  //
  // await new Promise(function (resolve) {
  //   helper.once('captured', function (info) {
  //     console.log('captured', JSON.stringify(info));
  //     resolve();
  //   });
  //   console.log('press any key within 8s to test capture...');
  //   helper.capture();
  //   setTimeout(resolve, 8000);
  // });
}

run()
  .catch(function (e) {
    fail('unexpected error: ' + (e && e.stack ? e.stack : e));
  })
  .then(function () {
    try { helper.stop(); } catch (e) { /* ignore */ }
    const passed = RESULTS.filter(function (r) { return r.ok; }).length;
    console.log('---');
    console.log('helper-selftest: ' + passed + '/' + RESULTS.length + ' checks passed');
    // Give stop() a moment to quit the child, then exit.
    setTimeout(function () { process.exit(failed ? 1 : 0); }, 300);
  });
