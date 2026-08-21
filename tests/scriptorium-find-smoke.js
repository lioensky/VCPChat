'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');

function registerMinimalIpc() {
    ipcMain.handle(
        'get-current-theme',
        () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('load-agents-list', () => []);
    ipcMain.handle('load-user-avatar', () => null);
    ipcMain.handle('load-agent-avatar', () => null);
    ipcMain.handle('docx:fonts-list', () => [
        'Arial',
        'Microsoft YaHei',
        'Noto Serif CJK SC',
    ]);
    ipcMain.handle('docx:choose-open', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:choose-import', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('docx:read-path', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:save', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:export-rich-document', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('scriptorium:svg-assets-load', () => []);
    ipcMain.handle('scriptorium:svg-assets-save', (_event, packs = []) => ({
        success: true,
        count: packs.length,
        size: 0,
    }));
    ipcMain.on('window-lifecycle:ready', () => {});
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => app.quit());
}

app.whenReady().then(async () => {
    registerMinimalIpc();
    const windowRef = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        frame: false,
        webPreferences: {
            preload: path.join(projectRoot, 'preloads', 'docx.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    windowRef.webContents.on('console-message', (...args) => {
        const details = args.find((value) =>
            value && typeof value === 'object'
            && typeof value.message === 'string'
        );
        const level = details?.level ?? args[1];
        const message = details?.message ?? args[2] ?? '';
        if (level === 'error' || level === 3) {
            console.error('[ScriptoriumFindSmoke:Renderer]', message);
        }
    });
    windowRef.webContents.on('render-process-gone', (_event, details) => {
        console.error(
            '[ScriptoriumFindSmoke:RendererGone]',
            details?.reason || 'unknown'
        );
    });

    await windowRef.loadFile(path.join(
        projectRoot,
        'ScriptoriumModules',
        'scriptorium.html'
    ));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await windowRef.webContents.executeJavaScript(
        `document.getElementById('welcome-new-btn').click()`
    );
    await new Promise((resolve) => setTimeout(resolve, 1800));

    const result = await windowRef.webContents.executeJavaScript(`(async () => {
        const panel = document.getElementById('find-panel');
        const input = document.getElementById('find-input');
        const status = document.getElementById('find-status');
        const scope = document.getElementById('find-scope');

        document.getElementById('find-btn').click();
        const buttonOpened = panel.hidden === false
            && document.activeElement === input
            && scope.textContent === '文稿文字';

        input.value = '未命名文稿';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const renderStatus = status.textContent;
        const renderFound = /^1 \\/ \\d+$/.test(renderStatus);
        document.getElementById('find-next-btn').click();
        const renderNavigationWorks = /^\\d+ \\/ \\d+$/.test(status.textContent);

        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'f',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        const shortcutKeepsOpen = panel.hidden === false
            && document.activeElement === input;

        document.getElementById('html-mode-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sourceScope = scope.textContent === '混合源码';
        input.value = '未命名文稿';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const sourceFound = /^1 \\/ \\d+$/.test(status.textContent);
        const editor = document.querySelector(
            '.source-editor-shell .CodeMirror'
        )?.CodeMirror;
        const sourceSelection = editor?.getSelection() === '未命名文稿';
        const sourceMarks = document.querySelectorAll(
            '.source-editor-shell .cm-vdoc-find-match,'
            + '.source-editor-shell .cm-vdoc-find-current'
        ).length > 0;

        input.value = '__scriptorium_no_such_match__';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const emptyState = status.textContent === '无匹配'
            && status.classList.contains('empty')
            && document.getElementById('find-next-btn').disabled;

        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true
        }));
        const escapeClosed = panel.hidden === true;

        return {
            buttonOpened,
            renderFound,
            renderNavigationWorks,
            shortcutKeepsOpen,
            sourceScope,
            sourceFound,
            sourceSelection,
            sourceMarks,
            emptyState,
            escapeClosed
        };
    })()`);

    console.log('[ScriptoriumFindSmoke]', JSON.stringify(result, null, 2));
    const passed = Object.values(result).every(Boolean);
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error('[ScriptoriumFindSmoke] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());