'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');

const projectRoot = path.resolve(__dirname, '..');
const SMOKE_TIMEOUT_MS = 120000;
let windowRef = null;
let smokeWatchdog = null;

function progress(stage) {
    console.log(`[ScriptoriumSmoke] Stage: ${stage}`);
}

function finish(exitCode) {
    if (smokeWatchdog) {
        clearTimeout(smokeWatchdog);
        smokeWatchdog = null;
    }
    app.exit(exitCode);
}

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('load-agents-list', () => []);
    ipcMain.handle('load-user-avatar', () => null);
    ipcMain.handle('load-agent-avatar', () => null);
    ipcMain.handle('docx:fonts-list', () => [
        'Arial',
        'Calibri',
        'Microsoft YaHei',
        'Noto Serif CJK SC',
        'SimSun',
        'Times New Roman',
    ]);
    ipcMain.handle('docx:choose-open', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:choose-import', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:read-path', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:save', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:export-rich-document', () => ({ success: false, canceled: true }));
    ipcMain.handle('open-docx-window', () => ({ success: true }));

    ipcMain.on('window-lifecycle:ready', (_event, payload) => {
        console.log('[ScriptoriumSmoke] Renderer ready:', JSON.stringify(payload));
    });
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => app.quit());
    ipcMain.on('open-dev-tools', () => {});
}

app.whenReady().then(async () => {
    smokeWatchdog = setTimeout(() => {
        console.error(
            `[ScriptoriumSmoke] TIMEOUT after ${SMOKE_TIMEOUT_MS} ms; forcing exit.`
        );
        finish(1);
    }, SMOKE_TIMEOUT_MS);
    progress('register-ipc');
    registerMinimalIpc();

    progress('create-window');
    windowRef = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false,
        frame: false,
        webPreferences: {
            preload: path.join(projectRoot, 'preloads', 'docx.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    const errors = [];
    windowRef.webContents.on('console-message', (...args) => {
        const details = args.find((value) => value && typeof value === 'object' && typeof value.message === 'string');
        const level = details?.level ?? args[1];
        const message = details?.message ?? args[2] ?? 'Unknown renderer message';
        const lineNumber = details?.lineNumber ?? args[3];
        const sourceId = details?.sourceId ?? args[4];
        console.log(`[Renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
        if (level === 'error' || level === 3) errors.push(message);
    });
    windowRef.webContents.on('render-process-gone', (_event, details) => {
        errors.push(`render-process-gone: ${details.reason}`);
    });

    progress('load-editor');
    await windowRef.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    progress('create-document');
    await windowRef.webContents.executeJavaScript(`document.getElementById('welcome-new-btn').click()`);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    progress('submit-agent-pr');
    const approvalPending = await windowRef.webContents.executeJavaScript(`(() => {
        const api = window.ScriptoriumAgent;
        const before = api.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 80
        });
        const info = api.common.getDocumentInfo();
        window.__scriptoriumApprovalPromise = api.common.submitSourcePr({
            requestId: 'scriptorium-smoke-pr-approval',
            author: { id: 'smoke-agent', name: '冒烟测试 Agent', type: 'agent' },
            summary: '验证人类审批前不修改源码',
            expectedRevision: info.revision,
            sourceKind: 'html',
            replacements: [{
                target: '未命名文稿',
                replace: '审批后文稿',
                startLine: 1
            }]
        });
        const afterSubmit = api.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 80
        });
        const pending = api.review.listPending();
        return {
            pendingCount: pending.length,
            pendingAuthor: pending[0]?.author?.name || '',
            pendingStatus: pending[0]?.status || '',
            sourceUnchangedBeforeApproval:
                before.source === afterSubmit.source
                && afterSubmit.source.includes('未命名文稿'),
            hasPendingCard: Boolean(document.querySelector('.checkpoint-item.pending')),
            hasPendingAvatar: Boolean(
                document.querySelector(
                    '.checkpoint-item.pending .checkpoint-avatar.agent[role="img"]'
                )
            ),
            pendingCounter: document.getElementById('pending-pr-count')?.textContent
        };
    })()`);

    progress('approve-agent-pr');
    const approvalResult = await windowRef.webContents.executeJavaScript(`(async () => {
        const receipt = document.querySelector('.checkpoint-item.pending .pr-inline-receipt');
        const approve = document.querySelector('.checkpoint-item.pending .pr-approve');
        if (!receipt || !approve) return { uiAvailable: false };
        receipt.value = '内容准确，允许合并。';
        approve.click();
        const result = await window.__scriptoriumApprovalPromise;
        const source = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 80
        });
        return {
            uiAvailable: true,
            success: result?.success === true,
            receiptMessage: result?.receipt?.message || '',
            receiptDecision: result?.receipt?.decision || '',
            authorName: result?.pr?.author?.name || '',
            status: result?.pr?.status || '',
            sourceChangedAfterApproval: source.source.includes('审批后文稿')
                && !source.source.includes('未命名文稿'),
            pendingCountAfterApproval: window.ScriptoriumAgent.review.listPending().length,
            pendingCounterAfterApproval:
                document.getElementById('pending-pr-count')?.textContent
        };
    })()`);

    progress('advanced-style-interaction');
    const interaction = await windowRef.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const editable = root.querySelector('[data-vdoc-text]');
        const textNode = editable?.firstChild;
        if (!editable || !textNode) return { selected: false };

        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(4, textNode.length));
        const selection = root.getSelection ? root.getSelection() : window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        editable.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: 420,
            clientY: 260
        }));

        document.getElementById('advanced-style-btn').click();
        const dialogVisible = !document.getElementById('style-library-dialog').hidden;
        const styleCount = document.querySelectorAll('#style-library-list .style-card').length;
        const previewReady = Boolean(document.getElementById('style-preview-frame').srcdoc);
        document.getElementById('style-apply-btn').click();

        return {
            selected: true,
            dialogVisible,
            styleCount,
            previewReady,
            appliedStyleNode: Boolean(root.querySelector('[data-vdoc-style]')),
            compiledStyle: root.querySelector('style')?.textContent.includes('vds-') || false
        };
    })()`);

    progress('source-and-math-interaction');
    await windowRef.webContents.executeJavaScript(`document.getElementById('html-mode-btn').click()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mathInteraction = await windowRef.webContents.executeJavaScript(`(() => {
        const codeMirror = document.querySelector('.source-editor-shell .CodeMirror')?.CodeMirror;
        if (!codeMirror) return { hasCodeMirror: false };
        codeMirror.setValue(codeMirror.getValue()
            + '<p>质能关系：<span class="vdoc-math vdoc-math-inline" data-vdoc-math="E%3Dmc%5E2" data-vdoc-display="false">E=mc^2</span></p>');
        document.getElementById('apply-source-btn').click();
        const root = document.getElementById('page-stream').shadowRoot;
        const renderedMath = root.querySelector('[data-vdoc-math]');
        const hasKatexVisual = Boolean(renderedMath?.querySelector('.katex'));
        document.getElementById('html-mode-btn').click();
        const semanticSource = codeMirror.getValue();
        const wrapToggle = document.getElementById('source-wrap-toggle');
        const sourceBeforeWrapToggle = codeMirror.getValue();
        wrapToggle.checked = false;
        wrapToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const wrapDisabled = codeMirror.getOption('lineWrapping') === false;
        wrapToggle.checked = true;
        wrapToggle.dispatchEvent(new Event('change', { bubbles: true }));
        const wrapEnabled = codeMirror.getOption('lineWrapping') === true;
        const hadLightTheme = document.body.classList.contains('light-theme');
        document.body.classList.add('light-theme');
        const lightEditorBackground = getComputedStyle(
            document.querySelector('.source-editor-shell .CodeMirror')
        ).backgroundColor;
        if (!hadLightTheme) document.body.classList.remove('light-theme');

        codeMirror.setValue(codeMirror.getValue() + Array.from(
            { length: 72 },
            (_, index) => '<p>分页回归段落 ' + (index + 1)
                + '：这是一段用于验证源码模式返回渲染模式后仍能正确分页的测试文字。</p>'
        ).join('\\n'));

        return {
            hasCodeMirror: true,
            hasLineNumbers: Boolean(document.querySelector('.CodeMirror-linenumbers')),
            isMultilineSource: semanticSource.split('\\n').length > 3,
            hasIndentedSource: /\\n\\s{4}</.test(semanticSource),
            wrapDisabled,
            wrapEnabled,
            wrapPreservesSource: codeMirror.getValue().includes('分页回归段落 72'),
            diagnostics: document.getElementById('source-diagnostics').textContent,
            hasKatexRuntime: Boolean(window.katex),
            hasKatexVisual,
            sourceKeepsLatex: semanticSource.includes('data-vdoc-math="E%3Dmc%5E2"'),
            sourceExcludesDerivedKatex: !semanticSource.includes('katex-html'),
            lightEditorBackground,
            lightEditorAdapted: !/rgb\\(17,\\s*22,\\s*20\\)/.test(lightEditorBackground)
                && !/rgb\\(13,\\s*18,\\s*16\\)/.test(lightEditorBackground)
        };
    })()`);

    progress('mode-switch-and-pagination');
    await windowRef.webContents.executeJavaScript(`document.getElementById('render-mode-btn').click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const modeSwitchInteraction = await windowRef.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const flowRuntime = root.querySelector('.vdoc-flow-runtime');
        const plainBlock = [...root.querySelectorAll('[data-vdoc-text]')]
            .find((node) => !node.querySelector('img, table, [data-vdoc-math]'));
        const plainEstimate = plainBlock
            ? window.ScriptoriumPretext?.estimateBlock(plainBlock, plainBlock.clientWidth)
            : null;
        const table = root.querySelector('table');
        const complexEstimate = table
            ? window.ScriptoriumPretext?.estimateBlock(table, table.clientWidth)
            : window.ScriptoriumPretext?.complexityOf(
                Object.assign(document.createElement('table'), { innerHTML: '<tr><td>复杂块</td></tr>' })
            );
        const flowStyle = getComputedStyle(flowRuntime);
        document.getElementById('read-mode-btn').click();
        const readRoot = document.getElementById('read-page-stream').shadowRoot;
        const previewPages = readRoot.querySelectorAll('.vdoc-page');
        const previewEditable = readRoot.querySelector('[contenteditable="true"]');
        const previewPageStyle = previewPages.length ? getComputedStyle(previewPages[0]) : null;
        const previewContent = readRoot.querySelector('.vdoc-page-content');
        const previewContentStyle = previewContent ? getComputedStyle(previewContent) : null;
        const status = document.getElementById('page-status').textContent;
        document.getElementById('render-mode-btn').click();
        return {
            renderVisible: !document.getElementById('render-host').hidden,
            sourceHidden: document.getElementById('source-host').hidden,
            continuousEditorHasNoPages: root.querySelectorAll('.vdoc-page').length === 0,
            hasContinuousRuntime: Boolean(flowRuntime),
            previewPageCount: previewPages.length,
            readingRemainsPaginated: previewPages.length > 1,
            readingIsReadonly: !previewEditable,
            readingStatus: status,
            editorBackground: flowStyle.backgroundColor,
            editorTextColor: flowStyle.color,
            editorIsTransparent: flowStyle.backgroundColor === 'rgba(0, 0, 0, 0)',
            editorTextIsReadable: flowStyle.color === getComputedStyle(document.body).color,
            readingPageBackground: previewPageStyle?.backgroundColor || '',
            readingContentBackground: previewContentStyle?.backgroundColor || '',
            readingTextColor: previewContentStyle?.color || '',
            readingUsesPaper: previewPageStyle?.backgroundColor === 'rgb(255, 253, 248)'
                && previewContentStyle?.backgroundColor === 'rgb(255, 253, 248)',
            readingUsesDarkInk: previewContentStyle?.color === 'rgb(29, 36, 33)',
            pretextReady: Boolean(window.Pretext?.prepare && window.ScriptoriumPretext?.isReady?.()),
            plainEstimateReady: Boolean(
                plainEstimate
                && Number.isFinite(plainEstimate.height)
                && plainEstimate.confidence >= .7
                && !plainEstimate.requiresDomMeasurement
            ),
            complexUsesDomFallback: complexEstimate?.requiresDomMeasurement === true,
            hasLastRegressionParagraph: [...root.querySelectorAll('[data-vdoc-text]')]
                .some((node) => (node.textContent || '').includes('分页回归段落 72'))
        };
    })()`);
    progress('formatting-interaction');
    const formattingInteraction = await windowRef.webContents.executeJavaScript(`(async () => {
        const root = document.getElementById('page-stream').shadowRoot;
        const editable = [...root.querySelectorAll('[data-vdoc-text]')]
            .find((node) => node.firstChild?.nodeType === Node.TEXT_NODE && node.firstChild.length >= 2);
        if (!editable) return { available: false };

        const textNode = editable.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(2, textNode.length));
        const selection = root.getSelection ? root.getSelection() : window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        editable.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: 430,
            clientY: 270
        }));

        const quickFont = document.getElementById('selection-font-family');
        quickFont.value = 'Microsoft YaHei';
        quickFont.dispatchEvent(new Event('change', { bubbles: true }));

        const styledSpan = [...editable.querySelectorAll('span')]
            .find((node) => node.style.fontFamily.includes('Microsoft YaHei'));
        styledSpan?.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            composed: true
        }));
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        const toggleBlock = [...root.querySelectorAll('[data-vdoc-text]')]
            .find((node) => (node.textContent || '').includes('分页回归段落 72'))
            || editable;
        const toggleCommands = ['bold', 'italic', 'underline', 'strikethrough'];
        const toggleResults = {};

        const commandIsActive = (element, command) => {
            const computed = getComputedStyle(element);
            if (command === 'bold') return Number.parseFloat(computed.fontWeight) >= 600;
            if (command === 'italic') return /^(?:italic|oblique)/i.test(computed.fontStyle);
            const decoration = computed.textDecorationLine || computed.textDecoration || '';
            return decoration.includes(
                command === 'underline' ? 'underline' : 'line-through'
            );
        };

        for (const command of toggleCommands) {
            const candidate = [...toggleBlock.childNodes]
                .find((node) => node.nodeType === Node.TEXT_NODE && node.length >= 4)
                || toggleBlock.firstChild;
            if (!candidate) {
                toggleResults[command] = { applied: false, removed: false };
                continue;
            }
            const commandRange = document.createRange();
            commandRange.setStart(candidate, 0);
            commandRange.setEnd(candidate, Math.min(4, candidate.length || 0));
            selection.removeAllRanges();
            selection.addRange(commandRange);
            toggleBlock.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                composed: true
            }));

            const button = document.querySelector(\`[data-command="\${command}"]\`);
            button.click();
            const appliedNode = selection.focusNode?.nodeType === Node.ELEMENT_NODE
                ? selection.focusNode
                : selection.focusNode?.parentElement;
            const applied = commandIsActive(appliedNode || toggleBlock, command);
            button.click();
            const removedNode = selection.focusNode?.nodeType === Node.ELEMENT_NODE
                ? selection.focusNode
                : selection.focusNode?.parentElement;
            toggleResults[command] = {
                applied,
                removed: !commandIsActive(removedNode || toggleBlock, command)
            };
        }

        return {
            available: true,
            quickFontApplied: Boolean(styledSpan),
            computedFont: styledSpan ? getComputedStyle(styledSpan).fontFamily : '',
            topFontRecognized: document.getElementById('font-family-select').value === 'Microsoft YaHei',
            quickFontRecognized: quickFont.value === 'Microsoft YaHei',
            inlineToggleResults: toggleResults,
            inlineToggleMarkersCleaned:
                !root.querySelector('[data-vdoc-format-removal]'),
            sourceContainsFont: document.getElementById('html-mode-btn')
                ? true
                : false
        };
    })()`);

    progress('copied-heading-paste-interaction');
    const copiedHeadingPasteInteraction = await windowRef.webContents.executeJavaScript(`(async () => {
        const root = document.getElementById('page-stream').shadowRoot;
        const headings = [...root.querySelectorAll('h1[data-vdoc-text], h2[data-vdoc-text]')];
        if (headings.length < 2) return { available: false };

        const copied = headings[0];
        const target = headings[1];
        const copiedId = copied.dataset.vdocText;
        const targetId = target.dataset.vdocText;
        const selection = root.getSelection ? root.getSelection() : window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);

        const clipboard = new DataTransfer();
        clipboard.setData('text/plain', copied.textContent || '');
        clipboard.setData('text/html', copied.outerHTML);
        target.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clipboardData: clipboard
        }));

        target.appendChild(document.createTextNode(' · 可保存'));
        target.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertText',
            data: ' · 可保存'
        }));
        await new Promise((resolve) => setTimeout(resolve, 2300));

        const source = window.ScriptoriumAgent.common.getSource({
            sourceKind: 'html',
            startLine: 1,
            endLine: 200
        }).source;
        const sourceTemplate = document.createElement('template');
        sourceTemplate.innerHTML = source;
        const storedTarget = sourceTemplate.content.querySelector(
            '[data-vdoc-text="' + CSS.escape(targetId) + '"]'
        );
        const storedCopied = sourceTemplate.content.querySelector(
            '[data-vdoc-text="' + CSS.escape(copiedId) + '"]'
        );
        const sourceIds = [...sourceTemplate.content.querySelectorAll('[data-vdoc-text]')]
            .map((node) => node.dataset.vdocText);

        const duplicateFixture = window.VDocCore.ensureTextNodeIds(
            '<section data-vdoc-container="duplicate-container">'
            + '<h1 data-vdoc-text="duplicate-text" data-vdoc-block="duplicate-block">甲</h1>'
            + '<section data-vdoc-container="duplicate-container">'
            + '<h2 data-vdoc-text="duplicate-text" data-vdoc-block="duplicate-block">乙</h2>'
            + '</section></section>'
        );
        const normalizedTemplate = document.createElement('template');
        normalizedTemplate.innerHTML = duplicateFixture;
        const normalizedTextIds = [
            ...normalizedTemplate.content.querySelectorAll('[data-vdoc-text]')
        ].map((node) => node.dataset.vdocText);
        const normalizedBlockIds = [
            ...normalizedTemplate.content.querySelectorAll('[data-vdoc-block]')
        ].map((node) => node.dataset.vdocBlock);
        const normalizedContainerIds = [
            ...normalizedTemplate.content.querySelectorAll('[data-vdoc-container]')
        ].map((node) => node.dataset.vdocContainer);

        return {
            available: true,
            pasteDefaultPrevented: target.textContent === (copied.textContent || '') + ' · 可保存',
            pastedIdentityNotNested: !target.querySelector(
                '[data-vdoc-text], [data-vdoc-block], [data-vdoc-container]'
            ),
            renderedIdsRemainUnique: new Set(
                [...root.querySelectorAll('[data-vdoc-text]')]
                    .map((node) => node.dataset.vdocText)
            ).size === root.querySelectorAll('[data-vdoc-text]').length,
            sourceIdsRemainUnique: new Set(sourceIds).size === sourceIds.length,
            targetEditSaved: storedTarget?.textContent === (copied.textContent || '') + ' · 可保存',
            originalHeadingUnaffected: storedCopied?.textContent === copied.textContent,
            duplicateTextIdsReissued:
                new Set(normalizedTextIds).size === normalizedTextIds.length,
            duplicateBlockIdsReissued:
                new Set(normalizedBlockIds).size === normalizedBlockIds.length,
            duplicateContainerIdsReissued:
                new Set(normalizedContainerIds).size === normalizedContainerIds.length
        };
    })()`);

    progress('range-selection-interaction');
    const rangeSelectionInteraction = await windowRef.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const blocks = [...root.querySelectorAll('[data-vdoc-text]')]
            .filter((node) => (node.textContent || '').trim().length >= 2)
            .slice(0, 2);
        if (blocks.length < 2) return { available: false };

        blocks[0].dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            buttons: 1,
            bubbles: true,
            composed: true,
            cancelable: true
        }));
        blocks[0].dispatchEvent(new PointerEvent('pointerup', {
            button: 0,
            bubbles: true,
            composed: true
        }));
        blocks[1].dispatchEvent(new PointerEvent('pointerdown', {
            button: 0,
            buttons: 1,
            shiftKey: true,
            bubbles: true,
            composed: true,
            cancelable: true
        }));
        blocks[1].dispatchEvent(new PointerEvent('pointerup', {
            button: 0,
            shiftKey: true,
            bubbles: true,
            composed: true
        }));
        const explicitSelectedCount = root.querySelectorAll(
            '[data-vdoc-text][data-vdoc-editor-selected="true"]'
        ).length;
        const explicitSelectionStatus = document.getElementById('selection-status').textContent;

        const firstText = [...blocks[0].childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
            || blocks[0].firstChild;
        const lastText = [...blocks[1].childNodes].reverse()
            .find((node) => node.nodeType === Node.TEXT_NODE) || blocks[1].lastChild;
        if (!firstText || !lastText) return { available: false };

        const range = document.createRange();
        range.setStart(firstText, 0);
        range.setEnd(lastText, Math.min(2, lastText.length || 0));
        const selection = root.getSelection ? root.getSelection() : window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        blocks[0].dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: 440,
            clientY: 280
        }));

        const quickSize = document.getElementById('selection-font-size');
        quickSize.value = '18pt';
        quickSize.dispatchEvent(new Event('change', { bubbles: true }));
        const styledBlocks = blocks.filter((block) =>
            [...block.querySelectorAll('span')].some((span) => span.style.fontSize === '18pt')
        );

        const nextRange = document.createRange();
        nextRange.selectNodeContents(blocks[0]);
        nextRange.setEndAfter(blocks[1]);
        selection.removeAllRanges();
        selection.addRange(nextRange);
        blocks[0].dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            composed: true
        }));
        document.querySelector('[data-command="text-align"][data-value="center"]').click();

        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'a',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
        }));
        const allSelectedText = selection.toString();
        const allDocumentText = [...root.querySelectorAll('[data-vdoc-text]')]
            .map((node) => node.textContent || '').join('');

        blocks[0].dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: 450,
            clientY: 290
        }));
        document.getElementById('advanced-style-btn').click();
        const cards = [...document.querySelectorAll('#style-library-list .style-card')];
        const previewFrame = document.getElementById('style-preview-frame');
        const previewResults = cards.map((card) => {
            card.click();
            return Boolean(previewFrame.srcdoc)
                && previewFrame.srcdoc.includes('<!doctype html>')
                && !previewFrame.srcdoc.includes('预览生成失败');
        });
        document.getElementById('style-library-close-btn').click();

        return {
            available: true,
            explicitShiftSelection: explicitSelectedCount === 2,
            explicitSelectionStatus,
            crossBlockFontApplied: styledBlocks.length === 2,
            preservesBlockStructure: !root.querySelector('span > p, span > h1, span > h2, span > h3, span > blockquote'),
            multiBlockAlignment: blocks.every((block) => block.style.textAlign === 'center'),
            selectAllCoversDocument: root.querySelectorAll(
                '[data-vdoc-text][data-vdoc-editor-selected="true"]'
            ).length === root.querySelectorAll('[data-vdoc-text]').length
                && document.getElementById('selection-status').textContent
                    === \`已选 \${root.querySelectorAll('[data-vdoc-text]').length} 块\`,
            previewCount: previewResults.length,
            allStylePreviewsReady: previewResults.length > 0 && previewResults.every(Boolean)
        };
    })()`);

    progress('enter-key-interaction');
    const enterInteraction = await windowRef.webContents.executeJavaScript(`(async () => {
        const root = document.getElementById('page-stream').shadowRoot;
        const runtimeBeforeShiftEnter = root.querySelector('.vdoc-flow-runtime');
        const block = [...root.querySelectorAll('p[data-vdoc-block]')]
            .find((node) => (node.textContent || '').trim().length > 1);
        if (!block) return { available: false };

        block.focus();
        const selection = root.getSelection ? root.getSelection() : window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(block);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        const countDocumentBlocks = () =>
            root.querySelectorAll('.vdoc-flow-runtime [data-vdoc-block]').length;
        const host = document.getElementById('render-host');
        const scrollBefore = host.scrollTop;
        const blocksBefore = countDocumentBlocks();
        const breaksBefore = block.querySelectorAll('br').length;
        block.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            composed: true,
            cancelable: true
        }));
        const blocksAfterEnter = countDocumentBlocks();
        const breaksAfterEnter = block.querySelectorAll('br').length;
        const scrollAfterEnter = host.scrollTop;

        block.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
            bubbles: true,
            composed: true,
            cancelable: true
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const blocksAfterShiftEnter = countDocumentBlocks();
        const scrollAfterShiftEnter = host.scrollTop;
        const activeAfterReflow = root.activeElement;
        const pageCountAfterShiftEnter = root.querySelectorAll('.vdoc-page').length;

        const firstBlock = root.querySelector(
            '.vdoc-flow-runtime [data-vdoc-block][data-vdoc-removable="true"]'
        );
        const firstBlockText = firstBlock?.textContent || '';
        const blocksBeforePrepend = countDocumentBlocks();
        if (firstBlock) {
            const startRange = document.createRange();
            startRange.selectNodeContents(firstBlock);
            startRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(startRange);
            firstBlock.focus();
            firstBlock.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                composed: true,
                cancelable: true
            }));
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const prependedBlock = firstBlock?.previousElementSibling;
        const blocksAfterPrepend = countDocumentBlocks();

        return {
            available: true,
            enterKeepsBlockCount: blocksAfterEnter === blocksBefore,
            enterAddsSoftBreak: breaksAfterEnter === breaksBefore + 1,
            shiftEnterAddsBlock: blocksAfterShiftEnter === blocksAfterEnter + 1,
            continuousEditorStaysUnpaginated: pageCountAfterShiftEnter === 0,
            shiftEnterPreservesContinuousRuntime:
                root.querySelector('.vdoc-flow-runtime') === runtimeBeforeShiftEnter,
            shiftEnterRestoresFocus: Boolean(
                activeAfterReflow?.matches?.('[data-vdoc-text]')
                && !(activeAfterReflow.textContent || '').trim()
            ),
            enterAtStartPrependsBlock: Boolean(
                prependedBlock?.matches?.('[data-vdoc-block]')
                && blocksAfterPrepend === blocksBeforePrepend + 1
            ),
            prependPreservesOriginalBlock: firstBlock?.textContent === firstBlockText,
            prependedBlockReceivesFocus: root.activeElement === prependedBlock,
            enterScrollStable: Math.abs(scrollAfterEnter - scrollBefore) < 80,
            shiftEnterScrollStable: Math.abs(scrollAfterShiftEnter - scrollAfterEnter) < 80
        };
    })()`);

    progress('block-interaction');
    const blockInteraction = await windowRef.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const initialContainers = root.querySelectorAll('[data-vdoc-container][data-vdoc-preserve="true"]').length;
        const initialBlocks = root.querySelectorAll('[data-vdoc-block][data-vdoc-removable="true"]').length;

        document.getElementById('block-type-select').value = 'paragraph';
        document.getElementById('insert-block-btn').click();
        const rootAfterParagraph = document.getElementById('page-stream').shadowRoot;
        const afterParagraphBlocks = rootAfterParagraph.querySelectorAll('[data-vdoc-block]').length;

        document.getElementById('block-type-select').value = 'table';
        document.getElementById('insert-block-btn').click();
        const finalRoot = document.getElementById('page-stream').shadowRoot;
        return {
            initialContainers,
            initialBlocks,
            afterParagraphBlocks,
            finalContainers: finalRoot.querySelectorAll('[data-vdoc-container][data-vdoc-preserve="true"]').length,
            hasTable: Boolean(finalRoot.querySelector('table')),
            hasEditableCells: finalRoot.querySelectorAll('td[contenteditable="true"]').length >= 9,
            leafProtocol: Boolean(finalRoot.querySelector('[data-vdoc-block][data-vdoc-removable="true"]'))
        };
    })()`);

    progress('media-insertion-interaction');
    const mediaInteraction = await windowRef.webContents.executeJavaScript(`(async () => {
        const mediaButton = document.querySelector('[data-command="image"]');
        mediaButton.click();
        const dialog = document.getElementById('media-dialog');
        const dialogVisibleAfterClick = dialog.hidden === false;
        const srcInput = document.getElementById('media-src-input');
        const descriptionInput = document.getElementById('media-description-input');
        srcInput.value = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="18"%3E%3Crect width="32" height="18" fill="%238b5e34"/%3E%3C/svg%3E';
        descriptionInput.value = '用于验证原生尺寸和源码描述的测试图片';
        document.getElementById('media-form').requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const root = document.getElementById('page-stream').shadowRoot;
        const figure = root.querySelector('figure[data-vdoc-media="image"]');
        const image = figure?.querySelector('img');
        const dialogClosedAfterInsert = dialog.hidden === true;

        mediaButton.click();
        const transfer = new DataTransfer();
        transfer.items.add(new File([
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>'
        ], 'batch-first.svg', { type: 'image/svg+xml' }));
        transfer.items.add(new File([
            '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect width="60" height="30" fill="blue"/></svg>'
        ], 'batch-second.svg', { type: 'image/svg+xml' }));
        const localInput = document.getElementById('media-local-input');
        localInput.files = transfer.files;
        localInput.dispatchEvent(new Event('change', { bubbles: true }));
        const localCards = [...document.querySelectorAll('.media-local-item')];
        const localDescriptions = [...document.querySelectorAll('.media-local-description')];
        const srcFieldsHiddenInLocalMode =
            document.getElementById('media-src-fields').hidden === true
            && document.getElementById('media-src-input').disabled === true;
        localDescriptions[0].value = '批量第一张红色测试图';
        localDescriptions[0].dispatchEvent(new Event('input', { bubbles: true }));
        localDescriptions[1].value = '批量第二张蓝色测试图';
        localDescriptions[1].dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('media-form').requestSubmit();
        const batchDeadline = Date.now() + 8000;
        while (!document.getElementById('media-dialog').hidden
            && Date.now() < batchDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const batch = root.querySelector('[data-vdoc-media-batch="2"]');
        const batchFigures = [...(batch?.querySelectorAll('figure[data-vdoc-media]') || [])];
        const batchDescriptions = batchFigures.map((node) => node.getAttribute('description'));
        const batchSourceNames = batchFigures.map((node) => node.dataset.vdocSourceName);
        const batchUsesInternalResources = batchFigures.length === 2
            && batchFigures.every((node) =>
                node.dataset.vdocSourceKind === 'embedded-resource'
                && node.querySelector('img')?.src.startsWith('blob:')
            );

        document.getElementById('html-mode-btn').click();
        const source = document.querySelector(
            '.source-editor-shell .CodeMirror'
        )?.CodeMirror?.getValue() || '';
        const internalReferences = source.match(
            /vdoc-resource:\\/\\/media\\/[a-f0-9]{64}/gi
        ) || [];
        return {
            buttonTitle: mediaButton.title || '',
            dialogVisibleAfterClick,
            dialogHasDescriptionField: Boolean(descriptionInput),
            dialogClosedAfterInsert,
            inserted: Boolean(figure && image),
            localPickerSupportsMultiple: localInput.multiple === true,
            localCardCount: localCards.length,
            srcFieldsHiddenInLocalMode,
            batchInserted: Boolean(batch),
            batchDescriptions,
            batchSourceNames,
            batchUsesInternalResources,
            sourceUsesInternalReferences: internalReferences.length >= 2,
            sourceExcludesBatchData: !source.includes(
                'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmci'
            ) && !source.includes('data:image/svg+xml;base64'),
            usesSrc: image?.getAttribute('src')?.startsWith('data:image/svg+xml') === true,
            nativeWidth: image?.getAttribute('width') || '',
            nativeHeight: image?.getAttribute('height') || '',
            centeredFigure: figure?.style.textAlign === 'center'
                && figure?.style.margin === '1em auto',
            centeredMedia: image?.style.margin === '0px auto'
                || image?.style.margin === '0 auto',
            description: figure?.getAttribute('description') || '',
            completeDescription: figure?.dataset.vdocDescription || '',
            mediaDescription: image?.getAttribute('description') || '',
            sourceKeepsMetadata: source.includes('data-vdoc-media="image"')
                && source.includes('data-vdoc-native-width="32"')
                && source.includes('data-vdoc-native-height="18"')
                && source.includes('description="用于验证原生尺寸和源码描述的测试图片"')
                && source.includes('data-vdoc-description=')
                && source.includes('原生分辨率 32 × 18 px')
                && source.includes('data-vdoc-media-batch="2"')
                && source.includes('data-vdoc-source-name="batch-first.svg"')
                && source.includes('data-vdoc-source-name="batch-second.svg"')
                && source.includes('description="批量第一张红色测试图"')
                && source.includes('description="批量第二张蓝色测试图"')
        };
    })()`);
    if (!mediaInteraction.inserted) {
        await windowRef.webContents.executeJavaScript(
            `document.getElementById('html-mode-btn').click()`
        );
    }

    progress('collect-snapshot');
    const snapshot = await windowRef.webContents.executeJavaScript(`({
    title: document.title,
    hasApi: Boolean(window.scriptoriumAPI),
    hasImportApi: typeof window.scriptoriumAPI?.chooseImport === 'function',
    hasRichExportApi: typeof window.scriptoriumAPI?.exportRichDocument === 'function',
    hasPaginationEngine: Boolean(window.VDocPagination),
    hasReadMode: Boolean(document.getElementById('read-mode-btn')),
    hasExportButtons: Boolean(
        document.getElementById('export-flow-html-btn')
        && document.getElementById('export-paged-html-btn')
        && document.getElementById('export-pdf-btn')
    ),
    hasImportButton: Boolean(document.getElementById('import-btn')),
    importButtonLabel: document.getElementById('import-btn')?.innerText.trim(),
    hasCompatibilityApi: Boolean(window.docxAPI),
    hasVdocCore: Boolean(window.VDocCore),
    format: window.VDocCore?.FORMAT,
    projectKinds: window.VDocCore?.PROJECT_KINDS,
    hasStyleLibrary: Boolean(window.VDocStyleLibrary),
    styleCount: window.VDocStyleLibrary?.list().length || 0,
    packFormat: window.VDocStyleLibrary?.PACK_FORMAT,
    scripts: Array.from(document.scripts).map((script) => script.src),
    bodyTheme: document.body.className,
    welcomeVisible: !document.getElementById('welcome-state').hidden,
    workspaceVisible: !document.getElementById('document-workspace').hidden,
    editorReady: document.getElementById('save-state').textContent === '已保存'
        || document.getElementById('save-state').textContent === '有未保存修改',
    hasShadowSurface: Boolean(document.getElementById('page-stream').shadowRoot),
    hasEditableSurface: Boolean(
        document.getElementById('page-stream').shadowRoot?.querySelector('[contenteditable="true"]')
    ),
    sourceModeVisible: !document.getElementById('source-host').hidden,
    sourceContainsIds: document.querySelector('.source-editor-shell .CodeMirror')?.CodeMirror
        ?.getValue().includes('data-vdoc-text') || false,
    hasFullSourceEditor: Boolean(document.querySelector('.source-editor-shell .CodeMirror')),
    hasSourceColorTool: Boolean(document.getElementById('source-color-input')),
    formatRoundTrips: (() => {
        const flow = window.VDocCore.createDocument({ title: '往返测试' });
        const restored = window.VDocCore.parse(window.VDocCore.serialize(flow));
        return restored.format === 'vcp-vdocx'
            && restored.manifest.scene.kind === 'flow-document'
            && restored.source.content.includes('data-vdoc-text');
    })(),
    slideDeckRoundTrips: (() => {
        const deck = window.VDocCore.createDocument({
            title: '演示测试',
            kind: window.VDocCore.PROJECT_KINDS.SLIDE_DECK,
            slides: [{
                name: '第一页',
                source: '<section data-vdoc-slide><h1>第一页</h1></section>'
            }]
        });
        const restored = window.VDocCore.parse(window.VDocCore.serialize(deck));
        return restored.manifest.scene.kind === 'slide-deck'
            && restored.manifest.scene.orientation === 'landscape'
            && window.VDocCore.extensionForKind(restored.manifest.scene.kind) === '.vpptx';
    })(),
    stylePackRoundTrips: (() => {
        const serialized = window.VDocStyleLibrary.serializePack(
            ['vcp.emphasis.vermillion'],
            { id: 'vcp.test.roundtrip', name: '往返测试' }
        );
        const restored = window.VDocStyleLibrary.parsePack(serialized);
        return restored.styles.length === 1
            && restored.styles[0].id === 'vcp.emphasis.vermillion'
            && restored.styles[0].css.includes('vds-vermillion');
    })(),
    loadingVisible: !document.getElementById('loading-state').hidden,
    saveState: document.getElementById('save-state').textContent,
    toastText: document.getElementById('toast-region').innerText,
    fontCount: document.getElementById('font-family-select').options.length,
    lineageText: document.getElementById('lineage-panel').innerText,
    interaction: ${JSON.stringify(interaction)},
    mathInteraction: ${JSON.stringify(mathInteraction)},
    modeSwitchInteraction: ${JSON.stringify(modeSwitchInteraction)},
    formattingInteraction: ${JSON.stringify(formattingInteraction)},
    copiedHeadingPasteInteraction: ${JSON.stringify(copiedHeadingPasteInteraction)},
    rangeSelectionInteraction: ${JSON.stringify(rangeSelectionInteraction)},
    enterInteraction: ${JSON.stringify(enterInteraction)},
    blockInteraction: ${JSON.stringify(blockInteraction)},
    mediaInteraction: ${JSON.stringify(mediaInteraction)},
    approvalPending: ${JSON.stringify(approvalPending)},
    approvalResult: ${JSON.stringify(approvalResult)},
    viewport: { width: innerWidth, height: innerHeight }
})`);

    progress('capture-screenshot');
    const outputDir = path.join(projectRoot, 'AppData', 'Scriptorium');
    await fs.ensureDir(outputDir);
    const image = await windowRef.webContents.capturePage();
    const screenshotPath = path.join(outputDir, 'scriptorium-smoke.png');
    await fs.writeFile(screenshotPath, image.toPNG());

    console.log('[ScriptoriumSmoke] Snapshot:', JSON.stringify(snapshot, null, 2));
    console.log('[ScriptoriumSmoke] Screenshot:', screenshotPath);

    if (!snapshot.hasApi || !snapshot.hasImportApi || !snapshot.hasRichExportApi
        || !snapshot.hasPaginationEngine || !snapshot.hasReadMode || !snapshot.hasExportButtons
        || !snapshot.hasImportButton
        || snapshot.importButtonLabel !== '导入'
        || !snapshot.hasVdocCore || !snapshot.hasStyleLibrary
        || snapshot.format !== 'vcp-vdocx' || snapshot.welcomeVisible || !snapshot.workspaceVisible
        || !snapshot.editorReady || !snapshot.hasShadowSurface || !snapshot.hasEditableSurface
        || !snapshot.sourceModeVisible || !snapshot.sourceContainsIds
        || !snapshot.hasFullSourceEditor || !snapshot.hasSourceColorTool
        || !snapshot.formatRoundTrips || !snapshot.slideDeckRoundTrips
        || !snapshot.stylePackRoundTrips || snapshot.fontCount < 2
        || snapshot.styleCount < 3 || !snapshot.interaction.selected
        || !snapshot.interaction.dialogVisible || snapshot.interaction.styleCount < 1
        || !snapshot.interaction.previewReady || !snapshot.interaction.appliedStyleNode
        || !snapshot.interaction.compiledStyle || !snapshot.mathInteraction.hasCodeMirror
        || !snapshot.mathInteraction.hasLineNumbers || !snapshot.mathInteraction.isMultilineSource
        || !snapshot.mathInteraction.hasIndentedSource || !snapshot.mathInteraction.wrapDisabled
        || !snapshot.mathInteraction.wrapEnabled || !snapshot.mathInteraction.wrapPreservesSource
        || !snapshot.mathInteraction.hasKatexRuntime
        || !snapshot.mathInteraction.hasKatexVisual || !snapshot.mathInteraction.sourceKeepsLatex
        || !snapshot.mathInteraction.sourceExcludesDerivedKatex
        || !snapshot.mathInteraction.lightEditorAdapted
        || !snapshot.modeSwitchInteraction.renderVisible
        || !snapshot.modeSwitchInteraction.sourceHidden
        || !snapshot.modeSwitchInteraction.continuousEditorHasNoPages
        || !snapshot.modeSwitchInteraction.hasContinuousRuntime
        || !snapshot.modeSwitchInteraction.readingRemainsPaginated
        || !snapshot.modeSwitchInteraction.readingIsReadonly
        || !snapshot.modeSwitchInteraction.editorIsTransparent
        || !snapshot.modeSwitchInteraction.editorTextIsReadable
        || !snapshot.modeSwitchInteraction.readingUsesPaper
        || !snapshot.modeSwitchInteraction.readingUsesDarkInk
        || !/^第 \d+ 页 \/ 共 \d+ 页$/.test(snapshot.modeSwitchInteraction.readingStatus)
        || !snapshot.modeSwitchInteraction.pretextReady
        || !snapshot.modeSwitchInteraction.plainEstimateReady
        || !snapshot.modeSwitchInteraction.complexUsesDomFallback
        || !snapshot.modeSwitchInteraction.hasLastRegressionParagraph
        || !snapshot.formattingInteraction.available
        || !snapshot.formattingInteraction.quickFontApplied
        || !snapshot.formattingInteraction.computedFont.includes('Microsoft YaHei')
        || !snapshot.formattingInteraction.topFontRecognized
        || !snapshot.formattingInteraction.quickFontRecognized
        || !snapshot.formattingInteraction.inlineToggleMarkersCleaned
        || !['bold', 'italic', 'underline', 'strikethrough'].every((command) =>
            snapshot.formattingInteraction.inlineToggleResults?.[command]?.applied
            && snapshot.formattingInteraction.inlineToggleResults?.[command]?.removed
        )
        || !snapshot.copiedHeadingPasteInteraction.available
        || !snapshot.copiedHeadingPasteInteraction.pasteDefaultPrevented
        || !snapshot.copiedHeadingPasteInteraction.pastedIdentityNotNested
        || !snapshot.copiedHeadingPasteInteraction.renderedIdsRemainUnique
        || !snapshot.copiedHeadingPasteInteraction.sourceIdsRemainUnique
        || !snapshot.copiedHeadingPasteInteraction.targetEditSaved
        || !snapshot.copiedHeadingPasteInteraction.originalHeadingUnaffected
        || !snapshot.copiedHeadingPasteInteraction.duplicateTextIdsReissued
        || !snapshot.copiedHeadingPasteInteraction.duplicateBlockIdsReissued
        || !snapshot.copiedHeadingPasteInteraction.duplicateContainerIdsReissued
        || !snapshot.rangeSelectionInteraction.available
        || !snapshot.rangeSelectionInteraction.explicitShiftSelection
        || snapshot.rangeSelectionInteraction.explicitSelectionStatus !== '已选 2 块'
        || !snapshot.rangeSelectionInteraction.crossBlockFontApplied
        || !snapshot.rangeSelectionInteraction.preservesBlockStructure
        || !snapshot.rangeSelectionInteraction.multiBlockAlignment
        || !snapshot.rangeSelectionInteraction.selectAllCoversDocument
        || snapshot.rangeSelectionInteraction.previewCount < 1
        || !snapshot.rangeSelectionInteraction.allStylePreviewsReady
        || !snapshot.enterInteraction.available
        || !snapshot.enterInteraction.enterKeepsBlockCount
        || !snapshot.enterInteraction.enterAddsSoftBreak
        || !snapshot.enterInteraction.shiftEnterAddsBlock
        || !snapshot.enterInteraction.continuousEditorStaysUnpaginated
        || !snapshot.enterInteraction.shiftEnterPreservesContinuousRuntime
        || !snapshot.enterInteraction.shiftEnterRestoresFocus
        || !snapshot.enterInteraction.enterAtStartPrependsBlock
        || !snapshot.enterInteraction.prependPreservesOriginalBlock
        || !snapshot.enterInteraction.prependedBlockReceivesFocus
        || !snapshot.enterInteraction.enterScrollStable
        || !snapshot.enterInteraction.shiftEnterScrollStable
        || snapshot.blockInteraction.initialContainers < 1
        || snapshot.blockInteraction.initialBlocks < 1
        || snapshot.blockInteraction.afterParagraphBlocks <= snapshot.blockInteraction.initialBlocks
        || snapshot.blockInteraction.finalContainers < 1
        || !snapshot.blockInteraction.hasTable || !snapshot.blockInteraction.hasEditableCells
        || !snapshot.blockInteraction.leafProtocol
        || snapshot.mediaInteraction.buttonTitle !== '插入媒体'
        || !snapshot.mediaInteraction.dialogVisibleAfterClick
        || !snapshot.mediaInteraction.dialogHasDescriptionField
        || !snapshot.mediaInteraction.dialogClosedAfterInsert
        || !snapshot.mediaInteraction.inserted
        || !snapshot.mediaInteraction.localPickerSupportsMultiple
        || snapshot.mediaInteraction.localCardCount !== 2
        || !snapshot.mediaInteraction.srcFieldsHiddenInLocalMode
        || !snapshot.mediaInteraction.batchInserted
        || snapshot.mediaInteraction.batchDescriptions?.join('|')
           !== '批量第一张红色测试图|批量第二张蓝色测试图'
        || snapshot.mediaInteraction.batchSourceNames?.join('|')
           !== 'batch-first.svg|batch-second.svg'
        || !snapshot.mediaInteraction.batchUsesInternalResources
        || !snapshot.mediaInteraction.sourceUsesInternalReferences
        || !snapshot.mediaInteraction.sourceExcludesBatchData
        || !snapshot.mediaInteraction.usesSrc
        || snapshot.mediaInteraction.nativeWidth !== '32'
        || snapshot.mediaInteraction.nativeHeight !== '18'
        || !snapshot.mediaInteraction.centeredFigure
        || !snapshot.mediaInteraction.centeredMedia
        || snapshot.mediaInteraction.description
           !== '用于验证原生尺寸和源码描述的测试图片'
        || snapshot.mediaInteraction.mediaDescription
           !== '用于验证原生尺寸和源码描述的测试图片'
        || !snapshot.mediaInteraction.completeDescription.includes('原生分辨率 32 × 18 px')
        || !snapshot.mediaInteraction.sourceKeepsMetadata
        || snapshot.approvalPending.pendingCount !== 1
        || snapshot.approvalPending.pendingAuthor !== '冒烟测试 Agent'
        || snapshot.approvalPending.pendingStatus !== 'pending'
        || !snapshot.approvalPending.sourceUnchangedBeforeApproval
        || !snapshot.approvalPending.hasPendingCard
        || !snapshot.approvalPending.hasPendingAvatar
        || snapshot.approvalPending.pendingCounter !== '1'
        || !snapshot.approvalResult.uiAvailable
        || !snapshot.approvalResult.success
        || snapshot.approvalResult.receiptMessage !== '内容准确，允许合并。'
        || snapshot.approvalResult.receiptDecision !== 'approved'
        || snapshot.approvalResult.authorName !== '冒烟测试 Agent'
        || snapshot.approvalResult.status !== 'applied'
        || !snapshot.approvalResult.sourceChangedAfterApproval
        || snapshot.approvalResult.pendingCountAfterApproval !== 0
        || snapshot.approvalResult.pendingCounterAfterApproval !== '0') {
        errors.push('Required VDOCX editing or advanced style surface is unavailable.');
    }

    if (errors.length) {
        console.error('[ScriptoriumSmoke] FAILED:', JSON.stringify(errors, null, 2));
        finish(1);
        return;
    }

    console.log('[ScriptoriumSmoke] PASSED');
    finish(0);
}).catch((error) => {
    console.error('[ScriptoriumSmoke] UNHANDLED:', error?.stack || error);
    finish(1);
});

app.on('window-all-closed', () => app.quit());