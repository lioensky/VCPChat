'use strict';

(() => {
    function createRuntimeController(context) {
        const {
            state,
            parsedSlide,
            isSlideDeck,
            activeSlide,
            getRenderRoot,
            getReadRoot,
        } = context;

        function dispose() {
            try {
                state.slideRuntimeDisposer?.();
            } catch (error) {
                console.error('[Scriptorium] Runtime cleanup failed:', error);
            }
            state.slideRuntimeDisposer = null;
            state.slideRuntimeIdentity = null;
        }

        function createScopedDocument(runtimeRoot) {
            return new Proxy(document, {
                get(target, property) {
                    if (property === 'querySelector') {
                        return (selector) =>
                            runtimeRoot.querySelector(selector) || target.querySelector(selector);
                    }
                    if (property === 'querySelectorAll') {
                        return (selector) => runtimeRoot.querySelectorAll(selector);
                    }
                    if (property === 'getElementById') {
                        return (id) =>
                            runtimeRoot.querySelector(`#${CSS.escape(String(id))}`)
                            || target.getElementById(id);
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        }

        function recordDiagnostics(diagnostics = []) {
            state.programmableContentDiagnostics = diagnostics.map((item) => ({
                ...item,
                createdAt: Date.now(),
            }));
            diagnostics.forEach((item) => {
                const log = item.level === 'refuse' ? console.error : console.warn;
                log('[Scriptorium Programmable Content]', item);
            });
        }

        function reviewScript(source, reviewContext = {}) {
            const policy = window.ScriptoriumProgrammableContent;
            if (!policy) {
                return {
                    allowed: false,
                    level: 'refuse',
                    findings: [{
                        level: 'refuse',
                        ruleId: 'review-engine-unavailable',
                        message: '可编程内容审查器未加载，拒绝执行脚本。',
                    }],
                    context: reviewContext,
                };
            }
            return policy.reviewJavaScript(source, reviewContext);
        }

        function diagnosticsFromReview(review, extra = {}) {
            return review.findings.map((finding) => ({
                ...finding,
                ...extra,
                context: review.context,
            }));
        }

        function createTrackedLifecycle() {
            const animationFrames = new Set();
            const timeouts = new Set();
            const intervals = new Set();
            const cleanups = [];
            let disposed = false;

            const requestAnimationFrame = (callback) => {
                if (disposed) return 0;
                const id = window.requestAnimationFrame((timestamp) => {
                    animationFrames.delete(id);
                    if (!disposed) callback(timestamp);
                });
                animationFrames.add(id);
                return id;
            };
            const cancelAnimationFrame = (id) => {
                animationFrames.delete(id);
                window.cancelAnimationFrame(id);
            };
            const setTimeout = (callback, wait, ...args) => {
                if (disposed) return 0;
                const id = window.setTimeout(() => {
                    timeouts.delete(id);
                    if (!disposed) callback(...args);
                }, wait);
                timeouts.add(id);
                return id;
            };
            const clearTimeout = (id) => {
                timeouts.delete(id);
                window.clearTimeout(id);
            };
            const setInterval = (callback, wait, ...args) => {
                if (disposed) return 0;
                const id = window.setInterval(() => {
                    if (!disposed) callback(...args);
                }, wait);
                intervals.add(id);
                return id;
            };
            const clearInterval = (id) => {
                intervals.delete(id);
                window.clearInterval(id);
            };
            const addCleanup = (callback) => {
                if (typeof callback === 'function') cleanups.push(callback);
                return callback;
            };
            const disposeLifecycle = (label = 'custom') => {
                if (disposed) return;
                disposed = true;
                animationFrames.forEach((id) => window.cancelAnimationFrame(id));
                timeouts.forEach((id) => window.clearTimeout(id));
                intervals.forEach((id) => window.clearInterval(id));
                animationFrames.clear();
                timeouts.clear();
                intervals.clear();
                [...cleanups].reverse().forEach((cleanup) => {
                    try {
                        cleanup();
                    } catch (error) {
                        console.error(`[Scriptorium] ${label} cleanup failed:`, error);
                    }
                });
            };

            return Object.freeze({
                addCleanup,
                requestAnimationFrame,
                cancelAnimationFrame,
                setTimeout,
                clearTimeout,
                setInterval,
                clearInterval,
                dispose: disposeLifecycle,
            });
        }

        function executeReviewedScript({
            source,
            root,
            surface,
            scriptId,
            documentKind,
            deck = null,
            diagnostics,
            lifecycle,
        }) {
            const review = reviewScript(source, {
                documentKind,
                surface,
                scriptId,
            });
            diagnostics.push(...diagnosticsFromReview(review, {
                scriptId,
                documentKind,
                surface,
            }));
            if (!review.allowed) return { allowed: false, review };

            const runtime = Object.freeze({
                surface,
                root,
                scriptId,
                slideId: documentKind === 'pptx' ? scriptId : undefined,
                addCleanup: lifecycle.addCleanup,
                requestAnimationFrame: lifecycle.requestAnimationFrame,
                cancelAnimationFrame: lifecycle.cancelAnimationFrame,
                setTimeout: lifecycle.setTimeout,
                clearTimeout: lifecycle.clearTimeout,
                setInterval: lifecycle.setInterval,
                clearInterval: lifecycle.clearInterval,
            });

            try {
                const argumentNames = documentKind === 'pptx'
                    ? ['scene', 'deck', 'runtime', 'document']
                    : ['scene', 'runtime', 'document'];
                const execute = new Function(
                    ...argumentNames,
                    'requestAnimationFrame',
                    'cancelAnimationFrame',
                    'setTimeout',
                    'clearTimeout',
                    'setInterval',
                    'clearInterval',
                    String(source || '')
                );
                const baseArguments = documentKind === 'pptx'
                    ? [root, deck, runtime, createScopedDocument(root)]
                    : [root, runtime, createScopedDocument(root)];
                const returned = execute.call(
                    root,
                    ...baseArguments,
                    lifecycle.requestAnimationFrame,
                    lifecycle.cancelAnimationFrame,
                    lifecycle.setTimeout,
                    lifecycle.clearTimeout,
                    lifecycle.setInterval,
                    lifecycle.clearInterval
                );
                if (typeof returned === 'function') lifecycle.addCleanup(returned);
                else if (returned && typeof returned.dispose === 'function') {
                    lifecycle.addCleanup(() => returned.dispose());
                }
            } catch (error) {
                diagnostics.push({
                    level: 'refuse',
                    ruleId: 'runtime-execution-error',
                    message: `脚本执行失败：${error.message}`,
                    scriptId,
                    documentKind,
                    surface,
                });
                console.error(`[Scriptorium] Runtime ${scriptId} failed:`, error);
            }
            return { allowed: true, review, runtime };
        }

        function clearBindingMarkers(root) {
            root.removeAttribute?.('data-bound');
            root.querySelectorAll?.('[data-bound]').forEach((node) =>
                node.removeAttribute('data-bound')
            );
        }

        function runSlide(slide, runtimeRoot, surface = 'edit') {
            const runtimeSlide = parsedSlide(slide);
            if (!runtimeSlide.script || !runtimeRoot?.isConnected) {
                dispose();
                return null;
            }

            const identity = {
                slideId: slide.id,
                surface,
                root: runtimeRoot,
            };
            const current = state.slideRuntimeIdentity;
            if (
                current
                && current.slideId === identity.slideId
                && current.surface === identity.surface
                && current.root === identity.root
                && runtimeRoot.isConnected
            ) {
                return current.runtime || null;
            }

            dispose();
            clearBindingMarkers(runtimeRoot);

            const lifecycle = createTrackedLifecycle();
            const observer = new MutationObserver((records) => {
                records.forEach((record) => {
                    record.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            node.setAttribute('data-vdoc-runtime-generated', 'true');
                        }
                    });
                });
            });
            observer.observe(runtimeRoot, { childList: true, subtree: true });
            lifecycle.addCleanup(() => observer.disconnect());

            const diagnostics = [];
            const result = executeReviewedScript({
                source: runtimeSlide.script,
                root: runtimeRoot,
                surface,
                scriptId: slide.id,
                documentKind: 'pptx',
                deck: window.VCPDeck || null,
                diagnostics,
                lifecycle,
            });
            recordDiagnostics(diagnostics);
            if (!result.allowed) {
                runtimeRoot.dataset.vdocScriptRefused = 'true';
                lifecycle.dispose('slide runtime');
                return null;
            }

            runtimeRoot.removeAttribute('data-vdoc-script-refused');
            state.slideRuntimeDisposer = () => lifecycle.dispose('slide runtime');
            state.slideRuntimeIdentity = {
                ...identity,
                runtime: result.runtime,
            };
            return result.runtime;
        }

        function dependencyDiagnostic(scriptElement, scriptId, surface) {
            const policy = window.ScriptoriumProgrammableContent;
            const dependency = policy?.dependencyForUrl(
                scriptElement.getAttribute('src')
            ) || {
                action: 'ignore',
                level: 'refuse',
                message: '依赖审查器不可用，外部脚本已拒绝。',
            };
            scriptElement.dataset.vdocDependencyAction = dependency.action;
            if (dependency.library) {
                scriptElement.dataset.vdocLocalLibrary = dependency.library;
            }
            return {
                level: dependency.level === 'warn' || dependency.level === 'refuse'
                    ? dependency.level
                    : 'info',
                ruleId: dependency.code || (
                    dependency.library ? 'local-library-redirect' : 'external-script'
                ),
                message: dependency.message,
                scriptId,
                library: dependency.library,
                source: dependency.source,
                localUrl: dependency.localUrl,
                documentKind: 'docx',
                surface,
            };
        }

        function runDocument(runtimeRoot, surface = 'edit') {
            dispose();
            if (!runtimeRoot?.isConnected) return null;

            const scriptElements = [...runtimeRoot.querySelectorAll('script')];
            if (!scriptElements.length) {
                recordDiagnostics([]);
                return null;
            }

            const lifecycle = createTrackedLifecycle();
            const diagnostics = [];

            scriptElements.forEach((scriptElement, index) => {
                const scriptId = scriptElement.id
                    || scriptElement.dataset.vdocScript
                    || `document-island-${index + 1}`;
                const island = scriptElement.closest(
                    '[data-vdoc-interactive], [data-vdoc-component], section, article, figure, div'
                ) || runtimeRoot;

                if (scriptElement.dataset.vdocLibrary) {
                    diagnostics.push({
                        level: 'info',
                        ruleId: 'local-library',
                        message: `${scriptElement.dataset.vdocLibrary} 使用 Scriptorium 内置本地依赖。`,
                        scriptId,
                        library: scriptElement.dataset.vdocLibrary,
                        documentKind: 'docx',
                        surface,
                    });
                    return;
                }

                if (
                    scriptElement.dataset.vdocIgnoredSrc
                    || scriptElement.type === 'application/x-vdoc-ignored-external'
                ) {
                    diagnostics.push({
                        level: 'warn',
                        ruleId: 'external-script-ignored',
                        message: `未允许的外部脚本保持忽略：${
                            scriptElement.dataset.vdocIgnoredSrc || '未知来源'
                        }`,
                        scriptId,
                        source: scriptElement.dataset.vdocIgnoredSrc || '',
                        documentKind: 'docx',
                        surface,
                    });
                    return;
                }

                if (scriptElement.src || scriptElement.getAttribute('src')) {
                    diagnostics.push(dependencyDiagnostic(scriptElement, scriptId, surface));
                    return;
                }

                clearBindingMarkers(island);
                const result = executeReviewedScript({
                    source: scriptElement.textContent || '',
                    root: island,
                    surface,
                    scriptId,
                    documentKind: 'docx',
                    diagnostics,
                    lifecycle,
                });
                scriptElement.dataset.vdocReviewLevel = result.review.level;
                if (!result.allowed) {
                    island.dataset.vdocScriptRefused = 'true';
                } else {
                    island.removeAttribute('data-vdoc-script-refused');
                }
            });

            recordDiagnostics(diagnostics);
            state.slideRuntimeDisposer = () => lifecycle.dispose('document island');
            state.slideRuntimeIdentity = {
                slideId: state.document?.manifest?.id || 'document',
                surface,
                root: runtimeRoot,
                runtime: { diagnostics },
            };
            return { diagnostics };
        }

        function activate(surface = state.mode) {
            if (isSlideDeck()) {
                activateCurrentSlide(surface);
                return;
            }
            const root = surface === 'read' ? getReadRoot() : getRenderRoot();
            const runtimeRoot = surface === 'read'
                ? root?.querySelector('.vdoc-paged-runtime')
                : root?.querySelector('.vdoc-flow-runtime');
            if (runtimeRoot) runDocument(runtimeRoot, surface);
            else dispose();
        }

        function activateCurrentSlide(surface = state.mode) {
            if (!isSlideDeck()) {
                dispose();
                return;
            }
            const slide = activeSlide();
            const root = surface === 'read' ? getReadRoot() : getRenderRoot();
            const runtimeRoot = surface === 'read'
                ? root?.querySelector(
                    `[data-vdoc-slide-id="${CSS.escape(slide?.id || '')}"]`
                ) || root?.querySelectorAll('.vdoc-page')?.[state.activeSlideIndex]
                : root?.querySelector('.vdoc-slide-editor-runtime');
            if (!runtimeRoot) {
                dispose();
                return;
            }
            runSlide(slide, runtimeRoot, surface);
        }

        return Object.freeze({
            activate,
            activateCurrentSlide,
            dispose,
            recordDiagnostics,
            runDocument,
            runSlide,
        });
    }

    window.ScriptoriumRuntime = Object.freeze({
        createRuntimeController,
    });
})();