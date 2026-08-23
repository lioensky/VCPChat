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
    // 每次 prepare/discard 都推进消息 epoch。异步历史读取返回后只有最新 epoch
    // 可以写 pending，防止同消息重试时旧 operation 在 discard 后复活占位。
    const prepareEpochs = new Map();
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
            const messageId = message?.id;
            if (!messageId) throw new TypeError('StreamTransientHistory.prepare requires a message id');
            const epoch = (prepareEpochs.get(messageId) || 0) + 1;
            prepareEpochs.set(messageId, epoch);
            const history = await readFor(context, visible);
            if (disposed || prepareEpochs.get(messageId) !== epoch) return null;
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
            pending.set(messageId, { ...placeholder });
            const index = history.findIndex(entry => entry?.id === messageId);
            if (index < 0) history.push(placeholder);
            else history[index] = { ...history[index], ...placeholder };
            if (visible) currentHistory.replace(cloneHistory(history));
            return history;
        },
        async finalize({ messageId, context, content, finishReason, visible = false } = {}) {
            if (disposed) return null;
            const epoch = prepareEpochs.get(messageId) || 0;
            const history = await readFor(context, visible, messageId);
            if (disposed || prepareEpochs.get(messageId) !== epoch) return null;
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
            prepareEpochs.delete(messageId);
            return Object.freeze({ message: Object.freeze({ ...message }), history });
        },
        discard(messageId) {
            const ownsPending = pending.has(messageId);
            const activeEpoch = prepareEpochs.get(messageId);
            pending.delete(messageId);
            // 仅撤销真实存在或仍在异步读取中的准备操作。finalize 成功后两者均已释放，
            // 终态清理的幂等 discard 不应重新创建永久 epoch 条目。
            if (ownsPending || activeEpoch !== undefined) {
                prepareEpochs.set(messageId, (activeEpoch || 0) + 1);
            }
        },
        get pendingCount() { return pending.size; },
        dispose() {
            disposed = true;
            pending.clear();
            prepareEpochs.clear();
        },
    });
}
