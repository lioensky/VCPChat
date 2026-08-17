/* Revisioned settlement facade for the existing Agent and Global settings forms. */
(function installSettingsSettlement(globalObject, factory) {
    const api = factory(globalObject);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.VCPSettingsSettlement = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createSettingsSettlementApi(globalObject) {
    'use strict';

    const document = globalObject?.document;
    const definitions = Object.freeze({ agent: 'agentSettingsForm', global: 'globalSettingsForm' });
    const states = new Map(Object.keys(definitions).map(name => [name, {
        operationId: 0, status: 'idle', success: null, error: null,
    }]));
    const listeners = new Set();
    const releases = [];
    let revision = 0;
    let installed = false;

    function getSnapshot() {
        return Object.freeze({
            revision,
            forms: Object.freeze(Object.fromEntries([...states].map(([name, value]) => [name, Object.freeze({ ...value })]))),
        });
    }

    function publish() {
        revision += 1;
        const snapshot = getSnapshot();
        listeners.forEach(listener => {
            try { listener(snapshot, snapshot); } catch (error) { console.error('[VCPSettings] Settlement subscriber failed:', error); }
        });
        return snapshot;
    }

    function begin(name) {
        const state = states.get(name);
        if (!state) return null;
        state.operationId += 1;
        state.status = 'saving';
        state.success = null;
        state.error = null;
        publish();
        return state.operationId;
    }

    function settle(name, detail = {}) {
        const state = states.get(name);
        if (!state) return;
        if (state.status !== 'saving') state.operationId += 1;
        state.status = detail.success ? 'saved' : 'failed';
        state.success = Boolean(detail.success);
        state.error = detail.error || null;
        publish();
    }

    function subscribe(listener, options = {}) {
        listeners.add(listener);
        if (options.immediate !== false) listener(getSnapshot(), getSnapshot());
        return () => listeners.delete(listener);
    }

    function whenSettled(options = {}) {
        const wait = globalObject?.VCPSettlement?.waitForSettlement;
        if (!wait) return Promise.reject(new Error('VCPSettlement is unavailable.'));
        const form = options.form || 'global';
        if (!states.has(form)) return Promise.reject(new TypeError(`Unknown settings form: ${form}`));
        const operationId = Number.isFinite(options.operationId)
            ? Number(options.operationId)
            : states.get(form).operationId;
        return wait({
            ...options,
            label: `${form} settings`,
            getSnapshot,
            subscribe,
            predicate: snapshot => {
                const state = snapshot.forms[form];
                return state.operationId >= operationId && state.status !== 'saving';
            },
        });
    }

    function install() {
        if (installed || !document) return;
        installed = true;
        Object.entries(definitions).forEach(([name, id]) => {
            const form = document.getElementById(id);
            if (!form) return;
            const onSubmit = () => begin(name);
            const onResult = event => settle(name, event.detail);
            form.addEventListener('submit', onSubmit, true);
            form.addEventListener('vcp-settings-save-result', onResult);
            releases.push(() => form.removeEventListener('submit', onSubmit, true));
            releases.push(() => form.removeEventListener('vcp-settings-save-result', onResult));
        });
    }

    function dispose() {
        releases.splice(0).forEach(release => release());
        listeners.clear();
        installed = false;
    }

    if (document?.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();

    return Object.freeze({ begin, dispose, getSnapshot, install, subscribe, whenSettled });
});
