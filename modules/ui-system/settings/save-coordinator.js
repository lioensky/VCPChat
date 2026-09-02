// One asynchronous save owner for a global-settings form. Clients still own
// field-specific adapters, but this coordinator owns result identity,
// aggregate status, and the close-time quiescence barrier.
const coordinators = new WeakMap();
const STATUS_ORDER = Object.freeze(['conflict', 'error', 'saving', 'dirty', 'saved', 'idle']);

function createOperationId() {
    return `settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCoordinator(form) {
    const clients = new Map();
    const operations = new Map();
    let disposed = false;
    let flushBarrier = null;
    let aggregateTimer = null;
    const aggregateStatus = () => {
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
            operations.set(operationId, { resolve: resolveOperation, owner, promise: completion });
            if (owner && clients.has(owner)) {
                const client = clients.get(owner);
                client.status = 'saving';
                client.dirty = true;
                scheduleAggregate();
            }
            return operationId;
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
            scheduleAggregate();
        },
        track(operationId, promise, { owner = null } = {}) {
            if (!operationId || !promise || typeof promise.then !== 'function') return Promise.resolve(promise);
            let resolveOperation;
            const result = new Promise(resolve => { resolveOperation = resolve; });
            const record = operations.get(operationId) || { resolve: resolveOperation, owner, promise: null };
            if (!operations.has(operationId)) operations.set(operationId, record);
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
            return Promise.race([tracked, result]);
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
            if (operations.size === 0) form.removeEventListener('vcp-settings-save-result', onResultEvent);
            // Keep the result channel alive while the barrier drains. Removing
            // it first strands operation promises that are completed by the
            // terminal result event.
            const snapshot = await coordinator.flush();
            if (snapshot?.status === 'error' || snapshot?.status === 'conflict') return snapshot;
            disposed = true;
            form.removeEventListener('vcp-settings-save-result', onResultEvent);
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
                delete form.dataset.vcpSettingsDirty;
                form.dispatchEvent(new CustomEvent('global-settings-updated', { detail: { settings: externalSettings, revision, source: 'settings-reload' } }));
                reportState('saved', { dirty: false });
            }
            return snapshot();
        },
        retryDraft() {
            return coordinator.flush();
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
