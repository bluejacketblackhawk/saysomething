'use strict';

/**
 * SaySomethingHelper.exe supervisor (agent A).
 *
 * Compiles the C# helper via native/build.cmd when the exe is missing, spawns
 * it, speaks the JSON-lines protocol from docs/CONTRACTS.md over stdio, and
 * auto-restarts it with exponential backoff on crash. Exposes a singleton
 * EventEmitter.
 *
 * Events:
 *   'ready'       — helper installed its hook and is accepting commands
 *   'key'         {vk, down, held} — a watched VK went down/up (held: physical snapshot of watched keys)
 *   'captured'    {vk, name, mods} — rebind capture result (mods: held modifier VKs)
 *   'foreground'  {exe, title}    — mirror of a foreground() reply
 *   'log'         msg             — helper-internal warning (never keystrokes)
 *   'crash'       {code, signal}  — helper process exited unexpectedly
 *   'unavailable' {restarts}      — gave up after MAX_RAPID_RESTARTS; hotkey dead
 *
 * Methods:
 *   start()            -> Promise<void>   compile-if-missing, spawn, resolve on ready
 *   stop()                                 quit + terminate; suppress restart
 *   watch(vks)                             replace the FULL watched VK set
 *   capture()                              arm one-shot next-key capture
 *   captureCancel()                        disarm a pending one-shot capture
 *   paste(text, restoreMs) -> Promise<{ok, err}>
 *   type(text)             -> Promise<{ok, err}>
 *   copy(text)             -> Promise<{ok, err}>   set clipboard, no paste
 *   placeAt(text, x, y, restoreMs) -> Promise<{ok, err}>  click at point + paste
 *   foreground()           -> Promise<{exe, title}>
 *   ping()                 -> Promise<boolean>
 */

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { BIN_HELPER, HELPER_SRC } = require('./config');
const log = require('./log');

const BUILD_CMD = path.join(path.dirname(HELPER_SRC), 'build.cmd');

const READY_TIMEOUT_MS = 15000;
const PING_TIMEOUT_MS = 2000;
const TYPE_TIMEOUT_MS = 8000;
const FOREGROUND_TIMEOUT_MS = 2000;

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 8000;
const STABLE_MS = 10000;      // helper up this long => reset the backoff counter
const MAX_RAPID_RESTARTS = 3; // then give up and emit 'unavailable' (SPEC resilience)

class Helper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.ready = false;
    this.watched = []; // last full watch set, re-sent after a restart

    this._buf = '';
    this._starting = null;
    this._stopping = false;
    this._restartCount = 0;
    this._restartTimer = null;
    this._stableTimer = null;

    // Per-command-type FIFO queues of pending {resolve, reject, timer}.
    this._pingQ = [];
    this._pasteQ = [];
    this._typeQ = [];
    this._fgQ = [];
    this._copyQ = [];
    this._placeQ = [];

    this._onReadyOnce = null;
  }

  // ---- lifecycle ------------------------------------------------------

  /** Compile if needed, spawn, resolve once the helper reports 'ready'. */
  start() {
    if (this._starting) return this._starting;
    if (this.proc && this.ready) return Promise.resolve();
    this._stopping = false;
    const self = this;
    this._starting = this._ensureCompiled()
      .then(function () { return self._spawn(); })
      .then(function () { self._starting = null; })
      .catch(function (e) { self._starting = null; throw e; });
    return this._starting;
  }

  /** Terminate the helper; do not auto-restart. */
  stop() {
    this._stopping = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
    const p = this.proc;
    this._rejectAll(new Error('helper stopped'));
    if (p) {
      try { this._send({ cmd: 'quit' }); } catch (e) { /* ignore */ }
      try { if (p.stdin) p.stdin.end(); } catch (e) { /* ignore */ }
      setTimeout(function () { try { p.kill(); } catch (e) { /* ignore */ } }, 500);
    }
  }

  _ensureCompiled() {
    return new Promise(function (resolve, reject) {
      if (fs.existsSync(BIN_HELPER)) { resolve(); return; }
      if (!fs.existsSync(BUILD_CMD)) {
        reject(new Error('helper build.cmd missing at ' + BUILD_CMD));
        return;
      }
      log.info('helper: SaySomethingHelper.exe missing — compiling via build.cmd');
      const cmd = process.env.ComSpec || 'cmd.exe';
      execFile(cmd, ['/c', BUILD_CMD], { windowsHide: true, cwd: path.dirname(BUILD_CMD) },
        function (err, stdout, stderr) {
          if (err) {
            const detail = (stderr && String(stderr).trim()) || (stdout && String(stdout).trim()) || err.message;
            reject(new Error('helper compile failed: ' + detail));
            return;
          }
          if (!fs.existsSync(BIN_HELPER)) {
            reject(new Error('helper compile produced no exe at ' + BIN_HELPER));
            return;
          }
          log.info('helper: compiled SaySomethingHelper.exe');
          resolve();
        });
    });
  }

  _spawn() {
    const self = this;
    return new Promise(function (resolve, reject) {
      let child;
      try {
        child = spawn(BIN_HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        reject(e);
        return;
      }

      self.proc = child;
      self.ready = false;
      self._buf = '';

      let settled = false;
      const readyTimer = setTimeout(function () {
        if (settled) return;
        settled = true;
        self._onReadyOnce = null;
        try { child.kill(); } catch (e) { /* ignore */ }
        reject(new Error('helper ready timeout'));
      }, READY_TIMEOUT_MS);

      self._onReadyOnce = function () {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        resolve();
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function (chunk) { self._onStdout(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', function (d) {
        const s = String(d).trim();
        if (s) log.warn('helper stderr: ' + s);
      });
      child.on('error', function (err) {
        log.error('helper: process error', err);
        if (!settled) {
          settled = true;
          clearTimeout(readyTimer);
          self._onReadyOnce = null;
          reject(err);
        }
      });
      child.on('exit', function (code, signal) { self._onExit(code, signal); });
    });
  }

  _onExit(code, signal) {
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
    const wasStopping = this._stopping;
    this.proc = null;
    this.ready = false;
    this._onReadyOnce = null;
    this._rejectAll(new Error('helper exited'));

    if (wasStopping) {
      log.info('helper: stopped (code=' + code + ', signal=' + signal + ')');
      return;
    }
    log.warn('helper: exited unexpectedly (code=' + code + ', signal=' + signal + ')');
    this.emit('crash', { code: code, signal: signal });
    this._scheduleRestart();
  }

  _scheduleRestart() {
    const self = this;
    if (this._restartTimer || this._stopping) return;
    // SPEC "Error handling & resilience": max 3 rapid retries, then notify + error.
    // _restartCount is reset to 0 once the helper stays up STABLE_MS (see the
    // 'ready' stable timer), so this counts only RAPID consecutive failures.
    if (this._restartCount >= MAX_RAPID_RESTARTS) {
      log.error('helper: gave up after ' + this._restartCount + ' rapid restarts — hotkey unavailable');
      this.emit('unavailable', { restarts: this._restartCount });
      return;
    }
    this._restartCount += 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, this._restartCount - 1));
    log.warn('helper: restart #' + this._restartCount + ' in ' + delay + 'ms');
    this._restartTimer = setTimeout(function () {
      self._restartTimer = null;
      if (self._stopping) return;
      self._spawn().then(function () {
        log.info('helper: restarted');
      }).catch(function (e) {
        log.error('helper: restart failed: ' + (e && e.message));
        if (!self._stopping) self._scheduleRestart();
      });
    }, delay);
  }

  // ---- stdout parsing -------------------------------------------------

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      let line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.length && line.charCodeAt(line.length - 1) === 13) {
        line = line.slice(0, -1); // strip trailing \r
      }
      if (line.length) this._onLine(line);
    }
  }

  _onLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch (e) { return; }
    if (!obj || typeof obj.evt !== 'string') return;

    switch (obj.evt) {
      case 'ready':
        this.ready = true;
        this._armStableTimer();
        // Re-assert the watched set after a (re)spawn.
        if (this.watched && this.watched.length) {
          this._send({ cmd: 'watch', vks: this.watched });
        }
        this.emit('ready');
        if (this._onReadyOnce) { const cb = this._onReadyOnce; this._onReadyOnce = null; cb(); }
        break;
      case 'pong':
        this._resolveNext(this._pingQ, true);
        break;
      case 'key':
        this.emit('key', {
          vk: obj.vk | 0,
          down: !!obj.down,
          held: Array.isArray(obj.held) ? obj.held.map(function (v) { return v | 0; }) : null,
        });
        break;
      case 'captured': {
        const mods = [];
        if (Array.isArray(obj.mods)) {
          for (let mi = 0; mi < obj.mods.length; mi++) {
            const mv = obj.mods[mi] | 0;
            if (mv > 0 && mods.indexOf(mv) === -1) mods.push(mv);
          }
        }
        this.emit('captured', {
          vk: obj.vk | 0,
          name: (typeof obj.name === 'string' ? obj.name : ''),
          mods: mods,
        });
        break;
      }
      case 'picked':
        this.emit('picked', { x: obj.x | 0, y: obj.y | 0 });
        break;
      case 'pasted':
        this._resolveNext(this._pasteQ, { ok: !!obj.ok, err: (obj.err == null ? null : String(obj.err)) });
        break;
      case 'typed':
        this._resolveNext(this._typeQ, { ok: !!obj.ok, err: (obj.err == null ? null : String(obj.err)) });
        break;
      case 'copied':
        this._resolveNext(this._copyQ, { ok: !!obj.ok, err: (obj.err == null ? null : String(obj.err)) });
        break;
      case 'placed':
        this._resolveNext(this._placeQ, { ok: !!obj.ok, err: (obj.err == null ? null : String(obj.err)) });
        break;
      case 'foreground': {
        const info = { exe: (obj.exe || ''), title: (obj.title || '') };
        this._resolveNext(this._fgQ, info);
        this.emit('foreground', info);
        break;
      }
      case 'log':
        if (obj.msg != null) {
          log.warn('helper: ' + obj.msg);
          this.emit('log', String(obj.msg));
        }
        break;
      default:
        break;
    }
  }

  _armStableTimer() {
    const self = this;
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(function () {
      self._restartCount = 0;
      self._stableTimer = null;
    }, STABLE_MS);
  }

  // ---- commands -------------------------------------------------------

  /** Replace the FULL watched VK set. @param {number[]} vks */
  watch(vks) {
    this.watched = Array.isArray(vks) ? vks.slice() : [];
    this._send({ cmd: 'watch', vks: this.watched });
  }

  /** One-shot: report the next keydown (any VK) as a 'captured' event. */
  capture() {
    this._send({ cmd: 'capture' });
  }

  /** Disarm a pending one-shot capture (rebind abandoned/timed out). */
  captureCancel() {
    this._send({ cmd: 'capture-cancel' });
  }

  /**
   * Arm a one-shot mouse pick: resolve with the next left-click's screen point
   * {x, y}. The click is swallowed by the hook (the caller then places text there
   * via placeAt). Rejects on timeout and disarms.
   * @param {number} [timeoutMs]
   * @returns {Promise<{x:number, y:number}>}
   */
  pickPoint(timeoutMs) {
    const self = this;
    const to = timeoutMs || 20000;
    return new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return; done = true;
        try { self.removeListener('picked', onPick); } catch (e) { /* ignore */ }
        try { self._send({ cmd: 'pick-cancel' }); } catch (e) { /* ignore */ }
        reject(new Error('pick timed out'));
      }, to);
      function onPick(pt) {
        if (done) return; done = true;
        clearTimeout(timer);
        resolve(pt);
      }
      self.once('picked', onPick);
      if (!self._send({ cmd: 'pickPoint' })) {
        done = true; clearTimeout(timer);
        try { self.removeListener('picked', onPick); } catch (e) { /* ignore */ }
        reject(new Error('helper not running'));
      }
    });
  }

  /** Disarm a pending one-shot mouse pick. */
  pickCancel() {
    this._send({ cmd: 'pick-cancel' });
  }

  /** Clipboard-swap + Ctrl+V. @param {string} text @param {number} [restoreMs] */
  paste(text, restoreMs) {
    const r = (restoreMs == null) ? 300 : (restoreMs | 0);
    const payload = { cmd: 'paste', text: (text == null ? '' : String(text)), restoreMs: r };
    return this._request(this._pasteQ, payload, r + 5000);
  }

  /** SendInput KEYEVENTF_UNICODE. @param {string} text */
  type(text) {
    const payload = { cmd: 'type', text: (text == null ? '' : String(text)) };
    return this._request(this._typeQ, payload, TYPE_TIMEOUT_MS);
  }

  /** Set the clipboard WITHOUT pasting (drop pad auto-copy). @param {string} text */
  copy(text) {
    const payload = { cmd: 'clipboard', text: (text == null ? '' : String(text)) };
    return this._request(this._copyQ, payload, TYPE_TIMEOUT_MS);
  }

  /**
   * Move the cursor to a screen point, click to focus + drop the caret, paste.
   * @param {string} text @param {number} x @param {number} y @param {number} [restoreMs]
   */
  placeAt(text, x, y, restoreMs) {
    const r = (restoreMs == null) ? 300 : (restoreMs | 0);
    const payload = { cmd: 'placeAt', text: (text == null ? '' : String(text)), x: x | 0, y: y | 0, restoreMs: r };
    return this._request(this._placeQ, payload, r + 5000);
  }

  /** @returns {Promise<{exe:string,title:string}>} */
  foreground() {
    return this._request(this._fgQ, { cmd: 'foreground' }, FOREGROUND_TIMEOUT_MS);
  }

  /** @returns {Promise<boolean>} true if the helper answered 'pong' */
  ping() {
    return this._request(this._pingQ, { cmd: 'ping' }, PING_TIMEOUT_MS)
      .then(function () { return true; });
  }

  // ---- plumbing -------------------------------------------------------

  _send(obj) {
    const p = this.proc;
    if (!p || !p.stdin || !p.stdin.writable) return false;
    try {
      p.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  _request(queue, obj, timeoutMs) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const pending = { resolve: resolve, reject: reject, timer: null };
      pending.timer = setTimeout(function () {
        const idx = queue.indexOf(pending);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new Error('helper timeout for ' + obj.cmd));
      }, timeoutMs);
      queue.push(pending);
      if (!self._send(obj)) {
        clearTimeout(pending.timer);
        const idx = queue.indexOf(pending);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new Error('helper not running'));
      }
    });
  }

  _resolveNext(queue, value) {
    const pending = queue.shift();
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(value);
    }
  }

  _rejectAll(err) {
    const queues = [this._pingQ, this._pasteQ, this._typeQ, this._fgQ, this._copyQ, this._placeQ];
    for (let q = 0; q < queues.length; q++) {
      const queue = queues[q];
      while (queue.length) {
        const pending = queue.shift();
        clearTimeout(pending.timer);
        try { pending.reject(err); } catch (e) { /* ignore */ }
      }
    }
  }
}

module.exports = new Helper();
