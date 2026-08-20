/**
 * Owns the main renderer's topic-selection readiness handshake.
 *
 * The topic list is mounted before ChatManager is fully wired.  This small
 * capability lets the producer defer one user selection without reaching
 * through ambient window fields; the renderer composition root remains the
 * only owner that changes readiness or consumes the deferred operation.
 */
export function createTopicSelectionReadiness() {
    let ready = false;
    let pending = null;

    return Object.freeze({
        isReady: () => ready,
        setReady(value) {
            ready = value === true;
        },
        defer(selection) {
            if (!selection || typeof selection !== 'object') return;
            pending = Object.freeze({ ...selection });
        },
        takePending() {
            const selection = pending;
            pending = null;
            return selection;
        },
        clearPending() {
            pending = null;
        },
    });
}
