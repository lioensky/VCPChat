/* Bounded, payload-free performance diagnostics for Next UI lifecycle paths. */
(function installPerformanceRecorder(globalObject, factory) {
    const api = factory(globalObject);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject && !globalObject.VCPPerformance) globalObject.VCPPerformance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPerformanceRecorder(globalObject) {
    'use strict';

    const MAX_ENTRIES = 100;
    const DEFAULT_BUDGETS = Object.freeze({
        'next.mount': 500,
        'ui-mode.transition': 1500,
        'settings.open': 500,
        'embedded.create': 10000,
        'embedded.activate': 500,
    });
    const entries = [];
    const listeners = new Set();
    const now = () => globalObject?.performance?.now?.() ?? Date.now();

    function safeMetadata(metadata = {}) {
        return Object.freeze(Object.fromEntries(Object.entries(metadata)
            .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
            .slice(0, 8)
            .map(([key, value]) => [String(key).slice(0, 40), typeof value === 'string' ? value.slice(0, 80) : value])));
    }

    function record(nameValue, durationValue, metadata = {}) {
        const name = String(nameValue || '').slice(0, 80);
        const durationMs = Math.max(0, Number(durationValue) || 0);
        const budgetMs = DEFAULT_BUDGETS[name] ?? null;
        const entry = Object.freeze({
            name,
            at: Date.now(),
            durationMs: Math.round(durationMs * 100) / 100,
            budgetMs,
            withinBudget: budgetMs === null || durationMs <= budgetMs,
            metadata: safeMetadata(metadata),
        });
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        listeners.forEach(listener => listener(entry));
        return entry;
    }

    function begin(name, metadata = {}) {
        const startedAt = now();
        let settled = false;
        return (result = {}) => {
            if (settled) return null;
            settled = true;
            return record(name, now() - startedAt, { ...metadata, ...result });
        };
    }

    function measure(name, operation, metadata = {}) {
        if (typeof operation !== 'function') throw new TypeError('Performance measurement requires an operation.');
        const finish = begin(name, metadata);
        try {
            const result = operation();
            if (result && typeof result.then === 'function') {
                return Promise.resolve(result).then(
                    value => { finish({ status: 'fulfilled' }); return value; },
                    error => { finish({ status: 'rejected' }); throw error; }
                );
            }
            finish({ status: 'fulfilled' });
            return result;
        } catch (error) {
            finish({ status: 'rejected' });
            throw error;
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('Performance subscriber must be a function.');
        listeners.add(listener);
        let active = true;
        return () => active && (active = false, listeners.delete(listener));
    }

    return Object.freeze({
        begin,
        measure,
        record,
        subscribe,
        snapshot: () => Object.freeze([...entries]),
        budgets: DEFAULT_BUDGETS,
    });
});
