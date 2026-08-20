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
    release();
    await adapter.dispose();
    assert.equal(rendererDisposed, true);
    assert.equal(root.hasAttribute('data-chat-surface'), false);
    assert.throws(() => adapter.streamRoutes.register('late', {}), /disposed/);
});
