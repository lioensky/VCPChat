/** Consumes non-stream events whose producer has already committed history. */
export function createNonStreamingEventConsumer({ renderTarget, messageRenderer, viewAuthority, onUnhandled = console.warn } = {}) {
    if (!renderTarget || !messageRenderer) throw new TypeError('Non-streaming consumer requires an owning render target');
    let disposed = false;
    return Object.freeze({
        async consume(event = {}) {
            if (disposed) return false;
            const type = String(event.type || '');
            const relevant = viewAuthority?.isCurrent?.(event.context) === true;
            if (type === 'full_response') {
                if (relevant) await messageRenderer.renderFullMessageProjection?.(
                    event.messageId, event.fullResponse || '', event.context?.agentName, event.context?.agentId, renderTarget.root
                );
                return true;
            }
            if (type === 'remove_message') {
                if (relevant) await renderTarget.removeMessage(event.messageId, false);
                return true;
            }
            if (type === 'no_ai_response') return true;
            if (!relevant) return false;
            if (type) onUnhandled(`[NonStreamingEventConsumer] Unhandled event: ${type}`, event);
            return false;
        },
        dispose() { disposed = true; },
    });
}
