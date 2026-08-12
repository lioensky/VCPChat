'use strict';

(() => {
    function createRuntimeController(context = {}) {
        const documentPort = context.documentPort;
        const policy = context.policy || window.ScriptoriumProgrammableContent;
        if (!documentPort) {
            throw new TypeError('Runtime controller requires DocumentPort.');
        }

        const surfaces = new Map();
        let diagnostics = [];
        let disposed = false;

        function assertActive() {
            if (disposed) {
                throw new Error('Runtime controller has been disposed.');
            }
        }

        function recordDiagnostics(items = []) {
            diagnostics = items.map((item) => Object.freeze({
                ...item,
                createdAt: Date.now(),
            }));
            diagnostics.forEach((item) => {
                const log = item.level === 'refuse'
                    ? console.error
                    : console.warn;
                log('[Scriptorium Runtime]', item);
            });
            context.onDiagnostics?.([...diagnostics]);
            return diagnostics;
        }

        function createLifecycle() {
            const frames = new Set();
            const timeouts = new Set();
            const intervals = new Set();
            const cleanups = [];
            let stopped = false;

            function requestFrame(callback) {
                if (stopped) return 0;
                const id = window.requestAnimationFrame((timestamp) => {
                    frames.delete(id);
                    if (!stopped) callback(timestamp);
                });
                frames.add(id);
                return id;
            }

            function cancelFrame(id) {
                frames.delete(id);
                window.cancelAnimationFrame(id);
            }

            function setTimeoutTracked(callback, wait, ...args) {
                if (stopped) return 0;
                const id = window.setTimeout(() => {
                    timeouts.delete(id);
                    if (!stopped) callback(...args);
                }, wait);
                timeouts.add(id);
                return id;
            }

            function clearTimeoutTracked(id) {
                timeouts.delete(id);
                window.clearTimeout(id);
            }

            function setIntervalTracked(callback, wait, ...args) {
                if (stopped) return 0;
                const id = window.setInterval(() => {
                    if (!stopped) callback(...args);
                }, wait);
                intervals.add(id);
                return id;
            }

            function clearIntervalTracked(id) {
                intervals.delete(id);
                window.clearInterval(id);
            }

            function addCleanup(cleanup) {
                if (typeof cleanup === 'function') cleanups.push(cleanup);
                return cleanup;
            }

            function stop() {
                if (stopped) return;
                stopped = true;
                frames.forEach(window.cancelAnimationFrame);
                timeouts.forEach(window.clearTimeout);
                intervals.forEach(window.clearInterval);
                frames.clear();
                timeouts.clear();
                intervals.clear();
                [...cleanups].reverse().forEach((cleanup) => {
                    try {
                        cleanup();
                    } catch (error) {
                        console.error(
                            '[Scriptorium Runtime] Cleanup failed:',
                            error
                        );
                    }
                });
                cleanups.length = 0;
            }

            return Object.freeze({
                requestAnimationFrame: requestFrame,
                cancelAnimationFrame: cancelFrame,
                setTimeout: setTimeoutTracked,
                clearTimeout: clearTimeoutTracked,
                setInterval: setIntervalTracked,
                clearInterval: clearIntervalTracked,
                addCleanup,
                dispose: stop,
            });
        }

        function scopedDocument(root) {
            const matchesRoot = (selector) =>
                root?.nodeType === Node.ELEMENT_NODE
                && root.matches?.(selector);
            return new Proxy(document, {
                get(target, property) {
                    if (property === 'querySelector') {
                        return (selector) =>
                            (matchesRoot(selector) ? root : null)
                            || root.querySelector(selector)
                            || target.querySelector(selector);
                    }
                    if (property === 'querySelectorAll') {
                        return (selector) => {
                            const descendants = [...root.querySelectorAll(selector)];
                            return matchesRoot(selector)
                                ? [root, ...descendants]
                                : descendants;
                        };
                    }
                    if (property === 'getElementById') {
                        return (id) => {
                            const normalizedId = String(id);
                            return root?.nodeType === Node.ELEMENT_NODE
                                && root.id === normalizedId
                                ? root
                                : root.querySelector(
                                    `#${CSS.escape(normalizedId)}`
                                )
                                || target.getElementById(normalizedId);
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function'
                        ? value.bind(target)
                        : value;
                },
            });
        }

        function review(source, reviewContext) {
            if (!policy?.reviewJavaScript) {
                return {
                    allowed: false,
                    level: 'refuse',
                    context: reviewContext,
                    findings: [{
                        level: 'refuse',
                        ruleId: 'review-engine-unavailable',
                        message: '可编程内容审查器未加载，拒绝执行脚本。',
                    }],
                };
            }
            return policy.reviewJavaScript(source, reviewContext);
        }

        function trackedAnime(root, lifecycle) {
            if (typeof window.anime !== 'function') return window.anime;
            const instances = new Set();
            const register = (instance) => {
                if (instance?.pause) instances.add(instance);
                return instance;
            };
            lifecycle.addCleanup(() => {
                instances.forEach((instance) => {
                    try {
                        instance.pause();
                    } catch {}
                });
                instances.clear();
            });
            return new Proxy(window.anime, {
                apply(target, thisArg, args) {
                    return register(Reflect.apply(target, thisArg, args));
                },
                get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property === 'timeline'
                        && typeof value === 'function') {
                        return (...args) =>
                            register(value.apply(target, args));
                    }
                    return typeof value === 'function'
                        ? value.bind(target)
                        : value;
                },
            });
        }

        function executeScript(input) {
            const {
                source,
                root,
                kind,
                surface,
                scriptId,
                lifecycle,
                deck,
            } = input;
            const documentKind = kind === 'deck' ? 'pptx' : 'docx';
            const reviewed = review(source, {
                documentKind,
                surface,
                scriptId,
            });
            const findings = (reviewed.findings || []).map((finding) => ({
                ...finding,
                documentKind,
                surface,
                scriptId,
                context: reviewed.context,
            }));
            if (!reviewed.allowed) {
                root.dataset.vdocScriptRefused = 'true';
                return { allowed: false, findings };
            }

            root.removeAttribute('data-vdoc-script-refused');
            const runtime = Object.freeze({
                surface,
                root,
                scriptId,
                addCleanup: lifecycle.addCleanup,
                requestAnimationFrame: lifecycle.requestAnimationFrame,
                cancelAnimationFrame: lifecycle.cancelAnimationFrame,
                setTimeout: lifecycle.setTimeout,
                clearTimeout: lifecycle.clearTimeout,
                setInterval: lifecycle.setInterval,
                clearInterval: lifecycle.clearInterval,
            });
            try {
                const anime = trackedAnime(root, lifecycle);
                const names = kind === 'deck'
                    ? ['scene', 'deck', 'runtime', 'document', 'anime']
                    : ['scene', 'runtime', 'document', 'anime'];
                const execute = new Function(
                    ...names,
                    'requestAnimationFrame',
                    'cancelAnimationFrame',
                    'setTimeout',
                    'clearTimeout',
                    'setInterval',
                    'clearInterval',
                    String(source || '')
                );
                const base = kind === 'deck'
                    ? [root, deck, runtime, scopedDocument(root), anime]
                    : [root, runtime, scopedDocument(root), anime];
                const returned = execute.call(
                    root,
                    ...base,
                    lifecycle.requestAnimationFrame,
                    lifecycle.cancelAnimationFrame,
                    lifecycle.setTimeout,
                    lifecycle.clearTimeout,
                    lifecycle.setInterval,
                    lifecycle.clearInterval
                );
                if (typeof returned === 'function') {
                    lifecycle.addCleanup(returned);
                } else if (returned?.dispose) {
                    lifecycle.addCleanup(() => returned.dispose());
                }
            } catch (error) {
                findings.push({
                    level: 'refuse',
                    ruleId: 'runtime-execution-error',
                    message: `脚本执行失败：${error.message}`,
                    documentKind,
                    surface,
                    scriptId,
                });
            }
            return { allowed: true, findings, runtime };
        }

        function markGeneratedNodes(root, lifecycle) {
            const observer = new MutationObserver((records) => {
                records.forEach((record) => {
                    record.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            node.dataset.vdocRuntimeGenerated = 'true';
                        }
                    });
                });
            });
            observer.observe(root, { childList: true, subtree: true });
            lifecycle.addCleanup(() => observer.disconnect());
        }

        function activateDeck(input, lifecycle) {
            const slide = input.adapter.activeSlide();
            const parsed = input.adapter.parsedSlide(slide);
            const runtimeRoot = input.surface === 'read'
                ? input.root.querySelector(
                    `[data-vdoc-slide-id="${
                        CSS.escape(slide?.id || '')
                    }"]`
                )
                : input.root.querySelector('.vdoc-slide-editor-runtime');
            if (!runtimeRoot || !parsed.script) return [];
            markGeneratedNodes(runtimeRoot, lifecycle);
            return executeScript({
                source: parsed.script,
                root: runtimeRoot,
                kind: 'deck',
                surface: input.surface,
                scriptId: slide.id,
                lifecycle,
                deck: window.VCPDeck || null,
            }).findings;
        }

        function activateFlow(input, lifecycle) {
            const runtimeRoot = input.root.querySelector(
                input.surface === 'read'
                    ? '.vdoc-paged-runtime'
                    : '.vdoc-flow-runtime'
            );
            if (!runtimeRoot) return [];
            const findings = [];
            runtimeRoot.querySelectorAll('script').forEach(
                (scriptElement, index) => {
                    if (scriptElement.src
                        || scriptElement.getAttribute('src')) {
                        findings.push({
                            level: 'warn',
                            ruleId: 'external-script-not-executed',
                            message: '外部脚本依赖不由文档运行时直接执行。',
                            documentKind: 'docx',
                            surface: input.surface,
                            scriptId: scriptElement.id
                                || `document-island-${index + 1}`,
                        });
                        return;
                    }
                    const island = scriptElement.closest(
                        '[data-vdoc-island],'
                        + '[data-vdoc-interactive],'
                        + '[data-vdoc-component]'
                    ) || runtimeRoot;
                    const scriptId = scriptElement.id
                        || scriptElement.dataset.vdocScript
                        || `document-island-${index + 1}`;
                    markGeneratedNodes(island, lifecycle);
                    findings.push(...executeScript({
                        source: scriptElement.textContent || '',
                        root: island,
                        kind: 'flow',
                        surface: input.surface,
                        scriptId,
                        lifecycle,
                    }).findings);
                }
            );
            return findings;
        }

        function disposeSurface(surface) {
            const key = surface === 'read' ? 'read' : 'edit';
            const entry = surfaces.get(key);
            if (!entry) return false;
            entry.lifecycle.dispose();
            surfaces.delete(key);
            return true;
        }

        function activate(input = {}) {
            assertActive();
            const surface = input.surface === 'read' ? 'read' : 'edit';
            if (!input.root?.isConnected || !input.adapter) {
                disposeSurface(surface);
                return false;
            }
            const status = documentPort.status();
            const identity = [
                status.generation,
                status.revision,
                input.adapter.kind,
                surface,
            ].join(':');
            const current = surfaces.get(surface);
            if (current?.identity === identity
                && current.root === input.root) {
                return current.runtime;
            }

            disposeSurface(surface);
            const lifecycle = createLifecycle();
            const nextDiagnostics = input.adapter.kind === 'deck'
                ? activateDeck(input, lifecycle)
                : activateFlow(input, lifecycle);
            recordDiagnostics(nextDiagnostics);
            const runtime = Object.freeze({
                identity,
                kind: input.adapter.kind,
                surface,
                root: input.root,
                diagnostics: nextDiagnostics,
            });
            surfaces.set(surface, {
                identity,
                root: input.root,
                lifecycle,
                runtime,
            });
            return runtime;
        }

        function status() {
            return Object.freeze({
                activeSurfaces: [...surfaces.keys()],
                diagnostics: [...diagnostics],
            });
        }

        function dispose() {
            if (disposed) return;
            [...surfaces.keys()].forEach(disposeSurface);
            diagnostics = [];
            disposed = true;
        }

        return Object.freeze({
            activate,
            disposeSurface,
            dispose,
            recordDiagnostics,
            status,
        });
    }

    window.ScriptoriumRuntime = Object.freeze({
        createRuntimeController,
    });
})();