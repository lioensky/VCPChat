import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatContext } from '../modules/chat/chatContext.js';

test('ChatContext exposes explicit state and ordered domain events', () => {
    const context = createChatContext();
    const events = [];
    const unsubscribe = context.subscribe(event => events.push(event.kind));
    context.setSelectedItem({ id: 'a', type: 'agent' });
    context.setTopicId('t1');
    context.setHistory([{ id: 'm1' }]);
    assert.equal(context.selectedItem.id, 'a');
    assert.equal(context.topicId, 't1');
    assert.deepEqual(context.history, [{ id: 'm1' }]);
    assert.deepEqual(events, ['selected-item', 'topic', 'history']);
    unsubscribe();
    context.dispose();
});

test('ChatContext does not expose mutable history storage', () => {
    const context = createChatContext({ history: [{ id: 'm1' }] });
    context.history.push({ id: 'local-only' });
    assert.deepEqual(context.history, [{ id: 'm1' }]);
    context.setHistory([{ id: 'm2' }]);
    assert.deepEqual(context.history, [{ id: 'm2' }]);
});
