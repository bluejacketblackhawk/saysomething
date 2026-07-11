'use strict';

/*
 * Audio session manager (main process) — owned by agent B (audio).
 *
 * Owns the main<->overlay audio IPC lifecycle and the assembly of buffered
 * PCM16 chunks into a complete 16 kHz / 16-bit / mono WAV (correct RIFF header).
 *
 * API (per docs/CONTRACTS.md):
 *   begin({sessionId, deviceId, preRollMs, warm, chime})  -> sends `audio:start`
 *   collect(sessionId, chunk)                             -> buffer one PCM16 chunk
 *   finish(sessionId): Promise<Buffer>                    -> sends `audio:stop`, resolves WAV
 *   abort(sessionId)                                      -> sends `audio:abort`, discards
 *
 * Wiring note for the integrator: this module owns the OUTGOING audio channels
 * to the overlay (audio:start/stop/abort) — call begin/finish/abort and do NOT
 * send those channels yourself. The INCOMING renderer chunks (audio:chunk) must
 * be routed here via collect(sessionId, buf). It tolerates chunks that arrive
 * briefly after finish() was called (grace window below).
 */

const ipc = require('./ipc');
const log = require('./log');

// finish() grace tuning: after `audio:stop`, keep accepting trailing in-flight
// chunks until the stream has been quiet for QUIET_MS, capped at MAX_GRACE.
const QUIET_MS = 100;
const MAX_GRACE = 500;
const POLL_MS = 25;

const SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

/** @type {Map<number, {chunks: Buffer[], lastChunkAt: number, done: boolean}>} */
const sessions = new Map();

/**
 * Resolve the overlay WebContents lazily (avoids load-order / circular issues
 * and keeps this module loadable in plain node for tests).
 * @returns {import('electron').WebContents|null}
 */
function overlayWC() {
  try {
    const windows = require('./windows');
    return (windows && typeof windows.getOverlayWC === 'function') ? windows.getOverlayWC() : null;
  } catch (e) {
    return null;
  }
}

function sendToOverlay(channel, payload) {
  const wc = overlayWC();
  if (!wc) {
    log.debug('audio-session: no overlay web contents for ' + channel);
    return;
  }
  try { wc.send(channel, payload); } catch (e) { log.error('audio-session: send failed ' + channel, e); }
}

/**
 * Normalize an incoming chunk (ArrayBuffer | TypedArray | Buffer) to a Buffer.
 * The bytes are little-endian Int16 PCM; we treat them opaquely here.
 * @param {ArrayBuffer|ArrayBufferView|Buffer} chunk
 * @returns {Buffer}
 */
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.alloc(0);
}

/**
 * Build a canonical PCM WAV from raw little-endian PCM16 mono data.
 * @param {Buffer[]} pcmBuffers
 * @returns {Buffer}
 */
function buildWav(pcmBuffers) {
  let dataSize = 0;
  for (let i = 0; i < pcmBuffers.length; i++) dataSize += pcmBuffers[i].length;

  const byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);      // ChunkSize
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20);                 // AudioFormat = PCM
  header.writeUInt16LE(NUM_CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);          // Subchunk2Size

  return Buffer.concat([header].concat(pcmBuffers), 44 + dataSize);
}

/**
 * Begin a capture session and tell the overlay to start capturing.
 * @param {{sessionId:number, deviceId?:string, preRollMs?:number, warm?:boolean, chime?:boolean}} opts
 */
function begin(opts) {
  opts = opts || {};
  const sessionId = opts.sessionId;
  if (sessionId == null) { log.error('audio-session.begin: missing sessionId'); return; }

  sessions.set(sessionId, { chunks: [], lastChunkAt: Date.now(), done: false });

  sendToOverlay(ipc.AUDIO_START, {
    sessionId: sessionId,
    deviceId: opts.deviceId || 'default',
    preRollMs: (typeof opts.preRollMs === 'number') ? opts.preRollMs : 0,
    warm: !!opts.warm,
    chime: !!opts.chime,
  });
}

/**
 * Buffer one PCM16 chunk for a session. Late chunks for unknown/finished
 * sessions are ignored gracefully.
 * @param {number} sessionId
 * @param {ArrayBuffer|ArrayBufferView|Buffer} chunk
 */
function collect(sessionId, chunk) {
  const s = sessions.get(sessionId);
  if (!s || s.done) return;
  const buf = toBuffer(chunk);
  if (buf.length > 0) {
    s.chunks.push(buf);
    s.lastChunkAt = Date.now();
  }
}

/**
 * Finalize a session: tell the overlay to stop, wait out any trailing in-flight
 * chunks, then resolve the assembled WAV. Always resolves (never rejects).
 * @param {number} sessionId
 * @returns {Promise<Buffer>} 16k / 16-bit / mono WAV
 */
function finish(sessionId) {
  const s = sessions.get(sessionId);
  sendToOverlay(ipc.AUDIO_STOP, { sessionId: sessionId });

  if (!s) return Promise.resolve(buildWav([]));

  return new Promise(function (resolve) {
    const started = Date.now();
    function check() {
      const idle = Date.now() - s.lastChunkAt;
      const waited = Date.now() - started;
      if (idle >= QUIET_MS || waited >= MAX_GRACE) {
        s.done = true;
        const wav = buildWav(s.chunks);
        sessions.delete(sessionId);
        resolve(wav);
      } else {
        setTimeout(check, POLL_MS);
      }
    }
    setTimeout(check, POLL_MS);
  });
}

/**
 * Snapshot the audio captured SO FAR for a live (still-recording) session as a
 * complete WAV, WITHOUT ending the session. Used by the streaming interim driver.
 * Returns null for an unknown/finished session or when nothing has been captured
 * yet. `samples` lets the caller throttle on "enough new audio since last pass".
 *
 * `maxSamples` (optional) caps the WAV to the TRAILING maxSamples of audio so an
 * interim decode's cost — and thus how long an un-cancellable in-flight decode
 * can hold the single-context server — stays bounded regardless of dictation
 * length. Under the cap, the full buffer is returned (unchanged behaviour).
 *
 * `samples` is the count in the returned WAV (possibly capped); `totalSamples` is
 * the full captured length. Callers throttle on `totalSamples` (fresh audio keeps
 * arriving) so a capped window doesn't freeze the "enough new audio" gate.
 * @param {number} sessionId
 * @param {number} [maxSamples]
 * @returns {{wav: Buffer, samples: number, totalSamples: number}|null}
 */
function snapshot(sessionId, maxSamples) {
  const s = sessions.get(sessionId);
  if (!s || s.done) return null;
  let dataSize = 0;
  for (let i = 0; i < s.chunks.length; i++) dataSize += s.chunks[i].length;
  if (dataSize === 0) return null;
  const totalSamples = Math.floor(dataSize / 2);

  // buildWav snapshots the current chunk contents synchronously, so a WAV built
  // here is stable even as the live chunks array keeps growing during transcribe.
  if (maxSamples && dataSize > maxSamples * 2) {
    const maxBytes = maxSamples * 2; // even (whole 16-bit samples)
    const all = Buffer.concat(s.chunks, dataSize);
    const tail = all.subarray(dataSize - maxBytes); // trailing window only
    return { wav: buildWav([tail]), samples: maxSamples, totalSamples: totalSamples };
  }
  return { wav: buildWav(s.chunks), samples: totalSamples, totalSamples: totalSamples };
}

/**
 * Discard a session's buffered audio and tell the overlay to cancel.
 * @param {number} sessionId
 */
function abort(sessionId) {
  const s = sessions.get(sessionId);
  if (s) { s.done = true; sessions.delete(sessionId); }
  sendToOverlay(ipc.AUDIO_ABORT, { sessionId: sessionId });
}

module.exports = {
  begin: begin,
  collect: collect,
  finish: finish,
  snapshot: snapshot,
  abort: abort,
  // Exported for unit tests (test/wav-test.js).
  buildWav: buildWav,
};
