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
            const advancedCss = primitives.compiledStyleIdsCss(
                documentModel.manifest.styleDependencies || []
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
            return `${primitives.baseCss(scene, options)
                .replace('@import url("../vendor/katex.min.css");', '')
                .replace(':host {', ':root {')}
${adapter.currentCss()}
@page {
    size: ${scene.page.width} ${scene.page.height};
    margin: 0;
}
html,body{margin:0;background:#fff}
.vdoc-paged-runtime{padding:0}
.vdoc-page{
    transform:none!important;
    margin:0!important;
    box-shadow:none!important;
    break-after:page;
}
html[data-vdoc-pdf="true"] *,
html[data-vdoc-pdf="true"] *::before,
html[data-vdoc-pdf="true"] *::after {
    animation-play-state:paused!important;
    transition:none!important;
}`;
        }

        function pagedHtml(adapter, options = {}) {
            const readSurface = options.surfacePort?.renderRead?.({
                force: true,
                export: true,
            });
            const runtime = readSurface?.runtime
                || readSurface?.root?.querySelector?.('.vdoc-paged-runtime');
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
            });
        }

        function build(options = {}) {
            const adapter = options.adapter;
            const compiled = options.compiled || adapter.compile();
            if (!adapter || adapter.kind !== 'flow') {
                throw new TypeError('Flow exporter only accepts a flow adapter.');
            }
            if (options.format === 'html-flow') {
                return Object.freeze({
                    html: continuousHtml(adapter, compiled),
                    paged: false,
                    page: model().manifest.scene.page,
                });
            }
            return Object.freeze({
                html: pagedHtml(adapter, options),
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