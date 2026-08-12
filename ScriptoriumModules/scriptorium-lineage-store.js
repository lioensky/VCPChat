'use strict';

(() => {
    function createLineageStore(context = {}) {
        const documentPort = context.documentPort;
        const core = context.core;
        if (!documentPort || !core) {
            throw new TypeError('Lineage store requires DocumentPort and VDocCore.');
        }

        let records = [];
        let disposed = false;
        const listeners = new Set();

        function emit(type, detail = {}) {
            const event = Object.freeze({
                type,
                records: [...records],
                ...detail,
            });
            listeners.forEach((listener) => {
                try {
                    listener(event);
                } catch (error) {
                    console.error('[ScriptoriumLineageStore] listener failed:', error);
                }
            });
        }

        function subscribe(listener) {
            if (typeof listener !== 'function') {
                throw new TypeError('Lineage listener must be a function.');
            }
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        function load(documentModel = documentPort.document()) {
            records = Array.isArray(documentModel?.checkpoints)
                ? [...documentModel.checkpoints]
                : [];
            emit('loaded');
            return list();
        }

        function list(options = {}) {
            const status = String(options.status || '').trim();
            return Object.freeze(records
                .filter((record) => !status || record.status === status)
                .slice(0, Math.max(1, Number(options.limit) || records.length)));
        }

        function byId(id) {
            return records.find((record) => record.id === id) || null;
        }

        function snapshot(documentModel = documentPort.document()) {
            if (!documentModel) return '';
            const normalized = JSON.parse(core.serialize(documentModel));
            normalized.checkpoints = (normalized.checkpoints || []).map(
                (checkpoint) => {
                    const { snapshot: ignored, ...record } = checkpoint || {};
                    return record;
                }
            );
            return JSON.stringify(normalized, null, 2);
        }

        function sourceState(adapter, documentModel = documentPort.document()) {
            return adapter.sourceState(documentModel);
        }

        function syncDocument() {
            documentPort.updateDerived((model) => {
                model.checkpoints = records;
            }, { reason: 'lineage-synchronized' });
        }

        function add(record = {}, options = {}) {
            const normalized = {
                id: String(record.id || `lineage-${crypto.randomUUID()}`),
                source: record.source === 'agent' ? 'agent' : 'human',
                author: record.author || null,
                name: String(record.name || '未命名刻点'),
                summary: String(record.summary || ''),
                note: String(record.note || ''),
                createdAt: Number(record.createdAt) || Date.now(),
                baseRevision: record.baseRevision ?? null,
                revision: record.revision
                    ?? documentPort.status().revision,
                operation: record.operation || null,
                proposal: record.proposal || null,
                changeSet: record.changeSet || null,
                status: record.status || 'applied',
                receipt: record.receipt || null,
                snapshot: record.snapshot
                    ?? (options.snapshot === false ? '' : snapshot()),
            };
            if (options.prepend === false) records.push(normalized);
            else records.unshift(normalized);
            syncDocument();
            emit('record-added', { record: normalized });
            return normalized;
        }

        function createCheckpoint(input = {}, adapter) {
            const after = sourceState(adapter);
            return add({
                source: 'human',
                author: input.author || {
                    id: 'human',
                    name: '人类审阅者',
                    type: 'human',
                },
                name: input.name,
                summary: input.summary || input.note || '',
                note: input.note || '',
                operation: { type: 'checkpoint-state' },
                changeSet: {
                    type: 'checkpoint-state',
                    before: null,
                    after,
                },
                status: 'applied',
            });
        }

        function update(id, patch = {}) {
            const record = byId(id);
            if (!record) return null;
            Object.assign(record, patch);
            syncDocument();
            emit('record-updated', { record });
            return record;
        }

        function restore(id, adapter) {
            const target = byId(id);
            if (!target?.snapshot || target.status === 'pending') return false;
            const currentStatus = documentPort.status();
            const before = sourceState(adapter);
            const backup = add({
                source: 'human',
                name: `回溯前备份 · ${currentStatus.currentName}`,
                summary: `回溯到“${target.name || target.id}”前自动保存。`,
                operation: {
                    type: 'version-backup-before-restore',
                    targetCheckpointId: target.id,
                },
                changeSet: {
                    type: 'version-backup-before-restore',
                    before: null,
                    after: before,
                },
                status: 'applied',
            });
            const restored = core.parse(target.snapshot);
            documentPort.replaceDocument(restored, {
                filePath: currentStatus.currentPath,
                name: currentStatus.currentName,
                resourceData: documentPort.resourceData(),
                dirty: true,
                reason: 'lineage-restore',
                previousDocumentId: currentStatus.documentId,
            });
            records = [backup, ...records.filter((record) =>
                record.id !== backup.id
            )];
            const after = sourceState(adapter, restored);
            add({
                source: 'human',
                name: `已回溯 · ${target.name || target.id}`,
                summary: '基于工程内嵌版本快照恢复文档。',
                operation: {
                    type: 'version-restore',
                    targetCheckpointId: target.id,
                },
                changeSet: {
                    type: 'version-restore',
                    before,
                    after,
                },
                status: 'applied',
            });
            syncDocument();
            emit('restored', { target });
            return true;
        }

        function dispose() {
            if (disposed) return;
            listeners.clear();
            records = [];
            disposed = true;
        }

        return Object.freeze({
            subscribe,
            load,
            list,
            byId,
            snapshot,
            sourceState,
            add,
            createCheckpoint,
            update,
            restore,
            dispose,
        });
    }

    window.ScriptoriumLineageStore = Object.freeze({
        createLineageStore,
    });
})();