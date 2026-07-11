'use strict';

/**
 * Settings store (agent E).
 *
 * Persists to <USER_DATA>/settings.json. Loads by deep-merging saved JSON over
 * the schema DEFAULTS with type coercion, so partial / stale / hand-edited files
 * always resolve to a fully-valid object. Writes are atomic (tmp file + rename)
 * and a corrupt file is backed up rather than lost. Change listeners fire after
 * every persisted mutation.
 *
 * Works both inside Electron and in plain node (require-able for tests): the path
 * comes from config.js, which itself falls back to %APPDATA%/SaySomething when Electron
 * is unavailable. Loading tolerates a missing directory/file (→ DEFAULTS) and
 * never throws.
 *
 * API: get() -> whole object, set(partial) -> deep-merge+persist+emit,
 * onChange(cb) -> register listener (returns an unsubscribe fn).
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// log.js requires config only; safe to require here. Guarded so the store stays
// usable in any context (e.g. a bare `node -e require(...)` outside the app).
let log;
try {
  log = require('../log');
} catch (e) {
  log = { debug: noop, info: noop, warn: noop, error: noop };
}
function noop() {}

const FILE = path.join(config.USER_DATA, 'settings.json');
const TMP = FILE + '.tmp';

const DEFAULTS = {
  hotkey: { vk: 163, name: 'Right Ctrl' },
  // Drop pad hotkey (v0.4): hold this instead of the main hotkey → speak → a
  // draggable, auto-copied pad appears to place the text wherever you want.
  padHotkey: { vk: 165, name: 'Right Alt' },
  pad: { enabled: true },
  mic: { deviceId: 'default', warm: true, preRollMs: 800 },
  model: 'small.en',
  language: 'en',
  format: {
    fillerRemoval: true,
    voiceCommands: true,
    trailingSpace: true,
    autoCapitalize: true,
    artifactStrip: true,
  },
  dictionary: [],
  // Optional local AI rewrite via Ollama (v0.2). Master toggle default OFF; when
  // on and Ollama is reachable, the formatted text is rewritten before injection.
  // localhost-only; see src/main/whisper/rewrite.js.
  rewrite: { enabled: false, style: 'cleanup', model: '', timeoutMs: 10000 },
  inject: { mode: 'paste', restoreClipboardMs: 300 },
  // Live partial transcripts (v0.3): show words in the pill as you speak. The
  // interim passes run on the already-warm whisper server and are display-only —
  // never injected, never stored. Default ON; it's the "feels alive" differentiator.
  streaming: { enabled: true },
  // Latched (hands-free) auto-stop: finish when the speaker goes quiet (v0.2).
  // Default ON — it's the differentiator; tap-again is always the manual override.
  // Applies ONLY to tap/latch mode; hold-to-talk is never auto-stopped.
  autoStop: { enabled: true, silenceMs: 2000 },
  overlay: { chime: true, offsetY: 48 },
  history: { enabled: true, max: 200 },
  launchAtLogin: false,
  paused: false,
  welcomed: false,         // set true after the first-run welcome has been shown
  whisperPort: 8737,
  maxUtteranceSec: 300,
};

const INJECT_MODES = ['paste', 'type'];
const REWRITE_STYLES = ['cleanup', 'professional', 'casual', 'bullets'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

/**
 * Deep-merge/validate `val` against the shape of `def`, returning a value with
 * exactly `def`'s structure and matching primitive types. Unknown keys in `val`
 * are dropped; missing/ill-typed values fall back to the default.
 */
function coerce(def, val) {
  if (Array.isArray(def)) {
    // The only array in the schema is `dictionary` (list of strings).
    if (!Array.isArray(val)) return def.slice();
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < val.length; i++) {
      if (typeof val[i] !== 'string') continue;
      const s = val[i].trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(s);
    }
    return out;
  }
  if (isPlainObject(def)) {
    const out = {};
    const keys = Object.keys(def);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const sub = isPlainObject(val) ? val[k] : undefined;
      out[k] = coerce(def[k], sub);
    }
    return out;
  }
  // primitive
  if (typeof val === typeof def && val !== null && val !== undefined) return val;
  return def;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return fallback;
  if (n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * Apply value-range / enum constraints on top of the structural coercion.
 * Mutates and returns `s`.
 */
function fixup(s) {
  if (INJECT_MODES.indexOf(s.inject.mode) === -1) s.inject.mode = DEFAULTS.inject.mode;
  if (REWRITE_STYLES.indexOf(s.rewrite.style) === -1) s.rewrite.style = DEFAULTS.rewrite.style;
  // Hard cap on the rewrite budget (SPEC: default 10s, hard cap) — a bad saved
  // value can never make a rewrite hang dictation longer than 10s.
  s.rewrite.timeoutMs = clampInt(s.rewrite.timeoutMs, 1000, 10000, DEFAULTS.rewrite.timeoutMs);
  if (typeof s.rewrite.model !== 'string') s.rewrite.model = DEFAULTS.rewrite.model;
  s.inject.restoreClipboardMs = clampInt(s.inject.restoreClipboardMs, 0, 60000, DEFAULTS.inject.restoreClipboardMs);
  s.mic.preRollMs = clampInt(s.mic.preRollMs, 0, 5000, DEFAULTS.mic.preRollMs);
  s.autoStop.silenceMs = clampInt(s.autoStop.silenceMs, 1000, 5000, DEFAULTS.autoStop.silenceMs);
  s.overlay.offsetY = clampInt(s.overlay.offsetY, 0, 2000, DEFAULTS.overlay.offsetY);
  s.history.max = clampInt(s.history.max, 0, 100000, DEFAULTS.history.max);
  s.whisperPort = clampInt(s.whisperPort, 1, 65535, DEFAULTS.whisperPort);
  s.maxUtteranceSec = clampInt(s.maxUtteranceSec, 1, 3600, DEFAULTS.maxUtteranceSec);
  s.hotkey.vk = clampInt(s.hotkey.vk, 0, 255, DEFAULTS.hotkey.vk);
  if (typeof s.hotkey.name !== 'string' || !s.hotkey.name) s.hotkey.name = DEFAULTS.hotkey.name;
  s.padHotkey.vk = clampInt(s.padHotkey.vk, 0, 255, DEFAULTS.padHotkey.vk);
  if (typeof s.padHotkey.name !== 'string' || !s.padHotkey.name) s.padHotkey.name = DEFAULTS.padHotkey.name;
  if (typeof s.model !== 'string' || !s.model) s.model = DEFAULTS.model;
  if (typeof s.language !== 'string' || !s.language) s.language = DEFAULTS.language;
  return s;
}

function validated(raw) {
  return fixup(coerce(DEFAULTS, raw));
}

function ensureDir() {
  try {
    fs.mkdirSync(config.USER_DATA, { recursive: true });
  } catch (e) {
    // best-effort; persist() will surface any real failure via log
  }
}

/**
 * Move a corrupt settings.json aside so it isn't silently overwritten.
 */
function backupCorrupt() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.USER_DATA, 'settings.corrupt-' + stamp + '.json');
    fs.renameSync(FILE, dest);
    log.warn('settings: corrupt file backed up to ' + dest);
  } catch (e) {
    log.warn('settings: could not back up corrupt file', e);
  }
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    // missing file / dir → defaults (do not write yet)
    return validated({});
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error('settings: settings.json is not valid JSON; recovering with defaults', e);
    backupCorrupt();
    const def = validated({});
    persist(def);
    return def;
  }
  return validated(parsed);
}

function persist(obj) {
  ensureDir();
  try {
    fs.writeFileSync(TMP, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
  } catch (e) {
    log.error('settings: failed to persist', e);
    try { fs.unlinkSync(TMP); } catch (e2) { /* ignore */ }
  }
}

/**
 * Recursively merge a (possibly nested) partial into base, mutating base.
 * Arrays and primitives from `partial` replace wholesale; nested plain objects
 * merge key-by-key so `set({format:{fillerRemoval:false}})` only touches one flag.
 */
function mergePartial(base, partial) {
  const keys = Object.keys(partial);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const pv = partial[k];
    if (isPlainObject(pv) && isPlainObject(base[k])) {
      mergePartial(base[k], pv);
    } else {
      base[k] = pv;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let current = load();
const listeners = [];

function emit() {
  const snapshot = current;
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i](snapshot);
    } catch (e) {
      log.error('settings: onChange listener threw', e);
    }
  }
}

module.exports = {
  /** @returns {object} the whole, validated settings object */
  get() {
    return current;
  },

  /**
   * Deep-merge a partial update over the current settings, re-validate, persist
   * atomically, and notify listeners.
   * @param {object} partial
   * @returns {object} the updated settings
   */
  set(partial) {
    if (!isPlainObject(partial)) return current;
    const merged = mergePartial(clone(current), partial);
    current = validated(merged);
    persist(current);
    emit();
    return current;
  },

  /**
   * Register a change listener. Fires with the full settings object after every
   * persisted mutation.
   * @param {(settings:object) => void} cb
   * @returns {() => void} unsubscribe
   */
  onChange(cb) {
    if (typeof cb !== 'function') return noop;
    listeners.push(cb);
    return function unsubscribe() {
      const i = listeners.indexOf(cb);
      if (i !== -1) listeners.splice(i, 1);
    };
  },

  /** Exposed for tests / integrator introspection. */
  DEFAULTS: DEFAULTS,
  path: FILE,
};
