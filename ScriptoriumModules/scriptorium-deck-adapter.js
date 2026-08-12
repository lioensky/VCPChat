'use strict';

(() => {
    function createDeckAdapter(context = {}) {
        const documentPort = context.documentPort;
        const core = context.core;
        if (!documentPort || !core) {
            throw new TypeError('Deck adapter requires documentPort and core.');
        }

        let activeSlideIndex = 0;
        let surface = null;
        let disposed = false;

        function assertActive() {
            if (disposed) throw new Error('Deck adapter has been disposed.');
        }

        function documentModel() {
            assertActive();
            const model = documentPort.document();
            if (!model) throw new Error('No document is open.');
            if (model.manifest?.scene?.kind !== core.PROJECT_KINDS.SLIDE_DECK) {
                throw new Error('Deck adapter cannot operate on a flow document.');
            }
            return model;
        }

        function slides() {
            return documentModel().source?.slides || [];
        }

        function clampActiveIndex(index = activeSlideIndex) {
            const list = slides();
            if (!list.length) return 0;
            return Math.max(0, Math.min(list.length - 1, Number(index) || 0));
        }

        function activeSlide() {
            const list = slides();
            activeSlideIndex = clampActiveIndex(activeSlideIndex);
            return list[activeSlideIndex] || list[0] || null;
        }

        function parsedSlide(slide = activeSlide()) {
            if (!slide) return Object.freeze({
                id: '',
                name: '',
                html: '',
                css: '',
                script: '',
            });
            return Object.freeze({
                ...core.splitSlideSource(slide.source),
                id: slide.id,
                name: slide.name,
            });
        }

        function currentSource() {
            return String(activeSlide()?.source || '');
        }

        function replaceCurrentSource(source, options = {}) {
            const slide = activeSlide();
            if (!slide) return false;
            const nextSource = core.normalizeCompleteSlideSource(source);
            if (nextSource === String(slide.source || '')) return false;
            return documentPort.mutate(() => {
                slide.source = nextSource;
            }, {
                reason: options.reason || 'deck-slide-source-replaced',
                dirty: options.dirty !== false,
            });
        }

        function replaceSlideSource(index, source, options = {}) {
            const targetIndex = clampActiveIndex(index);
            const slide = slides()[targetIndex];
            if (!slide) return false;
            const nextSource = core.normalizeCompleteSlideSource(source);
            if (nextSource === String(slide.source || '')) return false;
            return documentPort.mutate(() => {
                slide.source = nextSource;
            }, {
                reason: options.reason || 'deck-slide-source-replaced',
                dirty: options.dirty !== false,
            });
        }

        function currentCss() {
            return String(documentModel().source?.deckCss || '');
        }

        function replaceCurrentCss(css, options = {}) {
            const nextCss = core.sanitizeCss(css);
            if (nextCss === currentCss()) return false;
            return documentPort.mutate((model) => {
                model.source.deckCss = nextCss;
            }, {
                reason: options.reason || 'deck-css-replaced',
                dirty: options.dirty !== false,
            });
        }

        function compile() {
            return Object.freeze({
                kind: 'deck',
                activeSlideIndex,
                activeSlide: activeSlide(),
                parsedSlide: parsedSlide(),
                slides: slides(),
                css: currentCss(),
                scene: core.createSceneConfig(documentModel().manifest.scene),
            });
        }

        function sourceState(documentOverride = null) {
            const model = documentOverride || documentModel();
            return Object.freeze({
                documentKind: 'pptx',
                scene: model.manifest?.scene
                    ? JSON.parse(JSON.stringify(model.manifest.scene))
                    : null,
                source: '',
                documentCss: '',
                deckCss: String(model.source?.deckCss || ''),
                slides: (model.source?.slides || []).map((slide, index) => ({
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
                    runtimeTextOverrides: Array.isArray(slide.runtimeTextOverrides)
                        ? JSON.parse(JSON.stringify(slide.runtimeTextOverrides))
                        : [],
                })),
            });
        }

        function flushEditor() {
            return context.editor?.flush?.() !== false;
        }

        function selectSlide(index, options = {}) {
            const nextIndex = clampActiveIndex(index);
            if (!slides()[nextIndex] || nextIndex === activeSlideIndex) return false;
            if (options.flush !== false && !flushEditor()) return false;
            const previousIndex = activeSlideIndex;
            activeSlideIndex = nextIndex;
            context.onActiveSlideChange?.({
                previousIndex,
                activeSlideIndex,
                slide: activeSlide(),
            });
            return true;
        }

        function resetActiveSlide(index = 0) {
            activeSlideIndex = clampActiveIndex(index);
            return activeSlideIndex;
        }

        function addSlide(input = {}, options = {}) {
            if (!flushEditor()) return false;
            const insertionIndex = options.index === undefined
                ? slides().length
                : Math.max(0, Math.min(slides().length, Number(options.index) || 0));
            let created = null;
            documentPort.mutate((model) => {
                created = core.createSlide(input, insertionIndex);
                model.source.slides.splice(insertionIndex, 0, created);
            }, { reason: options.reason || 'deck-slide-added' });
            activeSlideIndex = insertionIndex;
            context.onActiveSlideChange?.({
                previousIndex: null,
                activeSlideIndex,
                slide: created,
            });
            return created;
        }

        function deleteSlide(index = activeSlideIndex, options = {}) {
            const list = slides();
            if (list.length <= 1) return false;
            const targetIndex = clampActiveIndex(index);
            if (!flushEditor()) return false;
            let removed = null;
            documentPort.mutate((model) => {
                [removed] = model.source.slides.splice(targetIndex, 1);
            }, { reason: options.reason || 'deck-slide-deleted' });
            activeSlideIndex = clampActiveIndex(
                targetIndex <= activeSlideIndex ? activeSlideIndex - 1 : activeSlideIndex
            );
            context.onActiveSlideChange?.({
                previousIndex: targetIndex,
                activeSlideIndex,
                slide: activeSlide(),
                removed,
            });
            return removed;
        }

        function updateScene(scene, options = {}) {
            const normalized = core.createSceneConfig({
                ...scene,
                kind: core.PROJECT_KINDS.SLIDE_DECK,
            });
            const current = core.createSceneConfig(documentModel().manifest.scene);
            if (JSON.stringify(normalized) === JSON.stringify(current)) return false;
            return documentPort.mutate((model) => {
                model.manifest.scene = normalized;
            }, { reason: options.reason || 'deck-scene-updated' });
        }

        function renderEditSurface(target, options = {}) {
            assertActive();
            if (!context.renderer?.renderEdit) {
                throw new Error('Deck edit renderer is unavailable.');
            }
            disposeSurface();
            surface = context.renderer.renderEdit({
                adapter: api,
                target,
                compiled: compile(),
                ...options,
            });
            return surface;
        }

        function renderReadSurface(target, options = {}) {
            assertActive();
            if (!context.renderer?.renderRead) {
                throw new Error('Deck read renderer is unavailable.');
            }
            return context.renderer.renderRead({
                adapter: api,
                target,
                compiled: compile(),
                ...options,
            });
        }

        function insertContent(fragment, options = {}) {
            if (!context.editor?.insertContent) {
                throw new Error('Deck editor strategy is unavailable.');
            }
            return context.editor.insertContent(fragment, {
                adapter: api,
                ...options,
            });
        }

        function executeFormatting(command, value, options = {}) {
            if (!context.editor?.executeFormatting) {
                throw new Error('Deck editor strategy is unavailable.');
            }
            return context.editor.executeFormatting(command, value, {
                adapter: api,
                ...options,
            });
        }

        function proposalSource(proposal = {}) {
            if (proposal.sourceKind === 'deck-css') {
                return currentCss();
            }
            const index = proposal.slideIndex === undefined
                || proposal.slideIndex === null
                ? activeSlideIndex
                : clampActiveIndex(proposal.slideIndex);
            return String(slides()[index]?.source || '');
        }

        function proposalPreview(context = {}) {
            const before = core.splitSlideSource(String(context.before || ''));
            const after = core.splitSlideSource(String(context.after || ''));
            return Object.freeze({
                before: before.html,
                after: after.html,
                css: [
                    currentCss(),
                    before.css,
                    after.css,
                ].filter(Boolean).join('\n'),
            });
        }

        function outline() {
            return slides().map((slide, index) => {
                const template = document.createElement('template');
                template.innerHTML = parsedSlide(slide).html;
                return Object.freeze({
                    index,
                    id: slide.id,
                    title: slide.name
                        || template.content.textContent?.trim().slice(0, 80)
                        || `第 ${index + 1} 页`,
                });
            });
        }

        function exportHtml(options = {}) {
            if (!context.exporter?.build) {
                throw new Error('Deck exporter is unavailable.');
            }
            return context.exporter.build({
                adapter: api,
                compiled: compile(),
                ...options,
            });
        }

        function attachEditor(editor) {
            context.editor = editor;
            return api;
        }

        function attachRenderer(renderer) {
            context.renderer = renderer;
            return api;
        }

        function attachExporter(exporter) {
            context.exporter = exporter;
            return api;
        }

        function disposeSurface() {
            try {
                surface?.dispose?.();
            } finally {
                surface = null;
                context.editor?.disposeSurface?.();
            }
        }

        function dispose() {
            if (disposed) return;
            flushEditor();
            disposeSurface();
            disposed = true;
        }

        const api = Object.freeze({
            kind: 'deck',
            projectKind: core.PROJECT_KINDS.SLIDE_DECK,
            currentSource,
            replaceCurrentSource,
            replaceSlideSource,
            currentCss,
            replaceCurrentCss,
            compile,
            sourceState,
            slides,
            activeSlide,
            activeSlideIndex: () => activeSlideIndex,
            parsedSlide,
            selectSlide,
            resetActiveSlide,
            addSlide,
            deleteSlide,
            updateScene,
            renderEditSurface,
            renderReadSurface,
            insertContent,
            executeFormatting,
            outline,
            proposalSource,
            proposalPreview,
            exportHtml,
            attachEditor,
            attachRenderer,
            attachExporter,
            disposeSurface,
            dispose,
        });

        return api;
    }

    window.ScriptoriumDeckAdapter = Object.freeze({
        createDeckAdapter,
    });
})();