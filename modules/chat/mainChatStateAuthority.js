const freezeSelection = value => Object.freeze(value && typeof value === 'object' ? { ...value } : {
    id: null, type: null, name: null, avatarUrl: null, config: null,
});

/** Owns the main chat's current selection without exposing mutable globals. */
export function createMainChatStateAuthority(initial = {}) {
    let selectedItem = freezeSelection(initial.selectedItem);
    let topicId = initial.topicId ?? null;

    const snapshot = () => Object.freeze({ selectedItem, topicId });
    const consumer = Object.freeze({ snapshot });

    return Object.freeze({
        consumer,
        snapshot,
        setSelectedItem(value) {
            selectedItem = freezeSelection(value);
            return selectedItem;
        },
        setTopicId(value) {
            topicId = value ?? null;
            return topicId;
        },
    });
}
