'use strict';

(() => {
    function createEditHistory(context = {}) {
        const documentPort = context.documentPort;
        const core = context.core;
        if (!documentPort || !core) {
            throw new TypeError('Edit history requires DocumentPort and VDocCore.');
        }

        const state = {
            branches: new Map(),
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

        function resolvedBranchKey() {
            const resolved = context.branchKeyResolver?.();
            return String(resolved || 'document:edit');
        }

        function branchFor(key = resolvedBranchKey(), options = {}) {
            const normalizedKey = String(key || 'document:edit');
            let branch = state.branches.get(normalizedKey);
            if (!branch && options.create !== false) {
                branch = {
                    key: normalizedKey,
                    entries: [],
                    index: -1,
                    burstTimer: null,
                    burstDirty: false,
                };
                state.branches.set(normalizedKey, branch);
            }
            return branch || null;
        }

        function notify(reason = 'history-status-changed', key = resolvedBranchKey()) {
            const current = status(key);
            context.onChange?.({ ...current, reason });
            return current;
        }

        function capture(options = {}) {
            assertActive();
            if (state.restoring || !documentPort.document()) return false;
            context.editorPort?.flush?.();
            const key = String(options.branchKey || resolvedBranchKey());
            const branch = branchFor(key);
            const serialized = snapshot();
            if (!serialized || branch.entries[branch.index] === serialized) {
                branch.burstDirty = false;
                notify(options.reason || 'capture-unchanged', key);
                return false;
            }
            branch.entries = branch.entries.slice(0, branch.index + 1);
            branch.entries.push(serialized);
            if (branch.entries.length > state.limit) branch.entries.shift();
            branch.index = branch.entries.length - 1;
            branch.burstDirty = false;
            const detail = {
                branchKey: key,
                index: branch.index,
                length: branch.entries.length,
                reason: options.reason || 'capture',
            };
            context.onCapture?.(detail);
            notify(detail.reason, key);
            return true;
        }

        function schedule(options = {}) {
            assertActive();
            const key = String(options.branchKey || resolvedBranchKey());
            const branch = branchFor(key);
            branch.burstDirty = true;
            window.clearTimeout(branch.burstTimer);
            branch.burstTimer = window.setTimeout(
                () => finalize({ ...options, branchKey: key }),
                Math.max(0, Number(options.delay) || 2000)
            );
            notify(options.reason || 'history-edit-scheduled', key);
            return true;
        }

        function finalize(options = {}) {
            assertActive();
            const key = String(options.branchKey || resolvedBranchKey());
            const branch = branchFor(key, { create: options.force === true });
            if (!branch) return false;
            window.clearTimeout(branch.burstTimer);
            branch.burstTimer = null;
            context.editorPort?.flush?.();
            if (!branch.burstDirty && options.force !== true) {
                notify(options.reason || 'history-finalize-unchanged', key);
                return false;
            }
            const captured = capture({
                branchKey: key,
                reason: options.reason || 'edit-burst-finalized',
            });
            context.onFinalize?.({ branchKey: key, captured });
            return captured;
        }

        function activate(key = resolvedBranchKey(), options = {}) {
            assertActive();
            const normalizedKey = String(key || 'document:edit');
            const branch = branchFor(normalizedKey);
            if (!branch.entries.length
                && options.capture !== false
                && documentPort.document()) {
                capture({
                    branchKey: normalizedKey,
                    reason: options.reason || 'history-branch-activated',
                });
            } else {
                notify(options.reason || 'history-branch-activated', normalizedKey);
            }
            return normalizedKey;
        }

        function restore(offset) {
            assertActive();
            const key = resolvedBranchKey();
            const branch = branchFor(key, { create: false });
            const viewState = context.editorPort?.captureViewState?.() || null;
            finalize({ branchKey: key });
            const nextIndex = (branch?.index ?? -1) + Number(offset);
            if (!branch
                || !Number.isInteger(nextIndex)
                || nextIndex < 0
                || nextIndex >= branch.entries.length) {
                notify('history-restore-unavailable', key);
                return false;
            }
            const serialized = branch.entries[nextIndex];
            const restored = context.restoreSnapshot?.(serialized, key)
                || core.parse(serialized);
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
                branch.index = nextIndex;
                context.adapterResolver?.()?.invalidate?.();
                context.renderPort?.invalidate?.(
                    offset < 0 ? 'history-undo' : 'history-redo'
                );
                context.renderPort?.renderCurrent?.({ force: true });
                context.editorPort?.restoreViewState?.(viewState);
                documentPort.markDirty({
                    reason: offset < 0 ? 'history-undo' : 'history-redo',
                    incrementRevision: false,
                });
                context.onRestore?.({
                    branchKey: key,
                    index: branch.index,
                    offset,
                });
                notify(offset < 0 ? 'history-undo' : 'history-redo', key);
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
            state.branches.forEach((branch) =>
                window.clearTimeout(branch.burstTimer)
            );
            state.branches.clear();
            if (options.capture !== false && documentPort.document()) {
                capture({ reason: 'history-reset' });
            } else {
                notify('history-reset');
            }
        }

        function status(key = resolvedBranchKey()) {
            const normalizedKey = String(key || 'document:edit');
            const branch = branchFor(normalizedKey, { create: false });
            return Object.freeze({
                branchKey: normalizedKey,
                index: branch?.index ?? -1,
                length: branch?.entries.length ?? 0,
                canUndo: (branch?.index ?? -1) > 0
                    || (
                        branch?.burstDirty === true
                        && (branch?.index ?? -1) >= 0
                    ),
                canRedo: branch?.burstDirty !== true
                    && (branch?.index ?? -1) >= 0
                    && branch.index < branch.entries.length - 1,
                burstDirty: branch?.burstDirty === true,
            });
        }

        function dispose() {
            if (state.disposed) return;
            state.branches.forEach((branch) =>
                window.clearTimeout(branch.burstTimer)
            );
            state.branches.clear();
            state.disposed = true;
        }

        return Object.freeze({
            capture,
            schedule,
            finalize,
            activate,
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