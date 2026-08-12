'use strict';

(() => {
    function createFlowRenderer(context = {}) {
        const primitives = context.primitives;
        const pagination = context.pagination;
        const documentPort = context.documentPort;
        if (!primitives || !pagination || !documentPort) {
            throw new TypeError(
                'Flow renderer requires render primitives, pagination and DocumentPort.'
            );
        }

        function model() {
            const documentModel = documentPort.document();
            if (!documentModel) throw new Error('No flow document is open.');
            return documentModel;
        }

        function flowCss(surface, options = {}) {
            const customCss = primitives.cssForShadow(
                model().source?.documentCss || ''
            );
            const advancedCss = primitives.compiledStyleIdsCss(
                model().manifest?.styleDependencies || []
            );
            const editCss = surface === 'edit'
                ? `
.vdoc-flow-runtime {
    width: min(calc(100% - 48px), 1440px);
    min-height: calc(100% - 64px);
    margin: 0 auto;
    padding: clamp(28px, 4vw, 64px) clamp(22px, 5vw, 72px) 96px;
    color: var(--primary-text, #f2f0e9);
    background: transparent;
    zoom: var(--vdoc-zoom, 1);
}
.vdoc-edit-region {
    position: relative;
    min-width: 0;
}
.vdoc-edit-region[data-vdoc-edit-type="island"]:hover {
    outline: 1px solid rgba(217, 119, 69, .42);
    outline-offset: 5px;
}
.vdoc-md-flow-surface {
    display: flow-root;
    width: 100%;
    min-width: 0;
    cursor: text;
    user-select: text;
}
.vdoc-md-live-preview {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 1em;
    margin: 0;
    padding: 0;
    border: 0;
    outline: 0;
    color: inherit;
    background: transparent;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
    caret-color: #3a8b78;
    cursor: text;
}
.vdoc-md-marker {
    color: color-mix(in srgb, currentColor 48%, #d97745);
    font-family: Consolas, "Maple Mono", monospace;
    font-size: .72em;
}
.vdoc-md-marker-concealed { display: none !important; }
${primitives.editDecorationsCss()}
`
                : `
.vdoc-paged-runtime { padding: 18px 0 88px; }
.vdoc-page {
    width: var(--vdoc-page-width) !important;
    height: var(--vdoc-page-height) !important;
    margin: 0 auto calc(
        var(--vdoc-page-gap) + var(--vdoc-zoom-height-compensation, 0px)
    ) !important;
    overflow: hidden;
    color: #1d2421;
    background: #fffdf8;
    box-shadow: 0 18px 55px rgba(0, 0, 0, .34);
    transform: scale(var(--vdoc-zoom, 1));
    transform-origin: top center;
}
.vdoc-page-content {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: var(--vdoc-page-padding-block) var(--vdoc-page-padding-inline);
    overflow: hidden;
}
`;
            return [
                primitives.baseCss(model().manifest.scene, options),
                customCss,
                advancedCss,
                editCss,
            ].join('\n');
        }

        function createSurface(target, surface, options = {}) {
            const root = primitives.ensureShadowRoot(target);
            root.replaceChildren();
            const style = primitives.createStyle(
                flowCss(surface, options)
            );
            const runtime = primitives.createRuntime(
                surface === 'edit'
                    ? 'vdoc-runtime vdoc-flow-runtime'
                    : 'vdoc-runtime vdoc-paged-runtime',
                model().manifest.scene.kind,
                options.zoom
            );
            root.append(style, runtime);
            return { root, runtime };
        }

        function activatePlugins(root, surface, adapter) {
            if (surface === 'edit') {
                context.editorPort?.bindSurface?.(root);
                context.objectPort?.bindRoot?.(root);
                context.renderedTextPort?.activate?.({
                    kind: 'flow',
                    root,
                    adapter,
                });
            }
            context.runtimePort?.activate?.({
                kind: 'flow',
                surface,
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
            pagination.renderContinuous(
                primitives.resolveResources(compiled.previewHtml),
                runtime,
                { ensureIds: (html) => html }
            );
            primitives.renderMath(root);
            primitives.renderMermaid(root);
            primitives.updateZoomLayout(root, options.zoom);
            context.visibilityPort?.observe?.(
                root,
                options.scrollHost,
                {
                    selector: '[data-vdoc-island]',
                    rootMargin: '0px',
                    viewportRoot: true,
                }
            );
            activatePlugins(root, 'edit', adapter);
            return Object.freeze({
                root,
                runtime,
                dispose() {
                    context.visibilityPort?.disconnect?.(root);
                    context.editorPort?.disposeSurface?.();
                    context.objectPort?.clearSelection?.();
                    context.renderedTextPort?.disposeSurface?.();
                    context.runtimePort?.disposeSurface?.('edit');
                },
            });
        }

        function renderRead(options = {}) {
            const { adapter, target, compiled } = options;
            const { root, runtime } = createSurface(
                target,
                'read',
                options
            );
            const result = pagination.paginate(
                primitives.resolveResources(compiled.html),
                runtime,
                {
                    ensureIds: (html) => html,
                    scene: model().manifest.scene,
                    zoom: options.zoom,
                }
            );
            primitives.renderMath(root);
            primitives.renderMermaid(root);
            primitives.updateZoomLayout(root, options.zoom);
            context.visibilityPort?.observe?.(
                root,
                options.scrollHost,
                {
                    selector: '[data-vdoc-island]',
                    rootMargin: '0px',
                    viewportRoot: true,
                }
            );
            activatePlugins(root, 'read', adapter);
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

        function patchRegion(shell, ordinal, caretSourceOffset = null) {
            if (!shell?.isConnected || !Number.isInteger(Number(ordinal))) {
                return false;
            }
            const compiled = context.adapter?.compile?.({ force: true });
            const template = document.createElement('template');
            template.innerHTML = compiled?.previewHtml || '';
            const replacement = template.content.querySelectorAll(
                '[data-vdoc-edit-key]'
            )[Number(ordinal)];
            if (!replacement) return false;
            shell.replaceChildren(...replacement.childNodes);
            shell.dataset.vdocEditKey = replacement.dataset.vdocEditKey;
            shell.dataset.vdocEditType = replacement.dataset.vdocEditType;
            shell.dataset.vdocFlowKind = replacement.dataset.vdocFlowKind;
            primitives.renderMath(shell);
            primitives.renderMermaid(shell);
            context.editorPort?.installMappings?.(
                shell.getRootNode()
            );
            if (Number.isFinite(caretSourceOffset)) {
                context.restoreCaret?.(
                    shell,
                    caretSourceOffset,
                    compiled.editRegions[Number(ordinal)]
                );
            }
            return true;
        }

        return Object.freeze({
            kind: 'flow-renderer',
            renderEdit,
            renderRead,
            patchRegion,
            buildCss: flowCss,
        });
    }

    window.ScriptoriumFlowRenderer = Object.freeze({
        createFlowRenderer,
    });
})();