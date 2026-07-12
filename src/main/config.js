'use strict';

/**
 * Central paths & constants. Everyone imports this module.
 *
 * Works both inside the Electron main process and in plain-node contexts such as
 * scripts/setup.js and the test scripts, always resolving to the per-user data dir
 * (%APPDATA%/SaySomething on Windows, ~/Library/Application Support/SaySomething on
 * macOS) so the same locations resolve either way.
 *
 * Every value here is either identical cross-platform or resolved through a single
 * `IS_MAC` branch: binary names lose their `.exe` on darwin, the helper source is
 * Swift, tar is the system bsdtar, and the whisper server is built locally rather
 * than downloaded. Windows values are byte-identical to before.
 */

const path = require('path');
const os = require('os');

const APP_NAME = 'SaySomething';
const IS_MAC = process.platform === 'darwin';

// config.js lives at <repo>/src/main/config.js → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// When packaged (electron-builder), bin/ and the default model ship as
// extraResources under process.resourcesPath. Prefer that; fall back to the repo
// layout in dev / plain-node. `bundledRoot` is null unless running packaged.
let bundledRoot = null;
try {
  const electron = require('electron');
  if (electron && electron.app && electron.app.isPackaged && process.resourcesPath) {
    bundledRoot = process.resourcesPath;
  }
} catch (e) {
  // not electron / not packaged — repo layout
}
const ASSET_ROOT = bundledRoot || REPO_ROOT;

/**
 * Resolve the per-user data directory.
 * @returns {string}
 */
function resolveUserData() {
  // Anchor on the platform roaming/app-data dir, NOT app.getPath('userData'): the
  // latter is derived from the lowercase npm package name ('saysomething'), which
  // would disagree with the plain-node fallback. Joining a fixed APP_NAME keeps both
  // identical. On darwin the roaming dir is ~/Library/Application Support (there is
  // no %APPDATA% — that env var is Windows-only), which is also what Electron's
  // getPath('appData') returns, so the two contexts still agree.
  let appData = IS_MAC
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      appData = electron.app.getPath('appData');
    }
  } catch (e) {
    // electron not available in this context — use the env-based appData
  }
  return path.join(appData, APP_NAME);
}

const USER_DATA = resolveUserData();

module.exports = {
  APP_NAME: APP_NAME,
  USER_DATA: USER_DATA,                                   // <appData>/SaySomething
  MODELS_DIR: path.join(USER_DATA, 'models'),             // <USER_DATA>/models
  LOGS_DIR: path.join(USER_DATA, 'logs'),                 // <USER_DATA>/logs
  // win: whisper-server.exe, whisper-cli.exe, *.dll — darwin: a single static
  // whisper-server (Metal embedded, no dylibs; see whisper/binaries.js).
  BIN_WHISPER: path.join(ASSET_ROOT, 'bin', 'whisper'),
  // Native helper binary. Loses the .exe on darwin (bin/helper/SaySomethingHelper).
  BIN_HELPER: path.join(ASSET_ROOT, 'bin', 'helper', IS_MAC ? 'SaySomethingHelper' : 'SaySomethingHelper.exe'),
  // Helper source: C# on Windows, a single-file Swift tool on darwin.
  HELPER_SRC: path.join(REPO_ROOT, 'native', IS_MAC ? 'SaySomethingHelper.swift' : 'SaySomethingHelper.cs'),
  // Compile-on-missing build script (dev checkout only): build.cmd (win, via
  // cmd.exe) vs build-mac.sh (darwin, via /bin/bash). See helper.js/setup.js.
  HELPER_BUILD: path.join(REPO_ROOT, 'native', IS_MAC ? 'build-mac.sh' : 'build.cmd'),
  THIRD_PARTY: path.join(ASSET_ROOT, 'third_party'),
  // Read-only models shipped inside the package (the default model), if any.
  BUNDLED_MODELS_DIR: bundledRoot ? path.join(bundledRoot, 'models') : null,
  // WHISPER_ZIP_* are Windows-only: whisper.cpp ships prebuilt x64 server binaries
  // there. On darwin there is no official server release, so binaries.js verifies a
  // locally-built whisper-server instead (built by WHISPER_BUILD_MAC below).
  WHISPER_ZIP_CACHE: 'whisper-bin-x64-v1.9.1.zip',
  WHISPER_ZIP_URL: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip',
  WHISPER_BUILD_MAC: path.join(REPO_ROOT, 'scripts', 'build-whisper-mac.sh'),
  MODEL_BASE_URL: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
  DEFAULT_PORT: 8737,
  // Windows-only toolchain paths. On darwin the helper is built by swiftc (invoked
  // from build-mac.sh) and archives are read by /usr/bin/tar (bsdtar), so csc is n/a.
  CSC: IS_MAC ? null : 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  TAR: IS_MAC ? '/usr/bin/tar' : 'C:\\Windows\\System32\\tar.exe',
};
