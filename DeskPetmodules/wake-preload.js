'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wakeCapture', {
    frame: samples => ipcRenderer.invoke('deskpet-wake:frame', samples),
    ready: () => ipcRenderer.send('deskpet-wake:capture-ready'),
    error: message => ipcRenderer.send('deskpet-wake:capture-error', String(message).slice(0, 500)),
    playbackEnded: token => ipcRenderer.send('deskpet-wake:playback-ended', token),
    onPlay: callback => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on('deskpet-wake:play', listener);
        return () => ipcRenderer.removeListener('deskpet-wake:play', listener);
    },
});