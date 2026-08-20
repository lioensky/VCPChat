import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainChatStateAuthority } from '../modules/chat/mainChatStateAuthority.js';

test('main chat state exposes immutable snapshots through a read-only consumer', () => {
    const authority = createMainChatStateAuthority();
    const source = { id: 'agent-a', type: 'agent', config: { model: 'x' } };
    authority.setSelectedItem(source);
    authority.setTopicId('topic-a');
    source.id = 'mutated';

    const snapshot = authority.consumer.snapshot();
    assert.equal(snapshot.selectedItem.id, 'agent-a');
    assert.equal(snapshot.topicId, 'topic-a');
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.selectedItem), true);
    assert.equal('setSelectedItem' in authority.consumer, false);
});
