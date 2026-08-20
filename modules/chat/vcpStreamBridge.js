import { createStreamCoordinator } from './streamCoordinator.js';

const MANAGED_TYPES = new Set(['agent_thinking', 'start', 'data', 'end', 'error']);

/** Adapts preload's externally-produced VCP stream events to owner-scoped handles. */
export function createVcpStreamBridge({ createConsumer, reportError = console.error } = {}) {
    if (typeof createConsumer !== 'function') throw new TypeError('VCP stream bridge requires a consumer factory');
    const operations = new Map();
    const consumers = new Map();

    const coordinator = createStreamCoordinator({
        reportError,
        run: (request, controls) => new Promise(resolve => {
            operations.set(request.sessionId, { controls, resolve });
        }),
        persist: value => consumers.get(value.request.sessionId)?.persist?.(value),
    });

    const ensureOperation = event => {
        const sessionId = String(event?.messageId || '').trim();
        if (!sessionId) return null;
        let operation = operations.get(sessionId);
        if (operation) return operation;

        const context = event.context || {};
        const conversationKey = context.groupId
            ? `group:${context.groupId}/topic:${context.topicId || ''}`
            : `agent:${context.agentId || ''}/topic:${context.topicId || ''}`;
        const consumer = createConsumer(event);
        consumers.set(sessionId, consumer);
        const handle = coordinator.start({
            sessionId,
            messageId: sessionId,
            conversationKey,
            context,
        }, {
            surfaceGeneration: consumer.surfaceGeneration,
            onEvent: streamEvent => consumer.consume?.(streamEvent),
        });
        handle.done.finally(() => {
            consumer.dispose?.();
            if (operations.get(sessionId)?.handle === handle) operations.delete(sessionId);
            if (consumers.get(sessionId) === consumer) consumers.delete(sessionId);
        });
        operation = operations.get(sessionId);
        operation.handle = handle;
        return operation;
    };

    return Object.freeze({
        accept(event) {
            if (!MANAGED_TYPES.has(event?.type) || !event?.messageId) return false;
            const operation = ensureOperation(event);
            const consumer = consumers.get(String(event.messageId));
            consumer?.prepare?.(event);
            if (event.type === 'data') {
                const normalized = consumer?.normalizeChunk?.(event.chunk) ?? event.chunk;
                operation.controls.pushChunk(normalized);
            }
            if (event.type === 'end' || event.type === 'error') {
                const terminal = event.type === 'end'
                    ? { kind: event.finish_reason || 'completed', fullResponse: event.fullResponse, context: event.context }
                    : { kind: 'failed', error: event.error, fullResponse: event.fullResponse || event.accumulatedResponse, context: event.context };
                operation.controls.terminal(terminal);
                operation.resolve(terminal);
            }
            return true;
        },
        async dispose() {
            await coordinator.dispose();
            operations.clear();
            consumers.clear();
        },
    });
}
