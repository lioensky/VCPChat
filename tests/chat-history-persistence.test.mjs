import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatHistoryPersistence, createTransientChatHistoryPersistence } from '../modules/chat/chatHistoryPersistence.js';

const projected = history => ({
    messageId: 'assistant-a',
    context: { agentId: 'agent', topicId: 'topic' },
    content: 'answer a',
    finishReason: 'completed',
    history,
});

test('terminal persistence merges reverse-completing messages by identity and chronological order', async () => {
    let durable = [
        { id: 'user-a', role: 'user', content: 'a', timestamp: 1 },
        { id: 'user-b', role: 'user', content: 'b', timestamp: 3 },
        { id: 'assistant-b', role: 'assistant', content: 'answer b', timestamp: 4 },
    ];
    const persistence = createChatHistoryPersistence({
        async getHistory() { return durable.map(message => ({ ...message })); },
        async saveHistory(_itemId, _itemType, _topicId, history) { durable = history; },
    });

    await persistence.commit(projected([
        { id: 'user-a', role: 'user', content: 'a', timestamp: 1 },
        { id: 'assistant-a', role: 'assistant', content: 'answer a', timestamp: 2 },
        { id: 'user-b', role: 'user', content: 'b', timestamp: 3 },
        { id: 'pending', role: 'assistant', isPendingStream: true, timestamp: 5 },
    ]));

    assert.deepEqual(durable.map(message => message.id), ['user-a', 'assistant-a', 'user-b', 'assistant-b']);
});

test('terminal persistence propagates read and write failures without a fallback overwrite', async () => {
    const readFailure = createChatHistoryPersistence({
        async getHistory() { throw new Error('read failed'); },
        async saveHistory() { assert.fail('save must not run after a failed durable read'); },
    });
    await assert.rejects(readFailure.commit(projected([])), /read failed/);

    const writeFailure = createChatHistoryPersistence({
        async getHistory() { return []; },
        async saveHistory() { throw new Error('write failed'); },
    });
    await assert.rejects(writeFailure.commit(projected([])), /write failed/);
});

test('temporary assistant and group projections do not write renderer-owned history', async () => {
    let writes = 0;
    const persistence = createChatHistoryPersistence({
        async getHistory() { return []; },
        async saveHistory() { writes += 1; },
    });
    await persistence.commit({ ...projected([]), context: { agentId: 'a', topicId: 'assistant_chat' } });
    await persistence.commit({ ...projected([]), context: { groupId: 'g', topicId: 't', isGroupMessage: true } });
    assert.equal(writes, 0);
});

test('auxiliary session persistence updates transient history without claiming durability', async () => {
    let sessionHistory = [{ id: 'user-a', role: 'user', content: 'question', timestamp: 1 }];
    const persistence = createTransientChatHistoryPersistence({
        async getHistory() { return sessionHistory; },
        async saveHistory(_itemId, _itemType, _topicId, history) { sessionHistory = history; },
    });

    assert.equal(persistence.durable, false);
    await persistence.commit({
        messageId: 'assistant-a',
        finishReason: 'completed',
        content: 'answer',
        context: { agentId: 'a', topicId: 'assistant_chat' },
        history: [...sessionHistory, { id: 'assistant-a', role: 'assistant', content: 'answer', timestamp: 2 }],
    });
    assert.deepEqual(sessionHistory.map(message => message.id), ['user-a', 'assistant-a']);
});

test('terminal persistence preserves concurrent durable fields outside the owned stream terminal', async () => {
    let durable = [
        { id: 'user-a', role: 'user', content: 'durable edited question', timestamp: 1, edited: true },
        { id: 'assistant-a', role: 'assistant', content: 'partial', timestamp: 2, feedback: 'liked' },
    ];
    const persistence = createChatHistoryPersistence({
        async getHistory() { return durable.map(message => ({ ...message })); },
        async saveHistory(_itemId, _itemType, _topicId, history) { durable = history; },
    });

    await persistence.commit(projected([
        { id: 'user-a', role: 'user', content: 'stale question', timestamp: 1 },
        { id: 'assistant-a', role: 'assistant', content: 'answer a', timestamp: 2, finishReason: 'completed' },
    ]));

    assert.deepEqual(durable.find(message => message.id === 'user-a'), {
        id: 'user-a',
        role: 'user',
        content: 'durable edited question',
        timestamp: 1,
        edited: true,
    });
    assert.deepEqual(durable.find(message => message.id === 'assistant-a'), {
        id: 'assistant-a',
        role: 'assistant',
        content: 'answer a',
        timestamp: 2,
        feedback: 'liked',
        finishReason: 'completed',
    });
});
