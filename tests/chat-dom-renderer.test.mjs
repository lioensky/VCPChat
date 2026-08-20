import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatDomRenderer } from '../modules/chat/chatDomRenderer.js';

test('ChatDomRenderer delegates operations and rejects work after dispose', async () => {
    const root = new JSDOM('<div id="root"></div>').window.document.querySelector('#root');
    const calls = [];
    const adapter = createChatDomRenderer({ root, renderer: {
        renderHistory: async () => { calls.push('history'); return 'ok'; },
        renderMessage: async () => { calls.push('message'); },
        renderMessageBatch: async () => { calls.push('batch'); },
        removeMessageById: () => calls.push('remove')
    } });
    assert.equal(await adapter.renderHistory([]), 'ok');
    adapter.removeMessage('m1');
    adapter.dispose();
    await assert.rejects(() => adapter.renderMessage({}), /disposed/);
    assert.deepEqual(calls, ['history', 'remove']);
});

test('ChatDomRenderer dispose reaches quiescence for an in-flight render', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    let resolveRender;
    const adapter = createChatDomRenderer({ root, renderer: {
        renderMessage: () => new Promise(resolve => { resolveRender = resolve; })
    } });
    const render = adapter.renderMessage({ id: 'm1' });
    let disposed = false;
    const disposing = adapter.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    resolveRender('done');
    await disposing;
    assert.equal(disposed, true);
    await render;
});

test('ChatDomRenderer passes its root as render context', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    let receivedRoot;
    const adapter = createChatDomRenderer({ root, renderer: {
        renderMessage: async (...args) => { receivedRoot = args[4].root; }
    } });
    await adapter.renderMessage({ id: 'm2' });
    assert.equal(receivedRoot, root);
    await adapter.dispose();
});

test('ChatDomRenderer binds streaming projection to the owning Surface root', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    let receivedMessage;
    const adapter = createChatDomRenderer({ root, renderer: {
        startStreamingMessage: async message => { receivedMessage = message; },
    } });
    await adapter.startStreaming({ id: 'stream-1' });
    assert.equal(receivedMessage.__surfaceRoot, root);
    await adapter.dispose();
});

test('ChatDomRenderer retracts owned routes before waiting for render work', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const calls = [];
    const adapter = createChatDomRenderer({ root, renderer: {} });
    adapter.own(() => calls.push('retract'));
    await adapter.dispose();
    assert.deepEqual(calls, ['retract']);
});
