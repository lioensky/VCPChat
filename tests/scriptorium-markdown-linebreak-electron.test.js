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

        let editor = shell.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        if (!editor) return { available: false, editorActivated: false };

        const selection = root.getSelection
            ? root.getSelection()
            : window.getSelection();
        const textNode = document.createTreeWalker(
            editor,
            NodeFilter.SHOW_TEXT
        );
        let caretNode = textNode.nextNode();
        while (caretNode && (caretNode.nodeValue || '').length < 4) {
            caretNode = textNode.nextNode();
        }
        if (!caretNode) {
            return {
                available: true,
                editorActivated: true,
                internalCaretAvailable: false
            };
        }
        const caretOffset = Math.max(
            1,
            Math.min(caretNode.length - 1, Math.floor(caretNode.length / 2))
        );
        const endRange = document.createRange();
        endRange.setStart(caretNode, caretOffset);
        endRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(endRange);
        editor.focus();

        const enterEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            composed: true,
            cancelable: true
        });
        editor.dispatchEvent(enterEvent);
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        const afterEnter = source();
        editor = root.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        if (!editor) {
            return {
                available: true,
                editorActivated: true,
                enterWasHandled: enterEvent.defaultPrevented,
                enterAddsOneCompositeBreak:
                    afterEnter.length === before.length + 4
                    && afterEnter.includes('  \\n\\u200B'),
                editorSurvivesEnterReflow: false
            };
        }
        const backspaceEvent = new InputEvent('beforeinput', {
            inputType: 'deleteContentBackward',
            bubbles: true,
            composed: true,
            cancelable: true
        });
        const selectionBeforeBackspace = selection.rangeCount
            ? {
                collapsed: selection.isCollapsed,
                text: selection.toString(),
                anchorInEditor: editor.contains(selection.anchorNode),
                focusInEditor: editor.contains(selection.focusNode)
            }
            : null;
        editor.dispatchEvent(backspaceEvent);
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const afterBackspace = source();

        return {
            available: true,
            editorActivated: true,
            enterWasHandled: enterEvent.defaultPrevented,
            enterAddsOneCompositeBreak:
                afterEnter.length === before.length + 4
                && afterEnter.includes('  \\n\\u200B'),
            backspaceWasHandled: backspaceEvent.defaultPrevented,
            oneBackspaceRestoresSource: afterBackspace === before,
            diagnostic: {
                inputType: backspaceEvent.inputType,
                editorConnected: editor.isConnected,
                editorIsActive: root.activeElement === editor,
                selectionBeforeBackspace,
                sourceDeltaAfterBackspace:
                    afterBackspace.length - before.length
            }
        };
    })()`);

    console.log(
        '[ScriptoriumMarkdownLinebreak]',
        JSON.stringify(result, null, 2)
    );
    const passed = Object.entries(result)
        .filter(([key]) => key !== 'diagnostic')
        .every(([, value]) => Boolean(value));
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error(
        '[ScriptoriumMarkdownLinebreak] FAILED:',
        error?.stack || error
    );
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());