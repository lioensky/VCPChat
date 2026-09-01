// autosave — the legacy form autosave state machine (dirty/saving/error
// status button + debounced requestSubmit). Result routing and cross-registry
// flush orchestration live in the save coordinator (阶段 4); this module owns
// only the legacy autosave registry and its lifecycle, registered there as
// the `legacy-autosave` client.
import { getSaveCoordinator } from './save-coordinator.js';

const autosaveStates = new Set();

// `state.saving` used to have exactly one unlock path: the
// `vcp-settings-save-result` event. When that event never arrived the state
// machine stayed wedged on 保存中… forever — later edits only queued, and the
// close-time flush silently skipped them. Mirror the 15s fallback the action
// bar presenter already uses so the machine can always unwind.
const SAVE_FALLBACK_MS = 15000;

function requestSubmitWithoutNativeValidation(form) {
    const previousNoValidate = form.noValidate;
    form.noValidate = true;
    try { return form.requestSubmit(); }
    finally { form.noValidate = previousNoValidate; }
}

function clearSaveFallback(state) {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
}

function armSaveFallback(state) {
    clearSaveFallback(state);
    state.fallbackTimer = setTimeout(() => {
        state.fallbackTimer = null;
        if (!state.saving) return;
        state.saving = false;
        state.failureOwner = 'legacy-autosave';
        state.setStatus('保存超时 · 重试', 'error');
        if (state.pending) state.schedule();
    }, state.fallbackMs);
}

// `options.fallbackMs` exists so the regression test can drive the fallback
// without waiting out the real 15s window. Production callers leave it unset.
export function mountSettingsAutosave(root, form, scope = null, options = {}) {
    if (form.dataset.vcpAutosaveMounted === 'true') return;
    // The coordinator is claimed by the pipeline's save-coordinator step, so
    // it is present in every mounted presentation. Standalone mounts (the
    // regression uiux, early bootstrap) fall back to a direct listener and
    // a direct submit.
    const coordinator = getSaveCoordinator(form);
    const state = {
        form,
        timer: null,
        fallbackTimer: null,
        fallbackMs: Number.isFinite(options.fallbackMs) && options.fallbackMs > 0
            ? options.fallbackMs
            : SAVE_FALLBACK_MS,
        saving: false,
        pending: false,
        cleanups: [],
    };
    // The machine has no visible status surface any more (the settings header
    // stays clean). `form.dataset.vcpAutosaveState` is the observable contract:
    // dirty | saving | saved | error, absent when idle. Failed saves retry on
    // the next edit and through the close-time flush.
    const setStatus = (value, mode = '') => {
        void value;
        if (coordinator) coordinator.reportState(mode);
        else if (mode) form.dataset.vcpAutosaveState = mode;
        else delete form.dataset.vcpAutosaveState;
    };
    const submit = () => {
        state.timer = null;
        if (!state.pending || state.saving) return;
        state.pending = false;
        state.saving = true;
        setStatus('保存中…', 'saving');
        armSaveFallback(state);
        try {
            // The coordinator owns the only form.requestSubmit() path; the
            // synchronous throw of a form without a submittable control
            // propagates through it unchanged.
            if (coordinator) coordinator.submit();
            else requestSubmitWithoutNativeValidation(form);
        } catch {
            // A form without a submittable control throws synchronously; the
            // state machine must unwind or every later save stays wedged on
            // saving=true with the status frozen at 保存中….
            clearSaveFallback(state);
            state.saving = false;
            state.failureOwner = 'legacy-autosave';
            setStatus('保存失败 · 重试', 'error');
        }
    };
    const schedule = () => {
        if (state.saving) { state.pending = true; return; }
        state.pending = true;
        form.dataset.vcpSettingsDirty = 'true';
        setStatus('未保存', 'dirty');
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(submit, 400);
    };
    // The fallback helper is module-scoped so the close-time flush can share
    // it; both closures are needed to unwind the machine from outside `mount`.
    state.schedule = schedule;
    state.setStatus = setStatus;
    const onInput = event => {
        if (!event.target?.matches?.('input, select, textarea')) return;
        // The native file-input change fires before the avatar cropper has
        // produced the File consumed by handleSaveGlobalSettings. Ignore that
        // early event; the cropper callback emits a follow-up input event once
        // the cropped file is available.
        if (event.type === 'change' && event.target.matches('input[type="file"]')) return;
        // Forum fields carry the same suppression marker as typed settings
        // fields; otherwise typing there also drives this whole-form
        // autosave chain and both owners fight over one status bar.
        if (event.target.dataset.vcpTypedFieldOwner === 'true') return;
        if (event.target.dataset.vcpTypedForumFieldOwner === 'true') return;
        if (event.target.dataset.vcpAppearanceDraftControl === 'true') return;
        schedule();
    };
    // Results arrive through the coordinator's routing (阶段 4): this client
    // is registered as the default consumer, so it sees only the form-level
    // save flow — typed clients receive their own owner-tagged results and
    // never clobber this machine's status. No owner strings here.
    const onResult = detail => {
        // A concurrent-submit merge notice is not an outcome: the in-flight
        // save still owns the result and will publish it. Keep waiting here,
        // otherwise the status bar flips to 失败 and immediately re-submits
        // straight back into the same guard.
        if (detail?.inflight) return;
        clearSaveFallback(state);
        state.saving = false;
        if (detail?.success) {
            delete state.failureOwner;
            delete form.dataset.vcpSettingsDirty;
            setStatus('已保存', 'saved');
            if (state.pending) schedule();
        } else {
            // Remember which owner failed so retry clicks can be routed.
            state.failureOwner = detail?.owner || 'legacy-autosave';
            setStatus('保存失败 · 重试', 'error');
        }
    };
    const listen = (target, type, handler, label) => {
        if (scope?.listen) return scope.listen(target, type, handler, undefined, label);
        target.addEventListener(type, handler);
        return () => target.removeEventListener(type, handler);
    };
    const releaseInput = listen(form, 'input', onInput, 'settings-legacy-autosave-input');
    const releaseChange = listen(form, 'change', onInput, 'settings-legacy-autosave-change');
    const releaseResult = coordinator
        ? coordinator.registerClient({
            id: 'legacy-autosave',
            isDefault: true,
            onResult,
            flush: () => flushState(state),
        })
        : listen(form, 'vcp-settings-save-result', event => onResult(event.detail), 'settings-legacy-autosave-result');
    state.cleanups.push(() => {
        if (state.timer) clearTimeout(state.timer);
        clearSaveFallback(state);
        // Scope-owned listeners are released by the presentation owner. The
        // fallback disposer keeps this module safe when LifecycleScope is not
        // available during early bootstrap, and every release is idempotent.
        void releaseInput?.();
        void releaseChange?.();
        void releaseResult?.();
        delete form.dataset.vcpAutosaveState;
        delete form.dataset.vcpAutosaveMounted;
    });
    form.dataset.vcpAutosaveMounted = 'true';
    autosaveStates.add(state);
}

// One machine's close-time flush. Shared by the module-level flushLegacyAutosave
// and the coordinator client's flush hook.
function flushState(state) {
    if (!state.pending) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.saving) {
        // A save is already in flight. Firing a second submit would race
        // it, so leave the outcome to the fallback timer instead. The work
        // stays marked dirty so the unsaved-changes guard still warns,
        // rather than the edit being dropped without a trace.
        state.form.dataset.vcpSettingsDirty = 'true';
        state.setStatus?.('保存中…', 'saving');
        if (!state.fallbackTimer) armSaveFallback(state);
        return;
    }
    state.saving = true;
    state.pending = false;
    armSaveFallback(state);
    try {
        const coordinator = getSaveCoordinator(state.form);
        if (coordinator) coordinator.submit();
        else requestSubmitWithoutNativeValidation(state.form);
    } catch {
        clearSaveFallback(state);
        state.saving = false;
        state.pending = true;
        state.form.dataset.vcpSettingsDirty = 'true';
    }
}

export function flushLegacyAutosave() {
    autosaveStates.forEach(flushState);
}

export function teardownLegacyAutosave() {
    [...autosaveStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        autosaveStates.delete(state);
    });
}
