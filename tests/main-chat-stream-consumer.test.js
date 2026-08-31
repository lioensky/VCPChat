const test = require('node:test');
const assert = require('node:assert/strict');

test('send-state projection settles immediately after terminal projection, before durable persistence', async () => {
    const { createMainChatStreamConsumer } = await import('../modules/renderer/mainChatStreamConsumer.js');

    let releasePersistence;
    const persistenceGate = new Promise(resolve => { releasePersistence = resolve; });
    const calls = [];
    const capabilities = {
        start: async () => {},
        append() {},
        projectTerminal: async () => {
            calls.push('project-terminal');
            return {
                messageId: 'terminal-order',
                context: { agentId: 'agent-a', topicId: 'topic-a' },
                content: 'done',
                finishReason: 'completed',
                history: [],
            };
        },
        onProjectionSettled() {
            calls.push('projection-settled');
        },
        async persistTerminal() {
            calls.push('persist-start');
            await persistenceGate;
            calls.push('persist-end');
            return { success: true };
        },
        setPersistenceState() {},
        async afterPersist() {},
    };
    const consumer = createMainChatStreamConsumer({
        type: 'start',
        messageId: 'terminal-order',
        streamOperationId: 'operation-a',
        context: { agentId: 'agent-a', topicId: 'topic-a' },
    }, capabilities);

    await consumer.prepare({
        type: 'start',
        messageId: 'terminal-order',
        streamOperationId: 'operation-a',
        context: { agentId: 'agent-a', topicId: 'topic-a' },
    });

    const persistence = consumer.persist({
        terminal: {
            kind: 'completed',
            fullResponse: 'done',
            context: { agentId: 'agent-a', topicId: 'topic-a' },
        },
        snapshot: { text: 'done' },
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, [
        'project-terminal',
        'projection-settled',
        'persist-start',
    ]);

    releasePersistence();
    await persistence;
    assert.deepEqual(calls, [
        'project-terminal',
        'projection-settled',
        'persist-start',
        'persist-end',
    ]);
});