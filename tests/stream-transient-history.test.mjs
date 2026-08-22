import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamTransientHistory } from '../modules/chat/streamTransientHistory.js';

test('transient stream history owns pending models without performing durable writes', async () => {
    let current = [{ id: 'user-a', role: 'user', timestamp: 1 }];
    let durableReads = 0;
    const provider = createStreamTransientHistory({
        repository: {
            async getHistory() { durableReads += 1; return [{ id: 'user-b', role: 'user', timestamp: 3 }]; },
            async saveHistory() { assert.fail('transient provider must never perform a durable write'); },
        },
        currentHistory: {
            get: () => current,
            replace: history => { current = history; },
        },
    });

    await provider.prepare({ id: 'assistant-a', replyToMessageId: 'user-a', timestamp: 2 }, { agentId: 'a', topicId: 'current' }, { visible: true });
    assert.equal(provider.pendingCount, 1);
    assert.deepEqual(current.map(message => message.id), ['user-a', 'assistant-a']);

    const finalized = await provider.finalize({
        messageId: 'assistant-a', context: { agentId: 'a', topicId: 'current' },
        content: 'answer', finishReason: 'completed', visible: true,
    });
    assert.equal(finalized.message.content, 'answer');
    assert.equal(finalized.message.isPendingStream, undefined);
    assert.equal(provider.pendingCount, 0);
    assert.equal(durableReads, 0);
});

test('background transient models read latest history and preserve reply ordering', async () => {
    let current = [{ id: 'unrelated', timestamp: 99 }];
    const provider = createStreamTransientHistory({
        repository: {
            async getHistory() {
                return [
                    { id: 'user-a', role: 'user', timestamp: 1 },
                    { id: 'user-b', role: 'user', timestamp: 3 },
                ];
            },
        },
        currentHistory: { get: () => current, replace: history => { current = history; } },
    });
    const context = { agentId: 'background', topicId: 'topic' };
    await provider.prepare({ id: 'assistant-a', replyToMessageId: 'user-a', timestamp: 2 }, context, { visible: false });
    const terminal = await provider.finalize({
        messageId: 'assistant-a', context, content: 'done', finishReason: 'completed', visible: false,
    });
    assert.deepEqual(terminal.history.map(message => message.id), ['user-a', 'assistant-a', 'user-b']);
    assert.deepEqual(current.map(message => message.id), ['unrelated'], 'background projection must not replace current Surface history');
});

test('dispose revokes transient history authority and clears pending models', async () => {
    const provider = createStreamTransientHistory({
        repository: { async getHistory() { return []; } },
        currentHistory: { get: () => [], replace() {} },
    });
    await provider.prepare({ id: 'pending' }, { agentId: 'a', topicId: 't' }, { visible: true });
    provider.dispose();
    assert.equal(provider.pendingCount, 0);
    await assert.rejects(provider.prepare({ id: 'late' }, { agentId: 'a', topicId: 't' }), /disposed/);
    assert.equal(await provider.finalize({ messageId: 'pending' }), null);
});
