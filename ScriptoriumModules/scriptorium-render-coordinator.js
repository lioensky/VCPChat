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
            if (!options.force && cacheMatches('edit')) {
                activateRuntime('edit');
                return state.editSurface;
            }

            state.editSurface?.dispose?.();
            state.editSurface = adapter.renderEditSurface(target, {
                ...options,
                zoom: state.zoom,
                scrollHost: options.scrollHost || context.editScrollHost,
            });
            const status = documentPort.status();
            state.editRevision = status.revision;
            state.editDocumentId = status.documentId;
            state.mode = 'edit';
            context.onRendered?.({
                surface: 'edit',
                adapter,
                result: state.editSurface,
            });
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
            state.readSurface = adapter.renderReadSurface(target, {
                ...options,
                zoom: state.zoom,
                scrollHost: options.scrollHost || context.readScrollHost,
            });
            const status = documentPort.status();
            state.readRevision = status.revision;
            state.readDocumentId = status.documentId;
            state.mode = 'read';
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
            disposeSurface('edit');
            disposeSurface('read');
            context.runtimePort?.dispose?.();
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