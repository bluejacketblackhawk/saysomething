'use strict';

/*
 * Headless CSS regression check for the live-partial cross-fade vs the VAD dim.
 * Loads the REAL overlay page in an offscreen BrowserWindow, drives it into the
 * exact broken combo (listening + data-vad="on" + a live partial), and reads the
 * COMPUTED opacity of the waveform and the partial text. Asserts the waveform is
 * fully hidden (0) and the partial is fully shown (1) — i.e. the words win over
 * the auto-stop dim. No mic, no server.
 *
 * Run: npx electron test/overlay-css-check.js   (exits 0 pass / 1 fail)
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    show: false, width: 360, height: 120,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'index.html'));

  // Kill transitions/animations so getComputedStyle returns the RESTING cascade
  // winner (the finding is about which rule wins, not the fade timing).
  await win.webContents.insertCSS('*{transition:none !important;animation:none !important;}');

  const js = [
    '(function(){',
    '  var o = window.__saysomethingOverlay;',
    '  if(!o) return {err:"no __saysomethingOverlay hook"};',
    '  o.applyState("listening", { t0: 1 });',   // enter listening
    '  o.vad(true, 0.05);',                        // auto-stop armed, ~no silence yet
    '  o.partial("the quick brown fox");',         // live words arrive
    '  var pill = document.getElementById("pill");',
    '  var wave = document.getElementById("wave");',
    '  var partial = document.getElementById("partial");',
    '  var cs = getComputedStyle;',
    '  return {',
    '    dataState: pill.getAttribute("data-state"),',
    '    dataVad: pill.getAttribute("data-vad"),',
    '    hasPartial: pill.classList.contains("has-partial"),',
    '    partialText: partial.textContent,',
    '    waveOpacity: parseFloat(cs(wave).opacity),',
    '    partialOpacity: parseFloat(cs(partial).opacity),',
    '  };',
    '})()',
  ].join('\n');

  let ok = true;
  try {
    const r = await win.webContents.executeJavaScript(js, true);
    console.log('overlay-css-check:', JSON.stringify(r));
    function assert(cond, msg) { if (cond) { console.log('  ok  - ' + msg); } else { ok = false; console.error('  FAIL- ' + msg); } }
    assert(r && !r.err, 'overlay hook present');
    assert(r.dataState === 'listening', 'pill is listening');
    assert(r.dataVad === 'on', 'VAD is armed (data-vad=on) — the broken combo');
    assert(r.hasPartial === true, 'has-partial class applied');
    assert(r.partialText && r.partialText.indexOf('quick') !== -1, 'partial text rendered (textContent)');
    assert(r.waveOpacity === 0, 'waveform fully HIDDEN under the partial (opacity 0), was ' + (r && r.waveOpacity));
    assert(r.partialOpacity === 1, 'partial text fully SHOWN (opacity 1), was ' + (r && r.partialOpacity));
  } catch (e) {
    ok = false;
    console.error('overlay-css-check: error', e);
  }

  win.destroy();
  console.log(ok ? '\noverlay-css-check: PASS' : '\noverlay-css-check: FAIL');
  app.exit(ok ? 0 : 1);
});
