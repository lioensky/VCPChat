const freezeSelection = value => Object.freeze(value && typeof value === 'object' ? { ...value } : {
    id: null, type: null, name: null, avatarUrl: null, config: null,
});

const cloneReadOnly = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(cloneReadOnly));
    return Object.freeze(Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, cloneReadOnly(nested)])
    ));
};

/** Owns the main chat's current selection without exposing mutable globals. */
export function createMainChatStateAuthority(initial = {}) {
    let selectedItem = freezeSelection(initial.selectedItem);
    let topicId = initial.topicId ?? null;
    let history = Array.isArray(initial.history) ? [...initial.history] : [];

    const snapshot = () => Object.freeze({ selectedItem, topicId, history: Object.freeze([...history]) });
    const consumerSnapshot = () => Object.freeze({
        selectedItem: cloneReadOnly(selectedItem),
        topicId,
        history: cloneReadOnly(history),
    });
    const historyRef = Object.freeze({
        get: () => history,
        set(value) {
            history = Array.isArray(value) ? [...value] : [];
            return history;
        },
    });
    const selectedItemRef = Object.freeze({
        get: () => selectedItem,
        set(value) {
            selectedItem = freezeSelection(value);
            return selectedItem;
        },
    });
    const topicIdRef = Object.freeze({
        get: () => topicId,
        set(value) {
            topicId = value ?? null;
            return topicId;
        },
    });
    const consumer = Object.freeze({ snapshot: consumerSnapshot });

    return Object.freeze({
        consumer,
        snapshot,
        selectedItemRef,
        topicIdRef,
        setSelectedItem(value) {
            return selectedItemRef.set(value);
        },
        setTopicId(value) {
            return topicIdRef.set(value);
        },
        historyRef,
    });
}
