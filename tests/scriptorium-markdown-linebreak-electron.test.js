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

        const dispatchEnter = async () => {
            const currentEditor = root.querySelector(
                '[data-vdoc-flow-source-editor="true"]'
            );
            if (!currentEditor) return null;
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                composed: true,
                cancelable: true
            });
            currentEditor.dispatchEvent(enterEvent);
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            const nextEditor = root.querySelector(
                '[data-vdoc-flow-source-editor="true"]'
            );
            const currentSelection = root.getSelection
                ? root.getSelection()
                : window.getSelection();
            return {
                handled: enterEvent.defaultPrevented,
                editorConnected: Boolean(nextEditor?.isConnected),
                editorFocused: root.activeElement === nextEditor,
                caretInEditor: Boolean(
                    nextEditor
                    && currentSelection?.anchorNode
                    && nextEditor.contains(currentSelection.anchorNode)
                )
            };
        };

        const firstEnter = await dispatchEnter();
        const afterEnter = source();

        // P0 最短复现：Enter → 退格 → Enter。退格可能把多行编辑器
        // 收回单行编辑器，但新编辑器必须继续持有焦点和有效光标。
        const firstCycleEditor = root.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        const firstCycleBackspace = new InputEvent('beforeinput', {
            inputType: 'deleteContentBackward',
            bubbles: true,
            composed: true,
            cancelable: true
        });
        firstCycleEditor?.dispatchEvent(firstCycleBackspace);
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const afterFirstCycleBackspace = source();
        const firstCycleEditorAfterBackspace = root.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        const firstCycleSelection = root.getSelection
            ? root.getSelection()
            : window.getSelection();
        const firstCycleShellAfterBackspace =
            firstCycleEditorAfterBackspace?.closest('[data-vdoc-edit-key]');
        const firstCycleBackspaceState = {
            handled: firstCycleBackspace.defaultPrevented,
            editorConnected: Boolean(firstCycleEditorAfterBackspace),
            editorFocused: root.activeElement === firstCycleEditorAfterBackspace,
            editorDomain:
                firstCycleEditorAfterBackspace?.dataset.vdocFlowDomain || null,
            shellKey:
                firstCycleShellAfterBackspace?.dataset.vdocEditKey || null,
            shellType:
                firstCycleShellAfterBackspace?.dataset.vdocEditType || null,
            shellFlowKind:
                firstCycleShellAfterBackspace?.dataset.vdocFlowKind || null,
            caretInEditor: Boolean(
                firstCycleEditorAfterBackspace
                && firstCycleSelection?.anchorNode
                && firstCycleEditorAfterBackspace.contains(
                    firstCycleSelection.anchorNode
                )
            ),
            sourceRestored: afterFirstCycleBackspace === before
        };
        const firstCycleRetryEnter = await dispatchEnter();
        const afterFirstCycleRetryEnter = source();

        const secondEnter = await dispatchEnter();
        const thirdEnter = await dispatchEnter();
        const afterThreeEnters = source();
        editor = root.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        if (!editor) {
            return {
                available: true,
                editorActivated: true,
                enterWasHandled: firstEnter?.handled === true,
                enterAddsOneCompositeBreak:
                    afterEnter.length === before.length + 3
                    && afterEnter.includes('  \\n')
                    && !afterEnter.includes('\\u200B'),
                threeConsecutiveEntersHandled:
                    secondEnter?.handled === true
                    && thirdEnter?.handled === true,
                editorSurvivesConsecutiveEnterReflow: false
            };
        }
        const protectedBreakCount = (
            afterThreeEnters.match(/\\u200B  \\n/g) || []
        ).length;
        const editorLineRects = [...editor.querySelectorAll(
            '.vdoc-md-live-preview-line'
        )].map((line) => {
            const rect = line.getBoundingClientRect();
            const style = getComputedStyle(line);
            const beforeStyle = getComputedStyle(line, '::before');
            return {
                tag: line.tagName,
                kind: line.dataset.vdocMdLineKind,
                className: line.className,
                empty: line.matches(':empty'),
                top: rect.top,
                height: rect.height,
                lineHeight: style.lineHeight,
                marginBlockStart: style.marginBlockStart,
                marginBlockEnd: style.marginBlockEnd,
                paddingBlockStart: style.paddingBlockStart,
                paddingBlockEnd: style.paddingBlockEnd,
                borderBlockStartWidth: style.borderBlockStartWidth,
                borderBlockEndWidth: style.borderBlockEndWidth,
                beforeContent: beforeStyle.content,
                beforeLineHeight: beforeStyle.lineHeight
            };
        });
        const editorLineSteps = editorLineRects.slice(1).map((rect, index) =>
            rect.top - editorLineRects[index].top
        );

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
        const editorAfterBackspace = root.querySelector(
            '[data-vdoc-flow-source-editor="true"]'
        );
        let enterAfterBackspace = null;
        if (editorAfterBackspace) {
            const retryEnterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                composed: true,
                cancelable: true
            });
            editorAfterBackspace.dispatchEvent(retryEnterEvent);
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            const editorAfterRetry = root.querySelector(
                '[data-vdoc-flow-source-editor="true"]'
            );
            const selectionAfterRetry = root.getSelection
                ? root.getSelection()
                : window.getSelection();
            enterAfterBackspace = {
                handled: retryEnterEvent.defaultPrevented,
                editorConnected: Boolean(editorAfterRetry?.isConnected),
                editorFocused: root.activeElement === editorAfterRetry,
                caretInEditor: Boolean(
                    editorAfterRetry
                    && selectionAfterRetry?.anchorNode
                    && editorAfterRetry.contains(selectionAfterRetry.anchorNode)
                ),
                sourceChanged: source() !== afterBackspace
            };
        }

        return {
            available: true,
            editorActivated: true,
            enterWasHandled: firstEnter?.handled === true,
            enterAddsOneCompositeBreak:
                afterEnter.length === before.length + 3
                && afterEnter.includes('  \\n')
                && !afterEnter.includes('\\u200B'),
            threeConsecutiveEntersHandled:
                secondEnter?.handled === true
                && thirdEnter?.handled === true,
            editorSurvivesConsecutiveEnterReflow:
                firstEnter?.editorConnected === true
                && secondEnter?.editorConnected === true
                && thirdEnter?.editorConnected === true
                && firstEnter?.caretInEditor === true
                && secondEnter?.caretInEditor === true
                && thirdEnter?.caretInEditor === true,
            enterBackspaceEnterWorks:
                firstCycleBackspaceState.handled === true
                && firstCycleBackspaceState.editorConnected === true
                && firstCycleBackspaceState.editorFocused === true
                && firstCycleBackspaceState.caretInEditor === true
                && firstCycleBackspaceState.sourceRestored === true
                && firstCycleRetryEnter?.handled === true
                && firstCycleRetryEnter?.editorConnected === true
                && firstCycleRetryEnter?.caretInEditor === true
                && afterFirstCycleRetryEnter === afterEnter,
            protectedEmptyLinesRendered: protectedBreakCount === 2,
            backspaceWasHandled: backspaceEvent.defaultPrevented,
            oneBackspaceRemovesLastProtectedLine:
                afterBackspace.length
                === afterThreeEnters.length - '\\u200B  \\n'.length,
            editorSurvivesBackspace:
                Boolean(editorAfterBackspace?.isConnected),
            enterAfterBackspaceWorks:
                enterAfterBackspace?.handled === true
                && enterAfterBackspace?.editorConnected === true
                && enterAfterBackspace?.caretInEditor === true
                && enterAfterBackspace?.sourceChanged === true,
            diagnostic: {
                inputType: backspaceEvent.inputType,
                editorConnected: editor.isConnected,
                editorIsActive: root.activeElement === editor,
                selectionBeforeBackspace,
                sourceDeltaAfterBackspace:
                    afterBackspace.length - before.length,
                protectedBreakCount,
                editorLineRects,
                editorLineSteps,
                firstEnter,
                firstCycleBackspaceState,
                firstCycleRetryEnter,
                secondEnter,
                thirdEnter,
                enterAfterBackspace
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