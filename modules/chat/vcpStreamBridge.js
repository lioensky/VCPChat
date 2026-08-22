import { createStreamCoordinator } from './streamCoordinator.js';

const MANAGED_TYPES = new Set(['agent_thinking', 'start', 'data', 'end', 'error']);
// VCP message ids are one-shot. Keep a bounded recent terminal cache so delayed
// IPC cannot resurrect an operation without retaining every id for the app lifetime.
const MAX_RETIRED_SESSIONS = 2048;

/** Adapts preload's externally-produced VCP stream events to owner-scoped handles. */
export function createVcpStreamBridge({ createConsumer, reportError = console.error } = {}) {
    if (typeof createConsumer !== 'function') throw new TypeError('VCP stream bridge requires a consumer factory');
    const operations = new Map();
    const consumers = new Map();
    const messageOperations = new Map();
    const retiredSessions = new Set();
    let disposed = false;
    const retireSession = sessionId => {
        if (!sessionId) return;
        retiredSessions.delete(sessionId);
        retiredSessions.add(sessionId);
        while (retiredSessions.size > MAX_RETIRED_SESSIONS) {
            retiredSessions.delete(retiredSessions.values().next().value);
        }
    };

    const coordinator = createStreamCoordinator({
        reportError,
        run: (request, controls) => new Promise(resolve => {
            const operation = {
                controls,
                resolve,
                chain: Promise.resolve(),
                handle: null,
                disposePromise: null,
                cancelPromise: null,
                accepting: true,
                projecting: true,
            };
            operations.set(request.sessionId, operation);
            controls.signal.addEventListener('abort', () => {
                if (operations.get(request.sessionId) === operation) resolve({ kind: 'discarded', reason: controls.signal.reason });
            }, { once: true });
        }),
        persist: value => consumers.get(value.request.sessionId)?.persist?.(value),
    });

    const ensureOperation = event => {
        if (disposed) return null;
        const messageId = String(event?.messageId || '').trim();
        const sessionId = String(event?.streamOperationId || messageId).trim();
        if (!messageId || !sessionId || retiredSessions.has(sessionId)) return null;
        let operation = operations.get(sessionId);
        if (operation) return operation;

        const context = event.context || {};
        const conversationKey = context.groupId
            ? `group:${context.groupId}/topic:${context.topicId || ''}`
            : `agent:${context.agentId || ''}/topic:${context.topicId || ''}`;
        const consumer = createConsumer(event);
        consumers.set(sessionId, consumer);
        messageOperations.set(messageId, sessionId);
        const handle = coordinator.start({
            sessionId,
            messageId,
            conversationKey,
            context,
        }, {
            surfaceGeneration: consumer.surfaceGeneration,
            onEvent: streamEvent => consumer.consume?.(streamEvent),
        });
        handle.done.finally(() => {
            retireSession(sessionId);
            consumer.dispose?.();
            if (operations.get(sessionId)?.handle === handle) operations.delete(sessionId);
            if (consumers.get(sessionId) === consumer) consumers.delete(sessionId);
            if (messageOperations.get(messageId) === sessionId) messageOperations.delete(messageId);
        });
        operation = operations.get(sessionId);
        operation.handle = handle;
        return operation;
    };

    const disposeOperation = (messageId, reason = 'surface-disposed') => {
        const visibleId = String(messageId || '').trim();
        const sessionId = messageOperations.get(visibleId) || visibleId;
        retireSession(sessionId);
        const operation = operations.get(sessionId);
        if (!operation) return Promise.resolve(false);
        if (!operation.disposePromise) {
            operation.accepting = false;
            operation.projecting = false;
            operation.disposePromise = (async () => {
                const outcome = await operation.handle.dispose(reason);
                await Promise.allSettled([operation.chain]);
                return outcome;
            })();
        }
        return operation.disposePromise;
    };
    const cancelOperation = (messageId, reason = 'cancelled') => {
        const visibleId = String(messageId || '').trim();
        const sessionId = messageOperations.get(visibleId) || visibleId;
        const operation = operations.get(sessionId);
        if (!operation) {
            retireSession(sessionId);
            return Promise.resolve(null);
        }
        if (!operation.cancelPromise) {
            operation.accepting = false;
            operation.cancelPromise = operation.chain.then(() => operation.handle.cancel(reason));
        }
        return operation.cancelPromise;
    };

    return Object.freeze({
        accept(event) {
            if (!MANAGED_TYPES.has(event?.type) || !event?.messageId) return false;
            const operation = ensureOperation(event);
            if (!operation?.accepting) return false;
            const consumer = consumers.get(String(event.streamOperationId || event.messageId));
            operation.chain = operation.chain.then(async () => {
                if (!operation.projecting) return;
                await consumer?.prepare?.(event);
                if (!operation.projecting) return;
                if (event.type === 'data') {
                    const normalized = consumer?.normalizeChunk?.(event.chunk) ?? event.chunk;
                    operation.controls.pushChunk(normalized);
                }
                if (event.type === 'end' || event.type === 'error') {
                    const terminal = event.type === 'end'
                        ? { kind: event.finish_reason || 'completed', fullResponse: event.fullResponse, context: event.context }
                        : { kind: 'failed', error: event.error, fullResponse: event.fullResponse || event.accumulatedResponse, context: event.context };
                    operation.accepting = false;
                    operation.projecting = false;
                    operation.controls.terminal(terminal);
                    operation.resolve(terminal);
                }
            }).catch(error => {
                operation.accepting = false;
                operation.projecting = false;
                reportError('[VcpStreamBridge] event projection failed', error);
                const terminal = { kind: 'failed', phase: 'projection', error };
                operation.controls.terminal(terminal);
                operation.resolve(terminal);
            });
            return true;
        },
        cancelOperation,
        disposeOperation,
        async dispose() {
            if (disposed) return;
            disposed = true;
            operations.forEach(operation => {
                operation.accepting = false;
                operation.projecting = false;
            });
            await coordinator.dispose();
            await Promise.allSettled([...operations.values()].map(operation => operation.chain));
            operations.clear();
            consumers.clear();
            messageOperations.clear();
            retiredSessions.clear();
        },
    });
}
