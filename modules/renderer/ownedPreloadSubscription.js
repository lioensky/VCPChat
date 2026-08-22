/** Owns one preload subscription and forwards producer payloads to a Surface consumer. */
export function createOwnedPreloadSubscription({ subscribe, consume, reportError = console.error } = {}) {
    if (typeof subscribe !== 'function') throw new TypeError('Owned preload subscription requires subscribe');
    if (typeof consume !== 'function') throw new TypeError('Owned preload subscription requires consume');
    let disposed = false;
    const tasks = new Set();
    const abortController = new AbortController();
    const lifecycle = Object.freeze({
        signal: abortController.signal,
        isActive: () => !disposed,
    });
    const disposer = subscribe(payload => {
        if (disposed) return;
        let result;
        try { result = consume(payload, lifecycle); }
        catch (error) { reportError('[OwnedPreloadSubscription] consumer failed', error); return undefined; }
        if (!result || typeof result.then !== 'function') return result;
        const task = Promise.resolve(result)
            .catch(error => { reportError('[OwnedPreloadSubscription] consumer failed', error); })
            .finally(() => tasks.delete(task));
        tasks.add(task);
        return task;
    });
    return Object.freeze({
        async dispose() {
            if (disposed) return;
            disposed = true;
            abortController.abort();
            try {
                if (typeof disposer === 'function') await disposer();
                else await disposer?.dispose?.();
            } catch (error) {
                reportError('[OwnedPreloadSubscription] unsubscribe failed', error);
            }
            await Promise.allSettled([...tasks]);
        },
    });
}
