'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');

const projectRoot = path.resolve(__dirname, '..');
let windowRef = null;

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    ipcMain.handle('docx:recent-list', () => []);
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
    registerMinimalIpc();

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

    await windowRef.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await windowRef.webContents.executeJavaScript(`document.getElementById('welcome-new-btn').click()`);
    await new Promise((resolve) => setTimeout(resolve, 5000));

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
        return {
            hasCodeMirror: true,
            hasLineNumbers: Boolean(document.querySelector('.CodeMirror-linenumbers')),
            isMultilineSource: semanticSource.split('\\n').length > 3,
            hasIndentedSource: /\\n\\s{4}</.test(semanticSource),
            wrapDisabled,
            wrapEnabled,
            wrapPreservesSource: codeMirror.getValue() === sourceBeforeWrapToggle,
            diagnostics: document.getElementById('source-diagnostics').textContent,
            hasKatexRuntime: Boolean(window.katex),
            hasKatexVisual,
            sourceKeepsLatex: semanticSource.includes('data-vdoc-math="E%3Dmc%5E2"'),
            sourceExcludesDerivedKatex: !semanticSource.includes('katex-html')
        };
    })()`);

    await windowRef.webContents.executeJavaScript(`document.getElementById('render-mode-btn').click()`);
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
    await windowRef.webContents.executeJavaScript(`document.getElementById('html-mode-btn').click()`);

    const snapshot = await windowRef.webContents.executeJavaScript(`({
    title: document.title,
    hasApi: Boolean(window.scriptoriumAPI),
    hasImportApi: typeof window.scriptoriumAPI?.chooseImport === 'function',
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
            && restored.source.html.includes('data-vdoc-text');
    })(),
    slideDeckRoundTrips: (() => {
        const deck = window.VDocCore.createDocument({
            title: '演示测试',
            kind: window.VDocCore.PROJECT_KINDS.SLIDE_DECK,
            html: '<section data-vdoc-slide><h1>第一页</h1></section>'
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
    blockInteraction: ${JSON.stringify(blockInteraction)},
    viewport: { width: innerWidth, height: innerHeight }
})`);

    const outputDir = path.join(projectRoot, 'AppData', 'Scriptorium');
    await fs.ensureDir(outputDir);
    const image = await windowRef.webContents.capturePage();
    const screenshotPath = path.join(outputDir, 'scriptorium-smoke.png');
    await fs.writeFile(screenshotPath, image.toPNG());

    console.log('[ScriptoriumSmoke] Snapshot:', JSON.stringify(snapshot, null, 2));
    console.log('[ScriptoriumSmoke] Screenshot:', screenshotPath);

    if (!snapshot.hasApi || !snapshot.hasImportApi || !snapshot.hasImportButton
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
        || snapshot.blockInteraction.initialContainers < 1
        || snapshot.blockInteraction.initialBlocks < 1
        || snapshot.blockInteraction.afterParagraphBlocks <= snapshot.blockInteraction.initialBlocks
        || snapshot.blockInteraction.finalContainers < 1
        || !snapshot.blockInteraction.hasTable || !snapshot.blockInteraction.hasEditableCells
        || !snapshot.blockInteraction.leafProtocol) {
        errors.push('Required VDOCX editing or advanced style surface is unavailable.');
    }

    if (errors.length) {
        console.error('[ScriptoriumSmoke] FAILED:', JSON.stringify(errors, null, 2));
        app.exit(1);
        return;
    }

    console.log('[ScriptoriumSmoke] PASSED');
    app.exit(0);
});

app.on('window-all-closed', () => app.quit());