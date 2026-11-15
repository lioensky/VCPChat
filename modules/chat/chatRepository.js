/** 将 IPC 失败 DTO 和被抛出的结构化错误统一为 Error，保留冲突码。 */
export function normalizeChatRepositoryError(value, fallback = '聊天仓储操作失败') {
    if (value instanceof Error) return value;
    const detail = value?.error;
    const message = typeof detail === 'string' && detail
        || detail?.message || value?.message
        || (typeof value === 'string' && value) || fallback;
    const error = new Error(message, { cause: value });
    const code = value?.code ?? detail?.code;
    if (code !== undefined) error.code = code;
    return error;
}

/** 兼容既有无返回值保存；明确失败绝不能被解释成成功。 */
export function assertChatRepositorySuccess(value, fallback) {
    if (value instanceof Error || value?.success === false
        || (value?.error !== undefined && value.error !== null && value.error !== false)) {
        throw normalizeChatRepositoryError(value, fallback);
    }
    return value;
}

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
    const invoke = async (name, ...args) => {
        try {
            return assertChatRepositorySuccess(await method(name)(...args));
        } catch (error) {
            throw normalizeChatRepositoryError(error);
        }
    };
    return Object.freeze({
        getHistory(itemId, itemType, topicId) {
            return invoke(itemType === 'group' ? 'getGroupChatHistory' : 'getChatHistory', itemId, topicId);
        },
        persistAssistant(scope, message) {
            return invoke('topicAdmissionPersistAssistant', scope, message);
        },
        saveHistory(itemId, itemType, topicId, history, options) {
            return invoke(itemType === 'group' ? 'saveGroupChatHistory' : 'saveChatHistory',
                itemId, topicId, history, options);
        }
    });
}
