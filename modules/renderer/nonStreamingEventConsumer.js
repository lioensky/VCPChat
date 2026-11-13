/** Consumes non-stream events whose producer has already committed history. */
export function createNonStreamingEventConsumer({
    renderTarget,
    messageRenderer,
    viewAuthority,
    disposeStream = null,
    streamProjection = null,
    onGroupQueueStateChange = null,
    notifySendStateChanged = null,
    onUnhandled = console.warn,
} = {}) {
    if (!renderTarget || !messageRenderer) throw new TypeError('Non-streaming consumer requires an owning render target');
    let disposed = false;
    const syncGroupQueueActivity = (event, forcedActive = null) => {
        const groupId = event?.context?.groupId || event?.state?.groupId;
        const topicId = event?.context?.topicId || event?.state?.topicId;
        if (!groupId || !topicId) return;
        let active = forcedActive;
        if (active === null) {
            if (
                (event.type === 'group_queue_state' && event.reason === 'idle')
                || event.state?.running === false
                || event.state?.stopRequested === true
            ) {
                active = false;
            } else if (
                event.type === 'jev_arbitration_started'
                || (event.type === 'group_queue_state' && event.reason === 'started')
                || event.state?.status === 'arbitrating'
                || (event.state?.running === true && !event.state?.stopRequested)
            ) {
                active = true;
            }
        }
        if (typeof active === 'boolean') {
            onGroupQueueStateChange?.({ groupId, topicId, active, event });
        }
    };
    return Object.freeze({
        async consume(event = {}) {
            if (disposed) return false;
            const type = String(event.type || '');
            const relevant = viewAuthority?.isCurrent?.(event.context) === true;
            if (type === 'full_response') {
                await disposeStream?.(event.messageId, 'non-stream-full-response');
                streamProjection?.discardStreamingMessage?.(event.messageId);
                if (relevant) await messageRenderer.renderFullMessageProjection?.(
                    event.messageId, event.fullResponse || '', event.context?.agentName, event.context?.agentId, renderTarget.root
                );
                notifySendStateChanged?.({ event, context: event.context, messageId: event.messageId });
                try {
                    await globalThis.window?.flowlockManager?.handleFinalizedMessage?.({
                        type: 'end',
                        messageId: event.messageId,
                        context: event.context,
                        content: event.fullResponse || '',
                        finishReason: 'completed',
                        error: null,
                    });
                } catch (error) {
                    console.error('[NonStreamingEventConsumer] Flowlock finalization failed:', error);
                }
                return true;
            }
            if (type === 'remove_message') {
                await disposeStream?.(event.messageId, 'non-stream-remove-message');
                streamProjection?.discardStreamingMessage?.(event.messageId);
                if (relevant) await renderTarget.removeMessage(event.messageId, false);
                notifySendStateChanged?.({ event, context: event.context, messageId: event.messageId });
                return true;
            }
            if (type === 'no_ai_response') {
                notifySendStateChanged?.({ event, context: event.context, messageId: event.messageId });
                return true;
            }
            if (type === 'group_queue_stopped') {
                syncGroupQueueActivity(event, false);
                notifySendStateChanged?.({ event, context: event.context, messageId: event.messageId });
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
            ].includes(type)) {
                syncGroupQueueActivity(event, null);
                notifySendStateChanged?.({ event, context: event.context, messageId: event.messageId });
                return true;
            }
            if (!relevant) return false;
            if (type) onUnhandled(`[NonStreamingEventConsumer] Unhandled event: ${type}`, event);
            return false;
        },
        dispose() { disposed = true; },
    });
}
