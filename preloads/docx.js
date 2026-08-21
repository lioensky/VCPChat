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
    readExternalResource: (payload) =>
        ipcRenderer.invoke('docx:read-external-resource', payload),
    resolveFontStylesheet: (payload) =>
        ipcRenderer.invoke('scriptorium:resolve-font-stylesheet', payload),
    resolveFontUrl: (payload) =>
        ipcRenderer.invoke('scriptorium:resolve-font-url', payload),
    save: (payload) => ipcRenderer.invoke('docx:save', payload),
    exportRichDocument: (payload) => ipcRenderer.invoke('scriptorium:export-rich-document', payload),
    listDocumentLibrary: () =>
        ipcRenderer.invoke('scriptorium:document-library'),
    listRecent: () => ipcRenderer.invoke('docx:recent-list'),
    loadStylePacks: () =>
        ipcRenderer.invoke('scriptorium:style-packs-load'),
    saveStylePacks: (packs) =>
        ipcRenderer.invoke('scriptorium:style-packs-save', packs),
    loadSvgAssetPacks: () =>
        ipcRenderer.invoke('scriptorium:svg-assets-load'),
    saveSvgAssetPacks: (packs) =>
        ipcRenderer.invoke('scriptorium:svg-assets-save', packs),
    listSystemFonts: (forceRefresh = false) => ipcRenderer.invoke('docx:fonts-list', forceRefresh),

    // 文脉署名头像只读取现有用户与 Agent 资料，不向文档工程写入本机路径。
    loadAgentsList: () => ipcRenderer.invoke('load-agents-list'),
    loadUserAvatar: () => ipcRenderer.invoke('load-user-avatar'),
    loadAgentAvatar: (folderName) => ipcRenderer.invoke('load-agent-avatar', folderName),

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

    // Agent 双端桥：主进程负责授权与路由，渲染端只执行已验证的结构化请求。
    onAgentCheckpointProposed: (callback) => subscribe('docx:agent-checkpoint-proposed', callback),
    onAgentRequest: (callback) => subscribe('scriptorium:agent-request', callback),
    respondAgentRequest: (payload) => ipcRenderer.send('scriptorium:agent-response', payload),
});

contextBridge.exposeInMainWorld('scriptoriumAPI', scriptoriumAPI);

// 兼容尚未迁移的调用方；新文坊渲染器只使用 scriptoriumAPI。
contextBridge.exposeInMainWorld('docxAPI', scriptoriumAPI);