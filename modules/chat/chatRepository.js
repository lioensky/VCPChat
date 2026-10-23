/**
 * Electron-free contract for chat history persistence. The adapter is the
 * only place where agent/group IPC naming is selected; callers depend on the
 * domain-shaped get/save methods instead of the transport API.
 */
export function createChatRepository(electronAPI) {
    if (!electronAPI) throw new TypeError('ChatRepository requires an IPC adapter');
    const method = (name) => {
        if (typeof electronAPI[name] !== 'function') throw new Error(`Missing chat repository capability: ${name}`);
        return electronAPI[name].bind(electronAPI);
    };
    const revisions = new Map();
    const key = (id, type, topic) => JSON.stringify([type, id, topic]);
    const tracked = new WeakMap();
    return Object.freeze({
        revisionOf(history) { return tracked.get(history); },
        revisionFor(itemId, itemType, topicId) { return revisions.get(key(itemId, itemType, topicId)); },
        getHistory(itemId, itemType, topicId) {
            if (typeof electronAPI.getNativeHistorySnapshot === 'function') {
                return electronAPI.getNativeHistorySnapshot(itemId, itemType, topicId).then(snapshot => {
                    if (snapshot?.syncEnabled === false) return (itemType === 'group' ? method('getGroupChatHistory') : method('getChatHistory'))(itemId, topicId);
                    if (!Array.isArray(snapshot?.history)) return { error: snapshot?.error || 'History read failed' };
                    if (snapshot.syncEnabled) {
                        revisions.set(key(itemId, itemType, topicId), snapshot.revision);
                        tracked.set(snapshot.history, snapshot.revision);
                    }
                    return snapshot.history;
                });
            }
            return itemType === 'group'
                ? method('getGroupChatHistory')(itemId, topicId)
                : method('getChatHistory')(itemId, topicId);
        },
        saveHistory(itemId, itemType, topicId, history, expectedRevision = tracked.get(history) ?? revisions.get(key(itemId, itemType, topicId))) {
            const save = itemType === 'group' ? method('saveGroupChatHistory') : method('saveChatHistory');
            const args = expectedRevision === undefined ? [itemId, topicId, history] : [itemId, topicId, history, expectedRevision];
            const result = save(...args);
            return Promise.resolve(result).then(value => {
                if (value?.success !== false && value?.revision) revisions.set(key(itemId, itemType, topicId), value.revision);
                return value;
            });
        },
        async commitTerminal(projected) {
            if (typeof electronAPI.commitNativeHistoryTerminal !== 'function') return { handled: false };
            const result = await electronAPI.commitNativeHistoryTerminal(projected);
            const context = projected.context;
            if (result?.revision && result?.success !== false) revisions.set(key(context.groupId || context.agentId, context.isGroupMessage ? 'group' : 'agent', context.topicId), result.revision);
            return result;
        },
    });
}
