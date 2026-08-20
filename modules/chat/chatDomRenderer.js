/**
 * DOM adapter for a chat surface. It owns the root contract and delegates
 * rendering operations to the existing renderer during the migration.
 */
export function createChatDomRenderer({ root, renderer, disposeRenderer = null }) {
    if (!root || typeof root.querySelector !== 'function') throw new TypeError('ChatDomRenderer requires a root element');
    if (!renderer) throw new TypeError('ChatDomRenderer requires a renderer adapter');
    let disposed = false;
    const pending = new Set();
    const ownedDisposers = [];
    const assertActive = () => { if (disposed) throw new Error('ChatDomRenderer is disposed'); };
    const track = (operation) => {
        const promise = Promise.resolve(operation);
        pending.add(promise);
        promise.finally(() => pending.delete(promise)).catch(() => {});
        return promise;
    };
    return {
        get root() { return root; },
        own(disposer) { assertActive(); if (typeof disposer !== 'function') throw new TypeError('ChatDomRenderer owner requires a disposer'); ownedDisposers.push(disposer); },
        renderMessage(...args) { if (disposed) return Promise.reject(new Error('ChatDomRenderer is disposed')); const options = args[4] || {}; args[4] = { ...options, root }; return track(renderer.renderMessage(...args)); },
        renderBatch(...args) { if (disposed) return Promise.reject(new Error('ChatDomRenderer is disposed')); const options = args[3] || {}; args[3] = { ...options, root }; return track(renderer.renderMessageBatch(...args)); },
        renderHistory(...args) { if (disposed) return Promise.reject(new Error('ChatDomRenderer is disposed')); const options = args[1] || {}; args[1] = { ...options, root }; return track(renderer.renderHistory(...args)); },
        updateStreaming(...args) { if (disposed) return Promise.reject(new Error('ChatDomRenderer is disposed')); return track(renderer.updateMessageContent?.(...args)); },
        startStreaming(...args) {
            if (disposed) return Promise.reject(new Error('ChatDomRenderer is disposed'));
            return track(renderer.startStreamingMessage?.(...args));
        },
        appendStreaming(...args) {
            if (disposed) return false;
            renderer.appendStreamChunk?.(...args);
            return true;
        },
        projectStreamTerminal(...args) {
            if (disposed) return Promise.reject(new Error('ChatDomRenderer is disposed'));
            return track(renderer.projectStreamTerminal?.(...args));
        },
        discardStreaming(...args) { if (disposed) return; return renderer.discardStreamingMessage?.(...args); },
        removeMessage(...args) { assertActive(); return track(renderer.removeMessageById(...args)); },
        async dispose({ clear = false } = {}) {
            if (disposed) return;
            disposed = true;
            await Promise.allSettled(ownedDisposers.splice(0).reverse().map(disposeOwned => Promise.resolve().then(disposeOwned)));
            await Promise.allSettled([...pending]);
            await disposeRenderer?.();
            if (clear) root.replaceChildren();
        }
    };
}
