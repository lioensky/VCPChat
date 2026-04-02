// modules/renderer/visibilityOptimizer.js

/**
 * 🎬 视界优化器 - 只暂停"会动的东西"
 * 
 * 支持的动画类型：
 * 1. Web Animations API (element.animate)
 * 2. CSS @keyframes 动画（通过 class 控制）
 * 3. anime.js（需要 animation.js 注册）
 * 4. Three.js（需要 animation.js 注册）
 * 5. Canvas + rAF 动画（通过注入包装器控制）
 * 6. video/audio 媒体元素
 */

// 存储每个消息的动画状态
const messageAnimationStates = new WeakMap();

// 全局 Observer 实例
let visibilityObserver = null;
let chatContainerRef = null;

// 原始方法备份
let originalElementAnimate = null;

// 配置
const CONFIG = {
    rootMargin: '200px 0px',  // 预加载边距
    threshold: 0,
    batchProcessDelay: 50,    // 批量处理节流
    scanDelay: 150            // 扫描延迟，确保脚本执行完毕
};

// 批量处理队列
let pendingPause = new Set();
let pendingResume = new Set();
let batchTimer = null;

/**
 * 初始化可见性优化器
 */
export function initializeVisibilityOptimizer(chatContainer) {
    chatContainerRef = chatContainer;

    if (visibilityObserver) {
        visibilityObserver.disconnect();
    }

    // 🔑 关键：注入全局拦截器
    injectGlobalInterceptors();

    visibilityObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const messageItem = entry.target;

            if (entry.isIntersecting) {
                pendingPause.delete(messageItem);
                pendingResume.add(messageItem);
            } else {
                pendingResume.delete(messageItem);
                pendingPause.add(messageItem);
            }
        });

        scheduleBatchProcess();
    }, {
        root: chatContainer,
        rootMargin: CONFIG.rootMargin,
        threshold: CONFIG.threshold
    });

    // 观察所有现有消息
    chatContainer.querySelectorAll('.message-item').forEach(observeMessage);

    console.debug('[VisibilityOptimizer] Initialized with global interceptors');
}

/**
 * 💉 注入全局拦截器
 */
function injectGlobalInterceptors() {
    // 拦截 Web Animations API
    if (!originalElementAnimate && typeof Element.prototype.animate === 'function') {
        originalElementAnimate = Element.prototype.animate;

        Element.prototype.animate = function (keyframes, options) {
            const animation = originalElementAnimate.call(this, keyframes, options);

            // 找到所属的消息气泡
            const messageItem = this.closest('.message-item');
            if (messageItem) {
                const state = messageAnimationStates.get(messageItem);
                if (state) {
                    if (!state.webAnimations.includes(animation)) {
                        state.webAnimations.push(animation);
                    }

                    // 如果当前气泡已暂停，立即暂停新动画
                    if (state.isPaused) {
                        // 延迟一帧确保动画初始化完成
                        requestAnimationFrame(() => {
                            if (state.isPaused && animation.playState === 'running') {
                                animation.pause();
                            }
                        });
                    }
                }
            }

            return animation;
        };

        console.debug('[VisibilityOptimizer] Element.animate interceptor installed');
    }
}

/**
 * 批量处理暂停/恢复操作
 */
function scheduleBatchProcess() {
    if (batchTimer) return;

    batchTimer = setTimeout(() => {
        batchTimer = null;

        // 先处理暂停（优先释放资源）
        pendingPause.forEach(pauseMessageAnimations);
        pendingPause.clear();

        // 再处理恢复
        pendingResume.forEach(resumeMessageAnimations);
        pendingResume.clear();
    }, CONFIG.batchProcessDelay);
}

/**
 * 观察单个消息
 */
export function observeMessage(messageItem) {
    if (!visibilityObserver || !messageItem) return;

    // 初始化状态存储
    if (!messageAnimationStates.has(messageItem)) {
        messageAnimationStates.set(messageItem, {
            animeInstances: [],      // anime.js 实例
            threeContexts: [],       // Three.js 上下文
            webAnimations: [],       // Web Animations API
            canvasContexts: [],      // Canvas + rAF 上下文
            mediaElements: [],       // 视频/音频
            svgElements: [],         // SVG SMIL 动画
            gifImages: [],           // GIF/WebP 动图
            mutationObserver: null,  // 动态元素监听
            isPaused: false,
            isInitialized: false
        });
    }

    const state = messageAnimationStates.get(messageItem);

    // [新增] 监听 DOM 变化，防止 AI 延迟插入动态元素
    if (!state.mutationObserver) {
        state.mutationObserver = new MutationObserver((mutations) => {
            let needsRescan = false;
            mutations.forEach(m => {
                m.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return; // 只处理元素节点
                    const name = node.nodeName;
                    if (name === 'CANVAS' || name === 'VIDEO' || name === 'AUDIO' || name === 'SVG' || name === 'IMG') {
                        needsRescan = true;
                    }
                    // 检查子元素
                    if (!needsRescan && node.querySelector) {
                        if (node.querySelector('canvas, video, audio, svg, img')) {
                            needsRescan = true;
                        }
                    }
                });
            });

            if (needsRescan) {
                scanAnimatedElements(messageItem);
                // 如果当前是暂停状态，新加进来的元素也要立即暂停
                if (state.isPaused) {
                    applyPauseToState(messageItem, state);
                }
            }
        });
        state.mutationObserver.observe(messageItem, { childList: true, subtree: true });
    }

    visibilityObserver.observe(messageItem);

    // 🔑 延迟扫描，确保脚本已执行完毕
    setTimeout(() => {
        scanAnimatedElements(messageItem);
    }, CONFIG.scanDelay);
}

/**
 * 🔍 扫描并缓存消息内的所有动态元素
 */
function scanAnimatedElements(messageItem) {
    const state = messageAnimationStates.get(messageItem);
    if (!state) return;

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    // 1. 🔑 主动扫描所有 Web Animations（包括已经在运行的）
    try {
        const allWebAnims = messageItem.getAnimations({ subtree: true });
        allWebAnims.forEach(anim => {
            if (!state.webAnimations.includes(anim)) {
                state.webAnimations.push(anim);
            }
        });
    } catch (e) {
        // getAnimations 可能在某些环境不可用
        console.warn('[VisibilityOptimizer] getAnimations not supported:', e);
    }

    // 2. 扫描媒体元素
    state.mediaElements = Array.from(
        contentDiv.querySelectorAll('video, audio')
    );

    // 3. 扫描 SVG 元素 (SMIL 动画)
    state.svgElements = Array.from(
        contentDiv.querySelectorAll('svg')
    );

    // 4. 扫描 GIF/WebP 动图
    state.gifImages = Array.from(
        contentDiv.querySelectorAll('img[src$=".gif"], img[src$=".webp"]')
    );

    // 5. 扫描 canvas 元素（用于 rAF 动画识别）
    const canvases = contentDiv.querySelectorAll('canvas');
    canvases.forEach(canvas => {
        // 检查是否已经有上下文（由 animation.js 注册）
        const existingCtx = state.canvasContexts.find(c => c.canvas === canvas);
        if (!existingCtx) {
            // 标记为未注册的 canvas（可能有 rAF 动画）
            state.canvasContexts.push({
                canvas,
                isRegistered: false,
                isPaused: false
            });
        }
    });

    state.isInitialized = true;

    const stats = {
        webAnims: state.webAnimations.length,
        anime: state.animeInstances.length,
        three: state.threeContexts.length,
        canvas: state.canvasContexts.length,
        media: state.mediaElements.length,
        svg: state.svgElements.length,
        gifs: state.gifImages.length
    };

    // 只在有动画内容时输出日志
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    if (total > 0) {
        console.debug(`[VisibilityOptimizer] Scanned ${messageItem.dataset.messageId}:`, stats);
    }
}

/**
 * 🧹 清理已结束的动画，避免内存泄漏
 */
function cleanupFinishedAnimations(state) {
    // 1. 清理 Web Animations API 实例
    if (state.webAnimations.length > 0) {
        state.webAnimations = state.webAnimations.filter(anim => {
            try {
                // 只保留正在运行、暂停或待处理的动画
                return anim.playState !== 'finished' && anim.playState !== 'idle';
            } catch (e) {
                return false;
            }
        });
    }

    // 2. 清理 anime.js 实例 (如果已完成则移除)
    if (state.animeInstances.length > 0) {
        state.animeInstances = state.animeInstances.filter(anim => {
            try {
                return !anim.completed;
            } catch (e) {
                return false;
            }
        });
    }
}

/**
 * ⏸️ 暂停消息内的所有动画
 */
export function pauseMessageAnimations(messageItem) {
    const state = messageAnimationStates.get(messageItem);
    if (!state || state.isPaused) return;

    // 首次暂停时确保已扫描
    if (!state.isInitialized) {
        scanAnimatedElements(messageItem);
    }

    // [新增] 清理已结束的动画，防止数组无限膨胀
    cleanupFinishedAnimations(state);

    // [新增] 固化高度，辅助 content-visibility 更好地工作
    // [Pretext集成] 优先使用预算高度，避免 offsetHeight 触发 reflow
    if (!messageItem.style.containIntrinsicSize || messageItem.style.containIntrinsicSize === 'auto 100px') {
        var cachedHeight = (window.pretextBridge && window.pretextBridge.getCachedHeight)
            ? window.pretextBridge.getCachedHeight(messageItem.dataset && messageItem.dataset.messageId || messageItem.id)
            : null;
        const height = cachedHeight != null ? cachedHeight : messageItem.offsetHeight;
        if (height > 0) {
            messageItem.style.containIntrinsicSize = `auto ${height}px`;
        }
    }

    applyPauseToState(messageItem, state);
    state.isPaused = true;
}

/**
 * 内部方法：执行具体的暂停逻辑
 */
function applyPauseToState(messageItem, state) {
    // 1. CSS 动画：添加暂停类
    messageItem.classList.add('vcp-paused');

    // 2. Web Animations API
    // 重新扫描以捕获新创建的动画
    try {
        const currentAnims = messageItem.getAnimations({ subtree: true });
        currentAnims.forEach(anim => {
            if (!state.webAnimations.includes(anim)) {
                state.webAnimations.push(anim);
            }
        });
    } catch (e) { }

    state.webAnimations.forEach(anim => {
        try {
            if (anim.playState === 'running') {
                anim.pause();
            }
        } catch (e) { /* 动画可能已结束 */ }
    });

    // 3. anime.js 实例
    state.animeInstances.forEach(anim => {
        try {
            if (anim && !anim.paused) {
                anim.pause();
            }
        } catch (e) { }
    });

    // 4. Three.js 渲染循环
    state.threeContexts.forEach(ctx => {
        if (!ctx.isPaused) {
            if (ctx.animationId) {
                cancelAnimationFrame(ctx.animationId);
            }
            if (ctx.renderer?.setAnimationLoop) {
                ctx.renderer.setAnimationLoop(null);
            }
            ctx.isPaused = true;
        }
    });

    // 5. Canvas + rAF 动画
    state.canvasContexts.forEach(ctx => {
        if (!ctx.isPaused) {
            if (ctx.pauseCallback) {
                ctx.pauseCallback();
            }
            ctx.canvas.style.visibility = 'hidden';
            ctx.canvas.dataset.vcpPaused = 'true';
            ctx.isPaused = true;
        }
    });

    // 6. 视频/音频
    state.mediaElements.forEach(media => {
        if (media.isConnected && !media.paused) {
            media.dataset.vcpWasPlaying = 'true';
            media.pause();
        }
    });

    // 7. [新增] SVG SMIL 动画
    state.svgElements.forEach(svg => {
        try {
            if (svg.pauseAnimations) svg.pauseAnimations();
        } catch (e) { }
    });

    // 8. [新增] GIF/WebP 动图
    state.gifImages.forEach(img => {
        if (img.isConnected) {
            img.style.visibility = 'hidden';
        }
    });
}

/**
 * ▶️ 恢复消息内的所有动画
 */
export function resumeMessageAnimations(messageItem) {
    const state = messageAnimationStates.get(messageItem);
    if (!state || !state.isPaused) return;

    // 1. 恢复 CSS 动画：移除暂停类
    messageItem.classList.remove('vcp-paused');

    // 2. 恢复 Web Animations API
    state.webAnimations.forEach(anim => {
        try {
            if (anim.playState === 'paused') {
                anim.play();
            }
        } catch (e) { }
    });

    // 3. anime.js 实例
    state.animeInstances.forEach(anim => {
        try {
            if (anim?.paused) {
                anim.play();
            }
        } catch (e) { }
    });

    // 4. Three.js 渲染循环
    state.threeContexts.forEach(ctx => {
        if (ctx.isPaused) {
            ctx.isPaused = false;
            if (ctx.renderLoop) {
                ctx.renderLoop();
            }
        }
    });

    // 5. Canvas + rAF 动画
    state.canvasContexts.forEach(ctx => {
        if (ctx.isPaused) {
            if (ctx.resumeCallback) {
                ctx.resumeCallback();
            }
            ctx.canvas.style.visibility = 'visible';
            delete ctx.canvas.dataset.vcpPaused;
            ctx.isPaused = false;
        }
    });

    // 6. 视频/音频
    state.mediaElements.forEach(media => {
        if (media.isConnected && media.dataset.vcpWasPlaying === 'true') {
            media.play().catch(() => { });
            delete media.dataset.vcpWasPlaying;
        }
    });

    // 7. [新增] SVG SMIL 动画
    state.svgElements.forEach(svg => {
        try {
            if (svg.unpauseAnimations) svg.unpauseAnimations();
        } catch (e) { }
    });

    // 8. [新增] GIF/WebP 动图
    state.gifImages.forEach(img => {
        if (img.isConnected) {
            img.style.visibility = 'visible';
        }
    });

    state.isPaused = false;
}

/**
 * 📝 注册 anime.js 实例
 */
export function registerAnimeInstance(messageItem, animeInstance) {
    if (!messageItem || !animeInstance) return;

    const state = messageAnimationStates.get(messageItem);
    if (state) {
        if (!state.animeInstances.includes(animeInstance)) {
            state.animeInstances.push(animeInstance);
        }

        if (state.isPaused) {
            try { animeInstance.pause(); } catch (e) { }
        }
    }
}

/**
 * 📝 注册 Three.js 上下文
 */
export function registerThreeContext(messageItem, context) {
    if (!messageItem || !context) return;

    const state = messageAnimationStates.get(messageItem);
    if (state) {
        if (!state.threeContexts.includes(context)) {
            context.isPaused = false;
            state.threeContexts.push(context);
        }

        if (state.isPaused) {
            if (context.animationId) {
                cancelAnimationFrame(context.animationId);
            }
            if (context.renderer?.setAnimationLoop) {
                context.renderer.setAnimationLoop(null);
            }
            context.isPaused = true;
        }
    }
}

/**
 * 📝 注册 Canvas rAF 动画上下文
 * @param {HTMLElement} messageItem 
 * @param {Object} context - { canvas, pauseCallback?, resumeCallback? }
 */
export function registerCanvasAnimation(messageItem, context) {
    if (!messageItem || !context?.canvas) return;

    const state = messageAnimationStates.get(messageItem);
    if (state) {
        // 查找或创建 canvas 上下文
        let canvasCtx = state.canvasContexts.find(c => c.canvas === context.canvas);
        if (!canvasCtx) {
            canvasCtx = {
                canvas: context.canvas,
                isRegistered: true,
                isPaused: false
            };
            state.canvasContexts.push(canvasCtx);
        }

        // 更新控制回调
        canvasCtx.pauseCallback = context.pauseCallback;
        canvasCtx.resumeCallback = context.resumeCallback;
        canvasCtx.isRegistered = true;

        if (state.isPaused && !canvasCtx.isPaused) {
            if (canvasCtx.pauseCallback) {
                canvasCtx.pauseCallback();
            }
            canvasCtx.canvas.style.visibility = 'hidden';
            canvasCtx.isPaused = true;
        }
    }
}

/**
 * ❓ 检查消息是否处于暂停状态
 */
export function isMessagePaused(messageItem) {
    if (!messageItem) return false;
    const state = messageAnimationStates.get(messageItem);
    return state ? state.isPaused : false;
}

/**
 * 🔧 创建一个可暂停的 requestAnimationFrame 包装器
 * 供 animation.js 在执行用户脚本时使用
 */
export function createPausableRAF(messageItem) {
    let rafId = null;

    const wrappedRAF = (callback) => {
        return requestAnimationFrame((timestamp) => {
            const state = messageAnimationStates.get(messageItem);

            // [Fix] 防止元素被移除后仍在运行动画导致 crash
            if (!state || !messageItem.isConnected) {
                return;
            }

            if (state.isPaused) {
                // 暂停时轮询
                rafId = requestAnimationFrame(() => wrappedRAF(callback));
            } else {
                callback(timestamp);
            }
        });
    };

    return wrappedRAF;
}

/**
 * 🗑️ 停止观察并清理消息
 */
export function unobserveMessage(messageItem) {
    if (visibilityObserver) {
        visibilityObserver.unobserve(messageItem);
    }

    const state = messageAnimationStates.get(messageItem);
    if (state) {
        // [新增] 断开 MutationObserver
        if (state.mutationObserver) {
            state.mutationObserver.disconnect();
            state.mutationObserver = null;
        }

        // 清理 Three.js 资源
        state.threeContexts.forEach(ctx => {
            if (ctx.animationId) cancelAnimationFrame(ctx.animationId);
            if (ctx.renderer?.dispose) ctx.renderer.dispose();
        });

        // 取消所有 Web Animations
        state.webAnimations.forEach(anim => {
            try { anim.cancel(); } catch (e) { }
        });

        messageAnimationStates.delete(messageItem);
    }

    pendingPause.delete(messageItem);
    pendingResume.delete(messageItem);
}

/**
 * 🔄 手动触发可见性检查
 */
export function recheckVisibility() {
    if (!chatContainerRef) return;

    const containerRect = chatContainerRef.getBoundingClientRect();
    const margin = 200;

    chatContainerRef.querySelectorAll('.message-item').forEach(item => {
        const rect = item.getBoundingClientRect();

        const isVisible = (
            rect.bottom > containerRect.top - margin &&
            rect.top < containerRect.bottom + margin
        );

        if (isVisible) {
            resumeMessageAnimations(item);
        } else {
            pauseMessageAnimations(item);
        }
    });
}

/**
 * 🛑 销毁优化器
 */
export function destroyVisibilityOptimizer() {
    if (visibilityObserver) {
        visibilityObserver.disconnect();
        visibilityObserver = null;
    }

    // 恢复原始的 Element.animate
    if (originalElementAnimate) {
        Element.prototype.animate = originalElementAnimate;
        originalElementAnimate = null;
    }

    if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
    }

    pendingPause.clear();
    pendingResume.clear();
    chatContainerRef = null;

    console.debug('[VisibilityOptimizer] Destroyed');
}