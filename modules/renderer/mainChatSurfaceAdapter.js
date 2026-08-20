import { createChatSurface } from '../chat/chatSurface.js';
import { createStreamConsumerRegistry } from '../chat/streamConsumerRegistry.js';
import { createVcpStreamBridge } from '../chat/vcpStreamBridge.js';
import { createMainChatStreamConsumer } from './mainChatStreamConsumer.js';

function createStreamCapabilities(root, services) {
    const required = ['streamProjection', 'messageRenderer', 'getSelection', 'getTopicId'];
    for (const name of required) {
        if (!services?.[name]) throw new TypeError(`MainChatSurfaceAdapter requires stream service: ${name}`);
    }
    const ownerDocument = root.ownerDocument;
    return Object.freeze({
        start: message => services.streamProjection.startStreamingMessage(message),
        append: (messageId, chunk, context) => services.streamProjection.appendStreamChunk(messageId, chunk, context),
        projectTerminal: (messageId, finishReason, context, payload) => (
            services.streamProjection.projectStreamTerminal(messageId, finishReason, context, payload)
        ),
        persistTerminal: projected => services.streamProjection.persistProjectedStreamTerminal(projected),
        dispatchTerminal: detail => services.dispatchTerminal?.(detail),
        async afterPersist({ terminal, finalized, context, messageId }) {
            const finalizedContext = finalized?.context || context;
            const finalizedContent = finalized?.content || terminal.fullResponse || '';
            const selected = services.getSelection();
            const relevant = finalizedContext
                && selected
                && (finalizedContext.groupId ? finalizedContext.groupId === selected.id : finalizedContext.agentId === selected.id)
                && finalizedContext.topicId === services.getTopicId();
            if (terminal.kind === 'completed' && finalizedContext && !finalizedContext.isGroupMessage && relevant) {
                await services.chatManager?.attemptTopicSummarizationIfNeeded?.();
            }
            await services.flowlockManager?.handleFinalizedMessage?.({
                type: terminal.kind === 'failed' ? 'error' : 'end', messageId,
                context: finalizedContext, content: finalizedContent,
                finishReason: finalized?.finishReason || terminal.finishReason || terminal.kind,
                error: terminal.error || null,
            });
        },
        renderError({ event, context }) {
            const selected = services.getSelection();
            const relevant = context && selected
                && (context.groupId ? context.groupId === selected.id : context.agentId === selected.id)
                && context.topicId === services.getTopicId();
            if (!relevant) return;
            const error = event.outcome?.transport?.error?.message
                || event.outcome?.transport?.error
                || event.outcome?.persistence?.error?.message
                || '未知连接错误';
            const errorContent = root.querySelector(`.message-item[data-message-id="${event.messageId}"] .md-content`);
            if (errorContent) {
                const paragraph = ownerDocument.createElement('p');
                const strong = ownerDocument.createElement('strong');
                strong.style.color = 'red';
                strong.textContent = `流错误: ${error}`;
                paragraph.appendChild(strong);
                errorContent.appendChild(paragraph);
            } else {
                services.messageRenderer.renderMessage({ role: 'system', content: `流处理错误 (ID: ${event.messageId}): ${error}`, timestamp: Date.now(), id: `err_${event.messageId}` });
            }
        },
    });
}

/** Main-window composition owner. Domain protocols remain outside this adapter. */
export function createMainChatSurfaceAdapter({
    root,
    renderer,
    repository,
    focusTarget,
    operations,
    presentationState,
    renderDependencies,
    streamServices,
    disposeRenderer,
}) {
    if (!root || !renderer || !repository) throw new TypeError('MainChatSurfaceAdapter requires root, renderer and repository');
    const streamRoutes = createStreamConsumerRegistry();
    const surface = createChatSurface({
        root,
        renderer,
        repository,
        focusTarget,
        mode: 'interactive',
        operations,
        presentationState,
        disposeRenderer,
    });
    renderer.initializeMessageRenderer({ ...renderDependencies, chatDomRenderer: surface.renderer });
    const streamCapabilities = createStreamCapabilities(root, streamServices);
    const bridge = createVcpStreamBridge({
        createConsumer: initialEvent => createMainChatStreamConsumer(initialEvent, {
            ...streamCapabilities,
            resolveProjection: messageId => streamRoutes.claim(messageId),
        }),
    });
    let disposed = false;
    return Object.freeze({
        surface,
        domRenderer: surface.renderer,
        streamRoutes: Object.freeze({ register: (...args) => streamRoutes.register(...args) }),
        acceptStreamEvent(event) { return disposed ? false : bridge.accept(event); },
        async dispose() {
            if (disposed) return;
            disposed = true;
            streamRoutes.dispose();
            await bridge.dispose();
            await surface.dispose();
        },
    });
}
