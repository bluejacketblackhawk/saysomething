'use strict';

/**
 * Stage the default model into build-resources/models/ for electron-builder to
 * pick up as extraResources (see package.json "build.extraResources"). Also makes
 * sure the whisper binaries + compiled helper are present in bin/. Run by
 * `npm run prep` before `npm run dist` / `dist:dir`.
 *
 * Plain node. Downloads the default model if it isn't present yet.
 *
 * Cross-platform: config.js and whisper/binaries.js are both platform-branched
 * internally (see their own headers), so most of this script reads the same on
 * win/darwin. The one darwin-only addition is re-asserting the executable bit on
 * the two native binaries before checking for them — a `git` checkout or a build
 * script that doesn't chmod its own output can land a present-but-not-executable
 * file, which binaries.ensure()'s X_OK check (darwin) would otherwise report as
 * "missing". See scripts/after-pack.js for the same re-assert on the packaged copy.
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/main/config');
const models = require('../src/main/whisper/models');
const binaries = require('../src/main/whisper/binaries');

const DEFAULT_MODEL = 'small.en';
const STAGE = path.join(__dirname, '..', 'build-resources', 'models');
const IS_MAC = process.platform === 'darwin';

function ensureExecBit(p) {
  if (!fs.existsSync(p)) return;
  try { fs.chmodSync(p, 0o755); } catch (e) { /* best-effort */ }
}

async function main() {
  if (IS_MAC) {
    // Pre-chmod before the readiness checks below run, so a present-but-not-
    // executable binary doesn't get misreported as "not built".
    ensureExecBit(binaries.serverExe());
    ensureExecBit(config.BIN_HELPER);
  }

  // 1. whisper binaries present (bin/whisper). Win: unpacked from the cached
  //    release zip (downloading it first if needed). Mac: no official release to
  //    download — binaries.ensure() just verifies the locally-built whisper-server
  //    (from scripts/build-whisper-mac.sh) exists and is executable, and throws a
  //    clear "build it with <path>" error otherwise. Either way, other agents may
  //    not have staged it yet on this machine — that's expected, not a bug here.
  process.stdout.write('stage-bundle: ensuring whisper binaries…\n');
  await binaries.ensure();

  // 2. compiled helper present — built by scripts/setup.js on win, or
  //    native/build-mac.sh on darwin (see config.HELPER_BUILD).
  if (!fs.existsSync(config.BIN_HELPER)) {
    console.error('stage-bundle: helper not built at ' + config.BIN_HELPER);
    if (IS_MAC) {
      console.error('             run:  ' + config.HELPER_BUILD + '   (compiles native/SaySomethingHelper.swift)');
    } else {
      console.error('             run:  node scripts/setup.js   (compiles the C# helper)');
    }
    process.exit(1);
  }

  if (IS_MAC) {
    // Both binaries confirmed present now — re-assert once more in case the
    // helper build (a separate script, possibly run after the pre-chmod above)
    // didn't preserve/set +x on its output.
    ensureExecBit(config.BIN_HELPER);
    ensureExecBit(binaries.serverExe());
    process.stdout.write('stage-bundle: mac binaries executable -> ' + config.BIN_HELPER + ', ' + binaries.serverExe() + '\n');
  }

  // 3. default model present (download if needed), then copy into staging.
  //    Shared across platforms — models.js has no OS-specific code.
  let src = models.pathFor(DEFAULT_MODEL);
  if (!fs.existsSync(src)) {
    process.stdout.write('stage-bundle: downloading ' + DEFAULT_MODEL + ' …\n');
    let lastPct = -1;
    await models.download(DEFAULT_MODEL, function (p) {
      const pct = (p && p.pct) || 0;
      if (pct !== lastPct) { lastPct = pct; process.stdout.write('\r  ' + pct + '%   '); }
    });
    process.stdout.write('\n');
    src = models.pathFor(DEFAULT_MODEL);
  }

  fs.mkdirSync(STAGE, { recursive: true });
  const dest = path.join(STAGE, 'ggml-' + DEFAULT_MODEL + '.bin');
  fs.copyFileSync(src, dest);

  const mb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(0);
  console.log('stage-bundle: staged model  -> ' + dest + '  (' + mb + ' MB)');
  console.log('stage-bundle: bundling bin/ -> ' + config.BIN_WHISPER + ' + helper');
  console.log('stage-bundle: ready for electron-builder.');
}

main().catch(function (e) {
  console.error('stage-bundle failed:', e && e.message);
  process.exit(1);
});
