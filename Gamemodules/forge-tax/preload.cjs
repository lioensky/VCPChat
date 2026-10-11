'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const listeners = new Set();
contextBridge.exposeInMainWorld('forgeTaxRemote', Object.freeze({
    getState: () => ipcRenderer.invoke('forge-tax:query'),
    command: args => ipcRenderer.invoke('forge-tax:command', args),
    onUpdate: callback => {
        if (typeof callback !== 'function') throw new TypeError('callback必须为函数');
        const listener = (_event, output) => callback(output);
        listeners.add(listener); ipcRenderer.on('forge-tax:update', listener);
        return () => { listeners.delete(listener); ipcRenderer.removeListener('forge-tax:update', listener); };
    }
}));
window.addEventListener('pagehide', () => {
    for (const listener of listeners) ipcRenderer.removeListener('forge-tax:update', listener);
    listeners.clear();
}, { once: true });