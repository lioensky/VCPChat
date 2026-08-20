import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMainChatSurfaceAdapter } from '../modules/renderer/mainChatSurfaceAdapter.js';

test('MainChatSurfaceAdapter owns renderer, stream routes and quiescent teardown', async () => {
    const dom = new JSDOM('<main><div id="root"></div><textarea></textarea></main>');
    const root = dom.window.document.getElementById('root');
    let initialized = null;
    let rendererDisposed = false;
    const renderer = {
        initializeMessageRenderer(value) { initialized = value; },
        renderHistory() {}, renderMessage() {},
    };
    const adapter = createMainChatSurfaceAdapter({
        root,
        renderer,
        repository: { getHistory: async () => [], saveHistory() {} },
        focusTarget: dom.window.document.querySelector('textarea'),
        operations: { dispose: async () => {} },
        renderDependencies: {},
        streamServices: {
            streamProjection: {
                startStreamingMessage() {}, appendStreamChunk() {}, projectStreamTerminal() {},
            },
            historyPersistence: { commit() {} },
            messageRenderer: renderer,
            getSelection: () => null,
            getTopicId: () => null,
        },
        disposeRenderer: async () => { rendererDisposed = true; },
    });
    assert.equal(initialized.chatDomRenderer, adapter.domRenderer);
    const release = adapter.streamRoutes.register('m1', { kind: 'main-chat' });
    assert.equal(typeof release.retract, 'function');
    assert.equal(typeof release.cancel, 'function');
    release();
    await adapter.dispose();
    assert.equal(rendererDisposed, true);
    assert.equal(root.hasAttribute('data-chat-surface'), false);
    assert.throws(() => adapter.streamRoutes.register('late', {}), /disposed/);
});

test('MainChatSurfaceAdapter owns the window unload receipt and releases it on dispose', async () => {
    const dom = new JSDOM('<main><div id="root"></div><textarea></textarea>');
    const root = dom.window.document.getElementById('root');
    let disposed = 0;
    const renderer = { initializeMessageRenderer() {}, renderHistory() {}, renderMessage() {} };
    const adapter = createMainChatSurfaceAdapter({
        root,
        renderer,
        repository: { getHistory: async () => [], saveHistory() {} },
        focusTarget: dom.window.document.querySelector('textarea'),
        operations: { dispose: async () => {} },
        renderDependencies: {},
        streamServices: {
            streamProjection: { startStreamingMessage() {}, appendStreamChunk() {}, projectStreamTerminal() {} },
            historyPersistence: { commit() {} },
            messageRenderer: renderer,
            getSelection: () => null,
            getTopicId: () => null,
        },
        disposeRenderer: async () => { disposed += 1; },
        ownerWindow: dom.window,
    });
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, 1);
    await adapter.dispose();
    dom.window.close();
});
