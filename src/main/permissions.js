'use strict';

/**
 * macOS permissions (TCC) tracker for the dictation onboarding (agent: permissions).
 *
 * darwin ONLY behaviour. On win32 every getter reports "granted", every request is
 * a no-op, and allGranted() is always true, so the existing Windows flow is
 * completely unchanged (the onboarding is never shown, the hotkey/mic just work).
 *
 * Three separate grants gate dictation on macOS:
 *   - listen  Input Monitoring  (kTCCServiceListenEvent)   — observe the global
 *             keyboard so the hold-to-talk key fires in any app.
 *   - ax      Accessibility     (kTCCServiceAccessibility)  — swallow the hotkey
 *             chord + inject the transcribed text at the caret.
 *   - mic     Microphone                                     — capture audio.
 *
 * listen/ax are reported by the native helper over stdio (see
 * docs/MAC-PORT-ADDENDUM.md: `{"evt":"perms","listen":..,"ax":..}`), surfaced by
 * helper.js as a 'perms' event and a permsRequest(kind)/perms() API. mic is
 * Electron-side via systemPreferences, and re-polled on window focus because TCC
 * can change behind the app's back while the user is in System Settings.
 *
 * You cannot pre-grant any of these (the TCC DB is SIP-protected); the app can only
 * trigger the OS prompt or deep-link the relevant System Settings pane.
 */

const { EventEmitter } = require('events');

const electron = require('electron');
const app = electron.app;
const systemPreferences = electron.systemPreferences;
const shell = electron.shell;

let helper = null;
try { helper = require('./helper'); } catch (e) { helper = null; }

let log;
try {
  log = require('./log');
} catch (e) {
  log = { debug: noop, info: noop, warn: noop, error: noop };
}
function noop() {}

const IS_DARWIN = process.platform === 'darwin';

// x-apple.systempreferences deep links (Privacy panes). See docs/MAC-PORT.md §4.
const PANE_URL = {
  listen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  ax: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

// Helper-fed grants default to false until the helper reports; mic is polled.
const state = { listen: false, ax: false, mic: false };

// ---------------------------------------------------------------------------
// mic (Electron systemPreferences)
// ---------------------------------------------------------------------------

function micGranted() {
  if (!IS_DARWIN) return true;
  try {
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  } catch (e) {
    return false;
  }
}

// Seed the mic state from the OS (best-effort; re-checked again on app-ready and
// on every window focus).
try { state.mic = micGranted(); } catch (e) { /* stays false */ }

// ---------------------------------------------------------------------------
// change tracking
// ---------------------------------------------------------------------------

function snapshot() {
  if (!IS_DARWIN) {
    return { listen: true, ax: true, mic: true, platform: 'win32' };
  }
  return { listen: !!state.listen, ax: !!state.ax, mic: !!state.mic, platform: 'darwin' };
}

let last = JSON.stringify(snapshot());

function emitIfChanged() {
  const now = JSON.stringify(snapshot());
  if (now === last) return;
  last = now;
  emitter.emit('change', snapshot());
}

function setPerm(key, value) {
  const b = !!value;
  if (state[key] === b) return;
  state[key] = b;
  log.info('permissions: ' + key + ' -> ' + (b ? 'granted' : 'missing'));
  emitIfChanged();
}

/** Re-poll the microphone grant (TCC can change while the app is unfocused). */
function recheckMic() {
  if (!IS_DARWIN) return;
  setPerm('mic', micGranted());
}

// ---------------------------------------------------------------------------
// helper 'perms' wiring (listen/ax) — no-op until the helper emits (or on win32)
// ---------------------------------------------------------------------------

if (IS_DARWIN && helper && typeof helper.on === 'function') {
  helper.on('perms', function (p) {
    if (!p || typeof p !== 'object') return;
    if (typeof p.listen === 'boolean') setPerm('listen', p.listen);
    if (typeof p.ax === 'boolean') setPerm('ax', p.ax);
  });
}

// ---------------------------------------------------------------------------
// re-check mic on focus
// ---------------------------------------------------------------------------

function hookFocus() {
  if (!IS_DARWIN || !app) return;
  try {
    app.on('browser-window-focus', recheckMic);
    app.on('activate', recheckMic); // macOS: dock click / app reactivation
  } catch (e) {
    log.warn('permissions: could not hook focus events', e);
  }
}

if (IS_DARWIN && app) {
  try {
    if (typeof app.isReady === 'function' && app.isReady()) {
      recheckMic();
      hookFocus();
    } else if (typeof app.whenReady === 'function') {
      app.whenReady().then(function () { recheckMic(); hookFocus(); }).catch(function () {});
    } else {
      hookFocus();
    }
  } catch (e) {
    hookFocus();
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** @returns {{listen:boolean, ax:boolean, mic:boolean, platform:'darwin'|'win32'}} */
function get() {
  return snapshot();
}

/**
 * Subscribe to grant changes. Fires with a fresh snapshot on every transition.
 * @param {(snapshot:object) => void} cb
 * @returns {() => void} unsubscribe
 */
function onChange(cb) {
  emitter.on('change', cb);
  return function () { try { emitter.removeListener('change', cb); } catch (e) { /* ignore */ } };
}

/** @returns {boolean} true once all three grants are in place (always true on win32). */
function allGranted() {
  const s = snapshot();
  return !!(s.listen && s.ax && s.mic);
}

/**
 * Deep-link the relevant System Settings > Privacy pane. macOS usually needs a
 * manual toggle even after the prompt, so callers pair this with the OS request.
 * @param {'listen'|'ax'|'mic'} kind
 * @returns {Promise<boolean>}
 */
function openPane(kind) {
  if (!IS_DARWIN) return Promise.resolve(false);
  const url = PANE_URL[kind];
  if (!url) return Promise.resolve(false);
  try {
    return Promise.resolve(shell.openExternal(url)).then(
      function () { return true; },
      function (e) { log.warn('permissions: openPane(' + kind + ') failed', e); return false; }
    );
  } catch (e) {
    log.warn('permissions: openPane(' + kind + ') threw', e);
    return Promise.resolve(false);
  }
}

/** Trigger the Input Monitoring prompt via the helper AND open the pane. */
function requestListen() {
  if (!IS_DARWIN) return;
  try { if (helper && helper.permsRequest) helper.permsRequest('listen'); }
  catch (e) { log.warn('permissions: helper.permsRequest(listen) failed', e); }
  openPane('listen');
}

/** Trigger the Accessibility prompt via the helper AND open the pane. */
function requestAx() {
  if (!IS_DARWIN) return;
  try { if (helper && helper.permsRequest) helper.permsRequest('ax'); }
  catch (e) { log.warn('permissions: helper.permsRequest(ax) failed', e); }
  openPane('ax');
}

/**
 * Prompt for microphone access. Once macOS has decided (denied) it won't reprompt,
 * so on a non-grant we also deep-link the Microphone pane. Never rejects.
 * @returns {Promise<boolean>} the resulting mic grant
 */
function requestMic() {
  if (!IS_DARWIN) return Promise.resolve(true);
  let pending;
  try {
    pending = systemPreferences.askForMediaAccess('microphone');
  } catch (e) {
    pending = Promise.resolve(false);
  }
  return Promise.resolve(pending).then(function (granted) {
    // Trust the fresh OS status over the boolean (it accounts for a pre-existing grant).
    setPerm('mic', !!granted || micGranted());
    if (!state.mic) openPane('mic'); // already-denied: the prompt won't show again
    return state.mic;
  }, function (e) {
    log.warn('permissions: askForMediaAccess failed', e);
    recheckMic();
    if (!state.mic) openPane('mic');
    return state.mic;
  });
}

module.exports = {
  get: get,
  onChange: onChange,
  allGranted: allGranted,
  requestListen: requestListen,
  requestAx: requestAx,
  requestMic: requestMic,
  openPane: openPane,
  recheckMic: recheckMic,
};
