'use strict';

(() => {
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (character) =>
            `&#${character.charCodeAt(0)};`
        );
    }

    function inlineScriptLiteral(source) {
        return JSON.stringify(String(source || ''))
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    function createDeckExporter(context = {}) {
        const documentPort = context.documentPort;
        const core = context.core;
        const primitives = context.primitives;
        const pagination = context.pagination;
        if (!documentPort || !core || !primitives || !pagination) {
            throw new TypeError(
                'Deck exporter requires DocumentPort, VDocCore, render primitives and pagination.'
            );
        }

        function model() {
            const documentModel = documentPort.document();
            if (!documentModel) throw new Error('No slide deck is open.');
            return documentModel;
        }

        function presentationHtml(adapter) {
            const documentModel = model();
            const scene = core.createSceneConfig(documentModel.manifest.scene);
            const title = escapeHtml(
                documentModel.manifest.title
                || documentPort.status().currentName
            );
            const language = escapeHtml(
                documentModel.manifest.language || 'zh-CN'
            );
            const slides = adapter.slides();
            const ratioParts = String(
                scene.presentation.aspectRatio || '16 / 9'
            ).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
            const ratioWidth = Number(ratioParts?.[1]) || 16;
            const ratioHeight = Number(ratioParts?.[2]) || 9;
            const numericRatio = ratioWidth / ratioHeight;
            const cssAspectRatio = `${ratioWidth} / ${ratioHeight}`;

            const slideMarkup = slides.map((slide, index) => {
                const parsed = adapter.parsedSlide(slide);
                return `<section class="vcp-slide${
                    index === 0 ? ' active' : ''
                }" data-slide-index="${index}" data-slide-id="${
                    escapeHtml(slide.id)
                }" data-transition="${
                    escapeHtml(core.normalizeTransition(slide.transition))
                }" aria-hidden="${index === 0 ? 'false' : 'true'}">
<style>${String(parsed.css).replace(/<\/style/gi, '<\\/style')}</style>
${parsed.html}
</section>`;
            }).join('\n');

            const slideScripts = slides.map((slide, index) => {
                const parsed = adapter.parsedSlide(slide);
                if (!parsed.script) return '';
                const safeSlideId = String(slide.id).replace(/['\\\r\n]/g, '');
                return `(() => {
    const scene = document.querySelector('[data-slide-index="${index}"]');
    if (!scene) return;
    try {
        const scopedDocument = new Proxy(document, {
            get(target, property) {
                if (property === 'querySelector') {
                    return (selector) =>
                        scene.querySelector(selector)
                        || target.querySelector(selector);
                }
                if (property === 'querySelectorAll') {
                    return (selector) => scene.querySelectorAll(selector);
                }
                if (property === 'getElementById') {
                    return (id) =>
                        scene.querySelector('#' + CSS.escape(String(id)))
                        || target.getElementById(id);
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function'
                    ? value.bind(target)
                    : value;
            }
        });
        const run = new Function(
            'scene',
            'deck',
            'document',
            ${inlineScriptLiteral(parsed.script)}
        );
        run.call(scene, scene, window.VCPDeck, scopedDocument);
    } catch (error) {
        console.error(
            '[VCPDeck] Scene ${safeSlideId} script failed:',
            error
        );
    }
})();`;
            }).filter(Boolean).join('\n');

            return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<style>
${adapter.currentCss()}
${primitives.compiledStyleIdsCss(
        documentModel.manifest.styleDependencies || []
    )}
*{box-sizing:border-box}
html,body{
    width:100%;
    height:100%;
    margin:0;
    overflow:hidden;
    background:#090b0c;
    color:#fff
}
body{
    display:grid;
    place-items:center;
    font-family:system-ui,sans-serif
}
.vcp-deck{
    position:relative;
    width:min(100vw,calc(100vh * ${numericRatio}));
    height:min(100vh,calc(100vw / ${numericRatio}));
    aspect-ratio:${cssAspectRatio};
    overflow:hidden;
    background:#fff;
    box-shadow:0 24px 90px rgba(0,0,0,.55)
}
.vcp-slide{
    position:absolute;
    inset:0;
    display:none;
    width:100%;
    height:100%;
    overflow:hidden;
    color:#1d2421;
    background:#fff
}
.vcp-slide.active{display:block}
.vcp-slide>.vdoc-slide-scene,
.vcp-slide>[data-vdoc-slide]{width:100%;height:100%}
.vcp-deck-control-dock{
    position:fixed;
    left:0;
    right:0;
    bottom:0;
    z-index:30;
    height:88px;
    display:flex;
    align-items:flex-end;
    justify-content:center;
    padding:0 18px 16px
}
.vcp-deck-controls{
    display:flex;
    align-items:center;
    gap:7px;
    padding:6px;
    border:1px solid rgba(255,255,255,.2);
    border-radius:10px;
    background:rgba(8,10,11,.78);
    box-shadow:0 12px 40px rgba(0,0,0,.38);
    backdrop-filter:blur(14px);
    opacity:0;
    transform:translateY(14px);
    transition:opacity .2s ease,transform .2s ease
}
.vcp-deck-control-dock:hover .vcp-deck-controls,
.vcp-deck-control-dock:focus-within .vcp-deck-controls{
    opacity:1;
    transform:translateY(0)
}
.vcp-deck-controls button{
    height:32px;
    min-width:34px;
    border:0;
    border-radius:7px;
    color:#fff;
    background:rgba(255,255,255,.1);
    cursor:pointer
}
.vcp-deck-status{
    min-width:64px;
    text-align:center;
    font:12px system-ui
}
@media print{
    html,body{
        height:auto;
        overflow:visible;
        background:#fff
    }
    .vcp-deck{
        display:block;
        width:${scene.page.width};
        height:auto;
        aspect-ratio:auto;
        box-shadow:none
    }
    .vcp-slide{
        position:relative;
        display:block!important;
        width:${scene.page.width};
        height:${scene.page.height};
        break-after:page
    }
    .vcp-deck-control-dock{display:none}
}
</style>
</head>
<body>
<main id="vcp-deck" class="vcp-deck" aria-label="${title}">
${slideMarkup}
</main>
<div class="vcp-deck-control-dock">
<nav class="vcp-deck-controls" aria-label="演示控制">
<button type="button" data-deck-action="previous" title="上一页">←</button>
<span class="vcp-deck-status">1 / ${slides.length}</span>
<button type="button" data-deck-action="next" title="下一页">→</button>
<button type="button" data-deck-action="fullscreen" title="全屏">⛶</button>
</nav>
</div>
<script>
(() => {
    const slides = [...document.querySelectorAll('.vcp-slide')];
    const status = document.querySelector('.vcp-deck-status');
    let index = 0;
    const show = (nextIndex) => {
        const normalized = Math.max(
            0,
            Math.min(slides.length - 1, Number(nextIndex) || 0)
        );
        slides.forEach((slide, slideIndex) => {
            const active = slideIndex === normalized;
            slide.classList.toggle('active', active);
            slide.setAttribute('aria-hidden', String(!active));
            slide.style.animation = 'none';
            if (active) {
                requestAnimationFrame(() =>
                    slide.style.removeProperty('animation')
                );
            }
        });
        index = normalized;
        if (status) {
            status.textContent =
                String(index + 1) + ' / ' + String(slides.length);
        }
        history.replaceState(
            null,
            '',
            '#slide-' + String(index + 1)
        );
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
        const action = event.target.closest(
            '[data-deck-action]'
        )?.dataset.deckAction;
        if (action === 'next') window.VCPDeck.next();
        else if (action === 'previous') window.VCPDeck.previous();
        else if (action === 'fullscreen') {
            document.documentElement.requestFullscreen?.();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
            event.preventDefault();
            window.VCPDeck.next();
        } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
            event.preventDefault();
            window.VCPDeck.previous();
        } else if (event.key === 'Home') {
            show(0);
        } else if (event.key === 'End') {
            show(slides.length - 1);
        }
    });
    const initial =
        Number(location.hash.match(/slide-(\\d+)/)?.[1] || 1) - 1;
    show(initial);
})();
${slideScripts}
</script>
</body>
</html>`;
        }

        function staticPagedHtml(adapter, options = {}) {
            const readSurface = options.surfacePort?.renderRead?.({
                force: true,
                export: true,
            });
            const runtime = readSurface?.runtime
                || readSurface?.root?.querySelector?.('.vdoc-paged-runtime');
            if (!runtime) {
                throw new Error('演示静态逐页预览尚未生成。');
            }
            const documentModel = model();
            const scene = core.createSceneConfig(
                documentModel.manifest.scene
            );
            const css = `${primitives.baseCss(scene, options)
                .replace('@import url("../vendor/katex.min.css");', '')
                .replace(':host {', ':root {')}
${adapter.currentCss()}
@page{
    size:${scene.page.width} ${scene.page.height};
    margin:0
}
html,body{margin:0;background:#fff}
.vdoc-paged-runtime{padding:0}
.vdoc-page{
    transform:none!important;
    margin:0!important;
    box-shadow:none!important;
    break-after:page
}
.vdoc-page *,
.vdoc-page *::before,
.vdoc-page *::after{
    animation-play-state:paused!important;
    transition:none!important
}`;
            return pagination.buildPagedHtml({
                title: documentModel.manifest.title
                    || documentPort.status().currentName,
                language: documentModel.manifest.language,
                runtime,
                css,
            });
        }

        function build(options = {}) {
            const adapter = options.adapter;
            if (!adapter || adapter.kind !== 'deck') {
                throw new TypeError(
                    'Deck exporter only accepts a deck adapter.'
                );
            }
            if (options.format === 'pdf') {
                return Object.freeze({
                    html: staticPagedHtml(adapter, options),
                    paged: true,
                    page: model().manifest.scene.page,
                });
            }
            return Object.freeze({
                html: presentationHtml(adapter),
                paged: false,
                page: model().manifest.scene.page,
            });
        }

        return Object.freeze({
            build,
            presentationHtml,
            staticPagedHtml,
        });
    }

    window.ScriptoriumDeckExport = Object.freeze({
        createDeckExporter,
    });
})();