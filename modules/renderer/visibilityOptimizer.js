// modules/renderer/visibilityOptimizer.js

const visibilityOwnerByMessage = new WeakMap();
const animateInterceptorByPrototype = new WeakMap();

function acquireElementAnimateInterceptor(elementPrototype) {
    if (!elementPrototype || typeof elementPrototype.animate !== 'function') return () => {};

    let realmState = animateInterceptorByPrototype.get(elementPrototype);
    if (!realmState) {
        const originalAnimate = elementPrototype.animate;
        realmState = { originalAnimate, users: 0 };
        animateInterceptorByPrototype.set(elementPrototype, realmState);
        elementPrototype.animate = function (keyframes, options) {
            const animation = originalAnimate.call(this, keyframes, options);
            const messageItem = this.closest?.('.message-item');
            visibilityOwnerByMessage.get(messageItem)?.captureWebAnimation(messageItem, animation);
            return animation;
        };
    }
    realmState.users += 1;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        realmState.users = Math.max(0, realmState.users - 1);
        if (realmState.users === 0) {
            if (elementPrototype.animate !== realmState.originalAnimate) {
                elementPrototype.animate = realmState.originalAnimate;
            }
            animateInterceptorByPrototype.delete(elementPrototype);
        }
    };
}

/** Creates one visibility and animation scheduler owner for one renderer. */
export function createVisibilityOptimizer() {
let publicApi = null;
let releaseElementAnimateInterceptor = null;

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
const observedMessages = new Set();
const scanTimers = new Map();

// 全局 Observer 实例
let visibilityObserver = null;
let chatContainerRef = null;
let ownerWindow = null;

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
function initializeVisibilityOptimizer(chatContainer) {
    if (visibilityObserver) {
        [...observedMessages].forEach(unobserveMessage);
        visibilityObserver.disconnect();
    }

    chatContainerRef = chatContainer;
    ownerWindow = chatContainer?.ownerDocument?.defaultView || window;

    releaseElementAnimateInterceptor?.();
    releaseElementAnimateInterceptor = acquireElementAnimateInterceptor(ownerWindow?.Element?.prototype);

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
function captureWebAnimation(messageItem, animation) {
    const state = messageAnimationStates.get(messageItem);
    if (!state) return;
    if (!state.webAnimations.includes(animation)) state.webAnimations.push(animation);
    if (state.isPaused) {
        requestAnimationFrame(() => {
            if (state.isPaused && animation.playState === 'running') animation.pause();
        });
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
function observeMessage(messageItem) {
    if (!visibilityObserver || !messageItem) return;
    visibilityOwnerByMessage.set(messageItem, publicApi);
    observedMessages.add(messageItem);

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
            animationStartHandler: null, // 捕获暂停后才启动的 CSS 动画（包括伪元素）
            pausedRAFCallbacks: [],  // 暂停期间被挂起的 rAF 回调，resume 时事件唤醒
            activePausableTimers: new Set(), // 由 animation.js 注入的可暂停 timeout/interval
            isPaused: false,
            isInitialized: false,
            isHydrated: false,
            isHeavyActivated: false
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

    // DOM 扫描只能发现新增节点，发现不了既有节点因 class/style 变化而新启动的
    // CSS @keyframes。animationstart 会冒泡，且伪元素动画也会在所属元素上报告；
    // 暂停态下重新抓取整棵消息子树的 Animation 实例，堵住动态 scoped CSS 的漏网动画。
    if (!state.animationStartHandler) {
        state.animationStartHandler = () => {
            if (!state.isPaused || !messageItem.isConnected) return;
            try {
                const currentAnimations = messageItem.getAnimations({ subtree: true });
                currentAnimations.forEach(animation => {
                    if (!state.webAnimations.includes(animation)) {
                        state.webAnimations.push(animation);
                    }
                    if (animation.playState === 'running') {
                        animation.pause();
                    }
                });
            } catch (error) {
                // CSS 的 .vcp-paused 屏障仍会负责暂停；旧 Chromium 不支持 subtree 时忽略。
            }
        };
        messageItem.addEventListener('animationstart', state.animationStartHandler, true);
    }

    visibilityObserver.observe(messageItem);
    rememberMessageHeight(messageItem);

    // 🔑 延迟扫描，确保脚本已执行完毕
    const messageWindow = messageItem.ownerDocument?.defaultView || ownerWindow || window;
    const existingScanTimer = scanTimers.get(messageItem);
    if (existingScanTimer) existingScanTimer.window.clearTimeout(existingScanTimer.id);
    const scanTimer = messageWindow.setTimeout(() => {
        scanTimers.delete(messageItem);
        if (!observedMessages.has(messageItem) || visibilityOwnerByMessage.get(messageItem) !== publicApi) return;
        scanAnimatedElements(messageItem);
        rememberMessageHeight(messageItem);
    }, CONFIG.scanDelay);
    scanTimers.set(messageItem, { id: scanTimer, window: messageWindow });
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

function rememberMessageHeight(messageItem) {
    if (!messageItem || !messageItem.isConnected) return;
    const messageId = messageItem.dataset?.messageId || messageItem.id;
    let height = 0;
    try {
        height = messageItem.offsetHeight;
    } catch (e) {
        height = 0;
    }
    if (height > 0) {
        messageItem.dataset.vcpMeasuredHeight = String(height);
        messageItem.style.containIntrinsicSize = `auto ${height}px`;
        if (window.pretextBridge && typeof window.pretextBridge.rememberHeight === 'function' && messageId) {
            try {
                window.pretextBridge.rememberHeight(messageId, height);
            } catch (e) {
                // 高度回写失败不影响墓碑冻结主流程
            }
        }
    }
}

function activateHeavyIfNeeded(messageItem, state) {
    if (!messageItem || !state || state.isHeavyActivated) return;
    if (typeof messageItem._vcp_activateHeavy === 'function') {
        state.isHeavyActivated = true;
        messageItem.dataset.vcpHeavyActivating = 'true';
        try {
            const result = messageItem._vcp_activateHeavy();
            if (result && typeof result.then === 'function') {
                result
                    .then(() => {
                        delete messageItem.dataset.vcpHeavyActivating;
                    })
                    .catch(error => {
                        state.isHeavyActivated = false;
                        delete messageItem.dataset.vcpHeavyActivating;
                        console.error('[VisibilityOptimizer] Heavy activation failed:', error);
                    });
            } else {
                delete messageItem.dataset.vcpHeavyActivating;
            }
        } catch (error) {
            state.isHeavyActivated = false;
            delete messageItem.dataset.vcpHeavyActivating;
            console.error('[VisibilityOptimizer] Heavy activation failed:', error);
        }
    }
}

function flushPausedRAFCallbacks(messageItem, state) {
    if (!state?.pausedRAFCallbacks?.length || !messageItem?.isConnected) return;
    const callbacks = state.pausedRAFCallbacks.splice(0);
    callbacks.forEach(callback => {
        requestAnimationFrame((timestamp) => {
            const latestState = messageAnimationStates.get(messageItem);
            if (!latestState || latestState.isPaused || !messageItem.isConnected) {
                if (latestState && !latestState.isPaused) {
                    latestState.pausedRAFCallbacks.push(callback);
                }
                return;
            }
            callback(timestamp);
        });
    });
}

function resumePausableTimers(state) {
    if (!state?.activePausableTimers?.size) return;
    state.activePausableTimers.forEach(timer => {
        if (timer && typeof timer.resume === 'function') {
            timer.resume();
        }
    });
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
function pauseMessageAnimations(messageItem) {
    const state = messageAnimationStates.get(messageItem);
    if (!state || state.isPaused) return;

    // 首次暂停时确保已扫描
    if (!state.isInitialized) {
        scanAnimatedElements(messageItem);
    }

    // [新增] 清理已结束的动画，防止数组无限膨胀
    cleanupFinishedAnimations(state);

    // [新增] 固化实测高度，辅助 content-visibility / 后续墓碑占位更好地工作
    rememberMessageHeight(messageItem);

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
function resumeMessageAnimations(messageItem) {
    const state = messageAnimationStates.get(messageItem);
    if (!state) return;

    activateHeavyIfNeeded(messageItem, state);
    rememberMessageHeight(messageItem);

    if (!state.isPaused) {
        scanAnimatedElements(messageItem);
        return;
    }

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
    flushPausedRAFCallbacks(messageItem, state);
    resumePausableTimers(state);
}

/**
 * 📝 注册 anime.js 实例
 */
function registerAnimeInstance(messageItem, animeInstance) {
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
function registerThreeContext(messageItem, context) {
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
function registerCanvasAnimation(messageItem, context) {
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
function isMessagePaused(messageItem) {
    if (!messageItem) return false;
    const state = messageAnimationStates.get(messageItem);
    return state ? state.isPaused : false;
}

/**
 * 🔧 创建一个可暂停的 requestAnimationFrame 包装器
 * 供 animation.js 在执行用户脚本时使用
 */
function createPausableRAF(messageItem) {
    const wrappedRAF = (callback) => {
        const state = messageAnimationStates.get(messageItem);
        if (!state || !messageItem?.isConnected) {
            return 0;
        }

        if (state.isPaused) {
            // 墓碑冻结：暂停态不再每帧轮询，等 resumeMessageAnimations() 事件唤醒。
            state.pausedRAFCallbacks.push(callback);
            return state.pausedRAFCallbacks.length;
        }

        return requestAnimationFrame((timestamp) => {
            const latestState = messageAnimationStates.get(messageItem);

            // [Fix] 防止元素被移除后仍在运行动画导致 crash
            if (!latestState || !messageItem.isConnected) {
                return;
            }

            if (latestState.isPaused) {
                latestState.pausedRAFCallbacks.push(callback);
                return;
            }

            callback(timestamp);
        });
    };

    return wrappedRAF;
}

function createPausableTimerAPI(messageItem) {
    const getState = () => messageAnimationStates.get(messageItem);

    const createTimerRecord = (type, callback, delay, args, repeat) => {
        const state = getState();
        const record = {
            type,
            callback,
            delay: Math.max(0, Number(delay) || 0),
            args,
            repeat,
            nativeId: null,
            canceled: false,
            pendingFire: false,
            resume() {
                if (record.canceled) return;
                if (record.pendingFire) {
                    record.pendingFire = false;
                    record.fire();
                } else if (record.repeat && !record.nativeId) {
                    record.schedule();
                }
            },
            schedule() {
                if (record.canceled) return;
                const latestState = getState();
                if (!latestState || !messageItem?.isConnected) {
                    record.cancel();
                    return;
                }
                if (latestState.isPaused) {
                    record.pendingFire = true;
                    return;
                }
                record.nativeId = window.setTimeout(() => {
                    record.nativeId = null;
                    record.fire();
                }, record.delay);
            },
            fire() {
                if (record.canceled) return;
                const latestState = getState();
                if (!latestState || !messageItem?.isConnected) {
                    record.cancel();
                    return;
                }
                if (latestState.isPaused) {
                    record.pendingFire = true;
                    return;
                }
                try {
                    record.callback(...record.args);
                } finally {
                    if (record.repeat && !record.canceled) {
                        record.schedule();
                    } else if (!record.repeat) {
                        latestState.activePausableTimers.delete(record);
                    }
                }
            },
            cancel() {
                record.canceled = true;
                record.pendingFire = false;
                if (record.nativeId) {
                    window.clearTimeout(record.nativeId);
                    record.nativeId = null;
                }
                const latestState = getState();
                latestState?.activePausableTimers?.delete(record);
            }
        };

        state?.activePausableTimers?.add(record);
        record.schedule();
        return record;
    };

    return {
        setTimeout(callback, delay, ...args) {
            return createTimerRecord('timeout', callback, delay, args, false);
        },
        clearTimeout(record) {
            if (record && typeof record.cancel === 'function') {
                record.cancel();
            } else {
                window.clearTimeout(record);
            }
        },
        setInterval(callback, delay, ...args) {
            return createTimerRecord('interval', callback, delay, args, true);
        },
        clearInterval(record) {
            if (record && typeof record.cancel === 'function') {
                record.cancel();
            } else {
                window.clearInterval(record);
            }
        }
    };
}

/**
 * 🗑️ 停止观察并清理消息
 */
function unobserveMessage(messageItem) {
    if (visibilityObserver) {
        visibilityObserver.unobserve(messageItem);
    }

    const state = messageAnimationStates.get(messageItem);
    const scanTimer = scanTimers.get(messageItem);
    if (scanTimer) {
        scanTimer.window.clearTimeout(scanTimer.id);
        scanTimers.delete(messageItem);
    }
    if (state) {
        // [新增] 断开 MutationObserver
        if (state.mutationObserver) {
            state.mutationObserver.disconnect();
            state.mutationObserver = null;
        }

        if (state.animationStartHandler) {
            messageItem.removeEventListener('animationstart', state.animationStartHandler, true);
            state.animationStartHandler = null;
        }

        if (state.pausedRAFCallbacks) {
            state.pausedRAFCallbacks.length = 0;
        }

        if (state.activePausableTimers) {
            state.activePausableTimers.forEach(timer => {
                if (timer && typeof timer.cancel === 'function') {
                    timer.cancel();
                }
            });
            state.activePausableTimers.clear();
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
    if (visibilityOwnerByMessage.get(messageItem) === publicApi) visibilityOwnerByMessage.delete(messageItem);
    observedMessages.delete(messageItem);

    pendingPause.delete(messageItem);
    pendingResume.delete(messageItem);
}

function isMessageInHotZone(messageItem, margin = 200) {
    if (!messageItem || !chatContainerRef || !messageItem.isConnected) return false;

    try {
        const containerRect = chatContainerRef.getBoundingClientRect();
        const rect = messageItem.getBoundingClientRect();

        return (
            rect.bottom > containerRect.top - margin &&
            rect.top < containerRect.bottom + margin
        );
    } catch (e) {
        return false;
    }
}

/**
 * 🔄 手动触发可见性检查
 */
function recheckVisibility() {
    if (!chatContainerRef) return;

    const containerRect = chatContainerRef.getBoundingClientRect();
    const margin = 200;

    chatContainerRef.querySelectorAll('.message-item').forEach(item => {
        const rect = item.getBoundingClientRect();

        const isVisible = isMessageInHotZone(item, margin);

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
function destroyVisibilityOptimizer() {
    if (visibilityObserver) {
        [...observedMessages].forEach(unobserveMessage);
        visibilityObserver.disconnect();
        visibilityObserver = null;
    }

    releaseElementAnimateInterceptor?.();
    releaseElementAnimateInterceptor = null;

    if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
    }

    pendingPause.clear();
    pendingResume.clear();
    [...observedMessages].forEach(unobserveMessage);
    scanTimers.forEach(timer => timer.window.clearTimeout(timer.id));
    scanTimers.clear();
    chatContainerRef = null;
    ownerWindow = null;

    console.debug('[VisibilityOptimizer] Destroyed');
}

publicApi = Object.freeze({
    initializeVisibilityOptimizer,
    observeMessage,
    pauseMessageAnimations,
    resumeMessageAnimations,
    registerAnimeInstance,
    registerThreeContext,
    registerCanvasAnimation,
    isMessagePaused,
    createPausableRAF,
    createPausableTimerAPI,
    unobserveMessage,
    isMessageInHotZone,
    recheckVisibility,
    destroyVisibilityOptimizer,
    captureWebAnimation,
});
return publicApi;
}
