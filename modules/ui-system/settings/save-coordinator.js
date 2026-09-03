// One asynchronous save owner for a global-settings form. Clients still own
// field-specific adapters, but this coordinator owns result identity,
// aggregate status, and the close-time quiescence barrier.
const coordinators = new WeakMap();
const STATUS_ORDER = Object.freeze(['conflict', 'error', 'saving', 'dirty', 'saved', 'idle']);

function createOperationId() {
    return `settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function patchToOperations(patch, prefix = []) {
    return Object.entries(patch || {}).flatMap(([key, value]) => {
        const path = [...prefix, key];
        return value && typeof value === 'object' && !Array.isArray(value)
            ? patchToOperations(value, path)
            : [{ op: 'set', path, value }];
    });
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const output = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
        output[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? deepMerge(output[key], value)
            : value;
    }
    return output;
}

function applyOperations(base, operations = []) {
    const output = JSON.parse(JSON.stringify(base || {}));
    for (const operation of operations) {
        const path = operation?.path;
        if (!Array.isArray(path) || !path.length) continue;
        let target = output;
        for (const part of path.slice(0, -1)) {
            if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
            target = target[part];
        }
        const leaf = path[path.length - 1];
        if (operation.op === 'unset') delete target[leaf];
        else if (operation.op === 'set') target[leaf] = operation.value;
    }
    return output;
}

function createCoordinator(form) {
    const clients = new Map();
    const operations = new Map();
    let disposed = false;
    let listenerReleased = false;
    let flushBarrier = null;
    let aggregateTimer = null;
    // Durable state is intentionally separate from presentation owners.  The
    // coordinator keeps the last committed base and an immutable local draft
    // so an owner cannot accidentally clear another owner's pending work.
    let durableBase = Object.freeze({});
    let durableRevision = null;
    let draft = Object.freeze({});
    let pendingOps = [];
    let retryableFailure = null;
    let conflict = null;
    const aggregateStatus = () => {
        if (conflict) return 'conflict';
        if (retryableFailure) return 'error';
        const statuses = [...clients.values()].map(client => client.status).filter(Boolean);
        return STATUS_ORDER.find(status => statuses.includes(status)) || 'idle';
    };
    const publishAggregate = () => {
        aggregateTimer = null;
        const status = aggregateStatus();
        if (status === 'idle') delete form.dataset.vcpAutosaveState;
        else form.dataset.vcpAutosaveState = status;
        const dirty = [...clients.values()].some(client => client.dirty || ['dirty', 'saving', 'error', 'conflict'].includes(client.status));
        if (dirty) form.dataset.vcpSettingsDirty = 'true';
        else delete form.dataset.vcpSettingsDirty;
    };
    const snapshot = () => Object.freeze({
        status: aggregateStatus(),
        dirty: form.dataset.vcpSettingsDirty === 'true',
        clients: Object.freeze([...clients.values()].map(client => Object.freeze({ id: client.id, status: client.status, dirty: client.dirty }))),
        durableRevision,
        durableBase,
        draft,
        pendingOps: Object.freeze(pendingOps.map(operation => Object.freeze({ ...operation, path: Object.freeze([...(operation.path || [])]) }))),
        retryableFailure,
        conflict,
    });
    const scheduleAggregate = () => {
        if (aggregateTimer !== null) clearTimeout(aggregateTimer);
        aggregateTimer = setTimeout(publishAggregate, 0);
        publishAggregate();
    };
    const onResultEvent = event => {
        const detail = event.detail || {};
        const owner = detail.owner;
        if (owner) clients.get(owner)?.onResult?.(detail);
        else for (const client of clients.values()) if (client.isDefault) client.onResult?.(detail);
        const operation = detail.operationId && operations.get(detail.operationId);
        if (operation && ['success', 'failed', 'cancelled', 'stale', 'conflict'].includes(detail.status)) {
            operation.resolve(detail);
            operations.delete(detail.operationId);
        }
    };
    form.addEventListener('vcp-settings-save-result', onResultEvent);
    const coordinator = {
        form,
        createOperation(owner) {
            const operationId = createOperationId();
            form.dataset.vcpSettingsOperationId = operationId;
            let resolveOperation;
            const completion = new Promise(resolve => { resolveOperation = resolve; });
            operations.set(operationId, { resolve: resolveOperation, owner, completion, promise: completion });
            if (owner && clients.has(owner)) {
                const client = clients.get(owner);
                client.status = 'saving';
                client.dirty = true;
                scheduleAggregate();
            }
            return operationId;
        },
        async savePatch(patch, { owner = 'legacy-autosave', expectedRevision, operationId = null, transport } = {}) {
            const id = operationId || coordinator.createOperation(owner);
            const request = transport || form.ownerDocument?.defaultView?.chatAPI?.saveSettings;
            if (typeof request !== 'function') {
                const result = { success: false, status: 'failed', operationId: id, error: '设置保存接口不可用' };
                form.dispatchEvent(new (form.ownerDocument?.defaultView?.CustomEvent || CustomEvent)('vcp-settings-save-result', { detail: { ...result, owner } }));
                return result;
            }
            try {
                const result = await request({
                    ...(patch || {}),
                    __vcpSettingsOps: Object.freeze(patchToOperations(patch)),
                    expectedRevision,
                    operationId: id,
                });
                const status = result?.status || (result?.success ? 'success' : 'failed');
                const terminal = { ...(result || {}), success: status === 'success', status, operationId: result?.operationId || id };
                form.dispatchEvent(new (form.ownerDocument?.defaultView?.CustomEvent || CustomEvent)('vcp-settings-save-result', { detail: { ...terminal, owner } }));
                return terminal;
            } catch (error) {
                const terminal = { success: false, status: 'failed', operationId: id, error: error?.message || String(error) };
                form.dispatchEvent(new (form.ownerDocument?.defaultView?.CustomEvent || CustomEvent)('vcp-settings-save-result', { detail: { ...terminal, owner } }));
                return terminal;
            }
        },
        registerClient({ id, onResult = null, flush = null, hasWork = null, isDefault = false }) {
            if (!id) throw new Error('save-coordinator client requires an id');
            const existing = clients.get(id);
            const client = existing || { id, status: 'idle', dirty: false };
            Object.assign(client, { onResult, flush, hasWork, isDefault: Boolean(isDefault) });
            clients.set(id, client);
            scheduleAggregate();
            return () => {
                if (clients.get(id) !== client) return;
                clients.delete(id);
                scheduleAggregate();
            };
        },
        setDurableBase(settings, revision = undefined) {
            durableBase = deepFreeze(deepMerge({}, settings || {}));
            if (revision !== undefined) durableRevision = revision;
            if (!form.dataset.vcpSettingsDirty) draft = durableBase;
            return snapshot();
        },
        recordDraft(patch = {}, ops = []) {
            draft = deepFreeze(deepMerge(draft, patch || {}));
            pendingOps = [...pendingOps, ...(Array.isArray(ops) ? ops : [])];
            return snapshot();
        },
        recordCommit(result = {}, patch = {}, ops = []) {
            if (result?.status === 'conflict' || result?.code === 'SETTINGS_CONFLICT') {
                conflict = result;
                retryableFailure = result;
                return snapshot();
            }
            if (result?.status !== 'success' && result?.success !== true) {
                retryableFailure = result;
                return snapshot();
            }
            // The manager validates and may normalize submitted values. Its
            // returned snapshot, not the renderer patch, is the durable
            // source of truth for the next revision/CAS submission.
            durableBase = deepFreeze(result?.settings && typeof result.settings === 'object'
                ? deepMerge({}, result.settings)
                : deepMerge(durableBase, patch || {}));
            if (result.currentRevision !== undefined) durableRevision = result.currentRevision;
            const committed = new Set((ops || []).map(operation => JSON.stringify(operation)));
            pendingOps = pendingOps.filter(operation => !committed.has(JSON.stringify(operation)));
            retryableFailure = null;
            conflict = null;
            draft = deepFreeze(pendingOps.length ? applyOperations(durableBase, pendingOps) : durableBase);
            return snapshot();
        },
        hasClient: id => clients.has(id),
        submit: () => {
            const previousNoValidate = form.noValidate;
            form.noValidate = true;
            try { return form.requestSubmit(); }
            finally { form.noValidate = previousNoValidate; }
        },
        reportState(mode, { owner = null, operationId = null, dirty = undefined } = {}) {
            const client = owner ? clients.get(owner) : [...clients.values()].find(entry => entry.isDefault);
            if (client) {
                if (mode) client.status = mode;
                else client.status = 'idle';
                if (dirty !== undefined) client.dirty = Boolean(dirty);
                else if (['dirty', 'saving', 'error', 'conflict'].includes(mode)) client.dirty = true;
                else if (!mode || mode === 'saved' || mode === 'idle') client.dirty = false;
            }
            if (operationId && !form.dataset.vcpSettingsOperationId) form.dataset.vcpSettingsOperationId = operationId;
            if (mode === 'conflict') conflict = { operationId };
            if (mode === 'error') retryableFailure = { operationId };
            scheduleAggregate();
        },
        track(operationId, promise, { owner = null } = {}) {
            if (!operationId || !promise || typeof promise.then !== 'function') return Promise.resolve(promise);
            let resolveOperation;
            const result = new Promise(resolve => { resolveOperation = resolve; });
            const existing = operations.get(operationId);
            const record = existing || { resolve: resolveOperation, owner, promise: null };
            if (!existing) operations.set(operationId, record);
            const tracked = Promise.resolve(promise).then(value => {
                if (operations.get(operationId) === record) {
                    operations.delete(operationId);
                    record.resolve(value);
                }
                return value;
            }, error => {
                if (operations.get(operationId) === record) {
                    operations.delete(operationId);
                    record.resolve({ success: false, status: 'failed', operationId, error: error?.message || String(error) });
                }
                throw error;
            });
            record.promise = tracked;
            return Promise.race([tracked, existing?.completion || result]);
        },
        async flush() {
            if (flushBarrier) return flushBarrier;
            flushBarrier = (async () => {
                for (;;) {
                    const hooks = [...clients.values()].map(client => client.flush?.()).filter(Boolean);
                    if (hooks.length) await Promise.all(hooks);
                    const pending = [...operations.values()].map(operation => operation.promise).filter(Boolean);
                    if (pending.length) await Promise.allSettled(pending);
                    const followUp = [...clients.values()].some(client => client.hasWork?.() === true);
                    if (['error', 'conflict'].includes(aggregateStatus())) break;
                    if (!followUp && ![...operations.values()].some(operation => operation.promise)) break;
                }
                return snapshot();
            })().finally(() => { flushBarrier = null; });
            return flushBarrier;
        },
        async dispose() {
            if (disposed) return;
            const hasPendingWork = [...clients.values()].some(client => client.hasWork?.() === true);
            if (operations.size === 0 && !hasPendingWork && !listenerReleased) {
                form.removeEventListener('vcp-settings-save-result', onResultEvent);
                listenerReleased = true;
            }
            // Keep the result channel alive while the barrier drains. Removing
            // it first strands operation promises that are completed by the
            // terminal result event.
            const snapshot = await coordinator.flush();
            if (snapshot?.status === 'error' || snapshot?.status === 'conflict') return snapshot;
            disposed = true;
            if (!listenerReleased) form.removeEventListener('vcp-settings-save-result', onResultEvent);
            listenerReleased = true;
            if (aggregateTimer !== null) clearTimeout(aggregateTimer);
            clients.clear();
            operations.clear();
            delete form.dataset.vcpSettingsOperationId;
            coordinators.delete(form);
            return snapshot;
        },
        getSnapshot: snapshot,
        async reloadExternal() {
            if (disposed) return snapshot();
            const settings = await form.ownerDocument?.defaultView?.chatAPI?.loadSettings?.();
            if (settings) {
                const revision = settings.__vcpSettingsRevision;
                const externalSettings = { ...settings };
                delete externalSettings.__vcpSettingsRevision;
                durableBase = deepFreeze(deepMerge({}, externalSettings));
                durableRevision = revision;
                draft = durableBase;
                pendingOps = [];
                retryableFailure = null;
                conflict = null;
                delete form.dataset.vcpSettingsDirty;
                for (const client of clients.values()) {
                    client.status = 'saved';
                    client.dirty = false;
                }
                const view = form.ownerDocument?.defaultView;
                (view || form).dispatchEvent(new (view?.CustomEvent || CustomEvent)('global-settings-updated', { detail: { settings: externalSettings, revision, source: 'settings-reload' } }));
                coordinator.reportState('saved', { dirty: false });
            }
            return snapshot();
        },
        retryDraft() {
            const view = form.ownerDocument?.defaultView;
            view?.dispatchEvent(new (view.CustomEvent || CustomEvent)('settings-retry-draft'));
            // The typed owner synchronously keeps the conflict marker for an
            // overlapping edit and removes it when the local patch is safe to
            // rebase. Only clear coordinator-level conflict after that owner
            // decision; otherwise a retry click could silently dismiss an
            // unresolved overlap.
            if (form.dataset.vcpSettingsConflict !== 'true') coordinator.clearConflict();
            return coordinator.flush();
        },
        clearConflict() {
            conflict = null;
            if (retryableFailure?.status === 'conflict' || retryableFailure?.code === 'SETTINGS_CONFLICT') retryableFailure = null;
            scheduleAggregate();
            return snapshot();
        },
    };
    coordinators.set(form, coordinator);
    return coordinator;
}

export function claimSaveCoordinator(form) {
    if (!form) return null;
    return coordinators.get(form) || createCoordinator(form);
}

export function getSaveCoordinator(form) {
    return form ? coordinators.get(form) || null : null;
}
