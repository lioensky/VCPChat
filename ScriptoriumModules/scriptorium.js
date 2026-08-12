'use strict';

(() => {
    const api = window.scriptoriumAPI || window.docxAPI;
    const core = window.VDocCore;
    const containerModule = window.VDocContainer;
    const hybridCompiler = window.VDocHybridCompiler;
    const styleLibrary = window.VDocStyleLibrary;
    const pagination = window.VDocPagination;
    const asyncModule = window.ScriptoriumAsync;
    const exportResourcesModule = window.ScriptoriumExportResources;
    const runtimeModule = window.ScriptoriumRuntime;
    const sourceEditorModule = window.ScriptoriumSourceEditor;
    const sessionModule = window.ScriptoriumSession;
    const objectModule = window.ScriptoriumObjects;
    const state = {
        document: null,
        currentPath: null,
        currentName: '未命名文稿.vdocx',
        dirty: false,
        ready: false,
        saving: false,
        loading: false,
        zoom: 100,
        mode: 'render',
        sourceMode: 'html',
        history: [],
        historyIndex: -1,
        checkpoints: [],
        pageObserver: null,
        activePage: null,
        themeDisposer: null,
        pathRequestDisposer: null,
        agentCheckpointDisposer: null,
        unsavedResolver: null,
        renderUpdateTimer: null,
        editBurstDirty: false,
        sourceEditorTimer: null,
        metricsTimer: null,
        paginationTimer: null,
        pendingRenderedNodes: new Map(),
        pendingRenderedAttributes: new Map(),
        renderedTextBlocks: [],
        pointerSelectionFrame: null,
        pendingPointerSelectionId: null,
        renderSurfaceAbortController: null,
        compositionEnterTarget: null,
        compositionEnterFrame: null,
        formattingSyncFrame: null,
        pendingFormattingTarget: null,
        fontOptionLookup: new WeakMap(),
        documentRevision: 0,
        documentGeneration: 0,
        agentApi: null,
        agentRequestDisposer: null,
        previewRevision: -1,
        previewResult: null,
        compiledRevision: -1,
        compiledDocument: null,
        activeSlideIndex: 0,
        exportHtml: '',
        systemFonts: [],
        selectionRange: null,
        selectionText: '',
        selectionBlockIds: [],
        explicitBlockSelection: false,
        blockSelectionAnchorId: null,
        pointerSelectionAnchorId: null,
        pointerSelectingBlocks: false,
        selectedAdvancedStyleId: null,
        usedAdvancedStyleIds: new Set(),
        styleLibraryDisposer: null,
        sourceEditor: null,
        sourceColorMarks: [],
        activeEditableBlock: null,
        activeReviewPrId: null,
        activeLineageRecordId: null,
        pendingRestoreRecordId: null,
        securityReviewEnabled: true,
        autoApprovalScheduled: new Set(),
        slideThumbnailObserver: null,
        slideRuntimeDisposer: null,
        slideRuntimeIdentity: null,
        programmableContentDiagnostics: [],
        checkpointSaveQueue: Promise.resolve(),
        documentResourceData: new Map(),
        resourceObjectUrls: new Map(),
        resourceResolver: null,
        mediaLocalItems: [],
        objectController: null,
        lineageAgents: [],
        lineageAvatarCache: new Map(),
        lineageAvatarPending: new Map(),
        copiedRichHtml: '',
        copiedPlainText: '',
        textContextBlock: null,
        textContextRange: null,
        textContextPoint: null,
        findQuery: '',
        findMatches: [],
        findIndex: -1,
        findSourceMarks: [],
        mermaidRenderSequence: 0,
        activeHybridTextEdit: null,
        markdownLivePreview: null,
        hybridDomSourceMap: new WeakMap(),
        hybridTextSourceMap: new WeakMap(),
        hybridEditSessions: new WeakMap(),
    };

    const asyncCoordinator = asyncModule?.createCoordinator({
        getGeneration: () => state.documentGeneration,
        getDocumentId: () => state.document?.manifest?.id || null,
        getRevision: () => state.documentRevision,
    });
    const elements = {};
    const $ = (id) => document.getElementById(id);
    const sourceEditorController = sourceEditorModule?.createSourceEditorController({
        state,
        elements,
        core,
        hybridCompiler,
        isSlideDeck,
        getCurrentHtml: currentSourceHtml,
        getCurrentCss: currentSourceCss,
    });
    const sessionController = sessionModule?.createSessionController({
        state,
        elements,
        api,
        core,
        containerModule,
        styleLibrary,
        asyncCoordinator,
        isSlideDeck,
        finalizeEditBurst,
        applySourceChanges,
        renderDocument,
        switchMode,
        captureSnapshot,
        markDirty,
        markSaved,
        updateIdentity,
        renderLineage,
        showToast,
    });

    function cacheElements() {
        [
            'document-state-dot', 'document-title', 'save-state',
            'outline-toggle-btn', 'focus-mode-btn', 'focus-mode-dock',
            'focus-document-title', 'focus-exit-btn', 'lineage-toggle-btn',
            'minimize-btn', 'maximize-btn', 'close-btn',
            'new-btn', 'new-deck-btn', 'open-btn', 'import-btn', 'save-btn', 'save-as-btn',
            'collect-external-resources',
            'export-flow-html-btn', 'export-paged-html-btn', 'export-pdf-btn',
            'render-mode-btn', 'read-mode-btn', 'html-mode-btn', 'css-mode-btn',
            'font-family-select', 'font-size-select', 'text-color-input',
            'highlight-color-input', 'line-height-select', 'block-type-select',
            'insert-block-btn', 'insert-table-btn', 'find-btn',
            'shape-kind-select', 'insert-shape-btn', 'text-context-menu',
            'object-context-menu',
            'object-inspector-dialog', 'object-inspector-form',
            'object-inspector-title', 'object-inspector-cancel-btn',
            'object-name-input', 'object-description-input',
            'object-width-input', 'object-height-input', 'object-rotation-input',
            'object-layout-field', 'object-layout-select', 'object-rotation-field',
            'object-shape-fields', 'object-fill-input', 'object-stroke-input',
            'object-stroke-width-input', 'object-radius-input',
            'object-opacity-input', 'object-dash-select',
            'object-svg-source-input', 'object-css-source-input',
            'object-source-diagnostics', 'object-preview-frame',
            'object-inspector-apply-btn',
            'welcome-state', 'welcome-new-btn', 'welcome-open-btn', 'recent-documents',
            'document-workspace', 'render-host', 'page-stream', 'read-host',
            'read-page-stream', 'source-host',
            'source-title', 'source-description', 'source-editor', 'apply-source-btn',
            'format-source-btn', 'source-diagnostics', 'source-wrap-toggle',
            'source-color-input', 'source-color-swatch',
            'loading-state', 'outline-resizer', 'lineage-resizer',
            'outline-count', 'outline-headings-tab', 'outline-paragraphs-tab',
            'outline-headings-view', 'outline-paragraphs-view', 'outline-tree',
            'paragraph-index', 'outline-empty', 'slide-navigator-header',
            'add-slide-btn', 'delete-slide-btn', 'slide-count', 'slide-navigator',
            'lineage-flow', 'checkpoint-count', 'pending-pr-count',
            'auto-approval-enabled', 'auto-approval-types',
            'create-checkpoint-btn', 'page-status', 'word-count', 'character-count',
            'font-status', 'selection-status', 'zoom-out-btn', 'zoom-range', 'zoom-in-btn', 'zoom-value',
            'toast-region', 'selection-format-bar', 'selection-font-family',
            'selection-font-size', 'selection-text-color', 'advanced-style-btn',
            'style-library-dialog', 'style-library-close-btn', 'style-search-input',
            'style-category-select', 'style-import-btn', 'style-export-btn',
            'style-import-input', 'style-library-list', 'style-preview-category',
            'style-preview-name', 'style-preview-description', 'style-preview-frame',
            'style-preview-targets', 'style-apply-btn', 'unsaved-dialog',
            'unsaved-dialog-message', 'unsaved-document-name', 'unsaved-cancel-btn',
            'unsaved-discard-btn', 'unsaved-save-btn', 'media-dialog', 'media-form',
            'media-src-fields', 'media-kind-select', 'media-src-input', 'media-description-input',
            'media-dialog-status', 'media-cancel-btn', 'media-insert-btn',
            'media-local-select-btn', 'media-local-input', 'media-local-count',
            'media-local-list', 'checkpoint-dialog',
            'checkpoint-name-input', 'checkpoint-note-input', 'checkpoint-cancel-btn',
            'pr-review-dialog', 'pr-review-title', 'pr-review-meta',
            'pr-review-close-btn', 'pr-render-diff', 'pr-source-diff',
            'pr-review-receipt', 'pr-review-reject-btn', 'pr-review-approve-btn',
            'security-review-toggle', 'security-review-dialog',
            'security-review-confirm-check', 'security-review-cancel-btn',
            'security-review-disable-btn', 'lineage-detail-dialog',
            'lineage-detail-title', 'lineage-detail-meta', 'lineage-detail-close-btn',
            'lineage-detail-record', 'lineage-detail-change', 'lineage-snapshot-status',
            'lineage-restore-btn', 'lineage-restore-dialog', 'lineage-restore-message',
            'lineage-restore-cancel-btn', 'lineage-restore-confirm-btn',
            'find-panel', 'find-input', 'find-scope', 'find-status',
            'find-previous-btn', 'find-next-btn', 'find-close-btn',
        ].forEach((id) => {
            elements[id] = $(id);
        });
    }

    function showToast(message, type = 'info', duration = 2600) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        elements['toast-region'].appendChild(toast);
        window.setTimeout(() => {
            toast.style.opacity = '0';
            window.setTimeout(() => toast.remove(), 180);
        }, duration);
    }

    function applyTheme(theme) {
        document.body.classList.toggle('light-theme', theme === 'light');
    }

    async function initializeTheme() {
        try {
            applyTheme(await api.getCurrentTheme());
        } catch {
            applyTheme('dark');
        }
        state.themeDisposer = api.onThemeUpdated(applyTheme);
    }

    function updateIdentity() {
        const displayName = state.currentName || '未命名文稿.vdocx';
        elements['document-title'].textContent = displayName;
        elements['document-title'].title = state.currentPath || '尚未保存到磁盘';
        elements['focus-document-title'].textContent = displayName;
        elements['focus-document-title'].title = state.currentPath || displayName;
        elements['save-state'].textContent = state.loading
            ? '正在展开'
            : state.saving
                ? '正在保存'
                : state.dirty
                    ? '有未保存修改'
                    : state.ready
                        ? '已保存'
                        : '等待落笔';
        elements['document-state-dot'].classList.toggle('dirty', state.dirty && !state.saving);
        elements['document-state-dot'].classList.toggle('saved', state.ready && !state.dirty);
        elements['save-btn'].disabled = !state.ready || state.saving;
        elements['save-as-btn'].disabled = !state.ready || state.saving;
        elements['export-flow-html-btn'].disabled = !state.ready || state.saving;
        elements['export-paged-html-btn'].disabled = !state.ready || state.saving;
        elements['export-pdf-btn'].disabled = !state.ready || state.saving;
        elements['create-checkpoint-btn'].disabled = !state.ready || state.saving;
        syncFocusModeAvailability();
    }
    function markDirty(options = {}) {
        if (!state.ready || state.loading) return;
        state.dirty = true;
        // 高频编辑期间只建立一次修订脏标记。两秒凝固提交后，
        // 下一轮输入才创建新的 revision，避免每个按键触发状态与统计工作。
        if (!options.coalesce || !state.editBurstDirty) {
            state.documentRevision += 1;
            state.previewRevision = -1;
            state.previewResult = null;
            updateIdentity();
            // 连续编辑的统计、大纲和历史统一由两秒凝固提交处理。
            // 非队列事务仍可在这里安排统计刷新。
            if (!options.coalesce) scheduleMetrics();
        }
        if (options.coalesce) state.editBurstDirty = true;
    }

    function markSaved() {
        state.dirty = false;
        state.editBurstDirty = false;
        updateIdentity();
    }

    function sourceStateOf(documentModel = state.document) {
        if (!documentModel) return null;
        const deck = documentModel.manifest?.scene?.kind
            === core.PROJECT_KINDS.SLIDE_DECK;
        return {
            documentKind: deck ? 'pptx' : 'docx',
            scene: documentModel.manifest?.scene
                ? JSON.parse(JSON.stringify(documentModel.manifest.scene))
                : null,
            source: deck ? '' : String(documentModel.source?.content || ''),
            deckCss: deck ? String(documentModel.source?.deckCss || '') : '',
            slides: deck
                ? (documentModel.source?.slides || []).map((slide, index) => ({
                    index,
                    id: slide.id,
                    name: slide.name,
                    source: String(slide.source || ''),
                    transition: slide.transition ?? null,
                    duration: slide.duration ?? null,
                    notes: String(slide.notes || ''),
                    resources: Array.isArray(slide.resources)
                        ? JSON.parse(JSON.stringify(slide.resources))
                        : [],
                }))
                : [],
        };
    }

    function createVersionSnapshot(documentModel = state.document) {
        if (!documentModel) return '';
        // 工程内版本快照保留完整文档模型、changeSet 和文脉元数据，
        // 但剥离各历史节点自身携带的 snapshot 字符串，避免快照递归嵌套。
        const normalized = JSON.parse(core.serialize(documentModel));
        normalized.checkpoints = (normalized.checkpoints || []).map((checkpoint) => {
            const { snapshot, ...record } = checkpoint || {};
            return record;
        });
        return JSON.stringify(normalized, null, 2);
    }

    function changeSetForLineageRecord(record) {
        if (record?.changeSet) {
            return {
                storage: 'changeSet',
                exactBeforeAfter: record.changeSet.before !== undefined
                    && record.changeSet.after !== undefined,
                ...record.changeSet,
            };
        }
        if (typeof record?.snapshot === 'string' && record.snapshot.trim()) {
            try {
                const snapshotDocument = core.parse(record.snapshot);
                return {
                    storage: 'legacy-snapshot',
                    exactBeforeAfter: false,
                    notice: '旧节点未保存精确代码差异；以下为该节点版本快照中的完整源码状态。',
                    type: record.operation?.type || 'snapshot-state',
                    before: null,
                    after: sourceStateOf(snapshotDocument),
                };
            } catch (error) {
                return {
                    storage: 'invalid-snapshot',
                    exactBeforeAfter: false,
                    notice: `节点快照无法解析：${error.message}`,
                    type: record.operation?.type || 'unknown',
                    before: null,
                    after: null,
                };
            }
        }
        return {
            storage: 'metadata-only',
            exactBeforeAfter: false,
            notice: '此旧节点没有保存 changeSet 或版本快照，无法恢复原始代码变动。',
            type: record?.operation?.type || record?.proposal?.type || 'unknown',
            before: null,
            after: null,
        };
    }

    function captureSnapshot() {
        if (!state.document) return;
        flushPendingRenderedEdits();
        const snapshot = core.serialize(state.document);
        if (state.history[state.historyIndex] === snapshot) return;
        state.history = state.history.slice(0, state.historyIndex + 1);
        state.history.push(snapshot);
        if (state.history.length > 80) state.history.shift();
        state.historyIndex = state.history.length - 1;
    }

    function captureRenderViewport() {
        const host = elements['render-host'];
        if (!host) return null;
        return {
            scrollLeft: host.scrollLeft,
            scrollTop: host.scrollTop,
        };
    }

    function restoreRenderViewport(viewport) {
        if (!viewport) return;
        window.requestAnimationFrame(() => {
            elements['render-host'].scrollLeft = viewport.scrollLeft;
            elements['render-host'].scrollTop = viewport.scrollTop;
        });
    }

    function restoreHistory(offset) {
        finalizeEditBurst();
        const nextIndex = state.historyIndex + offset;
        if (nextIndex < 0 || nextIndex >= state.history.length) return false;
        const viewport = captureRenderViewport();
        state.historyIndex = nextIndex;
        state.document = core.parse(state.history[nextIndex]);
        renderDocument();
        restoreRenderViewport(viewport);
        markDirty();
        return true;
    }

    function getRenderRoot() {
        return elements['page-stream'].shadowRoot;
    }

    function getReadRoot() {
        return elements['read-page-stream'].shadowRoot;
    }

    function isSlideDeck() {
        return state.document?.manifest?.scene?.kind === core.PROJECT_KINDS.SLIDE_DECK;
    }

    function syncFocusModeAvailability() {
        const available = state.ready && !state.loading && !isSlideDeck();
        elements['focus-mode-btn'].hidden = !available;
        elements['focus-mode-btn'].disabled = !available;
        if (!available && document.body.classList.contains('focus-mode')) {
            setFocusMode(false);
        }
        return available;
    }

    function setFocusMode(enabled) {
        const enter = enabled === true;
        if (enter) {
            if (!syncFocusModeAvailability()) return false;
            if (state.mode !== 'render') switchMode('render');
            if (state.mode !== 'render') return false;
            hideSelectionBar();
            state.objectController?.closeInspector(true);
            state.objectController?.clearSelection();
        }

        document.body.classList.toggle('focus-mode', enter);
        elements['focus-mode-dock'].hidden = !enter;
        elements['focus-mode-btn'].classList.toggle('active', enter);
        elements['focus-mode-btn'].setAttribute('aria-pressed', String(enter));
        elements['focus-mode-btn'].title = enter
            ? '退出纯文专注模式'
            : '进入纯文专注模式';
        if (enter) {
            window.requestAnimationFrame(() => state.activeEditableBlock?.focus?.());
        }
        return enter;
    }

    function toggleFocusMode() {
        return setFocusMode(!document.body.classList.contains('focus-mode'));
    }

    function activeSlide() {
        const slides = state.document?.source?.slides || [];
        return slides[state.activeSlideIndex] || slides[0] || null;
    }

    function parsedSlide(slide = activeSlide()) {
        if (!slide) return { html: '', css: '', script: '' };
        return {
            ...core.splitSlideSource(slide.source),
            id: slide.id,
            name: slide.name,
        };
    }

    function parsedDocument(force = false) {
        if (!state.document || isSlideDeck()) {
            return {
                html: '',
                css: '',
                blocks: [],
                islands: [],
                dependencies: [],
                diagnostics: [],
            };
        }
        if (!force
            && state.compiledRevision === state.documentRevision
            && state.compiledDocument) {
            return state.compiledDocument;
        }
        const compiled = hybridCompiler.compile(
            String(state.document.source?.content || ''),
            { sanitizeHtml: core.sanitizeHtml }
        );
        state.document.source.lineEnding = compiled.lineEnding;
        const previousIslands = new Map(
            (state.document.islands || []).map((island) => [island.id, island])
        );
        state.document.islands = compiled.islands.map((island) => ({
            ...previousIslands.get(island.id),
            ...island,
            runtimeTextOverrides: Array.isArray(
                previousIslands.get(island.id)?.runtimeTextOverrides
            )
                ? previousIslands.get(island.id).runtimeTextOverrides
                : [],
        }));
        state.document.manifest.programmableDependencies = [
            ...new Set(compiled.dependencies.filter((item) =>
                ['anime', 'three'].includes(item)
            )),
        ];
        state.compiledRevision = state.documentRevision;
        state.compiledDocument = {
            ...compiled,
            css: core.sanitizeCss(state.document.source?.documentCss || ''),
        };
        return state.compiledDocument;
    }

    function currentSourceHtml() {
        return isSlideDeck()
            ? String(activeSlide()?.source || '')
            : String(state.document?.source?.content || '');
    }

    function setCurrentSourceHtml(source) {
        if (isSlideDeck()) {
            const slide = activeSlide();
            if (slide) slide.source = core.normalizeCompleteSlideSource(source);
        } else {
            state.document.source.content = String(source ?? '');
            state.document.source.format = core.SOURCE_FORMATS.MARKDOWN_HYBRID;
            state.document.manifest.sourceFormat = core.SOURCE_FORMATS.MARKDOWN_HYBRID;
            state.compiledRevision = -1;
            state.compiledDocument = null;
        }
    }

    function resolveRuntimeResources(source) {
        return state.resourceResolver?.resolveHtml(source) || String(source || '');
    }

    function currentSourceCss() {
        return isSlideDeck()
            ? state.document?.source?.deckCss || ''
            : String(state.document?.source?.documentCss || '');
    }

    function setCurrentSourceCss(css) {
        if (isSlideDeck()) {
            state.document.source.deckCss = core.sanitizeCss(css);
            return;
        }
        state.document.source.documentCss = core.sanitizeCss(css);
        state.compiledRevision = -1;
        state.compiledDocument = null;
    }

    function documentCssForShadow() {
        const css = isSlideDeck()
            ? state.document.source.deckCss
            : state.document.source.documentCss;
        return String(css || '')
            .replace(/(^|})\s*:root\s*\{/g, '$1\n:host {')
            .replace(/(^|})\s*html\s*,\s*body\s*\{/g, '$1\n:host {')
            .replace(/(^|})\s*body\s*\{/g, '$1\n:host {');
    }

    function markdownBaseCss(scope) {
        return `
${scope} table {
    width: 100%;
    margin: 1.25em 0;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
    border-collapse: separate;
    border-spacing: 0;
    border-radius: 10px;
    background: color-mix(in srgb, currentColor 3%, transparent);
}
${scope} th,
${scope} td {
    min-width: 3em;
    padding: .62em .78em;
    border-right: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    text-align: left;
    vertical-align: top;
}
${scope} th {
    font-weight: 700;
    background: color-mix(in srgb, currentColor 9%, transparent);
}
${scope} tr > :last-child { border-right: 0; }
${scope} tbody tr:last-child > td { border-bottom: 0; }
${scope} tbody tr:nth-child(even) {
    background: color-mix(in srgb, currentColor 3.5%, transparent);
}
${scope} table code { white-space: nowrap; }
`;
    }

    function buildDocumentStyle(surface = 'edit') {
        const scene = core.createSceneConfig(state.document.manifest.scene);
        return `
@import url("../vendor/katex.min.css");
:host {
    display: block;
    min-height: 100%;
    --vdoc-page-width: ${scene.page.width};
    --vdoc-page-height: ${scene.page.height};
    --vdoc-page-gap: ${scene.page.gap};
    --vdoc-page-padding-block: 24mm 26mm;
    --vdoc-page-padding-inline: 22mm;
}
.vdoc-runtime { display: block; }
.vdoc-flow-runtime {
    width: min(calc(100% - 48px), 1440px);
    min-height: calc(100% - 64px);
    margin: 0 auto;
    padding: clamp(28px, 4vw, 64px) clamp(22px, 5vw, 72px) 96px;
    color: var(--primary-text, #f2f0e9) !important;
    background: transparent !important;
    box-shadow: none !important;
    zoom: var(--vdoc-zoom, 1);
    --vdoc-ink: var(--primary-text, #f2f0e9);
    --vdoc-muted: var(--secondary-text, #a7afb1);
    --vdoc-paper: transparent;
}
.vdoc-flow-runtime,
.vdoc-flow-runtime .vdoc-manuscript {
    color: var(--primary-text, #f2f0e9);
    background: transparent;
}
.vdoc-flow-runtime .vdoc-lead,
.vdoc-flow-runtime .vdoc-eyebrow {
    color: var(--secondary-text, #a7afb1);
}
.vdoc-slide-editor-runtime {
    display: grid;
    width: var(--vdoc-page-width);
    height: var(--vdoc-page-height);
    margin: 32px auto 88px;
    overflow: hidden;
    place-items: stretch;
    color: #1d2421;
    background: #fffdf8;
    box-shadow: 0 18px 55px rgba(0, 0, 0, .34);
    transform: scale(var(--vdoc-zoom, 1));
    transform-origin: top center;
    --vdoc-ink: #1d2421;
    --vdoc-muted: #66706b;
    --vdoc-paper: #fffdf8;
}
.vdoc-slide-editor-runtime > .vdoc-slide-scene {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
}
.vdoc-paged-runtime { padding: 18px 0 88px; }
.vdoc-page {
    width: var(--vdoc-page-width) !important;
    height: var(--vdoc-page-height) !important;
    min-height: var(--vdoc-page-height) !important;
    margin: 0 auto calc(var(--vdoc-page-gap) + var(--vdoc-zoom-height-compensation, 0px)) !important;
    padding: 0 !important;
    overflow: hidden;
    color: #1d2421 !important;
    background: #fffdf8 !important;
    box-shadow: 0 18px 55px rgba(0, 0, 0, .34);
    transform: scale(var(--vdoc-zoom, 1));
    --vdoc-ink: #1d2421;
    --vdoc-muted: #66706b;
    --vdoc-paper: #fffdf8;
    transform-origin: top center;
}
.vdoc-page-content {
    width: 100%;
    height: 100%;
    padding: var(--vdoc-page-padding-block) var(--vdoc-page-padding-inline);
    overflow: hidden;
    color: #1d2421 !important;
    background: #fffdf8 !important;
}
.vdoc-page-content .vdoc-manuscript {
    color: #1d2421;
    background: transparent;
}
.vdoc-runtime[data-scene-kind="slide-deck"] .vdoc-page {
    position: relative;
    height: var(--vdoc-page-height);
    overflow: hidden;
}
.vdoc-runtime[data-scene-kind="slide-deck"] .vdoc-page-content {
    padding: 0;
}
.vdoc-runtime[data-scene-kind="slide-deck"] .vdoc-page-content > [data-vdoc-slide],
.vdoc-runtime[data-scene-kind="slide-deck"] .vdoc-page-content .vdoc-slide-scene {
    width: 100%;
    height: 100%;
}
.vdoc-page[data-runtime-state="paused"] *,
.vdoc-page[data-runtime-state="paused"] *::before,
.vdoc-page[data-runtime-state="paused"] *::after,
.vdoc-runtime-paused *,
.vdoc-runtime-paused *::before,
.vdoc-runtime-paused *::after {
    animation-play-state: paused !important;
    transition: none !important;
}
[data-vdoc-text][data-vdoc-editor-selected="true"] {
    position: relative;
    outline: 2px solid rgba(58, 139, 120, .72) !important;
    outline-offset: 3px;
    background-color: rgba(58, 139, 120, .12) !important;
    box-shadow: 0 0 0 5px rgba(58, 139, 120, .06) !important;
}
::highlight(scriptorium-find-match) {
    color: inherit;
    background: rgba(242, 169, 0, .36);
    text-decoration: underline rgba(184, 117, 0, .72) 1px;
}
::highlight(scriptorium-find-current) {
    color: #171c1a;
    background: #ffc94a;
    text-decoration: underline #8b5e00 2px;
}
/*
 * 对象编辑装饰仅存在于编辑 ShadowRoot。对象本身的布局属性位于源码，
 * 选择框、拖拽光标和落点提示不会进入 VDOC 或导出结果。
 */
[data-vdoc-object-id] {
    box-sizing: border-box;
    touch-action: none;
}
[data-vdoc-object-id][data-vdoc-object-layout="free"] {
    cursor: move;
    user-select: none;
}
[data-vdoc-object-id][data-vdoc-object-layout^="float"],
[data-vdoc-object-id][data-vdoc-object-layout="block"] {
    cursor: grab;
}
[data-vdoc-object-id][data-vdoc-object-selected="true"] {
    outline: 2px solid #3a8b78 !important;
    outline-offset: 4px;
    box-shadow: 0 0 0 6px rgba(58, 139, 120, .14) !important;
}
[data-vdoc-object-id][data-vdoc-object-dragging="true"] {
    cursor: grabbing !important;
    opacity: .84;
}
[data-vdoc-text][data-vdoc-object-drop="before"] {
    box-shadow: 0 -3px 0 #3a8b78 !important;
}
[data-vdoc-text][data-vdoc-object-drop="after"] {
    box-shadow: 0 3px 0 #3a8b78 !important;
}
[data-vdoc-object="shape"] > svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
}
.vdoc-page-tombstone {
    display: grid;
    width: var(--vdoc-page-width);
    min-height: var(--vdoc-page-height);
    margin: 24px auto;
    place-items: center;
    color: #777;
    background: #f7f3e9;
    box-shadow: 0 18px 55px rgba(25, 30, 27, .12);
}
@media print {
    .vdoc-paged-runtime { padding: 0; }
    .vdoc-page { transform: none; margin: 0 !important; box-shadow: none; break-after: page; }
}
${markdownBaseCss('.vdoc-runtime')}
.vdoc-edit-region {
    position: relative;
    min-width: 0;
}
.vdoc-edit-region[data-vdoc-edit-active="true"] {
    z-index: 1;
}
.vdoc-edit-region[data-vdoc-edit-type="island"]:hover {
    outline: 1px solid rgba(217, 119, 69, .42);
    outline-offset: 5px;
}
${styleLibrary.compileCss([...state.usedAdvancedStyleIds])}
${documentCssForShadow()}

/*
 * 分页框架边界必须位于文档自定义 CSS 之后。统一源码允许作者定义通用的
 * section、div、* 盒模型规则，但这些规则不能改变分页器自身的测量容器。
 * page-content 使用 border-box 后，其 100% 宽高才包含纸张内边距，不会
 * 向右、向下越出纸页并欺骗 scrollHeight/clientHeight 溢出判断。
 */
.vdoc-paged-runtime {
    display: flow-root !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
}
.vdoc-paged-runtime > .vdoc-page {
    display: block !important;
    box-sizing: border-box !important;
    flex: none !important;
    max-width: none !important;
}
.vdoc-paged-runtime > .vdoc-page > .vdoc-page-content {
    display: block !important;
    box-sizing: border-box !important;
    width: 100% !important;
    height: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
}
.vdoc-paged-runtime > .vdoc-page > .vdoc-page-content * {
    max-width: 100%;
    overflow-wrap: break-word;
}
${surface === 'edit' ? `
.vdoc-page { display: none !important; }

/*
 * 岛内文字编辑保障必须位于作者 CSS 之后。可编程岛经常使用绝对定位、
 * 3D transform、透明深度层或 user-select:none；这些视觉规则不能阻止
 * 已建立源码映射的静态文字和运行态表格文字获得原生光标。
 .vdoc-edit-region[data-vdoc-edit-type="markdown"][data-vdoc-edit-active="true"] {
     /*
      * Live Preview 必须留在原排版流中。活动态不建立输入框外观，也不改变
      * 壳的盒模型；标题、段落、引用和列表继续使用文档自身的布局。
      */
     margin: inherit !important;
     padding: 0 !important;
     border: 0 !important;
     background: transparent !important;
     box-shadow: none !important;
     outline: 0 !important;
 }
 .vdoc-md-live-preview {
     min-width: 0 !important;
     min-height: 1em !important;
     border: 0 !important;
     outline: 0 !important;
     color: inherit !important;
     background: transparent !important;
     /*
      * 编辑态保留 textContent 中的真实换行，但视觉上按普通空白折叠为一个
      * 空格。退出 Live Preview 后重新编译 Markdown，行尾双空格与换行仍
      * 会恢复为正式的 <br>，因此这里只改变临时呈现，不改写正文真源。
      */
     white-space: normal !important;
     overflow-wrap: anywhere !important;
     tab-size: 4 !important;
     caret-color: #3a8b78 !important;
     cursor: text !important;
     user-select: text !important;
     -webkit-user-select: text !important;
 }
 }
 .vdoc-md-live-preview:empty::before {
     content: "输入 Markdown…" !important;
     color: color-mix(in srgb, currentColor 38%, transparent) !important;
     pointer-events: none !important;
 .vdoc-md-marker {
     display: inline !important;
     margin: 0 !important;
     padding: 0 !important;
     border: 0 !important;
     color: color-mix(in srgb, currentColor 48%, #d97745) !important;
     background: transparent !important;
     font-family: Consolas, "Maple Mono", monospace !important;
     font-size: .72em !important;
     font-style: normal !important;
     font-weight: 600 !important;
     line-height: inherit !important;
     text-decoration: none !important;
     vertical-align: .06em !important;
     opacity: .72 !important;
 }
 .vdoc-md-marker-concealed {
     display: none !important;
 }
 .vdoc-md-marker-heading {
     color: color-mix(in srgb, currentColor 48%, #3a8b78) !important;
 }
 .vdoc-md-marker-quote {
     color: color-mix(in srgb, currentColor 48%, #8b6cab) !important;
 }
 .vdoc-md-marker-list,
 .vdoc-md-marker-task-list {
     color: color-mix(in srgb, currentColor 48%, #b87828) !important;
 }
 }
 .vdoc-md-marker-strong {
     font-weight: 850 !important;
 }
 .vdoc-md-marker-emphasis {
     font-style: italic !important;
 }
 .vdoc-md-marker-strikethrough {
     text-decoration: line-through !important;
 }
 .vdoc-md-marker-code {
     color: #337ca0 !important;
     background: rgba(51, 124, 160, .13) !important;
 }
 .vdoc-edit-region[data-vdoc-edit-type="island"] [contenteditable="true"] {
     position: relative !important;
     z-index: 2147482000 !important;
     pointer-events: auto !important;
     user-select: text !important;
     -webkit-user-select: text !important;
     caret-color: currentColor !important;
     cursor: text !important;
     touch-action: manipulation !important;
 }
.vdoc-edit-region[data-vdoc-edit-type="island"] [contenteditable="true"]:focus {
    outline: 1px solid rgba(58, 139, 120, .72) !important;
    outline-offset: 2px !important;
}
.vdoc-edit-region[data-vdoc-edit-type="island"]
    [contenteditable="true"]:focus > * {
    pointer-events: none !important;
}

/*
 * 四角缩放手柄是纯编辑器装饰，必须位于文档 CSS 之后并使用高优先级，
 * 避免作者针对 span、* 或 figure 子元素的规则改变命中区域。
 */
[data-vdoc-object-id] > [data-vdoc-object-resize-handle] {
    position: absolute !important;
    z-index: 2147483000 !important;
    display: block !important;
    width: 11px !important;
    min-width: 11px !important;
    max-width: none !important;
    height: 11px !important;
    min-height: 11px !important;
    padding: 0 !important;
    border: 2px solid #fff !important;
    border-radius: 3px !important;
    overflow: visible !important;
    background: #3a8b78 !important;
    box-shadow: 0 1px 5px rgba(0, 0, 0, .42) !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    touch-action: none !important;
    user-select: none !important;
}
[data-vdoc-object-resize-handle="nw"] {
    top: -7px !important;
    left: -7px !important;
    cursor: nwse-resize !important;
}
[data-vdoc-object-resize-handle="ne"] {
    top: -7px !important;
    right: -7px !important;
    cursor: nesw-resize !important;
}
[data-vdoc-object-resize-handle="sw"] {
    bottom: -7px !important;
    left: -7px !important;
    cursor: nesw-resize !important;
}
[data-vdoc-object-resize-handle="se"] {
    right: -7px !important;
    bottom: -7px !important;
    cursor: nwse-resize !important;
}
[data-vdoc-object-id][data-vdoc-object-dragging="true"]
    > [data-vdoc-object-resize-handle] {
    opacity: .92 !important;
}
` : ''}`;
    }

    function updatePageZoomLayout(root = getRenderRoot()) {
        if (!root) return;
        const scale = state.zoom / 100;
        root.querySelectorAll('.vdoc-page').forEach((page) => {
            // offsetHeight 不包含 transform，正好可作为缩放前的布局基准。
            const baseHeight = page.offsetHeight;
            const compensation = Number.isFinite(baseHeight)
                ? baseHeight * (scale - 1)
                : 0;
            page.style.setProperty(
                '--vdoc-zoom-height-compensation',
                `${compensation}px`
            );
        });
        const slideEditor = root.querySelector('.vdoc-slide-editor-runtime');
        if (slideEditor) {
            slideEditor.style.marginBottom = `calc(88px + ${
                slideEditor.offsetHeight * (scale - 1)
            }px)`;
        }
    }

    const runtimeController = runtimeModule.createRuntimeController({
        state,
        parsedSlide,
        isSlideDeck,
        activeSlide,
        getRenderRoot,
        getReadRoot,
    });

    function disposeSlideRuntime() {
        return runtimeController.dispose();
    }

    function recordProgrammableDiagnostics(diagnostics = []) {
        return runtimeController.recordDiagnostics(diagnostics);
    }

    function activateProgrammableContent(surface = state.mode) {
        return runtimeController.activate(surface);
    }

    function activateCurrentSlideRuntime(surface = state.mode) {
        return runtimeController.activateCurrentSlide(surface);
    }

    function normalizeCurrentVisualObjects() {
        if (!state.document || !objectModule || !isSlideDeck()) return false;
        const normalized = objectModule.normalizeSource(currentSourceHtml(), isSlideDeck());
        if (!normalized.changed) return false;
        setCurrentSourceHtml(normalized.source);
        return true;
    }

    function renderDocument() {
        disposeSlideRuntime();
        if (!state.document) return;
        state.document = core.normalizeDocument(state.document);
        normalizeCurrentVisualObjects();
        const root = getRenderRoot() || elements['page-stream'].attachShadow({ mode: 'open' });
        state.pageObserver?.disconnect();
        root.replaceChildren();

        const style = document.createElement('style');
        style.textContent = resolveRuntimeResources(buildDocumentStyle('edit'));
        const runtime = document.createElement('div');
        runtime.dataset.sceneKind = state.document.manifest.scene.kind;
        runtime.style.setProperty('--vdoc-zoom', String(state.zoom / 100));
        root.append(style, runtime);

        if (isSlideDeck()) {
            const slide = activeSlide();
            const source = parsedSlide(slide);
            runtime.className = 'vdoc-runtime vdoc-slide-editor-runtime';
            runtime.dataset.slideId = slide?.id || '';
            runtime.innerHTML = resolveRuntimeResources(source.html);
            const slideStyle = document.createElement('style');
            slideStyle.dataset.vdocSlideStyle = slide?.id || '';
            slideStyle.textContent = resolveRuntimeResources(source.css);
            root.appendChild(slideStyle);
        } else {
            pagination.renderContinuous(
                resolveRuntimeResources(parsedDocument().previewHtml),
                runtime,
                { ensureIds: (html) => html }
            );
            installHybridDomSourceMaps(root);
        }
        renderMathNodes(root);
        renderMermaidNodes(root);

        if (isSlideDeck()) {
            root.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
                editable.contentEditable = 'true';
                editable.spellcheck = false;
            });
        }
        state.renderedTextBlocks = isSlideDeck()
            ? [...root.querySelectorAll('[data-vdoc-text]')]
            : [];
        state.pendingRenderedNodes.clear();
        state.pendingRenderedAttributes.clear();
        // 对象控制器使用捕获阶段拦截。必须先于文字选择委托注册，
        // 否则对象上的首次 pointerdown 会先触发空白建段或文本选择。
        if (isSlideDeck()) {
            state.objectController?.bindRoot(root);
            bindRenderSurface(root);
        } else {
            state.objectController?.clearSelection();
            bindHybridRenderSurface(root);
        }
        updatePageZoomLayout(root);
        if (state.mode === 'render') {
            window.requestAnimationFrame(() => {
                if (state.mode !== 'render') return;
                activateProgrammableContent('render');

                // 岛脚本是同步激活的。动态表格等运行态 DOM 只有脚本执行后才
                // 存在，因此必须在激活完成后再建立第二层岛文本编辑映射。
                installRuntimeIslandTextEditing(root);
            });
        }
        renderOutline();
        if (!elements['find-panel']?.hidden && state.mode === 'render') {
            window.requestAnimationFrame(refreshFindResults);
        }
        elements['page-status'].textContent = isSlideDeck()
            ? `第 ${state.activeSlideIndex + 1} 页 / 共 ${state.document.source.slides.length} 页`
            : '连续编辑';
        scheduleMetrics(true);
    }

    function renderReadingPreview(force = false) {
        if (!state.document) return null;
        if (!force && state.previewRevision === state.documentRevision && state.previewResult) {
            return state.previewResult;
        }
        const root = getReadRoot()
            || elements['read-page-stream'].attachShadow({ mode: 'open' });
        root.replaceChildren();
        const style = document.createElement('style');
        style.textContent = resolveRuntimeResources(buildDocumentStyle('paged'));
        const runtime = document.createElement('div');
        runtime.dataset.sceneKind = state.document.manifest.scene.kind;
        root.append(style, runtime);
        const previewHtml = resolveRuntimeResources(isSlideDeck()
            ? state.document.source.slides.map((slide) => {
                const source = parsedSlide(slide);
                return `<section data-vdoc-slide data-vdoc-slide-id="${escapeHtml(slide.id)}">${source.html}<style>${source.css}</style></section>`;
            }).join('\n')
            : parsedDocument().html);
        state.previewResult = pagination.paginate(previewHtml, runtime, {
            ensureIds: isSlideDeck() ? core.ensureTextNodeIds : (html) => html,
            scene: core.createSceneConfig(state.document.manifest.scene),
            slideDeckKind: core.PROJECT_KINDS.SLIDE_DECK,
            zoom: state.zoom,
        });
        renderMathNodes(root);
        renderMermaidNodes(root);
        if (state.previewResult.warnings.length) {
            showToast(
                `分页完成 · ${state.previewResult.warnings.length} 个超大原子块需要检查`,
                'info',
                4200
            );
        }
        state.previewRevision = state.documentRevision;
        updatePageZoomLayout(root);
        initializePageVisibility(root, elements['read-host']);
        updateCurrentPage(root, elements['read-host']);
        return state.previewResult;
    }

    function exportDocumentCss(surface = 'paged') {
        const scene = core.createSceneConfig(state.document.manifest.scene);
        return `${buildDocumentStyle(surface)
            .replace('@import url("../vendor/katex.min.css");', '')
            .replace(':host {', ':root {')
            .replace(documentCssForShadow(), isSlideDeck()
                ? state.document.source.deckCss
                : state.document.source.documentCss)
            .replace(/transform:\s*scale\(var\(--vdoc-zoom,\s*1\)\);/g, 'transform: none;')
            .replace(
                /margin:\s*0\s+auto\s+calc\(var\(--vdoc-page-gap\)\s*\+\s*var\(--vdoc-zoom-height-compensation,\s*0px\)\)\s*!important;/g,
                'margin: 0 auto var(--vdoc-page-gap) !important;'
            )}
@page { size: ${scene.page.width} ${scene.page.height}; margin: 0; }
html, body { margin: 0; background: #fff; }
html[data-vdoc-pdf="true"] *, html[data-vdoc-pdf="true"] *::before, html[data-vdoc-pdf="true"] *::after {
    animation-play-state: paused !important;
    transition: none !important;
}`;
    }

    function inlineScriptLiteral(source) {
        // HTML 解析器不会理会 JavaScript 字符串边界；原始 </script> 会提前
        // 关闭外层脚本。仅转义 HTML 边界字符，运行时恢复原始源码，不过滤、
        // 禁止或改写任何交互逻辑。
        return JSON.stringify(String(source || ''))
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    function buildPresentationHtml() {
        const scene = core.createSceneConfig(state.document.manifest.scene);
        const title = escapeHtml(state.document.manifest.title || state.currentName);
        const language = escapeHtml(state.document.manifest.language || 'zh-CN');
        const slides = state.document.source.slides;
        const ratioParts = String(scene.presentation.aspectRatio || '16 / 9')
            .match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
        const ratioWidth = Number(ratioParts?.[1]) || 16;
        const ratioHeight = Number(ratioParts?.[2]) || 9;
        const numericRatio = ratioWidth / ratioHeight;
        const cssAspectRatio = `${ratioWidth} / ${ratioHeight}`;
        const slideMarkup = slides.map((slide, index) => {
            const source = parsedSlide(slide);
            return `
<section class="vcp-slide${index === 0 ? ' active' : ''}"
    data-slide-index="${index}"
    data-slide-id="${escapeHtml(slide.id)}"
    data-transition="${escapeHtml(core.normalizeTransition(slide.transition))}"
    aria-hidden="${index === 0 ? 'false' : 'true'}">
    <style>${String(source.css).replace(/<\/style/gi, '<\\/style')}</style>
    ${source.html}
</section>`;
        }).join('\n');
        const slideScripts = slides.map((slide, index) => {
            const source = parsedSlide(slide);
            return source.script
            ? `(() => {
    const scene = document.querySelector('[data-slide-index="${index}"]');
    if (!scene) return;
    try {
        const scopedDocument = new Proxy(document, {
            get(target, property) {
                if (property === 'querySelector') {
                    return (selector) => scene.querySelector(selector) || target.querySelector(selector);
                }
                if (property === 'querySelectorAll') {
                    return (selector) => scene.querySelectorAll(selector);
                }
                if (property === 'getElementById') {
                    return (id) => scene.querySelector('#' + CSS.escape(String(id)))
                        || target.getElementById(id);
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const run = new Function(
            'scene',
            'deck',
            'document',
            ${inlineScriptLiteral(source.script)}
        );
        run.call(scene, scene, window.VCPDeck, scopedDocument);
    } catch (error) {
        console.error('[VCPDeck] Scene ${String(slide.id).replace(/['\\\r\n]/g, '')} script failed:', error);
    }
})();`
                : '';
        }).filter(Boolean).join('\n');

        return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<style>
${state.document.source.deckCss}
${styleLibrary.compileCss([...state.usedAdvancedStyleIds])}
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#090b0c;color:#fff}
body{display:grid;place-items:center;font-family:system-ui,sans-serif}
.vcp-deck{position:relative;width:min(100vw,calc(100vh * ${numericRatio}));height:min(100vh,calc(100vw / ${numericRatio}));aspect-ratio:${cssAspectRatio};overflow:hidden;background:#fff;box-shadow:0 24px 90px rgba(0,0,0,.55)}
.vcp-slide{position:absolute;inset:0;display:none;width:100%;height:100%;overflow:hidden;color:#1d2421;background:#fff}
.vcp-slide.active{display:block}
.vcp-slide>.vdoc-slide-scene,.vcp-slide>[data-vdoc-slide]{width:100%;height:100%}
.vcp-deck-control-dock{position:fixed;left:0;right:0;bottom:0;z-index:30;height:88px;display:flex;align-items:flex-end;justify-content:center;padding:0 18px 16px}
.vcp-deck-controls{display:flex;align-items:center;gap:7px;padding:6px;border:1px solid rgba(255,255,255,.2);border-radius:10px;background:rgba(8,10,11,.78);box-shadow:0 12px 40px rgba(0,0,0,.38);backdrop-filter:blur(14px);opacity:0;transform:translateY(14px);pointer-events:auto;transition:opacity .2s ease,transform .2s ease}
.vcp-deck-control-dock:hover .vcp-deck-controls,.vcp-deck-control-dock:focus-within .vcp-deck-controls{opacity:1;transform:translateY(0)}
.vcp-deck-controls button{height:32px;min-width:34px;border:0;border-radius:7px;color:#fff;background:rgba(255,255,255,.1);cursor:pointer}
.vcp-deck-status{min-width:64px;text-align:center;font:12px system-ui}
@media print{html,body{height:auto;overflow:visible;background:#fff}.vcp-deck{display:block;width:${scene.page.width};height:auto;aspect-ratio:auto;box-shadow:none}.vcp-slide{position:relative;display:block!important;width:${scene.page.width};height:${scene.page.height};break-after:page}.vcp-deck-control-dock{display:none}}
</style>
</head>
<body>
<main id="vcp-deck" class="vcp-deck" aria-label="${title}">
${slideMarkup}
</main>
<div class="vcp-deck-control-dock">
    <nav class="vcp-deck-controls" aria-label="演示控制">
        <button type="button" data-deck-action="previous" title="上一页">←</button>
        <span class="vcp-deck-status">1 / ${slides.length}</span>
        <button type="button" data-deck-action="next" title="下一页">→</button>
        <button type="button" data-deck-action="fullscreen" title="全屏">⛶</button>
    </nav>
</div>
<script>
(() => {
    const slides = [...document.querySelectorAll('.vcp-slide')];
    const status = document.querySelector('.vcp-deck-status');
    let index = 0;
    const show = (nextIndex) => {
        const normalized = Math.max(0, Math.min(slides.length - 1, Number(nextIndex) || 0));
        slides.forEach((slide, slideIndex) => {
            const active = slideIndex === normalized;
            slide.classList.toggle('active', active);
            slide.setAttribute('aria-hidden', String(!active));
            slide.style.animation = 'none';
            if (active) requestAnimationFrame(() => slide.style.removeProperty('animation'));
        });
        index = normalized;
        if (status) status.textContent = String(index + 1) + ' / ' + String(slides.length);
        history.replaceState(null, '', '#slide-' + String(index + 1));
        return index;
    };
    window.VCPDeck = Object.freeze({
        next: () => show(index + 1),
        previous: () => show(index - 1),
        goTo: show,
        current: () => index,
        count: () => slides.length,
    });
    document.addEventListener('click', (event) => {
        const action = event.target.closest('[data-deck-action]')?.dataset.deckAction;
        if (action === 'next') window.VCPDeck.next();
        else if (action === 'previous') window.VCPDeck.previous();
        else if (action === 'fullscreen') document.documentElement.requestFullscreen?.();
    });
    document.addEventListener('keydown', (event) => {
        if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
            event.preventDefault();
            window.VCPDeck.next();
        } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            window.VCPDeck.previous();
        } else if (event.key === 'Home') show(0);
        else if (event.key === 'End') show(slides.length - 1);
    });
    const initial = Number(location.hash.match(/slide-(\\d+)/)?.[1] || 1) - 1;
    show(initial);
})();
${slideScripts}
</script>
</body>
</html>`;
    }

    function buildFlowHtml() {
        if (isSlideDeck()) return buildPresentationHtml();
        const title = escapeHtml(state.document.manifest.title || state.currentName);
        const language = escapeHtml(state.document.manifest.language || 'zh-CN');
        const compiledStyles = styleLibrary.compileCss([...state.usedAdvancedStyleIds]);
        const compiled = parsedDocument();
        return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
html,body{margin:0;min-height:100%}
body{padding:clamp(24px,6vw,96px)}
.vdoc-flow-export{width:min(100%,210mm);margin:0 auto}
${markdownBaseCss('.vdoc-flow-export')}
${compiledStyles}
${state.document.source.documentCss}
@media print{body{padding:0}}
</style>
</head>
<body>
<main class="vdoc-flow-export">
${compiled.html}
</main>
</body>
</html>`;
    }

    function buildPagedExportHtml() {
        renderReadingPreview();
        const runtime = getReadRoot()?.querySelector('.vdoc-paged-runtime');
        if (!runtime) throw new Error('分页预览尚未生成。');
        return pagination.buildPagedHtml({
            title: state.document.manifest.title || state.currentName,
            language: state.document.manifest.language,
            runtime,
            css: exportDocumentCss('paged'),
        });
    }

    async function exportRichDocument(format) {
        if (!state.ready || state.saving) return false;
        finalizeEditBurst();
        const context = asyncCoordinator.captureContext();
        try {
            if (state.mode === 'html' || state.mode === 'css') {
                if (applySourceChanges(false) === false) return false;
            }
            let html;
            let paged = false;
            let resourceLocalization = null;
            if (isSlideDeck() && format !== 'pdf') {
                // 演示项目不存在“连续 HTML / 分页 HTML”的语义差异：
                // 所有 HTML 均导出为单页全屏导播器，只有 PDF 使用静态逐页版式。
                html = buildPresentationHtml();
            } else if (format === 'html-flow') {
                html = buildFlowHtml();
            } else {
                paged = true;
                switchMode('read');
                await new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve))
                );
                if (!asyncCoordinator.isContextCurrent(context, { revision: true })) {
                    return false;
                }
                html = buildPagedExportHtml();
            }
            html = state.resourceResolver?.resolveExportHtml(html) || html;
            if (format !== 'pdf') {
                resourceLocalization = await exportResourcesModule.localizeHtmlMedia(html, {
                    readExternalResource: (payload) => api.readExternalResource(payload),
                    bytesToBase64: containerModule.bytesToBase64,
                });
                if (!asyncCoordinator.isContextCurrent(context, { revision: true })) {
                    return false;
                }
                html = resourceLocalization.html;
            }
            const baseName = state.currentName.replace(/\.(?:vdocx|vpptx)$/i, '');
            const result = await api.exportRichDocument({
                format,
                html,
                paged,
                suggestedName: `${baseName}${format === 'pdf' ? '.pdf' : '.html'}`,
                page: core.createSceneConfig(state.document.manifest.scene).page,
                programmableDependencies:
                    state.document.manifest.programmableDependencies || [],
            });
            if (!result?.success || !asyncCoordinator.isContextCurrent(context)) return false;
            const localizedSummary = resourceLocalization?.localized
                ? ` · 已内联 ${resourceLocalization.localized} 项图片/音频`
                : '';
            const retainedSummary = resourceLocalization?.retained
                ? ` · ${resourceLocalization.retained} 项保留原 URL`
                : '';
            showToast(
                `已导出 · ${result.name}${localizedSummary}${retainedSummary}`,
                resourceLocalization?.retained ? 'info' : 'success',
                resourceLocalization?.retained ? 5000 : 2600
            );
            if (resourceLocalization?.failures?.length) {
                console.warn(
                    '[Scriptorium] Export media localization retained external URLs:',
                    resourceLocalization.failures
                );
            }
            return true;
        } catch (error) {
            showToast(`导出失败：${error.message}`, 'error', 5000);
            return false;
        }
    }

    function hybridEditRegionByKey(key) {
        return parsedDocument().editRegions.find((region) => region.key === key) || null;
    }

    function hybridEditableDomain(region) {
        if (!region) return 'atomic';
        if (region.type === 'markdown') return 'markdown';
        if (region.type === 'html' || region.type === 'island') return 'html';
        return 'atomic';
    }

    function hybridTextNodes(root) {
        if (!root) return [];
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (node.parentElement?.closest(
                    'script,style,noscript,canvas,svg,video,audio,input,textarea,select,'
                    + '[data-vdoc-math],[data-vdoc-mermaid],[data-vdoc-md-live-preview]'
                )) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            nodes.push(node);
        }
        return nodes;
    }

    function markdownLiveMarkerRanges(raw) {
        return hybridCompiler.markdownLiveMarkerRanges(String(raw || ''));
    }

    function markdownInlineMarkerKindsForElement(element, shell) {
        if (!element || !shell?.contains(element)) return [];
        const kinds = [];
        const closestWithinShell = (selector) => {
            const match = element.closest?.(selector);
            return match && shell.contains(match) ? match : null;
        };
        if (closestWithinShell('strong,b')) kinds.push('strong');
        if (closestWithinShell('em,i')) kinds.push('emphasis');
        if (closestWithinShell('del,s,strike')) kinds.push('strikethrough');
        if (closestWithinShell('code')) kinds.push('code');
        return kinds;
    }

    function markdownLiveInlineMarkerPairs(raw, ranges) {
        const source = String(raw || '');
        const inlineKinds = new Set([
            'strong',
            'emphasis',
            'italic',
            'strikethrough',
            'code',
        ]);
        const groups = new Map();
        ranges.forEach((marker, index) => {
            if (!inlineKinds.has(marker.kind)) return;
            const delimiter = source.slice(marker.start, marker.end);
            const key = `${marker.kind}\u0000${delimiter}`;
            const group = groups.get(key) || [];
            group.push({ ...marker, index, delimiter });
            groups.set(key, group);
        });
        return [...groups.values()].flatMap((group) => {
            const pairs = [];
            for (let index = 0; index + 1 < group.length; index += 2) {
                pairs.push({
                    kind: group[index].kind,
                    open: group[index],
                    close: group[index + 1],
                });
            }
            return pairs;
        });
    }

    function markdownLiveVisibleMarkerIndexes(raw, ranges, click = {}) {
        const source = String(raw || '');
        const visible = new Set();
        const inlineKinds = new Set([
            'strong',
            'emphasis',
            'italic',
            'strikethrough',
            'code',
        ]);
        const sourceOffset = Math.max(
            0,
            Math.min(source.length, Number(click.sourceOffset) || 0)
        );
        const lineStart = source.lastIndexOf('\n', Math.max(0, sourceOffset - 1)) + 1;
        const nextBreak = source.indexOf('\n', sourceOffset);
        const lineEnd = nextBreak < 0 ? source.length : nextBreak;

        // 标题、引用、列表、任务项和表格等块级界定符只恢复实际点击行。
        // 即使一个编辑 region 包含整个列表或多行表格，也不会把相邻行一起展开。
        ranges.forEach((marker, index) => {
            if (!inlineKinds.has(marker.kind)
                && marker.start >= lineStart
                && marker.start <= lineEnd) {
                visible.add(index);
            }
        });

        const targetStart = Number.isFinite(click.sourceStart)
            ? click.sourceStart
            : sourceOffset;
        const targetEnd = Number.isFinite(click.sourceEnd)
            ? click.sourceEnd
            : targetStart;
        const pairs = markdownLiveInlineMarkerPairs(source, ranges);
        const requestedKinds = new Set(click.inlineKinds || []);
        const matchingPairs = pairs.filter((pair) => {
            const kindMatches = requestedKinds.size
                ? requestedKinds.has(pair.kind)
                    || (requestedKinds.has('emphasis') && pair.kind === 'italic')
                : true;
            return kindMatches
                && pair.open.end <= targetStart
                && pair.close.start >= targetEnd;
        }).sort((left, right) =>
            (left.close.end - left.open.start)
            - (right.close.end - right.open.start)
        );

        // 初次点击可从渲染 DOM 得知 strong/em/code 等语义；编辑态内部再次
        // 点击时 DOM 已是平铺源码，此时只展开实际包围点击点的最小界定符对。
        const bestPair = matchingPairs[0];
        if (bestPair) {
            visible.add(bestPair.open.index);
            visible.add(bestPair.close.index);
        }
        return visible;
    }

    function createMarkdownLivePreviewFragment(raw, options = {}) {
        const source = String(raw || '');
        const fragment = document.createDocumentFragment();
        const ranges = markdownLiveMarkerRanges(source);
        const visibleMarkers = options.visibleMarkers instanceof Set
            ? options.visibleMarkers
            : new Set();
        let offset = 0;
        ranges.forEach((marker, index) => {
            if (marker.start > offset) {
                fragment.appendChild(document.createTextNode(
                    source.slice(offset, marker.start)
                ));
            }
            const span = document.createElement('span');
            span.className = `vdoc-md-marker vdoc-md-marker-${marker.kind}`;
            const visible = visibleMarkers.has(index);
            span.classList.toggle('vdoc-md-marker-concealed', !visible);
            span.style.setProperty(
                'display',
                visible ? 'inline' : 'none',
                'important'
            );
            span.dataset.vdocMdMarker = marker.kind;
            span.textContent = source.slice(marker.start, marker.end);
            fragment.appendChild(span);
            offset = marker.end;
        });
        if (offset < source.length || !fragment.childNodes.length) {
            fragment.appendChild(document.createTextNode(source.slice(offset)));
        }
        return fragment;
    }

    function markdownLivePreviewText(editor) {
        if (!editor) return '';
        // 所有受支持换行均由 beforeinput 写入文本节点，因此 textContent 是
        // 精确源码镜像，不会把装饰 span 或浏览器生成的 HTML 写回 Markdown。
        return String(editor.textContent || '').replace(/\r\n?/g, '\n');
    }

    function refreshMarkdownLivePreviewMarkers(session) {
        if (!session?.editor?.isConnected) return false;
        const selection = currentRenderSelection();
        const node = selection?.focusNode || selection?.anchorNode;
        const offset = selection?.focusNode
            ? selection.focusOffset
            : selection?.anchorOffset;
        if (!node || !session.editor.contains(node)) return false;

        const sourceOffset = renderedOffsetWithin(
            session.editor,
            node,
            offset
        );
        if (!Number.isFinite(sourceOffset)) return false;

        const raw = markdownLivePreviewText(session.editor);
        const ranges = markdownLiveMarkerRanges(raw);
        const visibleMarkers = markdownLiveVisibleMarkerIndexes(raw, ranges, {
            sourceOffset,
            sourceStart: sourceOffset,
            sourceEnd: sourceOffset,
        });
        const markerNodes = session.editor.querySelectorAll(
            '[data-vdoc-md-marker]'
        );
        if (markerNodes.length !== ranges.length) return false;

        // 只切换现有装饰节点的可见性。禁止 replaceChildren、focus 或重设
        // Selection，否则 Chromium 刚建立的原生光标会被销毁或跳回旧位置。
        markerNodes.forEach((marker, index) => {
            const visible = visibleMarkers.has(index);
            marker.classList.toggle('vdoc-md-marker-concealed', !visible);
            marker.style.setProperty(
                'display',
                visible ? 'inline' : 'none',
                'important'
            );
        });
        return true;
    }

    function setMarkdownLivePreviewCaretFromPointer(editor, pointer) {
        if (!editor?.isConnected || !pointer) return false;
        const target = pointerTextTarget(editor, pointer);
        if (!target?.node || !editor.contains(target.node)) return false;
        try {
            const range = document.createRange();
            range.setStart(target.node, target.offset);
            range.collapse(true);
            const selection = currentRenderSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            state.selectionRange = range.cloneRange();
            state.selectionText = '';
            return true;
        } catch {
            return false;
        }
    }

    function setMarkdownLivePreviewCaret(editor, wantedOffset) {
        if (!editor) return false;
        const point = renderedTextPoint(editor, wantedOffset);
        try {
            const range = document.createRange();
            range.setStart(point.node, point.offset);
            range.collapse(true);
            const selection = currentRenderSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return true;
        } catch {
            return false;
        }
    }

    function insertMarkdownLivePreviewText(editor, text) {
        const selection = currentRenderSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!editor || !range || !editor.contains(range.commonAncestorContainer)) {
            return false;
        }
        const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
        range.deleteContents();
        const node = document.createTextNode(normalized);
        range.insertNode(node);
        range.setStart(node, node.nodeValue.length);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        editor.normalize();
        return true;
    }

    function markdownLivePreviewSelection(editor) {
        const selection = currentRenderSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        return editor && range && !range.collapsed
            && editor.contains(range.commonAncestorContainer)
            ? { selection, range }
            : null;
    }

    function patchMarkdownLivePreviewSource(session) {
        if (!session?.shell?.isConnected || !session.editor?.isConnected) return false;
        const nextRaw = markdownLivePreviewText(session.editor);
        if (nextRaw === session.raw) return false;
        const source = currentSourceHtml();
        const currentRaw = source.slice(session.start, session.end);
        if (currentRaw !== session.raw) {
            showToast('当前 Markdown 区域源码映射已过期，已重新渲染。', 'error');
            renderDocument();
            return false;
        }
        setCurrentSourceHtml(
            source.slice(0, session.start) + nextRaw + source.slice(session.end)
        );
        session.end = session.start + nextRaw.length;
        session.raw = nextRaw;
        state.document.manifest.modifiedAt = new Date().toISOString();
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        return true;
    }

    function commitMarkdownLivePreview(session, rerender = true) {
        if (!session) return false;
        patchMarkdownLivePreviewSource(session);
        if (state.markdownLivePreview === session) {
            state.markdownLivePreview = null;
        }
        if (!rerender || !session.shell?.isConnected) return true;
        if (!patchHybridShellFromCompilation(session.shell, session.ordinal)) {
            renderDocument();
            return true;
        }
        const region = parsedDocument().editRegions[session.ordinal];
        if (region) restoreHybridEditableState(session.shell, region);
        return true;
    }

    function activateMarkdownLivePreview(shell, pointer = null) {
        const region = hybridEditRegionByKey(shell?.dataset?.vdocEditKey);
        if (!shell || region?.type !== 'markdown') return null;
        const current = state.markdownLivePreview;
        if (current?.shell === shell && current.editor?.isConnected) return current;
        if (current) commitMarkdownLivePreview(current);

        let caretOffset = 0;
        let pointerTarget = null;
        let pointerMapping = null;
        if (pointer) {
            pointerTarget = pointerTextTarget(shell, pointer);
            pointerMapping = pointerTarget?.node
                ? state.hybridTextSourceMap.get(pointerTarget.node)
                : null;
            if (pointerMapping?.shell === shell && pointerMapping.sourceRange) {
                caretOffset = Math.max(
                    0,
                    pointerMapping.sourceRange.start - region.sourceRange.start
                        + (pointerTarget.offset || 0)
                );
            }
        }

        const source = currentSourceHtml();
        const raw = source.slice(region.sourceRange.start, region.sourceRange.end);
        const markerRanges = markdownLiveMarkerRanges(raw);
        const pointerElement = pointerTarget?.parent || pointer?.target;
        const localSourceStart = pointerMapping?.sourceRange
            ? pointerMapping.sourceRange.start - region.sourceRange.start
            : caretOffset;
        const localSourceEnd = pointerMapping?.sourceRange
            ? pointerMapping.sourceRange.end - region.sourceRange.start
            : caretOffset;
        const visibleMarkers = markdownLiveVisibleMarkerIndexes(
            raw,
            markerRanges,
            {
                sourceOffset: caretOffset,
                sourceStart: localSourceStart,
                sourceEnd: localSourceEnd,
                inlineKinds: markdownInlineMarkerKindsForElement(
                    pointerElement,
                    shell
                ),
            }
        );
        // 复用原渲染块的元素类型与作者属性，而不是创建通用 div 输入框。
        // 例如二级标题仍是 h2，因此字号、字重、margin 和文档自定义 CSS
        // 全部保持不变；Live Preview 只把真源标记字符插回原文字位置。
        const renderedBlock = shell.firstElementChild;
        const editor = renderedBlock?.cloneNode?.(false)
            || document.createElement('p');
        editor.classList.add('vdoc-md-live-preview');
        editor.dataset.vdocMdLivePreview = 'true';
        editor.removeAttribute('contenteditable');
        editor.removeAttribute('spellcheck');
        editor.contentEditable = 'true';
        editor.spellcheck = false;
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-multiline', 'true');
        editor.setAttribute('aria-label', 'Markdown Live Preview 编辑区');
        editor.replaceChildren(createMarkdownLivePreviewFragment(raw, {
            visibleMarkers,
        }));
        shell.replaceChildren(editor);
        shell.dataset.vdocEditActive = 'true';

        const session = {
            shell,
            editor,
            ordinal: region.ordinal,
            start: region.sourceRange.start,
            end: region.sourceRange.end,
            raw,
        };
        state.markdownLivePreview = session;
        state.activeHybridTextEdit = null;
        state.activeEditableBlock = editor;
        try {
            editor.focus({ preventScroll: true });
        } catch {
            editor.focus();
        }
        if (pointer) {
            const clickPoint = {
                clientX: pointer.clientX,
                clientY: pointer.clientY,
                target: editor,
                composedPath: () => [editor],
            };
            // 标识符显隐会改变行内宽度。等待新编辑 DOM 完成布局后，
            // 按首次点击的屏幕坐标重新命中，避免依赖源码字符偏移。
            window.requestAnimationFrame(() => {
                if (state.markdownLivePreview !== session
                    || !setMarkdownLivePreviewCaretFromPointer(editor, clickPoint)) {
                    setMarkdownLivePreviewCaret(
                        editor,
                        Math.min(caretOffset, raw.length)
                    );
                }
            });
        } else {
            setMarkdownLivePreviewCaret(editor, Math.min(caretOffset, raw.length));
        }
        return session;
    }

    function emptyMarkdownParagraphSource() {
        // Markdown 编译器会丢弃纯空白段。零宽空格只负责让空段拥有稳定的
        // 源码范围和可聚焦 DOM；它不可见，也不是向用户展示的预制文本。
        return '\u200B';
    }

    function insertMarkdownParagraphRelativeToLivePreview(session, before = false) {
        if (!session?.shell?.isConnected) return false;
        patchMarkdownLivePreviewSource(session);
        const source = currentSourceHtml();
        const offset = before ? session.start : session.end;
        const leading = source.slice(0, offset);
        const trailing = source.slice(offset);
        const prefix = !leading
            ? ''
            : /(?:\r?\n){2}$/.test(leading)
                ? ''
                : /[\r\n]$/.test(leading) ? '\n' : '\n\n';
        const suffix = !trailing
            ? ''
            : /^(?:\r?\n){2}/.test(trailing)
                ? ''
                : /^[\r\n]/.test(trailing) ? '\n' : '\n\n';
        setCurrentSourceHtml(
            leading + prefix + emptyMarkdownParagraphSource() + suffix + trailing
        );
        state.document.manifest.modifiedAt = new Date().toISOString();
        state.markdownLivePreview = null;
        markDirty();
        captureSnapshot();
        const nextOrdinal = session.ordinal + (before ? 0 : 1);
        renderDocument();
        window.requestAnimationFrame(() => {
            if (state.mode === 'render') {
                focusHybridRegionByOrdinal(nextOrdinal);
            }
        });
        return true;
    }

    function mapHybridShellTextNodes(shell, region) {
        if (!shell || !region) return false;
        const source = currentSourceHtml();
        const raw = source.slice(region.sourceRange.start, region.sourceRange.end);
        state.hybridDomSourceMap.set(shell, {
            ...region,
            domain: hybridEditableDomain(region),
        });

        hybridTextNodes(shell).forEach((node) => {
            const localRange = region.type === 'island'
                ? (() => {
                    const island = shell.querySelector(
                        `[data-vdoc-island="${CSS.escape(region.islandId || '')}"]`
                    );
                    const path = islandElementPath(island, node.parentElement);
                    const textNodeIndex = [...(node.parentElement?.childNodes || [])]
                        .indexOf(node);
                    return island && path && textNodeIndex >= 0
                        ? sourceTextRangeFromIslandPath(
                            raw,
                            region.islandId,
                            path,
                            textNodeIndex,
                            node.nodeValue || ''
                        )
                        : null;
                })()
                : sourceTextRangeFromRenderedNode(raw, shell, node);
            if (!localRange) return;
            state.hybridTextSourceMap.set(node, {
                kind: 'source',
                shell,
                regionKey: region.key,
                domain: hybridEditableDomain(region),
                sourceRange: {
                    start: region.sourceRange.start + localRange.start,
                    end: region.sourceRange.start + localRange.end,
                },
            });

            // 可编程岛必须像旧 HTML 编辑面一样，从挂载完成起就是原生可编辑
            // DOM，而不是等 pointerdown 后才临时切换 contenteditable。只给已经
            // 建立源码映射的静态文本宿主开放编辑；脚本动态生成的节点不会进入
            // WeakMap，因此不会获得编辑能力，也不会污染 Markdown-first 真源。
            if (region.type === 'island') {
                const host = node.parentElement;
                const interactive = host?.closest(
                    'a,button,input,select,textarea,audio,video,[role="button"]'
                );
                const islandRoot = host?.matches?.('[data-vdoc-island]');
                if (host && !interactive && !islandRoot) {
                    // 与 VPPTX 已验证的原生编辑路径保持一致。源码安全边界由
                    // WeakMap 映射和 input patch 控制，而不是依赖 Chromium 对
                    // plaintext-only 的可选实现。
                    host.contentEditable = 'true';
                    host.spellcheck = false;
                }
            }
        });
        return true;
    }

    function mappedHybridTextForEditable(shell, editable, preferredNode = null) {
        const candidates = [
            preferredNode,
            ...hybridTextNodes(editable),
        ].filter((node, index, nodes) =>
            node?.nodeType === Node.TEXT_NODE
            && nodes.indexOf(node) === index
            && state.hybridTextSourceMap.get(node)?.shell === shell
        );
        const node = candidates[0] || null;
        const mapping = node ? state.hybridTextSourceMap.get(node) : null;
        return node && mapping ? { node, mapping } : null;
    }

    function beginHybridDomSession(shell, editable = null, preferredNode = null) {
        const region = hybridEditRegionByKey(shell?.dataset?.vdocEditKey);
        if (!shell || !region || hybridEditableDomain(region) === 'atomic') return null;
        const source = currentSourceHtml();
        const domain = hybridEditableDomain(region);
        const mappedText = domain === 'html' && editable
            ? mappedHybridTextForEditable(shell, editable, preferredNode)
            : null;

        // HTML 与可编程岛只允许编辑已经由静态源码建立映射的文本节点。
        // 脚本追加的表格行、计数器和动画状态没有源码范围，绝不能退化为
        // 整岛 textContent 差分，否则运行态 DOM 会被写回正文真源。
        if (domain === 'html' && !mappedText) return null;

        const runtimeMapping = mappedText?.mapping?.kind === 'runtime'
            ? { ...mappedText.mapping }
            : null;
        const mappedSourceRange = mappedText?.mapping?.kind === 'source'
            ? mappedText.mapping.sourceRange
            : null;
        const mappedValue = mappedText?.node?.nodeValue || '';
        const session = {
            shell,

            // 会话必须记录实际触发 input 的 contenteditable。Markdown 的差分
            // 仍以整个 shell.textContent 计算，但若这里保存 shell，input 事件
            // 随后拿到 h1/p 等实际 editable 时会误判为另一场会话，并在 DOM
            // 已经变化后重建 previousText，最终得到“文字没有变化”而不写源码。
            editable: editable || shell,
            mappedTextNode: mappedText?.node || null,
            mappedSourceRange,
            runtimeMapping,
            region: { ...region },
            domain,
            previousText: mappedText
                ? mappedValue
                : (shell.textContent || ''),
            raw: mappedSourceRange
                ? source.slice(mappedSourceRange.start, mappedSourceRange.end)
                : runtimeMapping
                    ? mappedValue
                    : source.slice(
                        region.sourceRange.start,
                        region.sourceRange.end
                    ),
            revision: state.documentRevision,
        };
        state.hybridEditSessions.set(shell, session);
        state.activeHybridTextEdit = session;
        state.activeEditableBlock = editable || shell;
        return session;
    }

    function refreshHybridSessionMapping(session) {
        if (!session?.shell?.isConnected) return false;
        const compiled = parsedDocument(true);
        const region = compiled.editRegions[session.region.ordinal];
        if (!region) return false;
        session.region = { ...region };
        session.raw = currentSourceHtml().slice(
            region.sourceRange.start,
            region.sourceRange.end
        );
        session.previousText = session.shell.textContent || '';
        session.revision = state.documentRevision;
        session.shell.dataset.vdocEditKey = region.key;
        session.shell.dataset.vdocEditType = region.type;
        mapHybridShellTextNodes(session.shell, region);
        return true;
    }

    function hybridEditChangesSyntax(domain, removed, inserted) {
        const changed = `${removed || ''}${inserted || ''}`;
        if (!changed) return false;
        if (/[\r\n]/.test(changed)) return true;
        return domain === 'markdown'
            ? /[`*_~[\]#>|\\$]/.test(changed)
            : /[<>]/.test(changed);
    }

    function restoreHybridEditableState(shell, region) {
        if (!shell || !region) return false;
        mapHybridShellTextNodes(shell, region);
        if (region.type === 'markdown') {
            [...shell.children].forEach((block) => {
                if (block.matches(
                    'pre,figure,table,[data-vdoc-island],[data-vdoc-math],'
                    + '[data-vdoc-mermaid]'
                )) {
                    return;
                }
                block.contentEditable = 'true';
                block.spellcheck = false;
            });
        }
        return true;
    }

    function patchHybridSourceFromDom(session) {
        if (!session?.shell?.isConnected) return false;
        const mappedNode = session.mappedTextNode?.isConnected
            ? session.mappedTextNode
            : null;
        const nextText = mappedNode
            ? (mappedNode.nodeValue || '')
            : (session.shell.textContent || '');
        const previousText = session.previousText;
        if (nextText === previousText) return false;

        // 脚本生成的 DOM 在 HTML 源码中不存在文本范围。它使用岛级运行态
        // 文字覆盖保存编辑结果；下一次脚本重建表格后再按稳定路径恢复。
        if (session.runtimeMapping) {
            if (!setRuntimeIslandTextOverride(session.runtimeMapping, nextText)) {
                showToast('动态岛文字无法建立稳定保存位置。', 'error');
                return false;
            }
            session.previousText = nextText;
            state.document.manifest.modifiedAt = new Date().toISOString();
            markDirty({ coalesce: true });
            scheduleEditSnapshot();
            return true;
        }

        let prefix = 0;
        const shared = Math.min(previousText.length, nextText.length);
        while (prefix < shared && previousText[prefix] === nextText[prefix]) prefix += 1;

        let previousEnd = previousText.length;
        let nextEnd = nextText.length;
        while (
            previousEnd > prefix
            && nextEnd > prefix
            && previousText[previousEnd - 1] === nextText[nextEnd - 1]
        ) {
            previousEnd -= 1;
            nextEnd -= 1;
        }

        const localStart = sourceOffsetForRenderedText(
            session.raw,
            previousText,
            prefix
        );
        const localEnd = sourceOffsetForRenderedText(
            session.raw,
            previousText,
            previousEnd
        );
        const insertion = nextText.slice(prefix, nextEnd);
        const removed = previousText.slice(prefix, previousEnd);
        const syntaxChanged = hybridEditChangesSyntax(
            session.domain,
            removed,
            insertion
        );
        const source = currentSourceHtml();
        const sourceBase = session.mappedSourceRange?.start
            ?? session.region.sourceRange.start;
        const absoluteStart = sourceBase + localStart;
        const absoluteEnd = sourceBase + localEnd;
        const currentRegion = source.slice(
            session.region.sourceRange.start,
            session.region.sourceRange.end
        );
        if (hybridCompiler.simpleHash(currentRegion) !== session.region.sourceHash) {
            showToast('当前块源码映射已过期，输入未写入源码。', 'error');
            renderDocument();
            return false;
        }

        setCurrentSourceHtml(
            source.slice(0, absoluteStart) + insertion + source.slice(absoluteEnd)
        );
        state.document.manifest.modifiedAt = new Date().toISOString();
        markDirty({ coalesce: true });
        session.previousText = nextText;
        session.raw = session.raw.slice(0, localStart)
            + insertion
            + session.raw.slice(localEnd);

        if (syntaxChanged) {
            const ordinal = session.region.ordinal;
            const caretOffset = prefix + insertion.length;
            if (!patchHybridShellFromCompilation(session.shell, ordinal)) {
                renderDocument();
                return true;
            }
            const region = hybridEditRegionByKey(
                session.shell.dataset.vdocEditKey
            );
            if (region) {
                restoreHybridEditableState(session.shell, region);
                session.region = { ...region };
                session.raw = currentSourceHtml().slice(
                    region.sourceRange.start,
                    region.sourceRange.end
                );
                session.previousText = session.shell.textContent || '';
                session.revision = state.documentRevision;
                restoreHybridRenderedSelection(
                    session.shell,
                    Math.min(caretOffset, session.previousText.length)
                );
            }
        } else if (session.mappedSourceRange) {
            const delta = insertion.length - (absoluteEnd - absoluteStart);
            session.mappedSourceRange = {
                start: session.mappedSourceRange.start,
                end: session.mappedSourceRange.end + delta,
            };
            const compiled = parsedDocument(true);
            const region = compiled.editRegions[session.region.ordinal];
            if (region) {
                session.region = { ...region };
                session.shell.dataset.vdocEditKey = region.key;
                session.shell.dataset.vdocEditType = region.type;
                mapHybridShellTextNodes(session.shell, region);
                const remapped = mappedHybridTextForEditable(
                    session.shell,
                    session.editable,
                    session.mappedTextNode
                );
                if (remapped) {
                    session.mappedTextNode = remapped.node;
                    session.mappedSourceRange = remapped.mapping.kind === 'source'
                        ? remapped.mapping.sourceRange
                        : null;
                    session.runtimeMapping = remapped.mapping.kind === 'runtime'
                        ? { ...remapped.mapping }
                        : null;
                }
                session.raw = nextText;
                session.previousText = nextText;
                session.revision = state.documentRevision;
            }
        } else {
            refreshHybridSessionMapping(session);
        }
        scheduleEditSnapshot();
        return true;
    }

    function installHybridDomSourceMaps(root) {
        state.hybridDomSourceMap = new WeakMap();
        state.hybridTextSourceMap = new WeakMap();
        state.hybridEditSessions = new WeakMap();
        state.activeHybridTextEdit = null;
        state.markdownLivePreview = null;

        root.querySelectorAll('[data-vdoc-edit-key]').forEach((shell) => {
            const region = hybridEditRegionByKey(shell.dataset.vdocEditKey);
            if (!region) return;
            mapHybridShellTextNodes(shell, region);
            if (region.type !== 'markdown') return;
            [...shell.children].forEach((block) => {
                if (block.matches(
                    'pre,figure,table,[data-vdoc-island],[data-vdoc-math],'
                    + '[data-vdoc-mermaid]'
                )) {
                    return;
                }
                block.contentEditable = 'true';
                block.spellcheck = false;
            });
        });
    }

    function hybridStyleDeclaration(command, value) {
        const declarations = {
            'font-family': `font-family:${String(value || '').replace(/[;"<>]/g, '')}`,
            'font-size': `font-size:${String(value || '').replace(/[;"<>]/g, '')}`,
            'text-color': `color:${String(value || '').replace(/[;"<>]/g, '')}`,
            'highlight-color': `background-color:${String(value || '').replace(/[;"<>]/g, '')}`,
            'line-height': `line-height:${String(value || '').replace(/[;"<>]/g, '')}`,
            'text-align': `display:block;text-align:${String(value || '').replace(/[;"<>]/g, '')}`,
            underline: 'text-decoration-line:underline',
        };
        return declarations[command] || '';
    }

    function normalizeHybridBlockInsertion(fragment) {
        const content = String(fragment ?? '').replace(/^\s*\n|\n\s*$/g, '');
        return content ? `\n\n${content}\n\n` : '';
    }

    function insertHybridSourceFragment(fragment, options = {}) {
        const insertion = normalizeHybridBlockInsertion(fragment);
        if (!insertion) return false;
        const source = currentSourceHtml();
        const activeSession = state.activeHybridTextEdit?.shell?.isConnected
            ? state.activeHybridTextEdit
            : null;
        const activeRegion = activeSession
            ? hybridEditRegionByKey(activeSession.shell.dataset.vdocEditKey)
            : null;
        const offset = activeRegion
            ? (options.afterRegion === false
                ? activeRegion.sourceRange.start
                : activeRegion.sourceRange.end)
            : source.length;
        const prefix = offset === source.length
            && source
            && !/[\r\n]$/.test(source)
            ? '\n'
            : '';
        setCurrentSourceHtml(
            source.slice(0, offset)
            + prefix
            + insertion.replace(offset === source.length ? /^\n+/ : /^/, '')
            + source.slice(offset)
        );
        state.document.manifest.modifiedAt = new Date().toISOString();
        markDirty();
        captureSnapshot();
        renderDocument();
        return true;
    }

    function hybridStructureSource(type) {
        if (/^heading-[1-6]$/.test(type)) {
            return `${'#'.repeat(Number(type.slice(-1)))} 新标题`;
        }
        if (type === 'blockquote') return '> 引文';
        if (type === 'table') {
            return [
                '| 标题 1 | 标题 2 | 标题 3 |',
                '| --- | --- | --- |',
                '| 内容 | 内容 | 内容 |',
                '| 内容 | 内容 | 内容 |',
            ].join('\n');
        }
        return '新段落';
    }

    function hybridSourceEndpoint(shell, node, offset, fallbackOffset) {
        const mapped = node?.nodeType === Node.TEXT_NODE
            ? state.hybridTextSourceMap.get(node)
            : null;
        if (mapped?.shell === shell) {
            return Math.min(
                mapped.sourceRange.end,
                mapped.sourceRange.start + Math.max(0, Number(offset) || 0)
            );
        }
        const region = state.hybridDomSourceMap.get(shell)
            || hybridEditRegionByKey(shell?.dataset?.vdocEditKey);
        if (!region) return null;
        const raw = currentSourceHtml().slice(
            region.sourceRange.start,
            region.sourceRange.end
        );
        return region.sourceRange.start + sourceOffsetForRenderedText(
            raw,
            shell.textContent || '',
            fallbackOffset
        );
    }

    function hybridDomEditingContext() {
        if (isSlideDeck()) return null;
        const selection = currentRenderSelection();
        const liveRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const savedRange = state.selectionRange?.startContainer?.isConnected
            && state.selectionRange?.endContainer?.isConnected
            ? state.selectionRange
            : null;
        const range = liveRange && !liveRange.collapsed ? liveRange : savedRange;
        if (!range || range.collapsed) return null;

        const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
            ? range.endContainer
            : range.endContainer.parentElement;
        const shell = startElement?.closest?.('[data-vdoc-edit-key]');
        if (!shell || endElement?.closest?.('[data-vdoc-edit-key]') !== shell) return null;

        const region = hybridEditRegionByKey(shell.dataset.vdocEditKey);
        const domain = hybridEditableDomain(region);
        if (!region || domain === 'atomic') return null;
        const rendered = renderedSelectionOffsets(shell);
        if (!rendered) return null;

        const sourceStart = hybridSourceEndpoint(
            shell,
            range.startContainer,
            range.startOffset,
            rendered.start
        );
        const sourceEnd = hybridSourceEndpoint(
            shell,
            range.endContainer,
            range.endOffset,
            rendered.end
        );
        if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)
            || sourceEnd < sourceStart) {
            return null;
        }
        return {
            domain,
            type: region.type,
            region,
            shell,
            range: range.cloneRange(),
            renderedStart: rendered.start,
            renderedEnd: rendered.end,
            sourceStart,
            sourceEnd,
            selected: range.toString(),
        };
    }

    function renderedTextPoint(root, wantedOffset) {
        const offset = Math.max(0, Number(wantedOffset) || 0);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let consumed = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const length = (node.nodeValue || '').length;
            if (consumed + length >= offset) {
                return { node, offset: Math.min(length, offset - consumed) };
            }
            consumed += length;
        }
        return { node: root, offset: root.childNodes.length };
    }

    function restoreHybridRenderedSelection(shell, start, end = start) {
        if (!shell?.isConnected) return false;
        const startPoint = renderedTextPoint(shell, start);
        const endPoint = renderedTextPoint(shell, end);
        try {
            const range = document.createRange();
            range.setStart(startPoint.node, startPoint.offset);
            range.setEnd(endPoint.node, endPoint.offset);
            const selection = currentRenderSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            state.selectionRange = range.cloneRange();
            state.selectionText = range.toString();
            return true;
        } catch {
            return false;
        }
    }

    function commitHybridDomSourcePatch(context, start, end, replacement) {
        const source = currentSourceHtml();
        const currentRegion = source.slice(
            context.region.sourceRange.start,
            context.region.sourceRange.end
        );
        if (hybridCompiler.simpleHash(currentRegion) !== context.region.sourceHash) {
            showToast('当前块源码映射已过期，请重新选择文字。', 'error');
            return false;
        }
        setCurrentSourceHtml(
            source.slice(0, start) + replacement + source.slice(end)
        );
        state.document.manifest.modifiedAt = new Date().toISOString();
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        return true;
    }

    function executeHybridDomFormattingCommand(command, value, context) {
        const markdownDelimiters = {
            bold: '**',
            italic: '*',
            strikethrough: '~~',
        };
        const semanticTags = {
            bold: ['<strong>', '</strong>'],
            italic: ['<em>', '</em>'],
            strikethrough: ['<s>', '</s>'],
        };
        let open = '';
        let close = '';

        if (context.domain === 'markdown' && markdownDelimiters[command]) {
            const delimiter = markdownDelimiters[command];
            const source = currentSourceHtml();
            const surrounded = source.slice(
                Math.max(0, context.sourceStart - delimiter.length),
                context.sourceStart
            ) === delimiter && source.slice(
                context.sourceEnd,
                context.sourceEnd + delimiter.length
            ) === delimiter;
            const start = surrounded
                ? context.sourceStart - delimiter.length
                : context.sourceStart;
            const end = surrounded
                ? context.sourceEnd + delimiter.length
                : context.sourceEnd;
            const selectedSource = source.slice(context.sourceStart, context.sourceEnd);
            const replacement = surrounded
                ? selectedSource
                : `${delimiter}${selectedSource}${delimiter}`;
            if (!commitHybridDomSourcePatch(context, start, end, replacement)) return false;
            if (!patchHybridShellFromCompilation(
                context.shell,
                context.region.ordinal
            )) {
                renderDocument();
                return true;
            }
            const nextRegion = hybridEditRegionByKey(context.shell.dataset.vdocEditKey);
            if (nextRegion) {
                mapHybridShellTextNodes(context.shell, nextRegion);
                [...context.shell.children].forEach((block) => {
                    if (!block.matches(
                        'pre,figure,table,[data-vdoc-island],[data-vdoc-math],'
                        + '[data-vdoc-mermaid]'
                    )) {
                        block.contentEditable = 'true';
                        block.spellcheck = false;
                    }
                });
                const session = state.hybridEditSessions.get(context.shell);
                if (session) {
                    session.region = { ...nextRegion };
                    session.raw = currentSourceHtml().slice(
                        nextRegion.sourceRange.start,
                        nextRegion.sourceRange.end
                    );
                    session.previousText = context.shell.textContent || '';
                    session.revision = state.documentRevision;
                }
            }
            restoreHybridRenderedSelection(
                context.shell,
                context.renderedStart,
                context.renderedEnd
            );
            scheduleFormattingFromCurrentSelection();
            return true;
        }

        if (semanticTags[command]) {
            [open, close] = semanticTags[command];
        } else {
            const declaration = hybridStyleDeclaration(command, value);
            if (!declaration) return false;
            open = `<span style="${declaration}">`;
            close = '</span>';
        }

        const source = currentSourceHtml();
        const selectedSource = source.slice(context.sourceStart, context.sourceEnd);
        if (!commitHybridDomSourcePatch(
            context,
            context.sourceStart,
            context.sourceEnd,
            `${open}${selectedSource}${close}`
        )) {
            return false;
        }

        // HTML 和可编程岛直接保留当前实例，仅把相同包裹应用到真实 DOM。
        const wrapperTemplate = document.createElement('template');
        wrapperTemplate.innerHTML = `${open}${close}`;
        const wrapper = wrapperTemplate.content.firstElementChild;
        if (!wrapper) return false;
        try {
            context.range.surroundContents(wrapper);
        } catch {
            wrapper.appendChild(context.range.extractContents());
            context.range.insertNode(wrapper);
        }
        const nextRange = document.createRange();
        nextRange.selectNodeContents(wrapper);
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(nextRange);
        state.selectionRange = nextRange.cloneRange();
        state.selectionText = nextRange.toString();

        const compiled = parsedDocument(true);
        const nextRegion = compiled.editRegions[context.region.ordinal];
        if (nextRegion) {
            context.shell.dataset.vdocEditKey = nextRegion.key;
            context.shell.dataset.vdocEditType = nextRegion.type;
            mapHybridShellTextNodes(context.shell, nextRegion);
            const session = state.hybridEditSessions.get(context.shell);
            if (session) {
                session.region = { ...nextRegion };
                session.raw = currentSourceHtml().slice(
                    nextRegion.sourceRange.start,
                    nextRegion.sourceRange.end
                );
                session.previousText = context.shell.textContent || '';
                session.revision = state.documentRevision;
            }
        }
        scheduleFormattingControls(wrapper);
        return true;
    }

    function executeHybridFormattingCommand(command, value) {
        const domContext = hybridDomEditingContext();
        if (domContext) {
            return executeHybridDomFormattingCommand(command, value, domContext);
        }

        showToast('请先在正文中选择文字。');
        return false;
    }

    function renderedOffsetWithin(shell, node, offset) {
        if (!shell || !node || !shell.contains(node)) return null;
        try {
            const prefix = document.createRange();
            prefix.selectNodeContents(shell);
            prefix.setEnd(node, offset);
            return prefix.toString().length;
        } catch {
            return null;
        }
    }

    function renderedSelectionOffsets(shell) {
        const selection = currentRenderSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        const start = renderedOffsetWithin(
            shell,
            range.startContainer,
            range.startOffset
        );
        const end = renderedOffsetWithin(
            shell,
            range.endContainer,
            range.endOffset
        );
        return start === null || end === null
            ? null
            : { start: Math.min(start, end), end: Math.max(start, end) };
    }

    function sourceOffsetForRenderedText(raw, renderedText, renderedOffset) {
        if (!renderedText || !Number.isFinite(renderedOffset) || renderedOffset <= 0) {
            return 0;
        }
        if (renderedOffset >= renderedText.length) return raw.length;

        // 优先使用光标前后的纯文字窗口定位。Markdown 标记通常只出现在
        // 窗口之间，因此无需建立持久 token 映射也能稳定回到附近源码。
        const windowStart = Math.max(0, renderedOffset - 12);
        const windowEnd = Math.min(renderedText.length, renderedOffset + 12);
        const probe = renderedText.slice(windowStart, windowEnd);
        const found = probe ? raw.indexOf(probe) : -1;
        if (found >= 0) return found + (renderedOffset - windowStart);

        const leading = renderedText.slice(0, renderedOffset);
        for (const size of [24, 16, 8, 4]) {
            const tail = leading.slice(-size);
            if (!tail) continue;
            const tailIndex = raw.indexOf(tail);
            if (tailIndex >= 0) return tailIndex + tail.length;
        }

        const trailing = renderedText.slice(renderedOffset);
        for (const size of [24, 16, 8, 4]) {
            const head = trailing.slice(0, size);
            if (!head) continue;
            const headIndex = raw.indexOf(head);
            if (headIndex >= 0) return headIndex;
        }
        return Math.min(raw.length, renderedOffset);
    }

    function uniqueSourceRange(raw, needle) {
        const value = String(needle || '');
        if (!value) return null;
        const start = raw.indexOf(value);
        if (start < 0 || raw.indexOf(value, start + value.length) >= 0) return null;
        return { start, end: start + value.length };
    }

    function sourceTextRange(raw, text) {
        const direct = uniqueSourceRange(raw, text);
        if (direct) return direct;
        const escaped = escapeHtml(text);
        return escaped !== text ? uniqueSourceRange(raw, escaped) : null;
    }

    function sourceTextRangeFromRenderedNode(raw, shell, node) {
        const text = String(node?.nodeValue || '');
        if (!text) return null;
        const renderedText = shell?.textContent || '';
        const renderedStart = renderedOffsetWithin(shell, node, 0);
        if (renderedStart === null) return sourceTextRange(raw, text);

        const expected = sourceOffsetForRenderedText(
            raw,
            renderedText,
            renderedStart
        );
        const candidates = [];
        let offset = raw.indexOf(text);
        while (offset >= 0) {
            candidates.push({
                start: offset,
                end: offset + text.length,
                distance: Math.abs(offset - expected),
            });
            offset = raw.indexOf(text, offset + Math.max(1, text.length));
        }
        if (!candidates.length) {
            const escaped = escapeHtml(text);
            if (escaped !== text) return sourceTextRange(raw, escaped);
            return null;
        }
        candidates.sort((left, right) => left.distance - right.distance);
        return {
            start: candidates[0].start,
            end: candidates[0].end,
        };
    }

    function insertHybridShellFromCompilation(anchorShell, ordinal, before = false) {
        if (!anchorShell?.isConnected || !Number.isInteger(ordinal)) return null;
        const compiled = parsedDocument(true);
        const template = document.createElement('template');
        template.innerHTML = compiled.previewHtml;
        const replacement = template.content.querySelectorAll(
            '[data-vdoc-edit-key]'
        )[ordinal];
        if (!replacement) return null;

        const insertedShell = replacement.cloneNode(true);
        if (before) anchorShell.before(insertedShell);
        else anchorShell.after(insertedShell);
        renderMathNodes(insertedShell);
        renderMermaidNodes(insertedShell);

        // 保留全部既有壳的 DOM 实例，仅同步编译后发生位移的区域身份与映射。
        const shells = [...getRenderRoot().querySelectorAll('[data-vdoc-edit-key]')];
        if (shells.length !== compiled.editRegions.length) {
            insertedShell.remove();
            return null;
        }
        shells.forEach((shell, index) => {
            const region = compiled.editRegions[index];
            if (!region) return;
            shell.dataset.vdocEditKey = region.key;
            shell.dataset.vdocEditType = region.type;
            restoreHybridEditableState(shell, region);
        });
        return insertedShell;
    }

    function patchHybridShellFromCompilation(shell, ordinal) {
        if (!shell?.isConnected || !Number.isInteger(ordinal)) return false;
        const compiled = parsedDocument(true);
        const template = document.createElement('template');
        template.innerHTML = compiled.previewHtml;
        const replacement = template.content.querySelectorAll('[data-vdoc-edit-key]')[ordinal];
        if (!replacement) return false;
        shell.replaceChildren(...replacement.childNodes);
        shell.dataset.vdocEditKey = replacement.dataset.vdocEditKey;
        shell.dataset.vdocEditType = replacement.dataset.vdocEditType;
        shell.removeAttribute('data-vdoc-edit-active');
        renderMathNodes(shell);
        renderMermaidNodes(shell);
        return true;
    }

    function nearestTextOffsetFromPoint(node, pointer) {
        const text = String(node?.nodeValue || '');
        if (!text || !pointer) return 0;
        const probe = document.createRange();
        let nearestOffset = 0;
        let nearestDistance = Infinity;
        for (let offset = 0; offset <= text.length; offset += 1) {
            try {
                probe.setStart(node, offset);
                probe.setEnd(node, Math.min(text.length, offset + 1));
                const rect = probe.getBoundingClientRect();
                if (!rect.width && !rect.height) continue;
                const boundaryX = offset < text.length ? rect.left : rect.right;
                const boundaryY = Math.max(rect.top, Math.min(rect.bottom, pointer.clientY));
                const distance = Math.hypot(
                    boundaryX - pointer.clientX,
                    boundaryY - pointer.clientY
                );
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestOffset = offset;
                }
                if (offset === text.length - 1) {
                    const endDistance = Math.hypot(
                        rect.right - pointer.clientX,
                        boundaryY - pointer.clientY
                    );
                    if (endDistance < nearestDistance) {
                        nearestDistance = endDistance;
                        nearestOffset = text.length;
                    }
                }
            } catch {
                break;
            }
        }
        if (nearestDistance < Infinity) return nearestOffset;
        const rect = node.parentElement?.getBoundingClientRect?.();
        return rect && pointer.clientX <= rect.left + rect.width / 2
            ? 0
            : text.length;
    }

    function pointerTextTarget(shell, pointer) {
        if (!shell || !pointer) return null;
        const root = shell.getRootNode?.();
        const caretPosition = root?.caretPositionFromPoint?.(
            pointer.clientX,
            pointer.clientY
        ) || document.caretPositionFromPoint?.(
            pointer.clientX,
            pointer.clientY
        );
        const caretRange = root?.caretRangeFromPoint?.(
            pointer.clientX,
            pointer.clientY
        ) || document.caretRangeFromPoint?.(
            pointer.clientX,
            pointer.clientY
        );
        const caretNode = caretPosition?.offsetNode || caretRange?.startContainer;
        const eventElement = pointer.composedPath?.().find((candidate) =>
            candidate?.nodeType === Node.ELEMENT_NODE
            && shell.contains(candidate)
        ) || pointer.target;
        const candidateElement = caretNode?.nodeType === Node.TEXT_NODE
            ? caretNode.parentElement
            : caretNode?.nodeType === Node.ELEMENT_NODE
                ? caretNode
                : eventElement;
        const forbidden = candidateElement?.closest?.(
            'script,style,noscript,canvas,svg,video,audio,input,textarea,select'
        );
        if (!candidateElement || forbidden || !shell.contains(candidateElement)) {
            return null;
        }

        if (caretNode?.nodeType === Node.TEXT_NODE
            && candidateElement.contains(caretNode)
            && (caretNode.nodeValue || '').trim()) {
            const caretOffset = caretPosition?.offset ?? caretRange?.startOffset ?? 0;
            return {
                node: caretNode,
                parent: caretNode.parentElement,
                offset: Math.max(
                    0,
                    Math.min(
                        (caretNode.nodeValue || '').length,
                        Number(caretOffset) || 0
                    )
                ),
            };
        }

        // ShadowRoot 的坐标光标 API 在 Chromium 中可能返回宿主元素。
        // 从实际事件目标向上寻找最近的文字宿主，并按点击坐标计算最近字符
        // 边界。禁止再无条件回退到文本末尾，否则段首永远无法放置光标。
        for (
            let element = eventElement;
            element && element !== shell.parentElement;
            element = element.parentElement
        ) {
            if (!shell.contains(element) || element.matches?.(
                'script,style,noscript,canvas,svg,video,audio,input,textarea,select'
            )) {
                continue;
            }
            const walker = document.createTreeWalker(
                element,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode(node) {
                        return (node.nodeValue || '').trim()
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_REJECT;
                    },
                }
            );
            const node = walker.nextNode();
            if (node) {
                return {
                    node,
                    parent: node.parentElement,
                    offset: nearestTextOffsetFromPoint(node, pointer),
                };
            }
            if (element === shell) break;
        }
        return null;
    }

    function islandElementPath(island, element) {
        if (!island || !element || !island.contains(element)) return null;
        const path = [];
        for (
            let current = element;
            current && current !== island;
            current = current.parentElement
        ) {
            const parent = current.parentElement;
            if (!parent) return null;
            path.unshift([...parent.children].indexOf(current));
        }
        return path;
    }

    function elementAtIslandPath(island, path) {
        let current = island;
        for (const index of path || []) {
            current = current?.children?.[index] || null;
            if (!current) return null;
        }
        return current;
    }

    function sourceTextRangeFromIslandPath(
        raw,
        islandId,
        path,
        textNodeIndex,
        renderedText
    ) {
        const template = document.createElement('template');
        template.innerHTML = raw;
        const sourceIsland = template.content.querySelector(
            `[data-vdoc-island="${CSS.escape(String(islandId || ''))}"]`
        );
        const sourceElement = elementAtIslandPath(sourceIsland, path);
        const sourceNode = sourceElement?.childNodes?.[textNodeIndex] || null;
        if (sourceNode?.nodeType !== Node.TEXT_NODE) return null;

        const sourceText = sourceNode.nodeValue || '';
        if (sourceText !== renderedText) return null;

        // 岛 ID 先确定持久源码域，元素路径和文本子节点序号再确定岛内目标。
        // 最后只需在该岛源码中选择同值文本节点对应的出现序号，不依赖正文 UUID。
        const walker = document.createTreeWalker(
            sourceIsland,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    if (node.parentElement?.closest('script,style,noscript')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return node.nodeValue === sourceText
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_SKIP;
                },
            }
        );
        const matchingNodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            matchingNodes.push(node);
        }
        const occurrence = matchingNodes.indexOf(sourceNode);
        if (occurrence < 0) return null;

        let sourceOffset = -1;
        for (let index = 0; index <= occurrence; index += 1) {
            sourceOffset = raw.indexOf(sourceText, sourceOffset + 1);
            if (sourceOffset < 0) return null;
        }
        return {
            start: sourceOffset,
            end: sourceOffset + sourceText.length,
        };
    }

    function islandRecordById(islandId) {
        return (state.document?.islands || [])
            .find((island) => island.id === islandId) || null;
    }

    function runtimeOverrideKey(path, textNodeIndex) {
        return `${(path || []).join('.')}:${Number(textNodeIndex)}`;
    }

    function setRuntimeIslandTextOverride(mapping, text) {
        const island = islandRecordById(mapping?.islandId);
        if (!island || !Array.isArray(mapping.path)
            || !Number.isInteger(mapping.textNodeIndex)) {
            return false;
        }
        island.runtimeTextOverrides = Array.isArray(island.runtimeTextOverrides)
            ? island.runtimeTextOverrides
            : [];
        const key = runtimeOverrideKey(mapping.path, mapping.textNodeIndex);
        const existing = island.runtimeTextOverrides.find((item) =>
            runtimeOverrideKey(item.path, item.textNodeIndex) === key
        );
        const value = String(text ?? '');
        if (existing) {
            existing.text = value;
        } else {
            island.runtimeTextOverrides.push({
                path: [...mapping.path],
                textNodeIndex: mapping.textNodeIndex,
                text: value,
            });
        }
        return true;
    }

    function applyRuntimeIslandTextOverrides(islandRoot, islandRecord) {
        (islandRecord?.runtimeTextOverrides || []).forEach((override) => {
            const element = elementAtIslandPath(islandRoot, override.path);
            const node = element?.childNodes?.[override.textNodeIndex] || null;
            if (node?.nodeType === Node.TEXT_NODE) {
                node.nodeValue = String(override.text ?? '');
            }
        });
    }

    function installRuntimeIslandTextEditing(root = getRenderRoot()) {
        if (!root || isSlideDeck()) return false;
        root.querySelectorAll(
            '[data-vdoc-edit-type="island"][data-vdoc-edit-key]'
        ).forEach((shell) => {
            const region = hybridEditRegionByKey(shell.dataset.vdocEditKey);
            const islandRoot = region?.islandId
                ? shell.querySelector(
                    `[data-vdoc-island="${CSS.escape(region.islandId)}"]`
                )
                : null;
            const islandRecord = islandRecordById(region?.islandId);
            if (!region || !islandRoot || !islandRecord) return;

            applyRuntimeIslandTextOverrides(islandRoot, islandRecord);
            const islandSource = currentSourceHtml().slice(
                region.sourceRange.start,
                region.sourceRange.end
            );

            hybridTextNodes(islandRoot).forEach((node) => {
                let mapping = state.hybridTextSourceMap.get(node);
                if (!mapping) {
                    const path = islandElementPath(islandRoot, node.parentElement);
                    const textNodeIndex = [...(node.parentElement?.childNodes || [])]
                        .indexOf(node);
                    if (!path || textNodeIndex < 0) return;

                    // 动态 DOM 的可见值可能仍来自岛脚本中的静态数据，例如
                    // test.md 表格的 rows 数组。若该文字在岛源码中唯一出现，
                    // 直接建立源码映射，使渲染后编辑真正修改脚本数据，而不是
                    // 仅保存一份与脚本分离的视觉覆盖。
                    const sourceRange = sourceTextRange(
                        islandSource,
                        node.nodeValue || ''
                    );
                    mapping = sourceRange
                        ? {
                            kind: 'source',
                            shell,
                            regionKey: region.key,
                            domain: 'html',
                            islandId: region.islandId,
                            path,
                            textNodeIndex,
                            sourceRange: {
                                start: region.sourceRange.start + sourceRange.start,
                                end: region.sourceRange.start + sourceRange.end,
                            },
                        }
                        : {
                            kind: 'runtime',
                            shell,
                            regionKey: region.key,
                            domain: 'html',
                            islandId: region.islandId,
                            path,
                            textNodeIndex,
                            sourceRange: null,
                        };
                    state.hybridTextSourceMap.set(node, mapping);
                }

                const host = node.parentElement;
                const interactive = host?.closest(
                    'a,button,input,select,textarea,audio,video,[role="button"]'
                );
                if (host && !interactive
                    && !host.matches('[data-vdoc-island]')) {
                    host.contentEditable = 'true';
                    host.spellcheck = false;
                }
            });
        });
        return true;
    }

    function focusHybridRegionByOrdinal(ordinal, selectContents = false) {
        const shell = getRenderRoot()?.querySelectorAll(
            '[data-vdoc-edit-key]'
        )?.[ordinal];
        if (!shell) return false;
        const editable = shell.querySelector('[contenteditable="true"]');
        if (!editable) return false;

        try {
            editable.focus({ preventScroll: true });
        } catch {
            editable.focus();
        }
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(!selectContents);
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        state.selectionRange = range.cloneRange();
        state.selectionText = range.toString();
        beginHybridDomSession(shell, editable);
        state.activeEditableBlock = editable;
        scheduleFormattingControls(editable);
        return true;
    }

    function insertHybridParagraphRelativeToSession(session, before = false) {
        if (!session?.shell?.isConnected) return false;
        patchHybridSourceFromDom(session);
        const region = hybridEditRegionByKey(
            session.shell.dataset.vdocEditKey
        );
        if (!region) return false;
        const nextOrdinal = region.ordinal + (before ? 0 : 1);
        if (!insertHybridSourceFragment(
            emptyMarkdownParagraphSource(),
            { afterRegion: !before }
        )) {
            return false;
        }
        window.requestAnimationFrame(() => {
            if (state.mode === 'render') {
                focusHybridRegionByOrdinal(nextOrdinal);
            }
        });
        return true;
    }

    function commitHybridRegionPresentation(shell) {
        if (!shell?.isConnected) return false;
        const livePreview = state.markdownLivePreview;
        if (livePreview?.shell === shell) {
            return commitMarkdownLivePreview(livePreview);
        }
        const session = state.hybridEditSessions.get(shell);
        if (session) patchHybridSourceFromDom(session);
        const region = hybridEditRegionByKey(shell.dataset.vdocEditKey);
        if (!region || region.type !== 'markdown') return false;

        // 行首补入 ##、>、- 等结构语法后，即使浏览器的 input 差分没有
        // 触发即时结构替换，离开输入区时也必须以 Markdown 真源重新生成 DOM。
        // 仅替换当前编辑壳，避免整篇重渲染和无关动画岛重新启动。
        if (!patchHybridShellFromCompilation(shell, region.ordinal)) return false;
        const nextRegion = parsedDocument().editRegions[region.ordinal];
        if (nextRegion) restoreHybridEditableState(shell, nextRegion);
        return true;
    }

    function bindHybridRenderSurface(root) {
        state.renderSurfaceAbortController?.abort();
        const controller = new AbortController();
        state.renderSurfaceAbortController = controller;
        const options = { signal: controller.signal };

        root.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || event.defaultPrevented) return;
            const shell = event.target.closest?.('[data-vdoc-edit-key]');
            if (!shell) return;
            const region = hybridEditRegionByKey(shell.dataset.vdocEditKey);
            if (!region || hybridEditableDomain(region) === 'atomic') return;
            const interactive = event.target.closest?.(
                'a,button,input,select,textarea,audio,video,[role="button"]'
            );
            if (interactive && !event.target.closest?.('[data-vdoc-md-live-preview]')) {
                return;
            }

            const livePreviewEditor = event.target.closest?.(
                '[data-vdoc-md-live-preview]'
            );
            if (region.type === 'markdown' && livePreviewEditor) {
                const session = state.markdownLivePreview;
                if (session?.editor === livePreviewEditor) {
                    // 不拦截 pointerdown，让浏览器先按点击坐标建立原生光标。
                    // 下一帧仅更新 marker 的显示状态，不替换任何编辑节点。
                    window.requestAnimationFrame(() => {
                        if (state.markdownLivePreview !== session) return;
                        refreshMarkdownLivePreviewMarkers(session);
                        scheduleFormattingControls(session.editor);
                    });
                }
                return;
            }
            if (region.type === 'markdown') {
                event.preventDefault();
                const session = activateMarkdownLivePreview(shell, event);
                if (session) scheduleFormattingControls(session.editor);
                return;
            }

            let editable = event.target.closest?.('[contenteditable]');
            let target = null;
            if (region.type === 'html' || region.type === 'island') {
                target = pointerTextTarget(shell, event);
                const mapped = target?.node
                    ? state.hybridTextSourceMap.get(target.node)
                    : null;
                if (!target || mapped?.shell !== shell) return;

                // 始终以坐标命中的映射文本节点为会话目标，不能使用某个祖先上
                // 遗留的 contenteditable；否则同一 HTML 宿主内的第二段文字会
                // 错写到第一段的源码范围。
                editable = target.parent;
                if (!editable || !shell.contains(editable)) return;

                // 岛内经常存在绝对定位的装饰层，例如 3D 卡片的 depth 覆盖层。
                // 浏览器原生点击会命中装饰层而不是其下方的可编辑标题，所以即使
                // editable 已经启用，也必须始终把焦点和光标重定向到映射文字。
                event.preventDefault();
                editable.contentEditable = 'true';
                editable.spellcheck = false;
                editable.focus({ preventScroll: true });

                const range = document.createRange();
                range.setStart(target.node, target.offset);
                range.collapse(true);
                const selection = currentRenderSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
            if (!editable || !shell.contains(editable)) return;
            if (editable.matches('[data-vdoc-md-live-preview]')) {
                state.activeEditableBlock = editable;
                return;
            }
            const session = beginHybridDomSession(
                shell,
                editable,
                target?.node || null
            );
            if (!session) {
                if (region.type === 'html' || region.type === 'island') {
                    editable.removeAttribute('contenteditable');
                    editable.removeAttribute('spellcheck');
                }
                return;
            }
            state.activeEditableBlock = editable;
            scheduleFormattingControls(editable);
        }, options);

        root.addEventListener('focusin', (event) => {
            const shell = event.target.closest?.('[data-vdoc-edit-key]');
            if (!shell || !event.target.closest?.('[contenteditable]')) return;
            const editable = event.target.closest('[contenteditable]');
            if (editable.matches('[data-vdoc-md-live-preview]')) {
                state.activeEditableBlock = editable;
                scheduleFormattingControls(event.target);
                return;
            }
            beginHybridDomSession(shell, editable);
            state.activeEditableBlock = editable;
            scheduleFormattingControls(event.target);
        }, options);

        root.addEventListener('paste', (event) => {
            const editor = event.target.closest?.('[data-vdoc-md-live-preview]');
            if (!editor) return;
            event.preventDefault();
            const text = (event.clipboardData || window.clipboardData)
                ?.getData?.('text/plain') || '';
            if (insertMarkdownLivePreviewText(editor, text)) {
                patchMarkdownLivePreviewSource(state.markdownLivePreview);
            }
        }, options);

        root.addEventListener('copy', (event) => {
            const editor = event.target.closest?.('[data-vdoc-md-live-preview]');
            const context = markdownLivePreviewSelection(editor);
            if (!context) return;
            const text = context.range.toString();
            event.clipboardData?.setData('text/plain', text);
            event.clipboardData?.setData('text/html', escapeHtml(text));
            event.preventDefault();
        }, options);

        root.addEventListener('cut', (event) => {
            const editor = event.target.closest?.('[data-vdoc-md-live-preview]');
            const context = markdownLivePreviewSelection(editor);
            if (!context) return;
            const text = context.range.toString();
            event.clipboardData?.setData('text/plain', text);
            event.clipboardData?.setData('text/html', escapeHtml(text));
            event.preventDefault();
            context.range.deleteContents();
            context.range.collapse(true);
            context.selection.removeAllRanges();
            context.selection.addRange(context.range);
            editor.normalize();
            patchMarkdownLivePreviewSource(state.markdownLivePreview);
        }, options);

        root.addEventListener('input', (event) => {
            const shell = event.target.closest?.('[data-vdoc-edit-key]');
            if (!shell || !event.target.closest?.('[contenteditable]')) return;
            const editable = event.target.closest('[contenteditable]');
            if (editable.matches('[data-vdoc-md-live-preview]')) {
                const session = state.markdownLivePreview;
                if (session?.editor === editable) {
                    patchMarkdownLivePreviewSource(session);
                    state.selectionText = currentRenderSelection()?.toString() || '';
                }
                return;
            }
            const existing = state.hybridEditSessions.get(shell);
            const session = existing?.editable === editable
                ? existing
                : beginHybridDomSession(shell, editable);
            if (!session) return;
            patchHybridSourceFromDom(session);
            state.selectionText = currentRenderSelection()?.toString() || '';
            scheduleFormattingControls(event.target);
        }, options);

        root.addEventListener('keydown', (event) => {
            if (event.isComposing || event.keyCode === 229) return;
            const isEnter = event.key === 'Enter';
            const isShiftEnter = isEnter && event.shiftKey;
            const isTab = event.key === 'Tab' && !event.ctrlKey
                && !event.metaKey && !event.altKey;
            if (!isEnter && !isTab) return;

            const shell = event.target.closest?.('[data-vdoc-edit-key]');
            const editable = event.target.closest?.('[contenteditable]');
            if (!shell || !editable) return;

            if (isTab || (isEnter && !isShiftEnter)) {
                event.preventDefault();
                event.stopPropagation();
                // Markdown 中单个源码换行会被解析为空格。普通 Enter 必须写入
                // “两个行尾空格 + 换行”才能在渲染与重新打开后保持段内换行。
                // Shift+Enter 不经过这里，而是创建独立的空文本段。
                const inserted = isTab
                    ? '\u3000\u3000'
                    : editable.matches('[data-vdoc-md-live-preview]')
                        ? '  \n'
                        : '\n';
                if (insertMarkdownLivePreviewText(editable, inserted)) {
                    if (editable.matches('[data-vdoc-md-live-preview]')) {
                        patchMarkdownLivePreviewSource(state.markdownLivePreview);
                    } else {
                        const existing = state.hybridEditSessions.get(shell);
                        const session = existing?.editable === editable
                            ? existing
                            : beginHybridDomSession(shell, editable);
                        if (session) patchHybridSourceFromDom(session);
                    }
                }
                return;
            }

            const atStart = caretIsAtBlockStart(
                currentRenderSelection(),
                editable
            );
            if (editable.matches('[data-vdoc-md-live-preview]')) {
                const livePreview = state.markdownLivePreview;
                if (!livePreview || livePreview.editor !== editable) return;
                event.preventDefault();
                event.stopPropagation();
                insertMarkdownParagraphRelativeToLivePreview(livePreview, atStart);
                return;
            }
            const region = hybridEditRegionByKey(shell.dataset.vdocEditKey);
            if (!region || hybridEditableDomain(region) === 'atomic') return;
            const existing = state.hybridEditSessions.get(shell);
            const session = existing?.editable === editable
                ? existing
                : beginHybridDomSession(shell, editable);
            if (!session) return;
            event.preventDefault();
            event.stopPropagation();
            insertHybridParagraphRelativeToSession(session, atStart);
        }, options);

        root.addEventListener('focusout', (event) => {
            const shell = event.target.closest?.('[data-vdoc-edit-key]');
            if (!shell) return;
            window.requestAnimationFrame(() => {
                if (!shell.isConnected) return;
                const active = root.activeElement;
                if (active && shell.contains(active)) return;
                commitHybridRegionPresentation(shell);
            });
        }, options);

        root.addEventListener('mouseup', () => {
            captureCurrentSelection();
            scheduleFormattingFromCurrentSelection();
        }, options);

        root.addEventListener('keyup', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
                .includes(event.key) && !event.shiftKey) {
                return;
            }
            captureCurrentSelection();
            scheduleFormattingFromCurrentSelection();
        }, options);
    }

    function bindRenderSurface(root) {
        // ShadowRoot 会在重渲染时复用。必须先移除上一轮委托监听器，
        // 否则每次应用源码或切页都会叠加一套 input/keydown 处理器。
        state.renderSurfaceAbortController?.abort();
        const controller = new AbortController();
        state.renderSurfaceAbortController = controller;
        const listenerOptions = { signal: controller.signal };

        root.addEventListener('focusin', (event) => {
            const page = event.target.closest?.('.vdoc-page');
            if (page) {
                state.activePage = page;
                activatePage(page);
            }
            const block = event.target.closest?.('[data-vdoc-block]');
            if (block) state.activeEditableBlock = block;
            scheduleFormattingControls(event.target);
        }, listenerOptions);

        root.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const block = event.target.closest?.('[data-vdoc-text]');
            if (!block) {
                createTextBlockAtBlankPoint(event);
                return;
            }

            // pointerdown 先于焦点和选区更新发生。直接以命中的实际文字节点
            // 同步工具栏，使重复点击已经聚焦的块、以及点击块内不同字号的
            // span 时，顶部字体和字号也能立即跳到当前位置。
            state.activeEditableBlock = block;
            scheduleFormattingControls(event.target);
            const blockId = block.dataset.vdocText;
            state.pointerSelectionAnchorId = blockId;
            state.pointerSelectingBlocks = false;

            if (event.shiftKey && state.blockSelectionAnchorId) {
                event.preventDefault();
                state.pointerSelectingBlocks = true;
                selectBlockInterval(state.blockSelectionAnchorId, blockId);
            } else if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                state.pointerSelectingBlocks = true;
                toggleExplicitBlock(blockId);
            } else {
                state.blockSelectionAnchorId = blockId;
                if (state.explicitBlockSelection) clearExplicitBlockSelection();
            }
        }, listenerOptions);

        root.addEventListener('pointermove', (event) => {
            if (!(event.buttons & 1) || !state.pointerSelectionAnchorId) return;
            const block = event.target.closest?.('[data-vdoc-text]');
            const blockId = block?.dataset?.vdocText;
            if (!blockId || blockId === state.pointerSelectionAnchorId
                || blockId === state.pendingPointerSelectionId) return;
            event.preventDefault();
            state.pointerSelectingBlocks = true;
            state.pendingPointerSelectionId = blockId;
            if (state.pointerSelectionFrame !== null) return;
            state.pointerSelectionFrame = window.requestAnimationFrame(() => {
                state.pointerSelectionFrame = null;
                const focusId = state.pendingPointerSelectionId;
                state.pendingPointerSelectionId = null;
                if (focusId && state.pointerSelectionAnchorId) {
                    selectBlockInterval(
                        state.pointerSelectionAnchorId,
                        focusId,
                        { preserveAnchor: true }
                    );
                }
            });
        }, listenerOptions);

        root.addEventListener('mouseup', () => {
            if (state.pointerSelectionFrame !== null) {
                window.cancelAnimationFrame(state.pointerSelectionFrame);
                state.pointerSelectionFrame = null;
            }
            const focusId = state.pendingPointerSelectionId;
            state.pendingPointerSelectionId = null;
            if (focusId && state.pointerSelectionAnchorId) {
                selectBlockInterval(
                    state.pointerSelectionAnchorId,
                    focusId,
                    { preserveAnchor: true }
                );
            }
            if (!state.pointerSelectingBlocks) captureCurrentSelection();
            state.pointerSelectionAnchorId = null;
            state.pointerSelectingBlocks = false;
            scheduleFormattingFromCurrentSelection();
        }, listenerOptions);
        root.addEventListener('keyup', (event) => {
            // 普通输入、Enter 与 Backspace 不改变当前字符格式，无需在每个按键后
            // 强制 getComputedStyle 和遍历数百个系统字体选项。
            const selectionKeys = new Set([
                'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                'Home', 'End', 'PageUp', 'PageDown',
            ]);
            if (!selectionKeys.has(event.key) && !event.shiftKey) return;
            captureCurrentSelection();
            scheduleFormattingFromCurrentSelection();
        }, listenerOptions);
        root.addEventListener('keydown', handleBlockEditingKeydown, listenerOptions);

        root.addEventListener('copy', (event) => {
            const payload = richClipboardPayload();
            if (!payload) return;
            writeRichClipboardPayload(payload, event.clipboardData);
            event.preventDefault();
        }, listenerOptions);

        root.addEventListener('cut', (event) => {
            const payload = richClipboardPayload();
            if (!payload) return;
            writeRichClipboardPayload(payload, event.clipboardData);
            event.preventDefault();
            deleteClipboardSelection();
        }, listenerOptions);

        root.addEventListener('paste', (event) => {
            const editable = event.target.closest?.('[data-vdoc-text]');
            if (!editable) return;

            // Ctrl+V 是安全默认项“粘贴”：内部复制也只插入文字，避免浏览器
            // 把完整 H1/H2 嵌进另一个可编辑块。保留结构由右键菜单中的
            // “粘贴（维持格式）”显式执行。
            const clipboard = event.clipboardData || window.clipboardData;
            const html = clipboard?.getData?.('text/html') || '';
            if (!/\bdata-vdoc-(?:text|block|container)\s*=/i.test(html)) return;

            event.preventDefault();
            const text = clipboard?.getData?.('text/plain') || '';
            if (!insertPlainTextAtCurrentSelection(editable, text)) return;
            queueRenderedNodeUpdate(editable);
            window.ScriptoriumPretext?.evictNode(editable.dataset.vdocText);
            state.activeEditableBlock = editable;
            markDirty({ coalesce: true });
        }, listenerOptions);

        root.addEventListener('input', (event) => {
            const editable = event.target.closest?.('[data-vdoc-text]');
            if (!editable) return;
            queueRenderedNodeUpdate(editable);
            window.ScriptoriumPretext?.evictNode(editable.dataset.vdocText);
            markDirty({ coalesce: true });
        }, listenerOptions);

        root.addEventListener('contextmenu', (event) => {
            if (event.target.closest?.('[data-vdoc-object-id]')) return;
            event.preventDefault();
            const block = event.target.closest?.('[data-vdoc-text]');
            if (!state.explicitBlockSelection) captureCurrentSelection();
            showTextContextMenu(event.clientX, event.clientY, block, event);
        }, listenerOptions);
    }

    function currentRenderSelection() {
        return getRenderRoot()?.getSelection?.() || window.getSelection();
    }

    function editableBlocksForRange(range) {
        const root = getRenderRoot();
        if (!root || !range || range.collapsed) return [];
        return allRenderedTextBlocks().filter((block) => {
            try {
                return range.intersectsNode(block);
            } catch {
                return false;
            }
        });
    }

    function allRenderedTextBlocks() {
        const root = getRenderRoot();
        if (!root) return [];
        if (state.renderedTextBlocks.length
            && state.renderedTextBlocks.every((block) => block.isConnected && root.contains(block))) {
            return state.renderedTextBlocks;
        }
        state.renderedTextBlocks = [...root.querySelectorAll('[data-vdoc-text]')];
        return state.renderedTextBlocks;
    }

    function blocksForIds(ids = state.selectionBlockIds) {
        const selected = new Set(ids);
        return allRenderedTextBlocks().filter((block) => selected.has(block.dataset.vdocText));
    }

    function updateBlockSelectionPresentation() {
        const selected = new Set(state.selectionBlockIds);
        allRenderedTextBlocks().forEach((block) => {
            if (state.explicitBlockSelection && selected.has(block.dataset.vdocText)) {
                block.dataset.vdocEditorSelected = 'true';
            } else {
                block.removeAttribute('data-vdoc-editor-selected');
            }
        });
        document.querySelectorAll('.outline-item, .paragraph-item').forEach((button) => {
            const active = state.explicitBlockSelection && selected.has(button.dataset.vdocText);
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        if (elements['selection-status']) {
            elements['selection-status'].hidden = !state.explicitBlockSelection;
            elements['selection-status'].textContent = state.explicitBlockSelection
                ? `已选 ${state.selectionBlockIds.length} 块`
                : '';
        }
    }

    function clearExplicitBlockSelection() {
        state.explicitBlockSelection = false;
        state.selectionBlockIds = [];
        state.selectionRange = null;
        state.selectionText = '';
        currentRenderSelection()?.removeAllRanges();
        updateBlockSelectionPresentation();
    }

    function setExplicitBlockSelection(ids, options = {}) {
        const ordered = allRenderedTextBlocks();
        const wanted = new Set(ids);
        const blocks = ordered.filter((block) => wanted.has(block.dataset.vdocText));
        if (!blocks.length) {
            clearExplicitBlockSelection();
            return false;
        }

        state.explicitBlockSelection = true;
        state.selectionBlockIds = blocks.map((block) => block.dataset.vdocText);
        if (!options.preserveAnchor) state.blockSelectionAnchorId = state.selectionBlockIds[0];

        const range = document.createRange();
        range.setStartBefore(blocks[0]);
        range.setEndAfter(blocks[blocks.length - 1]);
        state.selectionRange = range.cloneRange();
        state.selectionText = blocks.map((block) => block.textContent || '').join('\n');

        // Shift/Ctrl 多选会在 pointerdown 中 preventDefault，浏览器因此不会把
        // 焦点移入 contenteditable。只有 Range 而没有 Shadow DOM 内焦点时，
        // Ctrl+C 的 copy 事件会随机发往外层页面或此前控件，渲染根监听器收不到。
        // 先稳定焦点，再安装完整 Range，确保多选复制与剪切始终进入文稿事件链。
        try {
            blocks[0].focus({ preventScroll: true });
        } catch {
            blocks[0].focus();
        }
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        state.activeEditableBlock = blocks[0];
        scheduleFormattingControls(blocks[0]);
        updateBlockSelectionPresentation();
        return true;
    }

    function selectBlockInterval(anchorId, focusId, options = {}) {
        const blocks = allRenderedTextBlocks();
        const anchorIndex = blocks.findIndex((block) => block.dataset.vdocText === anchorId);
        const focusIndex = blocks.findIndex((block) => block.dataset.vdocText === focusId);
        if (anchorIndex < 0 || focusIndex < 0) return false;
        const start = Math.min(anchorIndex, focusIndex);
        const end = Math.max(anchorIndex, focusIndex);
        return setExplicitBlockSelection(
            blocks.slice(start, end + 1).map((block) => block.dataset.vdocText),
            { preserveAnchor: options.preserveAnchor ?? true }
        );
    }

    function toggleExplicitBlock(blockId) {
        const ids = new Set(state.explicitBlockSelection ? state.selectionBlockIds : []);
        if (ids.has(blockId)) ids.delete(blockId);
        else ids.add(blockId);
        if (!state.blockSelectionAnchorId) state.blockSelectionAnchorId = blockId;
        return setExplicitBlockSelection([...ids], { preserveAnchor: true });
    }

    function captureCurrentSelection() {
        const selection = currentRenderSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);
        const root = getRenderRoot();
        if (!root || !root.contains(range.commonAncestorContainer)) return false;
        state.explicitBlockSelection = false;
        state.selectionRange = range.cloneRange();
        state.selectionText = selection.toString();
        state.selectionBlockIds = editableBlocksForRange(range)
            .map((block) => block.dataset.vdocText)
            .filter(Boolean);
        updateBlockSelectionPresentation();
        return true;
    }

    function selectEntireRenderedDocument() {
        const root = getRenderRoot();
        const runtime = root?.querySelector('.vdoc-runtime');
        if (!runtime) return false;
        root.querySelectorAll('.vdoc-page[data-runtime-state="tombstone"]').forEach(activatePage);
        const blocks = [...root.querySelectorAll('[data-vdoc-text]')];
        if (!blocks.length) return false;
        setExplicitBlockSelection(blocks.map((block) => block.dataset.vdocText));
        showToast(`已选择全文 · ${blocks.length} 个文本块`, 'success');
        return true;
    }

    function restoreSavedSelection() {
        const range = state.selectionRange;
        if (!range || !range.startContainer?.isConnected || !range.endContainer?.isConnected) return null;
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return range;
    }

    function selectedRange(preferSaved = false) {
        if (preferSaved && state.selectionRange?.startContainer?.isConnected
            && state.selectionRange?.endContainer?.isConnected) {
            return state.selectionRange;
        }
        const selection = currentRenderSelection();
        if (selection?.rangeCount && !selection.isCollapsed) return selection.getRangeAt(0);
        return state.selectionRange?.startContainer?.isConnected
            && state.selectionRange?.endContainer?.isConnected
            ? state.selectionRange
            : null;
    }

    function rangeWithinBlock(sourceRange, block) {
        if (!sourceRange || !block) return null;
        try {
            if (!sourceRange.intersectsNode(block)) return null;
            const blockRange = document.createRange();
            blockRange.selectNodeContents(block);
            const range = document.createRange();
            if (sourceRange.compareBoundaryPoints(Range.START_TO_START, blockRange) > 0) {
                range.setStart(sourceRange.startContainer, sourceRange.startOffset);
            } else {
                range.setStart(blockRange.startContainer, blockRange.startOffset);
            }
            if (sourceRange.compareBoundaryPoints(Range.END_TO_END, blockRange) < 0) {
                range.setEnd(sourceRange.endContainer, sourceRange.endOffset);
            } else {
                range.setEnd(blockRange.endContainer, blockRange.endOffset);
            }
            return range.collapsed ? null : range;
        } catch {
            return null;
        }
    }

    function selectedEditableBlocks(preferSaved = false) {
        if (state.explicitBlockSelection) {
            const explicitBlocks = blocksForIds();
            if (explicitBlocks.length) return explicitBlocks;
        }
        const range = selectedRange(preferSaved);
        const blocks = editableBlocksForRange(range);
        if (blocks.length) return blocks;
        const root = getRenderRoot();
        return state.activeEditableBlock && root?.contains(state.activeEditableBlock)
            ? [state.activeEditableBlock]
            : [];
    }

    function wrapSelectionRanges(configureWrapper, preferSaved = false) {
        const sourceRange = selectedRange(preferSaved);
        if (!sourceRange || sourceRange.collapsed) return [];
        const targetBlocks = state.explicitBlockSelection
            ? blocksForIds()
            : editableBlocksForRange(sourceRange);
        const ranges = targetBlocks
            .map((block) => state.explicitBlockSelection
                ? (() => {
                    const range = document.createRange();
                    range.selectNodeContents(block);
                    return range;
                })()
                : rangeWithinBlock(sourceRange, block))
            .filter(Boolean);
        if (!ranges.length) return [];

        const wrappers = [];
        [...ranges].reverse().forEach((range) => {
            const wrapper = document.createElement('span');
            configureWrapper(wrapper);
            try {
                range.surroundContents(wrapper);
            } catch {
                wrapper.appendChild(range.extractContents());
                range.insertNode(wrapper);
            }
            wrappers.unshift(wrapper);
        });
        if (!wrappers.length) return [];

        const nextRange = document.createRange();
        nextRange.setStartBefore(wrappers[0]);
        nextRange.setEndAfter(wrappers[wrappers.length - 1]);
        state.selectionRange = nextRange.cloneRange();
        state.selectionText = nextRange.toString();
        state.selectionBlockIds = editableBlocksForRange(nextRange)
            .map((block) => block.dataset.vdocText)
            .filter(Boolean);
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(nextRange);
        return wrappers;
    }

    function cssColorToHex(color) {
        const match = String(color || '').match(/\d+(?:\.\d+)?/g);
        if (!match || match.length < 3) return '#1b211f';
        return `#${match.slice(0, 3)
            .map((value) => Math.max(0, Math.min(255, Math.round(Number(value))))
                .toString(16).padStart(2, '0'))
            .join('')}`;
    }

    function fontFamilies(fontFamily) {
        return String(fontFamily || '')
            .split(',')
            .map((family) => family.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
    }

    function firstFontFamily(fontFamily) {
        return fontFamilies(fontFamily)[0] || '';
    }

    function syncSelectClosestFont(select, fontFamily) {
        if (!select) return;
        let lookup = state.fontOptionLookup.get(select);
        if (!lookup || lookup.optionCount !== select.options.length) {
            lookup = {
                optionCount: select.options.length,
                values: new Map([...select.options].flatMap((option) =>
                    fontFamilies(option.value).map((family) => [
                        family.toLowerCase(),
                        option.value,
                    ])
                )),
            };
            state.fontOptionLookup.set(select, lookup);
        }

        // computedStyle 通常返回完整字体回退栈。首选字体不在系统列表时，
        // 继续匹配后续实际可用字体，而不是让工具栏停留在上一个文本块。
        const value = fontFamilies(fontFamily)
            .map((family) => lookup.values.get(family.toLowerCase()))
            .find((candidate) => candidate !== undefined);
        if (value !== undefined && select.value !== value) select.value = value;
    }

    function syncSelectClosestSize(select, pixelSize) {
        if (!select) return;
        const points = Number.parseFloat(pixelSize) * .75;
        const options = [...select.options]
            .map((option) => ({ option, value: Number.parseFloat(option.value) }))
            .filter((item) => Number.isFinite(item.value));
        if (!options.length || !Number.isFinite(points)) return;
        options.sort((left, right) =>
            Math.abs(left.value - points) - Math.abs(right.value - points)
        );
        select.value = options[0].option.value;
    }

    function setInlineCommandControlState(command, active) {
        document.querySelectorAll(
            `[data-command="${command}"], [data-selection-command="${command}"]`
        ).forEach((control) => {
            control.classList.toggle('active', active);
            control.setAttribute('aria-pressed', String(active));
        });
    }

    function elementHasInlineCommand(element, command) {
        if (!element) return false;
        const block = element.closest?.('[data-vdoc-text]');
        if (!block) return false;

        if (command === 'bold') {
            const weight = getComputedStyle(element).fontWeight;
            return Number.parseFloat(weight) >= 600 || weight === 'bold';
        }
        if (command === 'italic') {
            return /^(?:italic|oblique)/i.test(getComputedStyle(element).fontStyle);
        }

        const wantedDecoration = command === 'underline' ? 'underline' : 'line-through';
        for (let current = element; current; current = current.parentElement) {
            if (command === 'underline' && current.tagName === 'U') return true;
            if (command === 'strikethrough'
                && (current.tagName === 'S' || current.tagName === 'STRIKE')) return true;
            const decoration = `${current.style?.textDecorationLine || ''} ${
                current.style?.textDecoration || ''
            }`;
            if (decoration.split(/\s+/).includes(wantedDecoration)) return true;
            if (current === block) break;
        }
        return false;
    }

    function hybridElementHasInlineCommand(element, shell, command) {
        if (!element || !shell?.contains(element)) return false;
        if (command === 'bold') {
            const weight = getComputedStyle(element).fontWeight;
            return Number.parseFloat(weight) >= 600 || weight === 'bold';
        }
        if (command === 'italic') {
            return /^(?:italic|oblique)/i.test(getComputedStyle(element).fontStyle);
        }

        const wantedDecoration = command === 'underline' ? 'underline' : 'line-through';
        for (let current = element; current && shell.contains(current); current = current.parentElement) {
            if (command === 'underline' && current.tagName === 'U') return true;
            if (command === 'strikethrough'
                && ['S', 'STRIKE', 'DEL'].includes(current.tagName)) {
                return true;
            }
            const computed = getComputedStyle(current);
            const decoration = `${
                current.style?.textDecorationLine || ''
            } ${current.style?.textDecoration || ''} ${
                computed.textDecorationLine || ''
            }`;
            if (decoration.split(/\s+/).includes(wantedDecoration)) return true;
            if (current === shell) break;
        }
        return false;
    }

    function syncFormattingControls(target) {
        const domContext = !isSlideDeck() ? hybridDomEditingContext() : null;
        if (domContext) {
            document.querySelectorAll(
                '[data-command], [data-selection-command]'
            ).forEach((control) => {
                const command = control.dataset.command
                    || control.dataset.selectionCommand;
                if (['undo', 'redo', 'image'].includes(command)) return;
                control.disabled = false;
            });
            [
                elements['font-family-select'],
                elements['font-size-select'],
                elements['text-color-input'],
                elements['highlight-color-input'],
                elements['line-height-select'],
                elements['selection-font-family'],
                elements['selection-font-size'],
                elements['selection-text-color'],
            ].forEach((control) => {
                if (control) control.disabled = false;
            });

            const rangeElement = domContext.range.startContainer.nodeType
                === Node.ELEMENT_NODE
                ? domContext.range.startContainer
                : domContext.range.startContainer.parentElement;
            const textElement = rangeElement?.closest?.(
                'span,strong,b,em,i,del,s,strike,u,a,[contenteditable]'
            ) || rangeElement || domContext.shell;
            const computed = getComputedStyle(textElement);
            syncSelectClosestFont(elements['font-family-select'], computed.fontFamily);
            syncSelectClosestFont(elements['selection-font-family'], computed.fontFamily);
            syncSelectClosestSize(elements['font-size-select'], computed.fontSize);
            syncSelectClosestSize(elements['selection-font-size'], computed.fontSize);
            ['bold', 'italic', 'underline', 'strikethrough'].forEach((command) => {
                setInlineCommandControlState(
                    command,
                    hybridElementHasInlineCommand(
                        textElement,
                        domContext.shell,
                        command
                    )
                );
            });
            const color = cssColorToHex(computed.color);
            elements['text-color-input'].value = color;
            elements['selection-text-color'].value = color;
            const lineHeight = Number.parseFloat(computed.lineHeight);
            const fontSize = Number.parseFloat(computed.fontSize);
            if (Number.isFinite(lineHeight)
                && Number.isFinite(fontSize)
                && fontSize > 0) {
                const ratio = lineHeight / fontSize;
                const closest = [...elements['line-height-select'].options]
                    .sort((left, right) =>
                        Math.abs(Number(left.value) - ratio)
                        - Math.abs(Number(right.value) - ratio)
                    )[0];
                if (closest) elements['line-height-select'].value = closest.value;
            }
            return;
        }

        document.querySelectorAll(
            '[data-command], [data-selection-command]'
        ).forEach((control) => {
            control.disabled = false;
        });
        [
            elements['font-family-select'],
            elements['font-size-select'],
            elements['text-color-input'],
            elements['highlight-color-input'],
            elements['line-height-select'],
            elements['selection-font-family'],
            elements['selection-font-size'],
            elements['selection-text-color'],
        ].forEach((control) => {
            if (control) control.disabled = false;
        });

        const element = target?.nodeType === Node.ELEMENT_NODE
            ? target
            : target?.parentElement;
        const textElement = element?.closest?.('[data-vdoc-text], span, strong, em, a, u, s, strike')
            || state.activeEditableBlock;
        if (!textElement) return;

        const computed = getComputedStyle(textElement);
        syncSelectClosestFont(elements['font-family-select'], computed.fontFamily);
        syncSelectClosestFont(elements['selection-font-family'], computed.fontFamily);
        syncSelectClosestSize(elements['font-size-select'], computed.fontSize);
        syncSelectClosestSize(elements['selection-font-size'], computed.fontSize);
        ['bold', 'italic', 'underline', 'strikethrough'].forEach((command) => {
            setInlineCommandControlState(
                command,
                elementHasInlineCommand(textElement, command)
            );
        });

        const color = cssColorToHex(computed.color);
        elements['text-color-input'].value = color;
        elements['selection-text-color'].value = color;
        const lineHeight = Number.parseFloat(computed.lineHeight);
        const fontSize = Number.parseFloat(computed.fontSize);
        if (Number.isFinite(lineHeight) && Number.isFinite(fontSize) && fontSize > 0) {
            const ratio = lineHeight / fontSize;
            const closest = [...elements['line-height-select'].options]
                .sort((left, right) =>
                    Math.abs(Number(left.value) - ratio) - Math.abs(Number(right.value) - ratio)
                )[0];
            if (closest) elements['line-height-select'].value = closest.value;
        }
    }

    function scheduleFormattingControls(target) {
        state.pendingFormattingTarget = target;
        if (state.formattingSyncFrame !== null) return;
        state.formattingSyncFrame = window.requestAnimationFrame(() => {
            state.formattingSyncFrame = null;
            const pendingTarget = state.pendingFormattingTarget;
            state.pendingFormattingTarget = null;
            if (pendingTarget?.isConnected !== false) {
                syncFormattingControls(pendingTarget);
            }
        });
    }

    function scheduleFormattingFromCurrentSelection() {
        const selection = currentRenderSelection();
        const node = selection?.focusNode || selection?.anchorNode;
        if (node) scheduleFormattingControls(node);
    }

    function applyInlineStyle(property, value, preferSaved = false) {
        if (preferSaved) restoreSavedSelection();
        const wrappers = wrapSelectionRanges((wrapper) => {
            wrapper.style[property] = value;
        }, preferSaved);
        if (!wrappers.length) return false;
        const affectedBlocks = [...new Set(wrappers
            .map((wrapper) => wrapper.closest('[data-vdoc-text]'))
            .filter(Boolean))];
        queueRenderedNodesUpdate(affectedBlocks);
        markDirty({ coalesce: true });
        scheduleFormattingControls(wrappers[0]);
        return true;
    }

    function selectedTextElements(preferSaved = false) {
        const range = selectedRange(preferSaved);
        if (!range || range.collapsed) return [];
        const blocks = state.explicitBlockSelection
            ? blocksForIds()
            : editableBlocksForRange(range);
        const elementsInRange = [];
        blocks.forEach((block) => {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!(node.nodeValue || '').length) continue;
                try {
                    if (range.intersectsNode(node)) {
                        elementsInRange.push(node.parentElement || block);
                    }
                } catch {}
            }
        });
        return elementsInRange.length ? elementsInRange : blocks;
    }

    function selectionHasInlineCommand(command, preferSaved = false) {
        const targets = selectedTextElements(preferSaved);
        return targets.length > 0
            && targets.every((target) => elementHasInlineCommand(target, command));
    }

    function removeInlineCommandFromFragment(fragment, command) {
        const semanticTags = {
            bold: new Set(['B', 'STRONG']),
            italic: new Set(['I', 'EM']),
            underline: new Set(['U']),
            strikethrough: new Set(['S', 'STRIKE']),
        };
        const styleProperty = {
            bold: 'fontWeight',
            italic: 'fontStyle',
            underline: 'textDecoration',
            strikethrough: 'textDecoration',
        }[command];
        const decoration = command === 'underline' ? 'underline' : 'line-through';

        [...fragment.querySelectorAll('*')].reverse().forEach((node) => {
            if (styleProperty === 'textDecoration') {
                const lines = `${node.style.textDecorationLine || ''} ${
                    node.style.textDecoration || ''
                }`.split(/\s+/).filter((line) =>
                    line && line !== decoration && line !== 'none'
                );
                node.style.removeProperty('text-decoration');
                node.style.removeProperty('text-decoration-line');
                if (lines.length) node.style.textDecorationLine = [...new Set(lines)].join(' ');
            } else {
                node.style[styleProperty] = '';
            }
            if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');

            if (semanticTags[command].has(node.tagName)) {
                node.replaceWith(...node.childNodes);
            } else if (node.tagName === 'SPAN' && !node.attributes.length) {
                node.replaceWith(...node.childNodes);
            }
        });
    }

    function elementDeclaresInlineCommand(element, command) {
        if (!element) return false;
        const semanticTags = {
            bold: ['B', 'STRONG'],
            italic: ['I', 'EM'],
            underline: ['U'],
            strikethrough: ['S', 'STRIKE'],
        };
        if (semanticTags[command]?.includes(element.tagName)) return true;

        if (command === 'bold') {
            const weight = element.style.fontWeight;
            return weight === 'bold' || Number.parseFloat(weight) >= 600;
        }
        if (command === 'italic') {
            return /^(?:italic|oblique)/i.test(element.style.fontStyle);
        }
        const decoration = `${element.style.textDecorationLine || ''} ${
            element.style.textDecoration || ''
        }`;
        return decoration.split(/\s+/).includes(
            command === 'underline' ? 'underline' : 'line-through'
        );
    }

    function splitElementAroundChild(parent, child) {
        if (!parent?.parentNode || child?.parentNode !== parent) return child;
        const before = parent.cloneNode(false);
        const after = parent.cloneNode(false);
        while (parent.firstChild && parent.firstChild !== child) {
            before.appendChild(parent.firstChild);
        }
        while (child.nextSibling) after.appendChild(child.nextSibling);
        const replacements = [];
        if (before.childNodes.length) replacements.push(before);
        replacements.push(child);
        if (after.childNodes.length) replacements.push(after);
        parent.replaceWith(...replacements);
        return child;
    }

    function liftMarkerOutsideInlineCommand(marker, command, block) {
        let commandAncestor = marker.parentElement;
        while (commandAncestor && commandAncestor !== block
            && !elementDeclaresInlineCommand(commandAncestor, command)) {
            commandAncestor = commandAncestor.parentElement;
        }
        if (!commandAncestor || commandAncestor === block) return marker;

        // marker 可能嵌在若干无关 span/a 中。逐层拆分这些中间节点，
        // 再拆分真正声明格式的祖先，使选区脱离其继承格式，同时保留
        // 选区前后两侧原有的 DOM 与样式。
        while (marker.parentElement && marker.parentElement !== commandAncestor) {
            splitElementAroundChild(marker.parentElement, marker);
        }
        if (marker.parentElement === commandAncestor) {
            splitElementAroundChild(commandAncestor, marker);
        }
        return marker;
    }

    function removeInlineCommand(command, preferSaved = false) {
        if (preferSaved) restoreSavedSelection();
        const sourceRange = selectedRange(preferSaved);
        if (!sourceRange || sourceRange.collapsed) return false;
        const targetBlocks = state.explicitBlockSelection
            ? blocksForIds()
            : editableBlocksForRange(sourceRange);
        const ranges = targetBlocks.map((block) => {
            if (state.explicitBlockSelection) {
                const range = document.createRange();
                range.selectNodeContents(block);
                return range;
            }
            return rangeWithinBlock(sourceRange, block);
        }).filter(Boolean);
        if (!ranges.length) return false;

        const markers = [];
        [...ranges].reverse().forEach((range) => {
            const marker = document.createElement('span');
            marker.dataset.vdocFormatRemoval = command;
            try {
                range.surroundContents(marker);
            } catch {
                marker.appendChild(range.extractContents());
                range.insertNode(marker);
            }
            markers.unshift(marker);
        });

        const insertedBoundaries = markers.map((marker, index) => {
            const block = targetBlocks[index]
                || marker.closest('[data-vdoc-text]');

            // 导入内容可能同时使用语义标签与行内样式表达同一种格式。
            // 持续向外拆分，直到选区不再继承任何一层同类格式。
            while (marker.parentElement && marker.parentElement !== block) {
                const previousParent = marker.parentElement;
                liftMarkerOutsideInlineCommand(marker, command, block);
                if (marker.parentElement === previousParent) break;
            }

            removeInlineCommandFromFragment(marker, command);
            const first = marker.firstChild;
            const last = marker.lastChild;
            if (!first || !last) {
                marker.remove();
                return null;
            }
            marker.replaceWith(...marker.childNodes);
            return { first, last };
        }).filter(Boolean);
        if (!insertedBoundaries.length) return false;

        const nextRange = document.createRange();
        nextRange.setStartBefore(insertedBoundaries[0].first);
        nextRange.setEndAfter(insertedBoundaries[insertedBoundaries.length - 1].last);
        state.selectionRange = nextRange.cloneRange();
        state.selectionText = nextRange.toString();
        state.selectionBlockIds = editableBlocksForRange(nextRange)
            .map((block) => block.dataset.vdocText)
            .filter(Boolean);
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(nextRange);

        queueRenderedNodesUpdate(targetBlocks);
        markDirty({ coalesce: true });
        scheduleFormattingControls(insertedBoundaries[0].first);
        return true;
    }

    function applyInlineCommand(command, preferSaved = false) {
        const styles = {
            bold: ['fontWeight', '700'],
            italic: ['fontStyle', 'italic'],
            underline: ['textDecorationLine', 'underline'],
            strikethrough: ['textDecorationLine', 'line-through'],
        };
        const style = styles[command];
        if (!style) return false;
        return selectionHasInlineCommand(command, preferSaved)
            ? removeInlineCommand(command, preferSaved)
            : applyInlineStyle(style[0], style[1], preferSaved);
    }

    function placeCaretAtStart(element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(true);
        const selection = getRenderRoot()?.getSelection?.() || window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.focus();
    }

    function prepareEditableStructure(element) {
        const template = document.createElement('template');
        template.innerHTML = core.ensureTextNodeIds(element.outerHTML);
        const prepared = template.content.firstElementChild;
        prepared?.querySelectorAll?.(core.EDITABLE_SELECTOR).forEach((editable) => {
            editable.contentEditable = 'true';
            editable.spellcheck = false;
        });
        if (prepared?.matches?.(core.EDITABLE_SELECTOR)) {
            prepared.contentEditable = 'true';
            prepared.spellcheck = false;
        }
        return prepared;
    }

    function createEditableBlock(type = 'paragraph') {
        let element;
        if (/^heading-[1-6]$/.test(type)) {
            element = document.createElement(`h${type.slice(-1)}`);
        } else if (type === 'blockquote') {
            element = document.createElement('blockquote');
        } else if (type === 'table') {
            element = document.createElement('table');
            // 表格外观属于文档源码，而非编辑器运行时皮肤。行内声明使用户
            // 可以在 HTML 源码模式中直接二次修改，也会自然进入保存和导出结果。
            element.style.width = '100%';
            element.style.margin = '1em 0';
            element.style.border = '1px solid currentColor';
            element.style.borderCollapse = 'collapse';
            element.style.borderSpacing = '0';
            const tbody = document.createElement('tbody');
            for (let row = 0; row < 3; row += 1) {
                const tr = document.createElement('tr');
                for (let column = 0; column < 3; column += 1) {
                    const cell = document.createElement('td');
                    cell.style.minWidth = '2em';
                    cell.style.padding = '.45em .65em';
                    cell.style.border = '1px solid currentColor';
                    cell.style.textAlign = 'left';
                    cell.style.verticalAlign = 'top';
                    cell.textContent = row === 0 ? `标题 ${column + 1}` : '';
                    tr.appendChild(cell);
                }
                tbody.appendChild(tr);
            }
            element.appendChild(tbody);
            return prepareEditableStructure(element);
        } else {
            element = document.createElement('p');
        }
        element.innerHTML = '<br>';
        return prepareEditableStructure(element);
    }

    function createTextBlockAtBlankPoint(event) {
        // 流式正文只能通过 Source Buffer 修改；渲染 DOM 永远不是编辑真源。
        if (!isSlideDeck() || !state.ready || state.mode !== 'render'
            || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
            return false;
        }
        const root = getRenderRoot();
        const target = event.target;
        if (!root || !target?.matches?.(
            '.vdoc-flow-runtime, [data-vdoc-preserve="true"]'
        )) {
            return false;
        }

        const container = target.matches('[data-vdoc-preserve="true"]')
            ? target
            : root.querySelector('[data-vdoc-preserve="true"]');
        if (!container) return false;

        flushPendingRenderedEdits();
        const blocks = allRenderedTextBlocks().filter((block) => container.contains(block));
        let anchor = null;
        let position = 'after';
        if (blocks.length) {
            anchor = blocks.reduce((closest, candidate) => {
                const rect = candidate.getBoundingClientRect();
                const distance = event.clientY < rect.top
                    ? rect.top - event.clientY
                    : event.clientY > rect.bottom
                        ? event.clientY - rect.bottom
                        : 0;
                return !closest || distance < closest.distance
                    ? { block: candidate, rect, distance }
                    : closest;
            }, null);
            position = event.clientY < anchor.rect.top + anchor.rect.height / 2
                ? 'before'
                : 'after';
        }

        event.preventDefault();
        if (state.explicitBlockSelection) clearExplicitBlockSelection();
        const paragraph = createEditableBlock('paragraph');
        if (anchor?.block?.parentElement) {
            if (position === 'before') anchor.block.before(paragraph);
            else anchor.block.after(paragraph);
        } else {
            container.appendChild(paragraph);
        }
        state.renderedTextBlocks = [];
        insertSourceBlockRelativeTo(
            blockIdentityOf(anchor?.block),
            paragraph,
            position
        );
        state.activeEditableBlock = paragraph;
        state.blockSelectionAnchorId = paragraph.dataset.vdocText;
        placeCaretAtStart(paragraph);
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        return true;
    }

    function insertStructureBlock(type = elements['block-type-select']?.value || 'paragraph') {
        if (!state.ready || state.mode !== 'render') return false;
        if (!isSlideDeck()) {
            return insertHybridSourceFragment(
                hybridStructureSource(type),
                { afterRegion: true }
            );
        }
        flushPendingRenderedEdits();
        const root = getRenderRoot();
        const current = state.activeEditableBlock && root.contains(state.activeEditableBlock)
            ? state.activeEditableBlock
            : root.querySelector('[data-vdoc-block]:last-of-type');
        const block = createEditableBlock(type);
        const anchor = current?.closest?.('table, [data-vdoc-block]') || current;
        const parent = anchor?.parentElement
            || root.querySelector('[data-vdoc-preserve="true"]')
            || root.querySelector('.vdoc-flow-runtime');
        if (anchor?.parentElement) anchor.after(block);
        else parent.appendChild(block);
        state.renderedTextBlocks = [];

        // 只把这一个新建块写入源码。锚点及其它任何节点的源码形态保持原样，
        // 页内脚本对实时 DOM 的改动不会经由此路径进入文档真相。
        insertSourceBlockRelativeTo(blockIdentityOf(anchor), block, 'after');

        state.activeEditableBlock = block.matches('[data-vdoc-block]')
            ? block
            : block.querySelector('[data-vdoc-block]');
        const focusTarget = state.activeEditableBlock || block.querySelector('td, th');
        if (focusTarget) placeCaretAtStart(focusTarget);
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        return true;
    }

    // ── 定向源码写入 ──────────────────────────────────────────────
    //
    // 渲染树是源码的产物，不是源码的副本。页内脚本（Anime.js、Three.js、
    // 自定义交互等）会持续改写实时 DOM 的 style、class、data-* 和子节点，
    // 这些都属于运行时状态。因此编辑器绝不整树序列化渲染面。
    //
    // 人类在渲染面的能力被严格限定为：编辑文本块内容、增删文本块、
    // 调整块级格式。每一种都有明确锚点，下列函数只在源码中定位该锚点，
    // 并只改动那一处。任何未被显式编辑的节点，其源码形态原样保留。

    function withCurrentSourceDocument(mutate) {
        const template = document.createElement('template');
        template.innerHTML = currentSourceHtml();
        if (mutate(template.content) === false) return false;
        setCurrentSourceHtml(template.innerHTML);
        state.document.manifest.modifiedAt = new Date().toISOString();
        return true;
    }

    function sourceBlockById(fragment, blockId) {
        if (!blockId) return null;
        return fragment.querySelector(`[data-vdoc-text="${CSS.escape(blockId)}"]`)
            || fragment.querySelector(`[data-vdoc-block="${CSS.escape(blockId)}"]`);
    }

    function blockIdentityOf(renderedBlock) {
        return renderedBlock?.dataset?.vdocText
            || renderedBlock?.dataset?.vdocBlock
            || renderedBlock?.querySelector?.('[data-vdoc-text]')?.dataset?.vdocText
            || null;
    }

    function cleanBlockForSource(renderedBlock) {
        // 新建块由 createEditableBlock() 就地构造，尚未经过任何页面脚本，
        // 因此可以安全序列化。仅剥离编辑器自身附加的可编辑标记。
        const clone = renderedBlock.cloneNode(true);
        restoreMathSemantics(clone);
        clone.querySelectorAll('[data-vdoc-resource-src]').forEach((media) => {
            media.setAttribute('src', media.dataset.vdocResourceSrc);
            media.removeAttribute('data-vdoc-resource-src');
        });
        [clone, ...clone.querySelectorAll(
            '[contenteditable], [spellcheck], [data-vdoc-editor-selected]'
        )].forEach((node) => {
            node.removeAttribute?.('contenteditable');
            node.removeAttribute?.('spellcheck');
            node.removeAttribute?.('data-vdoc-editor-selected');
        });
        return clone;
    }

    function insertSourceBlockRelativeTo(anchorId, renderedBlock, position) {
        const prepared = cleanBlockForSource(renderedBlock);
        return withCurrentSourceDocument((fragment) => {
            const anchor = sourceBlockById(fragment, anchorId);
            if (anchor) {
                if (position === 'before') anchor.before(prepared);
                else anchor.after(prepared);
                return true;
            }
            // 没有锚点时只能追加到正文容器末尾。仍然是定向写入：
            // 只新增这一个节点，不触碰任何既有节点。
            const container = fragment.querySelector('[data-vdoc-preserve="true"]')
                || fragment.lastElementChild;
            if (!container) return false;
            container.appendChild(prepared);
            return true;
        });
    }

    function removeSourceBlock(blockId) {
        if (!blockId) return false;
        return withCurrentSourceDocument((fragment) => {
            const target = sourceBlockById(fragment, blockId);
            if (!target) return false;
            target.remove();
            return true;
        });
    }

    function removeSourceBlocks(blockIds) {
        const ids = [...new Set(blockIds.filter(Boolean))];
        if (!ids.length) return false;
        return withCurrentSourceDocument((fragment) => {
            let changed = false;
            ids.forEach((blockId) => {
                const target = sourceBlockById(fragment, blockId);
                if (!target) return;
                target.remove();
                changed = true;
            });
            return changed;
        });
    }

    function deleteExplicitBlockSelection() {
        if (!state.explicitBlockSelection) return false;
        const root = getRenderRoot();
        const selectedBlocks = blocksForIds().filter((block) =>
            block.matches('[data-vdoc-block][data-vdoc-removable="true"]')
        );
        if (!root || !selectedBlocks.length) return false;

        flushPendingRenderedEdits();
        const selectedSet = new Set(selectedBlocks);
        const orderedBlocks = allRenderedTextBlocks();
        const firstIndex = orderedBlocks.indexOf(selectedBlocks[0]);
        let target = null;
        for (let index = firstIndex - 1; index >= 0; index -= 1) {
            if (!selectedSet.has(orderedBlocks[index])) {
                target = orderedBlocks[index];
                break;
            }
        }
        if (!target) {
            target = orderedBlocks.find((block, index) =>
                index > firstIndex && !selectedSet.has(block)
            ) || null;
        }

        const removedIds = selectedBlocks.map(blockIdentityOf).filter(Boolean);
        removeSourceBlocks(removedIds);
        selectedBlocks.forEach((block) => {
            window.ScriptoriumPretext?.evictNode(block.dataset.vdocText);
            block.remove();
        });
        state.renderedTextBlocks = [];
        state.explicitBlockSelection = false;
        state.selectionRange = null;
        state.selectionText = '';
        state.selectionBlockIds = [];
        state.blockSelectionAnchorId = null;
        currentRenderSelection()?.removeAllRanges();

        // 全文删除后仍保留一个可继续输入的段落。表格行等结构容器不接收
        // 非法的段落子节点，兜底段落只追加到正文级保留容器。
        if (!root.querySelector('[data-vdoc-text]')) {
            const paragraph = createEditableBlock('paragraph');
            const parent = root.querySelector(
                '[data-vdoc-preserve="true"]:not(table):not(thead):not(tbody):not(tfoot):not(tr):not(ul):not(ol)'
            ) || root.querySelector('.vdoc-flow-runtime, .vdoc-slide-editor-runtime');
            parent?.appendChild(paragraph);
            insertSourceBlockRelativeTo(null, paragraph, 'after');
            target = paragraph;
            state.renderedTextBlocks = [];
        }

        updateBlockSelectionPresentation();
        state.activeEditableBlock = target?.isConnected ? target : null;
        if (state.activeEditableBlock) {
            focusRenderedBlock(state.activeEditableBlock.dataset.vdocText);
        }
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        showToast(`已删除 ${removedIds.length} 个文本块`, 'success');
        return true;
    }

    function focusRenderedBlock(focusNodeId) {
        const target = focusNodeId
            ? getRenderRoot()?.querySelector(`[data-vdoc-text="${CSS.escape(focusNodeId)}"]`)
            : state.activeEditableBlock;
        if (!target) return;
        state.activeEditableBlock = target;
        placeCaretAtStart(target);
    }

    function caretIsAtBlockStart(selection, block) {
        if (!selection?.isCollapsed || !selection.rangeCount || !block) return false;
        const range = selection.getRangeAt(0);
        if (!block.contains(range.startContainer)) return false;
        const prefix = range.cloneRange();
        prefix.selectNodeContents(block);
        prefix.setEnd(range.startContainer, range.startOffset);
        return prefix.collapsed || prefix.toString().length === 0;
    }

    function insertParagraphBeforeBlock(block) {
        if (!block?.parentElement) return null;
        flushPendingRenderedEdits();
        const paragraph = createEditableBlock('paragraph');
        block.before(paragraph);
        state.renderedTextBlocks = [];
        insertSourceBlockRelativeTo(blockIdentityOf(block), paragraph, 'before');
        state.activeEditableBlock = paragraph;
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        placeCaretAtStart(paragraph);
        return paragraph;
    }

    function insertStableSoftBreak(range, selection, block) {
        // 新建文本块以单个 BR 作为空内容占位。输入第一行后，Chromium 可能
        // 保留这个尾部 BR；Range.insertNode() 还会在文本末尾分裂出空文本
        // 节点。若仅用 nextSibling 判断段尾，第一次 Enter 的光标就可能落在
        // “换行 BR / 空文本 / 原占位 BR”之间的歧义位置，看起来完全没换行。
        const trailingRange = range.cloneRange();
        try {
            trailingRange.setEnd(block, block.childNodes.length);
        } catch {
            trailingRange.selectNodeContents(block);
        }
        const trailingFragment = trailingRange.cloneContents();
        const trailingElements = [...trailingFragment.querySelectorAll('*')];
        const hasTrailingContent = Boolean(trailingFragment.textContent)
            || trailingElements.some((node) => node.tagName !== 'BR');

        const lineBreak = document.createElement('br');
        range.insertNode(lineBreak);

        // insertNode 在文本边界产生的零长度节点没有语义，却会让 Chromium
        // 无法稳定决定 BR 前后哪一行承载光标。
        while (lineBreak.nextSibling?.nodeType === Node.TEXT_NODE
            && lineBreak.nextSibling.nodeValue === '') {
            lineBreak.nextSibling.remove();
        }

        if (!hasTrailingContent) {
            // 光标后若只有旧的占位 BR，直接复用；否则建立一个明确占位。
            // 使用 setStartBefore 而非 setStartAfter(lineBreak)，把落点锚定到
            // 具体节点边界，保证新建块的第一次 Enter 也立即显示新行。
            let placeholder = lineBreak.nextSibling;
            if (placeholder?.nodeType !== Node.ELEMENT_NODE
                || placeholder.tagName !== 'BR') {
                placeholder = document.createElement('br');
                lineBreak.after(placeholder);
            }
            range.setStartBefore(placeholder);
        } else {
            range.setStartAfter(lineBreak);
        }
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return lineBreak;
    }

    function richClipboardPayload() {
        // copy/cut 事件触发时浏览器实时选区才是用户当前意图。不能直接调用
        // selectedEditableBlocks()：显式块选择状态可能在浏览器已建立新 Range 后
        // 仍短暂残留，造成复制结果随此前是否用过全文/跨块选择而时好时坏。
        const selection = currentRenderSelection();
        const liveRange = selection?.rangeCount && !selection.isCollapsed
            ? selection.getRangeAt(0)
            : null;
        const root = getRenderRoot();
        const liveRangeInRoot = Boolean(
            liveRange && root?.contains(liveRange.commonAncestorContainer)
        );
        const explicitBlocks = state.explicitBlockSelection ? blocksForIds() : [];
        const explicitIds = new Set(explicitBlocks.map(blockIdentityOf).filter(Boolean));
        const liveBlocks = liveRangeInRoot ? editableBlocksForRange(liveRange) : [];
        const liveIds = new Set(liveBlocks.map(blockIdentityOf).filter(Boolean));

        // Shadow DOM 的 Selection 对“节点边界到节点边界”的跨块 Range 暴露并不
        // 稳定：焦点变化或原生 copy 分派期间，getSelection() 可能短暂折叠。
        // 显式多选因此以 selectionBlockIds 为权威；只有实时 Range 明确覆盖了
        // 另一组块时，才说明用户已切换到普通文字选区，不再使用旧多选。
        const liveSelectionDiffers = liveRangeInRoot
            && (liveIds.size !== explicitIds.size
                || [...liveIds].some((id) => !explicitIds.has(id)));
        const usesExplicitBlocks = explicitBlocks.length > 0 && !liveSelectionDiffers;
        const range = usesExplicitBlocks ? state.selectionRange : liveRange;
        const blocks = usesExplicitBlocks ? explicitBlocks : liveBlocks;
        if (!blocks.length || (!usesExplicitBlocks && !range)) return null;

        const fullBlocks = usesExplicitBlocks
            || blocks.every((block) => {
                const blockRange = document.createRange();
                blockRange.selectNodeContents(block);
                return range.toString().trim() === blockRange.toString().trim();
            });
        if (fullBlocks) {
            const clones = blocks.map((block) => cleanBlockForSource(block));
            return {
                html: clones.map((clone) => clone.outerHTML).join('\n'),
                text: blocks.map((block) => block.textContent || '').join('\n'),
            };
        }
        const fragment = range.cloneContents();
        restoreMathSemantics(fragment);
        fragment.querySelectorAll?.(
            '[contenteditable], [spellcheck], [data-vdoc-editor-selected]'
        ).forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
            node.removeAttribute('data-vdoc-editor-selected');
        });
        const container = document.createElement('div');
        container.appendChild(fragment);
        return {
            html: core.sanitizeHtml(container.innerHTML),
            text: range.toString(),
        };
    }

    function rememberRichClipboardPayload(payload) {
        if (!payload) return false;
        state.copiedRichHtml = String(payload.html || '');
        state.copiedPlainText = String(payload.text || '');
        return true;
    }

    async function writeRichClipboardPayload(payload, clipboardData = null) {
        if (!rememberRichClipboardPayload(payload)) return false;
        if (clipboardData) {
            clipboardData.setData('text/plain', state.copiedPlainText);
            clipboardData.setData('text/html', state.copiedRichHtml);
            return true;
        }

        try {
            if (navigator.clipboard?.write && typeof ClipboardItem === 'function') {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        'text/plain': new Blob(
                            [state.copiedPlainText],
                            { type: 'text/plain' }
                        ),
                        'text/html': new Blob(
                            [state.copiedRichHtml],
                            { type: 'text/html' }
                        ),
                    }),
                ]);
            } else if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(state.copiedPlainText);
            } else {
                throw new Error('当前环境未提供 Clipboard API');
            }
            return true;
        } catch (error) {
            // 内部富文本剪贴板已经写入，维持格式粘贴仍然可用。系统剪贴板
            // 失败不能反过来丢弃这份载荷，但需要明确告知用户降级状态。
            console.warn('[Scriptorium] System clipboard write failed:', error);
            showToast('已复制到 Scriptorium 内部剪贴板；系统剪贴板写入受限。', 'info');
            return true;
        }
    }

    function deleteTextRangeSelection(range = selectedRange(true)) {
        if (!range || range.collapsed) return false;
        const blocks = editableBlocksForRange(range);
        if (!blocks.length) return false;
        const selection = currentRenderSelection();
        try {
            range.deleteContents();
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        } catch {
            return false;
        }

        state.explicitBlockSelection = false;
        state.selectionRange = range.cloneRange();
        state.selectionText = '';
        state.selectionBlockIds = [];
        state.activeEditableBlock = blocks.find((block) => block.isConnected) || null;
        blocks.filter((block) => block.isConnected).forEach((block) => {
            queueRenderedNodeUpdate(block);
            window.ScriptoriumPretext?.evictNode(block.dataset.vdocText);
        });
        updateBlockSelectionPresentation();
        state.activeEditableBlock?.focus?.();
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        return true;
    }

    function deleteClipboardSelection() {
        if (state.explicitBlockSelection) return deleteExplicitBlockSelection();
        return deleteTextRangeSelection();
    }

    async function runClipboardCommand(action, options = {}) {
        if (state.mode !== 'render') return false;
        const payload = richClipboardPayload();
        if (!payload) {
            if (!options.silent) showToast('当前没有可复制的文字或文本块。');
            return false;
        }
        const written = await writeRichClipboardPayload(payload, options.clipboardData);
        if (!written) return false;
        if (action === 'cut' && !deleteClipboardSelection()) return false;
        if (!options.silent) {
            const count = state.explicitBlockSelection
                ? state.selectionBlockIds.length
                : editableBlocksForRange(selectedRange(true)).length;
            showToast(`${action === 'cut' ? '已剪切' : '已复制'}${
                count > 1 ? ` · ${count} 个文本块` : ''
            }`, 'success');
        }
        return true;
    }

    function prepareRichClipboardBlocks(html) {
        const template = document.createElement('template');
        template.innerHTML = core.sanitizeHtml(String(html || ''));
        const editables = [...template.content.querySelectorAll(core.EDITABLE_SELECTOR)];
        const topLevel = editables.filter((node) =>
            !node.parentElement?.closest?.(core.EDITABLE_SELECTOR)
        );
        if (!topLevel.length) return [];

        topLevel.forEach((block) => {
            [block, ...block.querySelectorAll('*')].forEach((node) => {
                node.removeAttribute?.('contenteditable');
                node.removeAttribute?.('spellcheck');
                node.removeAttribute?.('data-vdoc-editor-selected');
                node.removeAttribute?.('data-vdoc-text');
                node.removeAttribute?.('data-vdoc-block');
                node.removeAttribute?.('data-vdoc-container');
                node.removeAttribute?.('data-vdoc-preserve');
                node.removeAttribute?.('data-vdoc-removable');
            });
        });

        const normalized = core.ensureTextNodeIds(
            topLevel.map((block) => block.outerHTML).join('')
        );
        const prepared = document.createElement('template');
        prepared.innerHTML = normalized;
        return [...prepared.content.children].map((block) => {
            block.querySelectorAll?.(core.EDITABLE_SELECTOR).forEach((editable) => {
                editable.contentEditable = 'true';
                editable.spellcheck = false;
            });
            if (block.matches?.(core.EDITABLE_SELECTOR)) {
                block.contentEditable = 'true';
                block.spellcheck = false;
            }
            return block;
        });
    }

    function insertFormattedClipboardAtContext(html) {
        const blocks = prepareRichClipboardBlocks(html);
        if (!blocks.length) return false;
        flushPendingRenderedEdits();

        const root = getRenderRoot();
        let anchor = state.textContextBlock;
        if (!anchor?.isConnected || !root?.contains(anchor)) {
            anchor = nearestTextBlockForPoint(state.textContextPoint);
        }
        const parent = anchor?.parentElement
            || root?.querySelector('[data-vdoc-preserve="true"]')
            || root?.querySelector('.vdoc-flow-runtime, .vdoc-slide-editor-runtime');
        if (!parent) return false;

        let anchorId = blockIdentityOf(anchor);
        blocks.forEach((block) => {
            if (anchor?.parentElement) anchor.after(block);
            else parent.appendChild(block);
            insertSourceBlockRelativeTo(anchorId, block, 'after');
            anchor = block;
            anchorId = blockIdentityOf(block);
        });

        state.renderedTextBlocks = [];
        state.activeEditableBlock = blocks[blocks.length - 1];
        state.blockSelectionAnchorId = blockIdentityOf(state.activeEditableBlock);
        placeCaretAtStart(state.activeEditableBlock);
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
        renderOutline();
        return true;
    }

    function insertPlainTextAtCurrentSelection(block, text) {
        const selection = currentRenderSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !block?.contains(range.commonAncestorContainer)) return false;

        range.deleteContents();
        const fragment = document.createDocumentFragment();
        let lastNode = null;
        String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
            if (index) {
                lastNode = document.createElement('br');
                fragment.appendChild(lastNode);
            }
            if (line) {
                lastNode = document.createTextNode(line);
                fragment.appendChild(lastNode);
            }
        });
        if (!lastNode) {
            lastNode = document.createTextNode('');
            fragment.appendChild(lastNode);
        }
        range.insertNode(fragment);
        range.setStartAfter(lastNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        block.focus();
        return true;
    }

    function insertSoftBreakAtCurrentSelection(block) {
        const selection = currentRenderSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !block?.contains(range.commonAncestorContainer)) return false;

        range.deleteContents();
        insertStableSoftBreak(range, selection, block);
        queueRenderedNodeUpdate(block);
        window.ScriptoriumPretext?.evictNode(block.dataset.vdocText);
        state.activeEditableBlock = block;
        markDirty({ coalesce: true });
        return true;
    }

    function handleBlockEditingKeydown(event) {
        const editable = event.target.closest?.('[data-vdoc-text]');
        const selection = getRenderRoot()?.getSelection?.() || window.getSelection();

        // keyCode 229 兼容部分 Chromium/Windows 输入法未正确暴露
        // KeyboardEvent.isComposing 的情况。不能 preventDefault，否则会阻止
        // 候选词上屏。也不能等待 compositionend：部分 Windows 输入法会将
        // 该事件延后数百毫秒。候选词提交和 input 默认动作会在浏览器进入
        // 下一渲染帧前完成，因此直接在下一帧以提交后的光标补执行换行。
        if (event.key === 'Enter' && editable
            && (event.isComposing || event.keyCode === 229)) {
            const block = editable.closest?.(
                '[data-vdoc-block][data-vdoc-removable="true"]'
            ) || editable;
            state.compositionEnterTarget = block;
            if (state.compositionEnterFrame !== null) {
                window.cancelAnimationFrame(state.compositionEnterFrame);
            }
            state.compositionEnterFrame = window.requestAnimationFrame(() => {
                state.compositionEnterFrame = null;
                const target = state.compositionEnterTarget;
                state.compositionEnterTarget = null;
                if (target?.isConnected) insertSoftBreakAtCurrentSelection(target);
            });
            return;
        }

        if (event.key === 'Backspace' && state.explicitBlockSelection) {
            event.preventDefault();
            deleteExplicitBlockSelection();
            return;
        }

        if (event.key === 'Tab' && editable && selection?.isCollapsed && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            const prefix = range.cloneRange();
            prefix.selectNodeContents(editable);
            prefix.setEnd(range.startContainer, range.startOffset);

            // 光标前没有内容或只有 DOCX 遗留的 Tab/空格时，都仍属于首行头部。
            // 先移除这些可能被 HTML 折叠的隐藏空白，再规范化为两个全角空格，
            // 避免原始 Tab 导致浏览器执行焦点导航，或重复叠加多份缩进。
            if (/^[\s\u00a0\u3000]*$/u.test(prefix.toString())) {
                event.preventDefault();
                prefix.deleteContents();
                const indentation = document.createTextNode('\u3000\u3000');
                range.insertNode(indentation);
                range.setStartAfter(indentation);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                queueRenderedNodeUpdate(editable);
                state.activeEditableBlock = editable;
                markDirty({ coalesce: true });
                return;
            }
        }

        const block = event.target.closest?.('[data-vdoc-block][data-vdoc-removable="true"]');
        if (!block) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();

            // 某些输入法在 compositionend 后还会为同一次物理按键派发普通
            // Enter。若延迟换行尚未执行，则由本次 keydown 接管，避免双换行。
            if (state.compositionEnterFrame !== null) {
                window.cancelAnimationFrame(state.compositionEnterFrame);
                state.compositionEnterFrame = null;
                state.compositionEnterTarget = null;
            }

            // 在块的绝对开头按 Enter，表示在当前块上方创建一个新段落。
            // 这为文档/Scene 的首块提供稳定的“向前插入”入口；其他位置
            // 仍沿用块内软换行，Shift+Enter 则继续在下方新增结构块。
            if (caretIsAtBlockStart(selection, block)) {
                insertParagraphBeforeBlock(block);
                return;
            }

            // Enter 必须以当前光标为准。当前选区折叠时不能回退到此前保存的
            // 全文/跨块范围，否则一次回车可能误删整个旧选区。
            insertSoftBreakAtCurrentSelection(block);
            return;
        }
        if (event.key === 'Enter' && event.shiftKey && block.tagName !== 'TD' && block.tagName !== 'TH') {
            event.preventDefault();
            flushPendingRenderedEdits();
            const next = createEditableBlock('paragraph');
            block.after(next);
            state.renderedTextBlocks = [];
            const nextId = next.dataset.vdocText
                || next.querySelector('[data-vdoc-text]')?.dataset.vdocText;
            insertSourceBlockRelativeTo(blockIdentityOf(block), next, 'after');
            state.activeEditableBlock = next;
            focusRenderedBlock(nextId);
            markDirty({ coalesce: true });
            scheduleEditSnapshot();
            return;
        }

        const isEmpty = !(block.textContent || '').trim() && !block.querySelector('[data-vdoc-math], img');
        if (event.key !== 'Backspace' || !isEmpty || !selection?.isCollapsed) return;

        flushPendingRenderedEdits();
        const parent = block.parentElement;
        const removedId = blockIdentityOf(block);
        let target = block.previousElementSibling || block.nextElementSibling;
        event.preventDefault();
        block.remove();
        state.renderedTextBlocks = [];
        removeSourceBlock(removedId);

        if (parent?.matches('[data-vdoc-preserve="true"]')
            && !parent.querySelector('[data-vdoc-block], table')) {
            target = createEditableBlock('paragraph');
            parent.appendChild(target);
            insertSourceBlockRelativeTo(null, target, 'after');
        }

        target = target?.matches?.('[data-vdoc-block]')
            ? target
            : target?.querySelector?.('[data-vdoc-block]') || getRenderRoot().querySelector('[data-vdoc-block]');
        state.activeEditableBlock = target || null;
        focusRenderedBlock(target?.dataset?.vdocText);
        markDirty({ coalesce: true });
        scheduleEditSnapshot();
    }

    function decodeMathSource(node) {
        try {
            return decodeURIComponent(node.dataset.vdocMath || '');
        } catch {
            return node.dataset.vdocMath || node.textContent || '';
        }
    }

    function restoreMathSemantics(root) {
        root.querySelectorAll?.('[data-vdoc-math]').forEach((node) => {
            node.replaceChildren(document.createTextNode(decodeMathSource(node)));
            node.removeAttribute('aria-hidden');
        });
        return root;
    }

    function renderMathNodes(root) {
        root.querySelectorAll('[data-vdoc-math]').forEach((node) => {
            const latex = decodeMathSource(node);
            node.contentEditable = 'false';
            node.setAttribute('aria-label', latex);
            if (!window.katex?.render) {
                node.textContent = latex;
                return;
            }
            try {
                window.katex.render(latex, node, {
                    displayMode: node.dataset.vdocDisplay === 'true',
                    throwOnError: false,
                    strict: false,
                    trust: false,
                    output: 'htmlAndMathml',
                });
            } catch (error) {
                node.textContent = latex;
                node.dataset.vdocMathError = error.message;
            }
        });
    }

    function decodeMermaidSource(node) {
        try {
            return decodeURIComponent(node.dataset.vdocMermaid || '');
        } catch {
            return node.dataset.vdocMermaid || node.textContent || '';
        }
    }

    async function renderMermaidNodes(root) {
        const nodes = [...root.querySelectorAll('[data-vdoc-mermaid]')]
            .filter((node) =>
                node.dataset.vdocMermaidRendered !== 'true'
                && node.dataset.vdocMermaidRendering !== 'true'
            );
        if (!nodes.length) return [];
        if (!window.mermaid?.render) {
            console.warn('[Scriptorium] Mermaid renderer is unavailable.');
            return [];
        }

        window.mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'neutral',
        });

        return Promise.all(nodes.map(async (node) => {
            const source = decodeMermaidSource(node);
            const renderId = `vdoc-mermaid-${Date.now().toString(36)}-${
                state.mermaidRenderSequence += 1
            }`;
            node.dataset.vdocMermaidRendering = 'true';
            node.removeAttribute('data-vdoc-mermaid-error');

            try {
                const result = await window.mermaid.render(renderId, source);
                const svg = typeof result === 'string' ? result : result?.svg;
                if (!svg) throw new Error('Mermaid 没有返回 SVG 产物。');

                const template = document.createElement('template');
                template.innerHTML = String(svg).trim();
                const svgNode = template.content.querySelector('svg');
                if (!svgNode) throw new Error('Mermaid 返回结果中不存在 SVG 根。');

                svgNode.setAttribute('role', 'img');
                svgNode.setAttribute('aria-label', 'Mermaid 图表');
                svgNode.style.maxWidth = '100%';
                svgNode.style.height = 'auto';
                node.replaceChildren(svgNode);
                node.dataset.vdocMermaidRendered = 'true';
                if (typeof result?.bindFunctions === 'function') {
                    result.bindFunctions(node);
                }
                return node;
            } catch (error) {
                node.dataset.vdocMermaidError = error.message;
                node.replaceChildren(Object.assign(document.createElement('pre'), {
                    className: 'vdoc-mermaid-source',
                    textContent: source,
                }));
                console.warn(
                    `[Scriptorium] Mermaid block ${renderId} compile failed:`,
                    error
                );
                return null;
            } finally {
                node.removeAttribute('data-vdoc-mermaid-rendering');
            }
        }));
    }

    function semanticInnerHtml(renderedNode) {
        // 只序列化文本块内部内容。块自身的属性由定向写入路径单独维护，
        // 页内脚本对宿主节点属性的改动因此无法进入源码。
        const clone = renderedNode.cloneNode(true);
        restoreMathSemantics(clone);
        clone.querySelectorAll('[contenteditable], [spellcheck]').forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
        });
        return core.sanitizeHtml(clone.innerHTML);
    }

    function updateSourceNodes(renderedNodes, attributesById = new Map()) {
        const nodes = [...new Map(renderedNodes
            .filter((node) => node?.dataset?.vdocText)
            .map((node) => [node.dataset.vdocText, node])).values()];
        if (!nodes.length) return false;
        const template = document.createElement('template');
        template.innerHTML = currentSourceHtml();
        let changed = false;
        nodes.forEach((renderedNode) => {
            const nodeId = renderedNode.dataset.vdocText;
            const target = template.content.querySelector(
                `[data-vdoc-text="${CSS.escape(nodeId)}"]`
            );
            if (!target) return;

            const html = semanticInnerHtml(renderedNode);
            if (target.innerHTML !== html) {
                target.innerHTML = html;
                changed = true;
            }

            (attributesById.get(nodeId) || []).forEach((attribute) => {
                const nextValue = attribute === 'class'
                    ? renderedNode.className
                    : renderedNode.getAttribute(attribute);
                const currentValue = attribute === 'class'
                    ? target.className
                    : target.getAttribute(attribute);
                if (nextValue === currentValue) return;
                if (nextValue === null || nextValue === '') {
                    target.removeAttribute(attribute);
                } else if (attribute === 'class') {
                    target.className = nextValue;
                } else {
                    target.setAttribute(attribute, nextValue);
                }
                changed = true;
            });
        });
        if (!changed) return false;
        setCurrentSourceHtml(template.innerHTML);
        state.document.manifest.modifiedAt = new Date().toISOString();
        return true;
    }

    function flushPendingRenderedEdits() {
        window.clearTimeout(state.renderUpdateTimer);
        state.renderUpdateTimer = null;
        if (!isSlideDeck()) {
            state.pendingRenderedNodes.clear();
            state.pendingRenderedAttributes.clear();
            return false;
        }
        if (!state.pendingRenderedNodes.size) return false;
        const nodes = [...state.pendingRenderedNodes.values()];
        const attributes = new Map(state.pendingRenderedAttributes);
        state.pendingRenderedNodes.clear();
        state.pendingRenderedAttributes.clear();
        return updateSourceNodes(nodes, attributes);
    }

    function finalizeEditBurst() {
        window.clearTimeout(state.renderUpdateTimer);
        state.renderUpdateTimer = null;
        const sourceChanged = flushPendingRenderedEdits();
        const hadEditBurst = state.editBurstDirty;
        state.editBurstDirty = false;
        if (!sourceChanged && !hadEditBurst) return false;

        // 两秒内的文字输入、回车、格式和结构修改共同凝固为一个历史节点。
        // captureSnapshot 在这里且只在这里执行，因此一次撤销回退整个操作批次。
        captureSnapshot();
        renderOutline();
        scheduleMetrics();
        return true;
    }

    function queueRenderedNodesUpdate(renderedNodes, options = {}) {
        renderedNodes.forEach((node) => {
            const nodeId = node?.dataset?.vdocText;
            if (!nodeId) return;
            state.pendingRenderedNodes.set(nodeId, node);
            if (options.attributes?.length) {
                const attributes = state.pendingRenderedAttributes.get(nodeId) || new Set();
                options.attributes.forEach((attribute) => attributes.add(attribute));
                state.pendingRenderedAttributes.set(nodeId, attributes);
            }
        });
        window.clearTimeout(state.renderUpdateTimer);
        const delay = Number.isFinite(options.delay) ? options.delay : 2000;
        state.renderUpdateTimer = window.setTimeout(finalizeEditBurst, Math.max(0, delay));
    }

    function queueRenderedNodeUpdate(renderedNode, options = {}) {
        queueRenderedNodesUpdate([renderedNode], options);
    }

    function initializePageVisibility(root, renderHost = elements['read-host']) {
        state.pageObserver?.disconnect();
        state.pageObserver = window.ScriptoriumVisibility.observePages(root, renderHost, {
            selector: '.vdoc-page',
            rootMargin: '120% 0px',
        });
        updateCurrentPage(root, renderHost);
    }

    function activatePage(page) {
        if (page) window.ScriptoriumVisibility.resume(page);
    }

    function updateCurrentPage(root, host = elements['read-host']) {
        const pages = [...root.querySelectorAll('.vdoc-page')];
        if (!pages.length) {
            elements['page-status'].textContent = state.mode === 'render'
                ? '连续编辑'
                : '第 — 页 / 共 — 页';
            return;
        }
        const hostRect = host.getBoundingClientRect();
        let current = 0;
        let distance = Infinity;
        pages.forEach((page, index) => {
            const rect = page.getBoundingClientRect();
            const nextDistance = Math.abs(rect.top - hostRect.top);
            if (nextDistance < distance) {
                current = index;
                distance = nextDistance;
            }
        });
        elements['page-status'].textContent = `第 ${pages.length ? current + 1 : '—'} 页 / 共 ${pages.length || '—'} 页`;

        // 放映预览只运行当前可见页的交互脚本。翻到另一页时停止旧页
        // Canvas/RAF/定时器，再启动新页；缩略图仍保持静态冻结。
        if (
            state.mode === 'read'
            && isSlideDeck()
            && current !== state.activeSlideIndex
        ) {
            state.activeSlideIndex = current;
            window.requestAnimationFrame(() => {
                if (state.mode === 'read' && state.activeSlideIndex === current) {
                    activateCurrentSlideRuntime('read');
                }
            });
        }
    }

    function getSourceValue() {
        return sourceEditorController.getValue();
    }

    function setSourceValue(value) {
        return sourceEditorController.setValue(value);
    }

    function validateSource() {
        return sourceEditorController.validate();
    }

    function clearFindPresentation() {
        if (window.CSS?.highlights) {
            CSS.highlights.delete('scriptorium-find-match');
            CSS.highlights.delete('scriptorium-find-current');
        }
        state.findSourceMarks.forEach((mark) => mark.clear?.());
        state.findSourceMarks = [];
    }

    function findSurfaceRoot() {
        if (state.mode === 'read') return getReadRoot();
        if (state.mode === 'render') return getRenderRoot();
        return null;
    }

    function findScopeLabel() {
        if (state.mode === 'html') {
            return isSlideDeck() ? 'HTML 源码' : '混合源码';
        }
        if (state.mode === 'css') return 'CSS 源码';
        if (state.mode === 'read') return '预览文字';
        return '文稿文字';
    }

    function setFindStatus(message, empty = false) {
        elements['find-status'].textContent = message;
        elements['find-status'].classList.toggle('empty', empty);
        const available = state.findMatches.length > 0;
        elements['find-previous-btn'].disabled = !available;
        elements['find-next-btn'].disabled = !available;
    }

    function textNodesForFind(root) {
        const runtime = root?.querySelector('.vdoc-runtime');
        if (!runtime) return [];
        const nodes = [];
        const walker = document.createTreeWalker(runtime, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent || parent.closest(
                    'style, script, noscript, [data-vdoc-object-resize-handle],'
                    + '[data-vdoc-md-live-preview]'
                )) {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        });
        for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
        return nodes;
    }

    function renderedFindMatches(query) {
        const root = findSurfaceRoot();
        if (!root) return [];
        if (state.mode === 'read') {
            root.querySelectorAll('.vdoc-page[data-runtime-state="tombstone"]')
                .forEach(activatePage);
        }
        const nodes = textNodesForFind(root);
        const segments = [];
        let text = '';
        let previousBlock = null;
        nodes.forEach((node) => {
            const block = node.parentElement?.closest?.('[data-vdoc-text]') || null;
            if (text && block !== previousBlock) text += '\n';
            const start = text.length;
            text += node.nodeValue;
            segments.push({ node, start, end: text.length });
            previousBlock = block;
        });
        const normalizedText = text.toLocaleLowerCase();
        const normalizedQuery = query.toLocaleLowerCase();
        const matches = [];
        let offset = 0;
        while (normalizedQuery && (offset = normalizedText.indexOf(normalizedQuery, offset)) >= 0) {
            const endOffset = offset + normalizedQuery.length;
            const startSegment = segments.find((segment) =>
                offset >= segment.start && offset < segment.end
            );
            const endSegment = [...segments].reverse().find((segment) =>
                endOffset > segment.start && endOffset <= segment.end
            );
            if (startSegment && endSegment) {
                const range = document.createRange();
                range.setStart(startSegment.node, offset - startSegment.start);
                range.setEnd(endSegment.node, endOffset - endSegment.start);
                matches.push({ type: 'rendered', range });
            }
            offset = Math.max(endOffset, offset + 1);
        }
        return matches;
    }

    function sourceFindMatches(query) {
        const source = getSourceValue();
        const normalizedSource = source.toLocaleLowerCase();
        const normalizedQuery = query.toLocaleLowerCase();
        const matches = [];
        let offset = 0;
        while (normalizedQuery && (offset = normalizedSource.indexOf(normalizedQuery, offset)) >= 0) {
            matches.push({
                type: 'source',
                fromIndex: offset,
                toIndex: offset + normalizedQuery.length,
            });
            offset = Math.max(offset + normalizedQuery.length, offset + 1);
        }
        return matches;
    }

    function presentRenderedFindMatches() {
        if (!window.CSS?.highlights || typeof window.Highlight !== 'function') return;
        const ranges = state.findMatches.map((match) => match.range);
        const current = ranges[state.findIndex];
        CSS.highlights.set(
            'scriptorium-find-match',
            new Highlight(...ranges.filter((range) => range !== current))
        );
        CSS.highlights.set(
            'scriptorium-find-current',
            new Highlight(...(current ? [current] : []))
        );
    }

    function presentSourceFindMatches() {
        const editor = state.sourceEditor;
        if (!editor) return;
        state.findSourceMarks = state.findMatches.map((match, index) =>
            editor.markText(
                editor.posFromIndex(match.fromIndex),
                editor.posFromIndex(match.toIndex),
                {
                    className: index === state.findIndex
                        ? 'cm-vdoc-find-current'
                        : 'cm-vdoc-find-match',
                }
            )
        );
    }

    function revealFindMatch() {
        clearFindPresentation();
        const match = state.findMatches[state.findIndex];
        if (!match) return false;
        if (match.type === 'source') {
            presentSourceFindMatches();
            const editor = state.sourceEditor;
            const from = editor.posFromIndex(match.fromIndex);
            const to = editor.posFromIndex(match.toIndex);
            editor.setSelection(from, to);
            editor.scrollIntoView({ from, to }, 90);
        } else {
            presentRenderedFindMatches();
            const target = match.range.startContainer.parentElement;
            target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
        setFindStatus(`${state.findIndex + 1} / ${state.findMatches.length}`);
        return true;
    }

    function refreshFindResults(options = {}) {
        if (!elements['find-panel'] || elements['find-panel'].hidden) return false;
        const query = String(elements['find-input'].value || '');
        clearFindPresentation();
        state.findQuery = query;
        state.findMatches = [];
        state.findIndex = -1;
        elements['find-scope'].textContent = findScopeLabel();
        elements['find-input'].placeholder =
            state.mode === 'html' || state.mode === 'css' ? '查找源码' : '查找文字';
        if (!query) {
            setFindStatus('输入以查找');
            return false;
        }
        state.findMatches = state.mode === 'html' || state.mode === 'css'
            ? sourceFindMatches(query)
            : renderedFindMatches(query);
        if (!state.findMatches.length) {
            setFindStatus('无匹配', true);
            return false;
        }
        state.findIndex = options.preserveIndex
            ? Math.min(Math.max(0, options.index ?? 0), state.findMatches.length - 1)
            : 0;
        return revealFindMatch();
    }

    function moveFindMatch(direction = 1) {
        if (!state.findMatches.length) return refreshFindResults();
        state.findIndex = (
            state.findIndex + direction + state.findMatches.length
        ) % state.findMatches.length;
        return revealFindMatch();
    }

    function openFindPanel() {
        if (!state.ready) return false;
        elements['find-panel'].hidden = false;
        elements['find-scope'].textContent = findScopeLabel();
        elements['find-input'].placeholder =
            state.mode === 'html' || state.mode === 'css' ? '查找源码' : '查找文字';
        refreshFindResults();
        elements['find-input'].focus();
        elements['find-input'].select();
        return true;
    }

    function closeFindPanel() {
        if (!elements['find-panel'] || elements['find-panel'].hidden) return false;
        clearFindPresentation();
        elements['find-panel'].hidden = true;
        state.findMatches = [];
        state.findIndex = -1;
        if (state.mode === 'html' || state.mode === 'css') state.sourceEditor?.focus();
        return true;
    }

    function refreshSourceColorMarks() {
        return sourceEditorController.refreshColorMarks();
    }

    function replaceSourceColor(value) {
        return sourceEditorController.replaceColor(value);
    }

    function formatSource() {
        return sourceEditorController.format();
    }

    function initializeSourceEditor() {
        return sourceEditorController.initialize();
    }

    function safelyCaptureModeViewportAnchor(mode) {
        try {
            return typeof captureModeViewportAnchor === 'function'
                ? captureModeViewportAnchor(mode)
                : null;
        } catch (error) {
            console.warn(
                '[Scriptorium] 视口语义锚点捕获失败，模式切换将不恢复位置：',
                error
            );
            return null;
        }
    }

    function safelyRestoreModeViewportAnchor(mode, anchor) {
        if (!anchor) return false;
        try {
            return typeof restoreModeViewportAnchor === 'function'
                ? restoreModeViewportAnchor(mode, anchor)
                : false;
        } catch (error) {
            console.warn(
                '[Scriptorium] 视口语义锚点恢复失败，已保留目标模式：',
                error
            );
            return false;
        }
    }

    function switchMode(mode) {
        if (!state.ready) return;
        const previousMode = state.mode;
        // 位置同步是非关键增强。任何锚点算法异常都不得阻断模式切换、
        // 源码缓冲区初始化、编辑器刷新或可编程内容生命周期。
        const viewportAnchor = safelyCaptureModeViewportAnchor(previousMode);
        if (state.mode === 'render' && mode !== 'render') {
            state.objectController?.closeInspector(true);
            state.objectController?.clearSelection();
            finalizeEditBurst();
        }
        disposeSlideRuntime();
        const isRender = mode === 'render';
        const isRead = mode === 'read';
        const isSource = mode === 'html' || mode === 'css';
        const leavingSource = (state.mode === 'html' || state.mode === 'css') && !isSource;

        if (leavingSource && applySourceChanges(false) === false) return;
        state.mode = mode;
        elements['render-host'].hidden = !isRender;
        elements['read-host'].hidden = !isRead;
        elements['source-host'].hidden = !isSource;

        for (const candidate of ['render', 'read', 'html', 'css']) {
            const button = elements[`${candidate}-mode-btn`];
            const active = candidate === mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }

        if (isRead) {
            renderReadingPreview();
            window.requestAnimationFrame(() => {
                safelyRestoreModeViewportAnchor('read', viewportAnchor);
                updateCurrentPage(getReadRoot(), elements['read-host']);
                if (state.mode === 'read') {
                    activateProgrammableContent('read');
                }
            });
        } else if (isRender) {
            window.requestAnimationFrame(() => {
                if (state.mode !== 'render') return;
                safelyRestoreModeViewportAnchor('render', viewportAnchor);
                activateProgrammableContent('render');

                // 从源码模式返回时，applySourceChanges() 会在 state.mode 仍为
                // html/css 的阶段重建渲染树，因此 renderDocument() 不会执行
                // 仅限 render 模式的运行态岛文字映射。岛脚本在这里重新生成
                // 动态表格后，必须再次为这些新节点建立映射和编辑能力。
                installRuntimeIslandTextEditing(getRenderRoot());
            });
            state.pageObserver?.disconnect();
            elements['page-status'].textContent = isSlideDeck()
                ? `第 ${state.activeSlideIndex + 1} 页 / 共 ${state.document.source.slides.length} 页`
                : '连续编辑';
        }

        if (isSource) {
            state.sourceMode = mode;
            elements['source-title'].textContent = mode === 'html'
                ? (isSlideDeck() ? '当前页完整源码' : 'Markdown-first 混合源码')
                : (isSlideDeck() ? '演示全局 CSS' : '文档全局 CSS');
            elements['source-description'].textContent = mode === 'html'
                ? (isSlideDeck()
                    ? '当前页的 <style>、HTML、依赖声明与交互脚本均在此编辑'
                    : 'Markdown、HTML 岛、LaTeX 与 Mermaid 原文是唯一正文真相')
                : (isSlideDeck()
                    ? '应用于全部页面和演示共享外观；页内样式请编辑当前页完整源码'
                    : '应用于整份文档的共享样式与 CSS 动画');
            sourceEditorController.configureMode(mode);
            if (mode === 'html') setCurrentSourceHtml(currentSourceHtml());
            setSourceValue(mode === 'html' ? currentSourceHtml() : currentSourceCss());
            window.setTimeout(() => {
                state.sourceEditor?.refresh();
                state.sourceEditor?.focus();
                validateSource();
                refreshSourceColorMarks();
                // focus 会把旧光标主动滚入视口，因此语义位置必须作为布局与
                // 聚焦完成后的最后一步恢复，不能在 focus 之前执行。
                window.requestAnimationFrame(() => {
                    if (state.mode !== mode) return;
                    safelyRestoreModeViewportAnchor(mode, viewportAnchor);
                });
            }, 0);
        }

        if (!elements['find-panel'].hidden) {
            window.setTimeout(refreshFindResults, isSource ? 0 : 1);
        }
    }

    function applySourceChanges(showSuccess = true) {
        if (!state.document || (state.mode !== 'html' && state.mode !== 'css')) return;
        if (!validateSource()) {
            showToast('源码检查未通过，请修正后再应用。', 'error');
            return false;
        }
        const source = getSourceValue();
        if (state.sourceMode === 'html') {
            if (isSlideDeck()) {
                const policy = window.ScriptoriumProgrammableContent;
                const normalized = policy?.normalizeHtmlDependencies
                    ? policy.normalizeHtmlDependencies(source, {
                        phase: 'human-source-apply',
                        documentKind: 'pptx',
                        slideIndex: state.activeSlideIndex,
                    })
                    : { html: source, dependencies: [], diagnostics: [] };
                setCurrentSourceHtml(normalized.html);
                state.document.manifest.programmableDependencies = [
                    ...new Set([
                        ...(state.document.manifest.programmableDependencies || []),
                        ...(normalized.dependencies || []),
                    ]),
                ];
                recordProgrammableDiagnostics(normalized.diagnostics || []);
            } else {
                // 流式正文严禁 HTML 归一化、格式化或依赖标签改写。
                setCurrentSourceHtml(source);
                const compiled = parsedDocument(true);
                recordProgrammableDiagnostics(compiled.diagnostics || []);
            }
            setSourceValue(currentSourceHtml());
        } else {
            setCurrentSourceCss(source);
            setSourceValue(currentSourceCss());
        }
        renderDocument();
        captureSnapshot();
        markDirty();
        if (showSuccess) showToast('源码已应用到渲染页面', 'success');
    }

    function executeCommand(command, value, preferSaved = false) {
        if (command === 'undo') return restoreHistory(-1);
        if (command === 'redo') return restoreHistory(1);
        if (state.mode !== 'render') return false;
        if (!isSlideDeck()) {
            if (command === 'image') return insertMedia();
            return executeHybridFormattingCommand(command, value);
        }
        if (['bold', 'italic', 'underline', 'strikethrough'].includes(command)) {
            return applyInlineCommand(command, preferSaved);
        }
        if (command === 'font-family') return applyInlineStyle('fontFamily', value, preferSaved);
        if (command === 'font-size') return applyInlineStyle('fontSize', value, preferSaved);
        if (command === 'text-color') return applyInlineStyle('color', value, preferSaved);
        if (command === 'highlight-color') return applyInlineStyle('backgroundColor', value, preferSaved);
        if (command === 'line-height') {
            const blocks = selectedEditableBlocks(preferSaved);
            if (!blocks.length) return false;
            blocks.forEach((block) => {
                block.style.lineHeight = String(value);
            });
            queueRenderedNodesUpdate(blocks, { attributes: ['style'] });
            markDirty({ coalesce: true });
            scheduleFormattingControls(blocks[0]);
            return true;
        }
        if (command === 'text-align') {
            const blocks = selectedEditableBlocks(preferSaved);
            if (!blocks.length) return false;
            blocks.forEach((block) => {
                block.style.textAlign = value;
            });
            queueRenderedNodesUpdate(blocks, { attributes: ['style'] });
            markDirty({ coalesce: true });
            scheduleFormattingControls(blocks[0]);
            return true;
        }
        if (command === 'image') return insertMedia();
        return false;
    }

    function scheduleEditSnapshot(delay = 2000) {
        window.clearTimeout(state.renderUpdateTimer);
        state.renderUpdateTimer = window.setTimeout(finalizeEditBurst, delay);
    }

    function syncRenderedDocumentToSource(renderedNodes = allRenderedTextBlocks(), options = {}) {
        queueRenderedNodesUpdate(renderedNodes, options);
        state.document.manifest.styleDependencies = [...state.usedAdvancedStyleIds];
        state.document.manifest.embeddedStyles = [...state.usedAdvancedStyleIds]
            .map((styleId) => styleLibrary.get(styleId))
            .filter(Boolean);
        markDirty({ coalesce: true });
    }

    function inferMediaKind(src) {
        const normalized = String(src || '').trim().toLowerCase();
        const dataType = normalized.match(/^data:(image|video|audio)\//)?.[1];
        if (dataType) return dataType;
        const pathname = normalized.split(/[?#]/, 1)[0];
        if (/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|tiff?)$/i.test(pathname)) {
            return 'image';
        }
        if (/\.(?:m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i.test(pathname)) {
            return 'video';
        }
        if (/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba|wma)$/i.test(pathname)) {
            return 'audio';
        }
        return '';
    }

    function mediaNameFromSrc(src) {
        try {
            const pathname = new URL(src, location.href).pathname;
            return decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
        } catch {
            return String(src || '').split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] || '';
        }
    }

    function formatMediaDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '';
        const milliseconds = Math.round(seconds * 1000);
        const hours = Math.floor(milliseconds / 3600000);
        const minutes = Math.floor((milliseconds % 3600000) / 60000);
        const wholeSeconds = Math.floor((milliseconds % 60000) / 1000);
        const fraction = milliseconds % 1000;
        const clock = [
            ...(hours ? [String(hours).padStart(2, '0')] : []),
            String(minutes).padStart(2, '0'),
            String(wholeSeconds).padStart(2, '0'),
        ].join(':');
        return `${clock}.${String(fraction).padStart(3, '0')}`;
    }

    function readMediaMetadata(kind, src, timeout = 15000) {
        return new Promise((resolve) => {
            const media = kind === 'image'
                ? new Image()
                : document.createElement(kind);
            let settled = false;
            const finish = (metadata) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                media.removeAttribute?.('src');
                media.load?.();
                resolve(metadata);
            };
            const timer = window.setTimeout(() => finish({ available: false }), timeout);

            if (kind === 'image') {
                media.onload = () => finish({
                    available: true,
                    width: media.naturalWidth,
                    height: media.naturalHeight,
                });
                media.onerror = () => finish({ available: false });
            } else {
                media.preload = 'metadata';
                media.onloadedmetadata = () => finish({
                    available: true,
                    width: kind === 'video' ? media.videoWidth : null,
                    height: kind === 'video' ? media.videoHeight : null,
                    duration: Number.isFinite(media.duration) ? media.duration : null,
                });
                media.onerror = () => finish({ available: false });
            }
            media.src = src;
        });
    }

    function createMediaFigure(kind, src, metadata, description, sourceInfo = {}) {
        const figure = document.createElement('figure');
        figure.className = 'vdoc-media';
        figure.dataset.vdocMedia = kind;
        if (!src.startsWith('data:')) figure.dataset.vdocSrc = src;
        figure.dataset.vdocSourceKind = src.startsWith(containerModule.RESOURCE_SCHEME)
            ? 'embedded-resource'
            : 'external-src';
        if (sourceInfo.name) figure.dataset.vdocSourceName = sourceInfo.name;
        if (sourceInfo.type) figure.dataset.vdocSourceType = sourceInfo.type;
        if (Number.isFinite(sourceInfo.size)) {
            figure.dataset.vdocSourceSize = String(sourceInfo.size);
        }
        figure.style.margin = '1em auto';
        figure.style.textAlign = 'center';

        const media = document.createElement(kind === 'image' ? 'img' : kind);
        const internalResource = src.startsWith(containerModule.RESOURCE_SCHEME);
        if (internalResource) {
            media.dataset.vdocResourceSrc = src;
            media.src = resolveRuntimeResources(src);
        } else {
            media.src = src;
        }
        media.dataset.vdocMediaSource = 'src';
        media.style.display = 'block';
        media.style.margin = '0 auto';
        media.style.maxWidth = '100%';
        if (kind !== 'audio') media.style.height = 'auto';
        if (kind === 'image') {
            media.alt = description;
            media.loading = 'lazy';
            media.decoding = 'async';
        } else {
            media.controls = true;
            media.preload = 'metadata';
            media.setAttribute('aria-label', description);
        }

        const nativeWidth = Number(metadata.width);
        const nativeHeight = Number(metadata.height);
        if (nativeWidth > 0 && nativeHeight > 0) {
            media.width = nativeWidth;
            media.height = nativeHeight;
            figure.dataset.vdocNativeWidth = String(nativeWidth);
            figure.dataset.vdocNativeHeight = String(nativeHeight);
        }
        if (kind === 'audio') {
            media.style.width = 'min(100%, 640px)';
        }

        const duration = Number(metadata.duration);
        const durationText = formatMediaDuration(duration);
        if (Number.isFinite(duration) && duration >= 0) {
            figure.dataset.vdocDuration = String(Math.round(duration * 1000) / 1000);
            figure.dataset.vdocDurationText = durationText;
            media.dataset.vdocDuration = figure.dataset.vdocDuration;
        }

        const nativeFacts = [];
        if (nativeWidth > 0 && nativeHeight > 0) {
            nativeFacts.push(`原生分辨率 ${nativeWidth} × ${nativeHeight} px`);
        }
        if (durationText) {
            nativeFacts.push(`原生时长 ${durationText}（${figure.dataset.vdocDuration} 秒）`);
        }
        if (!metadata.available) nativeFacts.push('原生元数据未能读取');
        const nativeDescription = [
            kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频',
            description,
            ...nativeFacts,
        ].filter(Boolean).join('；');
        // description 保存人类输入的内容语义；data-vdoc-description 则补充
        // 分辨率、时长等机器探测结果，AI 可分别读取原始描述和完整媒体信息。
        figure.setAttribute('description', description);
        figure.dataset.vdocDescription = nativeDescription;
        figure.setAttribute('aria-label', nativeDescription);
        media.setAttribute('description', description);
        media.dataset.vdocDescription = nativeDescription;
        media.title = nativeDescription;

        const caption = document.createElement('figcaption');
        caption.textContent = description;
        caption.style.marginTop = '.5em';
        caption.style.fontSize = '.875em';
        caption.style.opacity = '.72';
        figure.append(media, caption);
        // 单项媒体由 insertVisualObject() 转换为视觉对象。批量插入时这些
        // figure 会先进入统一媒体组，不能提前变成 absolute 的 PPT 子对象，
        // 否则组内所有媒体会重叠在同一坐标。
        return figure;
    }

    function insertVisualObject(object) {
        if (!object) return false;
        if (!isSlideDeck()) {
            // 流式媒体与复杂组件作为正式 HTML 源码域插入 Source Buffer。
            // 只序列化新建且尚未执行脚本的节点，不读取或回写派生渲染 DOM。
            const prepared = cleanBlockForSource(object);
            return insertHybridSourceFragment(prepared.outerHTML);
        }
        flushPendingRenderedEdits();
        const root = getRenderRoot();
        if (!root) return false;
        objectModule?.normalizeObjectNode(object, true);

        if (isSlideDeck()) {
            const scene = root.querySelector(
                '.vdoc-slide-editor-runtime > .vdoc-slide-scene,'
                + '.vdoc-slide-editor-runtime > [data-vdoc-slide]'
            ) || root.querySelector('.vdoc-slide-editor-runtime');
            if (!scene) return false;
            scene.appendChild(object);
            const prepared = cleanBlockForSource(object);
            const inserted = withCurrentSourceDocument((fragment) => {
                const sourceScene = fragment.querySelector(
                    '.vdoc-slide-scene, [data-vdoc-slide]'
                ) || fragment.firstElementChild;
                if (!sourceScene) return false;
                sourceScene.appendChild(prepared);
                return true;
            });
            if (!inserted) {
                object.remove();
                return false;
            }
        } else {
            const current = state.activeEditableBlock
                && root.contains(state.activeEditableBlock)
                ? state.activeEditableBlock
                : root.querySelector('[data-vdoc-block]:last-of-type');
            const anchor = current?.closest?.('table, [data-vdoc-block]') || current;
            const parent = anchor?.parentElement
                || root.querySelector('[data-vdoc-preserve="true"]')
                || root.querySelector('.vdoc-flow-runtime');
            if (!parent) return false;
            if (anchor?.parentElement) anchor.after(object);
            else parent.appendChild(object);
            if (!insertSourceBlockRelativeTo(blockIdentityOf(anchor), object, 'after')) {
                object.remove();
                return false;
            }
        }

        markDirty();
        captureSnapshot();
        renderDocument();
        const objectId = object.dataset.vdocObjectId;
        const rendered = objectId
            ? getRenderRoot()?.querySelector(
                `[data-vdoc-object-id="${CSS.escape(objectId)}"]`
            )
            : null;
        if (rendered) state.objectController?.select(rendered);
        return true;
    }

    function commitVisualObjectMutation(mutation) {
        if (!state.document || !mutation?.objectId) return false;
        finalizeEditBurst();
        const result = objectModule.applyMutationToSource(
            currentSourceHtml(),
            mutation,
            isSlideDeck()
        );
        if (!result.changed) return false;
        setCurrentSourceHtml(result.source);
        state.previewRevision = -1;
        state.previewResult = null;
        markDirty();
        captureSnapshot();
        renderDocument();
        if (mutation.type !== 'delete') {
            const rendered = getRenderRoot()?.querySelector(
                `[data-vdoc-object-id="${CSS.escape(mutation.objectId)}"]`
            );
            if (rendered) state.objectController?.select(rendered);
        }
        return true;
    }

    function insertMediaFigure(figure) {
        return insertVisualObject(figure);
    }

    function mediaKindForFile(file) {
        const mimeKind = String(file?.type || '').match(/^(image|video|audio)\//)?.[1];
        return mimeKind || inferMediaKind(file?.name || '');
    }

    function formatFileSize(bytes) {
        const size = Number(bytes) || 0;
        if (size < 1024) return `${size} B`;
        if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / 1024 ** 2).toFixed(1)} MB`;
    }

    function syncMediaInputMode() {
        const localMode = state.mediaLocalItems.length > 0;
        elements['media-src-fields'].hidden = localMode;
        elements['media-src-input'].disabled = localMode;
        elements['media-kind-select'].disabled = localMode;
        elements['media-description-input'].disabled = localMode;
        elements['media-local-list'].querySelectorAll('textarea, button').forEach((control) => {
            control.disabled = elements['media-insert-btn'].disabled;
        });
    }

    function renderMediaLocalItems() {
        const list = elements['media-local-list'];
        const items = state.mediaLocalItems;
        list.hidden = !items.length;
        elements['media-local-count'].textContent = items.length
            ? `已选择 ${items.length} 个文件`
            : '尚未选择本地文件';
        list.replaceChildren(...items.map((item, index) => {
            const card = document.createElement('article');
            card.className = 'media-local-item';
            const kind = document.createElement('span');
            kind.className = 'media-local-kind';
            kind.textContent = item.kind === 'image' ? '图片'
                : item.kind === 'video' ? '视频' : '音频';
            const meta = document.createElement('div');
            meta.className = 'media-local-meta';
            const name = document.createElement('strong');
            name.textContent = item.file.name;
            const details = document.createElement('small');
            details.textContent = `${item.file.type || '未知 MIME'} · ${formatFileSize(item.file.size)}`;
            meta.append(name, details);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'media-local-remove';
            remove.textContent = '×';
            remove.title = `移除 ${item.file.name}`;
            remove.addEventListener('click', () => {
                state.mediaLocalItems.splice(index, 1);
                renderMediaLocalItems();
            });
            const description = document.createElement('textarea');
            description.className = 'media-local-description';
            description.placeholder = `描述“${item.file.name}”的实际内容，供 AI 理解`;
            description.value = item.description;
            description.dataset.mediaLocalId = item.id;
            description.addEventListener('input', () => {
                item.description = description.value;
            });
            card.append(kind, meta, remove, description);
            return card;
        }));
        elements['media-insert-btn'].textContent = items.length
            ? `读取信息并批量插入（${items.length}）`
            : '读取信息并插入';
        syncMediaInputMode();
    }

    function selectLocalMediaFiles(files) {
        const accepted = [...(files || [])].map((file, index) => ({
            id: `local-media-${Date.now()}-${index}`,
            file,
            kind: mediaKindForFile(file),
            description: '',
        })).filter((item) => ['image', 'video', 'audio'].includes(item.kind));
        state.mediaLocalItems = accepted;
        renderMediaLocalItems();
        if (!accepted.length && files?.length) {
            setMediaDialogStatus('所选文件中没有可识别的图片、视频或音频。', 'error');
        } else if (accepted.length) {
            setMediaDialogStatus(
                `已载入 ${accepted.length} 个本地媒体；请逐一填写 description 后批量插入。`
            );
        }
    }

    function setMediaDialogStatus(message, type = '') {
        const status = elements['media-dialog-status'];
        status.textContent = message;
        status.classList.toggle('loading', type === 'loading');
        status.classList.toggle('error', type === 'error');
    }

    function closeMediaDialog() {
        elements['media-dialog'].hidden = true;
        elements['media-insert-btn'].disabled = false;
        elements['media-cancel-btn'].disabled = false;
        elements['media-src-input'].disabled = false;
        elements['media-kind-select'].disabled = false;
        elements['media-description-input'].disabled = false;
        state.mediaLocalItems = [];
        elements['media-local-input'].value = '';
        renderMediaLocalItems();
        setMediaDialogStatus('等待输入媒体地址或选择本地文件');
    }

    function insertMedia() {
        if (!state.ready || state.mode !== 'render') {
            showToast('请先打开文档并切换到连续编辑模式。');
            return false;
        }
        elements['media-form'].reset();
        state.mediaLocalItems = [];
        renderMediaLocalItems();
        setMediaDialogStatus('等待输入媒体地址或选择本地文件');
        elements['media-dialog'].hidden = false;
        window.setTimeout(() => elements['media-src-input'].focus(), 0);
        return true;
    }

    async function submitMediaInsertion(event) {
        event.preventDefault();
        const localItems = [...state.mediaLocalItems];
        const normalizedSrc = elements['media-src-input'].value.trim();
        if (!localItems.length && !normalizedSrc) {
            setMediaDialogStatus('请选择本地媒体文件，或输入媒体 src 地址。', 'error');
            elements['media-src-input'].focus();
            return false;
        }

        const selectedKind = elements['media-kind-select'].value;
        const kind = selectedKind === 'auto'
            ? inferMediaKind(normalizedSrc)
            : selectedKind;
        if (!localItems.length && !['image', 'video', 'audio'].includes(kind)) {
            setMediaDialogStatus(
                '无法自动识别媒体类型，请在上方明确选择图片、视频或音频。',
                'error'
            );
            elements['media-kind-select'].focus();
            return false;
        }

        elements['media-insert-btn'].disabled = true;
        elements['media-cancel-btn'].disabled = true;
        elements['media-src-input'].disabled = true;
        elements['media-kind-select'].disabled = true;
        elements['media-description-input'].disabled = true;
        syncMediaInputMode();
        setMediaDialogStatus('正在读取原生分辨率与音视频时长…', 'loading');

        try {
            let insertedFigures = [];
            if (localItems.length) {
                const batch = document.createElement('section');
                batch.className = 'vdoc-media-batch';
                batch.dataset.vdocMediaBatch = String(localItems.length);
                batch.dataset.vdocObject = 'media-group';
                batch.dataset.vdocObjectName = `${localItems.length} 个媒体`;
                batch.style.textAlign = 'center';
                for (let index = 0; index < localItems.length; index += 1) {
                    const item = localItems[index];
                    setMediaDialogStatus(
                        `正在读取第 ${index + 1} / ${localItems.length} 个媒体：${item.file.name}`,
                        'loading'
                    );
                    const bytes = new Uint8Array(await item.file.arrayBuffer());
                    const probeUrl = URL.createObjectURL(new Blob(
                        [bytes],
                        { type: item.file.type || 'application/octet-stream' }
                    ));
                    let metadata;
                    try {
                        metadata = await readMediaMetadata(item.kind, probeUrl);
                    } finally {
                        URL.revokeObjectURL(probeUrl);
                    }
                    const description = item.description.trim() || item.file.name;
                    const resource = await containerModule.registerResource(
                        state.document,
                        state.documentResourceData,
                        {
                            bytes,
                            kind: 'media',
                            name: item.file.name,
                            mime: item.file.type,
                            description,
                            nativeWidth: metadata.width,
                            nativeHeight: metadata.height,
                            duration: metadata.duration,
                            durationText: formatMediaDuration(Number(metadata.duration)),
                        }
                    );
                    const resourceSrc = containerModule.resourceReference(resource);
                    const figure = createMediaFigure(
                        item.kind,
                        resourceSrc,
                        metadata,
                        description,
                        {
                            embedded: true,
                            name: item.file.name,
                            type: item.file.type,
                            size: item.file.size,
                        }
                    );
                    batch.appendChild(figure);
                    insertedFigures.push(figure);
                }
                if (!insertMediaFigure(batch)) insertedFigures = [];
            } else {
                const metadata = await readMediaMetadata(kind, normalizedSrc);
                const fallbackDescription = mediaNameFromSrc(normalizedSrc)
                    || (kind === 'image'
                        ? '插入的图片'
                        : kind === 'video'
                            ? '插入的视频'
                            : '插入的音频');
                const description = elements['media-description-input'].value.trim()
                    || fallbackDescription;
                const figure = createMediaFigure(
                    kind,
                    normalizedSrc,
                    metadata,
                    description
                );
                if (insertMediaFigure(figure)) insertedFigures = [figure];
            }
            if (!insertedFigures.length) {
                setMediaDialogStatus('当前页面没有可插入媒体的位置。', 'error');
                return false;
            }

            const summary = insertedFigures.length === 1
                ? insertedFigures[0].dataset.vdocDescription
                : `${insertedFigures.length} 个本地媒体，均已写入独立 description 与源信息`;
            closeMediaDialog();
            showToast(`已插入媒体 · ${summary}`, 'success', 5000);
            return true;
        } catch (error) {
            setMediaDialogStatus(`媒体插入失败：${error.message}`, 'error');
            return false;
        } finally {
            elements['media-insert-btn'].disabled = false;
            elements['media-cancel-btn'].disabled = false;
            syncMediaInputMode();
        }
    }

    function showSelectionBar() {
        const bar = elements['selection-format-bar'];
        bar.hidden = false;
        elements['text-context-menu']
            ?.querySelector('[data-format-separator]')
            ?.removeAttribute('hidden');
    }

    function hideSelectionBar() {
        elements['selection-format-bar'].hidden = true;
        elements['text-context-menu']
            ?.querySelector('[data-format-separator]')
            ?.setAttribute('hidden', '');
    }

    function hideTextContextMenu() {
        const menu = elements['text-context-menu'];
        if (menu) menu.hidden = true;
    }

    function nearestTextBlockForPoint(point = state.textContextPoint) {
        if (!point) return null;
        const blocks = allRenderedTextBlocks();
        return blocks.reduce((nearest, block) => {
            const rect = block.getBoundingClientRect();
            const distance = point.y < rect.top
                ? rect.top - point.y
                : point.y > rect.bottom
                    ? point.y - rect.bottom
                    : 0;
            return !nearest || distance < nearest.distance
                ? { block, distance }
                : nearest;
        }, null)?.block || null;
    }

    function showTextContextMenu(x, y, block = null, sourceEvent = null) {
        const menu = elements['text-context-menu'];
        if (!menu) return false;
        state.textContextBlock = block || nearestTextBlockForPoint({ x, y });
        state.textContextPoint = { x, y };
        const selection = currentRenderSelection();
        state.textContextRange = selection?.rangeCount
            ? selection.getRangeAt(0).cloneRange()
            : null;
        const hasSelection = Boolean(
            state.explicitBlockSelection
            || (selection?.rangeCount && !selection.isCollapsed)
        );
        menu.querySelectorAll('[data-requires-selection]').forEach((control) => {
            control.disabled = !hasSelection;
        });
        menu.querySelectorAll('[data-requires-block]').forEach((control) => {
            control.disabled = !state.textContextBlock;
        });
        if (hasSelection) showSelectionBar();
        else hideSelectionBar();
        menu.hidden = false;
        menu.style.left = '8px';
        menu.style.top = '8px';
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${
            Math.max(8, Math.min(innerWidth - rect.width - 8, x))
        }px`;
        menu.style.top = `${
            Math.max(8, Math.min(innerHeight - rect.height - 8, y))
        }px`;
        sourceEvent?.stopPropagation?.();
        return true;
    }

    async function plainTextFromClipboard() {
        try {
            return await navigator.clipboard.readText();
        } catch {
            return state.copiedPlainText || '';
        }
    }

    function restoreTextContextSelection() {
        const range = state.textContextRange;
        if (!range?.startContainer?.isConnected || !range?.endContainer?.isConnected) {
            return false;
        }
        const selection = currentRenderSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
    }

    async function runTextContextAction(action) {
        hideTextContextMenu();
        const block = state.textContextBlock;
        if (action === 'copy' || action === 'cut') {
            if (!state.explicitBlockSelection) restoreTextContextSelection();
            return runClipboardCommand(action);
        }
        if (action === 'select-all') return selectEntireRenderedDocument();
        if (action === 'select-block' && block) {
            return setExplicitBlockSelection([blockIdentityOf(block)]);
        }
        if (action === 'insert-paragraph') {
            const anchor = block || nearestTextBlockForPoint();
            if (anchor) return insertParagraphBeforeBlock(anchor);
            return insertStructureBlock('paragraph');
        }
        if (action === 'paste-formatted') {
            if (!state.copiedRichHtml) {
                showToast('剪贴板中没有可维持格式的 Scriptorium 元素。');
                return false;
            }
            return insertFormattedClipboardAtContext(state.copiedRichHtml);
        }
        if (action === 'paste') {
            const text = await plainTextFromClipboard();
            let target = block;
            if (!target) {
                const anchor = nearestTextBlockForPoint();
                target = anchor ? insertParagraphBeforeBlock(anchor) : null;
            }
            if (!target) return false;
            placeCaretAtStart(target);
            if (!insertPlainTextAtCurrentSelection(target, text)) return false;
            queueRenderedNodeUpdate(target);
            state.activeEditableBlock = target;
            markDirty({ coalesce: true });
            return true;
        }
        return false;
    }

    function inferSelectionTarget() {
        if (!isSlideDeck()) {
            const context = hybridDomEditingContext();
            if (!context) return 'inline';
            const startElement = context.range.startContainer.nodeType
                === Node.ELEMENT_NODE
                ? context.range.startContainer
                : context.range.startContainer.parentElement;
            const block = startElement?.closest?.(
                'h1,h2,h3,h4,h5,h6,p,blockquote,li,td,th'
            );
            if (/^H[1-6]$/.test(block?.tagName || '')) return 'heading';
            if (block && context.selected.trim() === block.textContent.trim()) {
                return 'paragraph';
            }
            return 'inline';
        }

        const range = state.selectionRange;
        const blocks = state.explicitBlockSelection
            ? blocksForIds()
            : editableBlocksForRange(range);
        if (blocks.length > 1) return 'block';
        const editable = blocks[0];
        if (/^H[1-6]$/.test(editable?.tagName || '')) return 'heading';
        if (editable && range?.toString().trim() === editable.textContent.trim()) {
            return 'paragraph';
        }
        return 'inline';
    }

    function openStyleLibrary() {
        if (!state.selectionRange) {
            showToast('请先选择一段文字。');
            return;
        }
        // 浮动格式条拥有独立的 fixed 层叠上下文。进入模态样式库前主动
        // 收起它，避免格式条悬浮在遮罩和对话框之上。
        hideSelectionBar();
        elements['style-library-dialog'].hidden = false;
        populateStyleCategories();
        renderStyleLibrary();
        const first = styleLibrary.list({ target: inferSelectionTarget() })[0]
            || styleLibrary.list({ target: 'inline' })[0];
        if (first) selectAdvancedStyle(first.id);
    }

    function closeStyleLibrary() {
        elements['style-library-dialog'].hidden = true;
    }

    function populateStyleCategories() {
        const previous = elements['style-category-select'].value;
        const options = [document.createElement('option')];
        options[0].value = '';
        options[0].textContent = '全部分类';
        styleLibrary.categories().forEach((category) => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            options.push(option);
        });
        elements['style-category-select'].replaceChildren(...options);
        if ([...elements['style-category-select'].options].some((option) => option.value === previous)) {
            elements['style-category-select'].value = previous;
        }
    }

    function renderStyleLibrary() {
        const inferredTarget = inferSelectionTarget();
        const styles = styleLibrary.list({
            query: elements['style-search-input'].value,
            category: elements['style-category-select'].value,
        }).filter((style) => style.targets.includes(inferredTarget)
            || style.targets.includes('inline')
            || (inferredTarget === 'heading' && style.targets.includes('block')));
        if (!styles.some((style) => style.id === state.selectedAdvancedStyleId)) {
            state.selectedAdvancedStyleId = null;
            elements['style-apply-btn'].disabled = true;
        }
        elements['style-library-list'].replaceChildren(...styles.map((style) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'style-card';
            button.classList.toggle('active', style.id === state.selectedAdvancedStyleId);
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(style.id === state.selectedAdvancedStyleId));
            const name = document.createElement('strong');
            name.textContent = style.name;
            const category = document.createElement('span');
            category.className = 'style-card-category';
            category.textContent = style.category;
            const description = document.createElement('p');
            description.textContent = style.description;
            const tags = document.createElement('div');
            tags.className = 'style-card-tags';
            tags.replaceChildren(...style.tags.slice(0, 4).map((tag) => {
                const chip = document.createElement('span');
                chip.textContent = tag;
                return chip;
            }));
            button.append(name, category, description, tags);
            button.addEventListener('click', () => selectAdvancedStyle(style.id));
            return button;
        }));
    }

    function selectAdvancedStyle(styleId) {
        const style = styleLibrary.get(styleId);
        if (!style) return;
        state.selectedAdvancedStyleId = style.id;
        renderStyleLibrary();
        elements['style-preview-category'].textContent = style.category;
        elements['style-preview-name'].textContent = style.name;
        elements['style-preview-description'].textContent = style.description;
        elements['style-preview-targets'].textContent = `适用：${style.targets.join(' / ')}`;
        elements['style-apply-btn'].disabled = false;
        renderStylePreview(style);
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function renderStylePreview(style) {
        const previousFrame = elements['style-preview-frame'];
        // Chromium 可能在 iframe 隐藏后复用相同 srcdoc 的浏览上下文，导致
        // 第二次打开模态窗时只剩空白画布。每轮预览使用全新的隔离 iframe，
        // 强制建立新的文档上下文，同时保留原节点的 class、sandbox 和标题。
        const frame = previousFrame.cloneNode(false);
        frame.removeAttribute('srcdoc');
        previousFrame.replaceWith(frame);
        elements['style-preview-frame'] = frame;
        try {
            const preview = styleLibrary.createPreviewDocument(style.id, {
                text: state.selectionText || style.previewText,
            });
            const tag = style.targets.includes('heading')
                ? 'h2'
                : style.targets.includes('paragraph')
                    ? 'p'
                    : style.targets.includes('block')
                        ? 'div'
                        : 'span';
            const previewText = (preview.text || style.previewText || '高级样式预览文字').slice(0, 1200);
            frame.srcdoc =
                `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;min-height:100%;background:#fffdf8;color:#202723}
body{display:grid;place-items:center;padding:34px;box-sizing:border-box;font-family:"Noto Serif CJK SC","Microsoft YaHei",serif;line-height:1.75}
body>*{max-width:100%;overflow-wrap:anywhere}
${preview.css}
</style></head><body><${tag} class="${escapeHtml(preview.className)}">${escapeHtml(previewText)}</${tag}></body></html>`;
        } catch (error) {
            frame.srcdoc = `<!doctype html><html lang="zh-CN"><body style="margin:0;display:grid;min-height:100vh;place-items:center;background:#fffdf8;color:#8b3d35;font:14px system-ui;padding:24px;box-sizing:border-box">预览生成失败：${escapeHtml(error.message)}</body></html>`;
            elements['style-apply-btn'].disabled = true;
            console.error('[Scriptorium] Advanced style preview failed:', error);
        }
    }

    function applySelectedAdvancedStyle() {
        const style = styleLibrary.get(state.selectedAdvancedStyleId);
        if (!style) return false;

        if (!isSlideDeck()) {
            const context = hybridDomEditingContext();
            if (!context) {
                showToast('当前选区无法应用高级样式。', 'error');
                return false;
            }

            const className = String(style.className || '')
                .replace(/[^a-zA-Z0-9_-]/g, '');
            if (!className) {
                showToast('高级样式缺少可用的语义类名。', 'error');
                return false;
            }

            const source = currentSourceHtml();
            const selectedSource = source.slice(
                context.sourceStart,
                context.sourceEnd
            );
            const open = `<span class="${escapeHtml(className)}" data-vdoc-style="${
                escapeHtml(style.id)
            }">`;
            if (!commitHybridDomSourcePatch(
                context,
                context.sourceStart,
                context.sourceEnd,
                `${open}${selectedSource}</span>`
            )) {
                return false;
            }

            state.usedAdvancedStyleIds.add(style.id);
            state.document.manifest.styleDependencies = [
                ...state.usedAdvancedStyleIds,
            ];
            state.document.manifest.embeddedStyles = [
                ...state.usedAdvancedStyleIds,
            ].map((styleId) => styleLibrary.get(styleId)).filter(Boolean);

            if (context.domain === 'markdown') {
                if (!patchHybridShellFromCompilation(
                    context.shell,
                    context.region.ordinal
                )) {
                    renderDocument();
                } else {
                    const nextRegion = hybridEditRegionByKey(
                        context.shell.dataset.vdocEditKey
                    );
                    if (nextRegion) {
                        restoreHybridEditableState(context.shell, nextRegion);
                    }
                    restoreHybridRenderedSelection(
                        context.shell,
                        context.renderedStart,
                        context.renderedEnd
                    );
                }
            } else {
                const wrapper = document.createElement('span');
                wrapper.className = className;
                wrapper.dataset.vdocStyle = style.id;
                try {
                    context.range.surroundContents(wrapper);
                } catch {
                    wrapper.appendChild(context.range.extractContents());
                    context.range.insertNode(wrapper);
                }

                const nextRange = document.createRange();
                nextRange.selectNodeContents(wrapper);
                const selection = currentRenderSelection();
                selection.removeAllRanges();
                selection.addRange(nextRange);
                state.selectionRange = nextRange.cloneRange();
                state.selectionText = nextRange.toString();

                const compiled = parsedDocument(true);
                const nextRegion = compiled.editRegions[context.region.ordinal];
                if (nextRegion) {
                    context.shell.dataset.vdocEditKey = nextRegion.key;
                    context.shell.dataset.vdocEditType = nextRegion.type;
                    restoreHybridEditableState(context.shell, nextRegion);
                    const session = state.hybridEditSessions.get(context.shell);
                    if (session) {
                        session.region = { ...nextRegion };
                        session.raw = currentSourceHtml().slice(
                            nextRegion.sourceRange.start,
                            nextRegion.sourceRange.end
                        );
                        session.previousText = context.shell.textContent || '';
                        session.revision = state.documentRevision;
                    }
                }
            }

            const rootStyle = getRenderRoot()?.querySelector('style');
            if (rootStyle) rootStyle.textContent = buildDocumentStyle();
            closeStyleLibrary();
            hideSelectionBar();
            scheduleEditSnapshot();
            showToast(`已应用高级样式 · ${style.name}`, 'success');
            return true;
        }

        const range = selectedRange(true);
        if (!style || !range) return false;
        const blocks = state.explicitBlockSelection ? blocksForIds() : editableBlocksForRange(range);
        if (!blocks.length) {
            showToast('当前选区无法应用高级样式。', 'error');
            return false;
        }

        const fullSingleBlock = blocks.length === 1
            && range.toString().trim() === blocks[0].textContent.trim();
        const useBlock = style.targets.includes('heading')
            || style.targets.includes('paragraph')
            || (style.targets.includes('block') && (blocks.length > 1 || fullSingleBlock));
        if (useBlock) {
            blocks.forEach((block) => {
                block.classList.add(style.className);
                block.dataset.vdocStyle = style.id;
            });
        } else {
            const wrappers = wrapSelectionRanges((wrapper) => {
                wrapper.className = style.className;
                wrapper.dataset.vdocStyle = style.id;
            }, true);
            if (!wrappers.length) {
                showToast('当前选区无法应用高级样式。', 'error');
                return false;
            }
        }

        state.usedAdvancedStyleIds.add(style.id);
        syncRenderedDocumentToSource(blocks, {
            attributes: useBlock ? ['class', 'data-vdoc-style'] : [],
        });
        const rootStyle = getRenderRoot()?.querySelector('style');
        if (rootStyle) rootStyle.textContent = buildDocumentStyle();
        closeStyleLibrary();
        hideSelectionBar();
        state.selectionRange = null;
        state.selectionBlockIds = [];
        state.explicitBlockSelection = false;
        updateBlockSelectionPresentation();
        showToast(`已应用高级样式 · ${style.name}${blocks.length > 1 ? ` · ${blocks.length} 个块` : ''}`, 'success');
        return true;
    }

    async function importStylePack(file) {
        if (!file) return;
        try {
            const pack = styleLibrary.parsePack(await file.text());
            const result = styleLibrary.registerPack(pack, { conflict: 'replace' });
            populateStyleCategories();
            renderStyleLibrary();
            showToast(`已导入 ${result.styles.length} 个高级样式`, 'success');
        } catch (error) {
            showToast(`样式包导入失败：${error.message}`, 'error', 5000);
        } finally {
            elements['style-import-input'].value = '';
        }
    }

    function exportStylePack() {
        try {
            const content = styleLibrary.serializePack(null, {
                id: `vcp.user.${Date.now().toString(36)}`,
                name: 'Scriptorium 高级样式集',
                author: 'Human + AI',
            });
            const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `scriptorium-styles-${new Date().toISOString().slice(0, 10)}.vstyle.json`;
            anchor.click();
            URL.revokeObjectURL(url);
            showToast('高级样式包已导出', 'success');
        } catch (error) {
            showToast(`样式包导出失败：${error.message}`, 'error');
        }
    }

    function renderOutline() {
        if (isSlideDeck()) {
            renderSlideNavigator();
            return;
        }
        elements['slide-navigator-header'].hidden = true;
        elements['slide-navigator'].hidden = true;
        document.querySelector('.outline-tabs').hidden = false;
        elements['outline-headings-view'].hidden = false;
        elements['outline-paragraphs-view'].hidden = true;
        const items = core.extractOutline(parsedDocument().html).map((item, index) => ({
            ...item,
            id: `runtime-outline-${index}`,
        }));
        const headings = items.filter((item) => item.kind === 'heading');
        const paragraphs = items.filter((item) => item.kind === 'paragraph' && item.text);
        elements['outline-count'].textContent = `${headings.length} 节`;
        elements['outline-tree'].replaceChildren(...headings.map(createOutlineItem));
        elements['paragraph-index'].replaceChildren(...paragraphs.map(createOutlineItem));
        elements['outline-empty'].hidden = items.length > 0;
        updateBlockSelectionPresentation();
    }

    function createOutlineItem(item) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = item.kind === 'heading' ? 'outline-item' : 'paragraph-item';
        button.dataset.vdocText = item.id;
        button.setAttribute('aria-selected', 'false');
        const label = document.createElement('span');
        label.className = item.kind === 'heading' ? 'outline-item-title' : 'paragraph-preview';
        label.textContent = item.text || '（空段落）';
        button.appendChild(label);
        button.style.setProperty('--outline-level', String(item.level || 1));
        button.addEventListener('click', (event) => {
            if (!isSlideDeck()) {
                const candidates = [...getRenderRoot()?.querySelectorAll(
                    core.EDITABLE_SELECTOR
                ) || []];
                candidates[item.ordinal]?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
                return;
            }
            const target = getRenderRoot()?.querySelector(
                `[data-vdoc-text="${CSS.escape(item.id)}"]`
            );
            if (!target) return;
            if (event.shiftKey && state.blockSelectionAnchorId) {
                selectBlockInterval(state.blockSelectionAnchorId, item.id);
            } else if (event.ctrlKey || event.metaKey) {
                toggleExplicitBlock(item.id);
            } else {
                state.blockSelectionAnchorId = item.id;
                setExplicitBlockSelection([item.id]);
            }
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return button;
    }

    function updateSlideThumbnailScale(host) {
        const stage = host?.shadowRoot?.querySelector('.slide-thumbnail-stage');
        if (!stage || !host.isConnected) return;
        const availableWidth = host.clientWidth;
        const baseWidth = stage.offsetWidth;
        const baseHeight = stage.offsetHeight;
        if (!availableWidth || !baseWidth || !baseHeight) return;
        const availableHeight = host.clientHeight;
        const scale = Math.min(availableWidth / baseWidth, availableHeight / baseHeight);
        stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }

    function createSlideThumbnail(slide) {
        const scene = core.createSceneConfig(state.document.manifest.scene);
        const host = document.createElement('span');
        host.className = 'slide-thumbnail-host';
        host.setAttribute('aria-hidden', 'true');

        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
:host {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    contain: strict;
    background: #fffdf8;
    pointer-events: none;
}
.slide-thumbnail-stage {
    position: absolute;
    top: 50%;
    left: 50%;
    width: ${scene.page.width};
    height: ${scene.page.height};
    overflow: hidden;
    color: #1d2421;
    background: #fffdf8;
    transform-origin: center;
    --vdoc-ink: #1d2421;
    --vdoc-muted: #66706b;
    --vdoc-paper: #fffdf8;
}
.slide-thumbnail-stage > .vdoc-slide-scene,
.slide-thumbnail-stage > [data-vdoc-slide] {
    width: 100%;
    height: 100%;
}
${resolveRuntimeResources(documentCssForShadow())}
${resolveRuntimeResources(parsedSlide(slide).css)}

/* 必须位于分页自定义 CSS 之后，保证预览始终冻结在初始帧。 */
.slide-thumbnail-stage *,
.slide-thumbnail-stage *::before,
.slide-thumbnail-stage *::after {
    animation: none !important;
    animation-play-state: paused !important;
    transition: none !important;
    caret-color: transparent !important;
}
svg animate,
svg animateMotion,
svg animateTransform,
svg set {
    display: none !important;
}
`;
        const stage = document.createElement('span');
        stage.className = 'slide-thumbnail-stage';
        stage.innerHTML = resolveRuntimeResources(parsedSlide(slide).html);
        root.append(style, stage);

        stage.querySelectorAll('[contenteditable]').forEach((node) =>
            node.removeAttribute('contenteditable')
        );
        stage.querySelectorAll('video, audio').forEach((media) => {
            media.removeAttribute('autoplay');
            media.removeAttribute('controls');
            try {
                media.pause();
                media.currentTime = 0;
            } catch {}
        });
        stage.querySelectorAll('svg').forEach((svg) => {
            try {
                svg.pauseAnimations?.();
                svg.setCurrentTime?.(0);
            } catch {}
        });
        renderMathNodes(root);
        window.requestAnimationFrame(() => updateSlideThumbnailScale(host));
        return host;
    }

    function renderSlideNavigator() {
        const slides = state.document?.source?.slides || [];
        elements['slide-navigator-header'].hidden = false;
        elements['slide-navigator'].hidden = false;
        elements['outline-headings-view'].hidden = true;
        elements['outline-paragraphs-view'].hidden = true;
        document.querySelector('.outline-tabs').hidden = true;
        elements['outline-empty'].hidden = true;
        elements['outline-count'].textContent = `${slides.length} 页`;
        elements['slide-count'].textContent = `${slides.length} 页`;
        elements['delete-slide-btn'].disabled = slides.length <= 1;
        elements['slide-navigator'].replaceChildren(...slides.map((slide, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'slide-nav-item';
            button.classList.toggle('active', index === state.activeSlideIndex);
            button.dataset.slideId = slide.id;

            const ordinal = document.createElement('span');
            ordinal.className = 'slide-nav-ordinal';
            ordinal.textContent = String(index + 1);

            const preview = document.createElement('span');
            preview.className = 'slide-nav-preview';
            const canvas = document.createElement('span');
            canvas.className = 'slide-nav-canvas';
            canvas.appendChild(createSlideThumbnail(slide));

            const title = document.createElement('span');
            title.className = 'slide-nav-title';
            const template = document.createElement('template');
            template.innerHTML = parsedSlide(slide).html;
            title.textContent = slide.name
                || template.content.textContent?.trim().slice(0, 42)
                || `第 ${index + 1} 页`;

            preview.append(canvas, title);
            button.append(ordinal, preview);
            button.addEventListener('click', () => selectSlide(index));
            return button;
        }));

        state.slideThumbnailObserver?.disconnect();
        state.slideThumbnailObserver = new ResizeObserver(() => {
            elements['slide-navigator'].querySelectorAll('.slide-thumbnail-host')
                .forEach(updateSlideThumbnailScale);
        });
        state.slideThumbnailObserver.observe(elements['slide-navigator']);
    }
    function selectSlide(index) {
        const slides = state.document?.source?.slides || [];
        if (!slides[index] || index === state.activeSlideIndex) return false;

        if (state.mode === 'render') {
            finalizeEditBurst();
        }

        // 切页是一个严格事务：源码编辑器中的缓冲区属于旧 activeSlide，
        // 必须在改变索引前提交。渲染面无需在此提交——文本、结构与格式
        // 编辑都已在各自事件中定向写入源码，切页不再触碰运行时 DOM。
        const sourceMode = state.mode === 'html' || state.mode === 'css';
        if (sourceMode && applySourceChanges(false) === false) return false;

        state.activeSlideIndex = index;
        state.activeEditableBlock = null;
        state.selectionRange = null;
        state.selectionText = '';
        state.selectionBlockIds = [];
        state.explicitBlockSelection = false;
        renderDocument();

        // 源码面切页后必须立即替换整个编辑缓冲区，不能让上一页内容
        // 在新 activeSlideIndex 下继续存在。
        if (sourceMode) refreshSourceEditorForActiveSlide();
        return true;
    }

    function refreshSourceEditorForActiveSlide() {
        if (state.mode !== 'html' && state.mode !== 'css') return;
        setSourceValue(state.sourceMode === 'html'
            ? currentSourceHtml()
            : currentSourceCss());
        window.clearTimeout(state.sourceEditorTimer);
        window.setTimeout(() => {
            state.sourceEditor?.refresh();
            validateSource();
            refreshSourceColorMarks();
        }, 0);
    }
    function commitActiveSlideBeforeNavigation() {
        if (state.mode === 'html' || state.mode === 'css') {
            return applySourceChanges(false) !== false;
        }
        finalizeEditBurst();
        return true;
    }

    function addSlide() {
        if (!isSlideDeck() || !commitActiveSlideBeforeNavigation()) return false;
        state.document.source.slides.push(
            core.createSlide({}, state.document.source.slides.length)
        );
        state.activeSlideIndex = state.document.source.slides.length - 1;
        state.activeEditableBlock = null;
        state.selectionRange = null;
        state.selectionText = '';
        state.selectionBlockIds = [];
        state.explicitBlockSelection = false;
        markDirty();
        captureSnapshot();
        renderDocument();
        refreshSourceEditorForActiveSlide();
        return true;
    }

    function deleteCurrentSlide() {
        if (!isSlideDeck()) return false;
        const slides = state.document.source.slides;
        if (slides.length <= 1) {
            showToast('演示至少需要保留一页。');
            return false;
        }
        if (!commitActiveSlideBeforeNavigation()) return false;
        slides.splice(state.activeSlideIndex, 1);
        state.activeSlideIndex = Math.min(state.activeSlideIndex, slides.length - 1);
        state.activeEditableBlock = null;
        state.selectionRange = null;
        state.selectionText = '';
        state.selectionBlockIds = [];
        state.explicitBlockSelection = false;
        markDirty();
        captureSnapshot();
        renderDocument();
        refreshSourceEditorForActiveSlide();
        return true;
    }

    function scheduleMetrics(immediate = false) {
        window.clearTimeout(state.metricsTimer);
        state.metricsTimer = window.setTimeout(updateMetrics, immediate ? 0 : 320);
    }

    function updateMetrics() {
        const template = document.createElement('template');
        template.innerHTML = isSlideDeck()
            ? state.document.source.slides
                .map((slide) => parsedSlide(slide).html)
                .join('\n')
            : parsedDocument().html;
        const text = template.content.textContent || '';
        const compact = text.replace(/\s/g, '');
        const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
        const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
        elements['word-count'].textContent = `${cjk + words} 字`;
        elements['character-count'].textContent = `${compact.length} 字符`;
    }

    function createEditor(documentModel = null, metadata = {}) {
        return sessionController.createEditor(documentModel, metadata);
    }

    function openResult(result, intent = null) {
        return sessionController.openResult(result, intent);
    }

    function chooseOpen() {
        return sessionController.chooseOpen();
    }

    function chooseImport() {
        return sessionController.chooseImport();
    }

    function openPath(filePath) {
        return sessionController.openPath(filePath);
    }

    function saveDocument(saveAs = false) {
        return sessionController.saveDocument(saveAs);
    }

    function persistCheckpointToFile(reason = '刻点') {
        return sessionController.persistCheckpoint(reason);
    }

    function requestUnsavedDecision(message) {
        return sessionController.requestUnsavedDecision(message);
    }

    function resolveUnsavedDecision(decision) {
        return sessionController.resolveUnsavedDecision(decision);
    }

    function runAfterUnsavedDecision(message, action) {
        return sessionController.runAfterUnsavedDecision(message, action);
    }

    function renderRecentDocuments() {
        return sessionController.renderRecentDocuments();
    }

    async function loadSystemFonts() {
        try {
            state.systemFonts = await api.listSystemFonts();
            const selects = [elements['font-family-select'], elements['selection-font-family']];
            selects.forEach((select) => {
                const options = state.systemFonts.map((font) => {
                    const option = document.createElement('option');
                    option.value = font;
                    option.textContent = font;
                    option.style.fontFamily = `"${font}"`;
                    return option;
                });
                select.replaceChildren(...options);
            });
            elements['font-status'].textContent = `${state.systemFonts.length} 种中日韩与系统字体可用`;
        } catch {
            elements['font-status'].textContent = '系统字体读取失败';
        }
    }

    function setSecurityReviewEnabled(enabled, options = {}) {
        const next = enabled !== false;
        state.securityReviewEnabled = next;
        window.ScriptoriumProgrammableContent?.setReviewEnabled(next);
        localStorage.setItem('scriptorium:security-review-enabled', String(next));
        const toggle = elements['security-review-toggle'];
        toggle.classList.toggle('disabled', !next);
        toggle.setAttribute('aria-pressed', String(next));
        toggle.title = next
            ? '安全审查已开启；点击可申请关闭'
            : '安全审查已关闭；点击立即重新开启';
        toggle.querySelector('span').textContent = next ? '安全审查' : '审查已关闭';
        if (!options.silent) {
            finalizeEditBurst();
            disposeSlideRuntime();
            renderDocument();
            showToast(
                next ? '可编程内容安全审查已重新开启' : '安全审查已关闭 · 高风险脚本允许执行',
                next ? 'success' : 'error',
                5000
            );
        }
        return next;
    }

    function restoreSecurityReviewConfig() {
        const stored = localStorage.getItem('scriptorium:security-review-enabled');
        setSecurityReviewEnabled(stored !== 'false', { silent: true });
    }

    function openSecurityReviewConfirmation() {
        if (!state.securityReviewEnabled) {
            setSecurityReviewEnabled(true);
            return;
        }
        elements['security-review-confirm-check'].checked = false;
        elements['security-review-disable-btn'].disabled = true;
        elements['security-review-dialog'].hidden = false;
        elements['security-review-confirm-check'].focus();
    }

    function closeSecurityReviewConfirmation() {
        elements['security-review-dialog'].hidden = true;
        elements['security-review-confirm-check'].checked = false;
        elements['security-review-disable-btn'].disabled = true;
    }

    function prOperationType(checkpoint) {
        return checkpoint?.proposal?.type || checkpoint?.operation?.type || '';
    }

    function programmableContentForPr(checkpoint) {
        return checkpoint?.proposal?.programmableContent || null;
    }

    function refuseDiagnosticsForPr(checkpoint) {
        const diagnostics = programmableContentForPr(checkpoint)?.diagnostics;
        return Array.isArray(diagnostics)
            ? diagnostics.filter((item) => item?.level === 'refuse')
            : [];
    }

    function hasRefuseRisk(checkpoint) {
        return programmableContentForPr(checkpoint)?.status === 'refuse'
            || refuseDiagnosticsForPr(checkpoint).length > 0;
    }

    function diagnosticLocation(item = {}) {
        const context = item.context && typeof item.context === 'object'
            ? item.context
            : {};
        const parts = [];
        const slideIndex = item.slideIndex ?? context.slideIndex;
        const replacementIndex = item.replacementIndex ?? context.replacementIndex;
        const scriptId = item.scriptId ?? context.scriptId;
        const phase = item.phase ?? context.phase;
        if (Number.isFinite(Number(slideIndex))) {
            parts.push(`第 ${Number(slideIndex) + 1} 页`);
        }
        if (Number.isFinite(Number(replacementIndex))) {
            parts.push(`替换片段 ${Number(replacementIndex) + 1}`);
        }
        if (scriptId) parts.push(`脚本 ${scriptId}`);
        if (phase) parts.push(`阶段 ${phase}`);
        return parts.join(' · ') || '位置未能精确定位';
    }

    function createPrRiskNotice(checkpoint, compact = false) {
        const diagnostics = refuseDiagnosticsForPr(checkpoint);
        if (!diagnostics.length) return null;
        const notice = document.createElement('section');
        notice.className = `pr-risk-notice${compact ? ' compact' : ''}`;
        const heading = document.createElement('strong');
        heading.textContent = compact
            ? `高风险提案 · ${diagnostics.length} 项 · 禁止自动批准`
            : `检测到 ${diagnostics.length} 项 refuse 级风险`;
        const explanation = document.createElement('p');
        explanation.textContent = compact
            ? '必须由人类打开审阅并手动决定。'
            : '自动批准已强制禁用。人类仍可合并源码，但命中规则的脚本会继续被 Scriptorium 运行时阻止执行。';
        const list = document.createElement('ul');
        diagnostics.forEach((item) => {
            const entry = document.createElement('li');
            const rule = document.createElement('code');
            rule.textContent = item.ruleId || 'unknown-rule';
            const message = document.createElement('span');
            message.textContent = item.message || '未提供风险说明';
            const location = document.createElement('small');
            location.textContent = diagnosticLocation(item);
            entry.append(rule, message, location);
            list.appendChild(entry);
        });
        notice.append(heading, explanation, list);
        return notice;
    }

    function autoApprovalConfig() {
        const enabled = elements['auto-approval-enabled']?.checked === true;
        const allowedTypes = new Set([
            ...(elements['auto-approval-types']?.querySelectorAll('input:checked') || []),
        ].map((input) => input.value));
        return { enabled, allowedTypes };
    }

    function saveAutoApprovalConfig() {
        const config = autoApprovalConfig();
        localStorage.setItem('scriptorium:auto-approval', JSON.stringify({
            enabled: config.enabled,
            allowedTypes: [...config.allowedTypes],
        }));
    }

    function restoreAutoApprovalConfig() {
        try {
            const stored = JSON.parse(localStorage.getItem('scriptorium:auto-approval') || '{}');
            elements['auto-approval-enabled'].checked = stored.enabled === true;
            const allowed = new Set(Array.isArray(stored.allowedTypes) ? stored.allowedTypes : []);
            elements['auto-approval-types'].querySelectorAll('input').forEach((input) => {
                input.checked = allowed.has(input.value);
            });
        } catch {
            elements['auto-approval-enabled'].checked = false;
        }
    }

    function receiptMessageFor(checkpoint, fallback = '') {
        return String(checkpoint?.receipt?.message || fallback || '').trim();
    }

    async function reviewPendingPr(prId, decision, message = '', options = {}) {
        const reviewApi = state.agentApi?.review;
        if (!reviewApi) return null;
        const result = decision === 'approve'
            ? await reviewApi.approvePr(prId, {
                message,
                automatic: options.automatic === true,
                policy: options.policy || null,
            })
            : await reviewApi.rejectPr(prId, { message });
        state.activeReviewPrId = null;
        elements['pr-review-dialog'].hidden = true;
        renderLineage();
        if (result?.success) {
            showToast(
                options.automatic ? '自动允许策略已合并 Agent 提案' : 'Agent 提案已合并',
                'success'
            );
        } else if (result?.code === 'PR_REJECTED') {
            showToast('Agent 提案已拒绝', 'info');
        } else {
            showToast(`Agent 提案处理失败：${result?.message || '未知错误'}`, 'error', 5000);
        }
        return result;
    }

    function appendSourceDiffLine(host, type, text) {
        const line = document.createElement('span');
        line.className = `pr-source-line pr-source-line-${type}`;
        line.textContent = text || ' ';
        host.appendChild(line);
    }

    function renderSourceReplacementDiff(host, replacements) {
        host.replaceChildren();
        const legend = document.createElement('div');
        legend.className = 'pr-source-legend';
        legend.innerHTML = '<span class="removed">− 移除</span><span class="added">＋ 新增</span>';
        host.appendChild(legend);
        replacements.forEach((replacement, index) => {
            if (index) appendSourceDiffLine(host, 'spacer', ' ');
            appendSourceDiffLine(
                host,
                'hunk',
                `@@ replacement ${index + 1}${
                    replacement.startLine ? ` · hint line ${replacement.startLine}` : ''
                } @@`
            );
            String(replacement.target || '').replace(/\r\n?/g, '\n').split('\n')
                .forEach((line) => appendSourceDiffLine(host, 'removed', `− ${line}`));
            String(replacement.replace ?? replacement.replacement ?? '')
                .replace(/\r\n?/g, '\n').split('\n')
                .forEach((line) => appendSourceDiffLine(host, 'added', `+ ${line}`));
        });
    }

    function prSourceFor(proposal) {
        const sourceKind = String(proposal.sourceKind || 'html');
        if (isSlideDeck() && sourceKind === 'deck-css') {
            return state.document?.source?.deckCss || '';
        }
        if (isSlideDeck() && proposal.slideIndex !== null && proposal.slideIndex !== undefined) {
            const slide = state.document?.source?.slides?.[Number(proposal.slideIndex)];
            return slide?.source || '';
        }
        return sourceKind === 'deck-css' ? currentSourceCss() : currentSourceHtml();
    }

    function elementChildren(node) {
        return [...(node?.children || [])];
    }

    function nearestPreviewIsland(node, root) {
        if (!node || node === root) return root;
        const preferred = 'div,section,article,aside,header,footer,main,figure,table,blockquote,li,[data-vdoc-block],[data-vdoc-slide]';
        const island = node.matches?.(preferred) ? node : node.closest?.(preferred);
        return island && root.contains(island) ? island : (node.parentElement || node);
    }

    function collectChangedDomPairs(beforeRoot, afterRoot, limit = 8) {
        const pairs = [];
        const seen = new Set();
        const addPair = (beforeNode, afterNode) => {
            const beforeIsland = beforeNode ? nearestPreviewIsland(beforeNode, beforeRoot) : null;
            const afterIsland = afterNode ? nearestPreviewIsland(afterNode, afterRoot) : null;
            const key = `${beforeIsland?.outerHTML || '∅'}\u0000${afterIsland?.outerHTML || '∅'}`;
            if (seen.has(key) || (!beforeIsland && !afterIsland)) return;
            seen.add(key);
            pairs.push({ before: beforeIsland, after: afterIsland });
        };
        const compare = (beforeNode, afterNode, depth = 0) => {
            if (pairs.length >= limit) return;
            if (!beforeNode || !afterNode) {
                addPair(beforeNode, afterNode);
                return;
            }
            if (beforeNode.outerHTML === afterNode.outerHTML) return;
            if (depth > 30 || beforeNode.tagName !== afterNode.tagName) {
                addPair(beforeNode, afterNode);
                return;
            }
            const beforeChildren = elementChildren(beforeNode);
            const afterChildren = elementChildren(afterNode);
            const attributesChanged = [...beforeNode.attributes].some((attribute) =>
                afterNode.getAttribute(attribute.name) !== attribute.value)
                || [...afterNode.attributes].some((attribute) =>
                    beforeNode.getAttribute(attribute.name) !== attribute.value);
            const directText = (node) => [...node.childNodes]
                .filter((child) => child.nodeType === Node.TEXT_NODE)
                .map((child) => child.textContent)
                .join('');
            if (attributesChanged || directText(beforeNode) !== directText(afterNode)) {
                addPair(beforeNode, afterNode);
                return;
            }
            const maximum = Math.max(beforeChildren.length, afterChildren.length);
            if (!maximum) {
                addPair(beforeNode, afterNode);
                return;
            }
            for (let index = 0; index < maximum; index += 1) {
                compare(beforeChildren[index], afterChildren[index], depth + 1);
            }
        };
        const maximum = Math.max(beforeRoot.children.length, afterRoot.children.length);
        for (let index = 0; index < maximum && pairs.length < limit; index += 1) {
            compare(beforeRoot.children[index], afterRoot.children[index]);
        }
        return pairs;
    }

    function buildIslandPreviewDocument(html, css, stateLabel) {
        const safeCss = String(css || '').replace(/<\/style/gi, '<\\/style');
        const markup = html || `<div class="pr-island-missing">${
            stateLabel === 'before' ? '变更前不存在' : '变更后已删除'
        }</div>`;
        return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;min-height:100%;box-sizing:border-box;background:#fffdf8;color:#1d2421}
body{padding:20px;font-family:"Noto Serif CJK SC","Microsoft YaHei",serif;overflow:auto}
*,*::before,*::after{box-sizing:border-box;animation-play-state:paused!important;transition:none!important}
.pr-island-missing{display:grid;min-height:120px;place-items:center;border:1px dashed #b7ada0;border-radius:8px;color:#81776b;background:#f4efe5;font:13px system-ui}
${safeCss}
</style></head><body>${markup}</body></html>`;
    }

    function renderHtmlIslandDiff(host, beforeHtml, afterHtml, css) {
        const beforeTemplate = document.createElement('template');
        const afterTemplate = document.createElement('template');
        beforeTemplate.innerHTML = beforeHtml;
        afterTemplate.innerHTML = afterHtml;
        const pairs = collectChangedDomPairs(beforeTemplate.content, afterTemplate.content);
        const usablePairs = pairs.length <= 8 ? pairs : [];
        const previewPairs = usablePairs.length
            ? usablePairs
            : [{
                before: beforeTemplate.content.firstElementChild,
                after: afterTemplate.content.firstElementChild,
                fallback: true,
            }];
        host.replaceChildren(...previewPairs.map((pair, index) => {
            const group = document.createElement('section');
            group.className = 'pr-island-group';
            const heading = document.createElement('div');
            heading.className = 'pr-island-heading';
            heading.textContent = pair.fallback
                ? '无法可靠定位最小变化岛，已降级显示文档根容器'
                : `变化岛 ${index + 1}`;
            const canvases = document.createElement('div');
            canvases.className = 'pr-island-canvases';
            const createCanvas = (label, node, stateLabel) => {
                const card = document.createElement('section');
                card.className = `pr-island-card ${stateLabel}`;
                const title = document.createElement('strong');
                title.textContent = label;
                const frame = document.createElement('iframe');
                frame.className = 'pr-island-frame';
                frame.sandbox = '';
                frame.title = `${label}隔离渲染预览`;
                frame.srcdoc = buildIslandPreviewDocument(node?.outerHTML || '', css, stateLabel);
                card.append(title, frame);
                return card;
            };
            canvases.append(
                createCanvas('变更前', pair.before, 'before'),
                createCanvas('变更后', pair.after, 'after')
            );
            group.append(heading, canvases);
            return group;
        }));
    }

    function renderTextualProposalFallback(host, replacements, reason) {
        const notice = document.createElement('div');
        notice.className = 'pr-render-fallback';
        notice.textContent = reason;
        const blocks = replacements.flatMap((replacement) => {
            const before = document.createElement('div');
            before.className = 'pr-diff-before';
            before.textContent = replacement.target || '（空 target）';
            const after = document.createElement('div');
            after.className = 'pr-diff-after';
            after.textContent = replacement.replace ?? replacement.replacement ?? '（删除）';
            return [before, after];
        });
        host.replaceChildren(notice, ...blocks);
    }

    function renderProposalDiff(checkpoint) {
        const proposal = checkpoint?.proposal || {};
        const replacements = Array.isArray(proposal.replacements)
            ? proposal.replacements
            : [];
        const renderDiff = elements['pr-render-diff'];
        const sourceDiff = elements['pr-source-diff'];
        if (proposal.type === 'source-replace' && replacements.length) {
            renderSourceReplacementDiff(sourceDiff, replacements);
            const sourceKind = String(proposal.sourceKind || 'html');
            const beforeSource = prSourceFor(proposal);
            const applied = window.ScriptoriumAgentModule.applyReplacements(
                beforeSource,
                replacements
            );
            if (sourceKind === 'html' && applied.success) {
                const documentCss = isSlideDeck()
                    ? core.splitSlideSource(
                        state.document?.source?.slides?.[Number(proposal.slideIndex)]?.source || ''
                    ).css
                    : currentSourceCss();
                renderHtmlIslandDiff(renderDiff, beforeSource, applied.source, documentCss);
            } else {
                renderTextualProposalFallback(
                    renderDiff,
                    replacements,
                    sourceKind === 'html'
                        ? `无法在当前修订定位替换目标：${applied.message || '未知原因'}`
                        : `${sourceKind.toUpperCase()} 变更无法映射到单一 DOM 岛，已安全降级为文本差异。`
                );
            }
        } else {
            const before = document.createElement('div');
            before.className = 'pr-diff-before';
            before.textContent = proposal.type === 'slide-delete'
                ? `删除第 ${Number(proposal.slideIndex) + 1} 页`
                : '当前演示结构';
            const after = document.createElement('div');
            after.className = 'pr-diff-after';
            after.textContent = proposal.type === 'slide-delete'
                ? '该页面将在合并后移除'
                : textFromProposal(proposal);
            renderDiff.replaceChildren(before, after);
            sourceDiff.replaceChildren();
            JSON.stringify(proposal, null, 2).split('\n')
                .forEach((line) => appendSourceDiffLine(sourceDiff, 'context', line));
        }
        const riskNotice = createPrRiskNotice(checkpoint);
        if (riskNotice) renderDiff.prepend(riskNotice);
    }

    function textFromProposal(proposal) {
        const template = document.createElement('template');
        template.innerHTML = String(proposal.source || '');
        return template.content.textContent?.trim()
            || proposal.name
            || proposal.type
            || '演示页面结构变更';
    }

    function openPrReview(checkpoint) {
        if (!checkpoint || checkpoint.status !== 'pending') return;
        state.activeReviewPrId = checkpoint.id;
        const author = checkpoint.author?.name || checkpoint.author?.signature || '未署名 Agent';
        const highRisk = hasRefuseRisk(checkpoint);
        elements['pr-review-title'].textContent = checkpoint.name || '协作变更审阅';
        elements['pr-review-meta'].textContent = highRisk
            ? `${author} · 高风险人工审阅 · 自动批准已禁用 · 基于修订 ${checkpoint.baseRevision}`
            : `${author} · ${checkpoint.summary || '无摘要'} · 基于修订 ${checkpoint.baseRevision}`;
        elements['pr-review-receipt'].value = '';
        elements['pr-review-approve-btn'].textContent = highRisk
            ? '人工确认并合并'
            : '允许并合并';
        elements['pr-review-approve-btn'].classList.toggle('high-risk', highRisk);
        elements['pr-review-approve-btn'].title = highRisk
            ? '仅合并源码；命中 refuse 规则的脚本仍不会被运行时执行'
            : '';
        renderProposalDiff(checkpoint);
        elements['pr-review-dialog'].hidden = false;
        elements['pr-review-receipt'].focus();
    }

    function scheduleAutoApproval(checkpoint) {
        if (checkpoint.status !== 'pending' || state.autoApprovalScheduled.has(checkpoint.id)) return;
        // refuse 级风险只能由人类审阅。即使该操作类型已在本地策略中勾选，
        // 也不得进入自动批准调度；Agent API 还会进行第二层强制校验。
        if (hasRefuseRisk(checkpoint)) return;
        const config = autoApprovalConfig();
        const operationType = prOperationType(checkpoint);
        if (!config.enabled || !config.allowedTypes.has(operationType)) return;
        state.autoApprovalScheduled.add(checkpoint.id);
        window.setTimeout(async () => {
            try {
                await reviewPendingPr(
                    checkpoint.id,
                    'approve',
                    `已由本地自动允许策略批准 ${operationType} 操作。`,
                    {
                        automatic: true,
                        policy: {
                            source: 'scriptorium-ui',
                            allowedOperationType: operationType,
                        },
                    }
                );
            } finally {
                state.autoApprovalScheduled.delete(checkpoint.id);
            }
        }, 0);
    }

    async function initializeLineageAvatars() {
        if (typeof api.loadAgentsList !== 'function') return [];
        try {
            const agents = await api.loadAgentsList();
            state.lineageAgents = Array.isArray(agents) ? agents : [];
        } catch (error) {
            state.lineageAgents = [];
            console.warn('[Scriptorium] 无法读取 Agent 头像索引：', error);
        }
        return state.lineageAgents;
    }

    function lineageAuthorName(checkpoint) {
        return String(
            checkpoint?.author?.name
            || checkpoint?.author?.signature
            || checkpoint?.maid?.name
            || (checkpoint?.source === 'agent' ? '未署名 Agent' : '人类')
        ).trim();
    }

    function lineageAvatarFallback(checkpoint, authorName) {
        if (checkpoint?.source === 'agent') {
            const compactName = String(authorName || '')
                .replace(/未署名\s*Agent/gi, '')
                .replace(/\s*Agent\s*/gi, '')
                .trim();
            return compactName.slice(0, 1).toUpperCase() || 'AI';
        }
        return '人';
    }

    async function lineageAvatarFor(checkpoint) {
        const source = checkpoint?.source === 'agent' ? 'agent' : 'human';
        const authorName = lineageAuthorName(checkpoint);
        const cacheKey = `${source}:${authorName.toLocaleLowerCase()}`;
        if (state.lineageAvatarCache.has(cacheKey)) {
            return state.lineageAvatarCache.get(cacheKey);
        }
        if (state.lineageAvatarPending.has(cacheKey)) {
            return state.lineageAvatarPending.get(cacheKey);
        }

        const request = (async () => {
            try {
                let avatar = null;
                if (source === 'human') {
                    avatar = await api.loadUserAvatar?.();
                } else {
                    const normalizedAuthor = authorName.toLocaleLowerCase();
                    const agent = state.lineageAgents.find((candidate) => {
                        const normalizedAgent = String(candidate?.name || '').trim().toLocaleLowerCase();
                        return normalizedAgent
                            && (normalizedAgent.includes(normalizedAuthor)
                                || normalizedAuthor.includes(normalizedAgent));
                    });
                    if (agent?.folder) avatar = await api.loadAgentAvatar?.(agent.folder);
                }
                const resolved = avatar || null;
                state.lineageAvatarCache.set(cacheKey, resolved);
                return resolved;
            } catch (error) {
                console.warn(`[Scriptorium] 无法读取“${authorName}”的文脉头像：`, error);
                state.lineageAvatarCache.set(cacheKey, null);
                return null;
            } finally {
                state.lineageAvatarPending.delete(cacheKey);
            }
        })();

        state.lineageAvatarPending.set(cacheKey, request);
        return request;
    }

    function createLineageAvatar(checkpoint) {
        const authorName = lineageAuthorName(checkpoint);
        const avatar = document.createElement('span');
        avatar.className = `checkpoint-avatar ${checkpoint.source === 'agent' ? 'agent' : 'human'} loading`;
        avatar.textContent = lineageAvatarFallback(checkpoint, authorName);
        avatar.dataset.author = authorName;
        avatar.setAttribute('role', 'img');
        avatar.setAttribute('aria-label', `${authorName}的头像`);
        avatar.title = authorName;

        lineageAvatarFor(checkpoint).then((source) => {
            if (!source || !avatar.isConnected || avatar.dataset.author !== authorName) return;
            avatar.style.backgroundImage = `url("${String(source).replace(/["\\\r\n]/g, '\\$&')}")`;
            avatar.textContent = '';
            avatar.classList.add('has-avatar');
            avatar.classList.remove('loading');
        });
        return avatar;
    }

    function renderLineage() {
        elements['checkpoint-count'].textContent = String(state.checkpoints.length);
        const pendingCount = state.checkpoints.filter((record) => record.status === 'pending').length;
        elements['pending-pr-count'].textContent = String(pendingCount);
        if (!state.checkpoints.length) {
            elements['lineage-flow'].innerHTML = '<div class="lineage-empty"><strong>文脉尚未开始</strong><p>人类与 AI 的每次共建刻点都会在这里留下轨迹。</p></div>';
            return;
        }
        elements['lineage-flow'].replaceChildren(...state.checkpoints.map((checkpoint) => {
            const item = document.createElement('article');
            const status = checkpoint.status || 'applied';
            const highRisk = hasRefuseRisk(checkpoint);
            item.className = `checkpoint-item ${checkpoint.source} ${status}${
                highRisk ? ' high-risk' : ''
            }`;
            item.innerHTML = '<div class="checkpoint-meta"><span class="checkpoint-identity"><span class="checkpoint-source"></span></span><time></time></div><h3></h3><p></p><span class="checkpoint-status"></span>';
            const authorName = lineageAuthorName(checkpoint);
            const identity = item.querySelector('.checkpoint-identity');
            identity.prepend(createLineageAvatar(checkpoint));
            item.querySelector('.checkpoint-source').textContent = checkpoint.source === 'agent'
                ? `AI 协作 · ${authorName}`
                : `人类刻点 · ${authorName}`;
            item.querySelector('time').textContent = new Date(checkpoint.createdAt).toLocaleString('zh-CN');
            item.querySelector('h3').textContent = checkpoint.name;
            item.querySelector('p').textContent = checkpoint.summary
                || checkpoint.note
                || '完整源码状态已记录。';
            const statusLabels = {
                pending: highRisk ? '高风险 · 仅限人工审阅' : '等待人类审阅',
                applied: checkpoint.receipt?.automatic ? '自动允许并已合并' : '已应用',
                rejected: '已拒绝',
                conflict: '修订冲突',
                failed: '应用失败',
            };
            item.querySelector('.checkpoint-status').textContent = statusLabels[status] || status;

            if (status === 'pending') {
                const riskNotice = createPrRiskNotice(checkpoint, true);
                if (riskNotice) item.appendChild(riskNotice);
                const receipt = document.createElement('textarea');
                receipt.className = 'pr-inline-receipt';
                receipt.maxLength = 1200;
                receipt.placeholder = '可填写给 Agent 的批准/拒绝原因或修改建议';
                const actions = document.createElement('div');
                actions.className = 'pr-card-actions';
                const review = document.createElement('button');
                review.type = 'button';
                review.textContent = '审阅';
                review.addEventListener('click', () => openPrReview(checkpoint));
                const reject = document.createElement('button');
                reject.type = 'button';
                reject.className = 'pr-reject';
                reject.textContent = '拒绝';
                reject.addEventListener('click', () =>
                    reviewPendingPr(checkpoint.id, 'reject', receipt.value));
                const approve = document.createElement('button');
                approve.type = 'button';
                approve.className = `pr-approve${highRisk ? ' high-risk' : ''}`;
                approve.textContent = highRisk ? '人工允许' : '允许';
                approve.title = highRisk
                    ? '自动批准已禁用；人工允许后高风险脚本仍由运行时阻止执行'
                    : '';
                approve.addEventListener('click', () =>
                    reviewPendingPr(checkpoint.id, 'approve', receipt.value));
                actions.append(review, reject, approve);
                item.append(receipt, actions);
                scheduleAutoApproval(checkpoint);
            } else if (checkpoint.receipt) {
                const receipt = document.createElement('div');
                receipt.className = 'pr-receipt-summary';
                receipt.textContent = receiptMessageFor(
                    checkpoint,
                    checkpoint.receipt.decision === 'rejected'
                        ? '人类拒绝了该提案。'
                        : '该提案已完成审阅。'
                );
                item.appendChild(receipt);
            }
            item.title = checkpoint.note || checkpoint.summary || '点击查看文脉详情';
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.addEventListener('click', (event) => {
                if (event.target.closest('button, textarea, input, select, a')) return;
                openLineageDetail(checkpoint);
            });
            item.addEventListener('keydown', (event) => {
                if ((event.key === 'Enter' || event.key === ' ')
                    && !event.target.closest('button, textarea, input, select, a')) {
                    event.preventDefault();
                    openLineageDetail(checkpoint);
                }
            });
            return item;
        }));
    }

    function lineageRecordById(recordId) {
        return state.checkpoints.find((record) => record.id === recordId) || null;
    }

    function openLineageDetail(record) {
        if (!record) return;
        state.activeLineageRecordId = record.id;
        const author = record.author?.name
            || record.maid?.name
            || (record.source === 'human' ? '人类' : '未署名 Agent');
        elements['lineage-detail-title'].textContent = record.name || '未命名文脉节点';
        elements['lineage-detail-meta'].textContent = [
            author,
            record.status || 'applied',
            new Date(record.createdAt || Date.now()).toLocaleString('zh-CN'),
            Number.isFinite(Number(record.revision)) ? `修订 ${record.revision}` : null,
        ].filter(Boolean).join(' · ');
        elements['lineage-detail-record'].textContent = JSON.stringify({
            id: record.id,
            source: record.source,
            author: record.author || record.maid || null,
            name: record.name,
            summary: record.summary || '',
            note: record.note || '',
            status: record.status || 'applied',
            baseRevision: record.baseRevision ?? null,
            revision: record.revision ?? null,
            createdAt: record.createdAt,
            reviewedAt: record.reviewedAt || null,
        }, null, 2);
        elements['lineage-detail-change'].textContent = JSON.stringify({
            changeSet: changeSetForLineageRecord(record),
            proposal: record.proposal || null,
            operation: record.operation || null,
            receipt: record.receipt || null,
        }, null, 2);
        const restorable = typeof record.snapshot === 'string' && record.snapshot.trim();
        elements['lineage-snapshot-status'].textContent = restorable
            ? '工程内嵌版本快照可用'
            : '此节点没有可用快照，仅可查看记录';
        elements['lineage-restore-btn'].disabled = !restorable
            || record.status === 'pending';
        elements['lineage-detail-dialog'].hidden = false;
    }

    function closeLineageDetail() {
        state.activeLineageRecordId = null;
        elements['lineage-detail-dialog'].hidden = true;
    }

    function requestLineageRestore(record) {
        if (!record?.snapshot || record.status === 'pending') return;
        state.pendingRestoreRecordId = record.id;
        elements['lineage-restore-message'].textContent =
            `将回溯到“${record.name || '未命名节点'}”。当前内容会先保存为新的工程内刻点，后续文脉不会被删除。`;
        elements['lineage-restore-dialog'].hidden = false;
    }

    function cancelLineageRestore() {
        state.pendingRestoreRecordId = null;
        elements['lineage-restore-dialog'].hidden = true;
    }

    async function confirmLineageRestore() {
        finalizeEditBurst();
        const target = lineageRecordById(state.pendingRestoreRecordId);
        if (!target?.snapshot) {
            cancelLineageRestore();
            return false;
        }
        try {
            const currentSnapshot = createVersionSnapshot();
            const currentSourceState = sourceStateOf();
            const restored = core.parse(target.snapshot);
            const restoredSourceState = sourceStateOf(restored);
            const timeline = state.checkpoints;
            const now = Date.now();
            timeline.unshift({
                id: `human-before-restore-${now}`,
                source: 'human',
                author: { id: 'human', name: '人类审阅者', type: 'human' },
                name: `回溯前备份 · ${state.currentName}`,
                summary: `回溯到“${target.name || target.id}”前自动保存当前版本。`,
                note: '',
                createdAt: now,
                revision: state.documentRevision,
                operation: {
                    type: 'version-backup-before-restore',
                    targetCheckpointId: target.id,
                },
                changeSet: {
                    type: 'version-backup-before-restore',
                    before: null,
                    after: currentSourceState,
                },
                status: 'applied',
                snapshot: currentSnapshot,
            });
            state.document = restored;
            state.document.checkpoints = timeline;
            state.checkpoints = timeline;
            state.activeSlideIndex = 0;
            state.selectionRange = null;
            state.selectionText = '';
            state.selectionBlockIds = [];
            state.explicitBlockSelection = false;
            state.previewRevision = -1;
            state.previewResult = null;
            state.documentRevision += 1;
            renderDocument();
            timeline.unshift({
                id: `human-restore-${now}`,
                source: 'human',
                author: { id: 'human', name: '人类审阅者', type: 'human' },
                name: `已回溯 · ${target.name || target.id}`,
                summary: '基于工程内嵌版本快照恢复文档内容，历史文脉保持不变。',
                note: '',
                createdAt: now + 1,
                baseRevision: target.revision ?? null,
                revision: state.documentRevision,
                operation: {
                    type: 'version-restore',
                    targetCheckpointId: target.id,
                },
                changeSet: {
                    type: 'version-restore',
                    before: currentSourceState,
                    after: restoredSourceState,
                },
                status: 'applied',
                snapshot: createVersionSnapshot(),
            });
            state.document.checkpoints = timeline;
            captureSnapshot();
            markDirty();
            renderLineage();
            closeLineageDetail();
            cancelLineageRestore();
            await persistCheckpointToFile('文脉版本回溯');
            showToast(`已回溯到 · ${target.name || target.id}`, 'success', 4200);
            return true;
        } catch (error) {
            showToast(`版本回溯失败：${error.message}`, 'error', 5000);
            return false;
        }
    }

    async function createCheckpoint(event) {
        event.preventDefault();
        finalizeEditBurst();
        const name = elements['checkpoint-name-input'].value.trim();
        if (!name) return;
        state.checkpoints.unshift({
            id: `human-${Date.now()}`,
            source: 'human',
            name,
            note: elements['checkpoint-note-input'].value.trim(),
            createdAt: Date.now(),
            operation: {
                type: 'checkpoint-state',
            },
            changeSet: {
                type: 'checkpoint-state',
                before: null,
                after: sourceStateOf(),
            },
            status: 'applied',
            snapshot: createVersionSnapshot(),
        });
        elements['checkpoint-dialog'].hidden = true;
        renderLineage();
        await persistCheckpointToFile('人类刻点');
    }

    function restorePanelWidths() {
        const outlineWidth = Number(localStorage.getItem('scriptorium:outline-width'));
        const lineageWidth = Number(localStorage.getItem('scriptorium:lineage-width'));
        if (Number.isFinite(outlineWidth) && outlineWidth >= 180) {
            document.documentElement.style.setProperty('--scriptorium-outline-width', `${outlineWidth}px`);
        }
        if (Number.isFinite(lineageWidth) && lineageWidth >= 200) {
            document.documentElement.style.setProperty('--scriptorium-lineage-width', `${lineageWidth}px`);
        }
    }

    function bindPanelResizer(resizer, side) {
        resizer.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || innerWidth <= 900) return;
            event.preventDefault();
            resizer.setPointerCapture(event.pointerId);
            resizer.classList.add('dragging');
            document.body.classList.add('resizing-panels');

            const stage = document.querySelector('.scriptorium-stage');
            const update = (pointerEvent) => {
                const rect = stage.getBoundingClientRect();
                const rawWidth = side === 'left'
                    ? pointerEvent.clientX - rect.left
                    : rect.right - pointerEvent.clientX;
                const maximum = Math.min(480, rect.width * .42);
                const minimum = side === 'left' ? 180 : 200;
                const width = Math.round(Math.max(minimum, Math.min(maximum, rawWidth)));
                const property = side === 'left'
                    ? '--scriptorium-outline-width'
                    : '--scriptorium-lineage-width';
                document.documentElement.style.setProperty(property, `${width}px`);
                localStorage.setItem(
                    side === 'left' ? 'scriptorium:outline-width' : 'scriptorium:lineage-width',
                    String(width)
                );
            };

            const finish = () => {
                resizer.classList.remove('dragging');
                document.body.classList.remove('resizing-panels');
                resizer.removeEventListener('pointermove', update);
                resizer.removeEventListener('pointerup', finish);
                resizer.removeEventListener('pointercancel', finish);
            };

            resizer.addEventListener('pointermove', update);
            resizer.addEventListener('pointerup', finish);
            resizer.addEventListener('pointercancel', finish);
        });
    }

    function bindControls() {
        elements['minimize-btn'].addEventListener('click', api.minimizeWindow);
        elements['maximize-btn'].addEventListener('click', api.maximizeWindow);
        elements['close-btn'].addEventListener('click', () => runAfterUnsavedDecision(
            '关闭 Scriptorium 前，可以保存当前修改，或舍弃这些修改。',
            api.closeWindow
        ));
        elements['new-btn'].addEventListener('click', () => runAfterUnsavedDecision(
            '建立新稿前是否保存当前修改？',
            () => createEditor()
        ));
        elements['new-deck-btn'].addEventListener('click', () => runAfterUnsavedDecision(
            '建立新演示前是否保存当前修改？',
            () => createEditor(core.createDocument({
                kind: core.PROJECT_KINDS.SLIDE_DECK,
                title: '未命名演示',
            }))
        ));
        elements['welcome-new-btn'].addEventListener('click', () => createEditor());
        elements['open-btn'].addEventListener('click', chooseOpen);
        elements['import-btn'].addEventListener('click', chooseImport);
        elements['welcome-open-btn'].addEventListener('click', chooseOpen);
        elements['collect-external-resources'].checked =
            localStorage.getItem('scriptorium:collect-external-resources') === 'true';
        elements['collect-external-resources'].addEventListener('change', (event) => {
            localStorage.setItem(
                'scriptorium:collect-external-resources',
                String(event.target.checked)
            );
        });
        elements['save-btn'].addEventListener('click', () => saveDocument(false));
        elements['save-as-btn'].addEventListener('click', () => saveDocument(true));
        elements['export-flow-html-btn'].addEventListener('click', () => exportRichDocument('html-flow'));
        elements['export-paged-html-btn'].addEventListener('click', () => exportRichDocument('html-paged'));
        elements['export-pdf-btn'].addEventListener('click', () => exportRichDocument('pdf'));
        elements['render-mode-btn'].addEventListener('click', () => switchMode('render'));
        elements['read-mode-btn'].addEventListener('click', () => switchMode('read'));
        elements['html-mode-btn'].addEventListener('click', () => switchMode('html'));
        elements['css-mode-btn'].addEventListener('click', () => switchMode('css'));
        elements['apply-source-btn'].addEventListener('click', () => applySourceChanges());
        elements['format-source-btn'].addEventListener('click', formatSource);
        elements['source-wrap-toggle'].addEventListener('change', (event) => {
            state.sourceEditor?.setOption('lineWrapping', event.target.checked);
            state.sourceEditor?.refresh();
        });
        elements['source-color-input'].addEventListener('input', (event) => {
            replaceSourceColor(event.target.value);
        });
        elements['insert-block-btn'].addEventListener('click', () => insertStructureBlock());
        document.querySelectorAll('[data-command]').forEach((control) => {
            control.addEventListener('mousedown', (event) => event.preventDefault());
            control.addEventListener('click', () => executeCommand(control.dataset.command, control.dataset.value));
        });
        elements['text-context-menu'].addEventListener('click', (event) => {
            const action = event.target.closest('[data-text-action]')?.dataset.textAction;
            if (action) runTextContextAction(action);
        });
        elements['selection-format-bar'].querySelectorAll('[data-selection-command]').forEach((control) => {
            control.addEventListener('mousedown', (event) => event.preventDefault());
            control.addEventListener('click', () => {
                executeCommand(control.dataset.selectionCommand, undefined, true);
            });
        });
        elements['selection-font-family'].addEventListener('change', (event) => {
            executeCommand('font-family', event.target.value, true);
        });
        elements['selection-font-size'].addEventListener('change', (event) => {
            executeCommand('font-size', event.target.value, true);
        });
        elements['selection-text-color'].addEventListener('change', (event) => {
            executeCommand('text-color', event.target.value, true);
        });
        elements['font-family-select'].addEventListener('change', (event) => executeCommand('font-family', event.target.value));
        elements['font-size-select'].addEventListener('change', (event) => executeCommand('font-size', event.target.value));
        elements['line-height-select'].addEventListener('change', (event) => executeCommand('line-height', event.target.value));
        elements['text-color-input'].addEventListener('change', (event) => executeCommand('text-color', event.target.value));
        elements['highlight-color-input'].addEventListener('change', (event) => executeCommand('highlight-color', event.target.value));
        elements['advanced-style-btn'].addEventListener('mousedown', (event) => event.preventDefault());
        elements['advanced-style-btn'].addEventListener('click', openStyleLibrary);
        elements['style-library-close-btn'].addEventListener('click', closeStyleLibrary);
        elements['style-library-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['style-library-dialog']) closeStyleLibrary();
        });
        elements['style-search-input'].addEventListener('input', renderStyleLibrary);
        elements['style-category-select'].addEventListener('change', renderStyleLibrary);
        elements['style-apply-btn'].addEventListener('click', applySelectedAdvancedStyle);
        elements['style-import-btn'].addEventListener('click', () => elements['style-import-input'].click());
        elements['style-import-input'].addEventListener('change', (event) => {
            importStylePack(event.target.files?.[0]);
        });
        elements['style-export-btn'].addEventListener('click', exportStylePack);
        elements['find-btn'].addEventListener('click', openFindPanel);
        elements['find-input'].addEventListener('input', () => refreshFindResults());
        elements['find-input'].addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            moveFindMatch(event.shiftKey ? -1 : 1);
        });
        elements['find-previous-btn'].addEventListener('click', () => moveFindMatch(-1));
        elements['find-next-btn'].addEventListener('click', () => moveFindMatch(1));
        elements['find-close-btn'].addEventListener('click', closeFindPanel);
        elements['insert-table-btn'].addEventListener('click', () => insertStructureBlock('table'));
        elements['zoom-range'].addEventListener('input', (event) => updateZoom(event.target.value));
        elements['zoom-out-btn'].addEventListener('click', () => updateZoom(state.zoom - 10));
        elements['zoom-in-btn'].addEventListener('click', () => updateZoom(state.zoom + 10));
        [elements['render-host'], elements['read-host']].forEach((host) => {
            host.addEventListener('wheel', handleZoomWheel, {
                passive: false,
                capture: true,
            });
        });
        elements['read-host'].addEventListener('scroll', () => {
            const root = getReadRoot();
            if (root && state.mode === 'read') {
                updateCurrentPage(root, elements['read-host']);
            }
        }, { passive: true });
        elements['add-slide-btn'].addEventListener('click', addSlide);
        elements['delete-slide-btn'].addEventListener('click', deleteCurrentSlide);
        bindPanelResizer(elements['outline-resizer'], 'left');
        bindPanelResizer(elements['lineage-resizer'], 'right');
        elements['outline-toggle-btn'].addEventListener('click', () => document.body.classList.toggle('outline-collapsed'));
        elements['lineage-toggle-btn'].addEventListener('click', () => document.body.classList.toggle('lineage-collapsed'));
        elements['focus-mode-btn'].addEventListener('click', toggleFocusMode);
        elements['focus-exit-btn'].addEventListener('click', () => setFocusMode(false));
        elements['outline-headings-tab'].addEventListener('click', () => setOutlineTab(true));
        elements['outline-paragraphs-tab'].addEventListener('click', () => setOutlineTab(false));
        elements['auto-approval-enabled'].addEventListener('change', () => {
            saveAutoApprovalConfig();
            renderLineage();
        });
        elements['auto-approval-types'].addEventListener('change', () => {
            saveAutoApprovalConfig();
            renderLineage();
        });
        elements['pr-review-close-btn'].addEventListener('click', () => {
            state.activeReviewPrId = null;
            elements['pr-review-dialog'].hidden = true;
        });
        elements['pr-review-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['pr-review-dialog']) {
                state.activeReviewPrId = null;
                elements['pr-review-dialog'].hidden = true;
            }
        });
        elements['pr-review-approve-btn'].addEventListener('click', () => {
            if (!state.activeReviewPrId) return;
            reviewPendingPr(
                state.activeReviewPrId,
                'approve',
                elements['pr-review-receipt'].value
            );
        });
        elements['pr-review-reject-btn'].addEventListener('click', () => {
            if (!state.activeReviewPrId) return;
            reviewPendingPr(
                state.activeReviewPrId,
                'reject',
                elements['pr-review-receipt'].value
            );
        });
        elements['media-local-select-btn'].addEventListener(
            'click',
            () => elements['media-local-input'].click()
        );
        elements['media-local-input'].addEventListener('change', (event) => {
            selectLocalMediaFiles(event.target.files);
        });
        elements['media-form'].addEventListener('submit', submitMediaInsertion);
        elements['media-cancel-btn'].addEventListener('click', closeMediaDialog);
        elements['media-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['media-dialog']) closeMediaDialog();
        });
        elements['create-checkpoint-btn'].addEventListener('click', () => {
            elements['checkpoint-name-input'].value = '';
            elements['checkpoint-note-input'].value = '';
            elements['checkpoint-dialog'].hidden = false;
        });
        elements['checkpoint-cancel-btn'].addEventListener('click', () => elements['checkpoint-dialog'].hidden = true);
        elements['checkpoint-dialog'].querySelector('form').addEventListener('submit', createCheckpoint);
        elements['security-review-toggle'].addEventListener('click', openSecurityReviewConfirmation);
        elements['security-review-confirm-check'].addEventListener('change', (event) => {
            elements['security-review-disable-btn'].disabled = !event.target.checked;
        });
        elements['security-review-cancel-btn'].addEventListener('click', closeSecurityReviewConfirmation);
        elements['security-review-disable-btn'].addEventListener('click', () => {
            if (!elements['security-review-confirm-check'].checked) return;
            closeSecurityReviewConfirmation();
            setSecurityReviewEnabled(false);
        });
        elements['security-review-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['security-review-dialog']) {
                closeSecurityReviewConfirmation();
            }
        });
        elements['lineage-detail-close-btn'].addEventListener('click', closeLineageDetail);
        elements['lineage-detail-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['lineage-detail-dialog']) closeLineageDetail();
        });
        elements['lineage-restore-btn'].addEventListener('click', () => {
            requestLineageRestore(lineageRecordById(state.activeLineageRecordId));
        });
        elements['lineage-restore-cancel-btn'].addEventListener('click', cancelLineageRestore);
        elements['lineage-restore-confirm-btn'].addEventListener('click', confirmLineageRestore);
        elements['lineage-restore-dialog'].addEventListener('click', (event) => {
            if (event.target === elements['lineage-restore-dialog']) cancelLineageRestore();
        });
        elements['unsaved-cancel-btn'].addEventListener('click', () => resolveUnsavedDecision('cancel'));
        elements['unsaved-discard-btn'].addEventListener('click', () => resolveUnsavedDecision('discard'));
        elements['unsaved-save-btn'].addEventListener('click', () => resolveUnsavedDecision('save'));
        elements['render-host'].addEventListener('contextmenu', (event) => {
            if (event.composedPath().some((node) =>
                node?.matches?.('[data-vdoc-text], [data-vdoc-object-id]')
            )) return;
            event.preventDefault();
            showTextContextMenu(event.clientX, event.clientY, null, event);
        });
        window.addEventListener('pointerdown', (event) => {
            if (!elements['text-context-menu'].contains(event.target)) {
                hideTextContextMenu();
                hideSelectionBar();
            }
        }, true);
    }

    function setOutlineTab(headings) {
        elements['outline-headings-tab'].classList.toggle('active', headings);
        elements['outline-paragraphs-tab'].classList.toggle('active', !headings);
        elements['outline-headings-view'].hidden = !headings;
        elements['outline-paragraphs-view'].hidden = headings;
    }

    function updateZoom(value) {
        state.zoom = Math.max(50, Math.min(200, Number(value) || 100));
        elements['zoom-range'].value = String(state.zoom);
        elements['zoom-value'].textContent = `${state.zoom}%`;

        const editableRuntime = getRenderRoot()?.querySelector(
            '.vdoc-flow-runtime, .vdoc-slide-editor-runtime'
        );
        editableRuntime?.style.setProperty('--vdoc-zoom', String(state.zoom / 100));

        const readRoot = getReadRoot();
        readRoot?.querySelectorAll('.vdoc-page').forEach((page) => {
            page.style.setProperty('--vdoc-zoom', String(state.zoom / 100));
        });
        updatePageZoomLayout(readRoot);
        if (readRoot && state.mode === 'read') {
            window.requestAnimationFrame(() =>
                updateCurrentPage(readRoot, elements['read-host'])
            );
        }
        return state.zoom;
    }

    function handleZoomWheel(event) {
        if (!(event.ctrlKey || event.metaKey)
            || !state.ready
            || (state.mode !== 'render' && state.mode !== 'read')) return;
        event.preventDefault();

        const host = state.mode === 'read'
            ? elements['read-host']
            : elements['render-host'];
        const hostRect = host.getBoundingClientRect();
        const pointerX = event.clientX - hostRect.left;
        const pointerY = event.clientY - hostRect.top;
        const oldScale = state.zoom / 100;
        const direction = event.deltaY < 0 ? 1 : -1;
        const nextZoom = Math.max(50, Math.min(200, state.zoom + direction * 5));
        if (nextZoom === state.zoom) return;

        // 将鼠标所指的文档坐标换算到新比例，避免缩放后纸页突然跳离指针。
        const documentX = (host.scrollLeft + pointerX) / oldScale;
        const documentY = (host.scrollTop + pointerY) / oldScale;
        const newScale = updateZoom(nextZoom) / 100;

        window.requestAnimationFrame(() => {
            host.scrollLeft = Math.max(0, documentX * newScale - pointerX);
            host.scrollTop = Math.max(0, documentY * newScale - pointerY);
        });
    }

    function bindKeyboard() {
        window.addEventListener('keydown', (event) => {
            if (state.objectController?.handleKeydown(event)) return;
            const modifier = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            const formControl = event.target?.closest?.('input, textarea, select, .CodeMirror');
            if (event.key === 'Backspace'
                && !event.defaultPrevented
                && state.ready
                && state.mode === 'render'
                && state.explicitBlockSelection
                && !formControl) {
                event.preventDefault();
                deleteExplicitBlockSelection();
            } else if (modifier && (key === 'c' || key === 'x')
                && state.ready
                && state.mode === 'render'
                && state.explicitBlockSelection
                && !formControl) {
                // 跨块显式选择不能依赖 Chromium 是否把原生 copy/cut 事件
                // 派发到 ShadowRoot。顶层快捷键直接执行同一套剪贴板事务。
                event.preventDefault();
                event.stopImmediatePropagation();
                runClipboardCommand(key === 'x' ? 'cut' : 'copy');
            } else if (modifier && key === 'f') {
                event.preventDefault();
                openFindPanel();
            } else if (modifier && key === 'a' && state.ready && state.mode === 'render' && !formControl) {
                event.preventDefault();
                selectEntireRenderedDocument();
            } else if (modifier && key === 's') {
                event.preventDefault();
                saveDocument(event.shiftKey);
            } else if (modifier && key === 'o') {
                event.preventDefault();
                chooseOpen();
            } else if (modifier && key === 'n') {
                event.preventDefault();
                createEditor();
            } else if (modifier && key === 'z') {
                event.preventDefault();
                restoreHistory(event.shiftKey ? 1 : -1);
            } else if (modifier && key === 'y') {
                event.preventDefault();
                restoreHistory(1);
            } else if (event.key === 'Escape') {
                if (!elements['find-panel'].hidden) {
                    event.preventDefault();
                    closeFindPanel();
                    return;
                }
                if (document.body.classList.contains('focus-mode')) {
                    event.preventDefault();
                    setFocusMode(false);
                    return;
                }
                closeMediaDialog();
                closeStyleLibrary();
                hideSelectionBar();
                hideTextContextMenu();
                clearExplicitBlockSelection();
                closeSecurityReviewConfirmation();
                closeLineageDetail();
                cancelLineageRestore();
                elements['checkpoint-dialog'].hidden = true;
                elements['pr-review-dialog'].hidden = true;
                state.activeReviewPrId = null;
            }
        });
    }

    function bindRuntime() {
        state.pathRequestDisposer = api.onOpenPathRequest(openPath);
        state.agentRequestDisposer = api.onAgentRequest?.(async (request) => {
            const requestId = request?.requestId;
            try {
                const endpointName = request?.endpoint || 'current';
                const endpoint = endpointName === 'current'
                    ? state.agentApi?.current?.()
                    : state.agentApi?.[endpointName];
                const method = endpoint?.[request?.method];
                if (typeof method !== 'function') {
                    throw new Error(`未知 Agent 方法：${request?.method || '—'}`);
                }
                const result = await method(request.payload || {});
                api.respondAgentRequest?.({ requestId, result });
            } catch (error) {
                api.respondAgentRequest?.({
                    requestId,
                    error: { code: 'AGENT_REQUEST_FAILED', message: error.message },
                });
            }
        });
        state.agentCheckpointDisposer = api.onAgentCheckpointProposed(async (payload) => {
            if (!payload) return;
            state.checkpoints.unshift({
                id: payload.id || `agent-${Date.now()}`,
                source: 'agent',
                author: payload.author || null,
                name: payload.name || 'AI 排版提案',
                summary: payload.summary || payload.note || 'AI 已提交一轮润色与排版。',
                note: payload.note || '',
                createdAt: payload.createdAt || Date.now(),
                operation: payload.operation || { type: 'agent-checkpoint-state' },
                proposal: payload.proposal || null,
                changeSet: payload.changeSet || {
                    type: 'agent-checkpoint-state',
                    before: null,
                    after: sourceStateOf(),
                },
                status: payload.status || 'applied',
                snapshot: payload.snapshot || createVersionSnapshot(),
            });
            renderLineage();
            await persistCheckpointToFile('AI 刻点');
        });
        window.addEventListener('beforeunload', () => {
            finalizeEditBurst({ rerender: false });
            state.resourceResolver?.revoke();
            state.resourceResolver = null;
            state.renderSurfaceAbortController?.abort();
            if (state.compositionEnterFrame !== null) {
                window.cancelAnimationFrame(state.compositionEnterFrame);
            }
            if (state.formattingSyncFrame !== null) {
                window.cancelAnimationFrame(state.formattingSyncFrame);
            }
            disposeSlideRuntime();
            state.objectController?.dispose();
            state.pageObserver?.disconnect();
            state.slideThumbnailObserver?.disconnect();
            clearFindPresentation();
            window.clearTimeout(state.paginationTimer);
            window.clearTimeout(state.renderUpdateTimer);
            window.clearTimeout(state.sourceEditorTimer);
            window.ScriptoriumPretext?.clear?.();
            state.themeDisposer?.();
            state.pathRequestDisposer?.();
            state.agentCheckpointDisposer?.();
            state.agentRequestDisposer?.();
            state.styleLibraryDisposer?.();
        });
    }

    async function initialize() {
        if (!api || !core || !containerModule || !hybridCompiler || !window.JSZip
            || !styleLibrary || !pagination || !asyncModule || !exportResourcesModule
            || !runtimeModule || !sourceEditorModule || !sessionModule || !objectModule
            || !sourceEditorController || !sessionController
            || !window.ScriptoriumVisibility || !window.ScriptoriumAgentModule) {
            throw new Error('Scriptorium 原生文档内核或模块未载入。');
        }
        cacheElements();
        state.objectController = objectModule.createObjectController({
            elements,
            getRoot: getRenderRoot,
            getZoom: () => state.zoom,
            isSlideDeck,
            canInsert: () => state.ready && state.mode === 'render',
            insertObject: insertVisualObject,
            commitMutation: commitVisualObjectMutation,
            onSelectionChange: (selection) => {
                if (!elements['selection-status']) return;
                if (!selection) {
                    elements['selection-status'].hidden = !state.explicitBlockSelection;
                    elements['selection-status'].textContent = state.explicitBlockSelection
                        ? `已选 ${state.selectionBlockIds.length} 块`
                        : '';
                    return;
                }
                elements['selection-status'].hidden = false;
                elements['selection-status'].textContent =
                    `对象 · ${selection.name || '未命名'}`;
            },
        });
        restorePanelWidths();
        restoreAutoApprovalConfig();
        restoreSecurityReviewConfig();
        elements['page-stream'].attachShadow({ mode: 'open' });
        elements['read-page-stream'].attachShadow({ mode: 'open' });
        initializeSourceEditor();
        bindControls();
        bindKeyboard();
        state.agentApi = window.ScriptoriumAgentModule.createAgentApi({
            state,
            core,
            containerModule,
            hybridCompiler,
            getCompiledDocument: () => parsedDocument(),
            getRenderRoot,
            getReadRoot,
            getCurrentHtml: currentSourceHtml,
            getCurrentCss: currentSourceCss,
            setCurrentHtml: setCurrentSourceHtml,
            setCurrentCss: setCurrentSourceCss,
            renderDocument,
            renderReadingPreview,
            markDirty,
            captureSnapshot,
            createVersionSnapshot,
            renderLineage,
            persistCheckpoint: persistCheckpointToFile,
            selectSlide,
        });
        window.ScriptoriumAgent = state.agentApi;
        bindRuntime();
        await initializeTheme();
        state.styleLibraryDisposer = styleLibrary.subscribe(() => {
            if (!elements['style-library-dialog'].hidden) {
                populateStyleCategories();
                renderStyleLibrary();
            }
        });
        await Promise.all([
            loadSystemFonts(),
            renderRecentDocuments(),
        ]);
        renderLineage();
        // 头像属于非阻塞易用性增强。精简测试宿主或旧主进程可能尚未注册
        // 头像 IPC，不能因此延迟文档工作面就绪；索引到达后再刷新文脉即可。
        initializeLineageAvatars().then(renderLineage);
        updateIdentity();
        api.windowReady({ surface: 'scriptorium', version: 2, format: core.FORMAT });
    }

    document.addEventListener('DOMContentLoaded', initialize);
})();