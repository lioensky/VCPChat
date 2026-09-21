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
            if (type === 'group_queue_stopped') {
                if (event?.silentConvergence?.occurred) {
                    const meta = event.silentConvergence;
                    console.log(
                        `%c[JEV 仲裁收敛]%c 用户发言已裁定收敛，无需伙伴回复 (原因: ${meta.reason}, 结束概率: ${meta.endProbability}, 置信度: ${meta.confidence}, 话题: ${meta.topicName})`,
                        'color: #d97706; font-weight: bold; background: #fef3c7; padding: 2px 6px; border-radius: 4px; border: 1px solid #fde68a;',
                        'color: #b45309; font-weight: normal;'
                    );
                }
                return true;
            }
            if ([
                'group_queue_state',
                'group_queue_updated',
                'jev_arbitration_started',
                'jev_arbitration_result'
            ].includes(type)) return true;
            if (!relevant) return false;
            if (type) onUnhandled(`[NonStreamingEventConsumer] Unhandled event: ${type}`, event);
            return false;
        },
        dispose() { disposed = true; },
    });
}
