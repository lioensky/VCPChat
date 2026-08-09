'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');

const projectRoot = path.resolve(__dirname, '..');
let windowRef = null;

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('docx:fonts-list', () => [
        'Arial',
        'Calibri',
        'Microsoft YaHei',
        'Noto Serif CJK SC',
        'SimSun',
        'Times New Roman',
    ]);
    ipcMain.handle('docx:choose-open', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:read-path', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:save', () => ({ success: false, canceled: true }));
    ipcMain.handle('open-docx-window', () => ({ success: true }));

    ipcMain.on('window-lifecycle:ready', (_event, payload) => {
        console.log('[ScriptoriumSmoke] Renderer ready:', JSON.stringify(payload));
    });
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => app.quit());
    ipcMain.on('open-dev-tools', () => {});
}

app.whenReady().then(async () => {
    registerMinimalIpc();

    windowRef = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false,
        frame: false,
        webPreferences: {
            preload: path.join(projectRoot, 'preloads', 'docx.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    const errors = [];
    windowRef.webContents.on('console-message', (...args) => {
        const details = args.find((value) => value && typeof value === 'object' && typeof value.message === 'string');
        const level = details?.level ?? args[1];
        const message = details?.message ?? args[2] ?? 'Unknown renderer message';
        const lineNumber = details?.lineNumber ?? args[3];
        const sourceId = details?.sourceId ?? args[4];
        console.log(`[Renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
        if (level === 'error' || level === 3) errors.push(message);
    });
    windowRef.webContents.on('render-process-gone', (_event, details) => {
        errors.push(`render-process-gone: ${details.reason}`);
    });

    await windowRef.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await windowRef.webContents.executeJavaScript(`document.getElementById('welcome-new-btn').click()`);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const snapshot = await windowRef.webContents.executeJavaScript(`({
    title: document.title,
    hasApi: Boolean(window.docxAPI),
    superDocType: typeof window.SuperDoc,
    superDocKeys: window.SuperDoc && (typeof window.SuperDoc === 'object' || typeof window.SuperDoc === 'function')
        ? Object.keys(window.SuperDoc).slice(0, 30)
        : [],
    hasSuperDoc: Boolean(
        typeof window.SuperDoc === 'function'
        || (window.SuperDoc && typeof window.SuperDoc.SuperDoc === 'function')
        || (window.SuperDoc && typeof window.SuperDoc.default === 'function')
    ),
    scripts: Array.from(document.scripts).map((script) => ({
        src: script.src,
        type: script.type,
        loaded: script.src ? performance.getEntriesByName(script.src).length > 0 : true
    })),
    bodyTheme: document.body.className,
    welcomeVisible: !document.getElementById('welcome-state').hidden,
    editorVisible: !document.getElementById('superdoc-host').hidden,
    editorReady: document.getElementById('save-state').textContent === '已保存',
    hasEditableSurface: Boolean(document.querySelector('#superdoc-host .presentation-editor')),
    editorCommandKeys: window.SuperDocInstance?.activeEditor?.commands
        ? Object.keys(window.SuperDocInstance.activeEditor.commands).slice(0, 100)
        : [],
    loadingVisible: !document.getElementById('loading-state').hidden,
    saveState: document.getElementById('save-state').textContent,
    toastText: document.getElementById('toast-region').innerText,
    editorHtml: document.getElementById('superdoc-host').innerHTML.slice(0, 1200),
    fontCount: document.getElementById('font-family-select').options.length,
    lineageText: document.getElementById('lineage-panel').innerText,
    viewport: { width: innerWidth, height: innerHeight }
})`);

    const outputDir = path.join(projectRoot, 'AppData', 'DocxEditor');
    await fs.ensureDir(outputDir);
    const image = await windowRef.webContents.capturePage();
    const screenshotPath = path.join(outputDir, 'scriptorium-smoke.png');
    await fs.writeFile(screenshotPath, image.toPNG());

    console.log('[ScriptoriumSmoke] Snapshot:', JSON.stringify(snapshot, null, 2));
    console.log('[ScriptoriumSmoke] Screenshot:', screenshotPath);

    if (!snapshot.hasApi || !snapshot.hasSuperDoc || snapshot.welcomeVisible || !snapshot.editorVisible
        || !snapshot.editorReady || !snapshot.hasEditableSurface || snapshot.fontCount < 2) {
        errors.push('Required Scriptorium editing surface is unavailable.');
    }

    if (errors.length) {
        console.error('[ScriptoriumSmoke] FAILED:', JSON.stringify(errors, null, 2));
        app.exit(1);
        return;
    }

    console.log('[ScriptoriumSmoke] PASSED');
    app.exit(0);
});

app.on('window-all-closed', () => app.quit());