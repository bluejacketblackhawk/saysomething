'use strict';

/**
 * Canonical IPC channel names. This module is the single source of truth for
 * every channel used between main and the two renderers. The preload scripts
 * (src/preload/overlay.js, src/preload/settings.js) whitelist EXACTLY the
 * per-renderer subsets defined here; because sandboxed preloads cannot require
 * local modules, those preloads inline the same string literals — keep them in
 * sync with this file.
 */

const CH = {
  // ---- Overlay renderer: main → renderer ----
  OVERLAY_STATE: 'overlay:state',   // { state, detail } state ∈ hidden|listening|transcribing|rewriting|success|cancelled|error|nothing-heard
  OVERLAY_PARTIAL: 'overlay:partial', // { sessionId, text } live interim transcript (display-only, never injected)
  AUDIO_START: 'audio:start',       // { sessionId, deviceId, preRollMs, warm, chime }
  AUDIO_STOP: 'audio:stop',         // { sessionId }
  AUDIO_ABORT: 'audio:abort',       // { sessionId }
  AUDIO_VAD: 'audio:vad',           // { sessionId, enabled, silenceMs } — arm/disarm latched auto-stop VAD

  // ---- Drop pad renderer ----
  PAD_SHOW: 'pad:show',             // main → pad: { text }  show the pad with this text
  PAD_MOVE: 'pad:move',             // pad → main: { x, y }  move the pad window (drag-follow)
  PAD_PLACE: 'pad:place',           // pad → main: { x, y }  drop the text at this screen point
  PAD_COPY: 'pad:copy',             // pad → main: re-copy the text to the clipboard
  PAD_DISMISS: 'pad:dismiss',       // pad → main: close the pad

  // ---- Overlay renderer: renderer → main ----
  AUDIO_CHUNK: 'audio:chunk',       // { sessionId, buf }  (ArrayBuffer PCM16 16k mono)
  AUDIO_STARTED: 'audio:started',   // { sessionId }
  AUDIO_STOPPED: 'audio:stopped',   // { sessionId }
  AUDIO_ERROR: 'audio:error',       // { message }
  AUDIO_SILENCE: 'audio:silence',   // { sessionId } — VAD detected end-of-speech (latched auto-stop)

  // ---- Settings renderer: invoke (renderer → main → reply) ----
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  MODELS_LIST: 'models:list',
  MODELS_DOWNLOAD: 'models:download',
  MODELS_CANCEL: 'models:cancel',
  HISTORY_LIST: 'history:list',
  HISTORY_REMOVE: 'history:remove',
  HISTORY_CLEAR: 'history:clear',
  APP_INFO: 'app:info',
  HOTKEY_CAPTURE: 'hotkey:capture',
  WHISPER_RESTART: 'whisper:restart',
  REWRITE_MODELS: 'rewrite:models',   // -> { reachable, models:[name], host }

  // ---- Settings renderer: events (main → renderer) ----
  MODELS_PROGRESS: 'models:progress', // { name, pct, bytes, total }
  WHISPER_STATUS: 'whisper:status',   // { running, model, port }
  SETTINGS_CHANGED: 'settings:changed', // { settings }

  // ---- Welcome / permissions onboarding renderer (macOS TCC) ----
  // invoke (renderer → main → reply):
  PERMS_GET: 'perms:get',             // -> { listen, ax, mic, platform:'darwin'|'win32' }
  PERMS_REQUEST: 'perms:request',     // (kind: 'listen'|'ax'|'mic') trigger the OS prompt (+ open the pane for listen/ax) -> current snapshot
  PERMS_OPEN_PANE: 'perms:openPane',  // (kind) open the System Settings pane
  // event (main → renderer):
  PERMS_CHANGED: 'perms:changed',     // { listen, ax, mic, platform }
};

// Per-renderer whitelists (what each preload is allowed to bridge).
const OVERLAY = {
  send: [CH.AUDIO_CHUNK, CH.AUDIO_STARTED, CH.AUDIO_STOPPED, CH.AUDIO_ERROR, CH.AUDIO_SILENCE],
  on: [CH.OVERLAY_STATE, CH.OVERLAY_PARTIAL, CH.AUDIO_START, CH.AUDIO_STOP, CH.AUDIO_ABORT, CH.AUDIO_VAD],
  invoke: [],
};

const PAD = {
  send: [CH.PAD_MOVE, CH.PAD_PLACE, CH.PAD_COPY, CH.PAD_DISMISS],
  on: [CH.PAD_SHOW],
  invoke: [],
};

const SETTINGS = {
  send: [],
  on: [CH.MODELS_PROGRESS, CH.WHISPER_STATUS, CH.SETTINGS_CHANGED],
  invoke: [
    CH.SETTINGS_GET, CH.SETTINGS_SET,
    CH.MODELS_LIST, CH.MODELS_DOWNLOAD, CH.MODELS_CANCEL,
    CH.HISTORY_LIST, CH.HISTORY_REMOVE, CH.HISTORY_CLEAR,
    CH.APP_INFO, CH.HOTKEY_CAPTURE, CH.WHISPER_RESTART,
    CH.REWRITE_MODELS,
  ],
};

const WELCOME = {
  send: [],
  on: [CH.PERMS_CHANGED],
  invoke: [CH.PERMS_GET, CH.PERMS_REQUEST, CH.PERMS_OPEN_PANE],
};

// Export the constants both flat (ipc.OVERLAY_STATE) and grouped (ipc.CH.OVERLAY_STATE),
// plus the per-renderer whitelists.
module.exports = Object.assign({}, CH, { CH: CH, OVERLAY: OVERLAY, PAD: PAD, SETTINGS: SETTINGS, WELCOME: WELCOME });
