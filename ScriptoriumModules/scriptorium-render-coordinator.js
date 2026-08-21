'use strict';

(() => {
    function createRenderCoordinator(context = {}) {
        const documentPort = context.documentPort;
        if (!documentPort) {
            throw new TypeError('Render coordinator requires DocumentPort.');
        }

        const state = {
            adapter: null,
            mode: 'edit',
            zoom: 100,
            editSurface: null,
            readSurface: null,
            editRevision: -1,
            readRevision: -1,
            editDocumentId: null,
            readDocumentId: null,
            invalidationRevision: 0,
            disposed: false,
        };

        const disposers = [];

        function assertActive() {
            if (state.disposed) {
                throw new Error('Render coordinator has been disposed.');
            }
        }

        function currentAdapter() {
            assertActive();
            if (!state.adapter) throw new Error('No document adapter is active.');
            return state.adapter;
        }

        function setAdapter(adapter) {
            assertActive();
            if (!adapter
                || typeof adapter.renderEditSurface !== 'function'
                || typeof adapter.renderReadSurface !== 'function') {
                throw new TypeError('Render coordinator requires a document adapter.');
            }
            if (state.adapter === adapter) return adapter;
            disposeSurfaces();
            state.adapter?.disposeSurface?.();
            state.adapter = adapter;
            invalidate('adapter-changed');
            context.onAdapterChange?.(adapter);
            return adapter;
        }

        function setMode(mode) {
            assertActive();
            if (!['edit', 'read', 'source-html', 'source-css'].includes(mode)) {
                throw new TypeError(`Unsupported surface mode: ${mode}`);
            }
            state.mode = mode;
            return mode;
        }

        function setZoom(value) {
            assertActive();
            state.zoom = Math.max(50, Math.min(200, Number(value) || 100));
            const editRoot = state.editSurface?.root;
            const readRoot = state.readSurface?.root;
            context.primitives?.updateZoomLayout?.(editRoot, state.zoom);
            context.primitives?.updateZoomLayout?.(readRoot, state.zoom);
            context.onZoomChange?.(state.zoom);
            return state.zoom;
        }

        function cacheMatches(surface) {
            const status = documentPort.status();
            if (surface === 'edit') {
                return state.editSurface
                    && state.editRevision === status.revision
                    && state.editDocumentId === status.documentId;
            }
            return state.readSurface
                && state.readRevision === status.revision
                && state.readDocumentId === status.documentId;
        }

        function renderEdit(options = {}) {
            const adapter = currentAdapter();
            const target = options.target || context.editHost;
            if (!target) throw new Error('Edit surface host is unavailable.');

            // 渲染态输入会话拥有当前 contenteditable DOM 的所有权。
            // IME 组合期间禁止销毁该 DOM；只保留最后一次渲染请求，待
            // 编辑器完成“渲染态缓冲 -> 源码”对齐后再执行。
            if (context.editorPort?.inputPending?.()) {
                context.editorPort.deferRender?.(() =>
                    renderEdit(options)
                );
                return state.editSurface;
            }

            if (!options.force && cacheMatches('edit')) {
                activateRuntime('edit');
                return state.editSurface;
            }

            const scrollHost =
                options.scrollHost || context.editScrollHost;
            const preservedScroll = options.preserveScroll === false
                ? null
                : {
                    left: Number(scrollHost?.scrollLeft) || 0,
                    top: Number(scrollHost?.scrollTop) || 0,
                };
            state.editSurface?.dispose?.();
            state.editSurface = adapter.renderEditSurface(target, {
                ...options,
                zoom: state.zoom,
                scrollHost,
            });
            const renderedSurface = state.editSurface;
            const status = documentPort.status();
            state.editRevision = status.revision;
            state.editDocumentId = status.documentId;
            state.mode = 'edit';

            // 首次脚本激活必须发生在 coordinator 已正式接管 surface 之后。
            // renderer 内部的下一帧仍作为布局完成后的幂等兜底，但动画岛
            // 不再依赖一个可能在 surface 交接期间被取消的悬空 RAF 才能启动。
            context.runtimePort?.activate?.({
                kind: adapter.kind,
                surface: 'edit',
                root: state.editSurface.root,
                adapter,
                scrollHost,
            });
            context.onRendered?.({
                surface: 'edit',
                adapter,
                result: state.editSurface,
            });
            if (preservedScroll && scrollHost) {
                window.requestAnimationFrame(() => {
                    if (state.disposed
                        || state.editSurface !== renderedSurface) {
                        return;
                    }
                    scrollHost.scrollTo?.({
                        left: preservedScroll.left,
                        top: preservedScroll.top,
                        behavior: 'auto',
                    });
                });
            }
            return state.editSurface;
        }

        function renderRead(options = {}) {
            const adapter = currentAdapter();
            const target = options.target || context.readHost;
            if (!target) throw new Error('Read surface host is unavailable.');
            if (!options.force && cacheMatches('read')) {
                activateRuntime('read');
                return state.readSurface;
            }

            state.readSurface?.dispose?.();
            const scrollHost =
                options.scrollHost || context.readScrollHost;
            state.readSurface = adapter.renderReadSurface(target, {
                ...options,
                zoom: state.zoom,
                scrollHost,
            });
            const status = documentPort.status();
            state.readRevision = status.revision;
            state.readDocumentId = status.documentId;
            state.mode = 'read';
            context.runtimePort?.activate?.({
                kind: adapter.kind,
                surface: 'read',
                root: state.readSurface.root,
                adapter,
                scrollHost,
            });
            context.onRendered?.({
                surface: 'read',
                adapter,
                result: state.readSurface,
            });
            return state.readSurface;
        }

        function renderCurrent(options = {}) {
            return state.mode === 'read'
                ? renderRead(options)
                : renderEdit(options);
        }

        function activateRuntime(surface = state.mode) {
            const normalized = surface === 'read' ? 'read' : 'edit';
            const rendered = normalized === 'read'
                ? state.readSurface
                : state.editSurface;
            if (!rendered?.root) return false;
            context.runtimePort?.activate?.({
                kind: currentAdapter().kind,
                surface: normalized,
                root: rendered.root,
                adapter: currentAdapter(),
            });
            return true;
        }

        function invalidate(reason = 'manual') {
            assertActive();
            state.invalidationRevision += 1;
            state.editRevision = -1;
            state.readRevision = -1;
            state.editDocumentId = null;
            state.readDocumentId = null;
            context.onInvalidate?.({
                reason,
                invalidationRevision: state.invalidationRevision,
            });
        }

        function disposeSurface(surface) {
            if (surface === 'edit') {
                state.editSurface?.dispose?.();
                state.editSurface = null;
                state.editRevision = -1;
                state.editDocumentId = null;
                return;
            }
            if (surface === 'read') {
                state.readSurface?.dispose?.();
                state.readSurface = null;
                state.readRevision = -1;
                state.readDocumentId = null;
            }
        }

        function disposeSurfaces() {
            // Surface 重建、文档替换与 adapter 切换都只是运行时会话边界，
            // 不能永久销毁由应用级组合根持有的 RuntimeController。
            // 各 renderer surface 的 dispose() 会释放对应运行时；这里再显式
            // 清理一次可覆盖 surface 尚未完整建立或已提前丢失的情况。
            disposeSurface('edit');
            disposeSurface('read');
            context.runtimePort?.disposeSurface?.('edit');
            context.runtimePort?.disposeSurface?.('read');
        }

        function status() {
            return Object.freeze({
                adapterKind: state.adapter?.kind || null,
                mode: state.mode,
                zoom: state.zoom,
                editRevision: state.editRevision,
                readRevision: state.readRevision,
                invalidationRevision: state.invalidationRevision,
            });
        }

        if (typeof documentPort.subscribe === 'function') {
            disposers.push(documentPort.subscribe(
                documentPort.EVENTS?.DOCUMENT_REPLACED || 'document-replaced',
                () => {
                    disposeSurfaces();
                    invalidate('document-replaced');
                }
            ));
            disposers.push(documentPort.subscribe(
                documentPort.EVENTS?.DOCUMENT_MUTATED || 'document-mutated',
                (event) => {
                    if (!event.derived) invalidate('document-mutated');
                }
            ));
        }

        function dispose() {
            if (state.disposed) return;
            disposeSurfaces();
            // 只有 RenderCoordinator 自身退出时，才结束应用级运行时控制器。
            context.runtimePort?.dispose?.();
            state.adapter = null;
            disposers.splice(0).forEach((disposeSubscription) => {
                try {
                    disposeSubscription?.();
                } catch {}
            });
            state.disposed = true;
        }

        return Object.freeze({
            setAdapter,
            currentAdapter,
            setMode,
            setZoom,
            renderEdit,
            renderRead,
            renderCurrent,
            activateRuntime,
            invalidate,
            disposeSurface,
            disposeSurfaces,
            status,
            dispose,
        });
    }

    window.ScriptoriumRenderCoordinator = Object.freeze({
        createRenderCoordinator,
    });
})();