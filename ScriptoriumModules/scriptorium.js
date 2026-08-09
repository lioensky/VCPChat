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
        sourceUpdateTimer: null,
        metricsTimer: null,
        paginationTimer: null,
        documentRevision: 0,
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
            'lineage-flow', 'checkpoint-count',
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

    function markDirty() {
        if (!state.ready || state.loading) return;
        state.dirty = true;
        state.documentRevision += 1;
        state.previewRevision = -1;
        state.previewResult = null;
        updateIdentity();
        scheduleMetrics();
    }

    function markSaved() {
        state.dirty = false;
        updateIdentity();
    }

    function captureSnapshot() {
        if (!state.document) return;
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

    function currentSourceHtml() {
        return isSlideDeck() ? activeSlide()?.html || '' : state.document?.source?.html || '';
    }

    function setCurrentSourceHtml(html) {
        if (isSlideDeck()) {
            const slide = activeSlide();
            if (slide) slide.html = core.formatHtml(core.ensureTextNodeIds(html));
        } else {
            state.document.source.html = core.formatHtml(core.ensureTextNodeIds(html));
        }
    }

    function currentSourceCss() {
        return isSlideDeck() ? activeSlide()?.css || '' : state.document?.source?.css || '';
    }

    function setCurrentSourceCss(css) {
        if (isSlideDeck()) {
            const slide = activeSlide();
            if (slide) slide.css = core.sanitizeCss(css);
        } else {
            state.document.source.css = core.sanitizeCss(css);
        }
    }

    function documentCssForShadow() {
        return state.document.source.css
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
.vdoc-page[data-runtime-state="paused"] *::after {
    animation-play-state: paused !important;
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

    function renderDocument() {
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
            runtime.className = 'vdoc-runtime vdoc-slide-editor-runtime';
            runtime.dataset.slideId = slide?.id || '';
            runtime.innerHTML = slide?.html || '';
            const slideStyle = document.createElement('style');
            slideStyle.dataset.vdocSlideStyle = slide?.id || '';
            slideStyle.textContent = slide?.css || '';
            root.appendChild(slideStyle);
        } else {
            pagination.renderContinuous(state.document.source.html, runtime, {
                ensureIds: core.ensureTextNodeIds,
            });
        }
        renderMathNodes(root);

        root.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
            editable.contentEditable = 'true';
            editable.spellcheck = true;
        });
        bindRenderSurface(root);
        updatePageZoomLayout(root);
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
            ? state.document.source.slides.map((slide) =>
                `<section data-vdoc-slide data-vdoc-slide-id="${escapeHtml(slide.id)}">${slide.html}<style>${slide.css}</style></section>`
            ).join('\n')
            : state.document.source.html;
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
            .replace(documentCssForShadow(), state.document.source.css)
            .replace(/transform:\s*scale\(var\(--vdoc-zoom,\s*1\)\);/g, 'transform: none;')
            .replace(/margin-bottom:\s*calc\(var\(--vdoc-page-gap\)\s*\+\s*var\(--vdoc-zoom-height-compensation,\s*0px\)\)\s*!important;/g,
                'margin-bottom: var(--vdoc-page-gap) !important;')}
@page { size: ${scene.page.width} ${scene.page.height}; margin: 0; }
html, body { margin: 0; background: #fff; }
html[data-vdoc-pdf="true"] *, html[data-vdoc-pdf="true"] *::before, html[data-vdoc-pdf="true"] *::after {
    animation-play-state: paused !important;
    transition: none !important;
}`;
    }

    function buildPresentationHtml() {
        const scene = core.createSceneConfig(state.document.manifest.scene);
        const title = escapeHtml(state.document.manifest.title || state.currentName);
        const language = escapeHtml(state.document.manifest.language || 'zh-CN');
        const slides = state.document.source.slides;
        const slideMarkup = slides.map((slide, index) => `
<section class="vcp-slide${index === 0 ? ' active' : ''}"
    data-slide-index="${index}"
    data-slide-id="${escapeHtml(slide.id)}"
    data-transition="${escapeHtml(slide.transition || 'none')}"
    aria-hidden="${index === 0 ? 'false' : 'true'}">
    <style>${slide.css || ''}</style>
    ${slide.html}
</section>`).join('\n');
        const slideScripts = slides.map((slide, index) => slide.script
            ? `(() => {
    const scene = document.querySelector('[data-slide-index="${index}"]');
    if (!scene) return;
    try {
        const run = new Function('scene', 'deck', ${JSON.stringify(slide.script)});
        run(scene, window.VCPDeck);
    } catch (error) {
        console.error('[VCPDeck] Scene ${escapeHtml(slide.id)} script failed:', error);
    }
})();`
            : '').filter(Boolean).join('\n');

        return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<style>
${state.document.source.css}
${styleLibrary.compileCss([...state.usedAdvancedStyleIds])}
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#090b0c;color:#fff}
body{display:grid;place-items:center;font-family:system-ui,sans-serif}
.vcp-deck{position:relative;width:min(100vw,calc(100vh * ${scene.presentation.aspectRatio || '16 / 9'}));aspect-ratio:${scene.presentation.aspectRatio || '16 / 9'};overflow:hidden;background:#fff;box-shadow:0 24px 90px rgba(0,0,0,.55)}
.vcp-slide{position:absolute;inset:0;display:none;width:100%;height:100%;overflow:hidden;color:#1d2421;background:#fff}
.vcp-slide.active{display:block}
.vcp-slide>.vdoc-slide-scene,.vcp-slide>[data-vdoc-slide]{width:100%;height:100%}
.vcp-deck-controls{position:fixed;right:18px;bottom:16px;z-index:30;display:flex;align-items:center;gap:7px;padding:6px;border:1px solid rgba(255,255,255,.2);border-radius:10px;background:rgba(8,10,11,.72);backdrop-filter:blur(14px);opacity:.25;transition:opacity .2s}
.vcp-deck-controls:hover,.vcp-deck-controls:focus-within{opacity:1}
.vcp-deck-controls button{height:32px;min-width:34px;border:0;border-radius:7px;color:#fff;background:rgba(255,255,255,.1);cursor:pointer}
.vcp-deck-status{min-width:64px;text-align:center;font:12px system-ui}
@media print{html,body{height:auto;overflow:visible;background:#fff}.vcp-deck{display:block;width:${scene.page.width};height:auto;aspect-ratio:auto;box-shadow:none}.vcp-slide{position:relative;display:block!important;width:${scene.page.width};height:${scene.page.height};break-after:page}.vcp-deck-controls{display:none}}
</style>
</head>
<body>
<main id="vcp-deck" class="vcp-deck" aria-label="${title}">
${slideMarkup}
</main>
<nav class="vcp-deck-controls" aria-label="演示控制">
    <button type="button" data-deck-action="previous" title="上一页">←</button>
    <span class="vcp-deck-status">1 / ${slides.length}</span>
    <button type="button" data-deck-action="next" title="下一页">→</button>
    <button type="button" data-deck-action="fullscreen" title="全屏">⛶</button>
</nav>
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
${state.document.source.css}
${compiledStyles}
html,body{margin:0;min-height:100%}
body{padding:clamp(24px,6vw,96px)}
.vdoc-flow-export{width:min(100%,210mm);margin:0 auto}
@media print{body{padding:0}}
</style>
</head>
<body>
<main class="vdoc-flow-export">
${state.document.source.html}
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
        try {
            if (state.mode === 'html' || state.mode === 'css') {
                if (applySourceChanges(false) === false) return false;
            }
            let html;
            let paged = false;
            if (format === 'html-flow') {
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
        root.addEventListener('focusin', (event) => {
            const page = event.target.closest?.('.vdoc-page');
            if (page) {
                state.activePage = page;
                activatePage(page);
            }
            const block = event.target.closest?.('[data-vdoc-block]');
            if (block) state.activeEditableBlock = block;
            syncFormattingControls(event.target);
        });

        root.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const block = event.target.closest?.('[data-vdoc-text]');
            if (!block) return;
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
        });

        root.addEventListener('pointermove', (event) => {
            if (!(event.buttons & 1) || !state.pointerSelectionAnchorId) return;
            const block = event.target.closest?.('[data-vdoc-text]');
            const blockId = block?.dataset?.vdocText;
            if (!blockId || blockId === state.pointerSelectionAnchorId) return;
            event.preventDefault();
            state.pointerSelectingBlocks = true;
            selectBlockInterval(state.pointerSelectionAnchorId, blockId, { preserveAnchor: true });
        });

        root.addEventListener('mouseup', () => {
            if (!state.pointerSelectingBlocks) captureCurrentSelection();
            state.pointerSelectionAnchorId = null;
            state.pointerSelectingBlocks = false;
            syncFormattingFromCurrentSelection();
        });
        root.addEventListener('keyup', () => {
            captureCurrentSelection();
            syncFormattingFromCurrentSelection();
        });
        root.addEventListener('keydown', handleBlockEditingKeydown);

        root.addEventListener('input', (event) => {
            const editable = event.target.closest?.('[data-vdoc-text]');
            if (!editable) return;
            updateSourceNode(editable);
            window.ScriptoriumPretext?.evictNode(editable.dataset.vdocText);
            markDirty();
            window.clearTimeout(state.sourceUpdateTimer);
            state.sourceUpdateTimer = window.setTimeout(() => {
                captureSnapshot();
                renderOutline();
            }, 450);
        });

        root.addEventListener('contextmenu', (event) => {
            if (!state.explicitBlockSelection && !captureCurrentSelection()) return;
            event.preventDefault();
            showSelectionBar(event.clientX, event.clientY);
        });
    }

    function currentRenderSelection() {
        return getRenderRoot()?.getSelection?.() || window.getSelection();
    }

    function editableBlocksForRange(range) {
        const root = getRenderRoot();
        if (!root || !range || range.collapsed) return [];
        return [...root.querySelectorAll('[data-vdoc-text]')].filter((block) => {
            try {
                return range.intersectsNode(block);
            } catch {
                return false;
            }
        });
    }

    function allRenderedTextBlocks() {
        return [...(getRenderRoot()?.querySelectorAll('[data-vdoc-text]') || [])];
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
        syncFormattingControls(blocks[0]);
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
        const target = firstFontFamily(fontFamily).toLowerCase();
        const option = [...select.options].find((item) =>
            firstFontFamily(item.value).toLowerCase() === target
        );
        if (option) select.value = option.value;
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

    function syncFormattingFromCurrentSelection() {
        const selection = currentRenderSelection();
        const node = selection?.focusNode || selection?.anchorNode;
        if (node) syncFormattingControls(node);
    }

    function applyInlineStyle(property, value, preferSaved = false) {
        if (preferSaved) restoreSavedSelection();
        const wrappers = wrapSelectionRanges((wrapper) => {
            wrapper.style[property] = value;
        }, preferSaved);
        if (!wrappers.length) return false;
        syncRenderedDocumentToSource();
        syncFormattingControls(wrappers[0]);
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
            editable.spellcheck = true;
        });
        if (prepared?.matches?.(core.EDITABLE_SELECTOR)) {
            prepared.contentEditable = 'true';
            prepared.spellcheck = true;
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

    function insertStructureBlock(type = elements['block-type-select']?.value || 'paragraph') {
        if (!state.ready || state.mode !== 'render') return false;
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

        state.activeEditableBlock = block.matches('[data-vdoc-block]')
            ? block
            : block.querySelector('[data-vdoc-block]');
        const focusTarget = state.activeEditableBlock || block.querySelector('td, th');
        syncContinuousStructureToSource();
        renderOutline();
        scheduleMetrics();
        if (focusTarget) placeCaretAtStart(focusTarget);
        markDirty();
        captureSnapshot();
        return true;
    }

    function reflowAfterStructureChange(focusNodeId = null) {
        const target = focusNodeId
            ? getRenderRoot()?.querySelector(`[data-vdoc-text="${CSS.escape(focusNodeId)}"]`)
            : state.activeEditableBlock;
        syncContinuousStructureToSource();
        if (!target) return;
        state.activeEditableBlock = target;
        placeCaretAtStart(target);
    }

    function syncContinuousStructureToSource() {
        const runtime = getRenderRoot()?.querySelector(
            isSlideDeck() ? '.vdoc-slide-editor-runtime' : '.vdoc-flow-runtime'
        );
        if (!runtime) return;
        const clone = runtime.cloneNode(true);
        restoreMathSemantics(clone);
        clone.querySelectorAll('[contenteditable], [spellcheck], [data-vdoc-editor-selected]').forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
            node.removeAttribute('data-vdoc-editor-selected');
        });
        setCurrentSourceHtml(clone.innerHTML);
    }

    function handleBlockEditingKeydown(event) {
        const editable = event.target.closest?.('[data-vdoc-text]');
        const selection = getRenderRoot()?.getSelection?.() || window.getSelection();

        if (event.key === 'Tab' && editable && selection?.isCollapsed && selection.rangeCount) {
            const range = selection.getRangeAt(0);
            const prefix = range.cloneRange();
            prefix.selectNodeContents(editable);
            prefix.setEnd(range.startContainer, range.startOffset);

            // 仅在文本块首行头部把 Tab 解释为中文四格缩进；其他位置仍允许
            // 浏览器执行正常的焦点导航。比例字体中的四个半角空格通常只有
            // 约一个汉字宽，因此使用两个全角空格稳定实现两个汉字（2em）缩进。
            if (!prefix.toString()) {
                event.preventDefault();
                const indentation = document.createTextNode('\u3000\u3000');
                range.insertNode(indentation);
                range.setStartAfter(indentation);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                updateSourceNode(editable);
                state.activeEditableBlock = editable;
                markDirty();
                captureSnapshot();
                return;
            }
        }

        const block = event.target.closest?.('[data-vdoc-block][data-vdoc-removable="true"]');
        if (!block) return;

        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            // Enter 必须以当前光标为准。当前选区折叠时不能回退到此前保存的
            // 全文/跨块范围，否则一次回车可能误删整个旧选区。
            const range = selection?.rangeCount
                ? selection.getRangeAt(0)
                : selectedRange();
            if (!range || !block.contains(range.commonAncestorContainer)) return;
            range.deleteContents();
            const lineBreak = document.createElement('br');
            range.insertNode(lineBreak);
            range.setStartAfter(lineBreak);
            range.collapse(true);
            const selectionAfterBreak = currentRenderSelection();
            selectionAfterBreak.removeAllRanges();
            selectionAfterBreak.addRange(range);
            updateSourceNode(block);
            window.ScriptoriumPretext?.evictNode(block.dataset.vdocText);
            markDirty();
            captureSnapshot();
            return;
        }

        if (event.key === 'Enter' && event.shiftKey && block.tagName !== 'TD' && block.tagName !== 'TH') {
            event.preventDefault();
            const next = createEditableBlock('paragraph');
            block.after(next);
            const nextId = next.dataset.vdocText
                || next.querySelector('[data-vdoc-text]')?.dataset.vdocText;
            state.activeEditableBlock = next;
            reflowAfterStructureChange(nextId);
            scheduleMetrics();
            markDirty();
            captureSnapshot();
            return;
        }

        const isEmpty = !(block.textContent || '').trim() && !block.querySelector('[data-vdoc-math], img');
        if (event.key !== 'Backspace' || !isEmpty || !selection?.isCollapsed) return;

        const parent = block.parentElement;
        let target = block.previousElementSibling || block.nextElementSibling;
        event.preventDefault();
        block.remove();

        if (parent?.matches('[data-vdoc-preserve="true"]')
            && !parent.querySelector('[data-vdoc-block], table')) {
            target = createEditableBlock('paragraph');
            parent.appendChild(target);
        }

        target = target?.matches?.('[data-vdoc-block]')
            ? target
            : target?.querySelector?.('[data-vdoc-block]') || getRenderRoot().querySelector('[data-vdoc-block]');
        state.activeEditableBlock = target || null;
        reflowAfterStructureChange(target?.dataset?.vdocText);
        renderOutline();
        scheduleMetrics();
        markDirty();
        captureSnapshot();
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
        const clone = renderedNode.cloneNode(true);
        restoreMathSemantics(clone);
        clone.querySelectorAll('[contenteditable], [spellcheck]').forEach((node) => {
            node.removeAttribute('contenteditable');
            node.removeAttribute('spellcheck');
        });
        return core.sanitizeHtml(clone.innerHTML);
    }

    function updateSourceNode(renderedNode) {
        const nodeId = renderedNode?.dataset?.vdocText;
        if (!nodeId) return;
        const template = document.createElement('template');
        template.innerHTML = currentSourceHtml();
        const target = template.content.querySelector(`[data-vdoc-text="${CSS.escape(nodeId)}"]`);
        if (!target) return;
        target.innerHTML = semanticInnerHtml(renderedNode);
        setCurrentSourceHtml(template.innerHTML);
        state.document.manifest.modifiedAt = new Date().toISOString();
    }

    function initializePageVisibility(root, renderHost = elements['read-host']) {
        state.pageObserver?.disconnect();
        state.pageObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                entry.target.dataset.runtimeState = entry.isIntersecting ? 'active' : 'paused';
            });
            updateCurrentPage(root, renderHost);
        }, {
            root: renderHost,
            rootMargin: '120% 0px',
            threshold: 0,
        });
        root.querySelectorAll('.vdoc-page').forEach((page) => state.pageObserver.observe(page));
    }

    function activatePage(page) {
        if (page) page.dataset.runtimeState = 'active';
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
            const blocked = template.content.querySelector('script,iframe,object,embed');
            if (blocked) {
                valid = false;
                message = `禁止使用 <${blocked.tagName.toLowerCase()}>`;
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
            window.clearTimeout(state.sourceUpdateTimer);
            state.sourceUpdateTimer = window.setTimeout(refreshSourceColorMarks, 180);
        });
        state.sourceEditor.on('cursorActivity', syncSourceColorTool);
    }

    function switchMode(mode) {
        if (!state.ready) return;
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
            window.requestAnimationFrame(() => updateCurrentPage(getReadRoot(), elements['read-host']));
        } else if (isRender) {
            state.pageObserver?.disconnect();
            elements['page-status'].textContent = isSlideDeck()
                ? `第 ${state.activeSlideIndex + 1} 页 / 共 ${state.document.source.slides.length} 页`
                : '连续编辑';
        }

        if (isSource) {
            state.sourceMode = mode;
            elements['source-title'].textContent = mode === 'html' ? 'HTML 源码' : 'CSS 源码';
            elements['source-description'].textContent = mode === 'html'
                ? '人类编辑渲染结果，AI 始终以此结构为真相'
                : '样式与纯 CSS 动画由 AI 协助设计';
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
            setCurrentSourceHtml(source);
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
            syncRenderedDocumentToSource();
            syncFormattingControls(blocks[0]);
            return true;
        }
        if (command === 'text-align') {
            const blocks = selectedEditableBlocks(preferSaved);
            if (!blocks.length) return false;
            blocks.forEach((block) => {
                block.style.textAlign = value;
            });
            syncRenderedDocumentToSource();
            syncFormattingControls(blocks[0]);
            return true;
        }
        if (command === 'image') return insertImage();
        return false;
    }

    function syncRenderedDocumentToSource() {
        const root = getRenderRoot();
        if (!root) return;
        const sourceTemplate = document.createElement('template');
        sourceTemplate.innerHTML = currentSourceHtml();
        root.querySelectorAll('[data-vdoc-text]').forEach((renderedNode) => {
            const nodeId = renderedNode.dataset.vdocText;
            const sourceNode = sourceTemplate.content.querySelector(
                `[data-vdoc-text="${CSS.escape(nodeId)}"]`
            );
            if (!sourceNode) return;
            sourceNode.innerHTML = semanticInnerHtml(renderedNode);
            sourceNode.className = renderedNode.className;
            sourceNode.removeAttribute('data-vdoc-editor-selected');
            for (const attribute of [...renderedNode.attributes]) {
                if (attribute.name === 'contenteditable'
                    || attribute.name === 'spellcheck'
                    || attribute.name === 'data-vdoc-editor-selected') continue;
                sourceNode.setAttribute(attribute.name, attribute.value);
            }
        });
        setCurrentSourceHtml(core.sanitizeHtml(sourceTemplate.innerHTML));
        state.document.manifest.styleDependencies = [...state.usedAdvancedStyleIds];
        state.document.manifest.embeddedStyles = [...state.usedAdvancedStyleIds]
            .map((styleId) => styleLibrary.get(styleId))
            .filter(Boolean);
        markDirty();
        captureSnapshot();
        renderOutline();
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
        syncRenderedDocumentToSource();
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
        const items = core.extractOutline(state.document?.source.html || '');
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
            const title = document.createElement('span');
            title.className = 'slide-nav-title';
            const template = document.createElement('template');
            template.innerHTML = slide.html;
            title.textContent = slide.name
                || template.content.textContent?.trim().slice(0, 42)
                || `第 ${index + 1} 页`;
            preview.appendChild(title);
            button.append(ordinal, preview);
            button.addEventListener('click', () => selectSlide(index));
            return button;
        }));
    }

    function selectSlide(index) {
        const slides = state.document?.source?.slides || [];
        if (!slides[index] || index === state.activeSlideIndex) return false;
        syncContinuousStructureToSource();
        state.activeSlideIndex = index;
        state.activeEditableBlock = null;
        state.selectionRange = null;
        renderDocument();
        return true;
    }

    function addSlide() {
        if (!isSlideDeck()) return false;
        syncContinuousStructureToSource();
        state.document.source.slides.push(
            core.createSlide({}, state.document.source.slides.length)
        );
        state.activeSlideIndex = state.document.source.slides.length - 1;
        markDirty();
        captureSnapshot();
        renderDocument();
        return true;
    }

    function deleteCurrentSlide() {
        if (!isSlideDeck()) return false;
        const slides = state.document.source.slides;
        if (slides.length <= 1) {
            showToast('演示至少需要保留一页。');
            return false;
        }
        slides.splice(state.activeSlideIndex, 1);
        state.activeSlideIndex = Math.min(state.activeSlideIndex, slides.length - 1);
        state.activeEditableBlock = null;
        state.selectionRange = null;
        markDirty();
        captureSnapshot();
        renderDocument();
        return true;
    }

    function scheduleMetrics(immediate = false) {
        window.clearTimeout(state.metricsTimer);
        state.metricsTimer = window.setTimeout(updateMetrics, immediate ? 0 : 320);
    }

    function updateMetrics() {
        const template = document.createElement('template');
        template.innerHTML = isSlideDeck()
            ? state.document.source.slides.map((slide) => slide.html).join('\n')
            : state.document?.source.html || '';
        const text = template.content.textContent || '';
        const compact = text.replace(/\s/g, '');
        const words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
        const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
        elements['word-count'].textContent = `${cjk + words} 字`;
        elements['character-count'].textContent = `${compact.length} 字符`;
    }

    async function createEditor(documentModel = null, metadata = {}) {
        state.loading = true;
        elements['loading-state'].hidden = false;
        updateIdentity();
        try {
            state.document = documentModel ? core.normalizeDocument(documentModel) : core.createDocument();
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
            renderDocument();
            switchMode('render');
            captureSnapshot();
            markSaved();
            renderLineage();
            showToast(documentModel ? 'VDOCX 已展开' : '共笔新稿已建立', 'success');
        } finally {
            state.loading = false;
            elements['loading-state'].hidden = true;
            updateIdentity();
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
                html: isPresentation ? undefined : result.html,
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
        if (state.mode === 'html' || state.mode === 'css') applySourceChanges(false);
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
            if (!result?.success) return false;
            state.currentPath = result.filePath;
            state.currentName = result.name;
            markSaved();
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

    function requestUnsavedDecision(message) {
        if (!state.dirty) return Promise.resolve('discard');
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

    function renderLineage() {
        elements['checkpoint-count'].textContent = String(state.checkpoints.length);
        if (!state.checkpoints.length) {
            elements['lineage-flow'].innerHTML = '<div class="lineage-empty"><strong>文脉尚未开始</strong><p>人类与 AI 的每次共建刻点都会在这里留下轨迹。</p></div>';
            return;
        }
        elements['lineage-flow'].replaceChildren(...state.checkpoints.map((checkpoint) => {
            const item = document.createElement('article');
            item.className = `checkpoint-item ${checkpoint.source}`;
            item.innerHTML = '<div class="checkpoint-meta"><span class="checkpoint-source"></span><time></time></div><h3></h3><p></p>';
            item.querySelector('.checkpoint-source').textContent = checkpoint.source === 'agent' ? 'AI 协作' : '人类刻点';
            item.querySelector('time').textContent = new Date(checkpoint.createdAt).toLocaleString('zh-CN');
            item.querySelector('h3').textContent = checkpoint.name;
            item.querySelector('p').textContent = checkpoint.note || '完整源码状态已记录。';
            return item;
        }));
    }

    async function createCheckpoint(event) {
        event.preventDefault();
        const name = elements['checkpoint-name-input'].value.trim();
        if (!name) return;
        state.checkpoints.unshift({
            id: `human-${Date.now()}`,
            source: 'human',
            name,
            note: elements['checkpoint-note-input'].value.trim(),
            createdAt: Date.now(),
            snapshot: core.serialize(state.document),
        });
        elements['checkpoint-dialog'].hidden = true;
        markDirty();
        renderLineage();
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
        elements['create-checkpoint-btn'].addEventListener('click', () => {
            elements['checkpoint-name-input'].value = '';
            elements['checkpoint-note-input'].value = '';
            elements['checkpoint-dialog'].hidden = false;
        });
        elements['checkpoint-cancel-btn'].addEventListener('click', () => elements['checkpoint-dialog'].hidden = true);
        elements['checkpoint-dialog'].querySelector('form').addEventListener('submit', createCheckpoint);
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
            if (modifier && key === 'a' && state.ready && state.mode === 'render' && !formControl) {
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
                elements['checkpoint-dialog'].hidden = true;
            }
        });
    }

    function bindRuntime() {
        state.pathRequestDisposer = api.onOpenPathRequest(openPath);
        state.agentCheckpointDisposer = api.onAgentCheckpointProposed((payload) => {
            if (!payload) return;
            state.checkpoints.unshift({
                id: payload.id || `agent-${Date.now()}`,
                source: 'agent',
                name: payload.name || 'AI 排版提案',
                note: payload.note || 'AI 已提交一轮润色与排版。',
                createdAt: payload.createdAt || Date.now(),
            });
            renderLineage();
        });
        window.addEventListener('beforeunload', () => {
            state.pageObserver?.disconnect();
            window.clearTimeout(state.paginationTimer);
            window.ScriptoriumPretext?.clear?.();
            state.themeDisposer?.();
            state.pathRequestDisposer?.();
            state.agentCheckpointDisposer?.();
            state.styleLibraryDisposer?.();
        });
    }

    async function initialize() {
        if (!api || !core || !styleLibrary || !pagination) {
            throw new Error('Scriptorium 原生文档内核未载入。');
        }
        cacheElements();
        restorePanelWidths();
        elements['page-stream'].attachShadow({ mode: 'open' });
        elements['read-page-stream'].attachShadow({ mode: 'open' });
        initializeSourceEditor();
        bindControls();
        bindKeyboard();
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