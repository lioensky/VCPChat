import test from 'node:test';
import assert from 'node:assert/strict';
import { createNonStreamingEventConsumer } from '../modules/renderer/nonStreamingEventConsumer.js';

test('non-streaming consumer projects only already-persisted current-surface events', async () => {
    const calls = [];
    const renderTarget = {
        root: {},
        removeMessage(id, save) { calls.push(['remove', id, save]); },
    };
    const messageRenderer = {
        renderFullMessageProjection(...args) { calls.push(['full', ...args]); return Promise.resolve(); },
    };
    const consumer = createNonStreamingEventConsumer({
        renderTarget,
        messageRenderer,
        viewAuthority: { isCurrent: context => context?.topicId === 'current' },
    });
    assert.equal(consumer.consume({ type: 'full_response', messageId: 'm1', fullResponse: 'ok', context: { topicId: 'background' } }), false);
    assert.equal(consumer.consume({ type: 'full_response', messageId: 'm1', fullResponse: 'ok', context: { topicId: 'current' } }), true);
    assert.equal(consumer.consume({ type: 'remove_message', messageId: 'm1', context: { topicId: 'current' } }), true);
    assert.deepEqual(calls.map(call => call[0]), ['full', 'remove']);
    assert.equal(calls[1][2], false);
    consumer.dispose();
    assert.equal(consumer.consume({ type: 'remove_message', messageId: 'm2', context: { topicId: 'current' } }), false);
});
