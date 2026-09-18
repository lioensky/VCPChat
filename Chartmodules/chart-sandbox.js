'use strict';

(() => {
    const root = document.getElementById('vcp-chart-root');
    const LIBRARY_URLS = Object.freeze({
        anime: ['../vendor/anime.min.js'],
        three: ['../vendor/three.min.js'],
        pixi: ['../vendor/pixi.min.js', '../vendor/pixi-unsafe-eval.min.js'],
    });

    let chartId = null;
    let generation = 0;
    let manifest = null;
    let data = {};
    let runtimeSource = '';
    let instance = null;
    let controller = null;
    let resources = null;
    let mutationObserver = null;
    let stableTimer = null;
    let destroyed = true;
    let status = 'idle';
    let lastDiagnostics = null;

    const loadedScripts = new Map();

    function send(type, payload = {}) {
        parent.postMessage({
            source: 'vcp-chart-sandbox',
            chartId,
            generation,
            type,
            ...payload,
        }, '*');
    }

    function setStatus(nextStatus, description = '') {
        status = nextStatus;
        send('status', { status: nextStatus, description });
    }

    function loadScript(src) {
        if (loadedScripts.has(src)) return loadedScripts.get(src);
        const promise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.dataset.chartLibrary = src;
            script.addEventListener('load', () => resolve(src), { once: true });
            script.addEventListener('error', () => {
                loadedScripts.delete(src);
                script.remove();
                reject(new Error(`本地图表依赖加载失败：${src}`));
            }, { once: true });
            document.head.appendChild(script);
        });
        loadedScripts.set(src, promise);
        return promise;
    }

    async function loadLibraries(libraries = []) {
        for (const library of libraries) {
            const urls = LIBRARY_URLS[library];
            if (!urls) throw new Error(`不支持的图表依赖：${library}`);
            for (const url of urls) await loadScript(url);
        }
    }

    function deepClone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function pointerTokens(pointer) {
        if (!pointer) return [];
        if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
            throw new Error(`无效数据路径：${pointer}`);
        }
        return pointer.slice(1).split('/').map(token =>
            token.replace(/~1/g, '/').replace(/~0/g, '~')
        );
    }

    function getPointer(pointer) {
        let current = data;
        for (const token of pointerTokens(pointer)) current = current[token];
        return current;
    }

    function parentAndKey(pointer) {
        const tokens = pointerTokens(pointer);
        let parentValue = data;
        for (const token of tokens.slice(0, -1)) parentValue = parentValue[token];
        return { parentValue, key: tokens.at(-1) };
    }

    function applyOperation(operation) {
        const op = String(operation.op || '').toLowerCase();
        const pointer = operation.path || '';

        if (!pointer && ['replace', 'set', 'add'].includes(op)) {
            data = deepClone(operation.value);
            return;
        }

        if (op === 'append' || op === 'prepend') {
            const target = getPointer(pointer);
            if (!Array.isArray(target)) throw new Error(`${op} 目标不是数组：${pointer}`);
            const values = operation.spread && Array.isArray(operation.value)
                ? deepClone(operation.value)
                : [deepClone(operation.value)];
            if (op === 'append') target.push(...values);
            else target.unshift(...values);
            const maxItems = Number(operation.maxItems);
            if (Number.isInteger(maxItems) && maxItems >= 0 && target.length > maxItems) {
                if (op === 'append') target.splice(0, target.length - maxItems);
                else target.splice(maxItems);
            }
            return;
        }

        if (op === 'splice') {
            const target = getPointer(pointer);
            if (!Array.isArray(target)) throw new Error(`splice 目标不是数组：${pointer}`);
            target.splice(
                Number(operation.start),
                Number(operation.deleteCount || 0),
                ...(operation.items || [])
            );
            return;
        }

        if (op === 'increment') {
            const ref = parentAndKey(pointer);
            ref.parentValue[ref.key] += Number(operation.value ?? 1);
            return;
        }

        if (op === 'toggle') {
            const ref = parentAndKey(pointer);
            ref.parentValue[ref.key] = !ref.parentValue[ref.key];
            return;
        }

        if (op === 'remove') {
            const ref = parentAndKey(pointer);
            if (Array.isArray(ref.parentValue)) ref.parentValue.splice(Number(ref.key), 1);
            else delete ref.parentValue[ref.key];
            return;
        }

        if (op === 'merge') {
            const ref = parentAndKey(pointer);
            ref.parentValue[ref.key] = {
                ...(ref.parentValue[ref.key] || {}),
                ...(deepClone(operation.value) || {}),
            };
            return;
        }

        if (op === 'move' || op === 'copy') {
            const value = deepClone(getPointer(operation.from));
            if (op === 'move') applyOperation({ op: 'remove', path: operation.from });
            applyOperation({ op: 'add', path: pointer, value });
            return;
        }

        if (op === 'test') return;

        const ref = parentAndKey(pointer);
        if (Array.isArray(ref.parentValue) && op === 'add') {
            const index = ref.key === '-' ? ref.parentValue.length : Number(ref.key);
            ref.parentValue.splice(index, 0, deepClone(operation.value));
        } else {
            ref.parentValue[ref.key] = deepClone(operation.value);
        }
    }

    function createResourceScope() {
        const cleanups = [];
        const timers = new Set();
        const intervals = new Set();
        const frames = new Set();
        const animeInstances = new Set();
        const threeEntries = new Set();
        const pixiApps = new Set();

        return {
            track(disposable) {
                if (typeof disposable === 'function') cleanups.push(disposable);
                else if (typeof disposable?.destroy === 'function') {
                    cleanups.push(() => disposable.destroy());
                } else if (typeof disposable?.dispose === 'function') {
                    cleanups.push(() => disposable.dispose());
                }
                return disposable;
            },
            addEventListener(target, type, listener, options) {
                target.addEventListener(type, listener, options);
                cleanups.push(() => target.removeEventListener(type, listener, options));
                return listener;
            },
            setTimeout(callback, delay, ...args) {
                const id = window.setTimeout(() => {
                    timers.delete(id);
                    if (!destroyed) callback(...args);
                }, delay);
                timers.add(id);
                return id;
            },
            clearTimeout(id) {
                timers.delete(id);
                window.clearTimeout(id);
            },
            setInterval(callback, delay, ...args) {
                const id = window.setInterval(() => {
                    if (!destroyed) callback(...args);
                }, delay);
                intervals.add(id);
                return id;
            },
            clearInterval(id) {
                intervals.delete(id);
                window.clearInterval(id);
            },
            requestAnimationFrame(callback) {
                const id = window.requestAnimationFrame(timestamp => {
                    frames.delete(id);
                    if (!destroyed) callback(timestamp);
                });
                frames.add(id);
                return id;
            },
            cancelAnimationFrame(id) {
                frames.delete(id);
                window.cancelAnimationFrame(id);
            },
            registerAnimeInstance(value) {
                if (value) animeInstances.add(value);
                return value;
            },
            registerThreeRenderer(renderer, scene = null) {
                if (renderer) threeEntries.add({ renderer, scene });
                return renderer;
            },
            registerPixiApplication(app) {
                if (app) pixiApps.add(app);
                return app;
            },
            async destroy() {
                timers.forEach(id => clearTimeout(id));
                intervals.forEach(id => clearInterval(id));
                frames.forEach(id => cancelAnimationFrame(id));
                animeInstances.forEach(value => {
                    try { value.pause?.(); } catch (_error) {}
                });
                try { window.anime?.remove?.(root.querySelectorAll('*')); } catch (_error) {}
                pixiApps.forEach(app => {
                    try { app.stop?.(); } catch (_error) {}
                    try {
                        app.destroy?.(
                            { removeView: true },
                            { children: true, texture: true, textureSource: true }
                        );
                    } catch (_error) {}
                });
                threeEntries.forEach(({ renderer, scene }) => {
                    try {
                        scene?.traverse?.(object => {
                            object.geometry?.dispose?.();
                            const materials = Array.isArray(object.material)
                                ? object.material
                                : [object.material];
                            materials.filter(Boolean).forEach(material => {
                                Object.values(material).forEach(value =>
                                    value?.isTexture && value.dispose?.()
                                );
                                material.dispose?.();
                            });
                        });
                        renderer?.dispose?.();
                        renderer?.forceContextLoss?.();
                    } catch (_error) {}
                });
                cleanups.splice(0).reverse().forEach(cleanup => {
                    try { cleanup(); } catch (_error) {}
                });
            },
        };
    }

    function collectDiagnostics() {
        const rootRect = root.getBoundingClientRect();
        const canvases = [...root.querySelectorAll('canvas')].map((canvas, index) => {
            const rect = canvas.getBoundingClientRect();
            let possiblyBlank = false;
            try {
                const context2d = canvas.getContext('2d');
                if (context2d && canvas.width && canvas.height) {
                    const sampleWidth = Math.min(canvas.width, 64);
                    const sampleHeight = Math.min(canvas.height, 64);
                    const pixels = context2d.getImageData(
                        0, 0, sampleWidth, sampleHeight
                    ).data;
                    possiblyBlank = !pixels.some((value, offset) =>
                        offset % 4 === 3 && value > 3
                    );
                }
            } catch (_error) {
                possiblyBlank = false;
            }
            return {
                index,
                cssWidth: Math.round(rect.width),
                cssHeight: Math.round(rect.height),
                pixelWidth: canvas.width,
                pixelHeight: canvas.height,
                possiblyBlank,
                lowResolution: canvas.width + 1 < rect.width * devicePixelRatio
                    || canvas.height + 1 < rect.height * devicePixelRatio,
            };
        });

        const overflowX = root.scrollWidth > root.clientWidth + 1;
        const overflowY = root.scrollHeight > root.clientHeight + 1;
        const warnings = [];
        if (overflowX) warnings.push({
            code: 'HORIZONTAL_OVERFLOW',
            message: '图表内容宽度超过展示区。',
            amount: root.scrollWidth - root.clientWidth,
        });
        if (overflowY) warnings.push({
            code: 'VERTICAL_OVERFLOW',
            message: '图表内容高度超过展示区。',
            amount: root.scrollHeight - root.clientHeight,
        });
        for (const canvas of canvases) {
            if (!canvas.cssWidth || !canvas.cssHeight) warnings.push({
                code: 'ZERO_SIZE_CANVAS',
                message: `Canvas ${canvas.index} 的显示尺寸为零。`,
            });
            if (canvas.lowResolution) warnings.push({
                code: 'LOW_RESOLUTION_CANVAS',
                message: `Canvas ${canvas.index} 的像素分辨率低于设备像素比。`,
            });
            if (canvas.possiblyBlank) warnings.push({
                code: 'POSSIBLY_BLANK_CANVAS',
                message: `Canvas ${canvas.index} 可能为空白。`,
            });
        }

        return {
            status,
            viewport: {
                width: innerWidth,
                height: innerHeight,
                devicePixelRatio,
            },
            document: {
                scrollWidth: root.scrollWidth,
                scrollHeight: root.scrollHeight,
                clientWidth: root.clientWidth,
                clientHeight: root.clientHeight,
                overflowX,
                overflowY,
            },
            rootBounds: {
                x: rootRect.x,
                y: rootRect.y,
                width: rootRect.width,
                height: rootRect.height,
            },
            canvases,
            warnings,
            capturedAt: new Date().toISOString(),
        };
    }

    function reportError(error) {
        const message = error?.stack || error?.message || String(error);
        setStatus('error', message);
        send('error', { message, diagnostics: collectDiagnostics() });
    }

    async function reportStable(metadata = {}) {
        if (destroyed) return;
        try { await document.fonts?.ready; } catch (_error) {}
        await new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        lastDiagnostics = collectDiagnostics();
        setStatus('stable', '渲染稳定');
        send('stable', { metadata, diagnostics: lastDiagnostics });
    }

    function scheduleStable(reason) {
        if (destroyed) return;
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = window.setTimeout(
            () => reportStable({ reason }).catch(reportError),
            180
        );
    }

    function markBusy(reason = '') {
        if (destroyed) return;
        if (stableTimer) clearTimeout(stableTimer);
        setStatus('busy', reason || '图表正在更新');
        scheduleStable(reason || 'update');
    }

    function createContext() {
        const libraries = Object.freeze({
            anime: window.anime,
            THREE: window.THREE,
            PIXI: window.PIXI,
        });
        return Object.freeze({
            root,
            manifest,
            libraries,
            resources,
            signal: controller.signal,
            get data() { return data; },
            requestRender(reason = 'runtime-request') {
                markBusy(reason);
            },
            emit(name, payload) {
                send('runtime-event', { name, payload });
            },
            reportReady(metadata = {}) {
                setStatus('ready', '运行时已就绪');
                send('ready', { metadata });
                scheduleStable('runtime-ready');
            },
            reportBusy(reason = '') {
                markBusy(reason);
            },
            reportStable(metadata = {}) {
                reportStable(metadata).catch(reportError);
            },
            reportError,
        });
    }

    async function destroyRuntime({ announce = true } = {}) {
        if (destroyed) return;
        destroyed = true;
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = null;
        mutationObserver?.disconnect();
        mutationObserver = null;
        const context = instance ? createContext() : null;
        try { await instance?.destroy?.(context); } catch (_error) {}
        controller?.abort();
        await resources?.destroy?.();
        resources = null;
        instance = null;
        root.replaceChildren();
        document.querySelectorAll('style[data-chart-style]').forEach(node => node.remove());
        if (announce) setStatus('destroyed', '运行时已销毁');
    }

    async function mountSnapshot(snapshot) {
        await destroyRuntime({ announce: false });
        chartId = snapshot.manifest.id;
        generation = snapshot.generation;
        manifest = deepClone(snapshot.manifest);
        data = deepClone(snapshot.data);
        runtimeSource = String(snapshot.runtime || '');
        destroyed = false;
        controller = new AbortController();
        resources = createResourceScope();

        setStatus('loading', '正在加载本地渲染依赖');
        await loadLibraries(manifest.libraries || []);

        const style = document.createElement('style');
        style.dataset.chartStyle = 'true';
        style.textContent = String(snapshot.style || '');
        document.head.appendChild(style);

        const template = document.createElement('template');
        template.innerHTML = String(snapshot.template || '').replace(
            /<script\b[\s\S]*?<\/script\s*>/gi,
            ''
        );
        root.replaceChildren(template.content.cloneNode(true));

        setStatus('mounting', '正在挂载图表');
        const context = createContext();
        const factory = new Function(
            'context',
            'data',
            'manifest',
            'libraries',
            'anime',
            'THREE',
            'PIXI',
            runtimeSource
        );
        instance = await factory(
            context,
            data,
            manifest,
            context.libraries,
            context.libraries.anime,
            context.libraries.THREE,
            context.libraries.PIXI
        ) || {};
        await instance.mount?.(context);

        mutationObserver = new MutationObserver(() => {
            if (status === 'stable' || status === 'ready') {
                markBusy('DOM changed');
            }
        });
        mutationObserver.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });

        setStatus('ready', '图表已挂载');
        send('ready');
        scheduleStable('mounted');
    }

    async function handleMessage(message) {
        if (!message || message.source !== 'vcp-chart-shell') return;

        if (message.type === 'initialize') {
            await mountSnapshot(message.snapshot);
            return;
        }

        if (!chartId || message.chartId !== chartId) return;

        const context = createContext();
        if (message.type === 'data-change') {
            markBusy('接收数据更新');
            if (
                message.change.type === 'data-replaced'
                && message.change.data !== undefined
            ) {
                data = deepClone(message.change.data);
            } else {
                (message.change.operations || []).forEach(applyOperation);
            }
            await instance?.update?.(message.change, context);
            scheduleStable('data-updated');
        } else if (message.type === 'resize') {
            await instance?.resize?.(message.size, context);
            scheduleStable('resized');
        } else if (message.type === 'theme') {
            await instance?.setTheme?.(message.theme, context);
            scheduleStable('theme-changed');
        } else if (message.type === 'diagnose') {
            send('diagnostics', {
                requestId: message.requestId,
                diagnostics: collectDiagnostics(),
            });
        } else if (message.type === 'destroy') {
            await destroyRuntime();
        }
    }

    window.addEventListener('message', event => {
        handleMessage(event.data).catch(reportError);
    });
    window.addEventListener('error', event =>
        reportError(event.error || event.message)
    );
    window.addEventListener('unhandledrejection', event =>
        reportError(event.reason)
    );
    window.addEventListener('beforeunload', () => {
        destroyRuntime({ announce: false }).catch(() => undefined);
    });

    send('sandbox-ready');
})();