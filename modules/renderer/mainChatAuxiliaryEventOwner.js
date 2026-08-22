import { createOwnedPreloadSubscription } from './ownedPreloadSubscription.js';

/** Owns non-stream preload events that project into the main chat Surface. */
export function createMainChatAuxiliaryEventOwner({
    subscriptions = {},
    insertSharedText,
    consumeLogStatus,
    consumeLogMessage,
    consumeGroupTopicUpdate,
} = {}) {
    const receipts = [];
    let mounted = false;
    let disposed = false;

    const add = (subscribe, consume) => {
        if (typeof subscribe !== 'function' || typeof consume !== 'function') return;
        receipts.push(createOwnedPreloadSubscription({
            subscribe,
            consume: (payload, lifecycle) => consume(payload, lifecycle),
        }));
    };

    const mount = () => {
        if (disposed) throw new Error('MainChatAuxiliaryEventOwner is disposed');
        if (mounted) return;
        mounted = true;
        add(subscriptions.loomShareText, insertSharedText);
        add(subscriptions.logStatus, consumeLogStatus);
        add(subscriptions.logMessage, consumeLogMessage);
        add(subscriptions.groupTopicUpdated, consumeGroupTopicUpdate);
    };

    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        await Promise.allSettled(receipts.splice(0).map(receipt => receipt.dispose()));
    };

    return Object.freeze({ mount, dispose });
}
