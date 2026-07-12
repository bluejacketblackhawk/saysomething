'use strict';

/**
 * Window factory (agent E).
 *
 * Owns the two BrowserWindows:
 *  - overlay: frameless, transparent, click-through, non-focusable, always-on-top
 *    at the screen-saver level. It ALWAYS exists (created hidden) because it also
 *    hosts the mic capture + AudioWorklet even while visually hidden. It is shown
 *    with showInactive() (never steals focus) and hidden with hide().
 *  - settings: a normal 900x640 dark window, single-instance, opened from the tray.
 *
 * The state machine drives overlay visibility via showOverlay()/hideOverlay()
 * (see CONTRACTS: overlay:state 'hidden' => hide, anything else => showInactive).
 * Accessors getOverlayWC()/getSettingsWC() expose the web contents for IPC.
 *
 * NOTE: the `screen` module must not be touched before app 'ready', so it is
 * accessed lazily (electron.screen) inside functions that only run post-ready,
 * never destructured at module load.
 */

const path = require('path');
const electron = require('electron');
const { BrowserWindow, nativeImage } = electron;
const settings = require('./stores/settings');

let log;
try {
  log = require('./log');
} catch (e) {
  log = { debug: noop, info: noop, warn: noop, error: noop };
}
function noop() {}

const OVERLAY_W = 320;
const OVERLAY_H = 72;

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_DIR = path.join(__dirname, '..', 'preload');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

const PAD_W = 360;
const PAD_H = 208;

let overlayWin = null;
let settingsWin = null;
let padWin = null;
let screenHooked = false;

// ---------------------------------------------------------------------------
// overlay
// ---------------------------------------------------------------------------

function positionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    const primary = electron.screen.getPrimaryDisplay();
    const wa = primary.workArea; // excludes the taskbar
    let offsetY = 48;
    try { offsetY = settings.get().overlay.offsetY; } catch (e) { /* default */ }
    const x = Math.round(wa.x + (wa.width - OVERLAY_W) / 2);
    const y = Math.round(wa.y + wa.height - OVERLAY_H - offsetY);
    overlayWin.setBounds({ x: x, y: y, width: OVERLAY_W, height: OVERLAY_H });
  } catch (e) {
    log.warn('windows: failed to position overlay', e);
  }
}

function hookScreenEvents() {
  if (screenHooked) return;
  try {
    electron.screen.on('display-metrics-changed', positionOverlay);
    electron.screen.on('display-added', positionOverlay);
    electron.screen.on('display-removed', positionOverlay);
    screenHooked = true;
  } catch (e) {
    log.warn('windows: could not hook screen events', e);
  }
}

/**
 * Create (once) the always-present overlay window, hidden.
 * @returns {import('electron').BrowserWindow}
 */
// Renderers only ever load their own local file: URL. Prevent any navigation
// away from it and deny window.open, so injected/mis-typed content can never
// steer a renderer to a remote origin. Defense-in-depth atop the page CSPs.
function lockNavigation(win) {
  try {
    const wc = win.webContents;
    wc.on('will-navigate', function (e) { e.preventDefault(); });
    wc.setWindowOpenHandler(function () { return { action: 'deny' }; });
  } catch (e) { /* older electron: best-effort */ }
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  overlayWin = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    alwaysOnTop: true,
    acceptFirstMouse: false,
    title: 'Say Something overlay',
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  // Top-most above virtually everything, and click-through.
  try { overlayWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { /* older electron */ }
  try { overlayWin.setIgnoreMouseEvents(true); } catch (e) { /* platform */ }
  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) { /* platform */ }
  overlayWin.setMenu(null);

  hookScreenEvents();
  positionOverlay();

  lockNavigation(overlayWin);
  overlayWin.loadFile(path.join(RENDERER_DIR, 'overlay', 'index.html')).catch(function (err) {
    log.error('windows: overlay failed to load', err);
  });

  overlayWin.on('closed', function () { overlayWin = null; });

  return overlayWin;
}

/** Show the overlay without stealing focus. */
function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  positionOverlay();
  // showInactive() shows without focusing on every platform; guard defensively.
  if (!overlayWin.isVisible()) { try { overlayWin.showInactive(); } catch (e) { /* ignore */ } }
}

/** Hide the overlay (the window keeps living to host the mic/worklet). */
function hideOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) overlayWin.hide();
}

// ---------------------------------------------------------------------------
// settings window
// ---------------------------------------------------------------------------

function windowIcon() {
  try {
    // .ico is a Windows format; on macOS use the PNG. (BrowserWindow `icon` is
    // ignored on macOS anyway — the Dock/app icon comes from the bundle — so this
    // is harmless there, but we still hand it a valid image.)
    const file = process.platform === 'darwin' ? 'SaySomething.png' : 'SaySomething.ico';
    const img = nativeImage.createFromPath(path.join(ASSETS_DIR, file));
    if (img && !img.isEmpty()) return img;
  } catch (e) { /* ignore */ }
  return undefined;
}

/**
 * Create or focus the single settings window.
 * @returns {import('electron').BrowserWindow}
 */
function createSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 400,
    minHeight: 420,
    show: false,
    backgroundColor: '#0B0E14',
    title: 'Say Something',
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  settingsWin.setMenu(null);

  lockNavigation(settingsWin);
  settingsWin.loadFile(path.join(RENDERER_DIR, 'settings', 'index.html')).catch(function (err) {
    log.error('windows: settings failed to load', err);
  });

  settingsWin.once('ready-to-show', function () {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    settingsWin.show();
    settingsWin.focus();
  });

  settingsWin.on('closed', function () { settingsWin = null; });

  return settingsWin;
}

// ---------------------------------------------------------------------------
// drop pad — a small, focusable, movable, always-on-top window the user drags /
// clicks to place dictated text. Unlike the overlay it IS interactive.
// ---------------------------------------------------------------------------

function createPad() {
  if (padWin && !padWin.isDestroyed()) return padWin;

  padWin = new BrowserWindow({
    width: PAD_W,
    height: PAD_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: 'Say Something drop pad',
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'pad.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  try { padWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { /* older electron */ }
  padWin.setMenu(null);
  lockNavigation(padWin);
  padWin.loadFile(path.join(RENDERER_DIR, 'pad', 'index.html')).catch(function (err) {
    log.error('windows: pad failed to load', err);
  });
  padWin.on('closed', function () { padWin = null; });
  return padWin;
}

// Show the pad near the current cursor (clamped to the work area).
function showPad() {
  const win = createPad();
  try {
    const pt = electron.screen.getCursorScreenPoint();
    const disp = electron.screen.getDisplayNearestPoint(pt);
    const wa = disp.workArea;
    let x = pt.x + 16;
    let y = pt.y + 16;
    if (x + PAD_W > wa.x + wa.width) x = pt.x - PAD_W - 16;
    if (y + PAD_H > wa.y + wa.height) y = wa.y + wa.height - PAD_H - 8;
    if (x < wa.x) x = wa.x + 8;
    if (y < wa.y) y = wa.y + 8;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: PAD_W, height: PAD_H });
  } catch (e) { /* keep default position */ }
  try { win.show(); win.focus(); } catch (e) { /* ignore */ }
}

function hidePad() {
  if (padWin && !padWin.isDestroyed()) {
    try { padWin.hide(); } catch (e) { /* ignore */ }
  }
}

// Reposition the pad window to (x, y) while the user drags it (drag-follow). Keeps
// its fixed size; x/y are the desired top-left in screen coordinates.
function movePad(x, y) {
  if (padWin && !padWin.isDestroyed()) {
    try { padWin.setBounds({ x: Math.round(x), y: Math.round(y), width: PAD_W, height: PAD_H }); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// first-run welcome — a one-time greeting window. The renderer closes itself
// (window.close()); main marks the welcome seen when it opens this.
// ---------------------------------------------------------------------------

let welcomeWin = null;

function showWelcome() {
  if (welcomeWin && !welcomeWin.isDestroyed()) {
    try { welcomeWin.show(); welcomeWin.focus(); } catch (e) { /* ignore */ }
    return welcomeWin;
  }
  welcomeWin = new BrowserWindow({
    width: 480,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0B0E14',
    title: 'Welcome to Say Something',
    icon: windowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  welcomeWin.setMenu(null);
  lockNavigation(welcomeWin);
  welcomeWin.loadFile(path.join(RENDERER_DIR, 'welcome', 'index.html')).catch(function (err) {
    log.error('windows: welcome failed to load', err);
  });
  welcomeWin.once('ready-to-show', function () {
    if (welcomeWin && !welcomeWin.isDestroyed()) { welcomeWin.show(); welcomeWin.focus(); }
  });
  welcomeWin.on('closed', function () { welcomeWin = null; });
  return welcomeWin;
}

// Keep the overlay placed correctly when the user changes the offset. The
// listener is cheap and no-ops until the overlay exists.
try {
  settings.onChange(function () { positionOverlay(); });
} catch (e) { /* ignore */ }

module.exports = {
  createOverlay: createOverlay,
  createSettings: createSettings,
  createPad: createPad,
  showOverlay: showOverlay,
  hideOverlay: hideOverlay,
  showPad: showPad,
  hidePad: hidePad,
  movePad: movePad,
  showWelcome: showWelcome,
  positionOverlay: positionOverlay,

  /** @returns {(import('electron').WebContents|null)} */
  getPadWC() {
    return (padWin && !padWin.isDestroyed()) ? padWin.webContents : null;
  },

  /** @returns {(import('electron').WebContents|null)} */
  getOverlayWC() {
    return (overlayWin && !overlayWin.isDestroyed()) ? overlayWin.webContents : null;
  },

  /** @returns {(import('electron').WebContents|null)} */
  getSettingsWC() {
    return (settingsWin && !settingsWin.isDestroyed()) ? settingsWin.webContents : null;
  },
};
