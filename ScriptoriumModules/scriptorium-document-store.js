'use strict';

(() => {
    const EVENTS = Object.freeze({
        DOCUMENT_REPLACED: 'document-replaced',
        DOCUMENT_MUTATED: 'document-mutated',
        STATUS_CHANGED: 'status-changed',
        SAVED: 'saved',
        DISPOSED: 'disposed',
    });

    function createDocumentStore(options = {}) {
        const core = options.core;
        const containerModule = options.containerModule;
        const settingsPort = options.settingsPort || {};
        if (!core) throw new TypeError('Document store requires VDocCore.');

        const listeners = new Map();
        const state = {
            document: null,
            currentPath: null,
            currentName: '未命名文稿.vdocx',
            dirty: false,
            ready: false,
            saving: false,
            loading: false,
            revision: 0,
            generation: 0,
            resourceData: new Map(),
            resourceObjectUrls: new Map(),
            resourceResolver: null,
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) throw new Error('Document store has been disposed.');
        }

        function emit(type, detail = {}) {
            const event = Object.freeze({
                type,
                document: state.document,
                documentId: state.document?.manifest?.id || null,
                revision: state.revision,
                generation: state.generation,
                ...detail,
            });
            [...(listeners.get(type) || [])].forEach((listener) => {
                try {
                    listener(event);
                } catch (error) {
                    console.error(`[ScriptoriumDocumentStore] ${type} listener failed:`, error);
                }
            });
            [...(listeners.get('*') || [])].forEach((listener) => {
                try {
                    listener(event);
                } catch (error) {
                    console.error('[ScriptoriumDocumentStore] wildcard listener failed:', error);
                }
            });
            return event;
        }

        function subscribe(type, listener) {
            assertActive();
            if (typeof listener !== 'function') {
                throw new TypeError('Document store listener must be a function.');
            }
            const key = String(type || '*');
            const bucket = listeners.get(key) || new Set();
            bucket.add(listener);
            listeners.set(key, bucket);
            return () => {
                bucket.delete(listener);
                if (!bucket.size) listeners.delete(key);
            };
        }

        function status() {
            return Object.freeze({
                documentId: state.document?.manifest?.id || null,
                currentPath: state.currentPath,
                currentName: state.currentName,
                dirty: state.dirty,
                ready: state.ready,
                saving: state.saving,
                loading: state.loading,
                revision: state.revision,
                generation: state.generation,
            });
        }

        function documentModel() {
            return state.document;
        }

        function resourceData() {
            return state.resourceData;
        }

        function resourceResolver() {
            return state.resourceResolver;
        }

        function defaultNameFor(documentModel) {
            const extension = core.extensionForKind(documentModel.manifest.scene.kind);
            const fallback = documentModel.manifest.scene.kind === core.PROJECT_KINDS.SLIDE_DECK
                ? '未命名演示'
                : '未命名文稿';
            const supplied = String(documentModel.manifest.title || fallback);
            return supplied.toLowerCase().endsWith(extension)
                ? supplied
                : `${supplied.replace(/\.[^.]+$/, '')}${extension}`;
        }

        function revokeResources() {
            try {
                state.resourceResolver?.revoke?.();
            } catch (error) {
                console.warn('[ScriptoriumDocumentStore] Resource revocation failed:', error);
            }
            state.resourceResolver = null;
            state.resourceObjectUrls = new Map();
        }

        function replaceDocument(documentModel, metadata = {}) {
            assertActive();
            const normalized = core.normalizeDocument(documentModel);
            revokeResources();
            state.generation += 1;
            state.document = normalized;
            state.currentPath = metadata.filePath || null;
            state.currentName = String(metadata.name || defaultNameFor(normalized));
            const extension = core.extensionForKind(normalized.manifest.scene.kind);
            if (!state.currentName.toLowerCase().endsWith(extension)) {
                state.currentName = `${
                    state.currentName.replace(/\.[^.]+$/, '')
                }${extension}`;
            }
            state.resourceData = metadata.resourceData instanceof Map
                ? metadata.resourceData
                : new Map();
            state.resourceResolver = containerModule?.createRuntimeResolver?.(
                normalized,
                state.resourceData,
                state.resourceObjectUrls,
                {
                    trustNetworkFonts: () =>
                        settingsPort.get?.('trustNetworkFonts') === true,
                }
            ) || null;
            state.dirty = metadata.dirty === true;
            state.ready = true;
            state.saving = false;
            state.loading = false;
            state.revision = 0;
            emit(EVENTS.DOCUMENT_REPLACED, {
                previousDocumentId: metadata.previousDocumentId || null,
                reason: metadata.reason || 'replace',
            });
            emit(EVENTS.STATUS_CHANGED, { reason: 'document-replaced' });
            return normalized;
        }

        function mutate(mutator, options = {}) {
            assertActive();
            if (!state.document || typeof mutator !== 'function') return false;
            const beforeRevision = state.revision;
            const result = mutator(state.document);
            if (result === false) return false;
            state.document.manifest.modifiedAt = new Date().toISOString();
            state.revision += 1;
            state.dirty = options.dirty !== false;
            emit(EVENTS.DOCUMENT_MUTATED, {
                reason: options.reason || 'mutation',
                beforeRevision,
                result,
            });
            emit(EVENTS.STATUS_CHANGED, {
                reason: options.reason || 'mutation',
            });
            return result === undefined ? true : result;
        }

        function updateDerived(mutator, options = {}) {
            assertActive();
            if (!state.document || typeof mutator !== 'function') return false;
            const result = mutator(state.document);
            if (result === false) return false;
            emit(EVENTS.DOCUMENT_MUTATED, {
                reason: options.reason || 'derived-state',
                beforeRevision: state.revision,
                derived: true,
                result,
            });
            return result === undefined ? true : result;
        }

        function markDirty(options = {}) {
            assertActive();
            if (!state.ready || state.loading || !state.document) return false;
            const beforeRevision = state.revision;
            if (options.incrementRevision !== false) state.revision += 1;
            state.dirty = true;
            emit(EVENTS.DOCUMENT_MUTATED, {
                reason: options.reason || 'dirty',
                beforeRevision,
                metadataOnly: options.metadataOnly === true,
            });
            emit(EVENTS.STATUS_CHANGED, { reason: options.reason || 'dirty' });
            return true;
        }

        function markSaved(metadata = {}) {
            assertActive();
            if (metadata.filePath !== undefined) state.currentPath = metadata.filePath;
            if (metadata.name !== undefined) state.currentName = String(metadata.name);
            const savedRevision = metadata.revision;
            if (savedRevision === undefined || savedRevision === state.revision) {
                state.dirty = false;
            }
            emit(EVENTS.SAVED, {
                savedRevision: savedRevision ?? state.revision,
                dirtyAfterSave: state.dirty,
            });
            emit(EVENTS.STATUS_CHANGED, { reason: 'saved' });
            return !state.dirty;
        }

        function setActivity(patch = {}) {
            assertActive();
            if (patch.loading !== undefined) state.loading = patch.loading === true;
            if (patch.saving !== undefined) state.saving = patch.saving === true;
            if (patch.ready !== undefined) state.ready = patch.ready === true;
            emit(EVENTS.STATUS_CHANGED, { reason: patch.reason || 'activity' });
            return status();
        }

        function updateIdentity(metadata = {}) {
            assertActive();
            if (metadata.filePath !== undefined) state.currentPath = metadata.filePath;
            if (metadata.name !== undefined) state.currentName = String(metadata.name);
            emit(EVENTS.STATUS_CHANGED, { reason: metadata.reason || 'identity' });
            return status();
        }

        function serialize() {
            assertActive();
            return state.document ? core.serialize(state.document) : '';
        }

        function captureContext(extra = {}) {
            assertActive();
            return Object.freeze({
                generation: state.generation,
                documentId: state.document?.manifest?.id || null,
                revision: state.revision,
                ...extra,
            });
        }

        function isContextCurrent(context, checks = {}) {
            if (!context || state.disposed) return false;
            if (context.generation !== state.generation) return false;
            if (checks.document !== false
                && context.documentId !== (state.document?.manifest?.id || null)) {
                return false;
            }
            if (checks.revision === true && context.revision !== state.revision) {
                return false;
            }
            return true;
        }

        function dispose() {
            if (state.disposed) return;
            revokeResources();
            state.disposed = true;
            emit(EVENTS.DISPOSED);
            listeners.clear();
            state.document = null;
            state.resourceData.clear();
        }

        return Object.freeze({
            EVENTS,
            subscribe,
            status,
            document: documentModel,
            resourceData,
            resourceResolver,
            replaceDocument,
            mutate,
            updateDerived,
            markDirty,
            markSaved,
            setActivity,
            updateIdentity,
            serialize,
            captureContext,
            isContextCurrent,
            dispose,
        });
    }

    window.ScriptoriumDocumentStore = Object.freeze({
        EVENTS,
        createDocumentStore,
    });
})();