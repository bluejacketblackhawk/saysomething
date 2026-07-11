'use strict';

/**
 * whisper-server /inference client.
 *
 * Sends a WAV buffer to the local whisper HTTP server as multipart/form-data and
 * returns the plain transcript. Uses Node's built-in global `fetch`/`FormData`/
 * `Blob` (zero npm deps).
 *
 * /inference form fields (verified against whisper.cpp v1.9.1 --help flag names,
 * which map 1:1 to snake_case multipart fields the server parses per request):
 *   file            the WAV blob (required) — 16 kHz mono 16-bit PCM
 *   response_format 'json'  -> body is {"text": "..."}
 *   temperature     '0'     -> deterministic greedy decode
 *   language        e.g. 'en' (only sent when provided; must match the model)
 *   prompt          initial prompt = the custom dictionary (only when provided)
 * Because the server accepts prompt/language PER REQUEST, the custom dictionary
 * needs no server restart when it changes.
 *
 * FIFO queue: exactly one request is in flight at a time; calls are served in
 * arrival order. whisper-server holds a single model context behind a mutex, so
 * pipelining buys nothing and only risks timeouts.
 */

const server = require('./server');

// Tail of the FIFO chain. Never rejects (errors are swallowed on the chain so
// later requests still run); each caller gets its own result promise.
let tail = Promise.resolve();

/**
 * @param {Buffer} wavBuffer complete RIFF/WAV (16 kHz mono 16-bit)
 * @param {{prompt?:string, language?:string}} [opts]
 * @returns {Promise<{text:string, ms:number}>}
 */
function transcribe(wavBuffer, opts) {
  const run = function () { return _doTranscribe(wavBuffer, opts || {}); };
  const result = tail.then(run, run); // run regardless of the previous outcome
  tail = result.then(function () {}, function () {}); // keep the chain alive
  return result;
}

async function _doTranscribe(wavBuffer, opts) {
  if (!wavBuffer || typeof wavBuffer.length !== 'number' || wavBuffer.length === 0) {
    throw new Error('transcribe: empty WAV buffer');
  }
  const st = server.status();
  if (!st.running || !st.port) throw new Error('whisper server is not running');

  const url = 'http://127.0.0.1:' + st.port + '/inference';
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (opts.language) form.append('language', String(opts.language));
  if (opts.prompt) form.append('prompt', String(opts.prompt));

  // Bound the request so a wedged (alive-but-unresponsive) server can't freeze the
  // whole FIFO inject chain for undici's ~300 s default. Budget scales with audio
  // length: ~10 s decode headroom per recorded second, floor 20 s.
  const audioSec = Math.max(0, (wavBuffer.length - 44) / 2 / 16000);
  const timeoutMs = Math.max(20000, Math.ceil(audioSec * 10000) + 15000);

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('inference timed out after ' + timeoutMs + 'ms (whisper server unresponsive)');
    }
    throw e;
  }
  const ms = Date.now() - t0;

  if (!res.ok) {
    let extra = '';
    try { extra = (await res.text()).slice(0, 200); } catch (e) { /* ignore */ }
    throw new Error('inference HTTP ' + res.status + (extra ? ': ' + extra : ''));
  }

  const body = await res.text();
  return { text: extractText(body), ms: ms };
}

/**
 * Interim transcription for LIVE partials. Unlike transcribe(), this BYPASSES the
 * FIFO queue and takes an external AbortSignal so the caller (streaming driver)
 * can cancel it the instant the user releases — the authoritative final pass then
 * owns the server. Partials are best-effort: any error/abort just rejects and the
 * caller ignores it. One partial in flight at a time is the caller's contract.
 * @param {Buffer} wavBuffer growing WAV snapshot (16 kHz mono 16-bit)
 * @param {{prompt?:string, language?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<{text:string, ms:number}>}
 */
async function transcribePartial(wavBuffer, opts) {
  opts = opts || {};
  if (!wavBuffer || typeof wavBuffer.length !== 'number' || wavBuffer.length === 0) {
    throw new Error('transcribePartial: empty WAV buffer');
  }
  const st = server.status();
  if (!st.running || !st.port) throw new Error('whisper server is not running');

  const url = 'http://127.0.0.1:' + st.port + '/inference';
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (opts.language) form.append('language', String(opts.language));
  if (opts.prompt) form.append('prompt', String(opts.prompt));

  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', body: form, signal: opts.signal });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error('partial inference HTTP ' + res.status);
  const body = await res.text();
  return { text: extractText(body), ms: ms };
}

// Robust to response_format quirks: parse JSON when the body looks like an
// object (and pull `.text`); otherwise treat the raw body as the transcript.
function extractText(body) {
  const trimmed = (body || '').trim();
  if (trimmed.charAt(0) === '{') {
    try {
      const j = JSON.parse(trimmed);
      if (j && typeof j.text === 'string') return j.text;
    } catch (e) { /* fall through to raw */ }
  }
  return trimmed;
}

module.exports = {
  transcribe: transcribe,
  transcribePartial: transcribePartial,
};
