'use strict';

/**
 * SaySomething setup — idempotent installer.
 *
 * Steps (each safe to re-run):
 *   [1] Windows: unpack whisper binaries from the third_party cache (or download
 *       the zip from GitHub if the cache is missing) into bin/whisper. macOS: there
 *       is no official server release to download — verify a locally-built
 *       bin/whisper/whisper-server and point at scripts/build-whisper-mac.sh if absent.
 *   [2] Compile the native helper (native/build.cmd via cmd.exe on Windows,
 *       native/build-mac.sh via /bin/bash on macOS) -> bin/helper. Skipped
 *       gracefully if the build script is not present yet (built in parallel).
 *   [3] Download the default model (or --model <name>) into the user-data models
 *       dir with a console progress bar. Cross-platform (plain fetch). Skipped with --no-model.
 *   [4] Self-check: boot whisper-server with a local model (if any) and confirm
 *       it becomes reachable, then print a status matrix.
 *
 * Network: this script is the ONLY part of SaySomething that touches the internet —
 * whisper binaries from GitHub (Windows only), models from Hugging Face. It says so below.
 *
 * Flags: --model <name> | --model=<name> | --no-model | -h/--help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const config = require('../src/main/config');
const binaries = require('../src/main/whisper/binaries');
const models = require('../src/main/whisper/models');

const IS_MAC = process.platform === 'darwin';
const DEFAULT_MODEL = 'small.en';

function parseArgs(argv) {
  const args = { model: DEFAULT_MODEL, noModel: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-model') args.noModel = true;
    else if (a === '--model') { args.model = argv[++i]; }
    else if (a.indexOf('--model=') === 0) { args.model = a.slice('--model='.length); }
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log('Usage: node scripts/setup.js [--model <name> | --no-model]');
  console.log('');
  console.log('  --model <name>   download this model instead of the default (' + DEFAULT_MODEL + ')');
  console.log('  --no-model       skip the model download step entirely');
  console.log('  -h, --help       show this help');
  console.log('');
  console.log('Known models: ' + models.catalog().map(function (m) { return m.name; }).join(', '));
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// --- progress bar -------------------------------------------------------------
function renderBar(p) {
  const width = 28;
  const pct = p.total ? Math.max(0, Math.min(100, p.pct)) : 0;
  const filled = Math.round((pct / 100) * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  const mb = (p.bytes / 1048576).toFixed(1);
  const tot = p.total ? (p.total / 1048576).toFixed(1) : '?';
  process.stdout.write('\r      [' + bar + '] ' + String(pct).padStart(3) + '%  ' + mb + '/' + tot + ' MB   ');
}

// --- status matrix ------------------------------------------------------------
function badge(v) {
  if (v === 'ok') return '[  ok  ]';
  if (v === 'skip') return '[ skip ]';
  if (v === 'FAIL') return '[ FAIL ]';
  return '[  --  ]';
}
function printRow(label, v) {
  console.log('  ' + badge(v) + '  ' + label);
}

async function step1Binaries(status) {
  console.log('[1/4] Whisper binaries');
  try {
    if (binaries.isReady()) {
      console.log('      already present at ' + config.BIN_WHISPER);
    } else if (IS_MAC) {
      // No macOS whisper-server release to download — it is built from source
      // (Metal, arm64). Guide the user to the builder; do not attempt a download.
      status.binaries = 'FAIL';
      console.error('      whisper-server not found in ' + config.BIN_WHISPER);
      console.error('      build it first:  bash ' + config.WHISPER_BUILD_MAC);
      return;
    } else {
      console.log('      unpacking from ' + path.join(config.THIRD_PARTY, config.WHISPER_ZIP_CACHE));
      console.log('      (if the cache is missing it is downloaded from GitHub)');
      await binaries.ensure();
      console.log('      ready at ' + config.BIN_WHISPER);
    }
    status.binaries = 'ok';
  } catch (e) {
    status.binaries = 'FAIL';
    console.error('      ERROR: ' + e.message);
  }
}

function step2Helper(status) {
  const helperName = path.basename(config.BIN_HELPER);
  const buildScript = config.HELPER_BUILD;         // native/build.cmd | native/build-mac.sh
  const buildName = path.basename(buildScript);
  console.log('[2/4] Native helper (' + helperName + ')');
  try {
    if (fs.existsSync(config.BIN_HELPER)) {
      status.helper = 'ok';
      console.log('      already compiled: ' + config.BIN_HELPER);
      return;
    }
    if (!fs.existsSync(buildScript)) {
      status.helper = 'skip';
      console.log('      ' + buildName + ' not present yet (helper is built in parallel) — skipping.');
      return;
    }
    console.log('      compiling via ' + buildScript);
    // Windows: cmd.exe /c build.cmd (csc). macOS: /bin/bash build-mac.sh (swiftc).
    const r = IS_MAC
      ? spawnSync('/bin/bash', [buildScript], { stdio: 'inherit', cwd: path.dirname(buildScript) })
      : spawnSync('cmd.exe', ['/c', buildScript], { stdio: 'inherit', windowsHide: true });
    if (r.status === 0 && fs.existsSync(config.BIN_HELPER)) {
      status.helper = 'ok';
      console.log('      compiled: ' + config.BIN_HELPER);
    } else {
      status.helper = 'FAIL';
      console.error('      ' + buildName + ' failed (exit ' + r.status + ')');
    }
  } catch (e) {
    status.helper = 'FAIL';
    console.error('      ERROR: ' + e.message);
  }
}

async function step3Model(status, args) {
  console.log('[3/4] Speech model');
  if (args.noModel) {
    status.model = 'skip';
    console.log('      --no-model set — skipping download.');
    return;
  }
  const known = models.catalog().some(function (m) { return m.name === args.model; });
  if (!known) {
    status.model = 'FAIL';
    console.error('      unknown model "' + args.model + '".');
    console.error('      known: ' + models.catalog().map(function (m) { return m.name; }).join(', '));
    return;
  }
  if (models.listLocal().indexOf(args.model) !== -1) {
    status.model = 'ok';
    console.log('      already downloaded: ' + models.pathFor(args.model));
    return;
  }
  const meta = models.catalog().find(function (m) { return m.name === args.model; });
  console.log('      downloading ggml-' + args.model + '.bin (~' + meta.sizeMB + ' MB) from Hugging Face...');
  try {
    await models.download(args.model, renderBar);
    process.stdout.write('\n');
    status.model = 'ok';
    console.log('      saved: ' + models.pathFor(args.model));
  } catch (e) {
    process.stdout.write('\n');
    status.model = 'FAIL';
    console.error('      ERROR: ' + e.message);
  }
}

async function step4SelfCheck(status, args) {
  console.log('[4/4] Self-check (boot whisper-server)');
  const local = models.listLocal();
  let bootModel = null;
  if (!args.noModel && local.indexOf(args.model) !== -1) bootModel = args.model;
  else if (local.length) bootModel = local[0];

  if (status.binaries !== 'ok') {
    status.server = 'skip';
    console.log('      binaries not ready — skipping.');
    return;
  }
  if (!bootModel) {
    status.server = 'skip';
    console.log('      no local model — skipping server boot self-check.');
    console.log('      (download one, e.g. node scripts/setup.js --model ' + DEFAULT_MODEL + ')');
    return;
  }
  const server = require('../src/main/whisper/server');
  try {
    const st = await server.start(bootModel, config.DEFAULT_PORT);
    status.server = st.running ? 'ok' : 'FAIL';
    console.log('      booted with ' + bootModel + ' on 127.0.0.1:' + st.port + ' (HTTP reachable).');
  } catch (e) {
    status.server = 'FAIL';
    console.error('      server boot failed: ' + e.message);
  } finally {
    try { await server.stop(); } catch (e) { /* ignore */ }
    await delay(300);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  console.log('SaySomething setup — idempotent installer');
  console.log('Network: downloads whisper binaries from GitHub and models from Hugging Face ONLY.');
  console.log('');

  const status = { binaries: '?', helper: '?', model: '?', server: '?' };

  await step1Binaries(status);
  step2Helper(status);
  await step3Model(status, args);
  await step4SelfCheck(status, args);

  console.log('');
  console.log('  Status matrix');
  console.log('  -------------');
  printRow('whisper binaries', status.binaries);
  printRow('native helper   ', status.helper);
  printRow('speech model    ', status.model);
  printRow('server boot     ', status.server);
  console.log('');

  const failed = Object.keys(status).filter(function (k) { return status[k] === 'FAIL'; });
  if (failed.length) {
    console.log('Setup finished with errors in: ' + failed.join(', '));
    process.exit(1);
  }
  console.log('Setup OK.');
  process.exit(0);
}

main().catch(function (e) {
  console.error('setup: unexpected error: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
