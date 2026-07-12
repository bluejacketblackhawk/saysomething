'use strict';

/**
 * electron-builder `afterPack` hook (see package.json "build.afterPack").
 *
 * Runs for every platform's pack step; only acts on darwin. electron-builder's
 * extraResources copy (bin/ -> Contents/Resources/bin, see package.json
 * "build.extraResources") can drop the executable bit on the staged native
 * binaries, so re-assert 0755 on the two mac binaries after packing, before
 * signing. (scripts/stage-bundle.js already chmods them in the source bin/
 * tree pre-pack; this is a belt-and-suspenders re-assert on the copies that
 * actually ship.)
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const fs = require('fs');
  const path = require('path');

  const productFilename =
    (context.packager && context.packager.appInfo && context.packager.appInfo.productFilename) || 'Say Something';
  const resourcesDir = path.join(context.appOutDir, productFilename + '.app', 'Contents', 'Resources');

  const binaries = [
    path.join(resourcesDir, 'bin', 'helper', 'SaySomethingHelper'),
    path.join(resourcesDir, 'bin', 'whisper', 'whisper-server'),
  ];

  for (const bin of binaries) {
    if (fs.existsSync(bin)) {
      fs.chmodSync(bin, 0o755);
      console.log('after-pack: chmod 0755 ' + bin);
    } else {
      console.warn('after-pack: expected binary not found (skipping chmod): ' + bin);
    }
  }

  // electron-builder does not sign extraResources content, but every Mach-O in
  // the bundle needs a signature from the SAME identity as the app or TCC and
  // notarization both break (an ad-hoc helper under a signed app gets its own
  // unstable TCC row — the "duplicate Accessibility entries" trap). Signing
  // happens here, inside afterPack, so the outer app signature that
  // electron-builder applies NEXT seals over already-signed binaries
  // (inner-to-outer order). Set SS_MAC_SIGN_IDENTITY to the same identity the
  // build signs with; leave it unset for unsigned local builds.
  const identity = process.env.SS_MAC_SIGN_IDENTITY;
  if (identity) {
    const { execFileSync } = require('child_process');
    const entitlements = path.join(__dirname, '..', 'build-resources', 'entitlements.mac.inherit.plist');
    for (const bin of binaries) {
      if (!fs.existsSync(bin)) continue;
      execFileSync('codesign', [
        '--force', '--sign', identity,
        '--options', 'runtime',
        '--timestamp',
        '--entitlements', entitlements,
        bin,
      ], { stdio: 'inherit' });
      console.log('after-pack: signed ' + bin);
    }
  }
};
