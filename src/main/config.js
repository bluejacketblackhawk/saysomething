'use strict';

/**
 * Central paths & constants. Everyone imports this module.
 *
 * Works both inside the Electron main process and in plain-node contexts such as
 * scripts/setup.js and the test scripts, always resolving to %APPDATA%/SaySomething so
 * the same locations resolve either way.
 */

const path = require('path');
const os = require('os');

const APP_NAME = 'SaySomething';

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
  // Anchor on %APPDATA% (roaming), NOT app.getPath('userData'): the latter is
  // derived from the lowercase npm package name ('saysomething'), which would disagree
  // with the plain-node fallback. Joining a fixed APP_NAME keeps both identical.
  let appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
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
  USER_DATA: USER_DATA,                                   // %APPDATA%/SaySomething
  MODELS_DIR: path.join(USER_DATA, 'models'),             // <USER_DATA>/models
  LOGS_DIR: path.join(USER_DATA, 'logs'),                 // <USER_DATA>/logs
  BIN_WHISPER: path.join(ASSET_ROOT, 'bin', 'whisper'),   // whisper-server.exe, whisper-cli.exe, *.dll
  BIN_HELPER: path.join(ASSET_ROOT, 'bin', 'helper', 'SaySomethingHelper.exe'),
  HELPER_SRC: path.join(REPO_ROOT, 'native', 'SaySomethingHelper.cs'),
  THIRD_PARTY: path.join(ASSET_ROOT, 'third_party'),
  // Read-only models shipped inside the package (the default model), if any.
  BUNDLED_MODELS_DIR: bundledRoot ? path.join(bundledRoot, 'models') : null,
  WHISPER_ZIP_CACHE: 'whisper-bin-x64-v1.9.1.zip',
  WHISPER_ZIP_URL: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip',
  MODEL_BASE_URL: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
  DEFAULT_PORT: 8737,
  CSC: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  TAR: 'C:\\Windows\\System32\\tar.exe',
};
