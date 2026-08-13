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

    const result = await windowRef.webContents.executeJavaScript(`(async () => {
        const root = document.getElementById('page-stream').shadowRoot;
        const blocks = [...root.querySelectorAll('[data-vdoc-text]')]
            .filter((node) => (node.textContent || '').trim());
        const first = blocks[0];
        const second = blocks[1];
        const target = blocks[2];
        if (!first || !second || !target) return { available: false };

        first.classList.add('multi-copy-first');
        first.style.letterSpacing = '0.111em';
        second.classList.add('multi-copy-second');
        second.style.wordSpacing = '0.222em';
        const firstId = first.dataset.vdocText;
        const secondId = second.dataset.vdocText;

        const selectPair = (start, end) => {
            start.dispatchEvent(new PointerEvent('pointerdown', {
                button: 0,
                buttons: 1,
                bubbles: true,
                composed: true,
                cancelable: true
            }));
            start.dispatchEvent(new PointerEvent('pointerup', {
                button: 0,
                bubbles: true,
                composed: true
            }));
            end.dispatchEvent(new PointerEvent('pointerdown', {
                button: 0,
                buttons: 1,
                shiftKey: true,
                bubbles: true,
                composed: true,
                cancelable: true
            }));
            end.dispatchEvent(new PointerEvent('pointerup', {
                button: 0,
                shiftKey: true,
                bubbles: true,
                composed: true
            }));
        };
        const openMenu = (node, x = 500, y = 320) => {
            node.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                composed: true,
                cancelable: true,
                clientX: x,
                clientY: y
            }));
            return document.getElementById('text-context-menu');
        };
        const pasteFormattedAfterTarget = async () => {
            const menu = openMenu(target);
            menu.querySelector('[data-text-action="paste-formatted"]').click();
            await new Promise((resolve) => setTimeout(resolve, 80));
            return [target.nextElementSibling, target.nextElementSibling?.nextElementSibling];
        };

        // 真实快捷键路径：不人工构造 ClipboardEvent。顶层 keydown 必须直接
        // 识别显式多选，并建立可供“维持格式粘贴”使用的富文本载荷。
        selectPair(first, second);
        const focusedInsideShadow = root.activeElement === first;
        const selectedCount = root.querySelectorAll(
            '[data-vdoc-editor-selected="true"]'
        ).length;
        root.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'c',
            code: 'KeyC',
            ctrlKey: true,
            bubbles: true,
            composed: true,
            cancelable: true
        }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        const [keyboardPastedFirst, keyboardPastedSecond] =
            await pasteFormattedAfterTarget();

        // 真实菜单复制路径，同时检查格式工具条已嵌入唯一菜单容器，不再出现
        // 两个 fixed 浮层在同一坐标竞争点击的问题。
        selectPair(keyboardPastedFirst, keyboardPastedSecond);
        const mergedMenu = openMenu(keyboardPastedSecond, 520, 340);
        const mergedLayout = Boolean(
            mergedMenu.querySelector(':scope > #selection-format-bar:not([hidden])')
            && document.querySelectorAll('#selection-format-bar').length === 1
        );
        mergedMenu.querySelector('[data-text-action="copy"]').click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const [menuPastedFirst, menuPastedSecond] = await pasteFormattedAfterTarget();

        // 真实菜单剪切路径。剪切后原块必须同时离开渲染树与源码；剪贴板
        // 载荷仍应可再次作为新 ID 的元素粘贴回来。
        selectPair(first, second);
        const cutMenu = openMenu(second, 540, 360);
        cutMenu.querySelector('[data-text-action="cut"]').click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const sourceAfterCut = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 240
        }).source;
        const originalsRemovedFromDom = !first.isConnected && !second.isConnected;
        const originalsRemovedFromSource =
            !sourceAfterCut.includes(firstId) && !sourceAfterCut.includes(secondId);
        const [restoredFirst, restoredSecond] = await pasteFormattedAfterTarget();

        const sourceAfterRestore = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 280
        }).source;

        return {
            available: true,
            focusedInsideShadow,
            selectedCountIsTwo: selectedCount === 2,
            mergedLayout,
            keyboardCopyPastesTwoBlocks:
                Boolean(keyboardPastedFirst && keyboardPastedSecond),
            keyboardCopyKeepsTags:
                keyboardPastedFirst?.tagName === first.tagName
                && keyboardPastedSecond?.tagName === second.tagName,
            keyboardCopyKeepsStyles:
                keyboardPastedFirst?.classList.contains('multi-copy-first')
                && keyboardPastedFirst?.style.letterSpacing === '0.111em'
                && keyboardPastedSecond?.classList.contains('multi-copy-second')
                && keyboardPastedSecond?.style.wordSpacing === '0.222em',
            keyboardCopyUsesNewIds:
                keyboardPastedFirst?.dataset.vdocText !== firstId
                && keyboardPastedSecond?.dataset.vdocText !== secondId,
            menuCopyPastesTwoBlocks: Boolean(menuPastedFirst && menuPastedSecond),
            menuCopyKeepsStyles:
                menuPastedFirst?.classList.contains('multi-copy-first')
                && menuPastedSecond?.classList.contains('multi-copy-second'),
            originalsRemovedFromDom,
            originalsRemovedFromSource,
            cutPayloadCanRestore: Boolean(restoredFirst && restoredSecond),
            restoredUsesNewIds:
                restoredFirst?.dataset.vdocText !== firstId
                && restoredSecond?.dataset.vdocText !== secondId,
            sourceContainsRestoredStyles:
                sourceAfterRestore.includes('multi-copy-first')
                && sourceAfterRestore.includes('multi-copy-second')
        };
    })()`);

    console.log('[ScriptoriumMultiCopySmoke]', JSON.stringify(result, null, 2));
    const passed = Object.values(result).every(Boolean);
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error('[ScriptoriumMultiCopySmoke] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());