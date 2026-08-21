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
    ipcMain.handle('docx:choose-open', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('scriptorium:choose-import', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('docx:read-path', () => ({
        success: false,
        canceled: true,
    }));
    ipcMain.handle('docx:save', () => ({
        success: false,
        canceled: true,
    }));
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

    const result = await windowRef.webContents.executeJavaScript(`(async () => {
        const root = document.getElementById('page-stream').shadowRoot;
        const shell = [...root.querySelectorAll(
            '[data-vdoc-edit-key][data-vdoc-edit-type="markdown"]'
        )].find((node) =>
            node.dataset.vdocFlowKind !== 'stable-atomic'
            && Boolean(node.querySelector('p'))
            && (node.textContent || '').trim().length > 4
        );
        if (!shell) return { available: false };

        const source = () => window.ScriptoriumAgent.common.getSource({
            sourceKind: 'markdown-hybrid',
            startLine: 1,
            endLine: 240
        }).source;
        const before = source();

        shell.dispatchEvent(new MouseEvent('click', {
            button: 0,
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: shell.getBoundingClientRect().left + 8,
            clientY: shell.getBoundingClientRect().top + 8
        }));
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        const editor = shell.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        if (!editor) return { available: false, editorActivated: false };

        const walker = document.createTreeWalker(
            editor,
            NodeFilter.SHOW_TEXT
        );
        let textNode = walker.nextNode();
        while (textNode && (textNode.nodeValue || '').length < 4) {
            textNode = walker.nextNode();
        }
        if (!textNode) {
            return {
                available: true,
                editorActivated: true,
                insertionPointAvailable: false
            };
        }

        const offset = Math.max(
            1,
            Math.min(textNode.length - 1, Math.floor(textNode.length / 2))
        );
        const range = document.createRange();
        range.setStart(textNode, offset);
        range.collapse(true);
        const selection = root.getSelection
            ? root.getSelection()
            : window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        editor.focus();

        const clipboard = new DataTransfer();
        clipboard.setData('text/plain', '粘贴甲\\r\\n粘贴乙');
        clipboard.setData(
            'text/html',
            '<strong data-vdoc-text="should-not-persist">恶意格式</strong>'
        );
        const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clipboardData: clipboard
        });
        editor.dispatchEvent(pasteEvent);
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        const after = source();
        const insertedMarkdown = '粘贴甲  \\n\\u200B粘贴乙';
        return {
            available: true,
            editorActivated: true,
            insertionPointAvailable: true,
            pasteWasHandled: pasteEvent.defaultPrevented,
            plainTextPersisted: after.includes('粘贴甲')
                && after.includes('粘贴乙'),
            multilinePasteUsesHardBreak: after.includes(insertedMarkdown),
            sourceChangedOnce:
                after.length === before.length + insertedMarkdown.length,
            htmlClipboardIgnored:
                !after.includes('should-not-persist')
                && !after.includes('<strong')
                && !after.includes('恶意格式'),
            excludesDerivedDomMetadata:
                !after.includes('data-vdoc-edit-key')
                && !after.includes('contenteditable='),
            diagnostic: {
                insertedMarkdown,
                sourceDelta: after.length - before.length
            }
        };
    })()`);

    console.log('[ScriptoriumPaste]', JSON.stringify(result, null, 2));
    const passed = Object.entries(result)
        .filter(([key]) => key !== 'diagnostic')
        .every(([, value]) => Boolean(value));
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error('[ScriptoriumPaste] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());