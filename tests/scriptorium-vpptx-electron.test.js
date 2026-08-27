'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
let windowRef = null;
let lastExportPayload = null;

function registerMinimalIpc() {
    ipcMain.handle('get-current-theme', () =>
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('docx:fonts-list', () => [
        'Arial',
        'Microsoft YaHei',
        'Noto Serif CJK SC',
    ]);
    ipcMain.handle('docx:choose-open', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:choose-import', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:read-path', () => ({ success: false, canceled: true }));
    ipcMain.handle('docx:save', () => ({ success: false, canceled: true }));
    ipcMain.handle('scriptorium:svg-assets-load', () => []);
    ipcMain.handle('scriptorium:svg-assets-save', (_event, packs = []) => ({
        success: true,
        count: packs.length,
        size: 0,
    }));
    ipcMain.handle('scriptorium:export-rich-document', (_event, payload) => {
        lastExportPayload = payload;
        return {
            success: true,
            name: payload.suggestedName,
            filePath: path.join(projectRoot, 'AppData', 'Scriptorium', payload.suggestedName),
        };
    });
    ipcMain.handle('open-docx-window', () => ({ success: true }));

    ipcMain.on('window-lifecycle:ready', () => {});
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => app.quit());
    ipcMain.on('open-dev-tools', () => {});
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForExportPayload(timeout = 5000) {
    const startedAt = Date.now();
    while (!lastExportPayload && Date.now() - startedAt < timeout) {
        await delay(100);
    }
    return lastExportPayload;
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
        const details = args.find((value) =>
            value && typeof value === 'object' && typeof value.message === 'string'
        );
        const level = details?.level ?? args[1];
        const message = details?.message ?? args[2] ?? 'Unknown renderer message';
        const lineNumber = details?.lineNumber ?? args[3];
        const sourceId = details?.sourceId ?? args[4];
        console.log(`[ScriptoriumVPPTX Renderer:${level}] ${message} (${
            sourceId || 'unknown'
        }:${lineNumber || 0})`);
        if (level === 'error' || level === 3) errors.push(message);
    });
    windowRef.webContents.on('render-process-gone', (_event, details) => {
        errors.push(`render-process-gone: ${details.reason}`);
    });

    await windowRef.loadFile(
        path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html')
    );
    await delay(1200);
    await windowRef.webContents.executeJavaScript(
        `document.getElementById('new-deck-btn').click()`
    );
    await delay(1000);

    const initial = await windowRef.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('page-stream').shadowRoot;
        const runtime = root.querySelector('.vdoc-slide-editor-runtime');
        const items = [...document.querySelectorAll('#slide-navigator .slide-nav-item')];
        const model = window.VDocCore.createDocument({
            title: '模型往返',
            kind: window.VDocCore.PROJECT_KINDS.SLIDE_DECK,
            slides: [
                {
                    id: 'scene-stable-a',
                    name: '甲页',
                    source: '<style>.a{color:red}</style><section class="vdoc-slide-scene"><h1>甲</h1></section><script>scene.dataset.ran = "true";</script>',
                    transition: 'fade',
                    duration: 4,
                    notes: '甲备注',
                    resources: ['asset-a']
                },
                {
                    id: 'scene-stable-b',
                    name: '乙页',
                    source: '<section class="vdoc-slide-scene"><h1>乙</h1></section>'
                }
            ]
        });
        const restored = window.VDocCore.parse(window.VDocCore.serialize(model));
        const slideASplit = window.VDocCore.splitSlideSource(restored.source.slides[0].source);
        return {
            title: document.getElementById('document-title').textContent,
            navigatorVisible: !document.getElementById('slide-navigator').hidden,
            navigatorCount: items.length,
            slideCount: document.getElementById('slide-count').textContent,
            firstSceneId: items[0]?.dataset.slideId || '',
            runtimeSceneId: runtime?.dataset.slideId || '',
            hasLandscapeRuntime: Boolean(runtime)
                && runtime.offsetWidth > runtime.offsetHeight,
            hasEditableText: Boolean(runtime?.querySelector('[contenteditable="true"]')),
            deleteDisabled: document.getElementById('delete-slide-btn').disabled,
            roundTrip: restored.source.slides.length === 2
                && restored.source.slides[0].id === 'scene-stable-a'
                && restored.source.slides[1].id === 'scene-stable-b'
                && slideASplit.script.includes('dataset.ran')
                && restored.source.slides[0].transition === 'fade'
                && restored.source.slides[0].duration === 4
                && restored.source.slides[0].notes === '甲备注'
                && restored.source.slides[0].resources[0] === 'asset-a'
                && restored.manifest.scene.orientation === 'landscape'
                && restored.manifest.capabilities.sceneDiffs === true
        };
    })()`);

    const pageManagement = await windowRef.webContents.executeJavaScript(`(async () => {
        const waitFrames = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const root = document.getElementById('page-stream').shadowRoot;
        const firstId = document.querySelector('#slide-navigator .slide-nav-item')?.dataset.slideId;

        document.getElementById('add-slide-btn').click();
        await waitFrames();

        const itemsAfterAdd = [...document.querySelectorAll(
            '#slide-navigator .slide-nav-item'
        )];
        const secondId = itemsAfterAdd[1]?.dataset.slideId;
        const secondRuntime = root.querySelector('.vdoc-slide-editor-runtime');
        const secondHeading = secondRuntime?.querySelector('h1');
        if (secondHeading) {
            secondHeading.textContent = '第二页独立内容';
            secondHeading.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                composed: true,
                inputType: 'insertText',
                data: '第二页独立内容'
            }));
        }

        itemsAfterAdd[0].click();
        await waitFrames();
        const firstText = root.querySelector('.vdoc-slide-editor-runtime')?.textContent || '';
        const firstActive = document.querySelector(
            '#slide-navigator .slide-nav-item.active'
        )?.dataset.slideId;

        document.querySelectorAll('#slide-navigator .slide-nav-item')[1].click();
        await waitFrames();
        const secondText = root.querySelector('.vdoc-slide-editor-runtime')?.textContent || '';
        document.getElementById('html-mode-btn').click();
        await waitFrames();
        const source = document.querySelector(
            '#source-host .source-editor-shell .CodeMirror'
        )?.CodeMirror?.getValue() || '';
        document.getElementById('render-mode-btn').click();
        await waitFrames();

        document.getElementById('delete-slide-btn').click();
        await waitFrames();
        const countAfterDelete = document.querySelectorAll(
            '#slide-navigator .slide-nav-item'
        ).length;
        const deleteDisabledAfterDelete =
            document.getElementById('delete-slide-btn').disabled;
        document.getElementById('delete-slide-btn').click();
        await waitFrames();

        return {
            firstId,
            secondId,
            idsAreStableAndUnique: Boolean(firstId && secondId && firstId !== secondId),
            countAfterAdd: itemsAfterAdd.length,
            secondWasActiveAfterAdd: secondRuntime?.dataset.slideId === secondId,
            firstSelectionWorks: firstActive === firstId,
            firstPageIsIsolated: !firstText.includes('第二页独立内容'),
            secondPageKeepsEdit: secondText.includes('第二页独立内容'),
            sourceRoutesToSecondPage: source.includes('第二页独立内容'),
            countAfterDelete,
            deleteDisabledAfterDelete,
            lastPageSurvivesSecondDelete: document.querySelectorAll(
                '#slide-navigator .slide-nav-item'
            ).length === 1
        };
    })()`);

    await windowRef.webContents.executeJavaScript(
        `document.getElementById('add-slide-btn').click()`
    );
    await delay(250);
    const reading = await windowRef.webContents.executeJavaScript(`(async () => {
        document.getElementById('read-mode-btn').click();
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const root = document.getElementById('read-page-stream').shadowRoot;
        const pages = [...root.querySelectorAll('.vdoc-page')];
        const content = root.querySelector('.vdoc-page-content');
        return {
            pageCount: pages.length,
            readonly: !root.querySelector('[contenteditable="true"]'),
            landscape: pages.length > 0 && pages[0].offsetWidth > pages[0].offsetHeight,
            sceneFillsPage: content ? getComputedStyle(content).padding === '0px' : false,
            status: document.getElementById('page-status').textContent
        };
    })()`);

    const sourceTruthIsolation = await windowRef.webContents.executeJavaScript(`(async () => {
      try {
        const waitFrames = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const sourceButton = document.getElementById('html-mode-btn');
        sourceButton.click();
        await waitFrames();
        const codeMirror = document.querySelector(
            '#source-host .source-editor-shell .CodeMirror'
        )?.CodeMirror;
        if (!codeMirror) return { available: false };

        const marker = '<span class="dot" data-test-runtime-truth="true">●</span>';
        codeMirror.setValue(codeMirror.getValue().replace(
            /(<\\/section>)(?![\\s\\S]*<\\/section>)/,
            marker + '$1'
        ));
        document.getElementById('render-mode-btn').click();
        await waitFrames();

        let root = document.getElementById('page-stream').shadowRoot;
        let runtime = root.querySelector('.vdoc-slide-editor-runtime');
        const dot = runtime?.querySelector('[data-test-runtime-truth="true"]');
        if (!dot) return { available: false, markerInserted: false };

        // 等价模拟 Anime.js/第三方运行库在当前帧对既有节点所做的变异。
        dot.style.cssText =
            'transform: translateY(17px) scale(0.73); opacity: 0.42; border-radius: 37%;';
        dot.classList.add('animejs-current-frame');
        dot.dataset.runtimeFrame = '42';
        const generated = document.createElement('i');
        generated.dataset.vdocRuntimeGenerated = 'true';
        generated.textContent = 'runtime-only';
        runtime.appendChild(generated);

        const api = window.ScriptoriumAgent.current();
        api.getViewportSource({ sourceKind: 'html', radius: 200 });
        const afterRead = api.getSource({ sourceKind: 'html' }).source;

        // 结构操作仍需允许新增正文块，但同步过程必须以既有源码属性为真相。
        document.getElementById('insert-block-btn').click();
        const afterStructure = api.getSource({ sourceKind: 'html' }).source;

        const activeIndex = window.ScriptoriumAgent.common.getDocumentInfo().activeSlideIndex;
        const slideCount = window.ScriptoriumAgent.pptx.getSlideCount().count;
        const otherIndex = slideCount > 1 ? (activeIndex === 0 ? 1 : 0) : activeIndex;
        if (otherIndex !== activeIndex) {
            window.ScriptoriumAgent.pptx.selectSlide({ slideIndex: otherIndex });
            await waitFrames();
            window.ScriptoriumAgent.pptx.selectSlide({ slideIndex: activeIndex });
            await waitFrames();
        }
        const afterNavigation = api.getSource({
            sourceKind: 'html',
            slideIndex: activeIndex
        }).source;

        const remainsSourceTruth = (source) =>
            source.includes('data-test-runtime-truth="true"')
            && !source.includes('animejs-current-frame')
            && !source.includes('data-runtime-frame')
            && !source.includes('translateY(17px)')
            && !source.includes('opacity: 0.42')
            && !source.includes('border-radius: 37%')
            && !source.includes('runtime-only');

        return {
            available: true,
            markerInserted: true,
            runtimeWasMutated: dot.hasAttribute('style'),
            viewportReadIsPure: remainsSourceTruth(afterRead),
            structureSyncIsIsolated: remainsSourceTruth(afterStructure),
            structureEditSurvives: afterStructure !== afterRead,
            navigationIsPure: remainsSourceTruth(afterNavigation)
        };
      } catch (error) {
        return {
            available: false,
            thrown: String(error && error.stack ? error.stack : error)
        };
      }
    })()`);

    lastExportPayload = null;
    await windowRef.webContents.executeJavaScript(
        `document.getElementById('export-flow-html-btn').click()`
    );
    const presentationExport = await waitForExportPayload();

    lastExportPayload = null;
    await windowRef.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('export-paged-html-btn');
        button.hidden = false;
        button.click();
    })()`);
    const alternatePresentationExport = await waitForExportPayload();

    lastExportPayload = null;
    await windowRef.webContents.executeJavaScript(
        `document.getElementById('export-pdf-btn').click()`
    );
    const pdfExport = await waitForExportPayload();

    const exportChecks = {
        presentationFormat: presentationExport?.format,
        presentationPaged: presentationExport?.paged,
        presentationName: presentationExport?.suggestedName,
        hasConductor: presentationExport?.html?.includes('window.VCPDeck') || false,
        hasNavigation: presentationExport?.html?.includes('data-deck-action="next"')
            && presentationExport?.html?.includes('data-deck-action="previous"'),
        hasBottomHoverDock:
            presentationExport?.html?.includes('class="vcp-deck-control-dock"')
            && presentationExport?.html?.includes(
                '.vcp-deck-control-dock:hover .vcp-deck-controls'
            ),
        controlsHiddenByDefault:
            presentationExport?.html?.includes('.vcp-deck-controls{')
            && presentationExport?.html?.includes('opacity:0'),
        exportedSceneCount:
            (presentationExport?.html?.match(/class="vcp-slide(?: active)?"/g) || []).length,
        alternateHtmlFormat: alternatePresentationExport?.format,
        alternateHtmlPaged: alternatePresentationExport?.paged,
        alternateHtmlUsesConductor:
            alternatePresentationExport?.html?.includes('window.VCPDeck') || false,
        pdfFormat: pdfExport?.format,
        pdfPaged: pdfExport?.paged,
        pdfLandscape: Boolean(
            pdfExport?.page
            && Number.parseFloat(pdfExport.page.width)
                > Number.parseFloat(pdfExport.page.height)
        ),
        pdfFreezesAnimations:
            pdfExport?.html?.includes('animation-play-state: paused') || false,
        pdfPageBreaks:
            /break-after\s*:\s*page/i.test(pdfExport?.html || ''),
    };

    const snapshot = {
        initial,
        pageManagement,
        reading,
        sourceTruthIsolation,
        exportChecks,
    };
    console.log('[ScriptoriumVPPTX] Snapshot:', JSON.stringify(snapshot, null, 2));

    if (!initial.title.endsWith('.vpptx')
        || !initial.navigatorVisible
        || initial.navigatorCount !== 1
        || initial.slideCount !== '1 页'
        || !initial.firstSceneId
        || initial.firstSceneId !== initial.runtimeSceneId
        || !initial.hasLandscapeRuntime
        || !initial.hasEditableText
        || !initial.deleteDisabled
        || !initial.roundTrip
        || pageManagement.countAfterAdd !== 2
        || !pageManagement.idsAreStableAndUnique
        || !pageManagement.secondWasActiveAfterAdd
        || !pageManagement.firstSelectionWorks
        || !pageManagement.firstPageIsIsolated
        || !pageManagement.secondPageKeepsEdit
        || !pageManagement.sourceRoutesToSecondPage
        || pageManagement.countAfterDelete !== 1
        || !pageManagement.deleteDisabledAfterDelete
        || !pageManagement.lastPageSurvivesSecondDelete
        || reading.pageCount !== 2
        || !reading.readonly
        || !reading.landscape
        || !reading.sceneFillsPage
        || reading.status !== '连续编辑'
        || !sourceTruthIsolation.available
        || !sourceTruthIsolation.markerInserted
        || !sourceTruthIsolation.runtimeWasMutated
        || !sourceTruthIsolation.viewportReadIsPure
        || !sourceTruthIsolation.structureSyncIsIsolated
        || !sourceTruthIsolation.structureEditSurvives
        || !sourceTruthIsolation.navigationIsPure
        || exportChecks.presentationFormat !== 'html-flow'
        || exportChecks.presentationPaged !== false
        || !exportChecks.presentationName.endsWith('.html')
        || !exportChecks.hasConductor
        || !exportChecks.hasNavigation
        || !exportChecks.hasBottomHoverDock
        || !exportChecks.controlsHiddenByDefault
        || exportChecks.exportedSceneCount !== 2
        || exportChecks.alternateHtmlFormat !== 'html-paged'
        || exportChecks.alternateHtmlPaged !== false
        || !exportChecks.alternateHtmlUsesConductor
        || exportChecks.pdfFormat !== 'pdf'
        || exportChecks.pdfPaged !== true
        || !exportChecks.pdfLandscape
        || !exportChecks.pdfFreezesAnimations
        || !exportChecks.pdfPageBreaks) {
        errors.push('Required VPPTX scene editing, preview, or export contract failed.');
    }

    if (errors.length) {
        console.error('[ScriptoriumVPPTX] FAILED:', JSON.stringify(errors, null, 2));
        app.exit(1);
        return;
    }

    console.log('[ScriptoriumVPPTX] PASSED');
    app.exit(0);
}).catch((error) => {
    console.error('[ScriptoriumVPPTX] UNHANDLED:', error?.stack || error);
    app.exit(1);
});

app.on('window-all-closed', () => app.quit());