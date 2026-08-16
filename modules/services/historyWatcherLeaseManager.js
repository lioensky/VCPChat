'use strict';

/**
 * Serializes the single history watcher and rejects completions owned by an
 * obsolete renderer operation. A lease is claimed synchronously before any
 * asynchronous selection work begins; only the newest lease may mutate the
 * watcher afterwards.
 */
function createHistoryWatcherLeaseManager({ startWatching, stopWatching }) {
    if (typeof startWatching !== 'function' || typeof stopWatching !== 'function') {
        throw new TypeError('history watcher lease manager requires start/stop functions');
    }

    let sequence = 0;
    let activeLease = null;
    let operationQueue = Promise.resolve();
    let disposed = false;

    const enqueue = (operation) => {
        const result = operationQueue.then(operation, operation);
        operationQueue = result.catch(() => {});
        return result;
    };

    const owns = (ownerId, token) => (
        !disposed
        && activeLease?.ownerId === ownerId
        && activeLease?.token === token
    );

    return {
        claim(ownerId) {
            if (disposed) throw new Error('history watcher lease manager is disposed');
            const token = `${ownerId}:${++sequence}`;
            activeLease = { ownerId, token };
            const stopped = enqueue(async () => {
                if (!owns(ownerId, token)) return { success: false, stale: true };
                await stopWatching();
                return { success: true };
            });
            return { token, stopped };
        },

        async start(ownerId, token, payload) {
            return enqueue(async () => {
                if (!owns(ownerId, token)) return { success: false, stale: true };
                await startWatching(payload);
                if (!owns(ownerId, token)) {
                    // A newer claim arrived while the watcher was starting.
                    // Do not leave this obsolete watcher active.
                    await stopWatching();
                    return { success: false, stale: true };
                }
                return { success: true };
            });
        },

        async stop(ownerId, token) {
            return enqueue(async () => {
                if (!owns(ownerId, token)) return { success: false, stale: true };
                await stopWatching();
                return { success: true };
            });
        },

        isCurrent(ownerId, token) {
            return owns(ownerId, token);
        },

        async revoke(ownerId) {
            if (activeLease?.ownerId !== ownerId) return { success: false, stale: true };
            activeLease = null;
            await enqueue(() => stopWatching());
            return { success: true };
        },

        async dispose() {
            disposed = true;
            activeLease = null;
            await enqueue(() => stopWatching());
        }
    };
}

module.exports = { createHistoryWatcherLeaseManager };
