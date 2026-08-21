/* Bounded, cancellable waiting for an existing domain owner's revisioned state. */
(function installSettlement(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) globalObject.VCPSettlement = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSettlementApi() {
    'use strict';

    function abortError(reason) {
        const error = new Error(reason || 'Settlement wait aborted.');
        error.name = 'AbortError';
        return error;
    }

    function waitForSettlement(options = {}) {
        const getSnapshot = options.getSnapshot;
        const subscribe = options.subscribe;
        const predicate = options.predicate || (() => true);
        const afterRevision = Number.isFinite(options.afterRevision) ? Number(options.afterRevision) : -1;
        const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Number(options.timeoutMs)) : 5_000;
        const signal = options.signal;
        const label = options.label || 'domain';
        if (typeof getSnapshot !== 'function' || typeof subscribe !== 'function') {
            return Promise.reject(new TypeError('Settlement wait requires getSnapshot and subscribe.'));
        }
        if (signal?.aborted) return Promise.reject(abortError(signal.reason));

        return new Promise((resolve, reject) => {
            let active = true;
            let unsubscribe = null;
            let timer = null;
            const cleanup = () => {
                if (!active) return;
                active = false;
                if (timer !== null) clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                unsubscribe?.();
            };
            const finish = snapshot => { cleanup(); resolve(snapshot); };
            const fail = error => { cleanup(); reject(error); };
            const inspect = snapshot => {
                if (!active || !snapshot) return;
                if (Number(snapshot.revision) < afterRevision) return;
                if (predicate(snapshot)) finish(snapshot);
            };
            const onAbort = () => fail(abortError(signal.reason));
            signal?.addEventListener('abort', onAbort, { once: true });
            timer = setTimeout(() => fail(new Error(`${label} did not settle within ${timeoutMs}ms.`)), timeoutMs);
            try {
                unsubscribe = subscribe((_value, snapshot) => inspect(snapshot), { immediate: false });
                inspect(getSnapshot());
            } catch (error) {
                fail(error);
            }
        });
    }

    return Object.freeze({ waitForSettlement });
});
