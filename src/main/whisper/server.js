'use strict';

/**
 * whisper-server lifecycle manager (singleton EventEmitter).
 *
 * Spawns the local whisper HTTP server bound to 127.0.0.1, probes upward for a
 * free port if the requested one is busy, polls until the port accepts TCP
 * connections (the server only starts listening after the model has loaded, so
 * that doubles as a readiness signal), and auto-restarts with exponential
 * backoff if the process crashes after having been up.
 *
 * The binary path (whisper-server.exe on Windows, whisper-server on darwin) comes
 * from binaries.serverExe() — the CLI flags are identical cross-platform (same
 * whisper.cpp v1.9.1 wire contract). Verified flags (whisper-server --help):
 *   -m <path>  --host 127.0.0.1  --port <n>  -t <threads>
 * A bad/missing model makes the process exit immediately (code 3) BEFORE it
 * opens the port — that is treated as a launch failure (reject), not a crash to
 * retry forever.
 *
 * Emits: 'status' -> { running, model, port }.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { DEFAULT_PORT } = require('../config');
const models = require('./models');
const binaries = require('./binaries');
const log = require('../log');

const READY_TIMEOUT_MS = 60000;   // model load can be slow the first time
const PORT_PROBE_SPAN = 10;       // 8737..8747
const MAX_RAPID_CRASHES = 3;      // then give up auto-restart
const STABLE_MS = 15000;          // uptime after which the crash counter resets

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function threadCount() {
  const n = (os.cpus() || []).length;
  return Math.max(4, n - 2);
}

// Can we bind this port on 127.0.0.1 right now?
function portFree(port) {
  return new Promise(function (resolve) {
    const srv = net.createServer();
    srv.once('error', function () { resolve(false); });
    srv.once('listening', function () { srv.close(function () { resolve(true); }); });
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start) {
  for (let p = start; p <= start + PORT_PROBE_SPAN; p++) {
    /* eslint-disable no-await-in-loop */
    if (await portFree(p)) return p;
    /* eslint-enable no-await-in-loop */
  }
  throw new Error('no free port in range ' + start + '-' + (start + PORT_PROBE_SPAN));
}

// Is something accepting TCP connections on this port? (readiness probe)
function portOpen(port) {
  return new Promise(function (resolve) {
    const sock = new net.Socket();
    let done = false;
    function finish(v) { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(v); }
    sock.setTimeout(1500);
    sock.once('connect', function () { finish(true); });
    sock.once('timeout', function () { finish(false); });
    sock.once('error', function () { finish(false); });
    sock.connect(port, '127.0.0.1');
  });
}

class WhisperServer extends EventEmitter {
  constructor() {
    super();
    this._child = null;
    this._model = null;      // last selected model (kept for UI even when stopped)
    this._port = null;       // actual bound port
    this._basePort = DEFAULT_PORT;
    this._desiredModel = null;
    this._running = false;   // true once TCP-ready
    this._stopping = false;  // an intentional stop() is in progress
    this._crashes = 0;
    this._exited = false;
    this._exitCode = null;
    this._stableTimer = null;
    this._restartTimer = null; // pending auto-restart during backoff (cancellable)
  }

  _clearRestartTimer() {
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
  }

  /**
   * Start the server. If one is already running it is stopped first.
   * @param {string} modelName
   * @param {number} [port]
   * @returns {Promise<{running:boolean, model:string, port:number}>}
   */
  async start(modelName, port) {
    // Cancel any armed backoff restart first: during the backoff window _child is
    // null, so the stop() below would skip and the stale timer would later spawn
    // an orphaned server on the old model/port.
    this._clearRestartTimer();
    if (this._child) await this.stop();
    this._basePort = port || DEFAULT_PORT;
    this._desiredModel = modelName;
    return this._launch(modelName, this._basePort);
  }

  async _launch(modelName, basePort) {
    // Defensive: never leak a previous child if _launch is entered with one live.
    if (this._child) { try { this._child.kill(); } catch (e) { /* ignore */ } this._child = null; }
    const modelPath = models.pathFor(modelName);
    if (!fs.existsSync(modelPath)) {
      const e = new Error('model file not found: ' + modelPath + ' (download it first)');
      log.error('whisper start: ' + e.message);
      throw e;
    }
    const exe = binaries.serverExe();
    if (!fs.existsSync(exe)) {
      const e = new Error('whisper-server missing at ' + exe + ' (run binaries.ensure()/setup)');
      log.error('whisper start: ' + e.message);
      throw e;
    }

    const freePort = await findFreePort(basePort);
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(freePort),
      '-t', String(threadCount()),
    ];

    this._exited = false;
    this._exitCode = null;
    this._stopping = false;
    this._model = modelName;
    this._port = freePort;

    log.info('whisper start: ' + modelName + ' on 127.0.0.1:' + freePort + ' (' + threadCount() + ' threads)');
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this._child = child;

    // Do NOT persist third-party engine output to the disk log by default — it is
    // an ungated channel we don't control. Opt in with SAYSOMETHING_LOG_ENGINE=1 for
    // debugging. Server lifecycle (start/exit/crash) is logged separately below.
    const logEngine = process.env.SAYSOMETHING_LOG_ENGINE === '1';
    const onOut = function (d) {
      if (!logEngine) return;
      const line = String(d).trim();
      if (line) log.debug('[whisper] ' + line);
    };
    if (child.stdout) child.stdout.on('data', onOut);
    if (child.stderr) child.stderr.on('data', onOut);
    child.on('error', (err) => { log.error('whisper spawn error: ' + (err && err.message)); });
    child.on('exit', (code, signal) => this._onExit(code, signal));

    try {
      await this._waitReady(freePort);
    } catch (e) {
      try { child.kill(); } catch (e2) { /* ignore */ }
      this._child = null;
      this._running = false;
      this._emitStatus();
      throw e;
    }

    this._running = true;
    this._emitStatus();
    this._scheduleStableReset();
    return this.status();
  }

  async _waitReady(port) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._exited) {
        throw new Error('whisper-server exited during startup (code ' + this._exitCode + ') — check the model file and logs');
      }
      /* eslint-disable no-await-in-loop */
      if (await portOpen(port)) return;
      await delay(300);
      /* eslint-enable no-await-in-loop */
    }
    throw new Error('whisper-server did not become ready within ' + READY_TIMEOUT_MS + 'ms');
  }

  _scheduleStableReset() {
    if (this._stableTimer) clearTimeout(this._stableTimer);
    const self = this;
    this._stableTimer = setTimeout(function () {
      self._crashes = 0;
      self._stableTimer = null;
    }, STABLE_MS);
    if (this._stableTimer.unref) this._stableTimer.unref();
  }

  _onExit(code, signal) {
    const wasRunning = this._running;
    this._exited = true;
    this._exitCode = code;
    this._running = false;
    this._child = null;
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
    log.warn('whisper-server exited: code=' + code + ' signal=' + signal);
    this._emitStatus();

    if (this._stopping) { this._stopping = false; return; }   // intentional stop
    if (!wasRunning) return; // failed before ready — _waitReady rejects, no retry loop

    this._crashes += 1;
    if (this._crashes > MAX_RAPID_CRASHES) {
      log.error('whisper-server crashed ' + this._crashes + ' times; giving up auto-restart');
      this.emit('status', { running: false, model: this._model, port: null, error: 'whisper crashed repeatedly' });
      return;
    }
    const backoff = 500 * Math.pow(2, this._crashes - 1); // 500, 1000, 2000
    log.warn('whisper-server auto-restart in ' + backoff + 'ms (attempt ' + this._crashes + '/' + MAX_RAPID_CRASHES + ')');
    const self = this;
    this._clearRestartTimer();
    this._restartTimer = setTimeout(function () {
      self._restartTimer = null;
      self._launch(self._desiredModel || self._model, self._basePort)
        .catch(function (e) { log.error('whisper auto-restart failed: ' + (e && e.message)); });
    }, backoff);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  /**
   * Stop the server process (intentional — no auto-restart).
   * @returns {Promise<void>} resolves once the process has exited
   */
  stop() {
    this._clearRestartTimer(); // cancel any armed backoff restart
    const child = this._child;
    if (!child) return Promise.resolve();
    this._stopping = true;
    return new Promise(function (resolve) {
      let settled = false;
      const done = function () { if (settled) return; settled = true; resolve(); };
      child.once('exit', done);
      try { child.kill(); } catch (e) { done(); }
      // Safety net in case the exit event is missed.
      const t = setTimeout(function () { try { child.kill(); } catch (e) {} done(); }, 4000);
      if (t.unref) t.unref();
    });
  }

  /** @returns {{running:boolean, model:(string|null), port:(number|null)}} */
  status() {
    return {
      running: !!this._running,
      model: this._model || null,
      port: this._running ? this._port : null,
    };
  }

  /**
   * Restart with a (possibly new) model on the same base port. Clears the crash
   * counter so a deliberate restart is never mistaken for a crash loop.
   * @param {string} [model]
   * @returns {Promise<{running:boolean, model:string, port:number}>}
   */
  async restart(model) {
    const m = model || this._desiredModel || this._model;
    const p = this._basePort || DEFAULT_PORT;
    this._crashes = 0;
    await this.stop();
    this._desiredModel = m;
    return this._launch(m, p);
  }

  _emitStatus() {
    this.emit('status', this.status());
  }
}

module.exports = new WhisperServer();
