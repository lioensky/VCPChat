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
    ipcMain.handle('scriptorium:svg-assets-save', () => ({
        success: true,
        count: 0,
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

    const warnings = [];
    windowRef.webContents.on('console-message', (...args) => {
        const details = args.find((value) =>
            value && typeof value === 'object'
            && typeof value.message === 'string'
        );
        const message = details?.message ?? args[2] ?? '';
        if (String(message).includes('Lossless edit mapping failed')) {
            warnings.push(String(message));
        }
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
    await new Promise((resolve) => setTimeout(resolve, 1400));

    const result = await windowRef.webContents.executeJavaScript(`(async () => {
        const waitFrames = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        document.getElementById('html-mode-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const codeMirror = document.querySelector(
            '.source-editor-shell .CodeMirror'
        )?.CodeMirror;
        const tick = String.fromCharCode(96);
        const fixture = [
            '> 这是一份用于验证 Markdown-first、原生 HTML、LaTeX、Mermaid、网络媒体、Anime.js、CSS 3D、动态表格与局部文字特效能否在同一份源码中稳定共存的测试文档。',
            '',
            '> **岛闭合规则：** 每个可编程岛从带有 '
                + tick + 'data-vdoc-island' + tick + ' 的根 '
                + tick + '<div>' + tick + ' 开始，到与该根匹配的最后一个 '
                + tick + '</div>' + tick
                + ' 结束。岛的结构、局部样式、依赖声明和执行脚本必须全部位于这个范围内，任何岛内状态都不得泄漏到后续 Markdown 正文。',
            '',
            '普通段落第一行。'
        ].join('\\n');
        codeMirror.setValue(fixture);
        await new Promise((resolve) => setTimeout(resolve, 180));
        document.getElementById('render-mode-btn').click();
        await waitFrames();

        const root = document.getElementById('page-stream').shadowRoot;
        const snapshot = (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return {
                tag: node.tagName,
                html: node.outerHTML,
                text: node.textContent,
                height: rect.height,
                lineHeight: style.lineHeight,
                marginBlockStart: style.marginBlockStart,
                marginBlockEnd: style.marginBlockEnd,
                paddingBlockStart: style.paddingBlockStart,
                paddingBlockEnd: style.paddingBlockEnd
            };
        };
        const shells = [...root.querySelectorAll(
            '[data-vdoc-edit-key][data-vdoc-edit-type="markdown"]'
        )].filter((shell) => shell.querySelector('blockquote'));

        const results = [];
        for (const shell of shells) {
            const beforeNode = shell.firstElementChild;
            const before = snapshot(beforeNode);
            const rect = beforeNode.getBoundingClientRect();
            beforeNode.dispatchEvent(new MouseEvent('click', {
                button: 0,
                bubbles: true,
                composed: true,
                cancelable: true,
                clientX: rect.left + Math.min(24, rect.width / 2),
                clientY: rect.top + Math.min(12, rect.height / 2)
            }));
            await waitFrames();
            const editor = shell.querySelector(
                '[data-vdoc-flow-source-editor="true"]'
            );
            results.push({
                activated: Boolean(editor),
                activeElementIsEditor: root.activeElement === editor,
                before,
                after: editor ? snapshot(editor) : null
            });
            editor?.blur();
            await waitFrames();
        }
        return { count: shells.length, results };
    })()`);

    result.warnings = warnings;
    console.log('[ScriptoriumQuoteLayout]', JSON.stringify(result, null, 2));
    const passed = result.count === 2
        && result.results.every((entry) => entry.activated)
        && result.warnings.length === 0;
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error('[ScriptoriumQuoteLayout] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());