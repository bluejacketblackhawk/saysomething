'use strict';

/*
 * Live-partial driver test for src/main/whisper/streaming.js. Plain Node.
 *
 * streaming.js requires ../audio-session and ./client and calls their methods by
 * property at call time, so we monkeypatch those cached module objects with fakes
 * BEFORE requiring streaming — no mic, no server. Asserts:
 *   A) it emits partials via onPartial and never runs >1 interim at once
 *   B) stop() aborts the interim that is genuinely in flight, and halts delivery
 *   C) a stale stop() for a different session is ignored
 *
 * Exit code: 0 on success, 1 on any failed assertion.
 */

const audioSession = require('../src/main/audio-session');
const client = require('../src/main/whisper/client');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok  - ' + msg); }
  else { failures++; console.error('  FAIL- ' + msg); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// --- fakes ---------------------------------------------------------------
let sampleCount;
function fakeSnapshot() {
  sampleCount += 16000; // +1 s of audio each call so the throttle always passes
  // Driver throttles on totalSamples; mirror the real snapshot() return shape.
  return { wav: Buffer.alloc(44 + sampleCount * 2), samples: sampleCount, totalSamples: sampleCount };
}

let resolveDelay = 250; // how long a fake interim "runs" (tunable per phase)
let inFlight = 0;
let maxConcurrent = 0;
let calls = 0;
let abortedCount = 0;
function fakeTranscribePartial(wav, opts) {
  calls++;
  inFlight++;
  if (inFlight > maxConcurrent) maxConcurrent = inFlight;
  const signal = opts && opts.signal;
  return new Promise(function (resolve, reject) {
    const to = setTimeout(function () { inFlight--; resolve({ text: 'hello world', ms: 5 }); }, resolveDelay);
    if (signal) {
      signal.addEventListener('abort', function () {
        clearTimeout(to); inFlight--; abortedCount++; reject(new Error('aborted'));
      }, { once: true });
    }
  });
}

audioSession.snapshot = fakeSnapshot;
client.transcribePartial = fakeTranscribePartial;

const streaming = require('../src/main/whisper/streaming');

let partials = 0;
let lastText = '';
function onPartial(sessionId, text) { partials++; lastText = text; }

async function main() {
  // ---- Phase A: throttle + one-in-flight + delivery (fast resolves) ----
  sampleCount = 16000; resolveDelay = 250;
  streaming.start({ sessionId: 7, prompt: '', language: 'en', onPartial: onPartial });
  await wait(2600); // a few 900 ms ticks
  check(calls >= 2, 'A: driver issued multiple interim passes (' + calls + ')');
  check(partials >= 2, 'A: onPartial delivered multiple partials (' + partials + ')');
  check(lastText === 'hello world', 'A: partial text is the faked transcript');
  check(maxConcurrent === 1, 'A: never more than ONE interim in flight (was ' + maxConcurrent + ')');
  streaming.stop(7);

  // ---- Phase B: stop() aborts an interim that is genuinely in flight ----
  sampleCount = 16000; resolveDelay = 3000; // interim runs long
  abortedCount = 0; calls = 0;
  const partialsBefore = partials;
  streaming.start({ sessionId: 8, prompt: '', language: 'en', onPartial: onPartial });
  await wait(1200);                 // first tick (~900 ms) started a 3 s interim → in flight now
  check(inFlight === 1, 'B: an interim is in flight before stop');
  streaming.stop(8);
  check(abortedCount === 1, 'B: stop() aborted the in-flight interim');
  await wait(1200);
  check(partials === partialsBefore, 'B: no partials delivered after stop()');

  // ---- Phase C: a stale stop() for a different session is ignored ----
  sampleCount = 16000; resolveDelay = 250;
  const partialsBeforeC = partials;
  streaming.start({ sessionId: 9, prompt: '', language: 'en', onPartial: onPartial });
  streaming.stop(999);              // wrong id — must NOT tear down session 9
  await wait(1300);
  check(partials > partialsBeforeC, 'C: stale stop(wrongId) did not kill the active session');
  streaming.stop(9);

  if (failures > 0) {
    console.error('\nstreaming-test: ' + failures + ' assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nstreaming-test: all assertions passed');
  process.exit(0);
}

main().catch(function (err) {
  console.error('streaming-test: unexpected error', err);
  process.exit(1);
});
