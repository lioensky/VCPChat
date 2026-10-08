import { createChatOperations } from '../chat/chatOperation.js';
import { createMainChatSurfaceAdapter } from './mainChatSurfaceAdapter.js';

/**
 * Owns the main chat Surface composition. This module deliberately receives
 * already-created providers; it does not discover renderer globals or bind
 * application services itself.
 */
export function createMainChatComposition({
    root,
    messageInput,
    messageRenderer,
    streamProjection,
    chatRepository,
    historyPersistence,
    presentationState,
    renderDependencies,
    chatManager,
    flowlockManager,
    currentSelection,
    currentTopicId,
    chatWindow,
    dispatchTerminal,
    notifySendStateChanged,
    interrupt,
    showForwardModal,
    provideCapabilities,
    capabilitySnapshot,
    settings,
    createInternalRenderer,
    disposeCapabilities,
}) {
    let focusRecoveryGeneration = 0;
    const recoverFocusedConversation = () => {
        const selection = currentSelection?.();
        const topicId = currentTopicId?.();
        const itemId = selection?.id;
        const itemType = selection?.type || 'agent';
        if (!itemId || !topicId || typeof streamProjection?.reconcileConversation !== 'function') return;

        const generation = ++focusRecoveryGeneration;
        Promise.resolve(streamProjection.reconcileConversation({ itemType, itemId, topicId }))
            .catch(error => {
                if (generation === focusRecoveryGeneration) {
                    console.warn('[MainChatComposition] Focus recovery failed:', error);
                }
            });
    };
    chatWindow?.addEventListener?.('focus', recoverFocusedConversation);
    const adapter = createMainChatSurfaceAdapter({
        root,
        renderer: messageRenderer,
        repository: chatRepository,
        focusTarget: messageInput,
        operations: createChatOperations({
            send: request => chatManager?.sendMessage?.(request),
            cancel: () => interrupt(),
        }),
        presentationState,
        renderDependencies,
        streamServices: {
            streamProjection,
            historyPersistence,
            messageRenderer,
            chatManager,
            flowlockManager,
            getSelection: currentSelection,
            getTopicId: currentTopicId,
            dispatchTerminal,
            notifySendStateChanged,
        },
        disposeRenderer: async () => {
            await messageRenderer.disposeRootResources(root);
            messageRenderer.disposeRendererResources();
            await streamProjection?.dispose?.();
        },
        ownerWindow: chatWindow,
        onDispose: async () => {
            focusRecoveryGeneration += 1;
            chatWindow?.removeEventListener?.('focus', recoverFocusedConversation);
            await disposeCapabilities?.();
        },
    });

    const release = provideCapabilities?.({
        repository: chatRepository,
        getSnapshot: capabilitySnapshot,
        createRenderer: createInternalRenderer,
        manager: chatManager,
        presentation: presentationState,
        settings,
    }) || null;

    messageRenderer.setContextMenuDependencies({
        showForwardModal,
        acceptStreamEvent: event => adapter.acceptStreamEvent(event),
        startStream: (message, messageItem) => adapter.startStream(message, messageItem),
        cancelStream: (messageId, reason) => adapter.cancelStream(messageId, reason),
    });

    return Object.freeze({
        adapter,
        surface: adapter.surface,
        domRenderer: adapter.domRenderer,
        releaseCapabilities: release,
    });
}
