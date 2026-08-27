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
            const advancedCss = primitives.compiledDocumentStylesCss(
                documentModel,
                slides.flatMap((slide) => [
                    slide?.source,
                    adapter.parsedSlide(slide).html,
                ])
            );
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
                return `window.__VCPRegisterScene(${index}, (lifecycle) => {
    const slide = document.querySelector('[data-slide-index="${index}"]');
    if (!slide) return null;
    const scene = slide.matches('.vdoc-slide-scene,[data-vdoc-slide]')
        ? slide
        : slide.querySelector('.vdoc-slide-scene,[data-vdoc-slide]')
            || slide;
    try {
        const matchesScene = (selector) => scene.matches?.(selector);
        const currentScript = Object.freeze({
            dataset: Object.freeze({ vdocRuntimeScript: 'true' }),
            parentElement: scene,
            previousElementSibling: scene,
            closest(selector) {
                if (matchesScene(selector)) return scene;
                return scene.closest?.(selector) || null;
            },
            getRootNode: () => scene.getRootNode?.() || document,
        });
        const scopedDocument = new Proxy(document, {
            get(target, property) {
                if (property === 'currentScript') return currentScript;
                if (property === 'querySelector') {
                    return (selector) =>
                        (matchesScene(selector) ? scene : null)
                        || scene.querySelector(selector)
                        || target.querySelector(selector);
                }
                if (property === 'querySelectorAll') {
                    return (selector) => {
                        const descendants = [...scene.querySelectorAll(selector)];
                        return matchesScene(selector)
                            ? [scene, ...descendants]
                            : descendants;
                    };
                }
                if (property === 'getElementById') {
                    return (id) => {
                        const normalizedId = String(id);
                        return scene.id === normalizedId
                            ? scene
                            : scene.querySelector(
                                '#' + CSS.escape(normalizedId)
                            )
                            || target.getElementById(normalizedId);
                    };
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
            'runtime',
            'document',
            'anime',
            'requestAnimationFrame',
            'cancelAnimationFrame',
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            ${inlineScriptLiteral(parsed.script)}
        );
        const returned = run.call(
            scene,
            scene,
            window.VCPDeck,
            lifecycle.runtime,
            scopedDocument,
            lifecycle.anime,
            lifecycle.requestAnimationFrame,
            lifecycle.cancelAnimationFrame,
            lifecycle.setTimeout,
            lifecycle.clearTimeout,
            lifecycle.setInterval,
            lifecycle.clearInterval
        );
        if (typeof returned === 'function') lifecycle.addCleanup(returned);
        else if (returned?.dispose) {
            lifecycle.addCleanup(() => returned.dispose());
        }
        if (typeof scene.__vcpCleanup === 'function') {
            lifecycle.addCleanup(() => {
                scene.__vcpCleanup?.();
                delete scene.__vcpCleanup;
            });
        }
    } catch (error) {
        console.error(
            '[VCPDeck] Scene ${safeSlideId} script failed:',
            error
        );
    }
    return lifecycle.dispose;
});`;
            }).filter(Boolean).join('\n');

            return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<style>
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
${adapter.currentCss()}
${advancedCss}
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
    const sceneFactories = new Map();
    let activeDispose = null;
    let activationToken = 0;
    let index = 0;

    const createLifecycle = (slide, scene) => {
        const pristineScene = scene.cloneNode(true);
        const frames = new Set();
        const timeouts = new Set();
        const intervals = new Set();
        const cleanups = [];
        const animeInstances = new Set();
        let disposed = false;
        const requestFrame = (callback) => {
            if (disposed) return 0;
            const id = window.requestAnimationFrame((timestamp) => {
                frames.delete(id);
                if (!disposed) callback(timestamp);
            });
            frames.add(id);
            return id;
        };
        const cancelFrame = (id) => {
            frames.delete(id);
            window.cancelAnimationFrame(id);
        };
        const setTimeoutTracked = (callback, wait, ...args) => {
            if (disposed) return 0;
            const id = window.setTimeout(() => {
                timeouts.delete(id);
                if (!disposed) callback(...args);
            }, wait);
            timeouts.add(id);
            return id;
        };
        const clearTimeoutTracked = (id) => {
            timeouts.delete(id);
            window.clearTimeout(id);
        };
        const setIntervalTracked = (callback, wait, ...args) => {
            if (disposed) return 0;
            const id = window.setInterval(() => {
                if (!disposed) callback(...args);
            }, wait);
            intervals.add(id);
            return id;
        };
        const clearIntervalTracked = (id) => {
            intervals.delete(id);
            window.clearInterval(id);
        };
        const addCleanup = (cleanup) => {
            if (typeof cleanup === 'function') cleanups.push(cleanup);
            return cleanup;
        };
        const trackAnime = (instance) => {
            if (instance?.pause) animeInstances.add(instance);
            return instance;
        };
        const scopedAnime = typeof window.anime === 'function'
            ? new Proxy(window.anime, {
                apply(target, thisArg, args) {
                    return trackAnime(Reflect.apply(target, thisArg, args));
                },
                get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property === 'timeline' && typeof value === 'function') {
                        return (...args) => trackAnime(value.apply(target, args));
                    }
                    return typeof value === 'function'
                        ? value.bind(target)
                        : value;
                },
            })
            : window.anime;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            frames.forEach(window.cancelAnimationFrame);
            timeouts.forEach(window.clearTimeout);
            intervals.forEach(window.clearInterval);
            animeInstances.forEach((instance) => {
                try { instance.pause(); } catch {}
            });
            [...cleanups].reverse().forEach((cleanup) => {
                try { cleanup(); } catch (error) {
                    console.error('[VCPDeck] Scene cleanup failed:', error);
                }
            });
            frames.clear();
            timeouts.clear();
            intervals.clear();
            animeInstances.clear();
            cleanups.length = 0;
            if (scene === slide) {
                [...slide.attributes].forEach((attribute) => {
                    if (!['class', 'data-slide-index', 'data-slide-id',
                        'data-transition', 'aria-hidden'].includes(attribute.name)) {
                        slide.removeAttribute(attribute.name);
                    }
                });
                slide.innerHTML = pristineScene.innerHTML;
            } else if (scene.isConnected && scene.parentNode) {
                scene.parentNode.replaceChild(
                    pristineScene.cloneNode(true),
                    scene
                );
            }
        };
        return Object.freeze({
            runtime: Object.freeze({
                root: scene,
                addCleanup,
                requestAnimationFrame: requestFrame,
                cancelAnimationFrame: cancelFrame,
                setTimeout: setTimeoutTracked,
                clearTimeout: clearTimeoutTracked,
                setInterval: setIntervalTracked,
                clearInterval: clearIntervalTracked,
            }),
            anime: scopedAnime,
            addCleanup,
            requestAnimationFrame: requestFrame,
            cancelAnimationFrame: cancelFrame,
            setTimeout: setTimeoutTracked,
            clearTimeout: clearTimeoutTracked,
            setInterval: setIntervalTracked,
            clearInterval: clearIntervalTracked,
            dispose,
        });
    };

    window.__VCPRegisterScene = (slideIndex, factory) => {
        if (typeof factory === 'function') {
            sceneFactories.set(Number(slideIndex), factory);
        }
    };

    const activate = (slideIndex, token) => {
        if (token !== activationToken) return;
        const slide = slides[slideIndex];
        const factory = sceneFactories.get(slideIndex);
        if (!slide || !factory) return;
        const scene = slide.querySelector(
            '.vdoc-slide-scene,[data-vdoc-slide]'
        ) || slide;
        const lifecycle = createLifecycle(slide, scene);
        const returned = factory(lifecycle);
        activeDispose = typeof returned === 'function'
            ? returned
            : lifecycle.dispose;
    };

    const show = (nextIndex) => {
        const normalized = Math.max(
            0,
            Math.min(slides.length - 1, Number(nextIndex) || 0)
        );
        activationToken += 1;
        activeDispose?.();
        activeDispose = null;
        slides.forEach((slide, slideIndex) => {
            const active = slideIndex === normalized;
            slide.classList.toggle('active', active);
            slide.setAttribute('aria-hidden', String(!active));
            slide.style.animation = 'none';
            if (active) {
                const token = activationToken;
                requestAnimationFrame(() => {
                    slide.style.removeProperty('animation');
                    activate(normalized, token);
                });
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
})();
${slideScripts}
const initialSlide =
    Number(location.hash.match(/slide-(\\d+)/)?.[1] || 1) - 1;
window.VCPDeck.goTo(initialSlide);
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
            const advancedCss = primitives.compiledDocumentStylesCss(
                documentModel,
                adapter.slides().flatMap((slide) => [
                    slide?.source,
                    adapter.parsedSlide(slide).html,
                ])
            );
            const css = `${primitives.baseCss(scene, options)
                .replace('@import url("../vendor/katex.min.css");', '')
                .replace(':host {', ':root {')}
${advancedCss}
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