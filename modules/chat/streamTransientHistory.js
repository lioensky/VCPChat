const cloneHistory = history => history.map(message => ({ ...message }));
const isTemporaryContext = context => (
    context?.topicId === 'assistant_chat' || context?.topicId?.startsWith?.('voicechat_')
);

/**
 * Owns renderer-transient stream message models. This provider never performs
 * a durable save; ChatHistoryPersistence remains the sole durable authority.
 */
export function createStreamTransientHistory({ repository, currentHistory } = {}) {
    if (typeof repository?.getHistory !== 'function') {
        throw new TypeError('StreamTransientHistory requires a history reader');
    }
    if (typeof currentHistory?.get !== 'function' || typeof currentHistory?.replace !== 'function') {
        throw new TypeError('StreamTransientHistory requires a current Surface history capability');
    }
    const pending = new Map();
    let disposed = false;

    const readFor = async (context, visible, messageId = null) => {
        const current = cloneHistory(currentHistory.get() || []);
        const ownsPending = visible && messageId && current.some(message => message?.id === messageId);
        if (visible || ownsPending || isTemporaryContext(context)) return current;
        const itemId = context?.groupId || context?.agentId;
        const itemType = context?.isGroupMessage ? 'group' : 'agent';
        if (!itemId || !context?.topicId) throw new Error('Transient stream history requires item and topic identity');
        const history = await repository.getHistory(itemId, itemType, context.topicId);
        if (!Array.isArray(history)) throw new Error('Transient stream history reader returned an invalid history');
        return cloneHistory(history);
    };

    return Object.freeze({
        async prepare(message, context, { visible = false } = {}) {
            if (disposed) throw new Error('StreamTransientHistory is disposed');
            const history = await readFor(context, visible);
            const skipThinkingSeed = context?.isGroupMessage === true && message?.isThinking === true;
            const placeholder = {
                ...message,
                content: skipThinkingSeed ? '' : (message?.content || ''),
                isThinking: false,
                isPendingStream: true,
                timestamp: message?.timestamp || Date.now(),
                isGroupMessage: context?.isGroupMessage === true,
                name: context?.agentName,
                agentId: context?.agentId,
            };
            pending.set(message.id, { ...placeholder });
            const index = history.findIndex(entry => entry?.id === message.id);
            if (index < 0) history.push(placeholder);
            else history[index] = { ...history[index], ...placeholder };
            if (visible) currentHistory.replace(cloneHistory(history));
            return history;
        },
        async finalize({ messageId, context, content, finishReason, visible = false } = {}) {
            if (disposed) return null;
            const history = await readFor(context, visible, messageId);
            let index = history.findIndex(message => message?.id === messageId);
            if (index < 0) {
                const placeholder = pending.get(messageId);
                if (placeholder) {
                    const replyIndex = placeholder.replyToMessageId
                        ? history.findIndex(message => message?.id === placeholder.replyToMessageId)
                        : -1;
                    index = replyIndex >= 0 ? replyIndex + 1 : history.length;
                    history.splice(index, 0, { ...placeholder });
                }
            }
            if (index < 0) return null;
            const message = {
                ...history[index],
                content,
                finishReason,
                isThinking: false,
            };
            delete message.isPendingStream;
            if (message.isGroupMessage) {
                message.name = context?.agentName || message.name;
                message.agentId = context?.agentId || message.agentId;
            }
            history[index] = message;
            if (visible) currentHistory.replace(cloneHistory(history));
            pending.delete(messageId);
            return Object.freeze({ message: Object.freeze({ ...message }), history });
        },
        discard(messageId) { pending.delete(messageId); },
        get pendingCount() { return pending.size; },
        dispose() { disposed = true; pending.clear(); },
    });
}
