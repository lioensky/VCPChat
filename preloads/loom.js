'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, callback) {
    if (typeof callback !== 'function') {
        throw new TypeError('Loom event callback must be a function.');
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const loomAPI = Object.freeze({
    listApps: () => invoke('loom:list-apps'),
    listOpenApps: () => invoke('loom:list-open-apps'),
    getApp: (appId) => invoke('loom:get-app', appId),
    getRuntimeSource: (appId) => invoke('loom:get-runtime-source', appId),
    getRenderedText: (appId, options) => invoke('loom:get-rendered-text', appId, options),
    createApp: (payload) => invoke('loom:create-app', payload),
    saveApp: (payload) => invoke('loom:save-app', payload),
    editAppSources: (appId, payload) => invoke('loom:edit-app-sources', appId, payload),
    deleteApp: (appId) => invoke('loom:delete-app', appId),
    setEnabled: (appId, enabled) => invoke('loom:set-enabled', appId, enabled),
    openApp: (appId) => invoke('loom:open-app', appId),
    closeApp: (appId) => invoke('loom:close-app', appId),
    clearSession: (appId) => invoke('loom:clear-session', appId),
    reloadRegistry: () => invoke('loom:reload-registry'),
    openManager: () => invoke('loom:open-manager'),
    exportApp: (appId) => invoke('loom:export-app', appId),
    importApp: () => invoke('loom:import-app'),
    openAppFolder: (appId) => invoke('loom:open-app-folder', appId),

    shellReady: () => invoke('loom:shell-ready'),
    shellAction: (action, payload) => invoke('loom:shell-action', action, payload),

    getCurrentTheme: () => invoke('get-current-theme'),
    onThemeUpdated: (callback) => subscribe('theme-updated', callback),

    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

    onRegistryChanged: (callback) => subscribe('loom:registry-changed', callback),
    onShellState: (callback) => subscribe('loom:shell-state', callback),
});

contextBridge.exposeInMainWorld('loomAPI', loomAPI);
console.log('[Preload][loom] loaded');