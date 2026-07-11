'use strict';

/**
 * File logger for the main process. Writes timestamped lines to
 * %APPDATA%/SaySomething/logs/SaySomething.log, size-capped at ~1 MB and rotated once
 * (SaySomething.log → SaySomething.log.1). Never throws — logging must not crash the app.
 * There is deliberately no console.log spray in the main process; set the
 * env var SAYSOMETHING_LOG_CONSOLE=1 to mirror lines to stdout/stderr while developing.
 *
 * API: log.debug(...) log.info(...) log.warn(...) log.error(...), plus log.path.
 */

const fs = require('fs');
const path = require('path');
const { LOGS_DIR } = require('./config');

const LOG_FILE = path.join(LOGS_DIR, 'SaySomething.log');
const ROTATE_FILE = path.join(LOGS_DIR, 'SaySomething.log.1');
const MAX_BYTES = 1024 * 1024; // ~1 MB
const MIRROR = process.env.SAYSOMETHING_LOG_CONSOLE === '1';

let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    dirEnsured = true;
  } catch (e) {
    // ignore — if we cannot make the dir, appends below will no-op safely
  }
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size >= MAX_BYTES) {
      try { fs.unlinkSync(ROTATE_FILE); } catch (e) { /* may not exist */ }
      fs.renameSync(LOG_FILE, ROTATE_FILE);
    }
  } catch (e) {
    // file does not exist yet — nothing to rotate
  }
}

function stringify(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function format(level, args) {
  const ts = new Date().toISOString();
  const msg = Array.prototype.map.call(args, stringify).join(' ');
  return '[' + ts + '] [' + level + '] ' + msg + '\n';
}

function write(level, args) {
  const line = format(level, args);
  ensureDir();
  rotateIfNeeded();
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    // never throw from logging
  }
  if (MIRROR) {
    const out = (level === 'ERROR' || level === 'WARN') ? process.stderr : process.stdout;
    try { out.write(line); } catch (e) { /* ignore */ }
  }
}

module.exports = {
  debug: function () { write('DEBUG', arguments); },
  info: function () { write('INFO', arguments); },
  warn: function () { write('WARN', arguments); },
  error: function () { write('ERROR', arguments); },
  path: LOG_FILE,
};
