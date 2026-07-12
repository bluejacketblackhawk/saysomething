'use strict';

/*
 * Headless render check for the macOS permissions onboarding. Loads the REAL
 * welcome page offscreen WITH the welcome preload, stubs the perms:* IPC channels,
 * and asserts:
 *   - the darwin permissions card is shown (intro hidden) and lists all three rows
 *     (Microphone, Input Monitoring, Accessibility) with a Grant button each,
 *   - "Start dictating" is DISABLED while a grant is missing,
 *   - a Grant click invokes perms:request with the right kind,
 *   - a live perms:changed event flips the status lights and ENABLES the start
 *     button once every grant is granted.
 *
 * The renderer branches on the preload's platform flag, so this check is meaningful
 * on darwin; on other platforms the intro card shows instead and the check reports
 * a skip (still exits 0). No helper, no server, no TCC.
 *
 * Run: npx electron test/welcome-perms-check.js   (exits 0 pass / 1 fail)
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

// Grant state the stubbed main pretends to hold. perms:get returns this; the test
// mutates it and pushes perms:changed to exercise the live-update path.
let grants = { listen: false, ax: false, mic: false, platform: 'darwin' };
let lastRequest = null;

ipcMain.handle('perms:get', function () { return grants; });
ipcMain.handle('perms:request', function (_e, kind) { lastRequest = kind; return grants; });
ipcMain.handle('perms:openPane', function () { return { ok: true }; });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    show: false, width: 480, height: 620,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'src', 'preload', 'welcome.js'),
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'welcome', 'index.html'));
  await win.webContents.executeJavaScript('new Promise(function(r){setTimeout(r,400);})', true);

  let ok = true;
  function assert(c, m) { if (c) { console.log('  ok  - ' + m); } else { ok = false; console.error('  FAIL- ' + m); } }

  try {
    // Are we on the darwin onboarding path at all?
    const mode = await win.webContents.executeJavaScript(
      '(function(){ return { platform: (window.saysomething && window.saysomething.platform) || null,' +
      ' introHidden: document.getElementById("intro").hidden,' +
      ' permsHidden: document.getElementById("perms").hidden }; })()', true);
    console.log('welcome-perms-check: mode', JSON.stringify(mode));

    if (mode.platform !== 'darwin') {
      console.log('  --  - not darwin (platform=' + mode.platform + '); onboarding is macOS-only — SKIP');
      assert(mode.introHidden === false && mode.permsHidden === true, 'non-darwin shows the intro card, not the perms card');
      win.destroy();
      console.log('\nwelcome-perms-check: PASS (skipped darwin assertions)');
      app.exit(0);
      return;
    }

    // ---- initial (nothing granted) ----
    const before = await win.webContents.executeJavaScript(
      '(function(){' +
      '  var rows = document.querySelectorAll("#perm-rows .perm-row");' +
      '  var start = document.getElementById("start");' +
      '  function light(id){ var r=document.getElementById(id); return r ? r.getAttribute("data-granted") : null; }' +
      '  return {' +
      '    permsVisible: document.getElementById("perms").hidden === false,' +
      '    introHidden: document.getElementById("intro").hidden === true,' +
      '    rowCount: rows.length,' +
      '    hasMic: !!document.getElementById("row-mic"),' +
      '    hasListen: !!document.getElementById("row-listen"),' +
      '    hasAx: !!document.getElementById("row-ax"),' +
      '    grantBtns: document.querySelectorAll("#perm-rows .grant").length,' +
      '    startDisabled: !!start.disabled,' +
      '    micLight: light("row-mic"), listenLight: light("row-listen"), axLight: light("row-ax"),' +
      '    hasDebugHook: !!(window.__saysomethingWelcome && window.__saysomethingWelcome.render),' +
      '  };' +
      '})()', true);
    console.log('welcome-perms-check: before', JSON.stringify(before));
    assert(before.permsVisible === true, 'permissions card is shown on darwin');
    assert(before.introHidden === true, 'intro card is hidden on darwin');
    assert(before.rowCount === 3, 'three permission rows rendered');
    assert(before.hasMic && before.hasListen && before.hasAx, 'Microphone, Input Monitoring, Accessibility rows all present');
    assert(before.grantBtns === 3, 'a Grant button per row');
    assert(before.startDisabled === true, 'Start dictating is DISABLED while grants are missing');
    assert(before.micLight === 'false' && before.listenLight === 'false' && before.axLight === 'false', 'all status lights start off');
    assert(before.hasDebugHook === true, 'debug hook exposed for tests');

    // ---- a Grant click routes to perms:request with the kind ----
    lastRequest = null;
    await win.webContents.executeJavaScript('document.getElementById("grant-listen").click(); true', true);
    await sleep(150);
    assert(lastRequest === 'listen', 'clicking Grant on Input Monitoring invokes perms:request("listen")');

    // ---- live update: everything granted -> start enabled ----
    grants = { listen: true, ax: true, mic: true, platform: 'darwin' };
    win.webContents.send('perms:changed', grants);
    await sleep(250);

    const after = await win.webContents.executeJavaScript(
      '(function(){' +
      '  var start = document.getElementById("start");' +
      '  function light(id){ var r=document.getElementById(id); return r ? r.getAttribute("data-granted") : null; }' +
      '  function btn(id){ var b=document.getElementById(id); return b ? { disabled: !!b.disabled, text: b.textContent } : null; }' +
      '  return {' +
      '    startDisabled: !!start.disabled,' +
      '    micLight: light("row-mic"), listenLight: light("row-listen"), axLight: light("row-ax"),' +
      '    micBtn: btn("grant-mic"),' +
      '  };' +
      '})()', true);
    console.log('welcome-perms-check: after', JSON.stringify(after));
    assert(after.micLight === 'true' && after.listenLight === 'true' && after.axLight === 'true', 'all status lights turn on via perms:changed');
    assert(after.startDisabled === false, 'Start dictating ENABLES once every grant is granted');
    assert(after.micBtn && after.micBtn.disabled === true, 'a granted row disables its Grant button');
    assert(after.micBtn && after.micBtn.text === 'Granted', 'a granted row relabels its button "Granted"');
  } catch (e) {
    ok = false;
    console.error('welcome-perms-check: error', e && e.message);
  }

  win.destroy();
  console.log(ok ? '\nwelcome-perms-check: PASS' : '\nwelcome-perms-check: FAIL');
  app.exit(ok ? 0 : 1);
});
