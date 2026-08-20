/** Consumes non-stream events whose producer has already committed history. */
export function createNonStreamingEventConsumer({ renderTarget, messageRenderer, viewAuthority, onUnhandled = console.warn } = {}) {
    if (!renderTarget || !messageRenderer) throw new TypeError('Non-streaming consumer requires an owning render target');
    let disposed = false;
    return Object.freeze({
        consume(event = {}) {
            if (disposed) return false;
            const type = String(event.type || '');
            const relevant = viewAuthority?.isCurrent?.(event.context) === true;
            if (!relevant) return false;
            if (type === 'full_response') {
                void messageRenderer.renderFullMessageProjection?.(
                    event.messageId, event.fullResponse || '', event.context?.agentName, event.context?.agentId, renderTarget.root
                );
                return true;
            }
            if (type === 'remove_message') {
                renderTarget.removeMessage(event.messageId, false);
                return true;
            }
            if (type === 'no_ai_response') return true;
            if (type) onUnhandled(`[NonStreamingEventConsumer] Unhandled event: ${type}`, event);
            return false;
        },
        dispose() { disposed = true; },
    });
}
