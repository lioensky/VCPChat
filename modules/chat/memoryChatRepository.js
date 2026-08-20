const cloneHistory = history => Array.isArray(history) ? history.map(message => ({ ...message })) : [];

/** Explicit short-lived repository for auxiliary chat windows with no durable topic. */
export function createMemoryChatRepository({ read, write } = {}) {
    if (typeof read !== 'function' || typeof write !== 'function') {
        throw new TypeError('memory chat repository requires read and write capabilities');
    }
    return Object.freeze({
        async getHistory() {
            return cloneHistory(read());
        },
        async saveHistory(_itemId, _itemType, _topicId, history) {
            const next = cloneHistory(history);
            write(next);
            return next;
        },
    });
}
