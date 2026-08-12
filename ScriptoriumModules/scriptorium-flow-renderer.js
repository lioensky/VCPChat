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
    margin: 0;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
}
.vdoc-edit-region[data-vdoc-edit-active="true"] {
    z-index: 1;
}
.vdoc-edit-region[data-vdoc-edit-type="markdown"][data-vdoc-edit-active="true"] {
    margin: inherit;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    box-shadow: none;
}
.vdoc-md-live-preview {
    min-width: 0;
    min-height: 1em;
    border: 0;
    outline: 0;
    color: inherit;
    background: transparent;
    white-space: normal;
    overflow-wrap: anywhere;
    tab-size: 4;
    caret-color: #3a8b78;
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
}
.vdoc-md-live-preview-run {
    display: flow-root;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
}
.vdoc-md-live-preview-run > .vdoc-md-live-preview-line {
    min-width: 0;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
}
.vdoc-md-live-preview-line[data-vdoc-md-line-kind="quote"] {
    margin-block: .55em;
    padding-inline-start: 1em;
    border-inline-start: 3px solid color-mix(
        in srgb,
        currentColor 34%,
        transparent
    );
    color: color-mix(in srgb, currentColor 82%, transparent);
}
.vdoc-md-live-preview-line[data-vdoc-md-line-kind="list"],
.vdoc-md-live-preview-line[data-vdoc-md-line-kind="task-list"] {
    position: relative;
    display: list-item;
    margin-inline-start: 1.65em;
    padding-inline-start: .2em;
}
.vdoc-md-live-preview-line[data-vdoc-md-line-kind="task-list"] {
    list-style-type: square;
}
.vdoc-md-live-preview-line[data-vdoc-md-line-kind="table"] {
    margin: 0;
    padding: .34em .55em;
    border-inline: 1px solid color-mix(
        in srgb,
        currentColor 22%,
        transparent
    );
    background: color-mix(in srgb, currentColor 3.5%, transparent);
    font-family: Consolas, "Maple Mono", monospace;
}
.vdoc-md-live-preview-line[data-vdoc-md-line-kind="table"]
    + .vdoc-md-live-preview-line[data-vdoc-md-line-kind="table"] {
    border-top: 1px solid color-mix(
        in srgb,
        currentColor 16%,
        transparent
    );
}
.vdoc-md-live-preview-run > .vdoc-md-live-preview-line:empty::before {
    content: "\\200B";
}
.vdoc-md-live-preview:empty::before {
    content: "输入 Markdown…";
    color: color-mix(in srgb, currentColor 38%, transparent);
    pointer-events: none;
}
.vdoc-md-marker {
    display: inline;
    margin: 0;
    padding: 0;
    border: 0;
    color: color-mix(in srgb, currentColor 48%, #d97745);
    background: transparent;
    font-family: Consolas, "Maple Mono", monospace;
    font-size: .72em;
    font-style: normal;
    font-weight: 600;
    line-height: inherit;
    text-decoration: none;
    vertical-align: .06em;
    opacity: .72;
}
.vdoc-md-marker-concealed { display: none !important; }
.vdoc-md-marker-heading {
    color: color-mix(in srgb, currentColor 48%, #3a8b78);
}
.vdoc-md-marker-quote {
    color: color-mix(in srgb, currentColor 48%, #8b6cab);
}
.vdoc-md-marker-list,
.vdoc-md-marker-task-list {
    color: color-mix(in srgb, currentColor 48%, #b87828);
}
.vdoc-md-marker-html-tag {
    color: color-mix(in srgb, currentColor 42%, #6d7f91);
}
.vdoc-md-marker-strong {
    font-weight: 850;
}
.vdoc-md-marker-emphasis,
.vdoc-md-marker-italic {
    font-style: italic;
}
.vdoc-md-marker-strikethrough {
    text-decoration: line-through;
}
.vdoc-md-marker-code {
    color: #337ca0;
    background: rgba(51, 124, 160, .13);
}
[data-vdoc-inline-html-decoration="true"] {
    max-width: 100%;
}
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

        function activateEditPlugins(root, adapter) {
            context.editorPort?.bindSurface?.(root);
            context.objectPort?.bindRoot?.(root);
            context.renderedTextPort?.activate?.({
                kind: 'flow',
                root,
                adapter,
            });
        }

        function scheduleRuntimeActivation(
            root,
            surface,
            adapter,
            scrollHost
        ) {
            let canceled = false;
            const frame = window.requestAnimationFrame(() => {
                if (canceled || !root.host?.isConnected) return;
                context.runtimePort?.activate?.({
                    kind: 'flow',
                    surface,
                    root,
                    adapter,
                    scrollHost,
                });
            });
            return () => {
                canceled = true;
                window.cancelAnimationFrame(frame);
            };
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
            activateEditPlugins(root, adapter);
            const cancelRuntimeActivation = scheduleRuntimeActivation(
                root,
                'edit',
                adapter,
                options.scrollHost
            );
            return Object.freeze({
                root,
                runtime,
                dispose() {
                    cancelRuntimeActivation();
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
            const cancelRuntimeActivation = scheduleRuntimeActivation(
                root,
                'read',
                adapter,
                options.scrollHost
            );
            return Object.freeze({
                root,
                runtime,
                result,
                dispose() {
                    cancelRuntimeActivation();
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