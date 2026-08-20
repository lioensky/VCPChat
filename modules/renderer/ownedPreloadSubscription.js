/** Owns one preload subscription and forwards producer payloads to a Surface consumer. */
export function createOwnedPreloadSubscription({ subscribe, consume, reportError = console.error } = {}) {
    if (typeof subscribe !== 'function') throw new TypeError('Owned preload subscription requires subscribe');
    if (typeof consume !== 'function') throw new TypeError('Owned preload subscription requires consume');
    let disposed = false;
    const disposer = subscribe(payload => {
        if (disposed) return;
        try { return consume(payload); }
        catch (error) { reportError('[OwnedPreloadSubscription] consumer failed', error); return undefined; }
    });
    return Object.freeze({
        dispose() {
            if (disposed) return;
            disposed = true;
            if (typeof disposer === 'function') disposer();
            else disposer?.dispose?.();
        },
    });
}
