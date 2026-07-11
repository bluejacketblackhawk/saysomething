'use strict';

/**
 * Preload for the DROP PAD renderer. Exposes window.saysomething = { send, on, invoke }
 * with only the pad channels whitelisted. Inlined channel names (sandboxed
 * preloads can't require local modules) — keep in sync with src/main/ipc.js (PAD).
 */

const { contextBridge, ipcRenderer } = require('electron');

const SEND = ['pad:move', 'pad:place', 'pad:copy', 'pad:dismiss'];
const ON = ['pad:show'];
const INVOKE = [];

function makeBridge(sendCh, onCh, invokeCh) {
  return {
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
  };
}

contextBridge.exposeInMainWorld('saysomething', makeBridge(SEND, ON, INVOKE));
