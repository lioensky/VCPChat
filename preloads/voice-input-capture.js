'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceCaptureAPI', Object.freeze({
    ready: () => ipcRenderer.send('voice-input-capture:ready'),
    focusReady: payload => ipcRenderer.send('voice-input-capture:focus-ready', {
        sessionId: String(payload?.sessionId || ''),
        editable: payload?.editable === true,
        selectionStart: Number(payload?.selectionStart),
        selectionEnd: Number(payload?.selectionEnd),
    }),
    update: payload => ipcRenderer.send('voice-input-capture:update', {
        text: String(payload?.text || ''),
        composing: payload?.composing === true,
        updatedAt: Number(payload?.updatedAt) || Date.now(),
    }),
    onPrepare: callback => {
        const listener = (_event, payload) => callback(payload || {});
        ipcRenderer.on('voice-input-capture:prepare', listener);
        return () => ipcRenderer.removeListener('voice-input-capture:prepare', listener);
    },
    onStop: callback => {
        const listener = (_event, payload) => callback(payload || {});
        ipcRenderer.on('voice-input-capture:stop', listener);
        return () => ipcRenderer.removeListener('voice-input-capture:stop', listener);
    },
}));