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
        const headings = [...root.querySelectorAll('h1[data-vdoc-text], h2[data-vdoc-text]')];
        const copied = headings[0];
        const target = headings[1];
        copied.classList.add('paste-debug-heading');
        copied.style.letterSpacing = '0.123em';

        const selection = root.getSelection ? root.getSelection() : window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(copied);
        selection.removeAllRanges();
        selection.addRange(range);

        const clipboard = new DataTransfer();
        copied.dispatchEvent(new ClipboardEvent('copy', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clipboardData: clipboard
        }));
        const clipboardHtml = clipboard.getData('text/html');

        target.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: 500,
            clientY: 320
        }));
        document.querySelector(
            '#text-context-menu [data-text-action="paste-formatted"]'
        ).click();

        const pasted = target.nextElementSibling;
        const source = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 120
        }).source;
        const sourceTemplate = document.createElement('template');
        sourceTemplate.innerHTML = source;
        const stored = pasted?.dataset?.vdocText
            ? sourceTemplate.content.querySelector(
                '[data-vdoc-text="' + CSS.escape(pasted.dataset.vdocText) + '"]'
            )
            : null;

        return {
            copiedOuterHtml: copied?.outerHTML || '',
            clipboardHtml,
            targetOuterHtml: target?.outerHTML || '',
            pastedOuterHtml: pasted?.outerHTML || '',
            storedOuterHtml: stored?.outerHTML || '',
            copiedTag: copied?.tagName || '',
            pastedTag: pasted?.tagName || '',
            clipboardHasClass: clipboardHtml.includes('paste-debug-heading'),
            clipboardHasStyle: clipboardHtml.includes('letter-spacing'),
            pastedHasClass: pasted?.classList.contains('paste-debug-heading') || false,
            pastedHasStyle: pasted?.style.letterSpacing === '0.123em',
        };
    })()`);

    console.log('[ScriptoriumPasteDebug]', JSON.stringify(result, null, 2));
    await windowRef.close();
    app.exit(0);
}).catch((error) => {
    console.error('[ScriptoriumPasteDebug] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());