'use strict';

/*
 * Headless render check for the Model tab's first-day guidance. Loads the REAL
 * settings page offscreen, feeds it a models:list payload shaped like main's
 * (with note + recommended), and asserts the rendered cards show the Recommended
 * badge on small.en and the plain-English note in the meta line. No server.
 *
 * Run: npx electron test/settings-models-check.js  (exits 0 pass / 1 fail)
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const FAKE_MODELS = [
  { name: 'tiny.en', sizeMB: 75, note: 'Fastest, roughly accurate', recommended: false, downloaded: false, active: false },
  { name: 'small.en', sizeMB: 466, note: 'Best balance for English', recommended: true, downloaded: true, active: true },
  { name: 'large-v3-turbo', sizeMB: 1620, note: 'Most accurate, largest', recommended: false, downloaded: false, active: false },
];

// The settings preload bridges window.saysomething.invoke to ipcMain.handle; stub the
// channels the page calls on load so it renders without a real backend.
ipcMain.handle('settings:get', function () {
  return { model: 'small.en', mic: {}, format: {}, overlay: {}, history: {}, inject: {}, autoStop: {}, streaming: {}, rewrite: {}, hotkey: {}, dictionary: [] };
});
ipcMain.handle('models:list', function () { return FAKE_MODELS; });
ipcMain.handle('history:list', function () { return []; });
ipcMain.handle('app:info', function () { return { version: '0.1.0', whisper: {}, helper: {} }; });
ipcMain.handle('rewrite:models', function () { return { reachable: false, models: [], host: '' }; });

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    show: false, width: 920, height: 680,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, '..', 'src', 'preload', 'settings.js'),
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'settings', 'index.html'));
  await win.webContents.executeJavaScript('new Promise(function(r){setTimeout(r,400);})', true);

  const js = [
    '(function(){',
    '  var cards = document.querySelectorAll("#model-list .model-card");',
    '  var small = document.querySelector(".model-card[data-model=\\"small.en\\"]");',
    '  var rec = small ? small.querySelector(".model-rec") : null;',
    '  var meta = small ? small.querySelector(".model-meta") : null;',
    '  var tiny = document.querySelector(".model-card[data-model=\\"tiny.en\\"]");',
    '  var tinyRec = tiny ? tiny.querySelector(".model-rec") : null;',
    '  return {',
    '    cardCount: cards.length,',
    '    smallHasRec: !!rec,',
    '    recText: rec ? rec.textContent : null,',
    '    smallMeta: meta ? meta.textContent : null,',
    '    smallCardRecClass: small ? small.classList.contains("recommended") : false,',
    '    tinyHasRec: !!tinyRec,',
    '  };',
    '})()',
  ].join('\n');

  let ok = true;
  try {
    const r = await win.webContents.executeJavaScript(js, true);
    console.log('settings-models-check:', JSON.stringify(r));
    function assert(c, m) { if (c) { console.log('  ok  - ' + m); } else { ok = false; console.error('  FAIL- ' + m); } }
    assert(r.cardCount === 3, 'rendered all 3 model cards');
    assert(r.smallHasRec === true, 'small.en shows a Recommended badge');
    assert(r.recText === 'Recommended', 'badge text is "Recommended"');
    assert(r.smallCardRecClass === true, 'small.en card has the recommended accent class');
    assert(/Best balance for English/.test(r.smallMeta || ''), 'small.en meta shows the plain-English note');
    assert(r.tinyHasRec === false, 'non-recommended models have NO badge');
  } catch (e) {
    ok = false;
    console.error('settings-models-check: error', e && e.message);
  }

  win.destroy();
  console.log(ok ? '\nsettings-models-check: PASS' : '\nsettings-models-check: FAIL');
  app.exit(ok ? 0 : 1);
});
