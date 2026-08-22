/** A narrow operation contract for interactive chat surfaces. */
export function createChatOperations({ send, cancel = null }) {
    if (typeof send !== 'function') throw new TypeError('ChatOperations requires send()');
    let active = null;
    let cancelRequested = false;
    let disposed = false;
    return {
        get state() { return Object.freeze({ status: disposed ? 'disposed' : active ? 'pending' : 'idle' }); },
        async sendMessage(request) {
            if (disposed) throw new Error('ChatOperations is disposed');
            if (active) throw new Error('A chat operation is already pending');
            cancelRequested = false;
            let operation;
            try { operation = Promise.resolve(send(request)); }
            catch (error) { operation = Promise.reject(error); }
            active = operation;
            try { return await operation; }
            finally { if (active === operation) active = null; }
        },
        async cancel() {
            if (!active || typeof cancel !== 'function') return false;
            if (cancelRequested) return true;
            cancelRequested = true;
            await cancel();
            return true;
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            if (active && typeof cancel === 'function') await cancel();
            if (active) await Promise.allSettled([active]);
        }
    };
}
