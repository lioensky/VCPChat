'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const scriptoriumAPI = Object.freeze({
    openWindow: (options = {}) => ipcRenderer.invoke('open-docx-window', options),
    chooseOpen: () => ipcRenderer.invoke('docx:choose-open'),
    chooseImport: () => ipcRenderer.invoke('scriptorium:choose-import'),
    readPath: (filePath) => ipcRenderer.invoke('docx:read-path', filePath),
    save: (payload) => ipcRenderer.invoke('docx:save', payload),
    exportRichDocument: (payload) => ipcRenderer.invoke('scriptorium:export-rich-document', payload),
    listRecent: () => ipcRenderer.invoke('docx:recent-list'),
    listSystemFonts: (forceRefresh = false) => ipcRenderer.invoke('docx:fonts-list', forceRefresh),

    getCurrentTheme: () => ipcRenderer.invoke('get-current-theme'),
    windowReady: (payload = {}) => ipcRenderer.send('window-lifecycle:ready', {
        appId: 'docx-editor',
        ...payload,
    }),

    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    unmaximizeWindow: () => ipcRenderer.send('unmaximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),
    openDevTools: () => ipcRenderer.send('open-dev-tools'),

    onThemeUpdated: (callback) => subscribe('theme-updated', callback),
    onWindowMaximized: (callback) => subscribe('window-maximized', callback),
    onWindowUnmaximized: (callback) => subscribe('window-unmaximized', callback),
    onOpenPathRequest: (callback) => subscribe('docx:open-path-request', callback),

    // Agent 管线占位：首版没有对应主进程执行入口，只保留只读事件订阅契约。
    onAgentCheckpointProposed: (callback) => subscribe('docx:agent-checkpoint-proposed', callback),
});

contextBridge.exposeInMainWorld('scriptoriumAPI', scriptoriumAPI);

// 兼容尚未迁移的调用方；新文坊渲染器只使用 scriptoriumAPI。
contextBridge.exposeInMainWorld('docxAPI', scriptoriumAPI);