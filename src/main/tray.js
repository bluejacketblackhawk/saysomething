'use strict';

/**
 * System tray (agent E).
 *
 * Shows the Say Something mark in the notification area with a menu:
 *   Paused (checkbox) / Settings... / Start with Windows (checkbox) / Quit
 * and a tooltip that reflects the live hotkey name. Double-clicking the icon
 * opens Settings.
 *
 * The icon is a nativeImage built from a PNG buffer. If assets/SaySomething.png exists
 * (produced by scripts/gen-icon.js) it is used; otherwise a small aurora
 * cyan->violet "wisp" orb is drawn programmatically and PNG-encoded with Node's
 * built-in zlib (zero runtime deps).
 */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { app, Tray, Menu, nativeImage } = require('electron');
const settings = require('./stores/settings');
const windows = require('./windows');

let log;
try {
  log = require('./log');
} catch (e) {
  log = { debug: noop, info: noop, warn: noop, error: noop };
}
function noop() {}

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

let tray = null;
let unsubscribe = null;

// ---------------------------------------------------------------------------
// icon generation (no native deps)
// ---------------------------------------------------------------------------

const CRC_TABLE = (function () {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode a straight-alpha RGBA buffer (width*height*4) as a PNG buffer.
 * @param {Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Aurora gradient: bottom cyan -> mid teal -> top violet.
function auroraColor(t) {
  const cyan = [103, 232, 249];
  const teal = [94, 234, 212];
  const violet = [167, 139, 250];
  if (t < 0.5) {
    const u = t / 0.5;
    return [lerp(cyan[0], teal[0], u), lerp(cyan[1], teal[1], u), lerp(cyan[2], teal[2], u)];
  }
  const u = (t - 0.5) / 0.5;
  return [lerp(teal[0], violet[0], u), lerp(teal[1], violet[1], u), lerp(teal[2], violet[2], u)];
}

/**
 * Draw a soft glowing wisp orb at the given square size and return its PNG.
 * @param {number} size
 * @returns {Buffer}
 */
function drawWispPng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const sigma = size * 0.30;
  const twoSigma2 = 2 * sigma * sigma;
  for (let y = 0; y < size; y++) {
    // vertical gradient parameter: 1 at top (violet), 0 at bottom (cyan)
    const t = size > 1 ? (1 - y / (size - 1)) : 0.5;
    const col = auroraColor(t);
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      let a = Math.exp(-d2 / twoSigma2);
      a = Math.min(1, a * 1.18);
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(col[0]);
      rgba[i + 1] = Math.round(col[1]);
      rgba[i + 2] = Math.round(col[2]);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(rgba, size, size);
}

/**
 * Build the tray nativeImage: prefer a generated asset PNG, else draw one.
 * @returns {import('electron').NativeImage}
 */
function buildIcon() {
  const assetPng = path.join(ASSETS_DIR, 'SaySomething.png');
  try {
    if (fs.existsSync(assetPng)) {
      const img = nativeImage.createFromBuffer(fs.readFileSync(assetPng));
      if (img && !img.isEmpty()) return img;
    }
  } catch (e) {
    log.warn('tray: could not use asset icon; drawing programmatic one', e);
  }
  try {
    const img = nativeImage.createFromBuffer(drawWispPng(16));
    // Provide a crisp 2x representation for high-DPI taskbars.
    try { img.addRepresentation({ scaleFactor: 2, width: 16, height: 16, buffer: drawWispPng(32) }); } catch (e) { /* ignore */ }
    return img;
  } catch (e) {
    log.error('tray: failed to build programmatic icon', e);
    return nativeImage.createEmpty();
  }
}

// ---------------------------------------------------------------------------
// menu / lifecycle
// ---------------------------------------------------------------------------

function currentSettings() {
  try { return settings.get(); } catch (e) { return settings.DEFAULTS || {}; }
}

function tooltipFor(s) {
  const name = (s && s.hotkey && s.hotkey.name) ? s.hotkey.name : 'Right Ctrl';
  return 'Say Something. Hold ' + name + ' to talk.';
}

function openSettings() {
  try { windows.createSettings(); } catch (e) { log.error('tray: openSettings failed', e); }
}

function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: [app.getAppPath()],
    });
  } catch (e) {
    log.warn('tray: setLoginItemSettings failed', e);
  }
}

function buildMenu(s) {
  return Menu.buildFromTemplate([
    {
      label: 'Paused',
      type: 'checkbox',
      checked: !!s.paused,
      click: function (item) {
        try { settings.set({ paused: item.checked }); } catch (e) { log.error('tray: toggle paused', e); }
      },
    },
    { type: 'separator' },
    {
      label: 'Settings…',
      click: openSettings,
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: !!s.launchAtLogin,
      click: function (item) {
        applyLoginItem(item.checked);
        try { settings.set({ launchAtLogin: item.checked }); } catch (e) { log.error('tray: toggle launchAtLogin', e); }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Say Something',
      click: function () { app.quit(); },
    },
  ]);
}

function refresh() {
  if (!tray || tray.isDestroyed()) return;
  const s = currentSettings();
  tray.setContextMenu(buildMenu(s));
  tray.setToolTip(tooltipFor(s));
}

module.exports = {
  /** Create the tray icon + menu. Safe to call once. */
  create() {
    if (tray && !tray.isDestroyed()) return tray;
    try {
      tray = new Tray(buildIcon());
    } catch (e) {
      log.error('tray: failed to create Tray', e);
      tray = null;
      return null;
    }
    const s = currentSettings();
    tray.setToolTip(tooltipFor(s));
    tray.setContextMenu(buildMenu(s));
    // Left double-click (or single click) opens settings — common tray UX.
    tray.on('double-click', openSettings);
    tray.on('click', openSettings);

    // Keep menu checkmarks + tooltip in sync when settings change elsewhere.
    try { unsubscribe = settings.onChange(function () { refresh(); }); } catch (e) { /* ignore */ }
    return tray;
  },

  /** Refresh menu checkmarks / tooltip from current settings. */
  update() { refresh(); },

  /** Remove the tray icon. */
  destroy() {
    if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) { /* ignore */ } unsubscribe = null; }
    if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch (e) { /* ignore */ } }
    tray = null;
  },
};
