'use strict';

(() => {
    function createDeckRenderer(context = {}) {
        const primitives = context.primitives;
        const pagination = context.pagination;
        const documentPort = context.documentPort;
        const core = context.core;
        if (!primitives || !pagination || !documentPort || !core) {
            throw new TypeError(
                'Deck renderer requires render primitives, pagination, DocumentPort and VDocCore.'
            );
        }

        function model() {
            const documentModel = documentPort.document();
            if (!documentModel) throw new Error('No slide deck is open.');
            return documentModel;
        }

        function deckCss(surface, options = {}) {
            const customCss = primitives.cssForShadow(
                model().source?.deckCss || ''
            );
            const advancedCss = primitives.compiledStyleIdsCss(
                model().manifest?.styleDependencies || []
            );
            const layoutCss = surface === 'edit'
                ? `
.vdoc-slide-editor-runtime {
    display: grid;
    width: var(--vdoc-page-width);
    height: var(--vdoc-page-height);
    margin: 32px auto 88px;
    overflow: hidden;
    place-items: stretch;
    background: #fffdf8;
    box-shadow: 0 18px 55px rgba(0, 0, 0, .34);
    transform: scale(var(--vdoc-zoom, 1));
    transform-origin: top center;
}
.vdoc-slide-editor-runtime > .vdoc-slide-scene,
.vdoc-slide-editor-runtime > [data-vdoc-slide] {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
}
${primitives.editDecorationsCss()}
`
                : `
.vdoc-paged-runtime { padding: 18px 0 88px; }
.vdoc-page {
    position: relative;
    width: var(--vdoc-page-width) !important;
    height: var(--vdoc-page-height) !important;
    margin: 0 auto calc(
        var(--vdoc-page-gap) + var(--vdoc-zoom-height-compensation, 0px)
    ) !important;
    padding: 0 !important;
    overflow: hidden;
    background: #fffdf8;
    box-shadow: 0 18px 55px rgba(0, 0, 0, .34);
    transform: scale(var(--vdoc-zoom, 1));
    transform-origin: top center;
}
.vdoc-page-content {
    width: 100%;
    height: 100%;
    padding: 0 !important;
    overflow: hidden;
}
.vdoc-page-content > [data-vdoc-slide],
.vdoc-page-content .vdoc-slide-scene {
    width: 100%;
    height: 100%;
}
`;
            return [
                primitives.baseCss(model().manifest.scene, options),
                ':host { color: #1d2421; }',
                customCss,
                advancedCss,
                layoutCss,
            ].join('\n');
        }

        function createSurface(target, surface, options = {}) {
            const root = primitives.ensureShadowRoot(target);
            root.replaceChildren();
            const style = primitives.createStyle(
                deckCss(surface, options)
            );
            const runtime = primitives.createRuntime(
                surface === 'edit'
                    ? 'vdoc-runtime vdoc-slide-editor-runtime'
                    : 'vdoc-runtime vdoc-paged-runtime',
                model().manifest.scene.kind,
                options.zoom
            );
            root.append(style, runtime);
            return { root, runtime };
        }

        function activateEditPlugins(root, adapter) {
            context.objectPort?.bindRoot?.(root);
            context.editorPort?.bindSurface?.(root);
            context.renderedTextPort?.activate?.({
                kind: 'deck',
                root,
                adapter,
            });
            context.runtimePort?.activate?.({
                kind: 'deck',
                surface: 'edit',
                root,
                adapter,
            });
        }

        function renderEdit(options = {}) {
            const { adapter, target, compiled } = options;
            const { root, runtime } = createSurface(
                target,
                'edit',
                options
            );
            const slide = compiled.activeSlide;
            const parsed = compiled.parsedSlide;
            runtime.dataset.slideId = slide?.id || '';
            runtime.innerHTML = primitives.resolveResources(parsed.html);
            const slideStyle = primitives.createStyle(
                parsed.css,
                { vdocSlideStyle: slide?.id || '' }
            );
            root.appendChild(slideStyle);
            primitives.renderMath(root);
            primitives.renderMermaid(root);
            primitives.updateZoomLayout(root, options.zoom);
            activateEditPlugins(root, adapter);
            return Object.freeze({
                root,
                runtime,
                slideId: slide?.id || null,
                dispose() {
                    context.editorPort?.disposeSurface?.();
                    context.objectPort?.clearSelection?.();
                    context.renderedTextPort?.disposeSurface?.();
                    context.runtimePort?.disposeSurface?.('edit');
                },
            });
        }

        function slideMarkup(adapter) {
            return adapter.slides().map((slide) => {
                const parsed = adapter.parsedSlide(slide);
                return `<section data-vdoc-slide data-vdoc-slide-id="${
                    context.escapeHtml?.(slide.id) || slide.id
                }">${parsed.html}<style>${
                    String(parsed.css).replace(/<\/style/gi, '<\\/style')
                }</style></section>`;
            }).join('\n');
        }

        function renderRead(options = {}) {
            const { adapter, target } = options;
            const { root, runtime } = createSurface(
                target,
                'read',
                options
            );
            const result = pagination.paginate(
                primitives.resolveResources(slideMarkup(adapter)),
                runtime,
                {
                    ensureIds: core.ensureTextNodeIds,
                    scene: core.createSceneConfig(model().manifest.scene),
                    slideDeckKind: core.PROJECT_KINDS.SLIDE_DECK,
                    zoom: options.zoom,
                }
            );
            primitives.renderMath(root);
            primitives.renderMermaid(root);
            primitives.updateZoomLayout(root, options.zoom);
            context.visibilityPort?.observe?.(root, options.scrollHost);
            context.runtimePort?.activate?.({
                kind: 'deck',
                surface: 'read',
                root,
                adapter,
            });
            return Object.freeze({
                root,
                runtime,
                result,
                dispose() {
                    context.visibilityPort?.disconnect?.(root);
                    context.runtimePort?.disposeSurface?.('read');
                },
            });
        }

        function createThumbnail(adapter, slide, options = {}) {
            const scene = core.createSceneConfig(model().manifest.scene);
            const parsed = adapter.parsedSlide(slide);
            const host = document.createElement('span');
            host.className = 'slide-thumbnail-host';
            host.setAttribute('aria-hidden', 'true');
            const root = host.attachShadow({ mode: 'open' });
            const style = primitives.createStyle(`
:host {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    contain: strict;
    color: #1d2421;
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
    background: #fffdf8;
    transform-origin: center;
}
${primitives.cssForShadow(model().source?.deckCss || '')}
${parsed.css}
.slide-thumbnail-stage *,
.slide-thumbnail-stage *::before,
.slide-thumbnail-stage *::after {
    animation: none !important;
    animation-play-state: paused !important;
    transition: none !important;
    caret-color: transparent !important;
}
`);
            const stage = document.createElement('span');
            stage.className = 'slide-thumbnail-stage';
            stage.innerHTML = primitives.resolveResources(parsed.html);
            root.append(style, stage);
            stage.querySelectorAll('[contenteditable]').forEach((node) =>
                node.removeAttribute('contenteditable')
            );
            stage.querySelectorAll('video,audio').forEach((media) => {
                media.removeAttribute('autoplay');
                media.removeAttribute('controls');
                try {
                    media.pause();
                    media.currentTime = 0;
                } catch {}
            });
            primitives.renderMath(root);
            const resize = () => {
                const width = host.clientWidth;
                const height = host.clientHeight;
                if (!width || !height || !stage.offsetWidth || !stage.offsetHeight) {
                    return;
                }
                const scale = Math.min(
                    width / stage.offsetWidth,
                    height / stage.offsetHeight
                );
                stage.style.transform =
                    `translate(-50%, -50%) scale(${scale})`;
            };
            window.requestAnimationFrame(resize);
            options.observe?.(host, resize);
            return host;
        }

        return Object.freeze({
            kind: 'deck-renderer',
            renderEdit,
            renderRead,
            createThumbnail,
            buildCss: deckCss,
        });
    }

    window.ScriptoriumDeckRenderer = Object.freeze({
        createDeckRenderer,
    });
})();