'use strict';

(() => {
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function createFlowExporter(context = {}) {
        const documentPort = context.documentPort;
        const primitives = context.primitives;
        const pagination = context.pagination;
        if (!documentPort || !primitives || !pagination) {
            throw new TypeError(
                'Flow exporter requires DocumentPort, render primitives and pagination.'
            );
        }

        function model() {
            const documentModel = documentPort.document();
            if (!documentModel) throw new Error('No flow document is open.');
            return documentModel;
        }

        function continuousHtml(adapter, compiled) {
            const documentModel = model();
            const title = escapeHtml(
                documentModel.manifest.title
                || documentPort.status().currentName
            );
            const language = escapeHtml(
                documentModel.manifest.language || 'zh-CN'
            );
            const advancedCss = primitives.compiledDocumentStylesCss(
                documentModel,
                [adapter.currentSource(), compiled.html]
            );
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
${primitives.markdownBaseCss('.vdoc-flow-export')}
${advancedCss}
${adapter.currentCss()}
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

        function pagedCss(adapter, options = {}) {
            const documentModel = model();
            const scene = documentModel.manifest.scene;
            const advancedCss = primitives.compiledDocumentStylesCss(
                documentModel,
                adapter.currentSource()
            );
            return `${primitives.baseCss(scene, options)
                .replace('@import url("../vendor/katex.min.css");', '')
                .replace(':host {', ':root {')}
${advancedCss}
${adapter.currentCss()}
@page {
    size: ${scene.page.width} ${scene.page.height};
    margin: 0;
}
html,body{
    min-width:100%;
    min-height:100%;
    margin:0;
    background:#202426;
}
body{
    overflow-x:auto;
}
.vdoc-paged-runtime{
    box-sizing:border-box;
    width:100%;
    min-width:calc(var(--vdoc-page-width) + 48px);
    padding:32px 24px 64px;
}
.vdoc-page{
    box-sizing:border-box;
    width:var(--vdoc-page-width)!important;
    height:var(--vdoc-page-height)!important;
    margin:0 auto var(--vdoc-page-gap)!important;
    overflow:hidden;
    color:#1d2421;
    background:#fffdf8;
    transform:none!important;
    box-shadow:0 18px 55px rgba(0,0,0,.32);
    break-after:page;
}
.vdoc-page-content{
    box-sizing:border-box;
    width:100%;
    height:100%;
    min-width:0;
    padding-block:var(--vdoc-page-padding-block);
    padding-inline:var(--vdoc-page-padding-inline);
    overflow:hidden;
}
.vdoc-page-body{
    display:flow-root;
    box-sizing:border-box;
    width:100%;
    height:100%;
    min-width:0;
    overflow:visible;
}
.vdoc-page-content .vdoc-pagination-shell{
    display:flow-root;
    min-width:0;
    max-width:100%;
}
.vdoc-page-content img,
.vdoc-page-content svg,
.vdoc-page-content video,
.vdoc-page-content canvas,
.vdoc-page-content iframe,
.vdoc-page-content object,
.vdoc-page-content embed{
    box-sizing:border-box;
    max-width:100%!important;
}
.vdoc-page-content img,
.vdoc-page-content svg,
.vdoc-page-content video{
    width:auto;
    height:auto;
    max-height:calc(var(--vdoc-page-height) - 50mm)!important;
    object-fit:contain;
}
.vdoc-page-content figure{
    box-sizing:border-box;
    max-width:100%;
    margin-inline:0;
}
.vdoc-page-content figure > img,
.vdoc-page-content figure > svg,
.vdoc-page-content figure > video{
    display:block;
    margin-inline:auto;
}
@media print{
    html,body{
        min-width:0;
        min-height:0;
        background:#fff;
    }
    body{
        overflow:visible;
    }
    .vdoc-paged-runtime{
        min-width:0;
        padding:0;
    }
    .vdoc-page{
        margin:0!important;
        box-shadow:none!important;
    }
}
html[data-vdoc-pdf="true"] *,
html[data-vdoc-pdf="true"] *::before,
html[data-vdoc-pdf="true"] *::after {
    animation-play-state:paused!important;
    transition:none!important;
}`;
        }

        async function pagedHtml(adapter, options = {}) {
            const scene = model().manifest.scene;
            const measurementHost = document.createElement('div');
            measurementHost.setAttribute('aria-hidden', 'true');
            measurementHost.style.cssText = [
                'position:fixed',
                'left:-100000px',
                'top:0',
                `width:${scene.page.width}`,
                'min-height:1px',
                'visibility:hidden',
                'pointer-events:none',
                'contain:layout style',
            ].join(';');
            document.body.appendChild(measurementHost);

            let readSurface = null;
            try {
                readSurface = options.surfacePort?.renderRead?.({
                    force: true,
                    export: true,
                    target: measurementHost,
                    scrollHost: measurementHost,
                    zoom: 100,
                });
                await readSurface?.ready;
                const runtime = readSurface?.runtime
                    || readSurface?.root?.querySelector?.(
                        '.vdoc-paged-runtime'
                    );
                if (!runtime) {
                    throw new Error('分页预览尚未生成。');
                }
                const documentModel = model();
                return pagination.buildPagedHtml({
                    title: documentModel.manifest.title
                        || documentPort.status().currentName,
                    language: documentModel.manifest.language,
                    runtime,
                    css: pagedCss(adapter, options),
                    // 屏幕外分页测量会给岛留下暂停类和初始化哨兵。
                    // 独立 HTML 需要恢复为待初始化状态，让内联脚本
                    // 在新文档中重新建立动画、事件和动态内容。
                    rehydrateRuntime: true,
                });
            } finally {
                options.surfacePort?.disposeRead?.();
                measurementHost.remove();
            }
        }

        async function build(options = {}) {
            const adapter = options.adapter;
            if (!adapter || adapter.kind !== 'flow') {
                throw new TypeError('Flow exporter only accepts a flow adapter.');
            }
            const compiled = options.compiled || adapter.compile();
            if (options.format === 'html-flow') {
                return Object.freeze({
                    html: continuousHtml(adapter, compiled),
                    paged: false,
                    page: model().manifest.scene.page,
                });
            }
            return Object.freeze({
                html: await pagedHtml(adapter, options),
                paged: true,
                page: model().manifest.scene.page,
            });
        }

        return Object.freeze({
            build,
            continuousHtml,
            pagedHtml,
            pagedCss,
        });
    }

    window.ScriptoriumFlowExport = Object.freeze({
        createFlowExporter,
    });
})();