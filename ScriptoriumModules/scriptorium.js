'use strict';

(() => {
    const api = window.scriptoriumAPI || window.docxAPI;
    const core = window.VDocCore;
    const styleLibrary = window.VDocStyleLibrary;
    const pagination = window.VDocPagination;
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
    };

    const elements = {};
    const $ = (id) => document.getElementById(id);

    function cacheElements() {
        [
            'document-state-dot', 'document-title', 'save-state',
            'outline-toggle-btn', 'focus-mode-btn', 'lineage-toggle-btn',
            'minimize-btn', 'maximize-btn', 'close-btn',
            'new-btn', 'new-deck-btn', 'open-btn', 'import-btn', 'save-btn', 'save-as-btn',
            'export-flow-html-btn', 'export-paged-html-btn', 'export-pdf-btn',
            'render-mode-btn', 'read-mode-btn', 'html-mode-btn', 'css-mode-btn',
            'font-family-select', 'font-size-select', 'text-color-input',
            'highlight-color-input', 'line-height-select', 'block-type-select',
            'insert-block-btn', 'insert-table-btn', 'find-btn',
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
            'unsaved-discard-btn', 'unsaved-save-btn', 'checkpoint-dialog',
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

    function disposeSlideRuntime() {
        try {
            state.slideRuntimeDisposer?.();
        } catch (error) {
            console.error('[Scriptorium] Slide runtime cleanup failed:', error);
        }
        state.slideRuntimeDisposer = null;
        state.slideRuntimeIdentity = null;
    }

    function createScopedDocument(runtimeRoot) {
        return new Proxy(document, {
            get(target, property) {
                if (property === 'querySelector') {
                    return (selector) =>
                        runtimeRoot.querySelector(selector) || target.querySelector(selector);
                }
                if (property === 'querySelectorAll') {
                    return (selector) => runtimeRoot.querySelectorAll(selector);
                }
                if (property === 'getElementById') {
                    return (id) =>
                        runtimeRoot.querySelector(`#${CSS.escape(String(id))}`)
                        || target.getElementById(id);
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }

    function recordProgrammableDiagnostics(diagnostics = []) {
        state.programmableContentDiagnostics = diagnostics.map((item) => ({
            ...item,
            createdAt: Date.now(),
        }));
        diagnostics.forEach((item) => {
            const log = item.level === 'refuse' ? console.error : console.warn;
            log('[Scriptorium Programmable Content]', item);
        });
    }

    function reviewRuntimeScript(source, context = {}) {
        const policy = window.ScriptoriumProgrammableContent;
        if (!policy) {
            return {
                allowed: false,
                level: 'refuse',
                findings: [{
                    level: 'refuse',
                    ruleId: 'review-engine-unavailable',
                    message: '可编程内容审查器未加载，拒绝执行脚本。',
                }],
                context,
            };
        }
        return policy.reviewJavaScript(source, context);
    }

    function diagnosticsFromReview(review, extra = {}) {
        return review.findings.map((finding) => ({
            ...finding,
            ...extra,
            context: review.context,
        }));
    }

    function runSlideRuntime(slide, runtimeRoot, surface = 'edit') {
        const runtimeSlide = parsedSlide(slide);
        if (!runtimeSlide.script || !runtimeRoot?.isConnected) {
            disposeSlideRuntime();
            return null;
        }

        const identity = {
            slideId: slide.id,
            surface,
            root: runtimeRoot,
        };
        const currentIdentity = state.slideRuntimeIdentity;
        if (
            currentIdentity
            && currentIdentity.slideId === identity.slideId
            && currentIdentity.surface === identity.surface
            && currentIdentity.root === identity.root
            && runtimeRoot.isConnected
        ) {
            return currentIdentity.runtime || null;
        }

        disposeSlideRuntime();

        // AI 页面脚本常用 data-bound 防止重复绑定。它属于运行时状态，
        // 不应阻止新建渲染树重新启动，也不应被持久化回 VPPTX。
        if (runtimeRoot.hasAttribute?.('data-bound')) {
            runtimeRoot.removeAttribute('data-bound');
        }
        runtimeRoot.querySelectorAll?.('[data-bound]').forEach((element) => {
            element.removeAttribute('data-bound');
        });

        const animationFrames = new Set();
        const timeouts = new Set();
        const review = reviewRuntimeScript(runtimeSlide.script, {
            documentKind: 'pptx',
            surface,
            scriptId: slide.id,
        });
        recordProgrammableDiagnostics(diagnosticsFromReview(review, {
            scriptId: slide.id,
            documentKind: 'pptx',
            surface,
        }));
        if (!review.allowed) {
            runtimeRoot.dataset.vdocScriptRefused = 'true';
            return null;
        }
        runtimeRoot.removeAttribute('data-vdoc-script-refused');

        const intervals = new Set();
        const cleanups = [];
        let disposed = false;

        // 页面脚本创建的 Canvas、SVG、控制节点等只属于当前运行时，
        // 不能在编辑器同步结构时写回 slide.html，否则每次重渲染都会
        // 再执行脚本并重复追加一份运行时 DOM。
        const runtimeMutationObserver = new MutationObserver((records) => {
            records.forEach((record) => {
                record.addedNodes.forEach((node) => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;
                    // SVG/MathML 元素没有 dataset，必须使用属性 API 标记。
                    node.setAttribute('data-vdoc-runtime-generated', 'true');
                });
            });
        });
        runtimeMutationObserver.observe(runtimeRoot, {
            childList: true,
            subtree: true,
        });
        cleanups.push(() => runtimeMutationObserver.disconnect());

        const trackedRequestAnimationFrame = (callback) => {
            if (disposed) return 0;
            const id = window.requestAnimationFrame((timestamp) => {
                animationFrames.delete(id);
                if (!disposed) callback(timestamp);
            });
            animationFrames.add(id);
            return id;
        };
        const trackedCancelAnimationFrame = (id) => {
            animationFrames.delete(id);
            window.cancelAnimationFrame(id);
        };
        const trackedSetTimeout = (callback, wait, ...args) => {
            if (disposed) return 0;
            const id = window.setTimeout(() => {
                timeouts.delete(id);
                if (!disposed) callback(...args);
            }, wait);
            timeouts.add(id);
            return id;
        };
        const trackedClearTimeout = (id) => {
            timeouts.delete(id);
            window.clearTimeout(id);
        };
        const trackedSetInterval = (callback, wait, ...args) => {
            if (disposed) return 0;
            const id = window.setInterval(() => {
                if (!disposed) callback(...args);
            }, wait);
            intervals.add(id);
            return id;
        };
        const trackedClearInterval = (id) => {
            intervals.delete(id);
            window.clearInterval(id);
        };
        const runtime = Object.freeze({
            surface,
            root: runtimeRoot,
            slideId: slide.id,
            addCleanup(callback) {
                if (typeof callback === 'function') cleanups.push(callback);
                return callback;
            },
            requestAnimationFrame: trackedRequestAnimationFrame,
            cancelAnimationFrame: trackedCancelAnimationFrame,
            setTimeout: trackedSetTimeout,
            clearTimeout: trackedClearTimeout,
            setInterval: trackedSetInterval,
            clearInterval: trackedClearInterval,
        });

        try {
            const execute = new Function(
                'scene',
                'deck',
                'runtime',
                'document',
                'requestAnimationFrame',
                'cancelAnimationFrame',
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                String(runtimeSlide.script)
            );
            const returned = execute.call(
                runtimeRoot,
                runtimeRoot,
                window.VCPDeck || null,
                runtime,
                createScopedDocument(runtimeRoot),
                trackedRequestAnimationFrame,
                trackedCancelAnimationFrame,
                trackedSetTimeout,
                trackedClearTimeout,
                trackedSetInterval,
                trackedClearInterval
            );
            if (typeof returned === 'function') cleanups.push(returned);
            else if (returned && typeof returned.dispose === 'function') {
                cleanups.push(() => returned.dispose());
            }
        } catch (error) {
            console.error(`[Scriptorium] Slide ${slide.id} runtime failed:`, error);
        }

        state.slideRuntimeDisposer = () => {
            if (disposed) return;
            disposed = true;
            animationFrames.forEach((id) => window.cancelAnimationFrame(id));
            timeouts.forEach((id) => window.clearTimeout(id));
            intervals.forEach((id) => window.clearInterval(id));
            animationFrames.clear();
            timeouts.clear();
            intervals.clear();
            [...cleanups].reverse().forEach((cleanup) => {
                try {
                    cleanup();
                } catch (error) {
                    console.error('[Scriptorium] Slide custom cleanup failed:', error);
                }
            });
        };
        state.slideRuntimeIdentity = {
            ...identity,
            runtime,
        };
        return runtime;
    }

    function runDocumentRuntime(runtimeRoot, surface = 'edit') {
        disposeSlideRuntime();
        if (!runtimeRoot?.isConnected) return null;

        const policy = window.ScriptoriumProgrammableContent;
        const scriptElements = [...runtimeRoot.querySelectorAll('script')];
        if (!scriptElements.length) {
            recordProgrammableDiagnostics([]);
            return null;
        }

        const animationFrames = new Set();
        const timeouts = new Set();
        const intervals = new Set();
        const cleanups = [];
        const diagnostics = [];
        let disposed = false;

        const trackedRequestAnimationFrame = (callback) => {
            if (disposed) return 0;
            const id = window.requestAnimationFrame((timestamp) => {
                animationFrames.delete(id);
                if (!disposed) callback(timestamp);
            });
            animationFrames.add(id);
            return id;
        };
        const trackedCancelAnimationFrame = (id) => {
            animationFrames.delete(id);
            window.cancelAnimationFrame(id);
        };
        const trackedSetTimeout = (callback, wait, ...args) => {
            if (disposed) return 0;
            const id = window.setTimeout(() => {
                timeouts.delete(id);
                if (!disposed) callback(...args);
            }, wait);
            timeouts.add(id);
            return id;
        };
        const trackedClearTimeout = (id) => {
            timeouts.delete(id);
            window.clearTimeout(id);
        };
        const trackedSetInterval = (callback, wait, ...args) => {
            if (disposed) return 0;
            const id = window.setInterval(() => {
                if (!disposed) callback(...args);
            }, wait);
            intervals.add(id);
            return id;
        };
        const trackedClearInterval = (id) => {
            intervals.delete(id);
            window.clearInterval(id);
        };

        scriptElements.forEach((scriptElement, index) => {
            const scriptId = scriptElement.id
                || scriptElement.dataset.vdocScript
                || `document-island-${index + 1}`;
            const island = scriptElement.closest(
                '[data-vdoc-interactive], [data-vdoc-component], section, article, figure, div'
            ) || runtimeRoot;

            if (scriptElement.dataset.vdocLibrary) {
                diagnostics.push({
                    level: 'info',
                    ruleId: 'local-library',
                    message: `${scriptElement.dataset.vdocLibrary} 使用 Scriptorium 内置本地依赖。`,
                    scriptId,
                    library: scriptElement.dataset.vdocLibrary,
                    documentKind: 'docx',
                    surface,
                });
                return;
            }

            if (
                scriptElement.dataset.vdocIgnoredSrc
                || scriptElement.type === 'application/x-vdoc-ignored-external'
            ) {
                diagnostics.push({
                    level: 'warn',
                    ruleId: 'external-script-ignored',
                    message: `未允许的外部脚本保持忽略：${
                        scriptElement.dataset.vdocIgnoredSrc || '未知来源'
                    }`,
                    scriptId,
                    source: scriptElement.dataset.vdocIgnoredSrc || '',
                    documentKind: 'docx',
                    surface,
                });
                return;
            }

            if (scriptElement.src || scriptElement.getAttribute('src')) {
                const dependency = policy?.dependencyForUrl(
                    scriptElement.getAttribute('src')
                ) || {
                    action: 'ignore',
                    level: 'refuse',
                    message: '依赖审查器不可用，外部脚本已拒绝。',
                };
                if (dependency.level === 'warn' || dependency.level === 'refuse') {
                    diagnostics.push({
                        level: dependency.level,
                        ruleId: dependency.code || 'external-script',
                        message: dependency.message,
                        scriptId,
                        documentKind: 'docx',
                        surface,
                    });
                } else {
                    diagnostics.push({
                        level: 'info',
                        ruleId: 'local-library-redirect',
                        message: dependency.message,
                        scriptId,
                        library: dependency.library,
                        source: dependency.source,
                        localUrl: dependency.localUrl,
                        documentKind: 'docx',
                        surface,
                    });
                }
                // 外链标签作为文档源码与导出依赖声明保留。通过 innerHTML
                // 插入的 script 不会自动执行，因此未允许的外链不会在编辑器加载。
                scriptElement.dataset.vdocDependencyAction = dependency.action;
                if (dependency.library) {
                    scriptElement.dataset.vdocLocalLibrary = dependency.library;
                }
                return;
            }

            const source = scriptElement.textContent || '';
            const review = reviewRuntimeScript(source, {
                documentKind: 'docx',
                surface,
                scriptId,
            });
            diagnostics.push(...diagnosticsFromReview(review, {
                scriptId,
                documentKind: 'docx',
                surface,
            }));
            // 内联脚本节点保留为 VDOCX 文档真相；运行时只显式执行审查通过的源码。
            scriptElement.dataset.vdocReviewLevel = review.level;
            if (!review.allowed) {
                island.dataset.vdocScriptRefused = 'true';
                return;
            }
            island.removeAttribute('data-vdoc-script-refused');
            island.removeAttribute('data-bound');
            island.querySelectorAll('[data-bound]').forEach((node) =>
                node.removeAttribute('data-bound')
            );

            const runtime = Object.freeze({
                surface,
                root: island,
                scriptId,
                addCleanup(callback) {
                    if (typeof callback === 'function') cleanups.push(callback);
                    return callback;
                },
                requestAnimationFrame: trackedRequestAnimationFrame,
                cancelAnimationFrame: trackedCancelAnimationFrame,
                setTimeout: trackedSetTimeout,
                clearTimeout: trackedClearTimeout,
                setInterval: trackedSetInterval,
                clearInterval: trackedClearInterval,
            });

            try {
                const execute = new Function(
                    'scene',
                    'runtime',
                    'document',
                    'requestAnimationFrame',
                    'cancelAnimationFrame',
                    'setTimeout',
                    'clearTimeout',
                    'setInterval',
                    'clearInterval',
                    source
                );
                const returned = execute.call(
                    island,
                    island,
                    runtime,
                    createScopedDocument(island),
                    trackedRequestAnimationFrame,
                    trackedCancelAnimationFrame,
                    trackedSetTimeout,
                    trackedClearTimeout,
                    trackedSetInterval,
                    trackedClearInterval
                );
                if (typeof returned === 'function') cleanups.push(returned);
                else if (returned && typeof returned.dispose === 'function') {
                    cleanups.push(() => returned.dispose());
                }
            } catch (error) {
                diagnostics.push({
                    level: 'refuse',
                    ruleId: 'runtime-execution-error',
                    message: `脚本执行失败：${error.message}`,
                    scriptId,
                    documentKind: 'docx',
                    surface,
                });
                console.error(`[Scriptorium] Document island ${scriptId} failed:`, error);
            }
        });

        recordProgrammableDiagnostics(diagnostics);
        state.slideRuntimeDisposer = () => {
            if (disposed) return;
            disposed = true;
            animationFrames.forEach((id) => window.cancelAnimationFrame(id));
            timeouts.forEach((id) => window.clearTimeout(id));
            intervals.forEach((id) => window.clearInterval(id));
            animationFrames.clear();
            timeouts.clear();
            intervals.clear();
            [...cleanups].reverse().forEach((cleanup) => {
                try {
                    cleanup();
                } catch (error) {
                    console.error('[Scriptorium] Document island cleanup failed:', error);
                }
            });
        };
        state.slideRuntimeIdentity = {
            slideId: state.document?.manifest?.id || 'document',
            surface,
            root: runtimeRoot,
            runtime: { diagnostics },
        };
        return { diagnostics };
    }

    function activateProgrammableContent(surface = state.mode) {
        if (isSlideDeck()) {
            activateCurrentSlideRuntime(surface);
            return;
        }
        const root = surface === 'read' ? getReadRoot() : getRenderRoot();
        const runtimeRoot = surface === 'read'
            ? root?.querySelector('.vdoc-paged-runtime')
            : root?.querySelector('.vdoc-flow-runtime');
        if (runtimeRoot) runDocumentRuntime(runtimeRoot, surface);
        else disposeSlideRuntime();
    }

    function activateCurrentSlideRuntime(surface = state.mode) {
        if (!isSlideDeck()) {
            disposeSlideRuntime();
            return;
        }
        const slide = activeSlide();
        const root = surface === 'read' ? getReadRoot() : getRenderRoot();
        let runtimeRoot;
        if (surface === 'read') {
            runtimeRoot = root?.querySelector(
                `[data-vdoc-slide-id="${CSS.escape(slide?.id || '')}"]`
            ) || root?.querySelectorAll('.vdoc-page')?.[state.activeSlideIndex];
        } else {
            runtimeRoot = root?.querySelector('.vdoc-slide-editor-runtime');
        }
        if (!runtimeRoot) {
            disposeSlideRuntime();
            return;
        }
        runSlideRuntime(slide, runtimeRoot, surface);
    }

    function renderDocument() {
        disposeSlideRuntime();
        if (!state.document) return;
        state.document = core.normalizeDocument(state.document);
        const root = getRenderRoot() || elements['page-stream'].attachShadow({ mode: 'open' });
        state.pageObserver?.disconnect();
        root.replaceChildren();

        const style = document.createElement('style');
        style.textContent = buildDocumentStyle('edit');
        const runtime = document.createElement('div');
        runtime.dataset.sceneKind = state.document.manifest.scene.kind;
        runtime.style.setProperty('--vdoc-zoom', String(state.zoom / 100));
        root.append(style, runtime);

        if (isSlideDeck()) {
            const slide = activeSlide();
            const source = parsedSlide(slide);
            runtime.className = 'vdoc-runtime vdoc-slide-editor-runtime';
            runtime.dataset.slideId = slide?.id || '';
            runtime.innerHTML = source.html;
            const slideStyle = document.createElement('style');
            slideStyle.dataset.vdocSlideStyle = slide?.id || '';
            slideStyle.textContent = source.css;
            root.appendChild(slideStyle);
        } else {
            pagination.renderContinuous(parsedDocument().html, runtime, {
                ensureIds: core.ensureTextNodeIds,
            });
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
        style.textContent = buildDocumentStyle('paged');
        const runtime = document.createElement('div');
        runtime.dataset.sceneKind = state.document.manifest.scene.kind;
        root.append(style, runtime);
        const previewHtml = isSlideDeck()
            ? state.document.source.slides.map((slide) => {
                const source = parsedSlide(slide);
                return `<section data-vdoc-slide data-vdoc-slide-id="${escapeHtml(slide.id)}">${source.html}<style>${source.css}</style></section>`;
            }).join('\n')
            : parsedDocument().html;
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
                html = buildPagedExportHtml();
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
            if (!result?.success) return false;
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

    function firstFontFamily(fontFamily) {
        return String(fontFamily || '')
            .split(',')[0]
            .trim()
            .replace(/^["']|["']$/g, '');
    }

    function syncSelectClosestFont(select, fontFamily) {
        if (!select) return;
        let lookup = state.fontOptionLookup.get(select);
        if (!lookup || lookup.size !== select.options.length) {
            lookup = new Map([...select.options].map((option) => [
                firstFontFamily(option.value).toLowerCase(),
                option.value,
            ]));
            state.fontOptionLookup.set(select, lookup);
        }
        const value = lookup.get(firstFontFamily(fontFamily).toLowerCase());
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

    function syncFormattingControls(target) {
        const element = target?.nodeType === Node.ELEMENT_NODE
            ? target
            : target?.parentElement;
        const textElement = element?.closest?.('[data-vdoc-text], span, strong, em, a')
            || state.activeEditableBlock;
        if (!textElement) return;

        const computed = getComputedStyle(textElement);
        syncSelectClosestFont(elements['font-family-select'], computed.fontFamily);
        syncSelectClosestFont(elements['selection-font-family'], computed.fontFamily);
        syncSelectClosestSize(elements['font-size-select'], computed.fontSize);
        syncSelectClosestSize(elements['selection-font-size'], computed.fontSize);

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

    function applyInlineCommand(command, preferSaved = false) {
        const styles = {
            bold: ['fontWeight', '700'],
            italic: ['fontStyle', 'italic'],
            underline: ['textDecoration', 'underline'],
            strikethrough: ['textDecoration', 'line-through'],
        };
        const style = styles[command];
        return style ? applyInlineStyle(style[0], style[1], preferSaved) : false;
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

    function insertStableSoftBreak(range, selection) {
        // contenteditable 段尾的单个 BR 同时承担换行和空行占位语义，
        // Chromium 会重新规范化其 DOM 与光标。显式补一个占位 BR，
        // 并把光标放在两者之间，可避免“回车偶尔无效/下一字位置异常”。
        const trailingRange = range.cloneRange();
        trailingRange.selectNodeContents(range.commonAncestorContainer);
        try {
            trailingRange.setStart(range.endContainer, range.endOffset);
        } catch {
            trailingRange.setStartAfter(range.commonAncestorContainer);
        }
        const atEnd = trailingRange.collapsed || trailingRange.toString().length === 0;

        const lineBreak = document.createElement('br');
        range.insertNode(lineBreak);
        if (atEnd && !lineBreak.nextSibling) {
            lineBreak.after(document.createElement('br'));
        }
        range.setStartAfter(lineBreak);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return lineBreak;
    }

    function handleBlockEditingKeydown(event) {
        const editable = event.target.closest?.('[data-vdoc-text]');
        const selection = getRenderRoot()?.getSelection?.() || window.getSelection();

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

            // 在块的绝对开头按 Enter，表示在当前块上方创建一个新段落。
            // 这为文档/Scene 的首块提供稳定的“向前插入”入口；其他位置
            // 仍沿用块内软换行，Shift+Enter 则继续在下方新增结构块。
            if (caretIsAtBlockStart(selection, block)) {
                insertParagraphBeforeBlock(block);
                return;
            }

            // Enter 必须以当前光标为准。当前选区折叠时不能回退到此前保存的
            // 全文/跨块范围，否则一次回车可能误删整个旧选区。
            const range = selection?.rangeCount
                ? selection.getRangeAt(0)
                : selectedRange();
            if (!range || !block.contains(range.commonAncestorContainer)) return;
            range.deleteContents();
            insertStableSoftBreak(range, currentRenderSelection());
            queueRenderedNodeUpdate(block);
            window.ScriptoriumPretext?.evictNode(block.dataset.vdocText);
            markDirty({ coalesce: true });
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
        return state.sourceEditor?.getValue() ?? elements['source-editor'].value;
    }

    function setSourceValue(value) {
        if (state.sourceEditor) state.sourceEditor.setValue(String(value || ''));
        else elements['source-editor'].value = String(value || '');
    }

    function validateSource() {
        const source = getSourceValue();
        let valid = true;
        let message = '源码有效';
        if (state.sourceMode === 'html') {
            const template = document.createElement('template');
            template.innerHTML = source;
            // script 由可编程内容策略执行依赖本地化和 warn/refuse 审查，
            // 不能再被旧源码校验器统一拒绝，否则合法本地依赖也无法应用。
            const blocked = template.content.querySelector('iframe,object,embed');
            if (blocked) {
                valid = false;
                message = `禁止使用 <${blocked.tagName.toLowerCase()}>`;
            } else if (template.content.querySelector('script')) {
                message = '源码有效 · 脚本将在应用时执行依赖本地化与安全审查';
            }
        } else {
            const opens = (source.match(/\{/g) || []).length;
            const closes = (source.match(/\}/g) || []).length;
            if (opens !== closes) {
                valid = false;
                message = `CSS 花括号不平衡：${opens} / ${closes}`;
            }
        }
        elements['source-diagnostics'].textContent = message;
        elements['source-diagnostics'].classList.toggle('valid', valid);
        elements['source-diagnostics'].classList.toggle('invalid', !valid);
        return valid;
    }

    function refreshSourceColorMarks() {
        if (!state.sourceEditor) return;
        state.sourceColorMarks.forEach((mark) => mark.clear());
        state.sourceColorMarks = [];
        const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
        state.sourceEditor.eachLine((lineHandle) => {
            const line = state.sourceEditor.getLineNumber(lineHandle);
            let match;
            while ((match = hexPattern.exec(lineHandle.text))) {
                const mark = state.sourceEditor.markText(
                    { line, ch: match.index },
                    { line, ch: match.index + match[0].length },
                    { className: 'cm-vdoc-color', css: `--cm-color:${match[0]}` }
                );
                state.sourceColorMarks.push(mark);
            }
        });
    }

    function sourceColorAtCursor() {
        if (!state.sourceEditor) return null;
        const cursor = state.sourceEditor.getCursor();
        const line = state.sourceEditor.getLine(cursor.line);
        const pattern = /#[0-9a-fA-F]{3,8}\b/g;
        let match;
        while ((match = pattern.exec(line))) {
            if (cursor.ch >= match.index && cursor.ch <= match.index + match[0].length) {
                return {
                    value: match[0],
                    from: { line: cursor.line, ch: match.index },
                    to: { line: cursor.line, ch: match.index + match[0].length },
                };
            }
        }
        return null;
    }

    function syncSourceColorTool() {
        const color = sourceColorAtCursor();
        if (!color || !/^#[0-9a-fA-F]{6}$/.test(color.value)) return;
        elements['source-color-input'].value = color.value;
        elements['source-color-swatch'].style.background = color.value;
    }

    function replaceSourceColor(value) {
        if (!state.sourceEditor) return;
        const color = sourceColorAtCursor();
        if (color) state.sourceEditor.replaceRange(value, color.from, color.to);
        else state.sourceEditor.replaceSelection(value);
        elements['source-color-swatch'].style.background = value;
        state.sourceEditor.focus();
    }

    function formatSource() {
        const source = getSourceValue();
        if (state.sourceMode === 'html') {
            setSourceValue(core.formatHtml(source));
        } else {
            setSourceValue(core.sanitizeCss(source)
                .replace(/\s*\{\s*/g, ' {\n    ')
                .replace(/;\s*/g, ';\n    ')
                .replace(/\s*\}\s*/g, '\n}\n')
                .replace(/[ \t]+\n/g, '\n'));
        }
        validateSource();
        refreshSourceColorMarks();
    }

    function initializeSourceEditor() {
        if (!window.CodeMirror || state.sourceEditor) return;
        state.sourceEditor = window.CodeMirror.fromTextArea(elements['source-editor'], {
            mode: 'htmlmixed',
            theme: 'material-darker',
            lineNumbers: true,
            lineWrapping: true,
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            autoCloseBrackets: true,
            autoCloseTags: true,
            viewportMargin: 20,
        });
        state.sourceEditor.on('change', () => {
            validateSource();
            window.clearTimeout(state.sourceEditorTimer);
            state.sourceEditorTimer = window.setTimeout(refreshSourceColorMarks, 180);
        });
        state.sourceEditor.on('cursorActivity', syncSourceColorTool);
    }

    function switchMode(mode) {
        if (!state.ready) return;
        if (state.mode === 'render' && mode !== 'render') {
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
        if (command === 'image') return insertImage();
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

    function insertImage() {
        showToast('图片资源本地化将在 VDOCX 资源层接入。');
        return true;
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
        const frame = elements['style-preview-frame'];
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
${documentCssForShadow()}
${parsedSlide(slide).css}

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
        stage.innerHTML = parsedSlide(slide).html;
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

    async function createEditor(documentModel = null, metadata = {}) {
        const generation = state.documentGeneration += 1;
        state.loading = true;
        elements['loading-state'].hidden = false;
        updateIdentity();
        try {
            // 打开旧工程必须保持无副作用。依赖升级不能位于载入关键路径，
            // 否则单个异常历史节点会阻止整个文档进入渲染界面。
            const nextDocument = documentModel
                ? core.normalizeDocument(documentModel)
                : core.createDocument();
            if (generation !== state.documentGeneration) return false;
            state.document = nextDocument;
            state.currentPath = metadata.filePath || null;
            const projectExtension = core.extensionForKind(state.document.manifest.scene.kind);
            const fallbackName = state.document.manifest.scene.kind === core.PROJECT_KINDS.SLIDE_DECK
                ? '未命名演示.vpptx'
                : '未命名文稿.vdocx';
            state.currentName = metadata.name || state.document.manifest.title || fallbackName;
            if (!state.currentName.toLowerCase().endsWith(projectExtension)) {
                state.currentName = `${state.currentName.replace(/\.[^.]+$/, '')}${projectExtension}`;
            }
            state.checkpoints = [...state.document.checkpoints];
            state.documentRevision = 0;
            state.previewRevision = -1;
            state.previewResult = null;
            const embeddedStyles = Array.isArray(state.document.manifest.embeddedStyles)
                ? state.document.manifest.embeddedStyles
                : [];
            embeddedStyles.forEach((style) => {
                styleLibrary.register(style, {
                    packId: `document.${state.document.manifest.id}`,
                    conflict: 'replace',
                });
            });
            state.usedAdvancedStyleIds = new Set(
                Array.isArray(state.document.manifest.styleDependencies)
                    ? state.document.manifest.styleDependencies.filter((styleId) => styleLibrary.get(styleId))
                    : []
            );
            state.ready = true;
            state.activeSlideIndex = 0;
            state.selectionRange = null;
            state.selectionText = '';
            state.selectionBlockIds = [];
            state.explicitBlockSelection = false;
            state.blockSelectionAnchorId = null;
            state.history = [];
            state.historyIndex = -1;
            elements['welcome-state'].hidden = true;
            elements['document-workspace'].hidden = false;
            const presentation = isSlideDeck();
            elements['read-mode-btn'].querySelector('span').textContent =
                presentation ? '放映预览' : '阅读预览';
            elements['export-flow-html-btn'].title =
                presentation ? '导出单文件演示 HTML' : '导出连续流语义 HTML';
            elements['export-paged-html-btn'].title =
                presentation ? '导出单文件演示 HTML' : '导出逐页富文档 HTML';
            elements['export-paged-html-btn'].hidden = presentation;
            renderDocument();
            switchMode('render');
            captureSnapshot();
            markSaved();
            renderLineage();
            showToast(documentModel ? 'VDOCX 已展开' : '共笔新稿已建立', 'success');
            return true;
        } finally {
            if (generation === state.documentGeneration) {
                state.loading = false;
                elements['loading-state'].hidden = true;
                updateIdentity();
            }
        }
    }

    async function openResult(result) {
        if (!result?.success) return;
        if (result.kind === 'imported') {
            const title = String(result.name || '导入文稿').replace(/\.[^.]+$/, '');
            const isPresentation = result.importedKind === 'pptx';
            const model = core.createDocument({
                title,
                kind: isPresentation ? core.PROJECT_KINDS.SLIDE_DECK : undefined,
                source: isPresentation ? undefined : String(result.html || ''),
                slides: isPresentation ? result.slides : undefined,
                page: isPresentation ? result.page : undefined,
            });
            model.manifest.import = result.importMetadata || {
                sourceFormat: result.importedKind,
                sourceName: result.name,
            };
            const projectType = isPresentation ? 'VPPTX' : 'VDOCX';
            await createEditor(model, {
                filePath: null,
                name: `${title}${isPresentation ? '.vpptx' : '.vdocx'}`,
                imported: true,
            });
            markDirty();
            const warningCount = model.manifest.import?.warnings?.length || 0;
            showToast(
                warningCount
                    ? `已导入 ${result.importedKind.toUpperCase()} · ${warningCount} 条转换提示`
                    : `已导入 ${result.importedKind.toUpperCase()}，请保存为 ${projectType}`,
                warningCount ? 'info' : 'success',
                4200
            );
            return;
        }

        const bytes = Uint8Array.from(result.bytes || []);
        const model = core.parse(bytes);
        await createEditor(model, result);
    }

    async function chooseOpen() {
        await runAfterUnsavedDecision('打开另一份文档前，可以保存当前修改，或舍弃这些修改。', async () => {
            try {
                await openResult(await api.chooseOpen());
                await renderRecentDocuments();
            } catch (error) {
                showToast(`打开失败：${error.message}`, 'error', 5000);
            }
        });
    }

    async function chooseImport() {
        await runAfterUnsavedDecision(
            '导入文档会建立一份新的 VDOCX 文稿。可以先保存当前修改，或舍弃这些修改。',
            async () => {
                try {
                    const result = await api.chooseImport();
                    await openResult(result);
                    if (result?.success) await renderRecentDocuments();
                } catch (error) {
                    showToast(`导入失败：${error.message}`, 'error', 5000);
                }
            }
        );
    }

    async function openPath(filePath) {
        await runAfterUnsavedDecision('载入另一份文档前，可以保存当前修改，或舍弃这些修改。', async () => {
            try {
                await openResult(await api.readPath(filePath));
            } catch (error) {
                showToast(`载入失败：${error.message}`, 'error', 5000);
            }
        });
    }

    async function saveDocument(saveAs = false) {
        if (!state.ready || state.saving) return false;
        finalizeEditBurst();
        if (state.mode === 'html' || state.mode === 'css') {
            if (applySourceChanges(false) === false) return false;
        }
        const generation = state.documentGeneration;
        const savedRevision = state.documentRevision;
        state.saving = true;
        updateIdentity();
        try {
            state.document.checkpoints = state.checkpoints;
            state.document.manifest.styleDependencies = [...state.usedAdvancedStyleIds];
            state.document.manifest.embeddedStyles = [...state.usedAdvancedStyleIds]
                .map((styleId) => styleLibrary.get(styleId))
                .filter(Boolean);
            const bytes = new TextEncoder().encode(core.serialize(state.document));
            const result = await api.save({
                filePath: state.currentPath,
                suggestedName: state.currentName,
                saveAs,
                bytes,
            });
            if (!result?.success || generation !== state.documentGeneration) return false;
            state.currentPath = result.filePath;
            state.currentName = result.name;
            if (state.documentRevision === savedRevision) markSaved();
            else updateIdentity();
            await renderRecentDocuments();
            showToast(`已保存 · ${result.name}`, 'success');
            return true;
        } catch (error) {
            showToast(`保存失败：${error.message}`, 'error', 5000);
            return false;
        } finally {
            state.saving = false;
            updateIdentity();
        }
    }

    function persistCheckpointToFile(reason = '刻点') {
        if (!state.ready || !state.document) return Promise.resolve(false);
        const generation = state.documentGeneration;

        // 刻点元数据需要进入文件，但不能递增正文 revision：
        // pending PR 的 baseRevision 依赖该值，若提交刻点本身增加 revision，
        // 随后的批准会被误判为正文修订冲突。
        state.document.checkpoints = state.checkpoints;
        state.dirty = true;
        updateIdentity();

        state.checkpointSaveQueue = state.checkpointSaveQueue
            .catch(() => false)
            .then(async () => {
                while (state.saving && generation === state.documentGeneration) {
                    await new Promise((resolve) => window.setTimeout(resolve, 40));
                }
                if (generation !== state.documentGeneration) return false;
                const saved = await saveDocument(false);
                if (!saved) {
                    showToast(`${reason}已建立，但自动保存到文件失败`, 'error', 5000);
                }
                return saved;
            });
        return state.checkpointSaveQueue;
    }

    function requestUnsavedDecision(message) {
        if (!state.dirty) return Promise.resolve('discard');
        if (state.unsavedResolver) {
            return Promise.resolve('cancel');
        }
        elements['unsaved-dialog-message'].textContent = message;
        elements['unsaved-document-name'].textContent = state.currentName;
        elements['unsaved-dialog'].hidden = false;
        return new Promise((resolve) => {
            state.unsavedResolver = resolve;
        });
    }

    function resolveUnsavedDecision(decision) {
        const resolve = state.unsavedResolver;
        if (!resolve) return;
        state.unsavedResolver = null;
        elements['unsaved-dialog'].hidden = true;
        resolve(decision);
    }

    async function runAfterUnsavedDecision(message, action) {
        if (!state.dirty) return action();
        const decision = await requestUnsavedDecision(message);
        if (decision === 'cancel') return false;
        if (decision === 'save' && !await saveDocument(false)) return false;
        return action();
    }

    async function renderRecentDocuments() {
        let recent = [];
        try {
            recent = await api.listRecent();
        } catch {}
        elements['recent-documents'].replaceChildren(...recent.slice(0, 6).map((item) => {
            const button = document.createElement('button');
            button.className = 'recent-document';
            button.textContent = item.name;
            button.title = item.path;
            button.addEventListener('click', () => openPath(item.path));
            return button;
        }));
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
            state.renderSurfaceAbortController?.abort();
            if (state.formattingSyncFrame !== null) {
                window.cancelAnimationFrame(state.formattingSyncFrame);
            }
            disposeSlideRuntime();
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
        if (!api || !core || !styleLibrary || !pagination
            || !window.ScriptoriumVisibility || !window.ScriptoriumAgentModule) {
            throw new Error('Scriptorium 原生文档内核或模块未载入。');
        }
        cacheElements();
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