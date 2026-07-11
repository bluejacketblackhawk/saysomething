'use strict';

/*
 * SaySomething audio worklet — owned by agent B (audio).
 *
 * Runs in the AudioWorkletGlobalScope (the audio rendering thread). It receives
 * the microphone signal at the hardware sample rate (the global `sampleRate`,
 * commonly 48000 or 44100) and downsamples it to 16 kHz mono PCM16 using box
 * averaging, which doubles as a simple anti-aliasing low-pass. Works for ANY
 * input rate (integer or fractional ratio; also tolerates rates below 16 kHz by
 * sample-and-hold).
 *
 * It posts two kinds of messages to audio.js over `this.port`:
 *   { type: 'chunk', buf: ArrayBuffer }  — ~100 ms of Int16 PCM (transferred)
 *   { type: 'level', rms: number }       — RMS of the 16 kHz signal, ~30 / s
 *
 * No audio is written to the node's output (it is fed into a gain-0 sink in
 * audio.js purely so the graph is pulled and process() keeps running).
 */

var TARGET_RATE = 16000;
var CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz
var LEVEL_SAMPLES = 533;  // ~30 Hz at 16 kHz (16000 / 533 ≈ 30.0)

class SaySomethingDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    // Input samples consumed per emitted 16 kHz output sample.
    this.step = sampleRate / TARGET_RATE;

    // Fractional-decimation state (carried across render quanta).
    this.phase = 0; // fractional position within the current output bin
    this.acc = 0;   // running sum of input samples in the current bin
    this.accN = 0;  // count of input samples in the current bin
    this.lastX = 0; // last input sample (used for sample-and-hold upsampling)

    // Output chunk accumulation.
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.chunkFill = 0;

    // Level (RMS) accumulation over the 16 kHz output.
    this.levelSum = 0;
    this.levelN = 0;
  }

  emitSample(v) {
    // v is a float in roughly [-1, 1].
    this.levelSum += v * v;
    this.levelN += 1;
    if (this.levelN >= LEVEL_SAMPLES) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / this.levelN) });
      this.levelSum = 0;
      this.levelN = 0;
    }

    var s = v;
    if (s > 1) s = 1; else if (s < -1) s = -1;
    // Asymmetric scale so full-scale maps correctly for both signs.
    this.chunk[this.chunkFill++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);

    if (this.chunkFill >= CHUNK_SAMPLES) {
      var out = this.chunk;
      this.port.postMessage({ type: 'chunk', buf: out.buffer }, [out.buffer]);
      this.chunk = new Int16Array(CHUNK_SAMPLES);
      this.chunkFill = 0;
    }
  }

  process(inputs) {
    var input = inputs[0];
    if (!input || input.length === 0) {
      // No source connected yet (or a momentary gap). Keep the processor alive.
      return true;
    }

    var ch0 = input[0];
    if (!ch0) return true;
    var nch = input.length;
    var frames = ch0.length;

    for (var n = 0; n < frames; n++) {
      var x = ch0[n];
      if (nch > 1) {
        var sum = 0;
        for (var c = 0; c < nch; c++) sum += input[c][n];
        x = sum / nch;
      }
      this.lastX = x;
      this.acc += x;
      this.accN += 1;
      this.phase += 1;

      while (this.phase >= this.step) {
        this.phase -= this.step;
        var v = this.accN > 0 ? (this.acc / this.accN) : this.lastX;
        this.emitSample(v);
        this.acc = 0;
        this.accN = 0;
      }
    }

    return true;
  }
}

registerProcessor('saysomething-downsampler', SaySomethingDownsampler);
