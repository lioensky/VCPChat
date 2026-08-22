import { createChatSurface } from '../chat/chatSurface.js';
import { createStreamConsumerRegistry } from '../chat/streamConsumerRegistry.js';
import { createVcpStreamBridge } from '../chat/vcpStreamBridge.js';
import { createMainChatStreamConsumer } from './mainChatStreamConsumer.js';

function createStreamCapabilities(root, services) {
    const required = ['streamProjection', 'historyPersistence', 'messageRenderer', 'getSelection', 'getTopicId'];
    for (const name of required) {
        if (!services?.[name]) throw new TypeError(`MainChatSurfaceAdapter requires stream service: ${name}`);
    }
    const ownerDocument = root.ownerDocument;
    const reportError = services.reportError || console.error;
    return Object.freeze({
        start: message => services.streamProjection.startStreamingMessage(message),
        append: (messageId, chunk, context, operationId) => services.streamProjection.appendStreamChunk(messageId, chunk, context, operationId),
        projectTerminal: (messageId, finishReason, context, payload) => (
            services.streamProjection.projectStreamTerminal(messageId, finishReason, context, payload)
        ),
        persistTerminal: projected => services.historyPersistence.commit(projected),
        dispatchTerminal: detail => services.dispatchTerminal?.(detail),
        onSettled(value) {
            services.notifySendStateChanged?.(value);
        },
        reportError,
        async afterPersist({ terminal, finalized, context, messageId }) {
            const finalizedContext = finalized?.context || context;
            const finalizedContent = finalized?.content || terminal.fullResponse || '';
            const selected = services.getSelection();
            const relevant = finalizedContext
                && selected
                && (finalizedContext.groupId ? finalizedContext.groupId === selected.id : finalizedContext.agentId === selected.id)
                && finalizedContext.topicId === services.getTopicId();
            const effects = [];
            if (terminal.kind === 'completed' && finalizedContext && !finalizedContext.isGroupMessage && relevant) {
                effects.push(Promise.resolve().then(() => services.chatManager?.attemptTopicSummarizationIfNeeded?.()));
            }
            effects.push(Promise.resolve().then(() => services.flowlockManager?.handleFinalizedMessage?.({
                type: terminal.kind === 'failed' ? 'error' : 'end', messageId,
                context: finalizedContext, content: finalizedContent,
                finishReason: finalized?.finishReason || terminal.finishReason || terminal.kind,
                error: terminal.error || null,
            })));
            const results = await Promise.allSettled(effects);
            results.forEach(result => {
                if (result.status === 'rejected') reportError('[MainChatSurfaceAdapter] post-commit side effect failed', result.reason);
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
    ownerWindow = root?.ownerDocument?.defaultView,
    onDispose = null,
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
    const unloadHandler = () => { void api.dispose(); };
    ownerWindow?.addEventListener?.('beforeunload', unloadHandler, { once: true });
    const registerStreamRoute = (messageId, route) => {
        const release = streamRoutes.register(messageId, route);
        const ownedRelease = () => release();
        ownedRelease.retract = () => {
            streamRoutes.claim(messageId)?.settle?.({
                event: Object.freeze({ type: 'discarded', messageId, reason: 'surface-route-retracted' }),
                finalized: null,
                context: null,
                messageId,
            });
            release.retract();
            return bridge.disposeOperation(messageId, 'surface-route-retracted');
        };
        ownedRelease.cancel = reason => bridge.cancelOperation(messageId, reason || 'surface-operation-cancelled');
        return ownedRelease;
    };
    const api = Object.freeze({
        surface,
        domRenderer: surface.renderer,
        streamRoutes: Object.freeze({ register: registerStreamRoute }),
        acceptStreamEvent(event) { return disposed ? false : bridge.accept(event); },
        cancelStream(messageId, reason) { return disposed ? Promise.resolve(null) : bridge.cancelOperation(messageId, reason); },
        async dispose() {
            if (disposed) return;
            disposed = true;
            ownerWindow?.removeEventListener?.('beforeunload', unloadHandler);
            streamRoutes.dispose();
            await bridge.dispose();
            await surface.dispose();
            await onDispose?.();
        },
    });
    return api;
}
