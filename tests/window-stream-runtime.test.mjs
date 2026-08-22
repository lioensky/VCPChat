import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createWindowStreamRuntime } from '../modules/renderer/windowStreamRuntime.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
        contextFilter: context => context?.topicId === 'voicechat_a',
        onSettled: ({ event }) => { settledType = event.type; },
        reportError: () => {},
    });
    runtime.accept({ type: 'end', messageId: 'm2', context: { agentId: 'a', topicId: 'voicechat_a' } });
    for (let attempt = 0; attempt < 50 && settledType === null; attempt += 1) await Promise.resolve();
    assert.equal(settledType, 'failed');
    await runtime.dispose();
});

test('auxiliary window close cancellation waits for the operation terminal', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const calls = [];
    const runtime = createWindowStreamRuntime({
        root,
        streamProjection: {
            startStreamingMessage() { calls.push('start'); },
            appendStreamChunk() { calls.push('chunk'); },
            async projectStreamTerminal(_id, reason) {
                calls.push(`project:${reason}`);
                return { messageId: 'm3', finishReason: reason, context: { agentId: 'a', topicId: 'assistant_chat' }, history: [] };
            },
        },
        historyPersistence: { async commit(value) { calls.push('persist'); return value; } },
        contextFilter: context => context?.topicId === 'assistant_chat',
        onSettled: ({ event }) => calls.push(`settled:${event.type}`),
    });
    runtime.accept({ type: 'data', messageId: 'm3', chunk: 'partial', context: { agentId: 'a', topicId: 'assistant_chat' } });
    const outcome = await runtime.cancel('m3', 'assistant-window-close');
    assert.equal(outcome.kind, 'cancelled');
    assert.deepEqual(calls, ['start', 'chunk', 'project:cancelled', 'persist', 'settled:cancelled']);
    assert.equal(runtime.accept({ type: 'end', messageId: 'm3', context: { agentId: 'a', topicId: 'assistant_chat' } }), false);
    await runtime.dispose();
});

test('voice and assistant windows cancel the real operation before durable close save', () => {
    for (const relativePath of ['Voicechatmodules/voicechat.js', 'rust_assistant_engine/ui/assistant.js']) {
        const source = fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8');
        assert.match(source, /createTransientChatHistoryPersistence/);
        assert.match(source, /await streamRuntime\?\.cancel\(activeStreamingMessageId,/);
        assert.match(source, /let historyMutationAuthority = null/);
        assert.match(source, /historyMutationAuthority = createChatHistoryMutationAuthority/);
        assert.match(source, /await historyMutationAuthority\?\.dispose\(\)/);
        assert.doesNotMatch(source, /const historyMutationAuthority = createChatHistoryMutationAuthority/);
        assert.doesNotMatch(source, /waitForActiveStreamToSettle|Timed out while waiting stream to settle/);
    }
});
