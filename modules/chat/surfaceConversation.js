const emptySelection = () => ({ id: null, type: null, name: null, avatarUrl: null, config: null });

/**
 * Owns the immutable identity and mutable in-memory history for one internal
 * chat Surface. This is a narrow operation capability, not an application
 * Store: it has no subscription API and cannot switch to another conversation.
 */
export function createSurfaceConversation({ selectedItem = null, topicId = null, history = [] } = {}) {
    const ownedSelection = selectedItem ? { ...selectedItem } : emptySelection();
    const ownedTopicId = topicId ?? null;
    let ownedHistory = Array.isArray(history) ? [...history] : [];
    let active = true;

    const assertActive = () => {
        if (!active) throw new Error('Surface conversation is disposed');
    };

    return Object.freeze({
        selectedItemRef: Object.freeze({ get: () => ownedSelection, set: () => false }),
        topicIdRef: Object.freeze({ get: () => ownedTopicId, set: () => false }),
        historyRef: Object.freeze({
            get: () => ownedHistory,
            set(value) {
                if (!active) return false;
                ownedHistory = Array.isArray(value) ? [...value] : [];
                return true;
            },
        }),
        isActive: () => active,
        replaceHistory(value) {
            assertActive();
            ownedHistory = Array.isArray(value) ? [...value] : [];
            return ownedHistory;
        },
        dispose() {
            if (!active) return;
            active = false;
            ownedHistory = [];
        },
    });
}
