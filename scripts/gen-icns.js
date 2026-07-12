'use strict';

/**
 * gen-icns.js (packaging lane) — build assets/SaySomething.icns from
 * assets/SaySomething.png using ONLY macOS built-in tools: `sips` (resize) and
 * `iconutil` (iconset -> icns). No npm deps, no network, no Electron relaunch
 * needed (unlike scripts/gen-icon.js, which needs a BrowserWindow to rasterize
 * the SVG — this script only resamples an already-rasterized PNG).
 *
 * darwin only. Run: node scripts/gen-icns.js
 *
 * Apple's standard iconset needs images up to 1024x1024 (icon_512x512@2x) for
 * a crisp Retina/Dock/Finder icon. assets/SaySomething.png is 256x256 (see
 * gen-icon.js), so anything above 256px is produced by upscaling the source
 * with sips's Lanczos resampler — soft, but graceful, and still yields a valid,
 * complete .icns. Re-render wisp.svg at a higher resolution later (e.g. bump
 * SIZE in gen-icon.js or add a dedicated 1024px rasterization) for a sharper
 * large icon; this script does not touch the SVG.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const PNG_SRC = path.join(ASSETS_DIR, 'SaySomething.png');
const ICNS_OUT = path.join(ASSETS_DIR, 'SaySomething.icns');

// macOS iconset naming convention: [file name, pixel size].
const ICONSET_SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const out = (r.stdout || '').toString().trim();
    const err = (r.stderr || '').toString().trim();
    throw new Error(cmd + ' ' + args.join(' ') + ' failed (exit ' + r.status + ')' + (err ? ': ' + err : out ? ': ' + out : ''));
  }
  return (r.stdout || '').toString();
}

function readDim(file, key) {
  const out = run('sips', ['-g', key, file]);
  const m = out.match(new RegExp(key + ':\\s*(\\d+)'));
  if (!m) throw new Error('gen-icns: could not read ' + key + ' from ' + file);
  return parseInt(m[1], 10);
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('gen-icns: uses sips/iconutil, macOS only. Nothing to do on ' + process.platform + '.');
    process.exit(1);
  }
  if (!fs.existsSync(PNG_SRC)) {
    console.error('gen-icns: source PNG not found at ' + PNG_SRC);
    process.exit(1);
  }

  const srcW = readDim(PNG_SRC, 'pixelWidth');
  const srcH = readDim(PNG_SRC, 'pixelHeight');
  console.log('gen-icns: source ' + PNG_SRC + ' is ' + srcW + 'x' + srcH);
  if (srcW !== srcH) {
    console.warn('gen-icns: WARNING — source is not square (' + srcW + 'x' + srcH + '); sips will stretch it to fit each square icon size.');
  }
  const maxSrc = Math.max(srcW, srcH);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saysomething-icns-'));
  const iconset = path.join(tmpRoot, 'SaySomething.iconset');
  fs.mkdirSync(iconset, { recursive: true });

  const upscaled = new Set();
  try {
    for (const entry of ICONSET_SIZES) {
      const name = entry[0];
      const size = entry[1];
      const dest = path.join(iconset, name);
      // Always resample from the original source (not from a previously resized
      // copy) so quality doesn't compound across sizes.
      fs.copyFileSync(PNG_SRC, dest);
      run('sips', ['-z', String(size), String(size), dest]);
      if (size > maxSrc) upscaled.add(size);
    }

    if (upscaled.size) {
      const sizes = Array.from(upscaled).sort(function (a, b) { return a - b; }).join(', ');
      console.log('gen-icns: source tops out at ' + maxSrc + 'px — upscaled to fill: ' + sizes + 'px (soft at those sizes; see file header for how to sharpen later).');
    }

    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    run('iconutil', ['-c', 'icns', iconset, '-o', ICNS_OUT]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const stat = fs.statSync(ICNS_OUT);
  console.log('gen-icns: wrote ' + ICNS_OUT + ' (' + stat.size + ' bytes)');
}

main();
