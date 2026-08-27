const messageIdentity = message => (
    message?.id || `${message?.role || ''}:${message?.timestamp || ''}:${message?.content || ''}`
);

const cloneHistory = history => history.map(message => ({ ...message }));

/**
 * Creates the durable terminal-history provider used by stream coordinators.
 * Serialization belongs to the coordinator; this provider owns repository
 * read/merge/write policy and propagates every durable failure to its caller.
 */
function createHistoryPersistence(repository, { durable, skipTemporaryContexts }) {
    if (!repository || typeof repository.getHistory !== 'function' || typeof repository.saveHistory !== 'function') {
        throw new TypeError('ChatHistoryPersistence requires a chat repository');
    }

    return Object.freeze({
        async commit(projected) {
            if (!projected?.context || !Array.isArray(projected.history)) return projected || null;

            const context = projected.context;
            if (skipTemporaryContexts && (context.topicId === 'assistant_chat' || context.isGroupMessage)) {
                return Object.freeze({
                    messageId: projected.messageId,
                    context,
                    content: projected.content,
                    finishReason: projected.finishReason,
                });
            }

            const itemId = context.groupId || context.agentId;
            const itemType = context.isGroupMessage ? 'group' : 'agent';
            if (!itemId || !context.topicId) {
                throw new Error('Stream terminal persistence requires item and topic identity');
            }

            const projectedHistory = cloneHistory(
                projected.history.filter(message => !message?.isThinking && !message?.isPendingStream)
            );
            const durableHistory = await repository.getHistory(itemId, itemType, context.topicId);
            if (!Array.isArray(durableHistory)) {
                throw new Error('Chat repository returned invalid history during stream commit');
            }

            const targetId = String(projected.messageId || '');
            const projectedById = new Map(projectedHistory.map(message => [messageIdentity(message), message]));
            const durableById = new Map(durableHistory.map(message => [messageIdentity(message), message]));
            const allIds = [];
            const seenIds = new Set();

            // 投影顺序表达当前对话结构；durable-only 消息随后加入，并由排序键定位。
            for (const message of projectedHistory) {
                const id = messageIdentity(message);
                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    allIds.push(id);
                }
            }
            for (const message of durableHistory) {
                const id = messageIdentity(message);
                if (!seenIds.has(id)) {
                    seenIds.add(id);
                    allIds.push(id);
                }
            }

            const mergedHistory = allIds.map((id, insertionOrder) => {
                const projectedMessage = projectedById.get(id);
                const durableMessage = durableById.get(id);

                if (id === targetId && projectedMessage) {
                    // 本事务只拥有终态消息的流式字段；保留 durable 上可能并发写入的扩展元数据，
                    // 再用规范终态覆盖 content/finishReason/isThinking 等投影字段。
                    return {
                        ...(durableMessage || {}),
                        ...projectedMessage,
                        __vcpMergeOrder: insertionOrder
                    };
                }

                // 非目标同 ID 消息不属于本次终态事务，durable 版本优先，防止旧投影快照
                // 覆盖并发编辑、附件、反馈状态或其他业务元数据。
                return {
                    ...(projectedMessage || {}),
                    ...(durableMessage || {}),
                    __vcpMergeOrder: insertionOrder
                };
            }).sort((left, right) => {
                const leftTime = Number(left?.timestamp);
                const rightTime = Number(right?.timestamp);
                if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
                    return leftTime - rightTime;
                }
                return left.__vcpMergeOrder - right.__vcpMergeOrder;
            }).map(message => {
                const cleanMessage = { ...message };
                delete cleanMessage.__vcpMergeOrder;
                return cleanMessage;
            });

            await repository.saveHistory(itemId, itemType, context.topicId, mergedHistory);
            return Object.freeze({
                messageId: projected.messageId,
                context,
                content: projected.content,
                finishReason: projected.finishReason,
            });
        },
        durable,
    });
}

export function createChatHistoryPersistence(repository) {
    return createHistoryPersistence(repository, { durable: true, skipTemporaryContexts: true });
}

/**
 * Creates terminal persistence for a short-lived auxiliary session.
 * The operation Promise settles only after the in-memory session snapshot is
 * updated; the session owner separately commits that snapshot to durable
 * history when it creates the final topic during close.
 */
export function createTransientChatHistoryPersistence(repository) {
    return createHistoryPersistence(repository, { durable: false, skipTemporaryContexts: false });
}
