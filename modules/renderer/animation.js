// modules/renderer/animation.js
import { createAnimationMountController } from './animationMountController.js';

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

const disposedResources = new WeakSet();
function disposeResource(resource) {
    if (!resource || typeof resource.dispose !== 'function' || disposedResources.has(resource)) return;
    disposedResources.add(resource);
    try { resource.dispose(); } catch (error) { console.warn('[Animation] resource dispose failed:', error); }
}
function disposeScene(scene) {
    const material = value => {
        if (!value) return;
        for (const entry of Object.values(value)) {
            if (entry?.isTexture || entry?.isWebGLRenderTarget) disposeResource(entry);
        }
        for (const uniform of Object.values(value.uniforms || {})) {
            const values = Array.isArray(uniform?.value) ? uniform.value : [uniform?.value];
            values.forEach(entry => { if (entry?.isTexture) disposeResource(entry); });
        }
        disposeResource(value);
    };
    for (const entry of [scene.background, scene.environment]) if (entry?.isTexture) disposeResource(entry);
    scene.traverse?.(object => {
        disposeResource(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material);
    });
}
const mounts = new WeakMap();
const dependencyTasks = new WeakMap();
const ALLOWED_DEPENDENCIES = new Set(Object.values(CDN_TO_LOCAL_MAP));
const scriptExecutions = new WeakMap();

function patchThreeJS(contentDiv, visibilityOptimizer, controller) {
    const three = contentDiv.ownerDocument.defaultView.THREE;
    if (!three?.WebGLRenderer) return three;
    const OriginalWebGLRenderer = three.WebGLRenderer;
    const MessageWebGLRenderer = function(...args) {
        if (!controller.isCurrent()) throw new Error('Animation mount revoked');
        const renderer = new OriginalWebGLRenderer(...args);

        const originalRender = renderer.render;
        let associatedScene = null;
        const scenes = new Set();
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
                if (!controller.isCurrent() || renderer._disposed) return;
                animationLoop = callback && controller.guard(callback);
                originalSetAnimationLoop(context.isPaused ? null : animationLoop);
            };
        }

        renderer.render = function(scene, camera) {
            if (this._disposed) {
                return;
            }
            
            if (!controller.isCurrent()) return;
            if (scene) scenes.add(scene);
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

        const messageItem = contentDiv.closest('.message-item');
        controller.own(() => {
            for (const scene of scenes) {
                try { disposeScene(scene); } catch (error) { console.warn('[Animation] scene dispose failed:', error); }
            }
            scenes.clear();
            try { renderer.dispose(); } finally {
                visibilityOptimizer?.unregisterAnimationResource?.(messageItem, context);
            }
        });
        if (messageItem) visibilityOptimizer?.registerThreeContext?.(messageItem, context);

        return renderer;
    };

    MessageWebGLRenderer.prototype = OriginalWebGLRenderer.prototype;
    Object.setPrototypeOf(MessageWebGLRenderer, OriginalWebGLRenderer);
    const constructors = new Map();
    return new Proxy(three, {
        get(target, prop) {
            if (prop === 'WebGLRenderer') return MessageWebGLRenderer;
            const value = target[prop];
            if (typeof value !== 'function' || typeof value.prototype?.dispose !== 'function') return value;
            if (!constructors.has(value)) constructors.set(value, new Proxy(value, {
                construct(constructor, args, newTarget) {
                    if (!controller.isCurrent()) throw new Error('Animation mount revoked');
                    const resource = Reflect.construct(constructor, args, newTarget);
                    controller.own(() => disposeResource(resource));
                    return resource;
                },
            }));
            return constructors.get(value);
        },
    });
}

function createMessagePixiFacade(messageItem, visibilityOptimizer, controller) {
    const originalPixi = controller.root.ownerDocument.defaultView.PIXI;
    if (!originalPixi?.Application || !messageItem || !visibilityOptimizer?.registerPixiContext) {
        return originalPixi;
    }

    const OriginalApplication = originalPixi.Application;

    function MessageOwnedApplication(...args) {
        if (!controller.isCurrent()) throw new Error('Animation mount revoked');
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
                if (context.isInitializing) {
                    context.pendingDestroy = true;
                    context.pause();
                    context.isDestroyed = true;
                    return;
                }
                context.pause();
                context.isDestroyed = true;
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

        controller.own(() => {
            context.destroy();
            visibilityOptimizer.unregisterAnimationResource?.(messageItem, context);
        });
        // AI 的显式 start 也必须经过气泡热区与话题配额，不得绕过调度器。
        app.start = () => {
            if (controller.isCurrent() && !context.isDestroyed) visibilityOptimizer.registerPixiContext(messageItem, context);
        };
        app.stop = () => {
            context.pause();
            context.isPaused = true;
        };
        app.destroy = () => {
            context.destroy();
            visibilityOptimizer.unregisterAnimationResource?.(messageItem, context);
        };

        if (originalInit) {
            app.init = async (options = {}) => {
                if (!controller.isCurrent() || context.isDestroyed) return;
                context.isInitializing = true;
                let result;
                try {
                    result = await originalInit({ ...options, autoStart: false });
                } finally {
                    context.isInitializing = false;
                    if (!controller.isCurrent() || context.pendingDestroy) {
                        context.isDestroyed = false;
                        context.destroy();
                    }
                }
                if (!controller.isCurrent() || context.isDestroyed) return result;
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

function loadScript(src, realm) {
    const resolved = new URL(replaceCdnUrls(src), realm.document.baseURI);
    const local = [...ALLOWED_DEPENDENCIES].find(path =>
        new URL(path, realm.document.baseURI).href === resolved.href);
    if (!local) return Promise.reject(new Error('Animation dependency is not allowlisted'));
    let tasks = dependencyTasks.get(realm);
    if (!tasks) dependencyTasks.set(realm, tasks = new Map());
    if (tasks.has(local)) return tasks.get(local);
    const globalName = local.includes('three') ? 'THREE' : local.includes('pixi') ? 'PIXI' : 'anime';
    if (realm[globalName]) return Promise.resolve();
    const task = new Promise((resolve, reject) => {
        const script = realm.document.createElement('script');
        let settled = false;
        const settle = error => {
            if (settled) return;
            settled = true;
            realm.clearTimeout(timeout);
            script.onload = script.onerror = null;
            if (error) { script.remove(); reject(error); }
            else resolve();
        };
        const timeout = realm.setTimeout(() => settle(new Error('Animation dependency timeout')), 15000);
        script.src = local;
        script.onload = () => settle(realm[globalName] ? null : new Error('Animation dependency missing global'));
        script.onerror = () => settle(new Error('Animation dependency failed'));
        realm.document.head.appendChild(script);
    });
    tasks.set(local, task);
    task.catch(() => { if (tasks.get(local) === task) tasks.delete(local); });
    return task;
}

function processScripts(containerElement, visibilityOptimizer) {
    const realm = containerElement.ownerDocument.defaultView;
    const previous = mounts.get(containerElement);
    if (previous && (previous.state === 'revoked' || previous.revision !== containerElement._vcpRenderRevision || previous.optimizer !== visibilityOptimizer)) {
        cleanupAnimationsInContent(containerElement);
    }
    const controller = mounts.get(containerElement) || createAnimationMountController(containerElement, visibilityOptimizer);
    mounts.set(containerElement, controller);
    const execution = controller;
    scriptExecutions.set(containerElement, execution);
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
        if (scriptExecutions.get(containerElement) !== execution || !controller.isCurrent()) return;
        // 🛡️ 拦截 anime.js 的创建，以便自动注册
        const originalAnime = realm.anime;
        const messageAnime = originalAnime && Object.assign(function(options) {
            if (!controller.isCurrent()) return;
            const instance = originalAnime(options);
            controller.own(() => {
                try { instance.pause?.(); } finally {
                    visibilityOptimizer?.unregisterAnimationResource?.(messageItem, instance);
                }
                const targets = instance.animatables?.map(entry => entry.target) || [];
                if (targets.length) originalAnime.remove?.(targets);
            });
            if (messageItem) visibilityOptimizer?.registerAnimeInstance?.(messageItem, instance);
            return instance;
        }, originalAnime);

        // 🛡️ Document API Shadowing - 防止 document.write/open/close 导致 SPA 崩溃
        const document = realm.document;

        const blockedApiHandler = function(...args) {
            console.warn('[Animation] Blocked document.write/open/close call in inline script:', args);
        };

        {
            inlineScripts.forEach(script => {
                if (!controller.isCurrent()) return;
                try {
                    // 1. 注册所有 canvas，以便优化器监控
                    const canvases = containerElement.querySelectorAll('canvas');
                    canvases.forEach(canvas => {
                        if (messageItem) {
                            const context = visibilityOptimizer?.registerCanvasAnimation?.(messageItem, { canvas });
                            if (context) controller.own(() => visibilityOptimizer?.unregisterAnimationResource?.(messageItem, context));
                        }
                    });

                    // 2. 创建可暂停的 rAF 与 timer 包装器
                    const pausableRAF = controller.api.requestAnimationFrame;
                    const pausableTimerAPI = controller.api;

                    // A single synchronous handoff captures all message-owned APIs.
                    const messagePixi = createMessagePixiFacade(messageItem, visibilityOptimizer, controller);
                    const virtualCurrentScript = {
                        tagName: 'SCRIPT',
                        nodeName: 'SCRIPT',
                        nodeType: realm.Node.ELEMENT_NODE,
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
                            if (prop === 'addEventListener') return (type, callback, options) => controller.listen(target, type, callback, options);
                            if (prop === 'removeEventListener') return (type, callback, options) => controller.unlisten(target, type, callback, options);
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
                                    const escapedId = realm.CSS?.escape
                                        ? realm.CSS.escape(String(id))
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
                        THREE: patchThreeJS(containerElement, visibilityOptimizer, controller),
                        anime: messageAnime,
                        requestAnimationFrame: pausableRAF,
                        webkitRequestAnimationFrame: pausableRAF,
                        mozRequestAnimationFrame: pausableRAF,
                        webkitCancelAnimationFrame: controller.api.cancelAnimationFrame,
                        mozCancelAnimationFrame: controller.api.cancelAnimationFrame,
                        ...pausableTimerAPI,
                        container: containerElement,
                    };
                    const scopedWindow = new Proxy(realm, {
                        get(target, prop) {
                            if (prop === 'window' || prop === 'self' || prop === 'globalThis') return scopedWindow;
                            if (Object.prototype.hasOwnProperty.call(scopedApis, prop)) return scopedApis[prop];
                            const value = Reflect.get(target, prop, target);
                            return typeof value === 'function' && !value.prototype ? value.bind(target) : value;
                        },
                        set(target, prop, value) { target[prop] = value; return true; },
                    });
                    // Same-Realm compatibility execution, deliberately not a security boundary.
                    
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
    const cancelAnimationFrame = window.cancelAnimationFrame;
    const webkitCancelAnimationFrame = cancelAnimationFrame;
    const mozCancelAnimationFrame = cancelAnimationFrame;
    // 同时也覆盖 webkitRequestAnimationFrame 等变体以防万一
    const webkitRequestAnimationFrame = requestAnimationFrame;
    const mozRequestAnimationFrame = requestAnimationFrame;
    const __vcpTimerAPI = window;
    const setTimeout = __vcpTimerAPI.setTimeout;
    const clearTimeout = __vcpTimerAPI.clearTimeout;
    const setInterval = __vcpTimerAPI.setInterval;
    const clearInterval = __vcpTimerAPI.clearInterval;
    
    const addEventListener = window.addEventListener;
    const removeEventListener = window.removeEventListener;
    const MutationObserver = window.MutationObserver;
    const ResizeObserver = window.ResizeObserver;
    const IntersectionObserver = window.IntersectionObserver;
    const fetch = window.fetch;
    const URL = window.URL;
    const Worker = window.Worker;
    const queueMicrotask = window.queueMicrotask;

    // 直接绑定本次处理所属的内容根，不再通过消息 ID 和全局 document 反查。
    // 因此 script 位于 DIV 岛内部、岛外或辅助 Surface 时语义完全一致。
    const container = window.container;
    try {
        ${scriptContent}
    } catch (e) {
        console.error('[Animation] Error in AI script:', e);
    }
}).call(window, window);`;
                    if (script.type && !/^(?:text|application)\/javascript$/i.test(script.type)) {
                        console.warn('[Animation] Unsupported inline script type:', script.type);
                        return;
                    }
                    const runner = document.createElement('script');
                    runner.textContent = `document.currentScript.__vcpRun = function(window) { ${wrappedScript} };`;
                    try {
                        document.head.appendChild(runner);
                        if (typeof runner.__vcpRun === 'function') runner.__vcpRun.call(scopedWindow, scopedWindow);
                        else console.warn('[Animation] Inline execution unavailable under this document policy');
                    } finally {
                        delete runner.__vcpRun;
                        runner.remove();
                    }

                } catch (e) {
                    console.error('[Animation] Error executing inline script:', e);
                }
            });
        }
    };

    const dependencies = [...threeScripts, ...otherExternalScripts];
    if (!dependencies.length) executeInline();
    else Promise.all(dependencies.map(script => loadScript(script.src, realm)))
        .then(executeInline)
        .catch(error => {
            if (controller.isCurrent()) console.error('[Animation] Execution stopped:', error);
        });
    return controller;
}

export function processAnimationsInContent(containerElement, visibilityOptimizer = null) {
    if (!containerElement) return;
    return processScripts(containerElement, visibilityOptimizer);
}


export function cleanupAnimationsInContent(contentDiv) {
    if (!contentDiv) return;
    mounts.get(contentDiv)?.revoke();
    mounts.delete(contentDiv);
    scriptExecutions.delete(contentDiv);
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
