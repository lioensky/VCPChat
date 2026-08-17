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
        const htmlHeading =
            '<h1 style="text-align:center">于影升起的太陽</h1>';
        const markdownHeading = '# 1. 网络图片与普通 Markdown';
        const fixture = [
            htmlHeading,
            '',
            markdownHeading,
            '',
            '![网络图片](https://example.invalid/network-image.png)',
            '',
            '网络图片后的普通 Markdown。',
            '',
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

        const markdownHeadingShell = [...root.querySelectorAll(
            '[data-vdoc-edit-key][data-vdoc-edit-type="markdown"]'
        )].find((candidate) =>
            candidate.querySelector('h1')?.textContent
                === '1. 网络图片与普通 Markdown'
        );
        const markdownHeadingNode = markdownHeadingShell?.querySelector('h1');
        if (markdownHeadingNode) {
            const rect = markdownHeadingNode.getBoundingClientRect();
            markdownHeadingNode.dispatchEvent(new MouseEvent('click', {
                button: 0,
                bubbles: true,
                composed: true,
                cancelable: true,
                clientX: rect.right - 2,
                clientY: rect.top + rect.height / 2
            }));
            await waitFrames();
        }
        const markdownHeadingEditor = markdownHeadingShell?.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        const markdownHeadingText = markdownHeadingEditor
            ? [...markdownHeadingEditor.childNodes].find((node) =>
                node.nodeType === Node.TEXT_NODE
                && node.nodeValue?.includes('网络图片与普通 Markdown')
            )
            : null;
        if (markdownHeadingText) {
            const selection = root.getSelection
                ? root.getSelection()
                : window.getSelection();
            const range = document.createRange();
            range.setStart(markdownHeadingText, markdownHeadingText.length);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            markdownHeadingEditor.focus();
        }
        const markdownHeadingEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            composed: true,
            cancelable: true
        });
        markdownHeadingEditor?.dispatchEvent(markdownHeadingEnter);
        await waitFrames();
        const sourceAfterMarkdownHeadingEnter =
            window.ScriptoriumAgent.common.getSource({
                sourceKind: 'markdown-hybrid',
                startLine: 1,
                endLine: 30
            }).source;
        const markdownBoundaryEditor = root.querySelector(
            '[data-vdoc-flow-source-editor="true"][data-vdoc-flow-domain="markdown"]'
        );
        const markdownBoundarySelection = root.getSelection
            ? root.getSelection()
            : window.getSelection();
        const markdownBoundaryShell =
            markdownBoundaryEditor?.closest('[data-vdoc-edit-key]');
        const markdownHeadingEnterResult = {
            activated: Boolean(markdownHeadingEditor),
            handled: markdownHeadingEnter.defaultPrevented,
            insertedBlankLine: sourceAfterMarkdownHeadingEnter.includes(
                markdownHeading + '\\n↵\\n'
            ),
            movedToNewRegion:
                markdownBoundaryShell !== markdownHeadingShell,
            focusedNewRegion:
                root.activeElement === markdownBoundaryEditor,
            caretInNewRegion: Boolean(
                markdownBoundaryEditor
                && markdownBoundarySelection?.anchorNode
                && markdownBoundaryEditor.contains(
                    markdownBoundarySelection.anchorNode
                )
            )
        };
        markdownBoundaryEditor?.blur();
        await waitFrames();

        const headingShell = [...root.querySelectorAll(
            '[data-vdoc-edit-key][data-vdoc-edit-type="html"]'
        )].find((candidate) =>
            candidate.querySelector('h1')?.textContent === '于影升起的太陽'
        );
        const heading = headingShell?.querySelector('h1');
        if (headingShell && heading) {
            const rect = heading.getBoundingClientRect();
            heading.dispatchEvent(new MouseEvent('click', {
                button: 0,
                bubbles: true,
                composed: true,
                cancelable: true,
                clientX: rect.right - 2,
                clientY: rect.top + rect.height / 2
            }));
            await waitFrames();
        }
        const headingEditor = headingShell?.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        const visibleHeadingText = headingEditor
            ? [...headingEditor.querySelectorAll('h1')]
                .flatMap((node) => [...node.childNodes])
                .find((node) =>
                    node.nodeType === Node.TEXT_NODE
                    && node.nodeValue === '于影升起的太陽'
                )
            : null;
        if (visibleHeadingText) {
            const selection = root.getSelection
                ? root.getSelection()
                : window.getSelection();
            const range = document.createRange();
            range.setStart(visibleHeadingText, visibleHeadingText.length);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            headingEditor.focus();
        }
        const enter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            composed: true,
            cancelable: true
        });
        headingEditor?.dispatchEvent(enter);
        await waitFrames();
        const sourceAfterHeadingEnter =
            window.ScriptoriumAgent.common.getSource({
                sourceKind: 'markdown-hybrid',
                startLine: 1,
                endLine: 20
            }).source;
        const boundaryEditor = root.querySelector(
            '[data-vdoc-flow-source-editor="true"][data-vdoc-flow-domain="markdown"]'
        );
        const selectionAfterHeadingEnter = root.getSelection
            ? root.getSelection()
            : window.getSelection();
        const boundaryFocused = root.activeElement === boundaryEditor;
        const boundaryCaretRestored = Boolean(
            boundaryEditor
            && selectionAfterHeadingEnter?.anchorNode
            && boundaryEditor.contains(selectionAfterHeadingEnter.anchorNode)
        );
        const secondEnter = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            composed: true,
            cancelable: true
        });
        boundaryEditor?.dispatchEvent(secondEnter);
        await waitFrames();
        const sourceAfterSecondEnter =
            window.ScriptoriumAgent.common.getSource({
                sourceKind: 'markdown-hybrid',
                startLine: 1,
                endLine: 20
            }).source;
        const editorAfterSecondEnter = root.querySelector(
            '[data-vdoc-flow-source-editor="true"][data-vdoc-flow-domain="markdown"]'
        );
        const selectionAfterSecondEnter = root.getSelection
            ? root.getSelection()
            : window.getSelection();

        return {
            count: shells.length,
            results,
            markdownHeadingEnter: markdownHeadingEnterResult,
            htmlHeadingEnter: {
                activated: Boolean(headingEditor),
                handled: enter.defaultPrevented,
                insertedAfterElement: sourceAfterHeadingEnter.startsWith(
                    htmlHeading + '\\n\\n\\u200B'
                ),
                boundaryEditorActivated: Boolean(boundaryEditor),
                boundaryFocused,
                boundaryCaretRestored,
                secondEnterHandled: secondEnter.defaultPrevented,
                secondEnterChangedSource:
                    sourceAfterSecondEnter !== sourceAfterHeadingEnter,
                editorSurvivesSecondEnter:
                    Boolean(editorAfterSecondEnter?.isConnected),
                caretSurvivesSecondEnter: Boolean(
                    editorAfterSecondEnter
                    && selectionAfterSecondEnter?.anchorNode
                    && editorAfterSecondEnter.contains(
                        selectionAfterSecondEnter.anchorNode
                    )
                ),
                source: sourceAfterSecondEnter
            }
        };
    })().catch((error) => ({
        executionError: {
            name: error?.name || 'Error',
            message: error?.message || String(error),
            stack: error?.stack || ''
        }
    }))`);

    result.warnings = warnings;
    console.log('[ScriptoriumQuoteLayout]', JSON.stringify(result, null, 2));
    const passed = !result.executionError
        && result.count === 2
        && result.results.every((entry) => entry.activated)
        && result.markdownHeadingEnter?.activated === true
        && result.markdownHeadingEnter?.handled === true
        && result.markdownHeadingEnter?.insertedBlankLine === true
        && result.markdownHeadingEnter?.movedToNewRegion === true
        && result.markdownHeadingEnter?.focusedNewRegion === true
        && result.markdownHeadingEnter?.caretInNewRegion === true
        && result.htmlHeadingEnter?.activated === true
        && result.htmlHeadingEnter?.handled === true
        && result.htmlHeadingEnter?.insertedAfterElement === true
        && result.htmlHeadingEnter?.boundaryEditorActivated === true
        && result.htmlHeadingEnter?.boundaryFocused === true
        && result.htmlHeadingEnter?.boundaryCaretRestored === true
        && result.htmlHeadingEnter?.secondEnterHandled === true
        && result.htmlHeadingEnter?.secondEnterChangedSource === true
        && result.htmlHeadingEnter?.editorSurvivesSecondEnter === true
        && result.htmlHeadingEnter?.caretSurvivesSecondEnter === true
        && result.warnings.length === 0;
    await windowRef.close();
    app.exit(passed ? 0 : 1);
}).catch((error) => {
    console.error('[ScriptoriumQuoteLayout] FAILED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());