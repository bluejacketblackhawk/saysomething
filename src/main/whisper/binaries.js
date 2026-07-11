'use strict';

/**
 * Ensure the whisper.cpp runtime binaries are unpacked into BIN_WHISPER.
 *
 * Source of truth is the cached release zip at
 * `third_party/whisper-bin-x64-v1.9.1.zip` (downloaded from GitHub only if the
 * cache is missing). Extraction uses Windows' bundled bsdtar
 * (`C:\Windows\System32\tar.exe`) — NOT Git Bash's GNU tar, which cannot read
 * zips. The zip stores everything under a `Release/` prefix, which we flatten
 * with `--strip-components=1`.
 *
 * We keep only what whisper-server/whisper-cli need: the two exes plus the
 * `ggml*.dll` and `whisper.dll` runtime libraries. SDL2.dll (audio-capture demos
 * only) and parakeet.dll are intentionally left out — verified: whisper-server
 * runs without SDL2.dll present.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { spawn } = require('child_process');
const {
  BIN_WHISPER,
  THIRD_PARTY,
  WHISPER_ZIP_CACHE,
  WHISPER_ZIP_URL,
  TAR,
} = require('../config');
const HASHES = require('./hashes');

function sha256File(p) {
  return new Promise(function (resolve, reject) {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', function (d) { h.update(d); });
    s.on('end', function () { resolve(h.digest('hex')); });
  });
}

function serverExe() { return path.join(BIN_WHISPER, 'whisper-server.exe'); }

/** True when the binaries appear to be fully unpacked. */
function isReady() {
  return fs.existsSync(serverExe())
    && fs.existsSync(path.join(BIN_WHISPER, 'whisper-cli.exe'))
    && fs.existsSync(path.join(BIN_WHISPER, 'whisper.dll'));
}

// Run bsdtar, rejecting on non-zero exit. Captures stdout (for listing) too.
function runTar(args, capture) {
  return new Promise(function (resolve, reject) {
    const child = spawn(TAR, args, { windowsHide: true });
    let out = '';
    let err = '';
    if (child.stdout) child.stdout.on('data', function (d) { out += d; });
    if (child.stderr) child.stderr.on('data', function (d) { err += d; });
    child.on('error', reject);
    child.on('exit', function (code) {
      if (code === 0) resolve(capture ? out : undefined);
      else reject(new Error('tar exited ' + code + (err.trim() ? ': ' + err.trim() : '')));
    });
  });
}

// Inspect the archive and return the member paths we want to extract.
async function selectMembers(zipPath) {
  const listing = await runTar(['-tf', zipPath], true);
  const lines = String(listing).split(/\r?\n/);
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i].trim();
    if (!entry) continue;
    const base = entry.split('/').pop().toLowerCase();
    if (base === 'whisper-server.exe' || base === 'whisper-cli.exe') {
      keep.push(entry);
    } else if (/\.dll$/.test(base) && (base.indexOf('ggml') === 0 || base === 'whisper.dll')) {
      keep.push(entry); // ggml*.dll + whisper.dll; excludes SDL2.dll, parakeet.dll
    }
  }
  const hasServer = keep.some(function (e) { return e.toLowerCase().endsWith('whisper-server.exe'); });
  if (!hasServer) throw new Error('whisper-server.exe not found inside ' + zipPath);
  return keep;
}

// Minimal streaming file download with .part -> rename and size verification.
async function downloadFile(url, dest) {
  const part = dest + '.part';
  try { await fsp.unlink(part); } catch (e) { /* ignore */ }
  const controller = new AbortController();
  const ws = fs.createWriteStream(part);
  let bytes = 0;
  // Persistent write-stream error handler (see models.js): a disk/IO error while
  // awaiting the next network chunk would otherwise be an unhandled 'error' event.
  let streamErr = null;
  ws.on('error', function (e) {
    streamErr = e;
    try { controller.abort(); } catch (e2) { /* ignore */ }
  });
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status + ' for ' + url);
    const total = Number(res.headers.get('content-length')) || 0;
    for await (const chunk of res.body) {
      if (streamErr) throw streamErr;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      bytes += buf.length;
      if (!ws.write(buf)) await once(ws, 'drain');
    }
    await new Promise(function (resolve, reject) {
      ws.end(function (err) { if (err) reject(err); else resolve(); });
    });
    if (total && bytes !== total) {
      throw new Error('zip size mismatch: got ' + bytes + ' expected ' + total + ' bytes');
    }
    await fsp.rename(part, dest);
  } catch (e) {
    try { ws.destroy(); } catch (e2) { /* ignore */ }
    try { await fsp.unlink(part); } catch (e2) { /* ignore */ }
    if (streamErr) throw streamErr;
    throw e;
  }
}

/**
 * Ensure bin/whisper is populated. Idempotent: returns immediately when the
 * binaries are already present. Otherwise unpacks the cached zip (downloading
 * it from GitHub first if the cache is missing).
 * @returns {Promise<void>}
 */
async function ensure() {
  if (isReady()) return;

  await fsp.mkdir(BIN_WHISPER, { recursive: true });

  const zipPath = path.join(THIRD_PARTY, WHISPER_ZIP_CACHE);
  if (!fs.existsSync(zipPath)) {
    await fsp.mkdir(THIRD_PARTY, { recursive: true });
    // Network access: GitHub release download. Callers surface this to the user.
    await downloadFile(WHISPER_ZIP_URL, zipPath);
  }

  // Integrity: the native binaries are the highest-value supply-chain target, so
  // the zip (cached or freshly downloaded) must match its pinned digest.
  const expectedZip = HASHES[WHISPER_ZIP_CACHE];
  if (expectedZip) {
    const got = await sha256File(zipPath);
    if (got !== expectedZip) {
      throw new Error('whisper binaries zip checksum mismatch: got ' + got + ' expected ' + expectedZip + ' (' + zipPath + ')');
    }
  }

  const members = await selectMembers(zipPath);
  await runTar(['-xf', zipPath, '-C', BIN_WHISPER, '--strip-components=1'].concat(members), false);

  if (!isReady()) {
    throw new Error('whisper binaries still missing after extracting ' + zipPath);
  }
}

module.exports = {
  ensure: ensure,
  isReady: isReady,
};
