'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('durable terminal submits only target assistant without reading or saving a stale history snapshot', async () => {
    const { createChatHistoryPersistence } = await import('../modules/chat/chatHistoryPersistence.js');
    const calls = [];
    const provider = createChatHistoryPersistence({
        getHistory() { throw new Error('must not read stale snapshot'); },
        saveHistory() { throw new Error('must not replace history'); },
        persistAssistant: async (...args) => { calls.push(args); return { success: true }; },
    });
    const terminal = { id: 'reply', role: 'assistant', content: 'final', isThinking: false };
    const projected = { messageId: 'reply', context: { agentId: 'a', topicId: 't' },
        content: 'final', finishReason: 'completed',
        history: [{ id: 'old', role: 'user', content: 'stale edit' }, terminal] };
    await provider.commit(projected);
    assert.deepEqual(calls, [[{ itemId: 'a', itemType: 'agent', topicId: 't' }, terminal]]);
});

test('atomic terminal rejection propagates rather than falling back to whole-history save', async () => {
    const { createChatHistoryPersistence } = await import('../modules/chat/chatHistoryPersistence.js');
    const provider = createChatHistoryPersistence({
        getHistory() { throw new Error('unexpected read'); },
        saveHistory() { throw new Error('unexpected fallback'); },
        persistAssistant: async () => ({ success: false, error: 'disk failed' }),
    });
    await assert.rejects(provider.commit({
        messageId: 'reply', context: { agentId: 'a', topicId: 't' },
        history: [{ id: 'reply', role: 'assistant', content: 'final' }],
    }), /disk failed/);
});
test('side-chat children retain their separate persistence contract instead of ordinary topic validation', async () => {
    const { createChatHistoryPersistence } = await import('../modules/chat/chatHistoryPersistence.js');
    let saved;
    const provider = createChatHistoryPersistence({
        getHistory: async () => [{ id: 'human', role: 'user', content: 'question' }],
        saveHistory: async (_id, _type, _topic, history) => { saved = history; return { success: true }; },
        persistAssistant: async () => { assert.fail('side chat must not use ordinary topic validator'); },
    });
    await provider.commit({
        messageId: 'reply', context: { agentId: 'a', topicId: 'sidechat_1700000000000_abc123' },
        history: [{ id: 'reply', role: 'assistant', content: 'answer' }],
    });
    assert.deepEqual(saved.map(message => message.id).sort(), ['human', 'reply']);
});