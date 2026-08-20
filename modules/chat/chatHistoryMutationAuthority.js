const conversationKey = ({ itemId, itemType = 'agent', topicId }) => {
    if (!itemId || !topicId) throw new TypeError('History mutation requires itemId and topicId');
    return `${itemType}:${itemId}/topic:${topicId}`;
};

/**
 * Single durable write authority for non-stream chat-history mutations.
 * Callers still own domain intent; this provider owns serialization, repository
 * commit and the one observable operation Promise for each mutation.
 */
export function createChatHistoryMutationAuthority({ repository } = {}) {
    if (!repository || typeof repository.getHistory !== 'function' || typeof repository.saveHistory !== 'function') {
        throw new TypeError('ChatHistoryMutationAuthority requires a ChatRepository');
    }
    const queues = new Map();
    let disposed = false;

    const run = (descriptor, operation) => {
        if (disposed) return Promise.reject(new Error('ChatHistoryMutationAuthority is disposed'));
        const key = conversationKey(descriptor);
        const previous = queues.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        queues.set(key, current);
        current.finally(() => {
            if (queues.get(key) === current) queues.delete(key);
        }).catch(() => {});
        return current;
    };

    const commit = async (descriptor, history) => {
        if (!Array.isArray(history)) throw new TypeError('History mutation commit requires an array');
        const snapshot = structuredClone(history);
        const result = await repository.saveHistory(
            descriptor.itemId,
            descriptor.itemType || 'agent',
            descriptor.topicId,
            snapshot
        );
        if (result?.success === false) throw new Error(result.error || 'History mutation commit failed');
        return Object.freeze({
            category: descriptor.category || 'replace',
            itemId: descriptor.itemId,
            itemType: descriptor.itemType || 'agent',
            topicId: descriptor.topicId,
            history: Object.freeze(snapshot),
            result,
        });
    };

    return Object.freeze({
        replace(descriptor, history) {
            return run(descriptor, () => commit(descriptor, history));
        },
        mutate(descriptor, transform) {
            if (typeof transform !== 'function') throw new TypeError('History mutation requires a transform');
            return run(descriptor, async () => {
                const current = await repository.getHistory(
                    descriptor.itemId,
                    descriptor.itemType || 'agent',
                    descriptor.topicId
                );
                if (!Array.isArray(current)) throw new Error(current?.error || 'History mutation read failed');
                const next = await transform(structuredClone(current));
                return commit(descriptor, next);
            });
        },
        diagnostics() {
            return Object.freeze({ disposed, pendingConversations: queues.size });
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            await Promise.allSettled([...queues.values()]);
            queues.clear();
        },
    });
}
