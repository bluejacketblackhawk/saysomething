'use strict';

/**
 * gen-social.js — render a 1280x640 GitHub social-preview banner (the aurora
 * waveform + wordmark on a dark background) to assets/social-preview.png.
 *
 * Runs under Electron (needs a BrowserWindow to rasterize). Plain
 * `node scripts/gen-social.js` re-launches itself under the local Electron.
 * Zero deps, no network. Exits when done.
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const OUT = path.join(ASSETS_DIR, 'social-preview.png');
const W = 1280;
const H = 640;

let electron;
try { electron = require('electron'); }
catch (e) { process.stderr.write('gen-social: run `npm install` first.\n'); process.exit(1); }

if (typeof electron === 'string') {
  const { spawn } = require('child_process');
  const child = spawn(electron, [__filename], { stdio: 'inherit' });
  child.on('exit', function (c) { process.exit(c == null ? 0 : c); });
  child.on('error', function (e) { process.stderr.write('gen-social: ' + e.message + '\n'); process.exit(1); });
} else {
  runUnderElectron(electron);
}

function runUnderElectron(el) {
  const app = el.app;
  const BrowserWindow = el.BrowserWindow;
  function fail(msg, err) {
    process.stderr.write('gen-social: ' + msg + (err ? (' — ' + (err.stack || err.message || err)) : '') + '\n');
    try { app.exit(1); } catch (e) { process.exit(1); }
  }

  const wave =
    '<svg width="168" height="132" viewBox="0 0 256 256" style="filter:drop-shadow(0 0 26px rgba(103,232,249,.35))">' +
    '<defs><linearGradient id="a" x1="28" y1="128" x2="228" y2="128" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#67E8F9"/><stop offset=".5" stop-color="#5EEAD4"/><stop offset="1" stop-color="#A78BFA"/>' +
    '</linearGradient></defs><g fill="url(#a)">' +
    '<rect x="28" y="78" width="24" height="100" rx="12"/>' +
    '<rect x="72" y="40" width="24" height="176" rx="12"/>' +
    '<rect x="116" y="66" width="24" height="124" rx="12"/>' +
    '<rect x="160" y="24" width="24" height="208" rx="12"/>' +
    '<rect x="204" y="86" width="24" height="84" rx="12"/></g></svg>';

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;width:' + W + 'px;height:' + H + 'px;overflow:hidden;' +
    'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif;}' +
    '.wrap{box-sizing:border-box;width:' + W + 'px;height:' + H + 'px;padding:70px;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;text-align:center;' +
    'background:radial-gradient(120% 95% at 50% -12%, rgba(103,232,249,.16), transparent 55%),' +
    'radial-gradient(85% 80% at 82% 8%, rgba(167,139,250,.13), transparent 55%),#0B0E14;}' +
    'h1{margin:0;font-size:112px;line-height:1;font-weight:680;letter-spacing:.5px;' +
    'background:linear-gradient(92deg,#67E8F9,#5EEAD4 48%,#A78BFA);' +
    '-webkit-background-clip:text;background-clip:text;color:transparent;}' +
    'p{margin:0;font-size:31px;font-weight:500;color:#8B93A7;}' +
    '.free{color:#5EEAD4;font-weight:600;}' +
    '</style></head><body><div class="wrap">' +
    wave +
    '<h1>Say Something</h1>' +
    '<p><span class="free">Free, local</span> voice dictation for Windows. No cloud, no account.</p>' +
    '</div></body></html>';

  app.whenReady().then(function () {
    const win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, useContentSize: true,
      backgroundColor: '#0B0E14',
      webPreferences: { paintWhenInitiallyHidden: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.once('did-finish-load', function () {
      setTimeout(function () {
        win.webContents.capturePage().then(function (image) {
          if (!image || image.isEmpty()) { win.destroy(); return fail('empty capture'); }
          try {
            fs.mkdirSync(ASSETS_DIR, { recursive: true });
            fs.writeFileSync(OUT, image.resize({ width: W, height: H, quality: 'best' }).toPNG());
          } catch (e) { win.destroy(); return fail('write failed', e); }
          process.stdout.write('gen-social: wrote ' + OUT + '\n');
          win.destroy(); app.quit();
        }).catch(function (e) { win.destroy(); fail('capture failed', e); });
      }, 300);
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(function (e) { fail('load failed', e); });
  }).catch(function (e) { fail('app not ready', e); });

  app.on('window-all-closed', function () { app.quit(); });
}
