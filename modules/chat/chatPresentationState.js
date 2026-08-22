/** Read-only presentation state channel for skins and named slots. */
export function createChatPresentationState(initial = {}) {
    let state = { mode: 'idle', theme: initial.theme || 'light', reducedMotion: Boolean(initial.reducedMotion), activeSurface: initial.activeSurface || 'main' };
    let disposed = false;
    const listeners = new Set();
    const snapshot = () => Object.freeze({ ...state });
    return {
        getSnapshot: snapshot,
        set(patch = {}) {
            if (disposed) return snapshot();
            state = { ...state, ...patch };
            const next = snapshot();
            for (const listener of [...listeners]) {
                try { listener(next); } catch (error) {
                    // A presentation consumer cannot be allowed to break the
                    // authoritative state transition or other subscribers.
                    console.error('[ChatPresentationState] subscriber failed:', error);
                }
            }
            return next;
        },
        subscribe(listener) {
            if (disposed) return () => {};
            if (typeof listener !== 'function') throw new TypeError('presentation state listener is required');
            listeners.add(listener);
            try { listener(snapshot()); } catch (error) {
                console.error('[ChatPresentationState] subscriber failed during initial snapshot:', error);
            }
            return () => listeners.delete(listener);
        },
        dispose() { disposed = true; listeners.clear(); }
    };
}
