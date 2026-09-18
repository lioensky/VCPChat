'use strict';

(() => {
    const LIBRARY_URLS = Object.freeze({
        anime: ['../vendor/anime.min.js'],
        three: ['../vendor/three.min.js'],
        pixi: ['../vendor/pixi.min.js', '../vendor/pixi-unsafe-eval.min.js'],
    });
    const loadedScripts = new Map();

    function loadScript(src) {
        if (loadedScripts.has(src)) return loadedScripts.get(src);
        const promise = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-chart-library-src="${src}"]`);
            if (existing?.dataset.loaded === 'true') {
                resolve(src);
                return;
            }
            const script = existing || document.createElement('script');
            script.src = src;
            script.dataset.chartLibrarySrc = src;
            script.onload = () => {
                script.dataset.loaded = 'true';
                resolve(src);
            };
            script.onerror = () => {
                loadedScripts.delete(src);
                script.remove();
                reject(new Error(`本地图表依赖加载失败：${src}`));
            };
            if (!existing) document.head.appendChild(script);
        });
        loadedScripts.set(src, promise);
        return promise;
    }

    async function loadLibraries(libraries = []) {
        for (const name of libraries) {
            const urls = LIBRARY_URLS[name];
            if (!urls) throw new Error(`不支持的图表依赖：${name}`);
            for (const url of urls) await loadScript(url);
        }
    }

    function clone(value) {
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

    function applyOperation(holder, operation) {
        const op = String(operation.op || '').toLowerCase();
        const pointer = operation.path || '';
        if (!pointer && ['replace', 'set', 'add'].includes(op)) {
            holder.value = clone(operation.value);
            return;
        }

        const tokens = pointerTokens(pointer);
        let parent = holder.value;
        for (const token of tokens.slice(0, -1)) parent = parent[token];
        const key = tokens.at(-1);
        const get = () => tokens.reduce((current, token) => current[token], holder.value);

        if (op === 'append' || op === 'prepend') {
            const target = get();
            const values = operation.spread && Array.isArray(operation.value)
                ? clone(operation.value)
                : [clone(operation.value)];
            if (op === 'append') target.push(...values);
            else target.unshift(...values);
            const maxItems = Number(operation.maxItems);
            if (Number.isInteger(maxItems) && maxItems >= 0 && target.length > maxItems) {
                if (op === 'append') target.splice(0, target.length - maxItems);
                else target.splice(maxItems);
            }
        } else if (op === 'splice') {
            get().splice(
                Number(operation.start),
                Number(operation.deleteCount || 0),
                ...(operation.items || [])
            );
        } else if (op === 'increment') {
            parent[key] += Number(operation.value ?? 1);
        } else if (op === 'toggle') {
            parent[key] = !parent[key];
        } else if (op === 'remove') {
            if (Array.isArray(parent)) parent.splice(Number(key), 1);
            else delete parent[key];
        } else if (op === 'merge') {
            parent[key] = { ...(parent[key] || {}), ...(clone(operation.value) || {}) };
        } else if (op !== 'test') {
            if (Array.isArray(parent) && op === 'add') {
                parent.splice(key === '-' ? parent.length : Number(key), 0, clone(operation.value));
            } else {
                parent[key] = clone(operation.value);
            }
        }
    }

    function createResources(root, isAlive) {
        const cleanups = [];
        const timers = new Set();
        const intervals = new Set();
        const frames = new Set();
        const animeInstances = new Set();
        const threeEntries = new Set();
        const pixiApps = new Set();

        return Object.freeze({
            track(disposable) {
                if (typeof disposable === 'function') cleanups.push(disposable);
                else if (typeof disposable?.destroy === 'function') cleanups.push(() => disposable.destroy());
                else if (typeof disposable?.dispose === 'function') cleanups.push(() => disposable.dispose());
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
                    if (isAlive()) callback(...args);
                }, delay);
                timers.add(id);
                return id;
            },
            clearTimeout(id) {
                timers.delete(id);
                clearTimeout(id);
            },
            setInterval(callback, delay, ...args) {
                const id = window.setInterval(() => isAlive() && callback(...args), delay);
                intervals.add(id);
                return id;
            },
            clearInterval(id) {
                intervals.delete(id);
                clearInterval(id);
            },
            requestAnimationFrame(callback) {
                const id = requestAnimationFrame(time => {
                    frames.delete(id);
                    if (isAlive()) callback(time);
                });
                frames.add(id);
                return id;
            },
            cancelAnimationFrame(id) {
                frames.delete(id);
                cancelAnimationFrame(id);
            },
            registerAnimeInstance(value) {
                if (value) animeInstances.add(value);
                return value;
            },
            registerThreeRenderer(renderer, scene = null) {
                if (renderer) threeEntries.add({ renderer, scene });
                return renderer;
            },
            registerPixiApplication(value) {
                if (value) pixiApps.add(value);
                return value;
            },
            async destroy() {
                timers.forEach(clearTimeout);
                intervals.forEach(clearInterval);
                frames.forEach(cancelAnimationFrame);
                animeInstances.forEach(value => {
                    try { value.pause?.(); } catch (_error) {}
                });
                try { window.anime?.remove?.(root.querySelectorAll('*')); } catch (_error) {}
                pixiApps.forEach(value => {
                    try { value.stop?.(); } catch (_error) {}
                    try {
                        value.destroy?.(
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
        });
    }

    class ChartRuntime {
        constructor({ host, api, onStatus, onError, onStable, onEvent }) {
            this.host = host;
            this.api = api;
            this.onStatus = onStatus || (() => {});
            this.onError = onError || (() => {});
            this.onStable = onStable || (() => {});
            this.onEvent = onEvent || (() => {});
            this.snapshot = null;
            this.instance = null;
            this.resources = null;
            this.controller = null;
            this.style = null;
            this.stableTimer = null;
            this.destroyed = true;
            this.status = 'idle';
            this.dataHolder = { value: {} };
            this.diagnostics = null;
        }

        setStatus(status, description = '') {
            this.status = status;
            this.onStatus({ status, description, diagnostics: this.diagnostics });
        }

        async mount(snapshot) {
            await this.destroy(false);
            this.snapshot = clone(snapshot);
            this.dataHolder.value = clone(snapshot.data);
            this.destroyed = false;
            this.controller = new AbortController();
            this.resources = createResources(this.host, () => !this.destroyed);

            try {
                this.setStatus('loading', '正在加载本地渲染依赖');
                await loadLibraries(snapshot.manifest.libraries || []);

                this.style = document.createElement('style');
                this.style.dataset.chartRuntimeStyle = snapshot.manifest.id;
                this.style.textContent = String(snapshot.style || '');
                document.head.appendChild(this.style);

                const template = document.createElement('template');
                template.innerHTML = String(snapshot.template || '').replace(
                    /<script\b[\s\S]*?<\/script\s*>/gi,
                    ''
                );
                this.host.replaceChildren(template.content.cloneNode(true));

                this.setStatus('mounting', '正在挂载图表');
                const context = this.createContext();
                const factory = new Function(
                    'context', 'data', 'manifest', 'libraries',
                    'anime', 'THREE', 'PIXI',
                    String(snapshot.runtime || '')
                );
                this.instance = await factory(
                    context,
                    this.dataHolder.value,
                    snapshot.manifest,
                    context.libraries,
                    context.libraries.anime,
                    context.libraries.THREE,
                    context.libraries.PIXI
                ) || {};
                await this.instance.mount?.(context);

                // 动态图表会持续修改 DOM、SVG 属性或 Canvas，不应把每次视觉帧
                // 解释成新的业务更新。稳定状态只由 mount、外置数据更新、resize、
                // theme 或 runtime 显式 reportBusy/reportStable 驱动。
                this.setStatus('ready', '图表已挂载');
                this.scheduleStable('mounted');
            } catch (error) {
                this.reportError(error);
            }
        }

        createContext() {
            const dataSources = Object.freeze({
                read: request => this.api.readDataSource({
                    chartId: this.snapshot.manifest.id,
                    ...request,
                }),
                fetchJson: url => this.api.readDataSource({
                    chartId: this.snapshot.manifest.id,
                    type: 'http-json',
                    url,
                }),
                readJson: source => this.api.readDataSource({
                    chartId: this.snapshot.manifest.id,
                    type: 'json',
                    source,
                }),
                readText: source => this.api.readDataSource({
                    chartId: this.snapshot.manifest.id,
                    type: 'text',
                    source,
                }),
                readCsv: source => this.api.readDataSource({
                    chartId: this.snapshot.manifest.id,
                    type: 'csv',
                    source,
                }),
                querySqlite: (source, sql, params = []) => this.api.readDataSource({
                    chartId: this.snapshot.manifest.id,
                    type: 'sqlite',
                    source,
                    sql,
                    params,
                }),
            });
            return Object.freeze({
                root: this.host,
                manifest: this.snapshot.manifest,
                libraries: Object.freeze({
                    anime: window.anime,
                    THREE: window.THREE,
                    PIXI: window.PIXI,
                }),
                resources: this.resources,
                dataSources,
                signal: this.controller.signal,
                get data() { return this.dataHolder?.value; },
                requestRender: reason => this.markBusy(reason || 'runtime-request'),
                emit: (name, payload) => this.onEvent({ name, payload }),
                reportReady: metadata => {
                    this.setStatus('ready', '运行时已就绪');
                    this.scheduleStable(metadata?.reason || 'runtime-ready');
                },
                reportBusy: reason => this.markBusy(reason),
                reportStable: metadata => this.reportStable(metadata),
                reportError: error => this.reportError(error),
                dataHolder: this.dataHolder,
            });
        }

        markBusy(reason = '') {
            if (this.destroyed) return;
            clearTimeout(this.stableTimer);
            this.setStatus('busy', reason || '图表正在更新');
            this.scheduleStable(reason || 'update');
        }

        scheduleStable(reason) {
            if (this.destroyed) return;
            clearTimeout(this.stableTimer);
            this.stableTimer = setTimeout(() => this.reportStable({ reason }), 180);
        }

        async reportStable(metadata = {}) {
            if (this.destroyed) return;
            try { await document.fonts?.ready; } catch (_error) {}
            await new Promise(resolve =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
            );
            this.diagnostics = this.collectDiagnostics();
            this.setStatus('stable', '渲染稳定');
            this.onStable({ metadata, diagnostics: this.diagnostics });
        }

        reportError(error) {
            const message = error?.stack || error?.message || String(error);
            this.setStatus('error', message);
            this.onError({ message, diagnostics: this.collectDiagnostics() });
        }

        async update(change) {
            if (change.type === 'data-replaced' && change.data !== undefined) {
                this.dataHolder.value = clone(change.data);
            } else {
                (change.operations || []).forEach(operation =>
                    applyOperation(this.dataHolder, operation)
                );
            }
            this.markBusy('接收数据更新');
            await this.instance?.update?.(change, this.createContext());
            this.scheduleStable('data-updated');
        }

        async resize(size) {
            if (this.destroyed) return;
            await this.instance?.resize?.(size, this.createContext());
            this.scheduleStable('resized');
        }

        async setTheme(theme) {
            if (this.destroyed) return;
            await this.instance?.setTheme?.(theme, this.createContext());
            this.scheduleStable('theme-changed');
        }

        collectDiagnostics() {
            const rect = this.host.getBoundingClientRect();
            const canvases = [...this.host.querySelectorAll('canvas')].map((canvas, index) => {
                const bounds = canvas.getBoundingClientRect();
                return {
                    index,
                    cssWidth: Math.round(bounds.width),
                    cssHeight: Math.round(bounds.height),
                    pixelWidth: canvas.width,
                    pixelHeight: canvas.height,
                    lowResolution: canvas.width + 1 < bounds.width * devicePixelRatio
                        || canvas.height + 1 < bounds.height * devicePixelRatio,
                };
            });
            const overflowX = this.host.scrollWidth > this.host.clientWidth + 1;
            const overflowY = this.host.scrollHeight > this.host.clientHeight + 1;
            const warnings = [];
            if (overflowX) warnings.push({
                code: 'HORIZONTAL_OVERFLOW',
                message: '图表内容宽度超过展示区。',
                amount: this.host.scrollWidth - this.host.clientWidth,
            });
            if (overflowY) warnings.push({
                code: 'VERTICAL_OVERFLOW',
                message: '图表内容高度超过展示区。',
                amount: this.host.scrollHeight - this.host.clientHeight,
            });
            canvases.forEach(canvas => {
                if (!canvas.cssWidth || !canvas.cssHeight) warnings.push({
                    code: 'ZERO_SIZE_CANVAS',
                    message: `Canvas ${canvas.index} 的显示尺寸为零。`,
                });
                if (canvas.lowResolution) warnings.push({
                    code: 'LOW_RESOLUTION_CANVAS',
                    message: `Canvas ${canvas.index} 的像素分辨率低于设备像素比。`,
                });
            });
            return {
                status: this.status,
                viewport: {
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    devicePixelRatio,
                },
                document: {
                    scrollWidth: this.host.scrollWidth,
                    scrollHeight: this.host.scrollHeight,
                    clientWidth: this.host.clientWidth,
                    clientHeight: this.host.clientHeight,
                    overflowX,
                    overflowY,
                },
                canvases,
                warnings,
                capturedAt: new Date().toISOString(),
            };
        }

        async destroy(announce = true) {
            if (this.destroyed) return;
            this.destroyed = true;
            clearTimeout(this.stableTimer);
            try { await this.instance?.destroy?.(this.createContext()); } catch (_error) {}
            this.controller?.abort();
            await this.resources?.destroy?.();
            this.resources = null;
            this.instance = null;
            this.host.replaceChildren();
            this.style?.remove();
            this.style = null;
            if (announce) this.setStatus('destroyed', '运行时已销毁');
        }
    }

    window.VCPChartRuntime = Object.freeze({
        ChartRuntime,
        loadLibraries,
    });
})();