'use strict';

/**
 * Plain-node unit tests for the PURE latched auto-stop detector in
 * src/renderer/overlay/vad.js (energy-based VAD).
 *
 * Run: `node test/vad-test.js` — exits non-zero on any failing block.
 * No framework, no deps. Mirrors the style of test/formatter-test.js /
 * test/rewrite-test.js.
 *
 * This machine has no scriptable mic, so we feed synthetic RMS-level sequences
 * (silence -> speech -> mid-sentence pause -> speech -> long trailing silence)
 * through the detector and assert it fires exactly ONCE, at the right point,
 * never during the mid-sentence pause, and never before the first speech.
 */

const assert = require('assert');
const vadLib = require('../src/renderer/overlay/vad');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; return; }
  failed++;
  console.error('FAIL: ' + label);
}
function eq(actual, expected, label) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error('FAIL: ' + label);
  console.error('  expected: ' + JSON.stringify(expected));
  console.error('  actual:   ' + JSON.stringify(actual));
}

// ---------------------------------------------------------------------------
// harness: drive N samples of a constant level at a fixed cadence, recording the
// sample index at which the detector first fires (or -1 if it never does).
// ---------------------------------------------------------------------------

const DT = 1000 / 30;        // ~33.3 ms per level (matches the worklet cadence)
const NOISE = 0.004;         // ambient room noise
const SPEECH = 0.06;         // speaking energy (well above threshold)

function run(segments, opts) {
  const v = vadLib.createVad(opts || { silenceMs: 2000 });
  let fires = 0;
  let firstFireMs = -1;
  let firedDuring = {};
  let elapsed = 0;
  let idx = 0;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const n = Math.round(seg.ms / DT);
    for (let i = 0; i < n; i++) {
      const r = v.push(seg.level, DT);
      if (r.fire) {
        fires++;
        if (firstFireMs < 0) firstFireMs = elapsed;
        firedDuring[seg.tag || s] = (firedDuring[seg.tag || s] || 0) + 1;
      }
      elapsed += DT;
      idx++;
    }
  }
  return { fires: fires, firstFireMs: firstFireMs, firedDuring: firedDuring, total: idx };
}

// ---------------------------------------------------------------------------
// 1. canonical sequence: silence -> speech -> short pause -> speech -> long silence
// ---------------------------------------------------------------------------
{
  const seq = [
    { tag: 'lead-sil', level: NOISE,  ms: 500 },   // calibration + lead-in silence
    { tag: 'speech-1', level: SPEECH, ms: 1500 },  // first utterance
    { tag: 'pause',    level: NOISE,  ms: 800 },    // mid-sentence pause (< silenceMs)
    { tag: 'speech-2', level: SPEECH, ms: 1500 },  // second utterance
    { tag: 'trail-sil', level: NOISE, ms: 3000 },   // trailing silence (> silenceMs)
  ];
  const res = run(seq, { silenceMs: 2000 });

  eq(res.fires, 1, 'canonical: fires exactly once');
  ok(!res.firedDuring['pause'], 'canonical: never fires during the mid-sentence pause');
  ok(!res.firedDuring['lead-sil'], 'canonical: never fires during lead-in silence (before speech)');
  ok(!res.firedDuring['speech-1'] && !res.firedDuring['speech-2'], 'canonical: never fires during speech');
  ok(res.firedDuring['trail-sil'] === 1, 'canonical: fires during the trailing silence');

  // The fire should land ~2000 ms into the trailing silence. Trailing silence
  // begins at 500+1500+800+1500 = 4300 ms, so expect a fire near 6300 ms.
  const expected = 4300 + 2000;
  ok(Math.abs(res.firstFireMs - expected) <= 3 * DT,
     'canonical: fires ~silenceMs into the trailing silence (got ' + Math.round(res.firstFireMs) + 'ms, want ~' + expected + 'ms)');
}

// ---------------------------------------------------------------------------
// 2. never fires before first speech: pure silence for a long time
// ---------------------------------------------------------------------------
{
  const seq = [{ tag: 'sil', level: NOISE, ms: 10000 }];
  const res = run(seq, { silenceMs: 2000 });
  eq(res.fires, 0, 'no-speech: never fires when the user never spoke');
}

// ---------------------------------------------------------------------------
// 3. speech that never stops: never auto-stops
// ---------------------------------------------------------------------------
{
  const seq = [
    { tag: 'sil', level: NOISE, ms: 400 },
    { tag: 'speech', level: SPEECH, ms: 8000 },
  ];
  const res = run(seq, { silenceMs: 2000 });
  eq(res.fires, 0, 'nonstop-speech: never fires while speech continues');
}

// ---------------------------------------------------------------------------
// 4. several sub-threshold pauses that each reset the accumulator
// ---------------------------------------------------------------------------
{
  const seq = [
    { tag: 'sil', level: NOISE, ms: 400 },
    { tag: 's', level: SPEECH, ms: 800 },
    { tag: 'p', level: NOISE, ms: 1500 },   // 1.5s pause (< 2s) -> must NOT fire
    { tag: 's', level: SPEECH, ms: 800 },
    { tag: 'p', level: NOISE, ms: 1500 },   // another 1.5s pause -> must NOT fire
    { tag: 's', level: SPEECH, ms: 800 },
    { tag: 'end', level: NOISE, ms: 2500 }, // final 2.5s silence -> fire once
  ];
  const res = run(seq, { silenceMs: 2000 });
  eq(res.fires, 1, 'repeated-pauses: fires exactly once, only on the final long silence');
  ok(res.firedDuring['end'] === 1, 'repeated-pauses: the single fire is in the final silence');
  ok(!res.firedDuring['p'], 'repeated-pauses: no fire during any sub-threshold pause');
}

// ---------------------------------------------------------------------------
// 5. shorter silenceMs (settings min) fires sooner; longer (max) fires later
// ---------------------------------------------------------------------------
{
  const seq = [
    { tag: 'sil', level: NOISE, ms: 400 },
    { tag: 'speech', level: SPEECH, ms: 1000 },
    { tag: 'trail', level: NOISE, ms: 6000 },
  ];
  const fast = run(seq, { silenceMs: 1000 });
  const slow = run(seq, { silenceMs: 5000 });
  eq(fast.fires, 1, 'range: fires once at 1000ms setting');
  eq(slow.fires, 1, 'range: fires once at 5000ms setting');
  ok(fast.firstFireMs < slow.firstFireMs, 'range: shorter silenceMs fires sooner than longer');
}

// ---------------------------------------------------------------------------
// 6. adaptive floor: works even with a higher (but steady) noise floor
// ---------------------------------------------------------------------------
{
  const HI_NOISE = 0.02;
  const HI_SPEECH = 0.15;
  const seq = [
    { tag: 'sil', level: HI_NOISE, ms: 500 },
    { tag: 'speech', level: HI_SPEECH, ms: 1200 },
    { tag: 'trail', level: HI_NOISE, ms: 3000 },
  ];
  const res = run(seq, { silenceMs: 2000 });
  eq(res.fires, 1, 'adaptive-floor: fires once with a higher steady noise floor');
  ok(!res.firedDuring['speech'], 'adaptive-floor: no fire during speech at higher floor');
}

// ---------------------------------------------------------------------------
// 7. malformed input never throws and never spuriously fires
// ---------------------------------------------------------------------------
{
  const v = vadLib.createVad({ silenceMs: 2000 });
  let threw = false;
  let fired = false;
  const bad = [NaN, -1, undefined, null, Infinity, 'x'];
  for (let i = 0; i < 400; i++) {
    try {
      const r = v.push(bad[i % bad.length], bad[(i + 1) % bad.length]);
      if (r.fire) fired = true;
    } catch (e) { threw = true; }
  }
  ok(!threw, 'robust: malformed levels/dt never throw');
  ok(!fired, 'robust: malformed input (no real speech) never fires');
}

// ---------------------------------------------------------------------------
// 8. finding #1: a perfectly steady level held above the floor must NEVER drag
// the floor up until auto-stop fires mid-utterance. Calibrate on quiet room
// noise, then hold a constant 0.06 tone for 60s (a sustained vowel / hum /
// machine tone that never dips). With the old unconditional EWMA floor rise this
// fired at ~11.5s; silence-gated rise must keep it silent forever.
// ---------------------------------------------------------------------------
{
  const seq = [
    { tag: 'sil', level: NOISE, ms: 400 },
    { tag: 'tone', level: 0.06, ms: 60000 },
  ];
  const res = run(seq, { silenceMs: 2000 });
  eq(res.fires, 0, 'steady-tone: a sustained steady level never auto-stops mid-utterance');
  ok(!res.firedDuring['tone'], 'steady-tone: no fire at any point during the held tone');
}

// ---------------------------------------------------------------------------
// 9. finding #2: speech from t=0 (the whole calibration window is speech) seeds
// the floor high, but the first real pause re-seeds it via instant-down. A 100ms
// gap at t=3s followed by trailing silence must still auto-stop.
// ---------------------------------------------------------------------------
{
  const seq = [
    { tag: 'speech-0', level: SPEECH, ms: 3000 },  // already speaking at latch time
    { tag: 'gap',      level: NOISE,  ms: 100 },    // brief pause re-seeds the floor
    { tag: 'speech-1', level: SPEECH, ms: 1000 },
    { tag: 'trail',    level: NOISE,  ms: 6000 },
  ];
  const res = run(seq, { silenceMs: 2000 });
  eq(res.fires, 1, 'speech-from-t0: fires once after a mid-session pause re-seeds the floor');
  ok(res.firedDuring['trail'] === 1, 'speech-from-t0: the single fire lands in the trailing silence');
  ok(!res.firedDuring['speech-0'] && !res.firedDuring['speech-1'], 'speech-from-t0: never fires during speech');
}

// ---------------------------------------------------------------------------
// 10. finding #4: push() clamps its own dt. Establish speech, then a single push
// with a huge dt (5000ms > silenceMs) must NOT fire on its own — the internal
// clamp bounds one step to 1000ms so it cannot leap past silenceMs in one sample.
// ---------------------------------------------------------------------------
{
  const v = vadLib.createVad({ silenceMs: 2000 });
  for (let i = 0; i < Math.round(500 / DT); i++) v.push(NOISE, DT);   // calibrate on quiet
  for (let i = 0; i < Math.round(1000 / DT); i++) v.push(SPEECH, DT); // speak (hasSpoken)
  const r = v.push(NOISE, 5000);   // one giant silence step
  ok(!r.fire, 'dt-clamp: a single huge-dt silence step cannot fire alone (dt clamped to 1000ms)');
  eq(r.hasSpoken, true, 'dt-clamp: speech was registered before the huge-dt step');
}

// ---------------------------------------------------------------------------
console.log('vad-test: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
process.exit(0);
