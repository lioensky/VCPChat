'use strict';

(() => {
    const api = window.scriptoriumAPI || window.docxAPI;
    const core = window.VDocCore;
    const containerModule = window.VDocContainer;
    const styleLibrary = window.VDocStyleLibrary;
    const pagination = window.VDocPagination;
    const asyncModule = window.ScriptoriumAsync;
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
            'outline-toggle-btn', 'focus-mode-btn', 'lineage-toggle-btn',
            'minimize-btn', 'maximize-btn', 'close-btn',
            'new-btn', 'new-deck-btn', 'open-btn', 'import-btn', 'save-btn', 'save-as-btn',
            'collect-external-resources',
            'export-flow-html-btn', 'export-paged-html-btn', 'export-pdf-btn',
            'render-mode-btn', 'read-mode-btn', 'html-mode-btn', 'css-mode-btn',
            'font-family-select', 'font-size-select', 'text-color-input',
            'highlight-color-input', 'line-height-select', 'block-type-select',
            'insert-block-btn', 'insert-table-btn', 'find-btn',
            'shape-kind-select', 'insert-shape-btn', 'object-context-menu',
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
        elements['document-title'].textContent = state.currentName || '未命名文稿.vdocx';
        elements['document-title'].title = state.currentPath || '尚未保存到磁盘';
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

    function parsedDocument() {
        const source = String(state.document?.source?.content || '');
        const template = document.createElement('template');
        template.innerHTML = source;
        const styles = [...template.content.querySelectorAll('style')]
            .map((style) => style.textContent || '');
        template.content.querySelectorAll('style').forEach((style) => style.remove());
        return {
            html: template.innerHTML,
            css: core.sanitizeCss(styles.join('\n\n')),
        };
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
            state.document.source.content = String(source || '');
        }
    }

    function resolveRuntimeResources(source) {
        return state.resourceResolver?.resolveHtml(source) || String(source || '');
    }

    function currentSourceCss() {
        return isSlideDeck()
            ? state.document?.source?.deckCss || ''
            : parsedDocument().css;
    }

    function setCurrentSourceCss(css) {
        if (isSlideDeck()) {
            state.document.source.deckCss = core.sanitizeCss(css);
            return;
        }
        const documentSource = parsedDocument();
        state.document.source.content = `<style data-vdoc-document-style>
${core.sanitizeCss(css)}
</style>
${core.formatHtml(core.ensureTextNodeIds(documentSource.html))}`;
    }

    function documentCssForShadow() {
        const css = isSlideDeck()
            ? state.document.source.deckCss
            : parsedDocument().css;
        return String(css || '')
            .replace(/(^|})\s*:root\s*\{/g, '$1\n:host {')
            .replace(/(^|})\s*html\s*,\s*body\s*\{/g, '$1\n:host {')
            .replace(/(^|})\s*body\s*\{/g, '$1\n:host {');
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
    width: min(calc(100% - 48px), var(--vdoc-page-width));
    min-height: calc(100% - 64px);
    margin: 0 auto;
    padding: clamp(28px, 5vw, 72px) clamp(22px, 6vw, 84px) 96px;
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
        if (!state.document || !objectModule) return false;
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
                resolveRuntimeResources(parsedDocument().html),
                runtime,
                {
                    ensureIds: core.ensureTextNodeIds,
                }
            );
        }
        renderMathNodes(root);

        root.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
            editable.contentEditable = 'true';
            // Chromium 的原生拼写服务会在 contenteditable 输入和换行时同步参与
            // 文本标注。中文富文档收益很低，却可能造成与文档长度无关的按键抖动。
            editable.spellcheck = false;
        });
        state.renderedTextBlocks = [...root.querySelectorAll('[data-vdoc-text]')];
        state.pendingRenderedNodes.clear();
        state.pendingRenderedAttributes.clear();
        // 对象控制器使用捕获阶段拦截。必须先于文字选择委托注册，
        // 否则对象上的首次 pointerdown 会先触发空白建段或文本选择。
        state.objectController?.bindRoot(root);
        bindRenderSurface(root);
        updatePageZoomLayout(root);
        if (state.mode === 'render') {
            window.requestAnimationFrame(() => {
                if (state.mode === 'render') activateProgrammableContent('render');
            });
        }
        renderOutline();
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
            ensureIds: core.ensureTextNodeIds,
            scene: core.createSceneConfig(state.document.manifest.scene),
            slideDeckKind: core.PROJECT_KINDS.SLIDE_DECK,
            zoom: state.zoom,
        });
        renderMathNodes(root);
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
                : parsedDocument().css)
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
        return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${parsedDocument().css}
${compiledStyles}
html,body{margin:0;min-height:100%}
body{padding:clamp(24px,6vw,96px)}
.vdoc-flow-export{width:min(100%,210mm);margin:0 auto}
@media print{body{padding:0}}
</style>
</head>
<body>
<main class="vdoc-flow-export">
${parsedDocument().html}
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
            showToast(`已导出 · ${result.name}`, 'success');
            return true;
        } catch (error) {
            showToast(`导出失败：${error.message}`, 'error', 5000);
            return false;
        }
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

        root.addEventListener('input', (event) => {
            const editable = event.target.closest?.('[data-vdoc-text]');
            if (!editable) return;
            queueRenderedNodeUpdate(editable);
            window.ScriptoriumPretext?.evictNode(editable.dataset.vdocText);
            markDirty({ coalesce: true });
        }, listenerOptions);

        root.addEventListener('contextmenu', (event) => {
            if (!state.explicitBlockSelection && !captureCurrentSelection()) return;
            event.preventDefault();
            showSelectionBar(event.clientX, event.clientY);
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

    function syncFormattingControls(target) {
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
            const tbody = document.createElement('tbody');
            for (let row = 0; row < 3; row += 1) {
                const tr = document.createElement('tr');
                for (let column = 0; column < 3; column += 1) {
                    const cell = document.createElement('td');
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
        if (!state.ready || state.mode !== 'render' || isSlideDeck()
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

    function switchMode(mode) {
        if (!state.ready) return;
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
                updateCurrentPage(getReadRoot(), elements['read-host']);
                if (state.mode === 'read') {
                    activateProgrammableContent('read');
                }
            });
        } else if (isRender) {
            window.requestAnimationFrame(() => {
                if (state.mode === 'render') activateProgrammableContent('render');
            });
            state.pageObserver?.disconnect();
            elements['page-status'].textContent = isSlideDeck()
                ? `第 ${state.activeSlideIndex + 1} 页 / 共 ${state.document.source.slides.length} 页`
                : '连续编辑';
        }

        if (isSource) {
            state.sourceMode = mode;
            elements['source-title'].textContent = mode === 'html'
                ? (isSlideDeck() ? '当前页完整源码' : 'HTML 源码')
                : (isSlideDeck() ? '演示全局 CSS' : '文档全局 CSS');
            elements['source-description'].textContent = mode === 'html'
                ? (isSlideDeck()
                    ? '当前页的 <style>、HTML、依赖声明与交互脚本均在此编辑'
                    : '人类编辑渲染结果，AI 始终以此结构为真相')
                : (isSlideDeck()
                    ? '应用于全部页面和演示共享外观；页内样式请编辑当前页完整源码'
                    : '应用于整份文档的共享样式与 CSS 动画');
            state.sourceEditor?.setOption('mode', mode === 'html' ? 'htmlmixed' : 'css');
            if (mode === 'html') setCurrentSourceHtml(currentSourceHtml());
            setSourceValue(mode === 'html' ? currentSourceHtml() : currentSourceCss());
            window.setTimeout(() => {
                state.sourceEditor?.refresh();
                state.sourceEditor?.focus();
                validateSource();
                refreshSourceColorMarks();
            }, 0);
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
            const policy = window.ScriptoriumProgrammableContent;
            const normalized = policy?.normalizeHtmlDependencies
                ? policy.normalizeHtmlDependencies(source, {
                    phase: 'human-source-apply',
                    documentKind: isSlideDeck() ? 'pptx' : 'docx',
                    slideIndex: isSlideDeck() ? state.activeSlideIndex : null,
                })
                : {
                    html: source,
                    dependencies: [],
                    diagnostics: [],
                };
            setCurrentSourceHtml(normalized.html);
            state.document.manifest.programmableDependencies = [
                ...new Set([
                    ...(state.document.manifest.programmableDependencies || []),
                    ...(normalized.dependencies || []),
                ]),
            ];
            recordProgrammableDiagnostics(normalized.diagnostics || []);
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
        flushPendingRenderedEdits();
        const root = getRenderRoot();
        if (!root || !object) return false;
        objectModule?.normalizeObjectNode(object, isSlideDeck());

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

    function showSelectionBar(x, y) {
        const bar = elements['selection-format-bar'];
        bar.hidden = false;
        bar.style.left = `${Math.min(innerWidth - 360, Math.max(10, x + 8))}px`;
        bar.style.top = `${Math.min(innerHeight - 60, Math.max(10, y + 8))}px`;
    }

    function hideSelectionBar() {
        elements['selection-format-bar'].hidden = true;
    }

    function inferSelectionTarget() {
        const range = state.selectionRange;
        const blocks = state.explicitBlockSelection ? blocksForIds() : editableBlocksForRange(range);
        if (blocks.length > 1) return 'block';
        const editable = blocks[0];
        if (/^H[1-6]$/.test(editable?.tagName || '')) return 'heading';
        if (editable && range?.toString().trim() === editable.textContent.trim()) return 'paragraph';
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
        const items = core.extractOutline(parsedDocument().html);
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
            const target = getRenderRoot()?.querySelector(`[data-vdoc-text="${CSS.escape(item.id)}"]`);
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
            item.innerHTML = '<div class="checkpoint-meta"><span class="checkpoint-source"></span><time></time></div><h3></h3><p></p><span class="checkpoint-status"></span>';
            const authorName = checkpoint.author?.name || checkpoint.author?.signature || '';
            item.querySelector('.checkpoint-source').textContent = checkpoint.source === 'agent'
                ? `AI 协作${authorName ? ` · ${authorName}` : ''}`
                : `人类刻点${authorName ? ` · ${authorName}` : ''}`;
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
        elements['find-btn'].addEventListener('click', () => {
            const query = prompt('查找文字');
            if (query) window.find(query);
        });
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
        elements['focus-mode-btn'].addEventListener('click', () => document.body.classList.toggle('focus-mode'));
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
        window.addEventListener('pointerdown', (event) => {
            if (!elements['selection-format-bar'].contains(event.target)) hideSelectionBar();
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
                closeMediaDialog();
                closeStyleLibrary();
                hideSelectionBar();
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
            finalizeEditBurst();
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
        if (!api || !core || !containerModule || !window.JSZip
            || !styleLibrary || !pagination || !asyncModule
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
        await Promise.all([loadSystemFonts(), renderRecentDocuments()]);
        renderLineage();
        updateIdentity();
        api.windowReady({ surface: 'scriptorium', version: 2, format: core.FORMAT });
    }

    document.addEventListener('DOMContentLoaded', initialize);
})();