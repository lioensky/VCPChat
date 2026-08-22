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

            const projectedIds = new Set(projectedHistory.map(messageIdentity));
            const durableOnly = durableHistory
                .filter(message => !projectedIds.has(messageIdentity(message)))
                .map(message => ({ ...message }));
            const mergedHistory = [...projectedHistory, ...durableOnly]
                .sort((left, right) => {
                    const leftTime = Number(left?.timestamp);
                    const rightTime = Number(right?.timestamp);
                    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime === rightTime) return 0;
                    return leftTime - rightTime;
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
