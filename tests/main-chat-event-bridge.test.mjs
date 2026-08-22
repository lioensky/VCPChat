import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatEventBridge } from '../modules/renderer/mainChatEventBridge.js';

test('routes stream events to the owned consumer and disposes the preload subscription', async () => {
    let listener;
    let unsubscribed = 0;
    const calls = [];
    const bridge = createMainChatEventBridge({
        chatAPI: { onVCPStreamEvent(handler) { listener = handler; return () => { unsubscribed += 1; }; } },
        acceptStreamEvent(event) { calls.push(['stream', event]); return event.type === 'data'; },
        consumeNonStreamingEvent(event) { calls.push(['non-stream', event]); return event.type === 'full_response'; },
        onUnhandled(message, event) { calls.push(['unhandled', message, event]); },
    });
    assert.equal(await listener({ type: 'data', messageId: 'm1' }), true);
    assert.equal(await listener({ type: 'full_response', messageId: 'm1' }), true);
    assert.equal(await listener({ type: 'unknown', messageId: 'm1' }), false);
    assert.equal(calls[0][0], 'stream');
    assert.equal(calls[1][0], 'stream');
    assert.equal(calls[2][0], 'non-stream');
    assert.equal(calls.at(-1)[0], 'unhandled');
    bridge.dispose();
    assert.equal(unsubscribed, 1);
    assert.equal(await listener({ type: 'data', messageId: 'late' }), false);
});

test('rejects malformed events without touching the stream consumer', async () => {
    let listener;
    let accepted = 0;
    const bridge = createMainChatEventBridge({
        chatAPI: { onVCPStreamEvent(handler) { listener = handler; return () => {}; } },
        acceptStreamEvent() { accepted += 1; return true; },
        onUnhandled() {},
    });
    assert.equal(await listener({ type: 'data' }), false);
    assert.equal(accepted, 0);
    bridge.dispose();
});
