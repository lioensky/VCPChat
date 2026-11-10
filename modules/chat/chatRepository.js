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
    return Object.freeze({
        getHistory(itemId, itemType, topicId) {
            return itemType === 'group'
                ? method('getGroupChatHistory')(itemId, topicId)
                : method('getChatHistory')(itemId, topicId);
        },
        persistAssistant(scope, message) {
            return method('topicAdmissionPersistAssistant')(scope, message);
        },
        saveHistory(itemId, itemType, topicId, history, options) {
            return itemType === 'group'
                ? method('saveGroupChatHistory')(itemId, topicId, history, options)
                : method('saveChatHistory')(itemId, topicId, history, options);
        }
    });
}
