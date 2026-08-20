import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createWindowStreamRuntime } from '../modules/renderer/windowStreamRuntime.js';

test('auxiliary window stream runtime owns success, persistence and disposal', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const calls = [];
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    const runtime = createWindowStreamRuntime({
        root,
        streamProjection: {
            startStreamingMessage: message => { calls.push(['start', message.name]); },
            appendStreamChunk: (_id, chunk) => { calls.push(['chunk', chunk]); },
            projectStreamTerminal: async (_id, reason) => ({ messageId: 'm1', finishReason: reason, context: { agentId: 'a', topicId: 'voicechat_a' }, history: [] }),
        },
        historyPersistence: {
            commit: async value => { calls.push(['persist', value.finishReason]); return value; },
        },
        messageRenderer: {},
        getMessageContext: () => ({ agentName: 'Voice Agent' }),
        contextFilter: context => context?.topicId === 'voicechat_a',
        afterPersist: value => { calls.push(['terminal', value.terminal.kind]); },
        onSettled: ({ event }) => { calls.push(['settled', event.type]); settle(); },
    });
    assert.equal(runtime.accept({ type: 'data', messageId: 'm1', chunk: 'hello', context: { agentId: 'a', topicId: 'voicechat_a' } }), true);
    assert.equal(runtime.accept({ type: 'end', messageId: 'm1', context: { agentId: 'a', topicId: 'voicechat_a' } }), true);
    await settled;
    assert.deepEqual(calls, [
        ['start', 'Voice Agent'], ['chunk', 'hello'], ['persist', 'completed'], ['terminal', 'completed'], ['settled', 'completed'],
    ]);
    assert.equal(runtime.accept({ type: 'data', messageId: 'other', context: { topicId: 'other' } }), false);
    await runtime.dispose();
});

test('auxiliary composer settlement still runs when durable commit fails', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    let settledType = null;
    const runtime = createWindowStreamRuntime({
        root,
        streamProjection: {
            startStreamingMessage() {},
            appendStreamChunk() {},
            async projectStreamTerminal() {
                return { messageId: 'm2', finishReason: 'completed', context: { agentId: 'a', topicId: 'voicechat_a' }, history: [] };
            },
        },
        historyPersistence: { async commit() { throw new Error('disk failed'); } },
        messageRenderer: {},
        contextFilter: context => context?.topicId === 'voicechat_a',
        onSettled: ({ event }) => { settledType = event.type; },
        reportError: () => {},
    });
    runtime.accept({ type: 'end', messageId: 'm2', context: { agentId: 'a', topicId: 'voicechat_a' } });
    for (let attempt = 0; attempt < 50 && settledType === null; attempt += 1) await Promise.resolve();
    assert.equal(settledType, 'failed');
    await runtime.dispose();
});
