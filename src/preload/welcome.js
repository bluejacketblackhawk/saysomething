'use strict';

/**
 * Preload for the WELCOME / permissions-onboarding renderer. Exposes
 * window.saysomething = { send, on, invoke, platform } with only the perms
 * channels whitelisted, plus process.platform so the renderer can branch between
 * the plain first-run intro (win32) and the macOS TCC onboarding (darwin) without
 * a second HTML file.
 *
 * Inlined channel names (sandboxed preloads can't require local modules) — keep in
 * sync with src/main/ipc.js (WELCOME).
 */

const { contextBridge, ipcRenderer } = require('electron');

const SEND = [];
const ON = ['perms:changed'];
const INVOKE = ['perms:get', 'perms:request', 'perms:openPane'];

function makeBridge(sendCh, onCh, invokeCh) {
  return {
    // No send channels for this renderer, but keep the same bridge shape.
    send: function (channel, payload) {
      if (sendCh.indexOf(channel) === -1) {
        throw new Error('saysomething: send channel not allowed: ' + channel);
      }
      ipcRenderer.send(channel, payload);
    },
    on: function (channel, callback) {
      if (onCh.indexOf(channel) === -1) {
        throw new Error('saysomething: on channel not allowed: ' + channel);
      }
      const listener = function (_event, payload) { callback(payload); };
      ipcRenderer.on(channel, listener);
      return function () { ipcRenderer.removeListener(channel, listener); };
    },
    invoke: function (channel, payload) {
      if (invokeCh.indexOf(channel) === -1) {
        return Promise.reject(new Error('saysomething: invoke channel not allowed: ' + channel));
      }
      return ipcRenderer.invoke(channel, payload);
    },
    // Read-only platform flag: the renderer shows the TCC onboarding only on darwin.
    platform: process.platform,
  };
}

contextBridge.exposeInMainWorld('saysomething', makeBridge(SEND, ON, INVOKE));
