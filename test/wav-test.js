'use strict';

/*
 * WAV assembly test — owned by agent B (audio). Plain Node, no framework.
 *
 * Feeds synthetic sine-wave PCM16 chunks into src/main/audio-session.js via
 * collect()/finish() and asserts the resulting buffer is a valid 16 kHz / 16-bit
 * / mono WAV with the correct RIFF header, byte layout, and sample count.
 * Also exercises buildWav() directly, the ArrayBuffer/Buffer/TypedArray input
 * paths of collect(), late-chunk tolerance, and abort().
 *
 * Exit code: 0 on success, 1 on any failed assertion.
 */

const audio = require('../src/main/audio-session');

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  ok  - ' + msg);
  } else {
    failures++;
    console.error('  FAIL- ' + msg);
  }
}

// Build one ~100 ms chunk (1600 samples @ 16 kHz) of a sine wave as PCM16 LE.
const SR = 16000;
const CHUNK_SAMPLES = 1600;
function makeSineChunk(freq, startSample) {
  const arr = new Int16Array(CHUNK_SAMPLES);
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    const t = (startSample + i) / SR;
    arr[i] = Math.round(Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * freq * t))) * 0x7fff);
  }
  return arr;
}

function readAscii(buf, off, len) { return buf.toString('ascii', off, off + len); }

function assertHeader(wav, expectedSamples, label) {
  const dataSize = expectedSamples * 2;
  check(wav.length === 44 + dataSize, label + ': total length = 44 + dataSize (' + (44 + dataSize) + ')');
  check(readAscii(wav, 0, 4) === 'RIFF', label + ': "RIFF" magic');
  check(wav.readUInt32LE(4) === 36 + dataSize, label + ': RIFF chunk size = 36 + dataSize');
  check(readAscii(wav, 8, 4) === 'WAVE', label + ': "WAVE" format');
  check(readAscii(wav, 12, 4) === 'fmt ', label + ': "fmt " subchunk');
  check(wav.readUInt32LE(16) === 16, label + ': fmt chunk size = 16 (PCM)');
  check(wav.readUInt16LE(20) === 1, label + ': audioFormat = 1 (PCM)');
  check(wav.readUInt16LE(22) === 1, label + ': numChannels = 1 (mono)');
  check(wav.readUInt32LE(24) === 16000, label + ': sampleRate = 16000');
  check(wav.readUInt32LE(28) === 32000, label + ': byteRate = 32000');
  check(wav.readUInt16LE(32) === 2, label + ': blockAlign = 2');
  check(wav.readUInt16LE(34) === 16, label + ': bitsPerSample = 16');
  check(readAscii(wav, 36, 4) === 'data', label + ': "data" subchunk');
  check(wav.readUInt32LE(40) === dataSize, label + ': data size = ' + dataSize);
  check((wav.length - 44) / 2 === expectedSamples, label + ': sample count = ' + expectedSamples);
}

async function main() {
  // ---- 1) buildWav() directly, empty (silence) ----
  const empty = audio.buildWav([]);
  assertHeader(empty, 0, 'empty');

  // ---- 2) full session via begin/collect/finish with mixed input types ----
  const NUM = 5;                       // 5 chunks -> 8000 samples -> 0.5 s
  const total = NUM * CHUNK_SAMPLES;
  const sessionId = 1;
  audio.begin({ sessionId: sessionId, deviceId: 'default', preRollMs: 800, warm: true, chime: false });

  const chunks = [];
  for (let c = 0; c < NUM; c++) {
    const sine = makeSineChunk(440, c * CHUNK_SAMPLES);
    chunks.push(sine);
    if (c === 0) {
      // exact-sized ArrayBuffer (production path from IPC)
      audio.collect(sessionId, sine.buffer);
    } else if (c === 1) {
      // Node Buffer path
      audio.collect(sessionId, Buffer.from(sine.buffer.slice(0)));
    } else {
      // TypedArray (view) path
      audio.collect(sessionId, sine);
    }
  }

  const wav = await audio.finish(sessionId);
  assertHeader(wav, total, 'session');

  // Verify PCM payload byte-for-byte matches what we fed (LE Int16 order).
  let sampleMismatch = 0;
  for (let c = 0; c < NUM; c++) {
    for (let i = 0; i < CHUNK_SAMPLES; i++) {
      const got = wav.readInt16LE(44 + (c * CHUNK_SAMPLES + i) * 2);
      if (got !== chunks[c][i]) sampleMismatch++;
    }
  }
  check(sampleMismatch === 0, 'PCM payload matches fed samples (LE Int16, in order)');

  // ---- 2b) snapshot() returns a valid WAV of audio-so-far, mid-session ----
  const sid3 = 3;
  audio.begin({ sessionId: sid3, warm: true, chime: false });
  check(audio.snapshot(sid3) === null, 'snapshot: null before any audio');
  audio.collect(sid3, makeSineChunk(440, 0));                 // 1 chunk = 1600 samples
  let snap1 = audio.snapshot(sid3);
  check(snap1 !== null, 'snapshot: non-null after first chunk');
  check(snap1.samples === CHUNK_SAMPLES, 'snapshot: samples = 1600 after one chunk');
  assertHeader(snap1.wav, CHUNK_SAMPLES, 'snapshot-1');
  const second = makeSineChunk(440, CHUNK_SAMPLES);
  audio.collect(sid3, second);                                // 2nd chunk
  let snap2 = audio.snapshot(sid3);
  check(snap2.samples === 2 * CHUNK_SAMPLES, 'snapshot: grows with more audio (3200 samples)');
  check(snap2.totalSamples === 2 * CHUNK_SAMPLES, 'snapshot: totalSamples = full capture');
  assertHeader(snap2.wav, 2 * CHUNK_SAMPLES, 'snapshot-2');

  // maxSamples caps the WAV to the TRAILING window; totalSamples stays full.
  let capped = audio.snapshot(sid3, CHUNK_SAMPLES);           // cap 1600 of 3200
  check(capped.samples === CHUNK_SAMPLES, 'snapshot(cap): wav capped to trailing window (1600)');
  check(capped.totalSamples === 2 * CHUNK_SAMPLES, 'snapshot(cap): totalSamples still full (3200)');
  assertHeader(capped.wav, CHUNK_SAMPLES, 'snapshot-capped');
  let mism = 0;
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    if (capped.wav.readInt16LE(44 + i * 2) !== second[i]) mism++;
  }
  check(mism === 0, 'snapshot(cap): trailing window holds the MOST-RECENT samples');

  await audio.finish(sid3);
  check(audio.snapshot(sid3) === null, 'snapshot: null after finish (session gone)');

  // ---- 3) late chunk after finish is tolerated (no throw, ignored) ----
  let threw = false;
  try { audio.collect(sessionId, makeSineChunk(440, 0).buffer); } catch (e) { threw = true; }
  check(!threw, 'collect() after finish does not throw (late-chunk tolerance)');

  // ---- 4) abort discards buffered audio ----
  const sid2 = 2;
  audio.begin({ sessionId: sid2, warm: false, chime: false });
  audio.collect(sid2, makeSineChunk(660, 0).buffer);
  audio.abort(sid2);
  const afterAbort = await audio.finish(sid2); // unknown session -> empty WAV
  assertHeader(afterAbort, 0, 'post-abort');

  if (failures > 0) {
    console.error('\nwav-test: ' + failures + ' assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nwav-test: all assertions passed');
  process.exit(0);
}

main().catch(function (err) {
  console.error('wav-test: unexpected error', err);
  process.exit(1);
});
