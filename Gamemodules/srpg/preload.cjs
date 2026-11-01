'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const listeners = new Set();
contextBridge.exposeInMainWorld('srpgRemote', Object.freeze({
    getState: () => ipcRenderer.invoke('srpg:query'),
    command: args => ipcRenderer.invoke('srpg:command', args),
    sync: payload => ipcRenderer.invoke('srpg:sync', payload),
    onUpdate: callback => {
        if (typeof callback !== 'function') throw new TypeError('callback必须为函数');
        const listener = (_event, output) => callback(output);
        listeners.add(listener);
        ipcRenderer.on('srpg:update', listener);
        return () => {
            listeners.delete(listener);
            ipcRenderer.removeListener('srpg:update', listener);
        };
    },
}));
window.addEventListener('pagehide', () => {
    for (const listener of listeners) ipcRenderer.removeListener('srpg:update', listener);
    listeners.clear();
}, { once: true });