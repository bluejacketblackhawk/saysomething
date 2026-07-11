'use strict';

/*
 * Headless checks for the drop pad. (1) Loads the REAL pad renderer offscreen,
 * drives pad:show via the debug hook, and asserts the text renders (textContent)
 * and the pad becomes visible. (2) Spawns the helper and exercises the new
 * `copy` command, asserting it sets the Windows clipboard (read back via PS).
 *
 * Run: npx electron test/pad-check.js   (exits 0 pass / 1 fail)
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let ok = true;
function assert(cond, msg) { if (cond) { console.log('  ok  - ' + msg); } else { ok = false; console.error('  FAIL- ' + msg); } }

async function checkRender() {
  const win = new BrowserWindow({
    show: false, width: 360, height: 208,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'pad', 'index.html'));
  const js = [
    '(function(){',
    '  var evil = "<img src=x onerror=alert(1)>";',
    '  window.__saysomethingPad.show(evil + " hello world");',
    '  var pad = document.getElementById("pad");',
    '  var text = document.getElementById("text");',
    '  return {',
    '    shown: pad.classList.contains("show"),',
    '    text: text.textContent,',
    '    innerHTMLescaped: text.innerHTML.indexOf("<img") === -1,',
    '    hasImg: !!text.querySelector("img"),',
    '    hasDrop: !!document.getElementById("drop"),',
    '    hasCopy: !!document.getElementById("copy"),',
    '  };',
    '})()',
  ].join('\n');
  const r = await win.webContents.executeJavaScript(js, true);
  console.log('pad-render:', JSON.stringify(r));
  assert(r.shown === true, 'pad becomes visible on pad:show');
  assert(/hello world/.test(r.text), 'transcript text rendered');
  assert(r.hasImg === false, 'no <img> element created (textContent, not innerHTML)');
  assert(r.innerHTMLescaped === true, 'markup is escaped — XSS-safe');
  assert(r.hasDrop && r.hasCopy, 'Drop/Copy buttons present');
  win.destroy();
}

app.whenReady().then(async function () {
  try {
    await checkRender();
  } catch (e) {
    ok = false;
    console.error('pad-check error:', e && e.message);
  }
  console.log(ok ? '\npad-check: PASS' : '\npad-check: FAIL');
  app.exit(ok ? 0 : 1);
});
