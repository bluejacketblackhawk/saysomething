'use strict';

/**
 * SaySomething main process entry (agent I — integrator).
 *
 * Responsibilities:
 *  - single-instance lock
 *  - `--smoke` headless self-test (NO windows) that runs before any window is
 *    created and exits with a status code
 *  - boot order: settings -> log -> (helper.start() + binaries.ensure() +
 *    server.start(), in parallel, tolerating whisper failure) -> createOverlay ->
 *    tray -> watch(hotkey) -> wire the dictation state machine
 *  - all ipcMain handlers for the settings renderer + audio channel routing
 *  - settings.onChange side effects: hotkey rewatch (state.js), model -> server
 *    restart, launch-at-login sync, and forwarding settings:changed to the UI
 *  - graceful shutdown of the native children
 *
 * Boot never crashes: every module is required defensively and every side effect
 * is guarded, per SPEC's resilience rules.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session, Notification, dialog } = require('electron');

// Set the app name before anything reads a user path, so Electron's own caches
// live under %APPDATA%/SaySomething alongside our data (config.js anchors there too).
try { app.setName('SaySomething'); } catch (e) { /* best-effort */ }

function safeRequire(id) {
  try {
    return require(id);
  } catch (err) {
    try { require('./log').error('boot: failed to require ' + id, err); } catch (e) { /* ignore */ }
    return null;
  }
}

const config = safeRequire('./config');
const log = safeRequire('./log') || { debug: noop, info: noop, warn: noop, error: noop };
const ipc = safeRequire('./ipc');
const settingsStore = safeRequire('./stores/settings');
const historyStore = safeRequire('./stores/history');
const helper = safeRequire('./helper');
const binaries = safeRequire('./whisper/binaries');
const server = safeRequire('./whisper/server');
const models = safeRequire('./whisper/models');
const rewriter = safeRequire('./whisper/rewrite');
const audioSession = safeRequire('./audio-session');
const windows = safeRequire('./windows');
const tray = safeRequire('./tray');
const state = safeRequire('./state');
const permissions = safeRequire('./permissions');

const IS_DARWIN = process.platform === 'darwin';

function noop() {}
function logInfo() { if (log && log.info) log.info.apply(log, arguments); }
function logError() { if (log && log.error) log.error.apply(log, arguments); }
function logWarn() { if (log && log.warn) log.warn.apply(log, arguments); }

const isSmoke = process.argv.includes('--smoke');

/** Call a possibly-missing function; swallow sync throws and rejected promises. */
function safeCall(fn, label) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') {
      r.catch(function (err) { logError(label + ' failed', err); });
    }
    return r;
  } catch (err) {
    logError(label + ' threw', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// single-instance lock
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    try {
      if (windows && windows.createSettings) {
        windows.createSettings(); // focuses the existing settings window
      }
    } catch (e) { /* ignore */ }
  });

  if (isSmoke) {
    app.whenReady().then(runSmoke).catch(function (err) {
      try { process.stdout.write(JSON.stringify({ summary: true, ok: false, error: String(err) }) + '\n'); } catch (e) {}
      app.exit(1);
    });
  } else {
    app.whenReady().then(boot).catch(function (err) { logError('boot failed', err); });
    app.on('window-all-closed', function () { /* keep running in the tray */ });
    app.on('will-quit', shutdown);
  }
}

// ---------------------------------------------------------------------------
// --smoke: headless self-test (no windows)
// ---------------------------------------------------------------------------

function runSmoke() {
  const results = [];
  function emit(o) { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) { /* ignore */ } }
  function record(name, ok, detail) {
    const line = { check: name, ok: !!ok };
    if (detail !== undefined) line.detail = detail;
    results.push(line);
    emit(line);
  }
  function skip(name, detail) {
    const line = { check: name, ok: true, skipped: true };
    if (detail !== undefined) line.detail = detail;
    results.push(line);
    emit(line);
  }

  let settings = null;

  return Promise.resolve()
    // 1. settings load
    .then(function () {
      try {
        settings = settingsStore && settingsStore.get ? settingsStore.get() : null;
        record('settings', !!settings, settings ? { userData: config && config.USER_DATA } : null);
      } catch (e) {
        record('settings', false, String(e && e.message || e));
      }
    })
    // 2. helper: compile-if-missing + spawn + ping
    .then(function () {
      if (!helper || !helper.start) { record('helper', false, 'helper module missing'); return; }
      return helper.start()
        .then(function () { return helper.ping(); })
        .then(function (pong) { record('helper', pong === true, { ping: pong }); })
        .catch(function (e) { record('helper', false, String(e && e.message || e)); });
    })
    // 3. whisper binaries present (unpack if needed)
    .then(function () {
      if (!binaries || !binaries.ensure) { record('binaries', false, 'binaries module missing'); return false; }
      return binaries.ensure()
        .then(function () {
          const ready = binaries.isReady ? binaries.isReady() : true;
          record('binaries', ready);
          return ready;
        })
        .catch(function (e) { record('binaries', false, String(e && e.message || e)); return false; });
    })
    // 4. server boot + /inference reachability (skip gracefully if no model)
    .then(function (binOk) {
      const model = (settings && settings.model) || 'small.en';
      const port = (settings && settings.whisperPort) || (config && config.DEFAULT_PORT) || 8737;
      let modelPath = null;
      try { modelPath = models && models.pathFor ? models.pathFor(model) : null; } catch (e) { /* ignore */ }

      if (!modelPath || !fs.existsSync(modelPath)) {
        skip('server', 'model "' + model + '" not downloaded — run `node scripts/setup.js` (skipping server boot)');
        return;
      }
      if (!binOk) {
        skip('server', 'whisper binaries missing — run `node scripts/setup.js`');
        return;
      }
      if (!server || !server.start) { record('server', false, 'server module missing'); return; }
      return server.start(model, port)
        .then(function (st) {
          const ok = !!(st && st.running && st.port);
          record('server', ok, { model: st && st.model, port: st && st.port });
        })
        .catch(function (e) { record('server', false, String(e && e.message || e)); });
    })
    // summary + exit
    .then(function () {
      const failed = results.filter(function (r) { return !r.ok; }).length;
      const skipped = results.filter(function (r) { return r.skipped; }).length;
      const passed = results.length - failed - skipped;
      emit({ summary: true, total: results.length, passed: passed, failed: failed, skipped: skipped, ok: failed === 0 });

      try { if (helper && helper.stop) helper.stop(); } catch (e) { /* ignore */ }
      const stopServer = (server && server.stop) ? server.stop() : Promise.resolve();
      return Promise.resolve(stopServer).catch(function () {}).then(function () {
        app.exit(failed === 0 ? 0 : 1);
      });
    })
    .catch(function (err) {
      emit({ summary: true, ok: false, error: String(err && err.message || err) });
      app.exit(1);
    });
}

// ---------------------------------------------------------------------------
// normal boot
// ---------------------------------------------------------------------------

let lastModel = null;
let lastLaunchAtLogin = null;
let setupNotice = false; // set once we've told the user to run setup (dedupes notices)

function boot() {
  logInfo('SaySomething boot: starting');

  let settings = null;
  try {
    settings = (settingsStore && settingsStore.get) ? settingsStore.get() : null;
  } catch (e) {
    logError('settings load failed', e);
  }
  lastModel = settings ? settings.model : null;
  lastLaunchAtLogin = settings ? !!settings.launchAtLogin : null;

  // Sync launch-at-login with the persisted preference (best-effort).
  applyLoginItem(settings ? !!settings.launchAtLogin : false);

  // Grant microphone access to our own trusted renderers (both windows use the
  // default session). Without this Electron denies getUserMedia and the mic /
  // device-label picker fail. Everything else is denied (privacy-first).
  wirePermissions();

  // Subscribe to whisper status BEFORE starting so no early status is missed.
  if (server && server.on) {
    server.on('status', function (st) {
      forwardWhisperStatus(st);
    });
  }

  // Native pieces in parallel; whisper failure is non-fatal (SPEC resilience).
  // Helper start failure is normally non-fatal too, but if the app is otherwise
  // set up (so no setup dialog will fire) a dead dictation hotkey must not be
  // silent — tell the user how to recover.
  Promise.resolve()
    .then(function () { return helper && helper.start && helper.start(); })
    .catch(function (err) {
      logError('helper.start failed', err);
      if (!setupNotice) {
        notify('Say Something: hotkey unavailable',
          'The dictation hotkey may not work. Try running:  node scripts/setup.js');
      }
    });

  // If the helper gives up after its rapid-retry cap, the hotkey is dead — tell
  // the user via a tray notification + overlay error instead of failing silently.
  if (helper && helper.on) {
    helper.on('unavailable', function (info) {
      logError('helper unavailable after ' + (info && info.restarts) + ' restarts — hotkey is dead');
      notify('Say Something: dictation stopped', 'The hotkey stopped responding. Restart Say Something to get dictation back.');
      try {
        const wc = windows && windows.getOverlayWC && windows.getOverlayWC();
        if (wc && ipc) {
          windows.showOverlay && windows.showOverlay();
          wc.send(ipc.OVERLAY_STATE, { state: 'error', detail: { message: 'Dictation stopped. Restart Say Something to fix it.' } });
        }
      } catch (e) { /* ignore */ }
    });
  }

  // Set the initial watched hotkey now; helper re-asserts it once ready.
  try {
    const vk = settings && settings.hotkey && settings.hotkey.vk;
    if (helper && helper.watch && typeof vk === 'number') helper.watch([vk]);
  } catch (e) {
    logError('initial watch failed', e);
  }

  // Windows + tray first, so the first-run guidance below has a tray to fall back
  // on and can open the settings window when a model still needs downloading.
  safeCall(function () { return windows && windows.createOverlay && windows.createOverlay(); }, 'createOverlay');
  // Pre-create the drop pad (hidden) so it's loaded and ready on first use.
  safeCall(function () { return windows && windows.createPad && windows.createPad(); }, 'createPad');
  safeCall(function () { return tray && tray.create && tray.create(); }, 'tray.create');

  // Whisper engine — but ONLY if `node scripts/setup.js` has actually run. A
  // fresh clone has no binaries and no model; guide the user to setup instead of
  // sitting silently in the tray or pulling large files off the internet at boot.
  bootWhisper(settings);

  // IPC + settings side-effects + the dictation state machine.
  wireIpc();
  wireSettingsSideEffects();
  safeCall(function () { return state && state.init && state.init(); }, 'state.init');

  // First-run welcome / macOS permissions onboarding.
  //  - Windows: the one-time intro (unchanged).
  //  - macOS: a permission-gated onboarding — shown whenever a TCC grant is still
  //    missing (not just first run), because dictation literally cannot work
  //    without Input Monitoring + Accessibility + Microphone. It auto-closes the
  //    moment all three grants land (see wirePermsOnboarding).
  try {
    wirePermsOnboarding();
    startOnboarding(settings);
  } catch (e) {
    logError('onboarding wiring failed', e);
  }

  logInfo('SaySomething boot: ready');
}

function shutdown() {
  safeCall(function () { return helper && helper.stop && helper.stop(); }, 'helper.stop');
  safeCall(function () { return server && server.stop && server.stop(); }, 'server.stop');
  safeCall(function () { return tray && tray.destroy && tray.destroy(); }, 'tray.destroy');
}

// ---------------------------------------------------------------------------
// first-run readiness + whisper start
// ---------------------------------------------------------------------------

function whisperBinariesReady() {
  try { return !!(binaries && binaries.isReady && binaries.isReady()); }
  catch (e) { return false; }
}

function localModelNames() {
  try { return (models && models.listLocal) ? models.listLocal() : []; }
  catch (e) { return []; }
}

/**
 * Start whisper if setup has run; otherwise guide the user. Three states:
 *   - no binaries         -> setup was never run: clear dialog + notification
 *   - binaries, no model  -> setup interrupted: open the model manager
 *   - binaries + model     -> start the server (no runtime download needed)
 */
function bootWhisper(settings) {
  const binOk = whisperBinariesReady();
  const selected = (settings && settings.model) || 'small.en';
  const local = localModelNames();
  const modelReady = local.indexOf(selected) !== -1;

  if (!binOk) {
    logWarn('first run: whisper binaries missing — setup has not been run');
    guideRunSetup();
    return;
  }
  if (!modelReady) {
    logWarn('first run: model "' + selected + '" not downloaded — opening the model manager');
    guideDownloadModel(local.length > 0);
    return;
  }

  const port = (settings && settings.whisperPort) || (config && config.DEFAULT_PORT) || 8737;
  Promise.resolve()
    .then(function () { return server && server.start && server.start(selected, port); })
    .then(function () { logInfo('SaySomething boot: whisper server ready'); })
    .catch(function (err) { logError('whisper start failed (non-fatal)', err); });
}

/** Setup was never run: a plain-language dialog + notification pointing at setup.js. */
function guideRunSetup() {
  if (setupNotice) return;
  setupNotice = true;
  const msg =
    'Say Something needs a one-time setup before it can transcribe.\n\n' +
    'Open a terminal in the Say Something folder and run:\n\n' +
    '    node scripts/setup.js\n\n' +
    'That downloads the local speech engine and the default model (a few minutes,\n' +
    'just once). Then start Say Something again with:  npm start\n\n' +
    'Say Something sits in the tray meanwhile. Nothing runs until setup finishes.';
  try {
    if (dialog && dialog.showErrorBox) dialog.showErrorBox('Say Something needs a quick setup', msg);
  } catch (e) { logError('setup dialog failed', e); }
  notify('Say Something needs a quick setup',
    'Run  node scripts/setup.js  in the Say Something folder, then restart Say Something.');
}

/** Binaries are present but no usable model: land the user on the model manager. */
function guideDownloadModel(haveOtherModel) {
  if (setupNotice) return;
  setupNotice = true;
  safeCall(function () { return windows && windows.createSettings && windows.createSettings(); }, 'createSettings');
  const body = haveOtherModel
    ? 'Your selected model isn’t downloaded yet. Open Settings, then Models to get it or pick another.'
    : 'No speech model yet. Open Settings, then Models to download one and you’re good to go.';
  notify('Say Something needs a voice model', body);
}

// ---------------------------------------------------------------------------
// welcome / macOS permissions onboarding
// ---------------------------------------------------------------------------
//
// On darwin the welcome window doubles as the TCC onboarding (three grants). It is
// created HERE (not via windows.js) so it can carry the welcome preload that
// bridges the perms:* channels — windows.showWelcome() ships no preload and is
// owned by another lane. The renderer branches on the preload's platform flag, so
// the same welcome/index.html serves both the Windows intro and the macOS
// onboarding. See the report for the (optional) windows.js unification.

let onboardingWin = null;

function showOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    try { onboardingWin.show(); onboardingWin.focus(); } catch (e) { /* ignore */ }
    return onboardingWin;
  }
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const preloadDir = path.join(__dirname, '..', 'preload');

  onboardingWin = new BrowserWindow({
    width: 480,
    height: 620,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0B0E14',
    // Framed (unlike the frameless intro) so the OS close button is an escape
    // hatch: the "Start dictating" button is gated until every grant lands, and the
    // app keeps running in the tray if the user closes this to grant later.
    title: 'Say Something',
    webPreferences: {
      preload: path.join(preloadDir, 'welcome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  onboardingWin.setMenu(null);

  // Lock navigation to the local file (defense-in-depth atop the page CSP).
  try {
    const wc = onboardingWin.webContents;
    wc.on('will-navigate', function (e) { e.preventDefault(); });
    wc.setWindowOpenHandler(function () { return { action: 'deny' }; });
  } catch (e) { /* older electron */ }

  onboardingWin.loadFile(path.join(rendererDir, 'welcome', 'index.html')).catch(function (err) {
    logError('onboarding window failed to load', err);
  });

  onboardingWin.once('ready-to-show', function () {
    if (onboardingWin && !onboardingWin.isDestroyed()) {
      onboardingWin.show();
      onboardingWin.focus();
    }
  });
  onboardingWin.on('closed', function () { onboardingWin = null; });

  return onboardingWin;
}

function closeOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    try { onboardingWin.close(); } catch (e) { /* ignore */ }
  }
}

function sendToWelcome(channel, payload) {
  try {
    if (onboardingWin && !onboardingWin.isDestroyed()) {
      onboardingWin.webContents.send(channel, payload);
    }
  } catch (e) { /* ignore */ }
}

function markWelcomed() {
  try { if (settingsStore && settingsStore.set) settingsStore.set({ welcomed: true }); }
  catch (e) { /* ignore */ }
}

// Push live grant status to the onboarding window and, once everything is granted,
// close it. No re-watch needed: state.init() already sent the full watched set
// (hotkey variants + pad hotkey) and the helper holds that filter internally, so
// the event tap it creates once Input Monitoring lands uses it as-is. Watching
// only a subset here would REPLACE the full set and silently kill the drop pad.
// No-op on win32.
function wirePermsOnboarding() {
  if (!IS_DARWIN || !permissions || !permissions.onChange) return;
  permissions.onChange(function (p) {
    sendToWelcome(ipc.PERMS_CHANGED, p);
    if (permissions.allGranted && permissions.allGranted()) {
      logInfo('permissions: all granted — closing onboarding');
      closeOnboarding();
    }
  });
}

// Decide whether to show the onboarding. On darwin this is permission-gated (shown
// whenever a grant is missing, not just first run); on win32 it is the unchanged
// one-time intro.
function startOnboarding(settings) {
  if (IS_DARWIN) {
    if (!permissions) return;
    let evaluated = false;
    const evaluate = function () {
      if (evaluated) return;
      evaluated = true;
      try { if (permissions.recheckMic) permissions.recheckMic(); } catch (e) { /* ignore */ }
      if (!permissions.allGranted()) {
        showOnboarding();
      } else {
        // Everything is granted, so there is no onboarding to show — but a
        // menu-bar app that opens NO window on a manual launch looks broken
        // ("I double-clicked it and nothing happened"). Open Settings when the
        // user launched it by hand; stay silent for launch-at-login.
        try {
          const atLogin = !!(app.getLoginItemSettings && app.getLoginItemSettings().wasOpenedAtLogin);
          if (!atLogin && windows && windows.createSettings) windows.createSettings();
        } catch (e) { /* ignore */ }
      }
      // The macOS greeting IS the onboarding, so mark welcomed either way and never
      // fall back to the Windows-flavoured intro on this platform.
      markWelcomed();
    };
    // Prefer to decide after the helper reports listen/ax; fall back on a timer so a
    // missing/dead helper still lets the user grant mic and read the guidance.
    if (helper && helper.once) {
      helper.once('ready', function () {
        try { if (helper.perms) helper.perms(); } catch (e) { /* ignore */ }
        setTimeout(evaluate, 250); // let the fresh perms event land first
      });
    }
    setTimeout(evaluate, 2000);
    return;
  }

  // Windows: unchanged one-time intro. Marked seen immediately so a crash before
  // the user closes it doesn't re-show forever.
  try {
    if (settings && !settings.welcomed && windows && windows.showWelcome) {
      windows.showWelcome();
      markWelcomed();
    }
  } catch (e) {
    logError('first-run welcome failed', e);
  }
}

// ---------------------------------------------------------------------------
// login item
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// renderer permissions (mic only; deny everything else)
// ---------------------------------------------------------------------------

// 'media' covers BOTH microphone and camera in Electron, so a bare allow would
// also permit webcam capture. Inspect the requested media type(s) and grant only
// audio — a getUserMedia({video:true}) request is denied (privacy-first, mic-only).
function audioOnlyAllowed(permission, details) {
  if (permission === 'microphone' || permission === 'audioCapture') return true;
  if (permission !== 'media') return false;
  const d = details || {};
  // request handler exposes mediaTypes[]; check handler exposes mediaType (string).
  const types = d.mediaTypes || (d.mediaType ? [d.mediaType] : []);
  return types.indexOf('video') === -1; // audio-only (or unspecified => mic) OK
}

function wirePermissions() {
  try {
    const ses = session && session.defaultSession;
    if (!ses) return;
    ses.setPermissionRequestHandler(function (_wc, permission, callback, details) {
      callback(audioOnlyAllowed(permission, details));
    });
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(function (_wc, permission, _origin, details) {
        return audioOnlyAllowed(permission, details);
      });
    }
  } catch (e) {
    logWarn('wirePermissions failed', e);
  }
}

function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: [app.getAppPath()],
    });
  } catch (e) {
    logWarn('applyLoginItem failed', e);
  }
}

// ---------------------------------------------------------------------------
// settings renderer helpers
// ---------------------------------------------------------------------------

function sendToSettings(channel, payload) {
  try {
    const wc = windows && windows.getSettingsWC && windows.getSettingsWC();
    if (wc) wc.send(channel, payload);
  } catch (e) { /* ignore */ }
}

function notify(title, body) {
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      new Notification({ title: title, body: body }).show();
    }
  } catch (e) { /* best-effort */ }
}

// After a model download completes, start whisper if the downloaded model is the
// active one and the server isn't already up (binaries must be present, else the
// launch fails non-fatally and the user is already looking at the setup guidance).
function maybeStartAfterDownload(name) {
  let selected = null;
  try { selected = settingsStore.get().model; } catch (e) { /* ignore */ }
  if (name !== selected) return;
  const st = (server && server.status) ? server.status() : { running: false };
  if (st.running) return;
  if (!whisperBinariesReady()) return;
  logInfo('active model downloaded + engine idle -> starting whisper (' + selected + ')');
  restartWhisper(selected);
}

function forwardWhisperStatus(st) {
  const s = st || (server && server.status ? server.status() : { running: false, model: null, port: null });
  sendToSettings(ipc.WHISPER_STATUS, { running: !!s.running, model: s.model || null, port: s.port || null });
}

// Serialize whisper restarts so a model change + explicit restart cannot race.
// The settings UI both persists the new model (=> onChange restart) AND calls
// whisper:restart, so coalesce: if a restart to the SAME model is already in
// flight, reuse it instead of reloading the model a second time.
let whisperChain = Promise.resolve();
let whisperBusy = false;
let whisperPendingModel;
function restartWhisper(model) {
  if (whisperBusy && whisperPendingModel === model) return whisperChain;
  whisperBusy = true;
  whisperPendingModel = model;
  whisperChain = whisperChain.then(function () {
    if (!server || !server.restart) return null;
    return server.restart(model).then(null, function (e) {
      logError('whisper restart failed (non-fatal)', e);
    });
  }).then(function (r) { whisperBusy = false; return r; },
          function (e) { whisperBusy = false; throw e; });
  return whisperChain;
}

// ---------------------------------------------------------------------------
// settings.onChange side effects
// ---------------------------------------------------------------------------

function wireSettingsSideEffects() {
  if (!settingsStore || !settingsStore.onChange) return;
  settingsStore.onChange(function (s) {
    // Forward to the settings UI so open panels stay in sync.
    sendToSettings(ipc.SETTINGS_CHANGED, { settings: s });

    // Model change -> restart whisper with the new model.
    if (s.model !== lastModel) {
      lastModel = s.model;
      logInfo('settings: model changed -> restarting whisper (' + s.model + ')');
      restartWhisper(s.model);
    }

    // Launch-at-login change -> sync the OS login item.
    const launch = !!s.launchAtLogin;
    if (launch !== lastLaunchAtLogin) {
      lastLaunchAtLogin = launch;
      applyLoginItem(launch);
    }
    // Hotkey rewatch + paused are handled inside state.js (its own onChange).
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function wireIpc() {
  if (!ipc) return;

  // ---- overlay renderer -> main (audio) ----
  ipcMain.on(ipc.AUDIO_CHUNK, function (_e, p) {
    if (p && audioSession && audioSession.collect) {
      try { audioSession.collect(p.sessionId, p.buf); } catch (e) { logError('audio:chunk collect failed', e); }
    }
  });
  ipcMain.on(ipc.AUDIO_STARTED, function () { /* informational ack */ });
  ipcMain.on(ipc.AUDIO_STOPPED, function () { /* informational ack */ });
  ipcMain.on(ipc.AUDIO_ERROR, function (_e, p) {
    if (state && state.audioError) {
      try { state.audioError(p && p.message); } catch (e) { logError('audio:error handling failed', e); }
    }
  });
  ipcMain.on(ipc.AUDIO_SILENCE, function (_e, p) {
    if (state && state.silence && p && typeof p.sessionId === 'number') {
      try { state.silence(p.sessionId); } catch (e) { logError('audio:silence handling failed', e); }
    }
  });

  // ---- drop pad renderer -> main ----
  ipcMain.on(ipc.PAD_MOVE, function (_evt, p) {
    if (p && windows && windows.movePad) {
      try { windows.movePad(p.x | 0, p.y | 0); } catch (e) { /* ignore */ }
    }
  });
  ipcMain.on(ipc.PAD_PLACE, function (_evt, p) {
    if (p && state && state.padDropAt) {
      try { state.padDropAt(p.x | 0, p.y | 0); } catch (e) { logError('pad:place failed', e); }
    }
  });
  ipcMain.on(ipc.PAD_COPY, function () {
    if (state && state.padCopy) { try { state.padCopy(); } catch (e) { logError('pad:copy failed', e); } }
  });
  ipcMain.on(ipc.PAD_DISMISS, function () {
    if (state && state.padDismiss) { try { state.padDismiss(); } catch (e) { logError('pad:dismiss failed', e); } }
  });

  // ---- settings renderer invoke handlers ----
  ipcMain.handle(ipc.SETTINGS_GET, function () {
    return settingsStore && settingsStore.get ? settingsStore.get() : null;
  });

  ipcMain.handle(ipc.SETTINGS_SET, function (_e, partial) {
    if (!settingsStore || !settingsStore.set) return null;
    return settingsStore.set(partial || {});
  });

  ipcMain.handle(ipc.MODELS_LIST, function () {
    if (!models || !models.catalog) return [];
    let active = 'small.en';
    try { active = settingsStore.get().model; } catch (e) { /* default */ }
    let local = [];
    try { local = models.listLocal(); } catch (e) { local = []; }
    return models.catalog().map(function (m) {
      return {
        name: m.name,
        sizeMB: m.sizeMB,
        note: m.note || '',
        recommended: !!m.recommended,
        downloaded: local.indexOf(m.name) !== -1,
        active: m.name === active,
      };
    });
  });

  ipcMain.handle(ipc.MODELS_DOWNLOAD, function (_e, name) {
    if (!models || !models.download) throw new Error('models module unavailable');
    // Defense-in-depth: only ever act on a known catalog name. Blocks a renderer
    // (or a compromised one) from steering the download path/URL via the name
    // (e.g. '../../evil') — the name flows into a filesystem path and a fetch URL.
    if (!models.catalog().some(function (m) { return m.name === name; })) {
      throw new Error('unknown model: ' + name);
    }
    return models.download(name, function (p) {
      sendToSettings(ipc.MODELS_PROGRESS, {
        name: name,
        pct: p && p.pct,
        bytes: p && p.bytes,
        total: p && p.total,
      });
    }).then(function () {
      // Final 100% nudge + let the UI re-list.
      sendToSettings(ipc.MODELS_PROGRESS, { name: name, pct: 100, bytes: 0, total: 0 });
      // First-run recovery: if the user just downloaded the active model and the
      // engine isn't running (e.g. it was skipped at boot for lack of a model),
      // start it now so dictation works without restarting the app.
      maybeStartAfterDownload(name);
      return { ok: true };
    });
  });

  ipcMain.handle(ipc.MODELS_CANCEL, function (_e, name) {
    if (models && models.cancel) { try { models.cancel(name); } catch (e) { /* ignore */ } }
    return { ok: true };
  });

  ipcMain.handle(ipc.HISTORY_LIST, function () {
    return historyStore && historyStore.list ? historyStore.list() : [];
  });
  ipcMain.handle(ipc.HISTORY_REMOVE, function (_e, id) {
    if (historyStore && historyStore.remove) historyStore.remove(id);
    return { ok: true };
  });
  ipcMain.handle(ipc.HISTORY_CLEAR, function () {
    if (historyStore && historyStore.clear) historyStore.clear();
    return { ok: true };
  });

  ipcMain.handle(ipc.APP_INFO, function () {
    let version = '';
    try { version = app.getVersion(); } catch (e) { /* ignore */ }
    const st = (server && server.status) ? server.status() : { running: false, model: null, port: null };
    return {
      version: version,
      whisper: { running: !!st.running, model: st.model || null, port: st.port || null },
      helper: { running: !!(helper && helper.ready) },
    };
  });

  ipcMain.handle(ipc.HOTKEY_CAPTURE, function () {
    return new Promise(function (resolve, reject) {
      if (!helper || !helper.capture) { reject(new Error('helper unavailable')); return; }
      let settled = false;
      const to = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { helper.removeListener('captured', onCap); } catch (e) { /* ignore */ }
        // Disarm the helper so an abandoned rebind never later transmits a key.
        try { if (helper.captureCancel) helper.captureCancel(); } catch (e) { /* ignore */ }
        reject(new Error('capture timed out'));
      }, 10000);
      function onCap(info) {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        resolve({
          vk: info.vk,
          name: info.name || ('VK ' + info.vk),
          mods: Array.isArray(info.mods) ? info.mods : [],
        });
      }
      helper.once('captured', onCap);
      try {
        helper.capture();
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(to);
          try { helper.removeListener('captured', onCap); } catch (e2) { /* ignore */ }
          try { if (helper.captureCancel) helper.captureCancel(); } catch (e2) { /* ignore */ }
          reject(e);
        }
      }
    });
  });

  // Live model picker for the Rewrite settings tab. Queries the configured LOCAL
  // model server (loopback-only, enforced in rewrite.js); never throws — an
  // unreachable server returns { reachable:false } so the UI shows "not detected".
  // Accepts an optional { endpoint, api } so the UI can probe unsaved values;
  // falls back to the saved settings.
  ipcMain.handle(ipc.REWRITE_MODELS, function (_evt, opts) {
    if (!rewriter || !rewriter.listModels) {
      return { reachable: false, models: [], host: '' };
    }
    let rw = {};
    try { rw = settingsStore.get().rewrite || {}; } catch (e) { /* ignore */ }
    const endpoint = (opts && typeof opts.endpoint === 'string' && opts.endpoint) ? opts.endpoint : rw.endpoint;
    const api = (opts && opts.api) ? opts.api : rw.api;
    return rewriter.listModels({ endpoint: endpoint, api: api }).then(function (r) {
      return r || { reachable: false, models: [], host: '' };
    }, function (e) {
      logWarn('rewrite:models query failed', e);
      return { reachable: false, models: [], host: '' };
    });
  });

  ipcMain.handle(ipc.WHISPER_RESTART, function () {
    let model = null;
    try { model = settingsStore.get().model; } catch (e) { /* ignore */ }
    return restartWhisper(model).then(function () {
      return (server && server.status) ? server.status() : { running: false };
    });
  });

  // ---- welcome / permissions onboarding (macOS TCC) ----
  // On win32 these all resolve to "granted" / no-op (permissions.js reports win32),
  // so registering them unconditionally is harmless and keeps the channel set stable.
  ipcMain.handle(ipc.PERMS_GET, function () {
    if (permissions && permissions.get) return permissions.get();
    return { listen: true, ax: true, mic: true, platform: IS_DARWIN ? 'darwin' : 'win32' };
  });

  ipcMain.handle(ipc.PERMS_REQUEST, function (_e, kind) {
    if (!permissions) return { listen: true, ax: true, mic: true, platform: IS_DARWIN ? 'darwin' : 'win32' };
    try {
      if (kind === 'mic') {
        return Promise.resolve(permissions.requestMic()).then(function () { return permissions.get(); });
      }
      if (kind === 'listen') permissions.requestListen();
      else if (kind === 'ax') permissions.requestAx();
    } catch (e) {
      logWarn('perms:request failed', e);
    }
    return permissions.get();
  });

  ipcMain.handle(ipc.PERMS_OPEN_PANE, function (_e, kind) {
    if (permissions && permissions.openPane) {
      try { permissions.openPane(kind); } catch (e) { logWarn('perms:openPane failed', e); }
    }
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// exported for potential tooling / tests (harmless in production)
// ---------------------------------------------------------------------------

module.exports = { boot: boot, runSmoke: runSmoke };
