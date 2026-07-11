'use strict';

/**
 * Whisper ggml model catalog + local presence + downloader.
 *
 * Models are the standard whisper.cpp ggml weights, fetched from Hugging Face
 * (`MODEL_BASE_URL` + `ggml-<name>.bin`). Downloads stream to a `.part` file and
 * are renamed into place only after the byte count matches the server's
 * Content-Length, so a partial/aborted download never masquerades as complete.
 *
 * Zero npm deps: uses Node's built-in global `fetch` and `fs`.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { MODELS_DIR, MODEL_BASE_URL, BUNDLED_MODELS_DIR } = require('../config');
const HASHES = require('./hashes');

/** SHA-256 of a file, streamed. @param {string} p @returns {Promise<string>} */
function sha256File(p) {
  return new Promise(function (resolve, reject) {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    s.on('data', function (d) { h.update(d); });
    s.on('end', function () { resolve(h.digest('hex')); });
  });
}

// sizeMB is for display only (verification uses the live Content-Length).
// lang: 'en' = English-only model, 'multi' = multilingual.
// note: plain-English "which should I pick" guidance for the Model tab.
// recommended: the first-day default (English, best balance on a typical CPU).
const CATALOG = [
  { name: 'tiny.en', sizeMB: 75, lang: 'en', note: 'Fastest, roughly accurate' },
  { name: 'base.en', sizeMB: 142, lang: 'en', note: 'Fast, decent accuracy' },
  { name: 'small.en', sizeMB: 466, lang: 'en', note: 'Best balance for English', recommended: true },
  { name: 'medium.en', sizeMB: 1536, lang: 'en', note: 'More accurate, slower' },
  { name: 'large-v3-turbo', sizeMB: 1620, lang: 'multi', note: 'Most accurate, largest' },
  { name: 'tiny', sizeMB: 75, lang: 'multi', note: 'Fastest, many languages' },
  { name: 'base', sizeMB: 142, lang: 'multi', note: 'Fast, many languages' },
  { name: 'small', sizeMB: 466, lang: 'multi', note: 'Balanced, many languages' },
  { name: 'medium', sizeMB: 1536, lang: 'multi', note: 'Accurate, many languages' },
];

// name -> AbortController for in-flight downloads (enables cancel()).
const inflight = new Map();

/** @returns {Array<{name:string, sizeMB:number, lang:string, note:string, recommended:boolean}>} */
function catalog() {
  return CATALOG.map(function (m) {
    return { name: m.name, sizeMB: m.sizeMB, lang: m.lang, note: m.note || '', recommended: !!m.recommended };
  });
}

function fileName(name) { return 'ggml-' + name + '.bin'; }

/**
 * Absolute path to a model's ggml .bin. Prefers a user-downloaded copy in
 * MODELS_DIR; falls back to a read-only bundled copy shipped in the package; else
 * returns the MODELS_DIR path (the download target).
 * @param {string} name @returns {string}
 */
function pathFor(name) {
  const local = path.join(MODELS_DIR, fileName(name));
  if (fs.existsSync(local)) return local;
  if (BUNDLED_MODELS_DIR) {
    const bundled = path.join(BUNDLED_MODELS_DIR, fileName(name));
    if (fs.existsSync(bundled)) return bundled;
  }
  return local;
}

function namesIn(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return out; }
  for (let i = 0; i < entries.length; i++) {
    const m = /^ggml-(.+)\.bin$/.exec(entries[i]);
    if (m) out.push(m[1]);
  }
  return out;
}

/** @returns {string[]} model names present locally (downloaded OR bundled) */
function listLocal() {
  const seen = Object.create(null);
  const out = [];
  const all = namesIn(MODELS_DIR).concat(BUNDLED_MODELS_DIR ? namesIn(BUNDLED_MODELS_DIR) : []);
  for (let i = 0; i < all.length; i++) {
    if (!seen[all[i]]) { seen[all[i]] = true; out.push(all[i]); }
  }
  return out;
}

/**
 * Download a model to MODELS_DIR with progress. Streams to `<final>.part`,
 * verifies the byte count against Content-Length, then renames into place.
 * @param {string} name catalog model name
 * @param {(p:{pct:number, bytes:number, total:number}) => void} [onProgress]
 * @returns {Promise<void>}
 */
async function download(name, onProgress) {
  if (!name || typeof name !== 'string') throw new Error('model name required');
  // Only known catalog names — `name` builds a filesystem path and a fetch URL,
  // so an arbitrary value ('../x', a full URL, etc.) must never reach them.
  if (!CATALOG.some(function (m) { return m.name === name; })) {
    throw new Error('unknown model: ' + name);
  }
  const url = MODEL_BASE_URL + 'ggml-' + name + '.bin';
  const finalPath = pathFor(name);
  const partPath = finalPath + '.part';

  await fsp.mkdir(MODELS_DIR, { recursive: true });
  try { await fsp.unlink(partPath); } catch (e) { /* no stale part */ }

  const controller = new AbortController();
  inflight.set(name, controller);

  const ws = fs.createWriteStream(partPath);
  let bytes = 0;
  // Persistent write-stream error handler: without it, a disk/IO error emitted
  // while the loop is awaiting the next network chunk (not in a drain wait) is an
  // unhandled 'error' event that would crash the process. Capture it and abort.
  let streamErr = null;
  ws.on('error', function (e) {
    streamErr = e;
    try { controller.abort(); } catch (e2) { /* ignore */ }
  });
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error('download failed: HTTP ' + res.status + ' ' + res.statusText + ' for ' + url);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    let lastPct = -1;

    for await (const chunk of res.body) {
      if (streamErr) throw streamErr;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      bytes += buf.length;
      if (!ws.write(buf)) await once(ws, 'drain');
      if (onProgress) {
        if (total) {
          const pct = Math.floor((bytes / total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress({ pct: pct, bytes: bytes, total: total }); }
        } else {
          onProgress({ pct: 0, bytes: bytes, total: 0 });
        }
      }
    }

    await new Promise(function (resolve, reject) {
      ws.end(function (err) { if (err) reject(err); else resolve(); });
    });

    if (total && bytes !== total) {
      throw new Error('size mismatch for ' + name + ': got ' + bytes + ' expected ' + total + ' bytes');
    }
    // Integrity: if we have a pinned digest for this model, the bytes must match.
    const expected = HASHES[name];
    if (expected) {
      const got = await sha256File(partPath);
      if (got !== expected) {
        throw new Error('checksum mismatch for ' + name + ': got ' + got + ' expected ' + expected);
      }
    }
    await fsp.rename(partPath, finalPath);
    if (onProgress && total) onProgress({ pct: 100, bytes: total, total: total });
  } catch (e) {
    try { ws.destroy(); } catch (e2) { /* ignore */ }
    try { await fsp.unlink(partPath); } catch (e2) { /* ignore */ }
    // A real write error takes precedence over the AbortError it triggers, so a
    // disk failure is never misreported as a user cancellation.
    if (streamErr) throw streamErr;
    if (controller.signal.aborted || (e && e.name === 'AbortError')) {
      const err = new Error('download cancelled: ' + name);
      err.cancelled = true;
      throw err;
    }
    throw e;
  } finally {
    inflight.delete(name);
  }
}

/** Abort an in-flight download for `name` (no-op if none). @param {string} name */
function cancel(name) {
  const c = inflight.get(name);
  if (c) c.abort();
}

module.exports = {
  catalog: catalog,
  listLocal: listLocal,
  download: download,
  cancel: cancel,
  pathFor: pathFor,
};
