'use strict';

(() => {
    const api = window.scriptoriumAPI || window.docxAPI;
    const core = window.VDocCore;
    const styleLibrary = window.VDocStyleLibrary;
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
        systemFonts: [],
        selectionRange: null,
        selectionText: '',
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
            'new-btn', 'open-btn', 'import-btn', 'save-btn', 'save-as-btn',
            'render-mode-btn', 'html-mode-btn', 'css-mode-btn',
            'font-family-select', 'font-size-select', 'text-color-input',
            'highlight-color-input', 'line-height-select', 'block-type-select',
            'insert-block-btn', 'insert-table-btn', 'find-btn',
            'welcome-state', 'welcome-new-btn', 'welcome-open-btn', 'recent-documents',
            'document-workspace', 'render-host', 'page-stream', 'source-host',
            'source-title', 'source-description', 'source-editor', 'apply-source-btn',
            'format-source-btn', 'source-diagnostics', 'source-wrap-toggle',
            'source-color-input', 'source-color-swatch',
            'loading-state', 'outline-resizer', 'lineage-resizer',
            'outline-count', 'outline-headings-tab', 'outline-paragraphs-tab',
            'outline-headings-view', 'outline-paragraphs-view', 'outline-tree',
            'paragraph-index', 'outline-empty', 'lineage-flow', 'checkpoint-count',
            'create-checkpoint-btn', 'page-status', 'word-count', 'character-count',
            'font-status', 'zoom-out-btn', 'zoom-range', 'zoom-in-btn', 'zoom-value',
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
        elements['create-checkpoint-btn'].disabled = !state.ready || state.saving;
    }

    function markDirty() {
        if (!state.ready || state.loading) return;
        state.dirty = true;
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

    function restoreHistory(offset) {
        const nextIndex = state.historyIndex + offset;
        if (nextIndex < 0 || nextIndex >= state.history.length) return false;
        state.historyIndex = nextIndex;
        state.document = core.parse(state.history[nextIndex]);
        renderDocument();
        markDirty();
        return true;
    }

    function getRenderRoot() {
        return elements['page-stream'].shadowRoot;
    }

    function buildDocumentStyle() {
        const scene = core.createSceneConfig(state.document.manifest.scene);
        return `
@import url("../vendor/katex.min.css");
:host {
    display: block;
    min-height: 100%;
    --vdoc-page-width: ${scene.page.width};
    --vdoc-page-height: ${scene.page.height};
    --vdoc-page-gap: ${scene.page.gap};
}
.vdoc-runtime { display: block; padding: 18px 0 88px; }
.vdoc-page {
    width: var(--vdoc-page-width) !important;
    min-height: var(--vdoc-page-height) !important;
    transform: scale(var(--vdoc-zoom, 1));
    transform-origin: top center;
    margin-bottom: var(--vdoc-page-gap);
}
.vdoc-runtime[data-scene-kind="slide-deck"] .vdoc-page {
    position: relative;
    height: var(--vdoc-page-height);
    overflow: hidden;
}
.vdoc-page[data-runtime-state="paused"] *,
.vdoc-page[data-runtime-state="paused"] *::before,
.vdoc-page[data-runtime-state="paused"] *::after {
    animation-play-state: paused !important;
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
    .vdoc-page { transform: none; margin-bottom: 0; }
}
${styleLibrary.compileCss([...state.usedAdvancedStyleIds])}
${state.document.source.css}`;
    }

    function createPage(pageIndex, nodes) {
        const page = document.createElement('section');
        page.className = 'vdoc-page';
        page.dataset.pageIndex = String(pageIndex);
        page.dataset.runtimeState = 'active';
        page.style.setProperty('--vdoc-zoom', String(state.zoom / 100));
        nodes.forEach((node) => page.appendChild(node.cloneNode(true)));
        return page;
    }
    function splitIntoPages(html) {
        const template = document.createElement('template');
        template.innerHTML = core.ensureTextNodeIds(html);
        const scene = core.createSceneConfig(state.document.manifest.scene);
        const rootNodes = [...template.content.children];

        if (scene.kind === core.PROJECT_KINDS.SLIDE_DECK) {
            const explicitSlides = [...template.content.querySelectorAll(':scope > [data-vdoc-slide]')];
            const slides = explicitSlides.length ? explicitSlides : rootNodes;
            return slides.length
                ? slides.map((slide) => [slide])
                : [[document.createElement('section')]];
        }

        const pages = [];
        const pageSize = 5;
        for (let index = 0; index < rootNodes.length; index += pageSize) {
            pages.push(rootNodes.slice(index, index + pageSize));
        }
        return pages.length ? pages : [[document.createElement('p')]];
    }

    function renderDocument() {
        if (!state.document) return;
        state.document = core.normalizeDocument(state.document);
        const root = getRenderRoot() || elements['page-stream'].attachShadow({ mode: 'open' });
        root.replaceChildren();

        const style = document.createElement('style');
        style.textContent = buildDocumentStyle();
        const runtime = document.createElement('div');
        runtime.className = 'vdoc-runtime';
        runtime.dataset.sceneKind = state.document.manifest.scene.kind;
        splitIntoPages(state.document.source.html).forEach((nodes, index) => {
            runtime.appendChild(createPage(index, nodes));
        });
        root.append(style, runtime);
        renderMathNodes(root);

        root.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
            editable.contentEditable = 'true';
            editable.spellcheck = true;
        });
        bindRenderSurface(root);
        initializePageVisibility(root);
        renderOutline();
        scheduleMetrics(true);
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
        });

        root.addEventListener('keydown', handleBlockEditingKeydown);

        root.addEventListener('input', (event) => {
            const editable = event.target.closest?.('[data-vdoc-text]');
            if (!editable) return;
            updateSourceNode(editable);
            markDirty();
            window.clearTimeout(state.sourceUpdateTimer);
            state.sourceUpdateTimer = window.setTimeout(() => {
                captureSnapshot();
                renderOutline();
            }, 450);
        });

        root.addEventListener('contextmenu', (event) => {
            const selection = root.getSelection?.() || window.getSelection();
            if (!selection || selection.isCollapsed || !selection.rangeCount) return;
            event.preventDefault();
            state.selectionRange = selection.getRangeAt(0).cloneRange();
            state.selectionText = selection.toString();
            showSelectionBar(event.clientX, event.clientY);
        });
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
            || root.querySelector('.vdoc-page');
        if (anchor?.parentElement) anchor.after(block);
        else parent.appendChild(block);

        state.activeEditableBlock = block.matches('[data-vdoc-block]')
            ? block
            : block.querySelector('[data-vdoc-block]');
        syncPageStructureToSource();
        renderOutline();
        scheduleMetrics();
        const focusTarget = state.activeEditableBlock || block.querySelector('td, th');
        if (focusTarget) placeCaretAtStart(focusTarget);
        markDirty();
        captureSnapshot();
        return true;
    }

    function syncPageStructureToSource() {
        const root = getRenderRoot();
        const pageContents = [...root.querySelectorAll('.vdoc-page')].map((page) => {
            const clone = page.cloneNode(true);
            clone.querySelectorAll('.vdoc-page-tombstone').forEach((node) => node.remove());
            restoreMathSemantics(clone);
            clone.querySelectorAll('[contenteditable], [spellcheck], [data-runtime-state], [style]').forEach((node) => {
                node.removeAttribute('contenteditable');
                node.removeAttribute('spellcheck');
                node.removeAttribute('data-runtime-state');
                if (node.classList.contains('vdoc-page')) node.removeAttribute('style');
            });
            return clone.innerHTML;
        });
        state.document.source.html = core.formatHtml(
            core.ensureTextNodeIds(pageContents.join('\n'))
        );
    }

    function handleBlockEditingKeydown(event) {
        const block = event.target.closest?.('[data-vdoc-block][data-vdoc-removable="true"]');
        if (!block) return;
        const selection = getRenderRoot()?.getSelection?.() || window.getSelection();

        if (event.key === 'Enter' && !event.shiftKey && block.tagName !== 'TD' && block.tagName !== 'TH') {
            event.preventDefault();
            const next = createEditableBlock('paragraph');
            block.after(next);
            state.activeEditableBlock = next;
            syncPageStructureToSource();
            renderOutline();
            scheduleMetrics();
            placeCaretAtStart(next);
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

        syncPageStructureToSource();
        renderOutline();
        scheduleMetrics();
        target = target?.matches?.('[data-vdoc-block]')
            ? target
            : target?.querySelector?.('[data-vdoc-block]') || getRenderRoot().querySelector('[data-vdoc-block]');
        state.activeEditableBlock = target || null;
        if (target) placeCaretAtStart(target);
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
        template.innerHTML = state.document.source.html;
        const target = template.content.querySelector(`[data-vdoc-text="${CSS.escape(nodeId)}"]`);
        if (!target) return;
        target.innerHTML = semanticInnerHtml(renderedNode);
        state.document.source.html = core.formatHtml(template.innerHTML);
        state.document.manifest.modifiedAt = new Date().toISOString();
    }

    function initializePageVisibility(root) {
        state.pageObserver?.disconnect();
        const renderHost = elements['render-host'];
        state.pageObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                const page = entry.target;
                if (entry.isIntersecting) activatePage(page);
                else pausePage(page);
            });
            tombstoneRemotePages(root);
            updateCurrentPage(root);
        }, {
            root: renderHost,
            rootMargin: '120% 0px',
            threshold: 0,
        });
        root.querySelectorAll('.vdoc-page').forEach((page) => state.pageObserver.observe(page));
    }

    function activatePage(page) {
        if (!page || page.dataset.runtimeState === 'active') return;
        page.dataset.runtimeState = 'active';
        const tombstone = page.querySelector(':scope > .vdoc-page-tombstone');
        if (tombstone && page._vdocFrozenHtml) {
            page.innerHTML = page._vdocFrozenHtml;
            delete page._vdocFrozenHtml;
            page.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
                editable.contentEditable = 'true';
                editable.spellcheck = true;
            });
        }
    }

    function pausePage(page) {
        if (!page || page === state.activePage || page.contains(getRenderRoot()?.activeElement)) return;
        page.dataset.runtimeState = 'paused';
    }

    function tombstoneRemotePages(root) {
        const pages = [...root.querySelectorAll('.vdoc-page')];
        const hostRect = elements['render-host'].getBoundingClientRect();
        pages.forEach((page) => {
            const rect = page.getBoundingClientRect();
            const remote = rect.bottom < hostRect.top - hostRect.height * 3
                || rect.top > hostRect.bottom + hostRect.height * 3;
            if (!remote || page === state.activePage || page.contains(root.activeElement)) return;
            if (page.dataset.runtimeState === 'tombstone') return;
            page._vdocFrozenHtml = page.innerHTML;
            const marker = document.createElement('div');
            marker.className = 'vdoc-page-tombstone';
            marker.textContent = `第 ${Number(page.dataset.pageIndex) + 1} 页 · 已冻结`;
            page.replaceChildren(marker);
            page.dataset.runtimeState = 'tombstone';
        });
    }

    function updateCurrentPage(root) {
        const pages = [...root.querySelectorAll('.vdoc-page')];
        const hostRect = elements['render-host'].getBoundingClientRect();
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
        if (state.mode !== 'render' && mode === 'render') applySourceChanges(false);
        state.mode = mode;
        const isRender = mode === 'render';
        elements['render-host'].hidden = !isRender;
        elements['source-host'].hidden = isRender;
        for (const candidate of ['render', 'html', 'css']) {
            const button = elements[`${candidate}-mode-btn`];
            const active = candidate === mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }
        if (!isRender) {
            state.sourceMode = mode;
            elements['source-title'].textContent = mode === 'html' ? 'HTML 源码' : 'CSS 源码';
            elements['source-description'].textContent = mode === 'html'
                ? '人类编辑渲染结果，AI 始终以此结构为真相'
                : '样式与纯 CSS 动画由 AI 协助设计';
            state.sourceEditor?.setOption('mode', mode === 'html' ? 'htmlmixed' : 'css');
            if (mode === 'html') {
                state.document.source.html = core.formatHtml(state.document.source.html);
            }
            setSourceValue(state.document.source[mode]);
            window.setTimeout(() => {
                state.sourceEditor?.refresh();
                state.sourceEditor?.focus();
                validateSource();
                refreshSourceColorMarks();
            }, 0);
        }
    }

    function applySourceChanges(showSuccess = true) {
        if (!state.document || state.mode === 'render') return;
        if (!validateSource()) {
            showToast('源码检查未通过，请修正后再应用。', 'error');
            return false;
        }
        const source = getSourceValue();
        if (state.sourceMode === 'html') {
            state.document.source.html = core.formatHtml(core.ensureTextNodeIds(source));
            setSourceValue(state.document.source.html);
        } else {
            state.document.source.css = core.sanitizeCss(source);
            setSourceValue(state.document.source.css);
        }
        renderDocument();
        captureSnapshot();
        markDirty();
        if (showSuccess) showToast('源码已应用到渲染页面', 'success');
    }

    function executeCommand(command, value) {
        if (command === 'undo') return restoreHistory(-1);
        if (command === 'redo') return restoreHistory(1);
        if (state.mode !== 'render') return false;
        const root = getRenderRoot();
        root?.activeElement?.focus?.();
        const map = {
            bold: 'bold',
            italic: 'italic',
            underline: 'underline',
            strikethrough: 'strikeThrough',
            'text-color': 'foreColor',
            'highlight-color': 'hiliteColor',
            'text-align': `justify${String(value || 'left').replace(/^./, (char) => char.toUpperCase())}`,
            'bullet-list': 'insertUnorderedList',
            'numbered-list': 'insertOrderedList',
            'font-family': 'fontName',
        };
        if (command === 'font-size') return applySelectionStyle('fontSize', value);
        if (command === 'line-height') return applySelectionStyle('lineHeight', String(value));
        if (command === 'image') return insertImage();
        const nativeCommand = map[command];
        if (!nativeCommand) return false;
        document.execCommand(nativeCommand, false, value);
        syncRenderedDocumentToSource();
        return true;
    }

    function applySelectionStyle(property, value) {
        const selection = getRenderRoot()?.getSelection?.() || window.getSelection();
        if (!selection || selection.isCollapsed) return false;
        const range = selection.getRangeAt(0);
        const span = document.createElement('span');
        span.style[property] = value;
        try {
            range.surroundContents(span);
        } catch {
            span.appendChild(range.extractContents());
            range.insertNode(span);
        }
        syncRenderedDocumentToSource();
        return true;
    }

    function syncRenderedDocumentToSource() {
        const root = getRenderRoot();
        if (!root) return;
        const sourceTemplate = document.createElement('template');
        sourceTemplate.innerHTML = state.document.source.html;
        root.querySelectorAll('[data-vdoc-text]').forEach((renderedNode) => {
            const nodeId = renderedNode.dataset.vdocText;
            const sourceNode = sourceTemplate.content.querySelector(
                `[data-vdoc-text="${CSS.escape(nodeId)}"]`
            );
            if (!sourceNode) return;
            sourceNode.innerHTML = semanticInnerHtml(renderedNode);
            sourceNode.className = renderedNode.className;
            for (const attribute of [...renderedNode.attributes]) {
                if (attribute.name === 'contenteditable' || attribute.name === 'spellcheck') continue;
                sourceNode.setAttribute(attribute.name, attribute.value);
            }
        });
        state.document.source.html = core.formatHtml(
            core.sanitizeHtml(sourceTemplate.innerHTML)
        );
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
        const element = range?.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
            ? range.commonAncestorContainer
            : range?.commonAncestorContainer?.parentElement;
        const editable = element?.closest?.('[data-vdoc-text]');
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
        const preview = styleLibrary.createPreviewDocument(style.id, {
            text: state.selectionText || style.previewText,
        });
        const tag = preview.target === 'heading'
            ? 'h2'
            : preview.target === 'inline'
                ? 'span'
                : 'div';
        elements['style-preview-frame'].srcdoc =
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;min-height:100%;background:#fffdf8;color:#202723}
body{display:grid;place-items:center;padding:34px;box-sizing:border-box;font-family:"Noto Serif CJK SC","Microsoft YaHei",serif;line-height:1.75}
${preview.css}
</style></head><body><${tag} class="${escapeHtml(preview.className)}">${escapeHtml(preview.text)}</${tag}></body></html>`;
    }

    function applySelectedAdvancedStyle() {
        const style = styleLibrary.get(state.selectedAdvancedStyleId);
        const range = state.selectionRange;
        if (!style || !range) return false;
        const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        const editable = ancestor?.closest?.('[data-vdoc-text]');
        if (!editable) {
            showToast('当前选区无法应用高级样式。', 'error');
            return false;
        }

        const useBlock = style.targets.includes('heading')
            || style.targets.includes('paragraph')
            || (style.targets.includes('block') && range.toString().trim() === editable.textContent.trim());
        if (useBlock) {
            editable.classList.add(style.className);
            editable.dataset.vdocStyle = style.id;
        } else {
            const wrapper = document.createElement('span');
            wrapper.className = style.className;
            wrapper.dataset.vdocStyle = style.id;
            try {
                range.surroundContents(wrapper);
            } catch {
                wrapper.appendChild(range.extractContents());
                range.insertNode(wrapper);
            }
        }

        state.usedAdvancedStyleIds.add(style.id);
        syncRenderedDocumentToSource();
        const rootStyle = getRenderRoot()?.querySelector('style');
        if (rootStyle) rootStyle.textContent = buildDocumentStyle();
        closeStyleLibrary();
        hideSelectionBar();
        state.selectionRange = null;
        showToast(`已应用高级样式 · ${style.name}`, 'success');
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
        const items = core.extractOutline(state.document?.source.html || '');
        const headings = items.filter((item) => item.kind === 'heading');
        const paragraphs = items.filter((item) => item.kind === 'paragraph' && item.text);
        elements['outline-count'].textContent = `${headings.length} 节`;
        elements['outline-tree'].replaceChildren(...headings.map(createOutlineItem));
        elements['paragraph-index'].replaceChildren(...paragraphs.map(createOutlineItem));
        elements['outline-empty'].hidden = items.length > 0;
    }

    function createOutlineItem(item) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = item.kind === 'heading' ? 'outline-item' : 'paragraph-item';
        const label = document.createElement('span');
        label.className = item.kind === 'heading' ? 'outline-item-title' : 'paragraph-preview';
        label.textContent = item.text || '（空段落）';
        button.appendChild(label);
        button.style.setProperty('--outline-level', String(item.level || 1));
        button.addEventListener('click', () => {
            const target = getRenderRoot()?.querySelector(`[data-vdoc-text="${CSS.escape(item.id)}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target?.focus();
        });
        return button;
    }

    function scheduleMetrics(immediate = false) {
        window.clearTimeout(state.metricsTimer);
        state.metricsTimer = window.setTimeout(updateMetrics, immediate ? 0 : 320);
    }

    function updateMetrics() {
        const template = document.createElement('template');
        template.innerHTML = state.document?.source.html || '';
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
            const model = core.createDocument({
                title,
                html: result.html,
            });
            model.manifest.import = result.importMetadata || {
                sourceFormat: result.importedKind,
                sourceName: result.name,
            };
            await createEditor(model, {
                filePath: null,
                name: `${title}.vdocx`,
                imported: true,
            });
            markDirty();
            const warningCount = model.manifest.import?.warnings?.length || 0;
            showToast(
                warningCount
                    ? `已导入 ${result.importedKind.toUpperCase()} · ${warningCount} 条转换提示`
                    : `已导入 ${result.importedKind.toUpperCase()}，请保存为 VDOCX`,
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
        if (state.mode !== 'render') applySourceChanges(false);
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
        elements['new-btn'].addEventListener('click', () => runAfterUnsavedDecision('建立新稿前是否保存当前修改？', () => createEditor()));
        elements['welcome-new-btn'].addEventListener('click', () => createEditor());
        elements['open-btn'].addEventListener('click', chooseOpen);
        elements['import-btn'].addEventListener('click', chooseImport);
        elements['welcome-open-btn'].addEventListener('click', chooseOpen);
        elements['save-btn'].addEventListener('click', () => saveDocument(false));
        elements['save-as-btn'].addEventListener('click', () => saveDocument(true));
        elements['render-mode-btn'].addEventListener('click', () => switchMode('render'));
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
        elements['render-host'].addEventListener('wheel', handleZoomWheel, {
            passive: false,
            capture: true,
        });
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
        getRenderRoot()?.querySelectorAll('.vdoc-page').forEach((page) => {
            page.style.setProperty('--vdoc-zoom', String(state.zoom / 100));
        });
        return state.zoom;
    }

    function handleZoomWheel(event) {
        if (!(event.ctrlKey || event.metaKey) || !state.ready || state.mode !== 'render') return;
        event.preventDefault();

        const host = elements['render-host'];
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
            if (modifier && key === 's') {
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
            state.themeDisposer?.();
            state.pathRequestDisposer?.();
            state.agentCheckpointDisposer?.();
            state.styleLibraryDisposer?.();
        });
    }

    async function initialize() {
        if (!api || !core || !styleLibrary) throw new Error('Scriptorium 原生文档内核未载入。');
        cacheElements();
        restorePanelWidths();
        elements['page-stream'].attachShadow({ mode: 'open' });
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