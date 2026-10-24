import { createVcpStreamBridge } from '../chat/vcpStreamBridge.js';
import { createMainChatStreamConsumer } from './mainChatStreamConsumer.js';

/** Owns the VCP stream bridge and projection capabilities for an auxiliary window. */
export function createWindowStreamRuntime({
    streamProjection,
    historyPersistence,
    root,
    getSelection,
    getTopicId,
    contextFilter,
    getMessageContext = () => ({}),
    dispatchTerminal,
    afterPersist,
    onSettled,
    reportError,
    speech,
} = {}) {
    if (!streamProjection || !historyPersistence || !root || typeof contextFilter !== 'function') {
        throw new TypeError('window stream runtime requires projection, persistence and context filter');
    }
    const bridge = createVcpStreamBridge({
        reportError,
        createConsumer: initialEvent => createMainChatStreamConsumer({
            ...initialEvent,
            context: { ...getMessageContext(), ...(initialEvent.context || {}) },
        }, {
            getSurfaceGeneration: () => 0,
            start: message => {
                speech?.begin(message);
                return streamProjection.startStreamingMessage(message);
            },
            append: (messageId, chunk, context, operationId) => {
                const accepted = streamProjection.appendStreamChunk(messageId, chunk, context, operationId);
                if (accepted !== false) speech?.append(messageId, chunk, operationId);
                return accepted;
            },
            projectTerminal: (messageId, finishReason, context, payload) => {
                speech?.finish(messageId, finishReason, payload);
                return streamProjection.projectStreamTerminal(messageId, finishReason, context, payload);
            },
            persistTerminal: projected => historyPersistence.commit(projected),
            dispatchTerminal,
            reportError,
            async afterPersist(value) { await afterPersist?.(value); },
            onSettled(value) { onSettled?.(value); },
            renderError: ({ event, context }) => {
                if (!contextFilter(context)) return;
                const error = event.outcome?.transport?.error?.message
                    || event.outcome?.transport?.error
                    || event.outcome?.persistence?.error?.message
                    || '未知流错误';
                const content = root.querySelector(`.message-item[data-message-id="${event.messageId}"]`)?.querySelector('.md-content');
                if (content) content.textContent = error;
            },
        }),
    });
    return Object.freeze({
        accept(event) {
            if (!contextFilter(event?.context)) return false;
            return bridge.accept(event);
        },
        cancel(messageId, reason = 'window-close') {
            speech?.cancel(messageId);
            return bridge.cancelOperation(messageId, reason);
        },
        dispose() { speech?.dispose(); return bridge.dispose(); },
        getSelection,
        getTopicId,
    });
}
