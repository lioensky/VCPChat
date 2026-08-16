'use strict';

(() => {
    function createRenderPrimitives(context = {}) {
        const core = context.core;
        const styleLibrary = context.styleLibrary;
        const hybridCompiler = context.hybridCompiler;
        const settingsPort = context.settingsPort || {};
        if (!core || !hybridCompiler) {
            throw new TypeError(
                'Render primitives require VDocCore and VDocHybridCompiler.'
            );
        }

        let mermaidSequence = 0;
        const TRUSTED_FONT_STYLE_ID =
            'scriptorium-trusted-network-font-imports';

        function ensureShadowRoot(host) {
            if (!host) throw new TypeError('A surface host is required.');
            return host.shadowRoot || host.attachShadow({ mode: 'open' });
        }

        function replaceShadowContent(host, ...nodes) {
            const root = ensureShadowRoot(host);
            root.replaceChildren(...nodes);
            return root;
        }

        function resolveResources(source) {
            return context.resourceResolver?.()?.resolveHtml?.(source)
                || String(source || '');
        }

        function cssForShadow(css) {
            return String(css || '')
                .replace(/(^|})\s*:root\s*\{/g, '$1\n:host {')
                .replace(/(^|})\s*html\s*,\s*body\s*\{/g, '$1\n:host {')
                .replace(/(^|})\s*body\s*\{/g, '$1\n:host {');
        }

        function markdownBaseCss(scope = '.vdoc-runtime') {
            return `
${scope} [data-vdoc-paragraph-break-placeholder="true"],
${scope} [data-vdoc-md-marker="paragraph-break"] {
    display: inline !important;
    margin: 0 !important;
    padding: 0 !important;
    color: transparent !important;
    caret-color: #3a8b78 !important;
    background: transparent !important;
    font-family: inherit !important;
    font-size: inherit !important;
    font-weight: inherit !important;
    line-height: inherit !important;
    letter-spacing: -.92em !important;
    white-space: nowrap !important;
    opacity: 1 !important;
    vertical-align: baseline !important;
    pointer-events: auto !important;
    user-select: text !important;
    -webkit-user-select: text !important;
}
${scope} table {
    box-sizing: border-box;
    width: 100%;
    max-width: 100% !important;
    margin: 1.25em 0;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
    border-collapse: separate;
    border-spacing: 0;
    border-radius: 10px;
    background: color-mix(in srgb, currentColor 3%, transparent);
    table-layout: fixed;
}
${scope} th,
${scope} td {
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    padding: .62em .78em;
    overflow-wrap: anywhere;
    word-break: break-word;
    border-right: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    text-align: left;
    vertical-align: top;
}
${scope} th {
    font-weight: 700;
    background: color-mix(in srgb, currentColor 9%, transparent);
}
${scope} tr > :last-child { border-right: 0; }
${scope} tbody tr:last-child > td { border-bottom: 0; }
${scope} tbody tr:nth-child(even) {
    background: color-mix(in srgb, currentColor 3.5%, transparent);
}
${scope} table code {
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
}
`;
        }

        function baseCss(sceneInput, options = {}) {
            const scene = core.createSceneConfig(sceneInput);
            const zoom = Math.max(50, Math.min(200, Number(options.zoom) || 100));
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
    --vdoc-zoom: ${zoom / 100};
}
.vdoc-runtime {
    display: block;
    user-select: text;
    -webkit-user-select: text;
}
.vdoc-runtime [data-vdoc-island] {
    user-select: text;
    -webkit-user-select: text;
}
/*
 * 独占一行的 ↵ 是 Scriptorium 内部回车占位符。节点必须留在排版树和
 * Selection 映射中，但字符本身在编辑、阅读、分页和导出中均不可见。
 */
.vdoc-runtime [data-vdoc-paragraph-break-placeholder="true"],
.vdoc-runtime [data-vdoc-md-marker="paragraph-break"] {
    display: inline !important;
    margin: 0 !important;
    padding: 0 !important;
    color: transparent !important;
    caret-color: #3a8b78 !important;
    background: transparent !important;
    font-family: inherit !important;
    font-size: inherit !important;
    font-weight: inherit !important;
    line-height: inherit !important;
    letter-spacing: -.92em !important;
    white-space: nowrap !important;
    opacity: 1 !important;
    vertical-align: baseline !important;
    pointer-events: auto !important;
    user-select: text !important;
    -webkit-user-select: text !important;
}
.vdoc-runtime [data-vdoc-style-target="paragraph"] {
    display: block;
}
.vdoc-runtime-paused *,
.vdoc-runtime-paused *::before,
.vdoc-runtime-paused *::after {
    animation-play-state: paused !important;
    transition: none !important;
}
[data-vdoc-atomic] { caret-color: transparent !important; }
[data-vdoc-atomic="math"],
[data-vdoc-atomic="mermaid"],
[data-vdoc-atomic="media"] {
    user-select: all;
    -webkit-user-select: all;
}
::highlight(scriptorium-find-match) {
    color: inherit;
    background: rgba(242, 169, 0, .36);
    text-decoration: underline rgba(184, 117, 0, .72) 1px;
}
::highlight(scriptorium-find-current) {
    color: #171c1a;
    background: #ffc94a;
    text-decoration: underline #8b5e00 2px;
}
${markdownBaseCss('.vdoc-runtime')}
`;
        }

        function editDecorationsCss() {
            return `
[data-vdoc-text][data-vdoc-editor-selected="true"] {
    position: relative;
    outline: 2px solid rgba(58, 139, 120, .72) !important;
    outline-offset: 3px;
    background-color: rgba(58, 139, 120, .12) !important;
    box-shadow: 0 0 0 5px rgba(58, 139, 120, .06) !important;
}
[data-vdoc-object-id] {
    box-sizing: border-box;
    touch-action: none;
}
[data-vdoc-object-id][data-vdoc-object-layout="free"] {
    cursor: move;
    user-select: none;
}
[data-vdoc-object-id][data-vdoc-object-selected="true"] {
    outline: 2px solid #3a8b78 !important;
    outline-offset: 4px;
    box-shadow: 0 0 0 6px rgba(58, 139, 120, .14) !important;
}
[data-vdoc-object-id][data-vdoc-object-dragging="true"] {
    cursor: grabbing !important;
    opacity: .84;
}
[data-vdoc-object-id] > [data-vdoc-object-resize-handle] {
    position: absolute !important;
    z-index: 2147483000 !important;
    display: block !important;
    width: 11px !important;
    height: 11px !important;
    padding: 0 !important;
    border: 2px solid #fff !important;
    border-radius: 3px !important;
    background: #3a8b78 !important;
    box-shadow: 0 1px 5px rgba(0, 0, 0, .42) !important;
    pointer-events: auto !important;
    touch-action: none !important;
}
[data-vdoc-object-resize-handle="nw"] {
    top: -7px !important;
    left: -7px !important;
    cursor: nwse-resize !important;
}
[data-vdoc-object-resize-handle="ne"] {
    top: -7px !important;
    right: -7px !important;
    cursor: nesw-resize !important;
}
[data-vdoc-object-resize-handle="sw"] {
    bottom: -7px !important;
    left: -7px !important;
    cursor: nesw-resize !important;
}
[data-vdoc-object-resize-handle="se"] {
    right: -7px !important;
    bottom: -7px !important;
    cursor: nwse-resize !important;
}
`;
        }

        function compiledStyleIdsCss(ids = []) {
            return styleLibrary?.compileCss?.([...ids]) || '';
        }

        function referencedStyleIds(sources = []) {
            const ids = new Set();
            const pattern = /\bdata-vdoc-style\s*=\s*(["'])(.*?)\1/gi;
            (Array.isArray(sources) ? sources : [sources]).forEach((source) => {
                const html = String(source || '');
                let match = null;
                while ((match = pattern.exec(html))) {
                    String(match[2] || '')
                        .split(/\s+/)
                        .map((id) => id.trim())
                        .filter(Boolean)
                        .forEach((id) => ids.add(id));
                }
            });
            return [...ids];
        }

        function compiledDocumentStylesCss(documentModel, sources = []) {
            const manifest = documentModel?.manifest || {};
            const ids = new Set([
                ...(manifest.styleDependencies || []).map(String),
                ...referencedStyleIds(sources),
            ]);
            const embedded = new Map(
                (Array.isArray(manifest.embeddedStyles)
                    ? manifest.embeddedStyles
                    : [])
                    .filter((style) => style?.id && style?.css)
                    .map((style) => [String(style.id), style])
            );
            return [...ids].map((id) => {
                const registered = styleLibrary?.get?.(id);
                if (registered) {
                    return styleLibrary.compileCss([id]);
                }
                const style = embedded.get(id);
                if (!style) return '';
                return `/* ${style.name || id} · ${id}@${
                    Math.max(1, Number(style.version) || 1)
                } */\n${String(style.css)}`;
            }).filter(Boolean).join('\n\n');
        }

        function extractHttpsImports(css) {
            const imports = [];
            String(css || '').replace(
                /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))\s*\)?([^;]*);?/gi,
                (_source, doubleQuoted, singleQuoted, bare, suffix = '') => {
                    const url = String(
                        doubleQuoted || singleQuoted || bare || ''
                    ).trim();
                    if (/^https:\/\//i.test(url)) {
                        imports.push(
                            `@import url("${url.replace(/["\\]/g, '\\$&')}")${
                                String(suffix || '').trim()
                                    ? ` ${String(suffix).trim()}`
                                    : ''
                            };`
                        );
                    }
                    return _source;
                }
            );
            return [...new Set(imports)];
        }

        function installTrustedNetworkFontImports(imports) {
            const css = String(imports || '').trim();
            if (typeof document === 'undefined' || !document.head) return css;
            const id = TRUSTED_FONT_STYLE_ID;
            let style = document.getElementById(id);
            if (!css || settingsPort.get?.('trustNetworkFonts') !== true) {
                style?.remove();
                return '';
            }
            if (!style) {
                style = document.createElement('style');
                style.id = id;
                style.dataset.scriptoriumTrustedNetworkFonts = 'true';
                document.head.appendChild(style);
            }
            if (style.textContent !== css) style.textContent = css;
            return css;
        }

        function trustedNetworkFontImports(sources = []) {
            const imports = settingsPort.get?.('trustNetworkFonts') === true
                ? [...new Set(
                    (Array.isArray(sources) ? sources : [sources])
                        .flatMap(extractHttpsImports)
                )].join('\n')
                : '';
            // Chromium 会请求 ShadowRoot 内的 @import，却可能不把其中的
            // @font-face 注册到宿主页 FontFaceSet。同步安装到 document.head，
            // 使字体面全局注册后再供 Shadow DOM 中的排版规则使用。
            return installTrustedNetworkFontImports(imports);
        }

        function hoistTrustedImports(css) {
            const imports = [];
            const body = String(css || '').replace(
                /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))\s*\)?([^;]*);?/gi,
                (source, doubleQuoted, singleQuoted, bare, suffix = '') => {
                    const url = String(
                        doubleQuoted || singleQuoted || bare || ''
                    ).trim();
                    const remote = /^[a-z][a-z0-9+.-]*:/i.test(url)
                        || /^\/\//.test(url);
                    const allowed = !remote
                        || (
                            /^https:\/\//i.test(url)
                            && settingsPort.get?.('trustNetworkFonts') === true
                        );
                    if (allowed) {
                        imports.push(
                            `@import url("${url.replace(/["\\]/g, '\\$&')}")${
                                String(suffix || '').trim()
                                    ? ` ${String(suffix).trim()}`
                                    : ''
                            };`
                        );
                    }
                    // 本地依赖始终可用；HTTPS 仅在显式信任后提升到普通规则前。
                    // 其它远程协议继续按安全策略移除。
                    return '';
                }
            );
            return imports.length
                ? `${[...new Set(imports)].join('\n')}\n${body}`
                : body;
        }

        function createStyle(css, dataset = {}) {
            const style = document.createElement('style');
            Object.entries(dataset).forEach(([key, value]) => {
                style.dataset[key] = String(value);
            });
            style.textContent = hoistTrustedImports(resolveResources(css));
            return style;
        }

        function createRuntime(className, sceneKind, zoom = 100) {
            const runtime = document.createElement('div');
            runtime.className = className;
            runtime.dataset.sceneKind = String(sceneKind || '');
            runtime.style.setProperty(
                '--vdoc-zoom',
                String(Math.max(50, Math.min(200, Number(zoom) || 100)) / 100)
            );
            return runtime;
        }

        function decodeMathSource(node) {
            try {
                return decodeURIComponent(node.dataset.vdocMath || '');
            } catch {
                return node.dataset.vdocMath || node.textContent || '';
            }
        }

        function restoreMathSemantics(root) {
            root?.querySelectorAll?.('[data-vdoc-math]').forEach((node) => {
                node.replaceChildren(
                    document.createTextNode(decodeMathSource(node))
                );
                node.removeAttribute('aria-hidden');
            });
            return root;
        }

        function renderMath(root) {
            root?.querySelectorAll?.('[data-vdoc-math]').forEach((node) => {
                const latex = decodeMathSource(node);
                node.contentEditable = 'false';
                node.dataset.vdocAtomic = 'math';
                node.dataset.vdocStableId = node.dataset.vdocStableId
                    || `math-${hybridCompiler.simpleHash(latex)}`;
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
            return root;
        }

        function decodeMermaidSource(node) {
            try {
                return decodeURIComponent(node.dataset.vdocMermaid || '');
            } catch {
                return node.dataset.vdocMermaid || node.textContent || '';
            }
        }

        async function renderMermaid(root) {
            const nodes = [...(root?.querySelectorAll?.(
                '[data-vdoc-mermaid]'
            ) || [])].filter((node) =>
                node.dataset.vdocMermaidRendered !== 'true'
                && node.dataset.vdocMermaidRendering !== 'true'
            );
            if (!nodes.length || !window.mermaid?.render) return [];
            window.mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: 'neutral',
            });
            return Promise.all(nodes.map(async (node) => {
                const source = decodeMermaidSource(node);
                const renderId = `vdoc-mermaid-${Date.now().toString(36)}-${
                    mermaidSequence += 1
                }`;
                node.contentEditable = 'false';
                node.dataset.vdocAtomic = 'mermaid';
                node.dataset.vdocStableId = node.dataset.vdocStableId
                    || `mermaid-${hybridCompiler.simpleHash(source)}`;
                node.dataset.vdocMermaidRendering = 'true';
                try {
                    const result = await window.mermaid.render(renderId, source);
                    const template = document.createElement('template');
                    template.innerHTML = String(
                        typeof result === 'string' ? result : result?.svg || ''
                    ).trim();
                    const svg = template.content.querySelector('svg');
                    if (!svg) throw new Error('Mermaid 没有返回 SVG 根。');
                    svg.setAttribute('role', 'img');
                    svg.setAttribute('aria-label', 'Mermaid 图表');
                    svg.style.maxWidth = '100%';
                    svg.style.height = 'auto';
                    node.replaceChildren(svg);
                    node.dataset.vdocMermaidRendered = 'true';
                    result?.bindFunctions?.(node);
                    return node;
                } catch (error) {
                    node.dataset.vdocMermaidError = error.message;
                    const fallback = document.createElement('pre');
                    fallback.className = 'vdoc-mermaid-source';
                    fallback.textContent = source;
                    node.replaceChildren(fallback);
                    return null;
                } finally {
                    node.removeAttribute('data-vdoc-mermaid-rendering');
                }
            }));
        }

        function updateZoomLayout(root, zoom = 100) {
            if (!root) return;
            const scale = Math.max(50, Math.min(200, Number(zoom) || 100)) / 100;
            root.querySelectorAll('.vdoc-page').forEach((page) => {
                const baseHeight = page.offsetHeight;
                page.style.setProperty(
                    '--vdoc-zoom-height-compensation',
                    `${Number.isFinite(baseHeight)
                        ? baseHeight * (scale - 1)
                        : 0}px`
                );
                page.style.setProperty('--vdoc-zoom', String(scale));
            });
            const slide = root.querySelector('.vdoc-slide-editor-runtime');
            if (slide) {
                slide.style.setProperty('--vdoc-zoom', String(scale));
                slide.style.marginBottom = `calc(88px + ${
                    slide.offsetHeight * (scale - 1)
                }px)`;
            }
        }

        return Object.freeze({
            ensureShadowRoot,
            replaceShadowContent,
            resolveResources,
            cssForShadow,
            markdownBaseCss,
            baseCss,
            editDecorationsCss,
            compiledStyleIdsCss,
            referencedStyleIds,
            compiledDocumentStylesCss,
            extractHttpsImports,
            installTrustedNetworkFontImports,
            trustedNetworkFontImports,
            hoistTrustedImports,
            createStyle,
            createRuntime,
            decodeMathSource,
            restoreMathSemantics,
            renderMath,
            decodeMermaidSource,
            renderMermaid,
            updateZoomLayout,
        });
    }

    window.ScriptoriumRenderPrimitives = Object.freeze({
        createRenderPrimitives,
    });
})();