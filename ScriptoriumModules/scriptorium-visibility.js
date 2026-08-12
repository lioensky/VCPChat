'use strict';

(() => {
    const DEFAULT_MARGIN = '120% 0px';
    const PAUSE_EVENT = 'vdoc-runtime-pause';
    const RESUME_EVENT = 'vdoc-runtime-resume';
    const surfaceStates = new WeakMap();

    function createState(surface) {
        const state = {
            surface,
            paused: false,
            webAnimations: [],
            media: [],
            svg: [],
            canvasContexts: new Set(),
            pausedRafCallbacks: [],
            timers: new Set(),
        };
        surfaceStates.set(surface, state);
        return state;
    }

    function stateFor(surface) {
        return surfaceStates.get(surface) || createState(surface);
    }

    function scan(surface, state = stateFor(surface)) {
        try {
            state.webAnimations = surface.getAnimations({ subtree: true });
        } catch {
            state.webAnimations = [];
        }
        state.media = [...surface.querySelectorAll('video, audio')];
        state.svg = [...surface.querySelectorAll('svg')];
        return state;
    }

    function pause(surface) {
        const state = scan(surface);
        if (state.paused) return;
        surface.dataset.runtimeState = 'paused';
        surface.classList.add('vdoc-runtime-paused');

        state.webAnimations.forEach((animation) => {
            try {
                if (animation.playState === 'running') animation.pause();
            } catch {}
        });
        state.media.forEach((media) => {
            if (!media.paused) {
                media.dataset.vdocWasPlaying = 'true';
                media.pause();
            }
        });
        state.svg.forEach((svg) => {
            try {
                svg.pauseAnimations?.();
            } catch {}
        });
        state.canvasContexts.forEach((context) => {
            if (context.paused) return;
            context.pause?.();
            context.paused = true;
        });
        state.timers.forEach((timer) => timer.pause());
        state.paused = true;
        surface.dispatchEvent(new Event(PAUSE_EVENT));
    }

    function resume(surface) {
        const state = scan(surface);
        surface.dataset.runtimeState = 'active';
        surface.classList.remove('vdoc-runtime-paused');
        if (!state.paused) return;

        state.paused = false;
        state.webAnimations.forEach((animation) => {
            try {
                if (animation.playState === 'paused') animation.play();
            } catch {}
        });
        state.media.forEach((media) => {
            if (media.dataset.vdocWasPlaying === 'true') {
                media.play().catch(() => {});
                delete media.dataset.vdocWasPlaying;
            }
        });
        state.svg.forEach((svg) => {
            try {
                svg.unpauseAnimations?.();
            } catch {}
        });
        state.canvasContexts.forEach((context) => {
            if (!context.paused) return;
            context.paused = false;
            context.resume?.();
        });
        state.timers.forEach((timer) => timer.resume());
        surface.dispatchEvent(new Event(RESUME_EVENT));

        const callbacks = state.pausedRafCallbacks.splice(0);
        callbacks.forEach((callback) => {
            requestAnimationFrame((timestamp) => {
                if (!state.paused && surface.isConnected) callback(timestamp);
                else state.pausedRafCallbacks.push(callback);
            });
        });
    }

    function createPausableRaf(surface) {
        const state = stateFor(surface);
        return (callback) => {
            if (typeof callback !== 'function' || !surface.isConnected) return 0;
            if (state.paused) {
                state.pausedRafCallbacks.push(callback);
                return state.pausedRafCallbacks.length;
            }
            return requestAnimationFrame((timestamp) => {
                if (!surface.isConnected) return;
                if (state.paused) state.pausedRafCallbacks.push(callback);
                else callback(timestamp);
            });
        };
    }

    function createTimer(surface, callback, delay, repeat, args) {
        const state = stateFor(surface);
        const timer = {
            nativeId: null,
            canceled: false,
            pending: false,
            schedule() {
                if (timer.canceled || state.paused || !surface.isConnected) {
                    timer.pending = !timer.canceled && surface.isConnected;
                    return;
                }
                timer.nativeId = setTimeout(() => {
                    timer.nativeId = null;
                    if (state.paused) {
                        timer.pending = true;
                        return;
                    }
                    callback(...args);
                    if (repeat && !timer.canceled) timer.schedule();
                    else state.timers.delete(timer);
                }, Math.max(0, Number(delay) || 0));
            },
            pause() {
                if (timer.nativeId !== null) {
                    clearTimeout(timer.nativeId);
                    timer.nativeId = null;
                    timer.pending = true;
                }
            },
            resume() {
                if (!timer.canceled && (timer.pending || repeat)) {
                    timer.pending = false;
                    timer.schedule();
                }
            },
            cancel() {
                timer.canceled = true;
                timer.pending = false;
                if (timer.nativeId !== null) clearTimeout(timer.nativeId);
                timer.nativeId = null;
                state.timers.delete(timer);
            },
        };
        state.timers.add(timer);
        timer.schedule();
        return timer;
    }

    function createPausableTimerApi(surface) {
        return Object.freeze({
            setTimeout: (callback, delay, ...args) =>
                createTimer(surface, callback, delay, false, args),
            clearTimeout: (timer) => timer?.cancel?.(),
            setInterval: (callback, delay, ...args) =>
                createTimer(surface, callback, delay, true, args),
            clearInterval: (timer) => timer?.cancel?.(),
        });
    }

    function registerCanvas(surface, context) {
        if (!surface || !context) return () => {};
        const state = stateFor(surface);
        const record = {
            pause: typeof context.pause === 'function' ? context.pause : null,
            resume: typeof context.resume === 'function' ? context.resume : null,
            paused: false,
        };
        state.canvasContexts.add(record);
        if (state.paused) {
            record.pause?.();
            record.paused = true;
        }
        return () => state.canvasContexts.delete(record);
    }

    function observePages(root, host, options = {}) {
        const viewportRoot = options.viewportRoot === true;
        if (!root || (!host && !viewportRoot)) {
            return { disconnect() {} };
        }
        const targets = [
            ...root.querySelectorAll(options.selector || '.vdoc-page'),
        ];
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) resume(entry.target);
                else pause(entry.target);
            });
        }, {
            // Shadow Root 中的岛并非普通 DOM contains() 意义下的 host
            // 后代。逐岛观察使用顶层视口作为根，所有滚动/overflow
            // 祖先仍会参与浏览器的相交裁剪。
            root: viewportRoot ? null : host,
            rootMargin: options.rootMargin ?? DEFAULT_MARGIN,
            threshold: 0,
        });
        targets.forEach((target) => {
            stateFor(target);
            observer.observe(target);
        });
        return Object.freeze({
            disconnect() {
                observer.disconnect();
                targets.forEach(disposeSurface);
            },
        });
    }

    function disposeSurface(surface) {
        const state = surfaceStates.get(surface);
        if (!state) return;
        state.timers.forEach((timer) => timer.cancel());
        state.canvasContexts.forEach((context) => context.pause?.());
        state.pausedRafCallbacks.length = 0;
        surfaceStates.delete(surface);
    }

    window.ScriptoriumVisibility = Object.freeze({
        observePages,
        pause,
        resume,
        scan,
        isPaused: (surface) => Boolean(surfaceStates.get(surface)?.paused),
        createPausableRaf,
        createPausableTimerApi,
        registerCanvas,
        disposeSurface,
    });
})();