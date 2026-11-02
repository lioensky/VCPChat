'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

// 主进程抛出的错误经 invoke 返回时带有“Error invoking remote method '…': Error:”前缀，提示中只保留原文。
const plainInvoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((error) => {
    throw new Error(String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
});
const command = (channel) => (name, payload = {}) => plainInvoke(channel, { ...payload, command: name });

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

    // 原位打开的文件（modules/scriptorium）：各类文件视图按命令调用，主进程按 fileAccess 允许的范围读写。
    markdownOpenLink: (payload) => plainInvoke('scriptorium:markdown-link', payload),
    markdownFile: command('scriptorium:markdown-file'),
    onMarkdownEvent: (callback) => subscribe('scriptorium:markdown-event', callback),
    files: command('scriptorium:file'),
    page: command('scriptorium:page'),
    onPageChanged: (callback) => subscribe('scriptorium:page-changed', callback),
    onPageBlocked: (callback) => subscribe('scriptorium:page-blocked', callback),
    pdf: command('scriptorium:pdf'),
    sheet: command('scriptorium:sheet'),
    view: command('scriptorium:view'),
    onViewChanged: (callback) => subscribe('scriptorium:view-changed', callback),

    // Agent 双端桥：主进程负责授权与路由，渲染端只执行已验证的结构化请求。
    onAgentCheckpointProposed: (callback) => subscribe('docx:agent-checkpoint-proposed', callback),
    onAgentRequest: (callback) => subscribe('scriptorium:agent-request', callback),
    respondAgentRequest: (payload) => ipcRenderer.send('scriptorium:agent-response', payload),
});

contextBridge.exposeInMainWorld('scriptoriumAPI', scriptoriumAPI);

// 兼容尚未迁移的调用方；新文坊渲染器只使用 scriptoriumAPI。
contextBridge.exposeInMainWorld('docxAPI', scriptoriumAPI);

// 拖进文坊窗口的文件（modules/scriptorium/dropOpen.js）：在这个文坊中打开。
// 页面本身不处理文件拖放（否则拖入的文件会替换整个页面），所以带文件的拖动都在这里接收；无法打开时显示一行说明，三秒后消失。
(() => {
    const { webUtils } = require('electron');
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    let noteElement = null;
    let noteTimer = 0;
    const note = (text) => {
        if (!text || !document.body) return;
        if (!noteElement) {
            noteElement = document.createElement('div');
            noteElement.className = 'scriptorium-drop-note';
            noteElement.setAttribute('role', 'status');
            document.body.append(noteElement);
        }
        noteElement.textContent = text;
        noteElement.hidden = false;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => { noteElement.hidden = true; }, 3000);
    };
    window.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }, true);
    window.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const paths = Array.from(event.dataTransfer.files || []).map((file) => {
            try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
        }).filter(Boolean);
        void ipcRenderer.invoke('scriptorium:drop', { paths })
            .then((result) => note(result?.message))
            .catch((error) => note(`未能打开：${error?.message || error}`));
    }, true);
})();