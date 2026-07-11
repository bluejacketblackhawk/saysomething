'use strict';

/**
 * History store (agent E).
 *
 * Persists the last N transcriptions to <USER_DATA>/history.json as an array
 * ordered most-recent-first. `add` is a no-op when history is disabled in
 * settings and always caps the list at settings.history.max. Writes are atomic
 * (tmp + rename); a corrupt file is backed up and the list resets to empty
 * rather than throwing.
 *
 * Entry shape: { id, text, ms, app, at } where `ms` is the transcription time in
 * milliseconds, `app` is the foreground exe captured at finalize, and `at` is the
 * wall-clock timestamp (Date.now()) the entry was stored.
 *
 * API: add({text, ms, app}) -> entry|null, list() -> entries, remove(id), clear().
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const settings = require('./settings');

let log;
try {
  log = require('../log');
} catch (e) {
  log = { debug: noop, info: noop, warn: noop, error: noop };
}
function noop() {}

const FILE = path.join(config.USER_DATA, 'history.json');
const TMP = FILE + '.tmp';

let entries = load();
let idCounter = 0;

function ensureDir() {
  try {
    fs.mkdirSync(config.USER_DATA, { recursive: true });
  } catch (e) {
    // best-effort
  }
}

function backupCorrupt() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.USER_DATA, 'history.corrupt-' + stamp + '.json');
    fs.renameSync(FILE, dest);
    log.warn('history: corrupt file backed up to ' + dest);
  } catch (e) {
    log.warn('history: could not back up corrupt file', e);
  }
}

function sanitizeEntry(e) {
  if (e === null || typeof e !== 'object') return null;
  const text = typeof e.text === 'string' ? e.text : '';
  const id = typeof e.id === 'string' && e.id ? e.id : genId();
  const ms = isFinite(Number(e.ms)) ? Number(e.ms) : 0;
  const app = typeof e.app === 'string' ? e.app : '';
  const at = isFinite(Number(e.at)) ? Number(e.at) : Date.now();
  return { id: id, text: text, ms: ms, app: app, at: at };
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error('history: history.json is not valid JSON; recovering with empty list', e);
    backupCorrupt();
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (let i = 0; i < parsed.length; i++) {
    const s = sanitizeEntry(parsed[i]);
    if (s) out.push(s);
  }
  return out;
}

function persist() {
  ensureDir();
  try {
    fs.writeFileSync(TMP, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
  } catch (e) {
    log.error('history: failed to persist', e);
    try { fs.unlinkSync(TMP); } catch (e2) { /* ignore */ }
  }
}

function genId() {
  idCounter = (idCounter + 1) & 0xffffff;
  return Date.now().toString(36) + '-' + idCounter.toString(36) + '-' +
    Math.floor(Math.random() * 0xffffff).toString(36);
}

function cfg() {
  try {
    return settings.get().history;
  } catch (e) {
    return { enabled: true, max: 200 };
  }
}

module.exports = {
  /**
   * Append a transcription. No-op (returns null) when history is disabled.
   * @param {{text:string, ms:number, app:string}} entry
   * @returns {(object|null)} the stored entry, or null when disabled
   */
  add(entry) {
    const c = cfg();
    if (!c.enabled) return null;
    if (entry === null || typeof entry !== 'object') return null;
    const stored = {
      id: genId(),
      text: typeof entry.text === 'string' ? entry.text : '',
      ms: isFinite(Number(entry.ms)) ? Number(entry.ms) : 0,
      app: typeof entry.app === 'string' ? entry.app : '',
      at: Date.now(),
    };
    entries.unshift(stored);
    const max = c.max > 0 ? c.max : 0;
    if (entries.length > max) entries.length = max;
    persist();
    return stored;
  },

  /** @returns {Array<{id:string, text:string, ms:number, app:string, at:number}>} most-recent-first */
  list() {
    return entries.slice();
  },

  /** @param {string} id */
  remove(id) {
    const before = entries.length;
    entries = entries.filter(function (e) { return e.id !== id; });
    if (entries.length !== before) persist();
  },

  /** Clear all history. */
  clear() {
    if (entries.length === 0) return;
    entries = [];
    persist();
  },

  path: FILE,
};
