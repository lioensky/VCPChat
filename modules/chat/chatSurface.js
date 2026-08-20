import { createChatDomRenderer } from './chatDomRenderer.js';

/**
 * Lifecycle owner for a chat presentation surface. The first consumer is the
 * main chat; the same contract can later host a standalone read-only view.
 */
export function createChatSurface({ root, renderer, repository, focusTarget = null, mode = 'readonly', slots = null, operations = null, presentationState = null, disposeRenderer = null }) {
    if (!root) throw new TypeError('ChatSurface requires a root element');
    const domRenderer = createChatDomRenderer({ root, renderer, disposeRenderer });
    let disposed = false;
    let operationToken = 0;
    const mountedSlotDisposers = [];
    root.dataset.chatSurface = mode;
    root.setAttribute('aria-live', 'polite');

    const surface = {
        root,
        renderer: domRenderer,
        operations,
        get disposed() { return disposed; },
        async loadHistory(itemId, itemType, topicId, options) {
            if (disposed) throw new Error('ChatSurface is disposed');
            const token = ++operationToken;
            const history = await repository.getHistory(itemId, itemType, topicId);
            if (disposed || token !== operationToken) return { stale: true };
            await domRenderer.renderHistory(history, options);
            return { history, stale: false };
        },
        focus() { if (!disposed) (focusTarget || root).focus?.(); },
        mountSlot(slot, slotRoot, snapshot = {}) {
            if (disposed || !slots) return;
            mountedSlotDisposers.push(...slots.mount(slot, slotRoot, { mode, ...(presentationState?.getSnapshot?.() || {}), ...snapshot }));
        },
        sendMessage(request) {
            if (!operations) return Promise.reject(new Error('ChatSurface has no send capability'));
            return operations.sendMessage(request);
        },
        cancelMessage() { return operations?.cancel?.() || Promise.resolve(false); },
        async dispose() {
            if (disposed) return;
            disposed = true;
            operationToken += 1;
            await domRenderer.dispose();
            await operations?.dispose?.();
            mountedSlotDisposers.splice(0).reverse().forEach(disposeSlot => disposeSlot());
            delete root.dataset.chatSurface;
            root.removeAttribute('aria-live');
        }
    };
    return surface;
}

export function createReadOnlyChatSurface(options) {
    return createChatSurface({ ...options, mode: 'readonly' });
}
