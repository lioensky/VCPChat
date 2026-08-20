'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vcpBootstrap', Object.freeze({
    doctor: deep => ipcRenderer.invoke('bootstrap:doctor', deep),
    plan: () => ipcRenderer.invoke('bootstrap:plan'),
    repair: args => ipcRenderer.invoke('bootstrap:repair', args || []),
    launch: safe => ipcRenderer.invoke('bootstrap:launch', Boolean(safe)),
    cancel: () => ipcRenderer.invoke('bootstrap:cancel'),
    logs: () => ipcRenderer.invoke('bootstrap:logs'),
    openLog: target => ipcRenderer.invoke('bootstrap:open-log', target),
    quit: () => ipcRenderer.invoke('bootstrap:quit'),
    onOutput: callback => {
        const listener = (_event, detail) => callback(detail);
        ipcRenderer.on('bootstrap:output', listener);
        return () => ipcRenderer.removeListener('bootstrap:output', listener);
    },
}));
