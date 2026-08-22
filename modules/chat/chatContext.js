/**
 * Explicit chat-surface context. It is deliberately small: this is a state
 * boundary, not a replacement Store. Domain-facing code can observe/update
 * the active item, topic and history without knowing the renderer's globals.
 */
export function createChatContext(initial = {}) {
    let selectedItem = initial.selectedItem ?? { id: null, type: null, name: null, avatarUrl: null, config: null };
    let topicId = initial.topicId ?? null;
    let history = Array.isArray(initial.history) ? [...initial.history] : [];
    const listeners = new Set();

    const emit = (kind, value) => {
        for (const listener of [...listeners]) {
            try { listener({ kind, value, context }); } catch (error) {
                console.warn('[ChatContext] listener failed:', error);
            }
        }
    };
    const context = {
        get selectedItem() { return selectedItem; },
        get topicId() { return topicId; },
        get history() { return [...history]; },
        setSelectedItem(value) { selectedItem = value ?? { id: null, type: null, name: null, avatarUrl: null, config: null }; emit('selected-item', selectedItem); return selectedItem; },
        setTopicId(value) { topicId = value ?? null; emit('topic', topicId); return topicId; },
        setHistory(value) { history = Array.isArray(value) ? [...value] : []; emit('history', [...history]); return [...history]; },
        subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('ChatContext listener must be a function'); listeners.add(listener); return () => listeners.delete(listener); },
        dispose() { listeners.clear(); }
    };
    return context;
}
