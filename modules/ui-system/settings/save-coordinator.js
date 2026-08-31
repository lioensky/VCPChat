// save-coordinator — the single save entry for the global settings form
// (repayment plan 阶段 4). The legacy autosave state machine and the typed
// settings/forum field owners register here as clients; nobody filters the
// shared `vcp-settings-save-result` stream by owner string any more.
//
// What the coordinator owns:
//   · form.requestSubmit() — the only submission path; the legacy autosave's
//     debounce and the close-time flush both go through submit();
//   · result routing — a result event tagged with a registered client id is
//     delivered to that client alone; every untagged result (the form-level
//     save flow in global-settings-manager) goes to the client marked
//     `isDefault`, which is the legacy autosave;
//   · `form.dataset.vcpAutosaveState` (dirty | saving | saved | error, absent
//     when idle) — clients report transitions through reportState(), keeping
//     the observable contract identical while the write happens in one place.
//
// Trimmed seam by design: no schemastery/cordis schema, and the revision
// (compare-and-set) hook is intentionally left open — clients that gain
// concurrent-write semantics will declare it on their registration.
const coordinators = new WeakMap();

function createCoordinator(form) {
    const clients = new Map();
    const onResultEvent = event => {
        const detail = event.detail;
        const owner = detail?.owner;
        // An owner-tagged result is delivered to that owner alone. If the
        // owner never registered, the result is dropped rather than falling
        // through to the default client — a typed owner's outcome must never
        // resolve the legacy machine just because its registration is
        // missing (standalone uiuxes, teardown ordering).
        if (owner) {
            clients.get(owner)?.onResult?.(detail);
            return;
        }
        for (const client of clients.values()) {
            if (client.isDefault) client.onResult?.(detail);
        }
    };
    form.addEventListener('vcp-settings-save-result', onResultEvent);
    const coordinator = {
        form,
        // Explicit subscription: a client owns every result tagged with its
        // id; the default client receives the untagged form-level results.
        // `flush` lets the close-time flush drive all clients through one
        // entry. Returns the unsubscribe function.
        registerClient({ id, onResult = null, flush = null, isDefault = false }) {
            if (!id) throw new Error('save-coordinator client requires an id');
            clients.set(id, { id, onResult, flush, isDefault: Boolean(isDefault) });
            return () => {
                if (clients.get(id)?.onResult === onResult) clients.delete(id);
            };
        },
        hasClient: id => clients.has(id),
        // The single submission entry. Synchronous submit failures (a form
        // without a submittable control throws) propagate to the caller so
        // each client keeps unwinding its own state machine.
        submit: () => form.requestSubmit(),
        reportState(mode) {
            if (mode) form.dataset.vcpAutosaveState = mode;
            else delete form.dataset.vcpAutosaveState;
        },
        flush() {
            clients.forEach(client => client.flush?.());
        },
    };
    coordinator.dispose = () => {
        form.removeEventListener('vcp-settings-save-result', onResultEvent);
        clients.clear();
        coordinators.delete(form);
    };
    coordinators.set(form, coordinator);
    return coordinator;
}

// Idempotent claim: the pipeline step re-runs on every presentation refresh,
// and the same form element must keep one coordinator.
export function claimSaveCoordinator(form) {
    if (!form) return null;
    return coordinators.get(form) || createCoordinator(form);
}

export function getSaveCoordinator(form) {
    return form ? coordinators.get(form) || null : null;
}
