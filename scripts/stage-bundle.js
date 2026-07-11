'use strict';

/**
 * Stage the default model into build-resources/models/ for electron-builder to
 * pick up as extraResources (see package.json "build.extraResources"). Also makes
 * sure the whisper binaries + compiled helper are present in bin/. Run by
 * `npm run prep` before `npm run dist` / `dist:dir`.
 *
 * Plain node. Downloads the default model if it isn't present yet.
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/main/config');
const models = require('../src/main/whisper/models');
const binaries = require('../src/main/whisper/binaries');

const DEFAULT_MODEL = 'small.en';
const STAGE = path.join(__dirname, '..', 'build-resources', 'models');

async function main() {
  // 1. whisper binaries unpacked (bin/whisper).
  process.stdout.write('stage-bundle: ensuring whisper binaries…\n');
  await binaries.ensure();

  // 2. compiled helper present (bin/helper/SaySomethingHelper.exe) — built by setup.js.
  if (!fs.existsSync(config.BIN_HELPER)) {
    console.error('stage-bundle: helper not built at ' + config.BIN_HELPER);
    console.error('             run:  node scripts/setup.js   (compiles the C# helper)');
    process.exit(1);
  }

  // 3. default model present (download if needed), then copy into staging.
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
