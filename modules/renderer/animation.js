// modules/renderer/animation.js

// --- CDN URL Mapping ---
const CDN_TO_LOCAL_MAP = {
    'https://cdnjs.cloudflare.com/ajax/libs/three.js': 'vendor/three.min.js',
    'https://cdn.jsdelivr.net/npm/three': 'vendor/three.min.js',
    'https://unpkg.com/three': 'vendor/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/animejs': 'vendor/anime.min.js',
    'https://cdn.jsdelivr.net/npm/animejs': 'vendor/anime.min.js',
    'https://unpkg.com/animejs': 'vendor/anime.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pixi.js': 'vendor/pixi.min.js',
    'https://cdn.jsdelivr.net/npm/pixi.js': 'vendor/pixi.min.js',
    'https://unpkg.com/pixi.js': 'vendor/pixi.min.js',
};

// 🔥 全局跟踪已加载的脚本，防止跨消息重复加载
if (!window._vcp_loaded_scripts) {
    window._vcp_loaded_scripts = new Set();
}

if (window.PIXI) {
    window._vcp_loaded_scripts.add('vendor/pixi.min.js');
}

function replaceCdnUrls(scriptContent) {
    if (!scriptContent || typeof scriptContent !== 'string') {
        return scriptContent;
    }
    
    let processed = scriptContent;
    
    const threeJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/three(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/three(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
    ];
    
    threeJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/three.min.js');
    });
    
    const animeJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animejs\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/animejs(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/animejs(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
    ];
    
    animeJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/anime.min.js');
    });
    
    const pixiJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pixi\.js\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/pixi\.js(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/pixi\.js(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
    ];

    pixiJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/pixi.min.js');
    });

    const genericCdnPatterns = [
        { pattern: /https?:\/\/[^'"`);\s]*(?:three\.js|three)[^'"`);\s]*\/[^'"`);\s]*\.js(?:\?[^'"`);\s]*)?/gi, replacement: 'vendor/three.min.js' },
        { pattern: /https?:\/\/[^'"`);\s]*(?:animejs|anime)[^'"`);\s]*\/[^'"`);\s]*\.js(?:\?[^'"`);\s]*)?/gi, replacement: 'vendor/anime.min.js' },
        { pattern: /https?:\/\/[^'"`);\s]*(?:pixi\.js|pixijs|pixi)[^'"`);\s]*\/[^'"`);\s]*\.js(?:\?[^'"`);\s]*)?/gi, replacement: 'vendor/pixi.min.js' },
    ];
    
    genericCdnPatterns.forEach(({ pattern, replacement }) => {
        processed = processed.replace(pattern, replacement);
    });
    
    return processed;
}

const trackedThreeInstances = new Map();
const visibilityOwnerByContent = new WeakMap();
const trackedAnimeInstances = new WeakMap();
const scriptExecutions = new WeakMap();

function patchThreeJS(contentDiv, visibilityOptimizer) {
    if (!window.THREE?.WebGLRenderer) return window.THREE;
    const OriginalWebGLRenderer = window.THREE.WebGLRenderer;
    const MessageWebGLRenderer = function(...args) {
        const renderer = new OriginalWebGLRenderer(...args);

        const originalRender = renderer.render;
        let associatedScene = null;
        let associatedCamera = null;
        let animationLoop = null;
        const originalSetAnimationLoop = renderer.setAnimationLoop?.bind(renderer);
        const context = {
            renderer,
            getScene: () => associatedScene,
            getCamera: () => associatedCamera,
            isPaused: false,
            pause() {
                originalSetAnimationLoop?.(null);
            },
            resume() {
                if (!renderer._disposed && animationLoop) originalSetAnimationLoop?.(animationLoop);
            },
        };
        if (originalSetAnimationLoop) {
            renderer.setAnimationLoop = callback => {
                animationLoop = callback;
                originalSetAnimationLoop(context.isPaused ? null : callback);
            };
        }

        renderer.render = function(scene, camera) {
            if (this._disposed) {
                return;
            }
            
            if (scene && !associatedScene) {
                associatedScene = scene;
            }
            if (camera && !associatedCamera) {
                associatedCamera = camera;
            }
            
            if (!contentDiv.isConnected) {
                if (!this._disposed) this.dispose();
                return;
            }
            
            try {
                return originalRender.call(this, scene, camera);
            } catch (error) {
                console.error('[Three.js Safety] Render error caught:', error);
                if (!this._disposed) this.dispose();
                return;
            }
        };

        const originalDispose = renderer.dispose;
        renderer.dispose = function() {
            if (this._disposed) return;
            this._disposed = true;
            animationLoop = null;
            originalSetAnimationLoop?.(null);
            if (originalDispose) {
                return originalDispose.call(this);
            }
        };

        if (!trackedThreeInstances.has(contentDiv)) trackedThreeInstances.set(contentDiv, []);
        trackedThreeInstances.get(contentDiv).push({ renderer, getScene: () => associatedScene });
        const messageItem = contentDiv.closest('.message-item');
        if (messageItem) visibilityOptimizer?.registerThreeContext?.(messageItem, context);

        return renderer;
    };

    MessageWebGLRenderer.prototype = OriginalWebGLRenderer.prototype;
    Object.setPrototypeOf(MessageWebGLRenderer, OriginalWebGLRenderer);
    return new Proxy(window.THREE, {
        get(target, prop) { return prop === 'WebGLRenderer' ? MessageWebGLRenderer : target[prop]; },
    });
}

function createMessagePixiFacade(messageItem, visibilityOptimizer) {
    const originalPixi = window.PIXI;
    if (!originalPixi?.Application || !messageItem || !visibilityOptimizer?.registerPixiContext) {
        return originalPixi;
    }

    const OriginalApplication = originalPixi.Application;

    function MessageOwnedApplication(...args) {
        const app = Reflect.construct(OriginalApplication, args, new.target === MessageOwnedApplication
            ? OriginalApplication
            : new.target);
        const originalInit = typeof app.init === 'function' ? app.init.bind(app) : null;
        const originalStart = typeof app.start === 'function' ? app.start.bind(app) : null;
        const originalStop = typeof app.stop === 'function' ? app.stop.bind(app) : null;
        const originalDestroy = typeof app.destroy === 'function' ? app.destroy.bind(app) : null;

        const context = {
            app,
            isReady: !originalInit,
            isPaused: true,
            isDestroyed: false,
            pause() {
                if (context.isDestroyed) return;
                try { originalStop?.(); } catch (error) { /* partially initialized */ }
                try { app.ticker?.stop?.(); } catch (error) { /* partially initialized */ }
            },
            resume() {
                if (context.isDestroyed || !context.isReady) return;
                try {
                    if (originalStart) originalStart();
                    else app.ticker?.start?.();
                } catch (error) {
                    console.warn('[Animation] Pixi resume failed:', error);
                }
            },
            destroy() {
                if (context.isDestroyed) return;
                context.isDestroyed = true;
                context.pause();
                const canvas = app.canvas || app.view;
                try {
                    originalDestroy?.(
                        { removeView: true },
                        { children: true, texture: true, textureSource: true }
                    );
                } catch (error) {
                    console.warn('[Animation] Pixi destroy failed:', error);
                }
                canvas?.remove?.();
            }
        };

        // AI 的显式 start 也必须经过气泡热区与话题配额，不得绕过调度器。
        app.start = () => {
            visibilityOptimizer.registerPixiContext(messageItem, context);
        };
        app.stop = () => {
            context.pause();
            context.isPaused = true;
        };
        app.destroy = (...destroyArgs) => {
            if (context.isDestroyed) return;
            context.isDestroyed = true;
            try {
                originalStop?.();
                app.ticker?.stop?.();
                return originalDestroy?.(...destroyArgs);
            } finally {
                (app.canvas || app.view)?.remove?.();
            }
        };

        if (originalInit) {
            app.init = async (options = {}) => {
                const result = await originalInit({ ...options, autoStart: false });
                context.isReady = true;
                visibilityOptimizer.registerPixiContext(messageItem, context);
                return result;
            };
        }

        // 构造即登记并冻结；Pixi v8 会在 init 完成后再次登记。
        visibilityOptimizer.registerPixiContext(messageItem, context);
        return app;
    }

    MessageOwnedApplication.prototype = OriginalApplication.prototype;
    Object.setPrototypeOf(MessageOwnedApplication, OriginalApplication);

    return new Proxy(originalPixi, {
        get(target, prop, receiver) {
            if (prop === 'Application') return MessageOwnedApplication;
            return Reflect.get(target, prop, receiver);
        }
    });
}

function loadScript(src, onLoad, onError) {
    if (window._vcp_loaded_scripts.has(src)) {
        if(onLoad) onLoad();
        return;
    }
    window._vcp_loaded_scripts.add(src); // Pre-mark to prevent race conditions
    
    const scriptEl = document.createElement('script');
    scriptEl.src = src;
    scriptEl.onload = () => {
        console.log(`[Animation] ✅ Library loaded: ${src}`);
        if (onLoad) onLoad();
    };
    scriptEl.onerror = () => {
        console.error(`[Animation] ❌ Failed to load: ${src}`);
        window._vcp_loaded_scripts.delete(src); // Allow retry on failure
        if (onError) onError();
    };
    document.head.appendChild(scriptEl);
}

function processScripts(containerElement, visibilityOptimizer) {
    const execution = {};
    scriptExecutions.set(containerElement, execution);
    if (visibilityOptimizer) visibilityOwnerByContent.set(containerElement, visibilityOptimizer);
    const messageItem = containerElement.closest('.message-item');

    // Markdown fenced/inline code and HTML code preview wrappers are display-only domains.
    // They must never be promoted back into executable scripts, even if malformed upstream HTML
    // happens to produce a real <script> element inside <pre>/<code> or preview containers.
    const isDisplayOnlyCodeScript = (scriptElement) => Boolean(
        scriptElement?.closest?.('pre, code, .vcp-html-preview-container, .vcp-stream-code-block, [data-vcp-tool-data], [data-vcp-block-type="tool-batch"], .vcp-tool-result-bubble, .vcp-tool-use-bubble')
    );

    // Separate executable scripts from display-only code examples.
    // A bare HTML animation island (for example, a top-level <div>) remains
    // executable and can still be handled by the existing runtime.
    const allScripts = Array.from(containerElement.querySelectorAll('script'));
    const executableScripts = allScripts.filter(script => !isDisplayOnlyCodeScript(script));
    const threeScripts = executableScripts.filter(s => s.src && s.src.includes('three'));
    const otherExternalScripts = executableScripts.filter(s => s.src && !s.src.includes('three'));
    const inlineScripts = executableScripts
        .filter(s => !s.src && s.textContent.trim())
        .map(s => ({
            textContent: s.textContent,
            previousElementSibling: s.previousElementSibling,
            parentElement: s.parentElement,
            parentNode: s.parentNode,
            id: s.id || '',
            className: s.className || '',
            type: s.type || '',
            dataset: { ...s.dataset },
            getAttribute: (name) => s.getAttribute(name),
            hasAttribute: (name) => s.hasAttribute(name),
        }));

    // Remove only executable script tags. Scripts inside a display-only code
    // block are left untouched so the rendered example remains visible as code.
    executableScripts.forEach(s => { if (s.parentNode) s.parentNode.removeChild(s); });

    const executeInline = () => {
        if (scriptExecutions.get(containerElement) !== execution) return;
        // 🛡️ 拦截 anime.js 的创建，以便自动注册
        const originalAnime = window.anime;
        const messageAnime = originalAnime && Object.assign(function(options) {
            const instance = originalAnime(options);
            if (!trackedAnimeInstances.has(containerElement)) trackedAnimeInstances.set(containerElement, new Set());
            trackedAnimeInstances.get(containerElement).add(instance);
            if (messageItem) visibilityOptimizer?.registerAnimeInstance?.(messageItem, instance);
            return instance;
        }, originalAnime);

        // 🛡️ Document API Shadowing - 防止 document.write/open/close 导致 SPA 崩溃
        const originalWrite = document.write;
        const originalOpen = document.open;
        const originalClose = document.close;

        const blockedApiHandler = function(...args) {
            console.warn('[Animation] Blocked document.write/open/close call in inline script:', args);
        };

        document.write = blockedApiHandler;
        document.open = blockedApiHandler;
        document.close = blockedApiHandler;

        try {
            inlineScripts.forEach(script => {
                try {
                    // 1. 注册所有 canvas，以便优化器监控
                    const canvases = containerElement.querySelectorAll('canvas');
                    canvases.forEach(canvas => {
                        if (messageItem) {
                            visibilityOptimizer?.registerCanvasAnimation?.(messageItem, { canvas });
                        }
                    });

                    // 2. 创建可暂停的 rAF 与 timer 包装器
                    const pausableRAF = messageItem
                        ? visibilityOptimizer?.createPausableRAF?.(messageItem) || window.requestAnimationFrame
                        : window.requestAnimationFrame;
                    const pausableTimerAPI = messageItem
                        ? visibilityOptimizer?.createPausableTimerAPI?.(messageItem) || {
                            setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
                            setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window)
                        }
                        : {
                            setTimeout: window.setTimeout.bind(window),
                            clearTimeout: window.clearTimeout.bind(window),
                            setInterval: window.setInterval.bind(window),
                            clearInterval: window.clearInterval.bind(window)
                        };

                    // A single synchronous handoff captures all message-owned APIs.
                    const tempContainerId = `_vcp_container_${Math.random().toString(36).slice(2, 11)}`;
                    const messagePixi = createMessagePixiFacade(messageItem, visibilityOptimizer);
                    const virtualCurrentScript = {
                        tagName: 'SCRIPT',
                        nodeName: 'SCRIPT',
                        nodeType: Node.ELEMENT_NODE,
                        id: script.id,
                        className: script.className,
                        type: script.type,
                        dataset: script.dataset,
                        previousElementSibling: script.previousElementSibling,
                        parentElement: script.parentElement,
                        parentNode: script.parentNode,
                        ownerDocument: document,
                        getAttribute: script.getAttribute,
                        hasAttribute: script.hasAttribute,
                    };
                    const shadowDocument = new Proxy(document, {
                        get(target, prop) {
                            if (prop === 'write' || prop === 'open' || prop === 'close') return blockedApiHandler;
                            if (prop === 'currentScript') {
                                return virtualCurrentScript;
                            }

                            // 消息内脚本默认只能命中当前消息中的节点，避免多个消息包含
                            // 相同 id / data-vdoc-island 时 document.querySelector 总是选中
                            // 页面里的第一个副本。当前消息没有匹配项时才回退到真实 document，
                            // 以兼容脚本查询 body、head 或应用级全局节点。
                            if (prop === 'querySelector') {
                                return function(selector) {
                                    try {
                                        if (containerElement.matches?.(selector)) {
                                            return containerElement;
                                        }

                                        const localMatch = containerElement.querySelector(selector);
                                        if (localMatch) {
                                            return localMatch;
                                        }
                                    } catch (error) {
                                        // 让原生 document 重新处理并抛出非法选择器异常。
                                    }

                                    return target.querySelector(selector);
                                };
                            }

                            if (prop === 'querySelectorAll') {
                                return function(selector) {
                                    try {
                                        const localMatches = Array.from(containerElement.querySelectorAll(selector));
                                        if (containerElement.matches?.(selector)) {
                                            localMatches.unshift(containerElement);
                                        }

                                        if (localMatches.length > 0) {
                                            localMatches.item = (index) => localMatches[index] || null;
                                            return localMatches;
                                        }
                                    } catch (error) {
                                        // 让原生 document 重新处理并抛出非法选择器异常。
                                    }

                                    return target.querySelectorAll(selector);
                                };
                            }

                            if (prop === 'getElementById') {
                                return function(id) {
                                    const escapedId = window.CSS?.escape
                                        ? window.CSS.escape(String(id))
                                        : String(id).replace(/(["\\])/g, '\\$1');
                                    const localMatch = containerElement.querySelector(`#${escapedId}`);
                                    return localMatch || target.getElementById(id);
                                };
                            }

                            if (prop === 'getElementsByTagName') {
                                return function(tagName) {
                                    const normalizedTagName = String(tagName).toLowerCase();

                                    // script 查询保留原有兼容行为，库代码可能依赖 currentScript
                                    // 或通过最后一个 script 标签寻找自身。
                                    if (normalizedTagName === 'script') {
                                        const elements = Array.from(target.getElementsByTagName(tagName));
                                        const scripts = [...elements, virtualCurrentScript];
                                        scripts.item = (index) => scripts[index] || null;
                                        return scripts;
                                    }

                                    const localElements = Array.from(containerElement.getElementsByTagName(tagName));
                                    if (localElements.length > 0) {
                                        localElements.item = (index) => localElements[index] || null;
                                        return localElements;
                                    }

                                    return target.getElementsByTagName(tagName);
                                };
                            }

                            const value = target[prop];
                            return typeof value === 'function' ? value.bind(target) : value;
                        },
                        set(target, prop, value) {
                            target[prop] = value;
                            return true;
                        }
                    });
                    const scopedApis = {
                        document: shadowDocument,
                        PIXI: messagePixi,
                        THREE: patchThreeJS(containerElement, visibilityOptimizer),
                        anime: messageAnime,
                        requestAnimationFrame: pausableRAF,
                        webkitRequestAnimationFrame: pausableRAF,
                        mozRequestAnimationFrame: pausableRAF,
                        ...pausableTimerAPI,
                        container: containerElement,
                    };
                    const scopedWindow = new Proxy(window, {
                        get(target, prop) {
                            if (prop === 'window' || prop === 'self' || prop === 'globalThis') return scopedWindow;
                            if (Object.prototype.hasOwnProperty.call(scopedApis, prop)) return scopedApis[prop];
                            const value = Reflect.get(target, prop, target);
                            return typeof value === 'function' && !value.prototype ? value.bind(target) : value;
                        },
                        set(target, prop, value) { target[prop] = value; return true; },
                    });
                    window[tempContainerId] = scopedWindow;
                    
                    const scriptContent = replaceCdnUrls(script.textContent);
                    // Explicit window/globalThis calls resolve through the captured local proxy.
                    
                    const wrappedScript = `
(function(window) {
    const globalThis = window;
    const self = window;
    const document = window.document;
    const PIXI = window.PIXI;
    const THREE = window.THREE;
    const anime = window.anime;
    const requestAnimationFrame = window.requestAnimationFrame;
    // 同时也覆盖 webkitRequestAnimationFrame 等变体以防万一
    const webkitRequestAnimationFrame = requestAnimationFrame;
    const mozRequestAnimationFrame = requestAnimationFrame;
    const __vcpTimerAPI = window;
    const setTimeout = __vcpTimerAPI.setTimeout;
    const clearTimeout = __vcpTimerAPI.clearTimeout;
    const setInterval = __vcpTimerAPI.setInterval;
    const clearInterval = __vcpTimerAPI.clearInterval;
    
    // 直接绑定本次处理所属的内容根，不再通过消息 ID 和全局 document 反查。
    // 因此 script 位于 DIV 岛内部、岛外或辅助 Surface 时语义完全一致。
    const container = window.container;
    try {
        ${scriptContent}
    } catch (e) {
        console.error('[Animation] Error in AI script:', e);
    }
})(window['${tempContainerId}']);`;
                    
                    const newScript = document.createElement('script');
                    newScript.textContent = wrappedScript;
                    try {
                        document.head.appendChild(newScript);
                    } finally {
                        newScript.remove();
                        delete window[tempContainerId];
                    }

                } catch (e) {
                    console.error('[Animation] Error executing inline script:', e);
                }
            });
        } finally {
            // 🔄 恢复原始 API
            document.write = originalWrite;
            document.open = originalOpen;
            document.close = originalClose;
            
            // 如果我们在本次执行中临时修改了 anime，且希望保持全局干净（可选）
            // 但通常 anime 是全局加载的，保持 patch 也没关系
            document.open = originalOpen;
            document.close = originalClose;
        }
    };

    const loadOtherScriptsAndExecuteInline = () => {
        let remaining = otherExternalScripts.length;
        if (remaining === 0) {
            executeInline();
            return;
        }
        const onScriptLoaded = () => {
            remaining--;
            if (remaining === 0) {
                executeInline();
            }
        };
        otherExternalScripts.forEach(s => {
            loadScript(replaceCdnUrls(s.src), onScriptLoaded, onScriptLoaded);
        });
    };

    if (threeScripts.length > 0) {
        loadScript('vendor/three.min.js', () => {
            loadOtherScriptsAndExecuteInline();
        });
    } else {
        loadOtherScriptsAndExecuteInline();
    }
}

export function processAnimationsInContent(containerElement, visibilityOptimizer = null) {
    if (!containerElement) return;
    processScripts(containerElement, visibilityOptimizer);
}


export function cleanupAnimationsInContent(contentDiv) {
    if (!contentDiv) return;
    scriptExecutions.delete(contentDiv);
    const visibilityOptimizer = visibilityOwnerByContent.get(contentDiv);
    const messageItem = contentDiv.closest?.('.message-item');
    visibilityOptimizer?.destroyPixiMessage?.(messageItem);
    visibilityOwnerByContent.delete(contentDiv);

    const animeInstances = trackedAnimeInstances.get(contentDiv);
    if (animeInstances) {
        for (const instance of animeInstances) {
            instance.pause?.();
            const targets = instance.animatables?.map(entry => entry.target) || [];
            if (targets.length) window.anime?.remove?.(targets);
        }
        animeInstances.clear();
        trackedAnimeInstances.delete(contentDiv);
    }

    if (trackedThreeInstances.has(contentDiv)) {
        const instancesToClean = trackedThreeInstances.get(contentDiv);
        console.log(`[Cleanup] Cleaning ${instancesToClean.length} Three.js instance(s)`);

        instancesToClean.forEach(instance => {
            if (instance.renderer && !instance.renderer._disposed) {
                const scene = instance.getScene();
                if (scene) {
                    scene.traverse(object => {
                        if (object.isMesh) {
                            if (object.geometry) object.geometry.dispose();
                            if (object.material) {
                                if (Array.isArray(object.material)) {
                                    object.material.forEach(mat => { if (mat.dispose) mat.dispose(); });
                                } else if (object.material.dispose) {
                                    object.material.dispose();
                                }
                            }
                        }
                    });
                }
                try {
                    instance.renderer.dispose();
                } catch (e) {
                    console.warn('[Cleanup] Error during renderer disposal:', e);
                }
            }
        });

        trackedThreeInstances.delete(contentDiv);
    }
}

export function animateMessageIn(messageItem) {
    if (!window.anime) return;
    messageItem.style.opacity = 0;
    messageItem.style.transform = 'translateY(20px)';
    anime({
        targets: messageItem,
        opacity: 1,
        translateY: 0,
        duration: 500,
        easing: 'easeOutExpo',
        complete: () => {
            messageItem.style.opacity = '';
            messageItem.style.transform = '';
        }
    });
}

export function animateMessageOut(messageItem, onComplete) {
    if (!window.anime) {
        if (onComplete) onComplete();
        return;
    }
    anime({
        targets: messageItem,
        opacity: 0,
        translateY: -20,
        duration: 400,
        easing: 'easeInExpo',
        complete: onComplete
    });
}
