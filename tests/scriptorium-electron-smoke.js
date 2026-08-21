'use strict';

const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const TIMEOUT_MS = 60000;
let watchdog = null;
let persistedStylePacks = [{
    format: 'vcp-vdoc-style-pack',
    version: 1,
    manifest: {
        id: 'vcp.test.persisted-style',
        name: '持久化预置样式',
        author: 'Smoke Test',
    },
    styles: [{
        id: 'vcp.test.persisted-style.accent',
        version: 1,
        name: '持久化强调',
        category: '自动化测试',
        targets: ['inline'],
        className: 'vds-persisted-accent',
        css: '.vds-persisted-accent{color:#135724}',
    }],
}];

function registerMinimalIpc() {
    ipcMain.handle(
        'get-current-theme',
        () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );
    ipcMain.handle('docx:recent-list', () => []);
    ipcMain.handle('scriptorium:document-library', () => ({
        success: true,
        extensions: [
            'vdocx', 'docx', 'vpptx', 'pptx', 'txt', 'html', 'md',
        ],
        roots: [
            {
                id: 'documents',
                label: '用户文档',
                description: 'VDOCX 与导入文档',
                path: 'AppData/ScriptoriumDocument/VDOCX',
                children: [
                    {
                        type: 'file',
                        name: '原生文稿.vdocx',
                        path: 'AppData/ScriptoriumDocument/VDOCX/原生文稿.vdocx',
                        extension: 'vdocx',
                        size: 256,
                    },
                    {
                        type: 'file',
                        name: 'Word文稿.docx',
                        path: 'AppData/ScriptoriumDocument/VDOCX/Word文稿.docx',
                        extension: 'docx',
                        size: 256,
                    },
                    {
                        type: 'file',
                        name: '纯文本.txt',
                        path: 'AppData/ScriptoriumDocument/VDOCX/纯文本.txt',
                        extension: 'txt',
                        size: 128,
                    },
                    {
                        type: 'file',
                        name: '网页.html',
                        path: 'AppData/ScriptoriumDocument/VDOCX/网页.html',
                        extension: 'html',
                        size: 128,
                    },
                ],
            },
            {
                id: 'presentations',
                label: '用户演示',
                description: 'VPPTX 与 PowerPoint 演示',
                path: 'ScriptoriumDocument/VPPTX',
                children: [
                    {
                        type: 'file',
                        name: '原生演示.vpptx',
                        path: 'ScriptoriumDocument/VPPTX/原生演示.vpptx',
                        extension: 'vpptx',
                        size: 256,
                    },
                    {
                        type: 'file',
                        name: '传统演示.pptx',
                        path: 'ScriptoriumDocument/VPPTX/传统演示.pptx',
                        extension: 'pptx',
                        size: 256,
                    },
                ],
            },
            {
                id: 'notes',
                label: '用户笔记',
                description: 'Markdown 与纯文本笔记',
                path: 'AppData/Notemodules',
                children: [{
                    type: 'file',
                    name: '测试笔记.md',
                    path: 'AppData/Notemodules/测试笔记.md',
                    extension: 'md',
                    size: 128,
                }],
            },
        ],
    }));
    ipcMain.handle('load-agents-list', () => []);
    ipcMain.handle('load-user-avatar', () => null);
    ipcMain.handle('load-agent-avatar', () => null);
    ipcMain.handle('docx:fonts-list', () => [
        'Arial',
        'Microsoft YaHei',
        'Noto Serif CJK SC',
    ]);
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
    ipcMain.handle('scriptorium:style-packs-load', () =>
        persistedStylePacks
    );
    ipcMain.handle(
        'scriptorium:style-packs-save',
        (_event, packs = []) => {
            persistedStylePacks = JSON.parse(JSON.stringify(packs));
            return {
                success: true,
                count: packs.length,
                size: JSON.stringify(packs).length,
            };
        }
    );
    ipcMain.handle('scriptorium:svg-assets-load', () => []);
    ipcMain.handle('scriptorium:svg-assets-save', (_event, packs = []) => ({
        success: true,
        count: packs.length,
        size: 0,
    }));
    ipcMain.handle('open-docx-window', () => ({ success: true }));
    ipcMain.on('window-lifecycle:ready', () => {});
    ipcMain.on('minimize-window', () => {});
    ipcMain.on('maximize-window', () => {});
    ipcMain.on('unmaximize-window', () => {});
    ipcMain.on('close-window', () => app.quit());
}

function finish(code) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    app.exit(code);
}

app.whenReady().then(async () => {
    watchdog = setTimeout(() => {
        console.error(`[ScriptoriumSmoke] TIMEOUT after ${TIMEOUT_MS} ms`);
        finish(1);
    }, TIMEOUT_MS);
    registerMinimalIpc();

    const windowRef = new BrowserWindow({
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

    const rendererErrors = [];
    windowRef.webContents.on('console-message', (...args) => {
        const details = args.find((value) =>
            value && typeof value === 'object'
            && typeof value.message === 'string'
        );
        const level = details?.level ?? args[1];
        const message = details?.message ?? args[2] ?? '';
        if (level === 'error' || level === 3) {
            rendererErrors.push(message);
            console.error('[ScriptoriumSmoke:Renderer]', message);
        }
    });
    windowRef.webContents.on('render-process-gone', (_event, details) => {
        rendererErrors.push(`render-process-gone:${details?.reason || 'unknown'}`);
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
        const waitFrames = () => new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const api = window.ScriptoriumAgent;
        const current = api.current();
        const source = () => current.getSource({
            sourceKind: 'markdown-hybrid',
            startLine: 1,
            endLine: 1000
        }).source;

        const initialSource = source();
        const libraryExtensions = [
            ...document.querySelectorAll(
                '#document-library-tree .library-file'
            )
        ].map((node) => node.dataset.extension).sort();
        const shell = {
            apiVersion: window.ScriptoriumAgent.version,
            libraryModuleAvailable:
                Boolean(window.ScriptoriumLibrary?.createLibraryController),
            libraryRootCount:
                document.querySelectorAll(
                    '#document-library-tree .library-root'
                ).length,
            libraryRootOrder: [
                ...document.querySelectorAll(
                    '#document-library-tree .library-root-copy strong'
                )
            ].map((node) => node.textContent).join(' > '),
            librarySupportsAllFormats:
                libraryExtensions.join(',') ===
                    'docx,html,md,pptx,txt,vdocx,vpptx',
            libraryNotBusy:
                !document.getElementById(
                    'document-library-tree'
                ).hasAttribute('aria-busy'),
            currentApiIsDocx: current === api.docx,
            title: document.getElementById('document-title').textContent,
            workspaceVisible:
                document.getElementById('document-workspace').hidden === false,
            renderVisible: document.getElementById('render-host').hidden === false,
            hasShadowRoot:
                Boolean(document.getElementById('page-stream').shadowRoot),
            sourceKind:
                current.getSource({ sourceKind: 'markdown-hybrid' }).sourceKind,
            sourceIsMarkdownFirst: initialSource.includes('# 未命名文稿'),
            sourceExcludesDerivedMetadata:
                !initialSource.includes('data-vdoc-edit-key')
                && !initialSource.includes('contenteditable=')
        };

        const infoBeforePr = current.getDocumentInfo();
        const pendingPromise = current.submitSourcePr({
            requestId: 'modern-smoke-pr',
            author: {
                id: 'smoke-agent',
                name: '冒烟测试 Agent',
                type: 'agent'
            },
            summary: '验证 Markdown-first Agent PR 审批链路',
            expectedRevision: infoBeforePr.revision,
            sourceKind: 'markdown-hybrid',
            replacements: [{
                target: '未命名文稿',
                replace: '审批后文稿',
                startLine: 1
            }]
        });
        await Promise.resolve();
        const pending = api.review.listPending();
        const unchangedBeforeApproval = source() === initialSource;
        const approval = pending[0]
            ? await api.review.approvePr(pending[0].id, {
                message: '内容准确，允许合并。',
                reviewer: {
                    id: 'smoke-human',
                    name: '冒烟测试审阅者',
                    type: 'human'
                }
            })
            : null;
        const completed = await pendingPromise;
        const afterApproval = source();
        const agentReview = {
            pendingWasCreated: pending.length === 1,
            pendingAuthor: pending[0]?.author?.name || '',
            unchangedBeforeApproval,
            approved: approval?.success === true && completed?.success === true,
            receiptDecision: completed?.receipt?.decision || '',
            receiptMessage: completed?.receipt?.message || '',
            sourceMerged:
                afterApproval.includes('# 审批后文稿')
                && !afterApproval.includes('# 未命名文稿'),
            pendingCleared: api.review.listPending().length === 0
        };

        document.getElementById('html-mode-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const codeMirror = document.querySelector(
            '.source-editor-shell .CodeMirror'
        )?.CodeMirror;
        const sourceFixture = [
            '',
            '',
            '## 冒烟章节',
            '',
            '正文第一行',
            '',
            '$E=mc^2$'
        ].join('\\n');
        codeMirror?.setValue(codeMirror.getValue() + sourceFixture);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const liveSource = source();
        const sourceEditor = {
            available: Boolean(codeMirror),
            title: document.getElementById('source-title').textContent,
            liveSyncLabel: document.querySelector('.source-live-sync')?.textContent,
            lineNumbers:
                Boolean(document.querySelector('.CodeMirror-linenumbers')),
            liveSyncWorked:
                liveSource.includes('## 冒烟章节')
                && liveSource.includes('$E=mc^2$'),
            diagnostics: document.getElementById('source-diagnostics').textContent
        };

        document.getElementById('render-mode-btn').click();
        await waitFrames();
        const editRoot = document.getElementById('page-stream').shadowRoot;
        const rendered = {
            continuous:
                Boolean(editRoot.querySelector('.vdoc-flow-runtime'))
                && editRoot.querySelectorAll('.vdoc-page').length === 0,
            headingRendered:
                [...editRoot.querySelectorAll('h2')]
                    .some((node) => node.textContent.includes('冒烟章节')),
            mathRendered:
                Boolean(editRoot.querySelector('[data-vdoc-math] .katex')),
            hasEditableRegion:
                Boolean(editRoot.querySelector('[data-vdoc-edit-key]'))
        };

        const beforeStructure = source();
        document.getElementById('block-type-select').value = 'blockquote';
        document.getElementById('insert-block-btn').click();
        await waitFrames();
        const afterStructure = source();
        const structure = {
            inserted:
                afterStructure.length > beforeStructure.length
                && afterStructure.includes('> 引文'),
            persistedAsMarkdown:
                !afterStructure.includes('data-vdoc-block')
        };

        document.getElementById('read-mode-btn').click();
        await waitFrames();
        const readRoot = document.getElementById('read-page-stream').shadowRoot;
        const reading = {
            hasPages: readRoot.querySelectorAll('.vdoc-page').length > 0,
            readonly: !readRoot.querySelector('[contenteditable="true"]'),
            darkInk:
                getComputedStyle(
                    readRoot.querySelector('.vdoc-page-content')
                ).color === 'rgb(29, 36, 33)',
            status: document.getElementById('page-status').textContent
        };
        document.getElementById('render-mode-btn').click();
        await waitFrames();

        document.getElementById('insert-media-btn').click();
        const mediaDialog = document.getElementById('media-dialog');
        const mediaSource = document.getElementById('media-src-input');
        const mediaDescription =
            document.getElementById('media-description-input');
        mediaSource.value =
            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" '
            + 'width="32" height="18"%3E%3Crect width="32" height="18" '
            + 'fill="%238b5e34"/%3E%3C/svg%3E';
        mediaDescription.value = '现代冒烟测试图片';
        document.getElementById('media-form').requestSubmit();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const afterMedia = source();
        const media = {
            dialogOpened: mediaDialog.hidden === true,
            sourcePersisted:
                afterMedia.includes('data-vdoc-media="image"')
                && afterMedia.includes('现代冒烟测试图片'),
            descriptionPersisted:
                afterMedia.includes('description="现代冒烟测试图片"'),
            semanticMetadataPersisted:
                afterMedia.includes('data-vdoc-object="media"')
        };

        const restoredStylePack = current.getStylePack({
            packId: 'vcp.test.persisted-style'
        });
        const createdStylePack = await current.upsertStylePack({
            requestId: 'smoke-style-pack-create',
            maid: {
                id: 'smoke-agent',
                name: '冒烟测试 Agent',
                type: 'agent'
            },
            pack: {
                format: 'vcp-vdoc-style-pack',
                version: 1,
                manifest: {
                    id: 'vcp.test.agent-persisted-style',
                    name: 'Agent 持久化样式',
                    author: '冒烟测试 Agent'
                },
                styles: [{
                    id: 'vcp.test.agent-persisted-style.accent',
                    version: 1,
                    name: 'Agent 强调',
                    category: '自动化测试',
                    targets: ['inline'],
                    className: 'vds-agent-persisted-accent',
                    css: '.vds-agent-persisted-accent{color:#246813}'
                }]
            }
        });
        const stylePersistence = {
            restoredAtStartup:
                restoredStylePack.success === true
                && restoredStylePack.pack.styles.length === 1,
            agentCreateSucceeded:
                createdStylePack.success === true
                && createdStylePack.operation === 'create',
            visibleGlobally:
                current.getStylePack({
                    packId: 'vcp.test.agent-persisted-style'
                }).success === true
        };

        const styles = current.listStylePacks();
        const svgPacks = current.listSvgAssetPacks();
        const svgAssets = current.listSvgAssets();
        const agentOutline = current.getOutline();
        const smokeHeading = agentOutline.items.find((item) =>
            item.text === '冒烟章节'
        );
        const smokeSection = smokeHeading
            ? current.getSection({ id: smokeHeading.id })
            : null;
        const uiHeadingTexts = [
            ...document.querySelectorAll(
                '#outline-tree .outline-item-title'
            )
        ].map((node) => node.textContent.trim());
        const capabilities = {
            stylePacksAvailable:
                styles.success === true && styles.count > 0,
            svgAssetApiAvailable:
                svgPacks.success === true
                && svgAssets.success === true,
            outlineAvailable:
                agentOutline.sourceKind === 'markdown-hybrid',
            outlineHasLongDocumentMetadata:
                agentOutline.count === agentOutline.items.length
                && agentOutline.totalCharacters === source().length
                && smokeHeading?.characterCount > 0
                && smokeHeading?.sourceRange?.end
                    > smokeHeading?.sourceRange?.start,
            uiAndAgentOutlineAgree:
                agentOutline.items.every((item) =>
                    uiHeadingTexts.includes(item.text)
                ),
            sectionReadableByOutlineId:
                smokeSection?.heading?.id === smokeHeading?.id
                && smokeSection.source.includes('## 冒烟章节')
                && smokeSection.renderedText.includes('正文第一行'),
            renderedTextAvailable:
                current.getRenderedText().semanticFormat === 'compiled-html',
            deckRoundTrips: (() => {
                const deck = window.VDocCore.createDocument({
                    title: '演示往返',
                    kind: window.VDocCore.PROJECT_KINDS.SLIDE_DECK,
                    slides: [{
                        name: '第一页',
                        source:
                            '<section class="vdoc-slide-scene"><h1>第一页</h1></section>'
                    }]
                });
                const restored = window.VDocCore.parse(
                    window.VDocCore.serialize(deck)
                );
                return restored.manifest.scene.kind === 'slide-deck'
                    && restored.source.slides.length === 1;
            })()
        };

        return {
            shell,
            agentReview,
            sourceEditor,
            rendered,
            structure,
            reading,
            media,
            stylePersistence,
            capabilities
        };
    })()`);

    result.stylePersistence.savedByIpc =
        persistedStylePacks.some((pack) =>
            pack.manifest?.id === 'vcp.test.persisted-style'
        )
        && persistedStylePacks.some((pack) =>
            pack.manifest?.id === 'vcp.test.agent-persisted-style'
        );
    console.log('[ScriptoriumSmoke] Snapshot:', JSON.stringify(result, null, 2));
    const failed = [];
    const inspect = (value, prefix = '') => {
        Object.entries(value || {}).forEach(([key, entry]) => {
            const pathName = prefix ? `${prefix}.${key}` : key;
            if (entry && typeof entry === 'object') {
                inspect(entry, pathName);
            } else if (
                typeof entry === 'boolean'
                && entry !== true
            ) {
                failed.push(pathName);
            }
        });
    };
    inspect(result);

    const exact = {
        'shell.apiVersion': 5,
        'shell.libraryRootCount': 3,
        'shell.libraryRootOrder': '用户文档 > 用户演示 > 用户笔记',
        'shell.sourceKind': 'markdown-hybrid',
        'agentReview.pendingAuthor': '冒烟测试 Agent',
        'agentReview.receiptDecision': 'approved',
        'agentReview.receiptMessage': '内容准确，允许合并。',
        'sourceEditor.title': 'Markdown-first 混合源码',
        'sourceEditor.liveSyncLabel': '实时同步',
        'reading.status': '连续编辑',
    };
    Object.entries(exact).forEach(([pathName, expected]) => {
        const actual = pathName.split('.').reduce(
            (value, key) => value?.[key],
            result
        );
        if (actual !== expected) {
            failed.push(`${pathName}=${JSON.stringify(actual)}`);
        }
    });
    rendererErrors.forEach((error) => failed.push(`renderer:${error}`));

    if (failed.length) {
        console.error('[ScriptoriumSmoke] FAILED:', JSON.stringify(failed, null, 2));
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