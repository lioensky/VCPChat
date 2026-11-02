'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 停在主窗口右栏时（URL 带 vcpEmbedded=1，同 preloads/utility.js 的约定）给页面打上标记，
// 文坊自己的样式（ScriptoriumModules/uttu-scriptorium.css）据此去掉窗口按钮、换成窄宽布局。
const isEmbeddedSurface = new URLSearchParams(globalThis.location?.search || '').get('vcpEmbedded') === '1';
if (isEmbeddedSurface) {
    const mark = () => {
        document.documentElement?.setAttribute('data-vcp-embedded-app', 'true');
        document.body?.setAttribute('data-vcp-embedded-app', 'true');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark, { once: true });
    else mark();
}

function subscribe(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

// 文档载好、文件夹页列好（处理函数返回的 Promise 了结）后告诉主进程，藏着建的文坊窗口这时才显示
// （modules/uttu/scriptoriumWarm.js）。返回 false 或出错算没开成。
function reportOpened(channel, callback) {
    if (typeof callback !== 'function') return null;
    return (payload) => {
        // 告诉页面“有人要开这一份”，会话恢复（uttu-scriptorium-tabs.js）就不再抢着开上次那份。
        if (channel !== 'uttu-scriptorium:restore-tabs') {
            try { window.dispatchEvent(new CustomEvent('uttu-open-request', { detail: channel === 'docx:open-path-request' && typeof payload === 'string' ? payload : '' })); } catch (_) { /* 没有页面 */ }
        }
        Promise.resolve().then(() => callback(payload)).then(
            (result) => ipcRenderer.send('uttu-scriptorium:opened', { ok: result !== false }),
            () => ipcRenderer.send('uttu-scriptorium:opened', { ok: false }));
    };
}

// 主进程抛的错经 invoke 回来会带上“Error invoking remote method 'docx:save': Error:”，提示里只留原话。
const plainInvoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((error) => {
    throw new Error(String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
});

const scriptoriumAPI = Object.freeze({
    openWindow: (options = {}) => ipcRenderer.invoke('open-docx-window', options),
    // 选中一段点“问”，引用到主窗口对话的输入框。
    askAgent: (payload) => ipcRenderer.invoke('scriptorium:ask-agent', payload),
    // 新建文档时在文档库目录里分配一个不重名的路径（自动保存往这里写）。
    newDocumentPath: (payload) => ipcRenderer.invoke('scriptorium:new-document-path', payload),
    // 对话里点“看改动”：打开文脉里那次修改的对比。
    onShowChange: (callback) => subscribe('uttu-scriptorium:show-change', callback),
    chooseOpen: () => plainInvoke('docx:choose-open'),
    chooseImport: () => plainInvoke('scriptorium:choose-import'),
    readPath: (filePath) => plainInvoke('docx:read-path', filePath),
    readExternalResource: (payload) =>
        ipcRenderer.invoke('docx:read-external-resource', payload),
    resolveFontStylesheet: (payload) =>
        ipcRenderer.invoke('scriptorium:resolve-font-stylesheet', payload),
    resolveFontUrl: (payload) =>
        ipcRenderer.invoke('scriptorium:resolve-font-url', payload),
    save: (payload) => plainInvoke('docx:save', payload),
    // 点从 .md 打开的文档里的链接（网页交给系统，相对 .md 在文坊里开，别的文件在资源管理器里显示）。
    markdownOpenLink: (payload) => plainInvoke('uttu-md:open-link', payload),
    // 文坊“文件夹”页（选文件夹、列一层、按名字找、最近打开的）。
    markdownFolder: (command, payload = {}) => plainInvoke('uttu-md:folder', { ...payload, command }),
    // 工作区、最近打开、文件操作（主进程 modules/uttu/scriptoriumFiles）。
    files: (command, payload = {}) => plainInvoke('uttu-files:act', { ...payload, command }),
    // PDF 的读、写、并页、签名（主进程 modules/uttu/pdfFiles）。
    pdf: (command, payload = {}) => plainInvoke('uttu-pdf:act', { ...payload, command }),
    // 表格（.csv .tsv .xlsx）只读（主进程 modules/uttu/sheetFiles）。
    sheet: (command, payload = {}) => plainInvoke('uttu-sheet:act', { ...payload, command }),
    // 正在看的 .md 被别处改了、删了，打开的文件夹里有增删（主进程 modules/uttu/markdownFiles）。
    onMarkdownEvent: (callback) => subscribe('uttu-md:event', callback),
    exportRichDocument: (payload) => ipcRenderer.invoke('scriptorium:export-rich-document', payload),
    listDocumentLibrary: () =>
        ipcRenderer.invoke('scriptorium:document-library'),
    // 文库里的改名、复制一份、移到回收站、在文件夹里显示、临时转正式；只动文库目录里的文档。
    libraryAction: (payload) =>
        ipcRenderer.invoke('scriptorium:library-action', payload),
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
    onOpenPathRequest: (callback) => subscribe('docx:open-path-request', reportOpened('docx:open-path-request', callback)), // reportOpened
    // 拖进来的文件夹：打开文件夹页（uttu-scriptorium-folder.js）。
    onOpenFolderRequest: (callback) => subscribe('uttu-scriptorium:open-folder', reportOpened('uttu-scriptorium:open-folder', callback)),
    // 窗口显示之前先开好上次看的那份（uttu-scriptorium-tabs.js）。
    onRestoreTabs: (callback) => subscribe('uttu-scriptorium:restore-tabs', reportOpened('uttu-scriptorium:restore-tabs', callback)),
    onGotoLine: (callback) => subscribe('uttu-scriptorium:goto-line', callback),
    // .html 当网页开（modules/uttu/webPages）：读、存源码，看外部改动，列样张；网页里被拦下的链接。
    page: (command, payload = {}) => plainInvoke('uttu-scriptorium:page', { ...payload, command }),
    onPageChanged: (callback) => subscribe('uttu-scriptorium:page-changed', callback),
    boardTurn: (command, payload = {}) => plainInvoke('uttu-scriptorium:board-turn', { ...payload, command }), // 白板上轮到 Agent
    view: (command, payload = {}) => plainInvoke('uttu-view:act', { ...payload, command }), // 文本、图片
    onViewChanged: (callback) => subscribe('uttu-view:changed', callback),
    onPageBlocked: (callback) => subscribe('uttu-scriptorium:page-blocked', callback),

    // Agent 双端桥：主进程负责授权与路由，渲染端只执行已验证的结构化请求。
    onAgentCheckpointProposed: (callback) => subscribe('docx:agent-checkpoint-proposed', callback),
    onAgentRequest: (callback) => subscribe('scriptorium:agent-request', callback),
    respondAgentRequest: (payload) => ipcRenderer.send('scriptorium:agent-response', payload),
});

contextBridge.exposeInMainWorld('scriptoriumAPI', scriptoriumAPI);

// 兼容尚未迁移的调用方；新文坊渲染器只使用 scriptoriumAPI。
contextBridge.exposeInMainWorld('docxAPI', scriptoriumAPI);

// 拖进文坊的文件、文件夹（modules/uttu/dropOpen.js）：按同一张表在这个文坊里打开。
// 文坊自己不接文件拖放（不拦的话，掉进来的文件会把整个页面带走），所以带文件的拖动都在这里接住；打不开的写一行字，三秒后消失。
(() => {
    const { webUtils } = require('electron');
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    let noteEl = null;
    let noteTimer = 0;
    const note = (text) => {
        if (!text || !document.body) return;
        if (!noteEl) {
            noteEl = document.createElement('div');
            noteEl.className = 'uttu-drop-note';
            noteEl.setAttribute('role', 'status');
            document.body.append(noteEl);
        }
        noteEl.textContent = text;
        noteEl.hidden = false;
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => { noteEl.hidden = true; }, 3000);
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
        // 正在编辑一份 .md（页面在 body 上标 data-uttu-md-edit）、拖进来的全是图片、落在编辑栏里：
        // 交给页面插进文档（uttu-scriptorium-assets.js，图片存到 .md 旁边的 assets/），不当成打开。
        const editing = document.body?.dataset.uttuMdEdit === '1';
        const intoEditor = event.composedPath().some((node) => (node?.classList?.contains?.('uttu-pane') && node.classList.contains('ed')) || node?.id === 'render-host');
        if (editing && intoEditor && paths.length && paths.every((file) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(file))) {
            window.dispatchEvent(new CustomEvent('uttu-drop-images', { detail: JSON.stringify(paths) }));
            return;
        }
        void ipcRenderer.invoke('uttu-drop:open', { paths, from: 'scriptorium' })
            .then((result) => note(result?.message))
            .catch((error) => note(`没打开：${error?.message || error}`));
    }, true);
})();