/**
 * Owns the main-window VCP event subscription. The preload subscription is
 * the producer; this bridge is the single consumer router for the main
 * Surface and returns the producer's disposer to its composition owner.
 */
export function createMainChatEventBridge({
    chatAPI,
    acceptStreamEvent,
    consumeNonStreamingEvent,
    onUnhandled = console.warn,
} = {}) {
    if (!chatAPI || typeof chatAPI.onVCPStreamEvent !== 'function') {
        throw new TypeError('Main chat event bridge requires onVCPStreamEvent');
    }
    if (typeof acceptStreamEvent !== 'function') {
        throw new TypeError('Main chat event bridge requires an owned stream consumer');
    }
    let disposed = false;
    const subscription = chatAPI.onVCPStreamEvent(async eventData => {
        if (disposed) return false;
        const messageId = String(eventData?.messageId || '').trim();
        if (!messageId) {
            onUnhandled('[MainChatEventBridge] Ignoring stream event without messageId', eventData);
            return false;
        }
        if (acceptStreamEvent(eventData)) return true;
        if (await consumeNonStreamingEvent?.(eventData)) return true;
        if (eventData?.type === 'no_ai_response') return true;
        onUnhandled('[MainChatEventBridge] Unhandled stream event', eventData);
        return false;
    });
    return Object.freeze({
        dispose() {
            disposed = true;
            if (typeof subscription === 'function') subscription();
            else subscription?.dispose?.();
        },
    });
}
