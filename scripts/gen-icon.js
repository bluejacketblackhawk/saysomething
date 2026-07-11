'use strict';

/**
 * gen-icon.js (agent E) — rasterize the aurora wisp mark to a 256px PNG and
 * write a valid single-image ICO for the app/shortcut icon.
 *
 * Runs under Electron (it needs a BrowserWindow to rasterize the SVG). If invoked
 * with plain `node scripts/gen-icon.js`, it re-launches itself under the local
 * Electron binary (require('electron') returns that binary's path in node).
 *
 * Outputs:
 *   assets/SaySomething.png  (256x256 RGBA)   — also used by the tray as its icon source
 *   assets/SaySomething.ico  (single 256 image, PNG-compressed entry)
 *
 * Zero runtime deps; no network. Exits when done.
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SVG_PATH = path.join(ASSETS_DIR, 'wisp.svg');
const PNG_OUT = path.join(ASSETS_DIR, 'SaySomething.png');
const ICO_OUT = path.join(ASSETS_DIR, 'SaySomething.ico');
const SIZE = 256;

let electron;
try {
  electron = require('electron');
} catch (e) {
  process.stderr.write('gen-icon: Electron is not installed. Run `npm install` first.\n');
  process.exit(1);
}

if (typeof electron === 'string') {
  relaunchUnderElectron(electron);
} else {
  runUnderElectron(electron);
}

// ---------------------------------------------------------------------------

function relaunchUnderElectron(electronPath) {
  const { spawn } = require('child_process');
  const child = spawn(electronPath, [__filename], { stdio: 'inherit' });
  child.on('exit', function (code) { process.exit(code == null ? 0 : code); });
  child.on('error', function (err) {
    process.stderr.write('gen-icon: failed to launch Electron: ' + err.message + '\n');
    process.exit(1);
  });
}

function runUnderElectron(el) {
  const app = el.app;
  const BrowserWindow = el.BrowserWindow;

  function fail(msg, err) {
    process.stderr.write('gen-icon: ' + msg + (err ? (' — ' + (err.stack || err.message || err)) : '') + '\n');
    try { app.exit(1); } catch (e) { process.exit(1); }
  }

  app.whenReady().then(function () {
    let svg;
    try {
      svg = fs.readFileSync(SVG_PATH, 'utf8');
    } catch (e) {
      return fail('cannot read ' + SVG_PATH, e);
    }

    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;padding:0;background:transparent;width:' + SIZE + 'px;height:' + SIZE + 'px;overflow:hidden;}' +
      'svg{display:block;width:' + SIZE + 'px;height:' + SIZE + 'px;}' +
      '</style></head><body>' + svg + '</body></html>';

    const win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      webPreferences: {
        offscreen: false,
        paintWhenInitiallyHidden: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.webContents.once('did-finish-load', function () {
      // Give the compositor a moment to paint the first frame.
      setTimeout(function () {
        win.webContents.capturePage().then(function (image) {
          if (!image || image.isEmpty()) {
            win.destroy();
            return fail('capturePage returned an empty image');
          }
          let png;
          try {
            const norm = image.resize({ width: SIZE, height: SIZE, quality: 'best' });
            png = norm.toPNG();
          } catch (e) {
            win.destroy();
            return fail('failed to encode PNG', e);
          }
          try {
            fs.mkdirSync(ASSETS_DIR, { recursive: true });
            fs.writeFileSync(PNG_OUT, png);
            fs.writeFileSync(ICO_OUT, buildIco(png));
          } catch (e) {
            win.destroy();
            return fail('failed to write output files', e);
          }
          process.stdout.write('gen-icon: wrote ' + PNG_OUT + ' and ' + ICO_OUT + '\n');
          win.destroy();
          app.quit();
        }).catch(function (e) {
          win.destroy();
          fail('capturePage failed', e);
        });
      }, 300);
    });

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(function (e) {
      fail('failed to load rasterizer page', e);
    });
  }).catch(function (e) {
    fail('app failed to become ready', e);
  });

  // Do not keep the app alive after the window closes for any other reason.
  app.on('window-all-closed', function () { app.quit(); });
}

/**
 * Wrap a PNG buffer in a valid single-image .ico container.
 * ICONDIR (6) + one ICONDIRENTRY (16) + PNG bytes. A 256px dimension is encoded
 * as the byte value 0 per the ICO spec.
 * @param {Buffer} png
 * @returns {Buffer}
 */
function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(SIZE >= 256 ? 0 : SIZE, 0); // width  (0 => 256)
  entry.writeUInt8(SIZE >= 256 ? 0 : SIZE, 1); // height (0 => 256)
  entry.writeUInt8(0, 2);       // palette color count
  entry.writeUInt8(0, 3);       // reserved
  entry.writeUInt16LE(1, 4);    // color planes
  entry.writeUInt16LE(32, 6);   // bits per pixel
  entry.writeUInt32LE(png.length, 8);   // size of image data
  entry.writeUInt32LE(6 + 16, 12);      // offset of image data

  return Buffer.concat([header, entry, png]);
}
