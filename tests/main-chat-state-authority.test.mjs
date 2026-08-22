import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatStateAuthority } from '../modules/chat/mainChatStateAuthority.js';

test('main chat state exposes immutable snapshots through a read-only consumer', () => {
    const authority = createMainChatStateAuthority();
    const source = { id: 'agent-a', type: 'agent', config: { model: 'x' } };
    authority.setSelectedItem(source);
    authority.setTopicId('topic-a');
    authority.historyRef.set([{ id: 'message-a' }]);
    source.id = 'mutated';

    const snapshot = authority.consumer.snapshot();
    assert.equal(snapshot.selectedItem.id, 'agent-a');
    assert.equal(snapshot.topicId, 'topic-a');
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.selectedItem), true);
    assert.equal(snapshot.history[0].id, 'message-a');
    assert.equal(Object.isFrozen(snapshot.history), true);
    assert.equal(Object.isFrozen(snapshot.selectedItem.config), true);
    assert.equal(Object.isFrozen(snapshot.history[0]), true);
    assert.throws(() => { snapshot.selectedItem.config.model = 'mutated'; }, /read only|extensible/i);
    assert.throws(() => { snapshot.history[0].id = 'mutated'; }, /read only|extensible/i);
    assert.equal(authority.snapshot().selectedItem.config.model, 'x');
    assert.equal(authority.snapshot().history[0].id, 'message-a');
    assert.equal('setSelectedItem' in authority.consumer, false);
    assert.equal('historyRef' in authority.consumer, false);
});

test('main chat state refs update immutable snapshots without exposing setters', () => {
    const authority = createMainChatStateAuthority();
    const selected = authority.selectedItemRef.set({ id: 'agent-b', config: { model: 'y' } });
    authority.topicIdRef.set('topic-b');
    const snapshot = authority.snapshot();

    assert.equal(selected.id, 'agent-b');
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(snapshot.selectedItem, selected);
    assert.equal(snapshot.topicId, 'topic-b');
    assert.equal('selectedItemRef' in authority.consumer, false);
    assert.equal('topicIdRef' in authority.consumer, false);
});
