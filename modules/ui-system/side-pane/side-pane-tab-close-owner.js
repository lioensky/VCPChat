/** Single and batch closes retain their original page lifetimes through authorization and cleanup. */
export function createSidePaneTabCloseOwner({
    isDisposed, getTab, getEntry, getOnClosed, cancelPendingMount, retireTab
}) {
    const closing = new Map();
    const disposals = new WeakMap();
    const retiring = new Set();
    // Layout records and mount handles can change without reopening a page.
    // This token lasts until the state removal commits, including lazy mounts.
    const lifetimes = new Map();

    function getLifetime(tabId) {
        if (isDisposed() || !getTab(tabId)) return null;
        if (!lifetimes.has(tabId)) lifetimes.set(tabId, {});
        return lifetimes.get(tabId);
    }

    function disposeEntry(tabId, entry) {
        if (!entry) return Promise.resolve();
        let promise = disposals.get(entry);
        if (!promise) {
            promise = Promise.resolve().then(() => entry.handle?.dispose?.()).catch(error => {
                console.error(`[SidePaneController] Failed to dispose tab "${tabId}":`, error);
            }).then(() => entry.occurrence?.dispose?.('tab-closed')).catch(error => {
                // provider 的 dispose 抛错也要释放 scope，挂在上面的监听和定时器才不会漏
                console.error(`[SidePaneController] Failed to release tab "${tabId}":`, error);
            });
            disposals.set(entry, promise);
        }
        return promise;
    }

    function closeTab(tabId, options = {}, expectedLifetime = null, onFocusMoved = null) {
        if (isDisposed() || !tabId) return Promise.resolve();
        const tab = getTab(tabId);
        const entry = getEntry(tabId);
        const previous = closing.get(tabId);
        const lifetime = getLifetime(tabId);
        if (expectedLifetime && lifetime !== expectedLifetime) {
            return !tab && previous?.identity === expectedLifetime ? previous.promise : Promise.resolve();
        }
        if (previous && (!tab || previous.identity === lifetime)) {
            if (onFocusMoved) previous.focusObservers.add(onFocusMoved);
            return previous.promise;
        }
        if (!tab || tab.closable === false) return Promise.resolve();

        const operation = { identity: lifetime, focusObservers: new Set(onFocusMoved ? [onFocusMoved] : []), ...Promise.withResolvers() };
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
            if (!current || current.closable === false || getLifetime(tabId) !== lifetime) return;
            cancelPendingMount(tabId);
            // Commit removal before cleanup yields. A subsequent open is a new occurrence.
            retireTab(current, entry, options, (before, after) => {
                for (const observer of operation.focusObservers) observer(before, after);
            });
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

    async function closeTabs(tabs, options = {}, onFocusMoved = null) {
        const batch = tabs.map(tab => ({ id: tab.id, lifetime: getLifetime(tab.id) }));
        for (const target of batch) {
            if (target.lifetime) await closeTab(target.id, options, target.lifetime, onFocusMoved);
        }
    }

    async function dispose() {
        // Unadmitted requests may still be waiting on a provider; shutdown must not wait for authorization.
        // Their continuation checks isDisposed; already retired resources still finish their cleanup.
        closing.clear();
        lifetimes.clear();
        await Promise.allSettled([...retiring]);
    }

    return { closeTab, closeTabs, getLifetime, forgetLifetime: tabId => lifetimes.delete(tabId), disposeEntry, dispose };
}
