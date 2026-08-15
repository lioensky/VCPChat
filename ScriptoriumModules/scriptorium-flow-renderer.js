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
            const networkFontImports =
                primitives.trustedNetworkFontImports?.([
                    model().source?.content || '',
                    model().source?.documentCss || '',
                ]) || '';
            const customCss = primitives.cssForShadow(
                model().source?.documentCss || ''
            );
            const advancedCss = primitives.compiledStyleIdsCss(
                model().manifest?.styleDependencies || []
            );
            const editCss = surface === 'edit'
                ? `
.vdoc-flow-runtime {
    box-sizing: border-box;
    width: min(calc(100% - 48px), 1440px);
    max-width: calc(100% - 48px);
    min-height: calc(100% - 64px);
    margin: 0 auto;
    padding: clamp(28px, 4vw, 64px) clamp(22px, 5vw, 72px) 96px;
    color: var(--primary-text, #f2f0e9);
    background: transparent;
    zoom: var(--vdoc-zoom, 1);
}
.vdoc-edit-region {
    position: relative;
    width: 100%;
    max-width: 100%;
    min-width: 0;
}
.vdoc-edit-region[data-vdoc-edit-type="island"]:hover {
    outline: 1px solid rgba(217, 119, 69, .42);
    outline-offset: 5px;
}
.vdoc-md-flow-surface {
    display: flow-root;
    box-sizing: border-box;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: hidden;
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
    /*
     * 单块 Markdown 与 HTML 编辑树必须沿用静态渲染的行盒。源码缩进、
     * 标签间换行仍保留在 textContent 中，但不能用 break-spaces 将它们
     * 变成额外可见行；真正的多行 Markdown 在下方逐行启用该规则。
     */
    white-space: normal;
    overflow-wrap: normal;
    word-break: normal;
    tab-size: 4;
    caret-color: #3a8b78;
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
}
/*
 * 单行裸文本没有需要逐字符展示的源码空白，编辑态应与静态 Markdown
 * 渲染完全共用普通空白折叠和换行策略。尤其不能使用 anywhere，否则
 * 两端对齐段落在获得焦点时会重新计算换行机会并产生轻微几何跳动。
 */
.vdoc-md-live-preview.vdoc-md-plain-text-preview {
    white-space: normal;
    overflow-wrap: normal;
    word-break: normal;
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
.vdoc-md-live-preview-run > [data-vdoc-md-line-separator] {
    /*
     * 该节点只保存源码中的一个换行偏移。相邻编辑行本身已经是块级盒，
     * 不应再让分隔符内的换行参与布局，否则 break-spaces 会额外占一行。
     */
    display: none !important;
}
.vdoc-md-live-preview-run > .vdoc-md-live-preview-line {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    /*
     * 每个节点代表源码中的一行，而不是一个独立段落。静态段落的外边距
     * 已提升到 run 容器；这里必须清零，否则每次 Enter 都会叠加一组
     * p/h*/blockquote margin，表现为输入态行距远大于最终渲染态。
     */
    margin-block: 0;
    white-space: break-spaces;
    overflow-wrap: anywhere;
    line-height: inherit;
}
.vdoc-md-live-preview-run
    > .vdoc-md-live-preview-line[data-vdoc-md-line-kind="quote"] {
    /*
     * 该节点只是逐行编辑树中的一行，不是独立 blockquote 块。
     * 垂直 margin 会直接叠加到下一行，使编辑态基线步进大于渲染态。
     */
    margin-block: 0;
    padding-inline-start: 1em;
    border-inline-start: 3px solid color-mix(
        in srgb,
        currentColor 34%,
        transparent
    );
    color: color-mix(in srgb, currentColor 82%, transparent);
}
.vdoc-md-live-preview-run
    > .vdoc-md-live-preview-line[data-vdoc-md-line-kind="list"],
.vdoc-md-live-preview-run
    > .vdoc-md-live-preview-line[data-vdoc-md-line-kind="task-list"] {
    position: relative;
    display: list-item;
    margin-inline-start: 1.65em;
    padding-inline-start: .2em;
}
.vdoc-md-live-preview-run
    > .vdoc-md-live-preview-line[data-vdoc-md-line-kind="task-list"] {
    list-style-type: square;
}
.vdoc-md-live-preview-run
    > .vdoc-md-live-preview-line[data-vdoc-md-line-kind="table"] {
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
.vdoc-md-live-preview-run
    > .vdoc-md-live-preview-line[data-vdoc-md-line-kind="table"]
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
    font-family: inherit;
    /*
     * Markdown 标记展开只允许影响当前行的横向占位。字号、字体和基线
     * 全部继承正文，避免标记参与行盒计算后引发上下位移、行高变化，
     * 或产生正文在获得焦点时字号轻微跳变的视觉错觉。
     */
    font-size: inherit;
    font-style: normal;
    font-weight: 600;
    line-height: inherit;
    text-decoration: none;
    vertical-align: baseline;
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
    min-width: 0;
    padding-block: var(--vdoc-page-padding-block);
    padding-inline: var(--vdoc-page-padding-inline);
    overflow: hidden;
}
.vdoc-page-body {
    display: flow-root;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 0;
    overflow: visible;
}
.vdoc-page-content .vdoc-pagination-shell {
    display: flow-root;
    min-width: 0;
    max-width: 100%;
}
.vdoc-page-content img,
.vdoc-page-content svg,
.vdoc-page-content video,
.vdoc-page-content canvas,
.vdoc-page-content iframe,
.vdoc-page-content object,
.vdoc-page-content embed {
    box-sizing: border-box;
    max-width: 100% !important;
}
.vdoc-page-content img,
.vdoc-page-content svg,
.vdoc-page-content video {
    width: auto;
    height: auto;
    max-height: calc(
        var(--vdoc-page-height) - 50mm
    ) !important;
    object-fit: contain;
}
.vdoc-page-content figure {
    box-sizing: border-box;
    max-width: 100%;
    margin-inline: 0;
}
.vdoc-page-content figure > img,
.vdoc-page-content figure > svg,
.vdoc-page-content figure > video {
    display: block;
    margin-inline: auto;
}
.vdoc-page-content [data-vdoc-island],
.vdoc-page-content [data-vdoc-interactive],
.vdoc-page-content [data-vdoc-component] {
    box-sizing: border-box;
    max-width: 100%;
}
`;
            return [
                networkFontImports,
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
            const resolvedHtml = primitives.resolveResources(compiled.html);
            let paginationHtml = resolvedHtml;
            const paginate = () => pagination.paginate(
                paginationHtml,
                runtime,
                {
                    ensureIds: (html) => html,
                    scene: model().manifest.scene,
                    zoom: options.zoom,
                }
            );
            let result = paginate();
            primitives.renderMath(root);
            const mermaidReady = Promise.resolve(
                primitives.renderMermaid(root)
            ).catch(() => []);
            primitives.updateZoomLayout(root, options.zoom);
            let disposed = false;
            let activationFrame = 0;
            let settleFrame = 0;
            let resolveActivation = null;
            let resolveSettle = null;

            const activateRuntime = () => context.runtimePort?.activate?.({
                kind: 'flow',
                surface: 'read',
                root,
                adapter,
                scrollHost: options.scrollHost,
            });

            const activateRuntimeOnFrame = () => new Promise((resolve) => {
                resolveActivation = resolve;
                activationFrame = window.requestAnimationFrame(() => {
                    activationFrame = 0;
                    resolveActivation = null;
                    if (disposed || !root.host?.isConnected) {
                        resolve(false);
                        return;
                    }
                    activateRuntime();
                    resolve(true);
                });
            });

            const waitForLayoutFrame = () => new Promise((resolve) => {
                resolveSettle = resolve;
                settleFrame = window.requestAnimationFrame(() => {
                    settleFrame = 0;
                    resolveSettle = null;
                    resolve();
                });
            });

            const waitForImages = () => {
                const pending = [...root.querySelectorAll('img')]
                    .filter((image) => !image.complete);
                if (!pending.length) return Promise.resolve();
                return Promise.allSettled(pending.map((image) =>
                    new Promise((resolve) => {
                        image.addEventListener('load', resolve, { once: true });
                        image.addEventListener('error', resolve, { once: true });
                    })
                ));
            };

            const snapshotRenderedIslands = (sourceHtml) => {
                const selector = [
                    '[data-vdoc-island]',
                    '[data-vdoc-interactive]',
                    '[data-vdoc-component]',
                ].join(',');
                const template = document.createElement('template');
                template.innerHTML = sourceHtml;
                const sourceIslands = [...template.content.querySelectorAll(
                    selector
                )];
                const renderedIslands = [...root.querySelectorAll(selector)];
                const sourceByIslandId = new Map(
                    sourceIslands
                        .filter((island) => island.dataset.vdocIsland)
                        .map((island) => [
                            island.dataset.vdocIsland,
                            island,
                        ])
                );
                renderedIslands.forEach((renderedIsland, index) => {
                    const islandId = renderedIsland.dataset.vdocIsland;
                    const sourceIsland = (
                        islandId
                            ? sourceByIslandId.get(islandId)
                            : sourceIslands[index]
                    );
                    if (sourceIsland) {
                        sourceIsland.replaceWith(
                            renderedIsland.cloneNode(true)
                        );
                    }
                });
                return template.innerHTML;
            };

            const removeRuntimeGeneratedNodes = () => {
                root.querySelectorAll(
                    '[data-vdoc-runtime-generated="true"]'
                ).forEach((node) => node.remove());
            };

            const timeout = (wait) => new Promise((resolve) =>
                window.setTimeout(resolve, wait)
            );
            const initialRuntimeReady = activateRuntimeOnFrame();
            const assetsReady = Promise.race([
                Promise.allSettled([
                    document.fonts?.ready || Promise.resolve(),
                    waitForImages(),
                    mermaidReady,
                ]),
                timeout(1800),
            ]);
            const ready = Promise.all([
                initialRuntimeReady,
                assetsReady,
            ]).then(async () => {
                if (disposed || !root.host?.isConnected) return result;

                // 岛脚本可能在首帧同步创建内容，并在紧随其后的帧中完成
                // 尺寸写入。二次等待图片和两个布局帧，确保快照反映最终高度。
                await waitForImages();
                await waitForLayoutFrame();
                await waitForLayoutFrame();
                if (disposed || !root.host?.isConnected) return result;

                paginationHtml = snapshotRenderedIslands(resolvedHtml);
                context.runtimePort?.disposeSurface?.('read');
                result = paginate();

                // 运行态快照只负责给分页器提供真实几何。最终页面重新执行
                // 原始岛脚本前移除其生成节点，避免表格行、画布等被重复创建。
                removeRuntimeGeneratedNodes();
                primitives.renderMath(root);
                await Promise.resolve(
                    primitives.renderMermaid(root)
                ).catch(() => []);
                primitives.updateZoomLayout(root, options.zoom);
                if (!disposed && root.host?.isConnected) {
                    activateRuntime();
                }
                return result;
            });

            return Object.freeze({
                root,
                runtime,
                get result() {
                    return result;
                },
                ready,
                dispose() {
                    disposed = true;
                    if (activationFrame) {
                        window.cancelAnimationFrame(activationFrame);
                        activationFrame = 0;
                        resolveActivation?.(false);
                        resolveActivation = null;
                    }
                    if (settleFrame) {
                        window.cancelAnimationFrame(settleFrame);
                        settleFrame = 0;
                        resolveSettle?.();
                        resolveSettle = null;
                    }
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