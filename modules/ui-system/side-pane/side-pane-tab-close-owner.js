/** Async close authorization belongs to one mounted occurrence, never a later tab with the same id. */
export function createSidePaneTabCloseOwner({
    isDisposed, getTab, getEntry, getOnClosed, cancelPendingMount, retireTab
}) {
    const closing = new Map();
    const disposals = new WeakMap();
    const retiring = new Set();

    function disposeEntry(tabId, entry) {
        if (!entry) return Promise.resolve();
        let promise = disposals.get(entry);
        if (!promise) {
            promise = Promise.resolve().then(() => entry.handle?.dispose?.()).catch(error => {
                console.error(`[SidePaneController] Failed to dispose tab "${tabId}":`, error);
            });
            disposals.set(entry, promise);
        }
        return promise;
    }

    function closeTab(tabId, options = {}) {
        if (isDisposed() || !tabId) return Promise.resolve();
        const tab = getTab(tabId);
        const entry = getEntry(tabId);
        const previous = closing.get(tabId);
        if (previous && (!tab || previous.identity === (entry || tab))) return previous.promise;
        if (!tab || tab.closable === false) return Promise.resolve();

        const operation = { identity: entry || tab, ...Promise.withResolvers() };
        closing.set(tabId, operation);
        const onClosed = getOnClosed(tab);
        const run = async () => {
            if (entry) {
                const result = await entry.handle?.requestClose?.();
                if (result?.closed === false) return;
                if (isDisposed() || getEntry(tabId) !== entry) return;
            }
            if (isDisposed()) return;
            const current = getTab(tabId);
            if (!current) return;
            cancelPendingMount(tabId);
            // Commit removal before cleanup yields. A subsequent open is a new occurrence.
            retireTab(current, entry, options);
            const cleanup = (async () => {
                await disposeEntry(tabId, entry);
                try { await onClosed?.(current); }
                catch (error) { console.error(`[SidePaneController] onClosed failed for tab "${tabId}":`, error); }
            })();
            retiring.add(cleanup);
            try { await cleanup; }
            finally { retiring.delete(cleanup); }
        };
        const forget = () => { if (closing.get(tabId) === operation) closing.delete(tabId); };
        run().then(value => { forget(); operation.resolve(value); }, error => { forget(); operation.reject(error); });
        return operation.promise;
    }

    async function dispose() {
        // Unadmitted requests may still be waiting on a provider; shutdown must not wait for authorization.
        // Their continuation checks isDisposed; already retired resources still finish their cleanup.
        closing.clear();
        await Promise.allSettled([...retiring]);
    }

    return { closeTab, disposeEntry, dispose };
}
