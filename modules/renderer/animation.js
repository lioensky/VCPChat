// modules/renderer/animation.js

// --- CDN URL Mapping ---
const CDN_TO_LOCAL_MAP = {
    'https://cdnjs.cloudflare.com/ajax/libs/three.js': 'vendor/three.min.js',
    'https://cdn.jsdelivr.net/npm/three': 'vendor/three.min.js',
    'https://unpkg.com/three': 'vendor/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/animejs': 'vendor/anime.min.js',
    'https://cdn.jsdelivr.net/npm/animejs': 'vendor/anime.min.js',
    'https://unpkg.com/animejs': 'vendor/anime.min.js',
};

import * as visibilityOptimizer from './visibilityOptimizer.js';
import { createPausableRAF, registerCanvasAnimation } from './visibilityOptimizer.js';

// 🔥 全局跟踪已加载的脚本，防止跨消息重复加载
if (!window._vcp_loaded_scripts) {
    window._vcp_loaded_scripts = new Set();
}

function replaceCdnUrls(scriptContent) {
    if (!scriptContent || typeof scriptContent !== 'string') {
        return scriptContent;
    }
    
    let processed = scriptContent;
    
    const threeJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/three[@\/][^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/three[@\/][^'"`);\s]*/gi,
    ];
    
    threeJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/three.min.js');
    });
    
    const animeJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animejs\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/animejs[@\/][^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/animejs[@\/][^'"`);\s]*/gi,
    ];
    
    animeJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/anime.min.js');
    });
    
    const genericCdnPatterns = [
        { pattern: /https?:\/\/[^'"`);\s]*three[^'"`);\s]*\.js/gi, replacement: 'vendor/three.min.js' },
        { pattern: /https?:\/\/[^'"`);\s]*anime[^'"`);\s]*\.js/gi, replacement: 'vendor/anime.min.js' },
    ];
    
    genericCdnPatterns.forEach(({ pattern, replacement }) => {
        processed = processed.replace(pattern, replacement);
    });
    
    return processed;
}

const trackedThreeInstances = new Map();
let isThreePatched = false;

function patchThreeJS() {
    if (isThreePatched || !window.THREE || !window.THREE.WebGLRenderer) return;

    const OriginalWebGLRenderer = window.THREE.WebGLRenderer;

    window.THREE.WebGLRenderer = function(...args) {
        const renderer = new OriginalWebGLRenderer(...args);

        const originalRender = renderer.render;
        let associatedScene = null;
        let associatedCamera = null;

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
            
            if (!document.body.contains(this.domElement)) {
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
            if (originalDispose) {
                return originalDispose.call(this);
            }
        };

        const observer = new MutationObserver(() => {
            if (document.body.contains(renderer.domElement)) {
                const contentDiv = renderer.domElement.closest('.md-content');
                if (contentDiv) {
                    if (!trackedThreeInstances.has(contentDiv)) {
                        trackedThreeInstances.set(contentDiv, []);
                    }
                    const instance = {
                        renderer,
                        getScene: () => associatedScene,
                    };
                    trackedThreeInstances.get(contentDiv).push(instance);

                    // 注册到可见性优化器
                    const messageItem = contentDiv.closest('.message-item');
                    if (messageItem) {
                        visibilityOptimizer.registerThreeContext(messageItem, {
                            renderer,
                            getScene: () => associatedScene,
                            getCamera: () => associatedCamera,
                            // 注意：这里无法直接获取外部的 renderLoop，
                            // 但我们可以通过拦截 setAnimationLoop 来获取
                        });
                    }
                }
                observer.disconnect();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        return renderer;
    };

    window.THREE.WebGLRenderer.prototype = OriginalWebGLRenderer.prototype;
    isThreePatched = true;
    console.log('[Three.js Patch] THREE.WebGLRenderer patched with safety checks.');
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

function processScripts(containerElement) {
    const messageItem = containerElement.closest('.message-item');

    // Separate scripts by type
    const allScripts = Array.from(containerElement.querySelectorAll('script'));
    const threeScripts = allScripts.filter(s => s.src && s.src.includes('three'));
    const otherExternalScripts = allScripts.filter(s => s.src && !s.src.includes('three'));
    const inlineScripts = allScripts.filter(s => !s.src && s.textContent.trim());

    // Clean up all script tags from the message body
    allScripts.forEach(s => { if (s.parentNode) s.parentNode.removeChild(s); });

    const executeInline = () => {
        // 🛡️ 拦截 anime.js 的创建，以便自动注册
        const originalAnime = window.anime;
        let animePatched = false;
        if (originalAnime && !originalAnime._vcp_patched) {
            window.anime = function(options) {
                const instance = originalAnime(options);
                if (messageItem) {
                    visibilityOptimizer.registerAnimeInstance(messageItem, instance);
                }
                return instance;
            };
            Object.assign(window.anime, originalAnime);
            window.anime._vcp_patched = true;
            animePatched = true;
        }

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
                            registerCanvasAnimation(messageItem, { canvas });
                        }
                    });

                    // 2. 创建可暂停的 rAF 包装器
                    const pausableRAF = messageItem
                        ? createPausableRAF(messageItem)
                        : window.requestAnimationFrame;

                    // 3. 影子注入：通过 IIFE 重新定义局部作用域内的 API
                    // 我们将 pausableRAF 挂载到一个临时全局变量上，以便注入脚本读取
                    const tempRafId = `_vcp_raf_${Math.random().toString(36).slice(2, 11)}`;
                    window[tempRafId] = pausableRAF;
                    
                    // [优化] 拦截脚本中的 requestAnimationFrame，强制指向 pausableRAF
                    let scriptContent = script.textContent;
                    
                    // 简单的正则替换，处理常见的调用方式
                    // 注意：这只是辅助手段，核心拦截靠 IIFE 作用域覆盖
                    scriptContent = scriptContent.replace(/window\.requestAnimationFrame/g, `window['${tempRafId}']`);
                    
                    const wrappedScript = `
(function() {
    const requestAnimationFrame = window['${tempRafId}'];
    // 同时也覆盖 webkitRequestAnimationFrame 等变体以防万一
    const webkitRequestAnimationFrame = requestAnimationFrame;
    const mozRequestAnimationFrame = requestAnimationFrame;
    
    const container = document.querySelector('.message-item[data-message-id="${messageItem?.dataset.messageId}"] .md-content');
    try {
        ${scriptContent}
    } catch (e) {
        console.error('[Animation] Error in AI script:', e);
    }
})();`;
                    
                    const newScript = document.createElement('script');
                    newScript.textContent = wrappedScript;
                    document.head.appendChild(newScript).parentNode.removeChild(newScript);
                    
                    // 稍微延迟清理，确保脚本解析完成
                    setTimeout(() => { delete window[tempRafId]; }, 0);

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
            patchThreeJS();
            loadOtherScriptsAndExecuteInline();
        });
    } else {
        loadOtherScriptsAndExecuteInline();
    }
}

export function processAnimationsInContent(containerElement) {
    if (!containerElement) return;
    processScripts(containerElement);
}


export function cleanupAnimationsInContent(contentDiv) {
    if (!contentDiv) return;

    if (window.anime) {
        const animatedElements = contentDiv.querySelectorAll('*');
        if (animatedElements.length > 0) anime.remove(animatedElements);
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
