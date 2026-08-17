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
    ipcMain.handle('scriptorium:document-library', () => ({
        success: true,
        documents: [],
    }));
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
    ipcMain.handle('scriptorium:style-packs-load', () => []);
    ipcMain.handle('scriptorium:style-packs-save', (_event, packs = []) => ({
        success: true,
        count: packs.length,
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
            // 必须命中普通 paragraph token。旧条件 querySelector('p')
            // 会优先选中 blockquote > p，使测试完全绕过“静态 p 被拆成
            // 多个逐行 p，段级 margin 重复执行”的真实回归。
            && node.firstElementChild?.matches('p')
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
        let caretNode = null;
        let candidate = textNode.nextNode();
        while (candidate) {
            const parent = candidate.parentElement;
            if ((candidate.nodeValue || '').length
                && !parent?.closest?.('[data-vdoc-md-marker]')) {
                caretNode = candidate;
            }
            candidate = textNode.nextNode();
        }
        if (!caretNode) {
            return {
                available: true,
                editorActivated: true,
                internalCaretAvailable: false
            };
        }
        // 核心回归：光标必须位于段落短尾，而不是正文中部。末端 Enter
        // 只写入真换行与显式 ↵ 锚点，使 Markdown、渲染、拖选与源码
        // 使用同一条可观察的换行语义。
        const caretOffset = caretNode.length;
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
                    afterEnter.length === before.length + 2
                    && afterEnter.includes('\\n↵'),
                threeConsecutiveEntersHandled:
                    secondEnter?.handled === true
                    && thirdEnter?.handled === true,
                editorSurvivesConsecutiveEnterReflow: false
            };
        }
        const paragraphBreakCount = (
            afterThreeEnters.match(/^↵$/gm) || []
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
        const paragraphLinesAreNeutralBoxes = editorLineRects
            .filter((line) => line.kind === 'paragraph')
            .every((line) => line.tag === 'DIV');

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
        // 后续 retry Enter 会同步重建编辑树，使这里保存的旧节点断开。
        // 必须在派发下一次 Enter 前快照退格后的实际存活状态。
        const editorSurvivedBackspace =
            Boolean(editorAfterBackspace?.isConnected);
        let enterAfterBackspace = null;
        let placeholderInput = null;
        let repeatedPlaceholderTyping = null;
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

            const beforePlaceholderInput = source();
            const insertTextEvent = new InputEvent('beforeinput', {
                inputType: 'insertText',
                data: '新行文字',
                bubbles: true,
                composed: true,
                cancelable: true
            });
            editorAfterRetry?.dispatchEvent(insertTextEvent);
            await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            const afterPlaceholderInput = source();
            placeholderInput = {
                handled: insertTextEvent.defaultPrevented,
                inserted: afterPlaceholderInput.includes('新行文字'),
                placeholderReplaced:
                    afterPlaceholderInput.length
                    === beforePlaceholderInput.length - 1 + '新行文字'.length
                    && !afterPlaceholderInput.includes('↵新行文字')
                    && !afterPlaceholderInput.includes('新行文字↵')
            };

            const stressFailures = [];
            for (let index = 0; index < 24; index += 1) {
                const activeEditor = root.querySelector(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const stressEnter = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    composed: true,
                    cancelable: true
                });
                activeEditor?.dispatchEvent(stressEnter);
                await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve))
                );

                const editorWithPlaceholder = root.querySelector(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const value = ' 压力输入' + index;
                const stressInput = new InputEvent('beforeinput', {
                    inputType: 'insertText',
                    data: value,
                    bubbles: true,
                    composed: true,
                    cancelable: true
                });
                editorWithPlaceholder?.dispatchEvent(stressInput);
                await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve))
                );

                const currentSource = source();
                const expected = '压力输入' + index;
                const currentEditor = root.querySelector(
                    '[data-vdoc-flow-source-editor="true"]'
                );
                const currentSelection = root.getSelection
                    ? root.getSelection()
                    : window.getSelection();
                const valid = stressEnter.defaultPrevented
                    && stressInput.defaultPrevented
                    && currentSource.includes('\\n' + expected)
                    && !currentSource.includes('\\n↵' + value)
                    && !currentSource.includes('\\n' + value)
                    && root.activeElement === currentEditor
                    && Boolean(
                        currentEditor
                        && currentSelection?.anchorNode
                        && currentEditor.contains(currentSelection.anchorNode)
                    );
                if (!valid) {
                    stressFailures.push({
                        index,
                        stressEnterHandled: stressEnter.defaultPrevented,
                        stressInputHandled: stressInput.defaultPrevented,
                        sourceTail: currentSource.slice(-120)
                    });
                    break;
                }
            }
            repeatedPlaceholderTyping = {
                passed: stressFailures.length === 0,
                failures: stressFailures
            };
        }

        return {
            available: true,
            editorActivated: true,
            enterWasHandled: firstEnter?.handled === true,
            enterAddsOneCompositeBreak:
                afterEnter.length === before.length + 2
                && afterEnter.includes('\\n↵'),
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
            protectedEmptyLinesRendered: paragraphBreakCount === 3,
            paragraphLinesDoNotRepeatParagraphBoxes:
                paragraphLinesAreNeutralBoxes,
            backspaceWasHandled: backspaceEvent.defaultPrevented,
            oneBackspaceRemovesLastProtectedLine:
                afterBackspace.length
                === afterThreeEnters.length - '\\n↵'.length,
            editorSurvivesBackspace: editorSurvivedBackspace,
            enterAfterBackspaceWorks:
                enterAfterBackspace?.handled === true
                && enterAfterBackspace?.editorConnected === true
                && enterAfterBackspace?.caretInEditor === true
                && enterAfterBackspace?.sourceChanged === true,
            typingReplacesParagraphBreak:
                placeholderInput?.handled === true
                && placeholderInput?.inserted === true
                && placeholderInput?.placeholderReplaced === true,
            repeatedPlaceholderTypingIsStable:
                repeatedPlaceholderTyping?.passed === true,
            diagnostic: {
                inputType: backspaceEvent.inputType,
                editorConnected: editor.isConnected,
                editorIsActive: root.activeElement === editor,
                selectionBeforeBackspace,
                sourceDeltaAfterBackspace:
                    afterBackspace.length - before.length,
                paragraphBreakCount,
                editorLineRects,
                editorLineSteps,
                firstEnter,
                firstCycleBackspaceState,
                firstCycleRetryEnter,
                secondEnter,
                thirdEnter,
                enterAfterBackspace,
                placeholderInput,
                repeatedPlaceholderTyping
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