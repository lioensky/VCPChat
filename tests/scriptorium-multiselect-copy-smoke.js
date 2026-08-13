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
    ipcMain.handle('docx:fonts-list', () => ['Arial', 'Microsoft YaHei']);
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

    const result = await windowRef.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const shells = [...root.querySelectorAll('[data-vdoc-edit-key]')]
            .filter((node) =>
                node.dataset.vdocFlowKind !== 'stable-atomic'
                && (node.textContent || '').trim()
            );
        const first = shells[0];
        const second = shells[1];
        if (!first || !second) return { available: false };

        const sourceBefore = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'markdown-hybrid',
            startLine: 1,
            endLine: 240
        }).source;
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(second, second.childNodes.length);
        const selection = root.getSelection
            ? root.getSelection()
            : window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        const clipboard = new DataTransfer();
        const copyEvent = new ClipboardEvent('copy', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clipboardData: clipboard
        });
        first.dispatchEvent(copyEvent);

        const plain = clipboard.getData('text/plain');
        const markdown = clipboard.getData('text/markdown');
        const sourceAfter = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'markdown-hybrid',
            startLine: 1,
            endLine: 240
        }).source;

        return {
            available: true,
            selectionCrossesRegions:
                first.dataset.vdocEditKey !== second.dataset.vdocEditKey
                && !selection.isCollapsed,
            copyWasHandled: copyEvent.defaultPrevented,
            plainTextAvailable: plain.length > 0,
            markdownAvailable: markdown.length > 0,
            clipboardFormatsAgree: plain === markdown,
            preservesMarkdownHeading: markdown.includes('# 未命名文稿'),
            preservesFollowingContent:
                markdown.includes('VCP SCRIPTORIUM')
                || markdown.includes('人类负责思想与创作'),
            excludesDerivedDomMetadata:
                !markdown.includes('data-vdoc-edit-key')
                && !markdown.includes('contenteditable='),
            copyDoesNotMutateSource: sourceAfter === sourceBefore,
            diagnostic: {
                markdown,
                firstType: first.dataset.vdocEditType,
                firstFlowKind: first.dataset.vdocFlowKind,
                firstText: first.textContent
            }
        };
    })()`);

    console.log('[ScriptoriumMultiCopySmoke]', JSON.stringify(result, null, 2));
    const passed = Object.entries(result)
        .filter(([key]) => key !== 'diagnostic')
        .every(([, value]) => Boolean(value));
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error('[ScriptoriumMultiCopySmoke] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());