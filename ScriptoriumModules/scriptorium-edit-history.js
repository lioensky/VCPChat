'use strict';

(() => {
    function createEditHistory(context = {}) {
        const documentPort = context.documentPort;
        const core = context.core;
        if (!documentPort || !core) {
            throw new TypeError('Edit history requires DocumentPort and VDocCore.');
        }

        const state = {
            entries: [],
            index: -1,
            burstTimer: null,
            burstDirty: false,
            restoring: false,
            limit: Math.max(1, Number(context.limit) || 80),
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) throw new Error('Edit history has been disposed.');
        }

        function snapshot() {
            const model = documentPort.document();
            return model ? core.serialize(model) : '';
        }

        function capture(options = {}) {
            assertActive();
            if (state.restoring || !documentPort.document()) return false;
            context.editorPort?.flush?.();
            const serialized = snapshot();
            if (!serialized || state.entries[state.index] === serialized) {
                state.burstDirty = false;
                return false;
            }
            state.entries = state.entries.slice(0, state.index + 1);
            state.entries.push(serialized);
            if (state.entries.length > state.limit) state.entries.shift();
            state.index = state.entries.length - 1;
            state.burstDirty = false;
            context.onCapture?.({
                index: state.index,
                length: state.entries.length,
                reason: options.reason || 'capture',
            });
            return true;
        }

        function schedule(options = {}) {
            assertActive();
            state.burstDirty = true;
            window.clearTimeout(state.burstTimer);
            state.burstTimer = window.setTimeout(
                () => finalize(options),
                Math.max(0, Number(options.delay) || 2000)
            );
            return true;
        }

        function finalize(options = {}) {
            assertActive();
            window.clearTimeout(state.burstTimer);
            state.burstTimer = null;
            context.editorPort?.flush?.();
            if (!state.burstDirty && options.force !== true) return false;
            const captured = capture({
                reason: options.reason || 'edit-burst-finalized',
            });
            context.onFinalize?.({ captured });
            return captured;
        }

        function restore(offset) {
            assertActive();
            finalize();
            const nextIndex = state.index + Number(offset);
            if (!Number.isInteger(nextIndex)
                || nextIndex < 0
                || nextIndex >= state.entries.length) {
                return false;
            }
            const restored = core.parse(state.entries[nextIndex]);
            const currentStatus = documentPort.status();
            state.restoring = true;
            try {
                documentPort.replaceDocument(restored, {
                    filePath: currentStatus.currentPath,
                    name: currentStatus.currentName,
                    resourceData: documentPort.resourceData(),
                    dirty: true,
                    reason: offset < 0 ? 'history-undo' : 'history-redo',
                    previousDocumentId: currentStatus.documentId,
                });
                state.index = nextIndex;
                context.adapterResolver?.()?.invalidate?.();
                context.renderPort?.invalidate?.(
                    offset < 0 ? 'history-undo' : 'history-redo'
                );
                context.renderPort?.renderCurrent?.({ force: true });
                documentPort.markDirty({
                    reason: offset < 0 ? 'history-undo' : 'history-redo',
                    incrementRevision: false,
                });
                context.onRestore?.({
                    index: state.index,
                    offset,
                });
                return true;
            } finally {
                state.restoring = false;
            }
        }

        function execute(command) {
            if (command === 'undo') return restore(-1);
            if (command === 'redo') return restore(1);
            return false;
        }

        function reset(options = {}) {
            assertActive();
            window.clearTimeout(state.burstTimer);
            state.burstTimer = null;
            state.entries = [];
            state.index = -1;
            state.burstDirty = false;
            if (options.capture !== false && documentPort.document()) {
                capture({ reason: 'history-reset' });
            }
        }

        function status() {
            return Object.freeze({
                index: state.index,
                length: state.entries.length,
                canUndo: state.index > 0,
                canRedo: state.index >= 0
                    && state.index < state.entries.length - 1,
                burstDirty: state.burstDirty,
            });
        }

        function dispose() {
            if (state.disposed) return;
            window.clearTimeout(state.burstTimer);
            state.burstTimer = null;
            state.entries = [];
            state.index = -1;
            state.disposed = true;
        }

        return Object.freeze({
            capture,
            schedule,
            finalize,
            restore,
            execute,
            reset,
            status,
            dispose,
        });
    }

    window.ScriptoriumEditHistory = Object.freeze({
        createEditHistory,
    });
})();