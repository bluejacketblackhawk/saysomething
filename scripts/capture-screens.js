'use strict';

/**
 * SaySomething — screenshot capture (docs tooling, dependency-free).
 *
 * A standalone, minimal Electron entry point that renders the two renderer pages
 * to PNGs for the README, WITHOUT booting the real app (no native helper, no
 * whisper server, no microphone). Run it as its own Electron app so it never
 * touches src/main/main.js:
 *
 *     npx electron scripts/capture-screens.js
 *     # (or:  npm run capture-screens  if wired in package.json)
 *
 * It loads the pages via file:// with NO preload, so each renderer falls back to
 * its built-in demo data / debug hooks (settings.js `makeFallbackApi`,
 * overlay.js `window.__saysomethingOverlay`) — meaning zero setup artifacts are needed.
 *
 * Outputs:
 *   assets/screenshots/overlay-listening.png   — the floating pill, listening
 *   assets/screenshots/settings.png            — the settings window (General)
 *   assets/screenshots/settings-rewrite.png    — the settings window (Rewrite)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'assets', 'screenshots');
const OVERLAY_HTML = path.join(REPO, 'src', 'renderer', 'overlay', 'index.html');
const SETTINGS_HTML = path.join(REPO, 'src', 'renderer', 'settings', 'index.html');

const INK = '#0B0E14'; // theme.css --ink-900

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// GUI Electron on Windows does not attach stdout to a redirected file, so mirror
// progress to a temp log as well (kept OUT of the committed assets dir) so runs
// stay debuggable without cluttering the screenshots folder.
const LOG_FILE = path.join(os.tmpdir(), 'saysomething-capture-screens.log');
function logStep(line) {
  try { process.stdout.write(line + '\n'); } catch (e) { /* ignore */ }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
}

function writePng(name, image) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, image.toPNG());
  const kb = Math.round(fs.statSync(file).size / 1024);
  logStep('wrote ' + path.relative(REPO, file) + ' (' + kb + ' KB)');
}

// ---------------------------------------------------------------------------
// overlay pill — driven into its "listening" state with a live waveform
// ---------------------------------------------------------------------------
async function captureOverlay(win) {
  await win.loadFile(OVERLAY_HTML);
  // Show without stealing focus — a window that is never shown can leave
  // capturePage() waiting forever for a frame on some GPUs.
  win.showInactive();
  await wait(200);

  // Paint a soft ink backdrop behind the (transparent) pill so the capture reads
  // like a framed hero shot, then drive the pill into "listening" and feed it a
  // steady stream of levels so the aurora waveform is mid-motion, not flat.
  await win.webContents.executeJavaScript(`
    (function () {
      document.documentElement.style.background =
        'radial-gradient(120% 140% at 50% 38%, #131a29 0%, #0b0e14 62%)';
      var o = window.__saysomethingOverlay;
      if (o && o.applyState) {
        o.applyState('listening', { t0: Date.now() - 7000 });
        // ~30/s level feed with a lively, speech-like envelope
        var i = 0;
        window.__capTimer = setInterval(function () {
          i++;
          var rms = 0.12 + 0.09 * Math.abs(Math.sin(i * 0.5)) + 0.05 * Math.random();
          o.level(rms);
        }, 33);
      }
      return true;
    })();
  `);

  // Let the 60fps loop build up a full, settled waveform.
  await wait(1100);

  const image = await win.webContents.capturePage();
  writePng('overlay-listening.png', image);
}

// ---------------------------------------------------------------------------
// settings window — General tab, populated by settings.js demo fallback
// ---------------------------------------------------------------------------
async function captureSettings(win) {
  await win.loadFile(SETTINGS_HTML);
  win.showInactive();
  await wait(150);

  // settings.js has no window.saysomething bridge here, so it uses makeFallbackApi():
  // demo models/history/dictionary and a fully interactive General tab. Give it a
  // beat to run its async settings:get / models:list before capturing.
  await wait(700);

  const image = await win.webContents.capturePage();
  writePng('settings.png', image);
}

// ---------------------------------------------------------------------------
// settings window — Rewrite tab (local AI via Ollama), populated by the
// settings.js demo fallback (rewrite:models returns a reachable daemon with a
// few installed models). Driven by clicking the tab nav the same way a user
// would, so activateTab('rewrite') fires and loadOllamaModels() populates the
// live model picker + status line.
// ---------------------------------------------------------------------------
async function captureRewriteSettings(win) {
  await win.webContents.executeJavaScript(`
    (function () {
      var tab = document.querySelector('.tab[data-tab="rewrite"]');
      if (tab) tab.click();               // -> activateTab('rewrite') -> loadOllamaModels()
      var en = document.getElementById('rewrite-enabled');
      if (en && !en.checked) en.click();  // show the enabled, fully-wired state
      return true;
    })();
  `);
  // loadOllamaModels() does an async invoke('rewrite:models'); give it time to
  // resolve and paint the populated <select> and "N models available" status.
  await wait(700);

  const image = await win.webContents.capturePage();
  writePng('settings-rewrite.png', image);
}

function makeWindow(width, height) {
  return new BrowserWindow({
    width: width,
    height: height,
    show: false,
    backgroundColor: INK,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
}

app.whenReady().then(async function () {
  // Create BOTH windows up front. Destroying a window and then creating +
  // loading a new one makes the new loadFile reject with ERR_FAILED on this
  // Electron/Windows build, so keep both alive until the very end.
  let settingsWin = null;
  let overlayWin = null;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try { fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
    logStep('ready');

    settingsWin = makeWindow(900, 640);
    overlayWin = makeWindow(760, 240);

    await captureSettings(settingsWin);
    logStep('settings captured');
    await captureRewriteSettings(settingsWin);
    logStep('rewrite settings captured');
    await captureOverlay(overlayWin);
    logStep('overlay captured');

    logStep('capture-screens: done');
    try { if (settingsWin) settingsWin.destroy(); } catch (e) {}
    try { if (overlayWin) overlayWin.destroy(); } catch (e) {}
    app.exit(0);
  } catch (err) {
    logStep('capture-screens FAILED: ' + (err && err.stack || err));
    app.exit(1);
  }
});
