'use strict';

/**
 * Preload for the SETTINGS renderer. Exposes a minimal, channel-whitelisted
 * bridge as window.saysomething = { send, on, invoke }.
 *
 * The channel lists below mirror the SETTINGS subset in src/main/ipc.js. They are
 * inlined (not required) because sandboxed preloads cannot require local modules.
 * Keep in sync with src/main/ipc.js.
 */

const { contextBridge, ipcRenderer } = require('electron');

const SEND = [];
const ON = ['models:progress', 'whisper:status', 'settings:changed'];
const INVOKE = [
  'settings:get', 'settings:set',
  'models:list', 'models:download', 'models:cancel',
  'history:list', 'history:remove', 'history:clear',
  'app:info', 'hotkey:capture', 'whisper:restart',
  'rewrite:models',
];

function makeBridge(sendCh, onCh, invokeCh) {
  return {
    /**
     * @param {string} channel
     * @param {*} payload
     */
    send: function (channel, payload) {
      if (sendCh.indexOf(channel) === -1) {
        throw new Error('SaySomething: send channel not allowed: ' + channel);
      }
      ipcRenderer.send(channel, payload);
    },
    /**
     * @param {string} channel
     * @param {(payload:*) => void} callback
     * @returns {() => void} unsubscribe
     */
    on: function (channel, callback) {
      if (onCh.indexOf(channel) === -1) {
        throw new Error('SaySomething: on channel not allowed: ' + channel);
      }
      const listener = function (_event, payload) { callback(payload); };
      ipcRenderer.on(channel, listener);
      return function () { ipcRenderer.removeListener(channel, listener); };
    },
    /**
     * @param {string} channel
     * @param {*} payload
     * @returns {Promise<*>}
     */
    invoke: function (channel, payload) {
      if (invokeCh.indexOf(channel) === -1) {
        return Promise.reject(new Error('SaySomething: invoke channel not allowed: ' + channel));
      }
      return ipcRenderer.invoke(channel, payload);
    },
  };
}

contextBridge.exposeInMainWorld('saysomething', makeBridge(SEND, ON, INVOKE));
