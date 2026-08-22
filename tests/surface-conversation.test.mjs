import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceConversation } from '../modules/chat/surfaceConversation.js';

test('SurfaceConversation owns a fixed identity and copies incoming history', () => {
    const selectedItem = { id: 'agent-a', type: 'agent', name: 'A' };
    const source = [{ id: 'm1' }];
    const conversation = createSurfaceConversation({ selectedItem, topicId: 'topic-a', history: source });

    selectedItem.id = 'agent-b';
    source.push({ id: 'outside' });
    assert.equal(conversation.selectedItemRef.get().id, 'agent-a');
    assert.equal(conversation.topicIdRef.get(), 'topic-a');
    assert.deepEqual(conversation.historyRef.get().map(message => message.id), ['m1']);

    const replacement = [{ id: 'm2' }];
    conversation.replaceHistory(replacement);
    replacement.push({ id: 'outside-2' });
    assert.deepEqual(conversation.historyRef.get().map(message => message.id), ['m2']);
});

test('SurfaceConversation revokes mutation authority on dispose', () => {
    const conversation = createSurfaceConversation({ selectedItem: { id: 'agent-a', type: 'agent' }, topicId: 'topic-a' });
    assert.equal(conversation.historyRef.set([{ id: 'm1' }]), true);
    conversation.dispose();
    conversation.dispose();

    assert.equal(conversation.isActive(), false);
    assert.deepEqual(conversation.historyRef.get(), []);
    assert.equal(conversation.historyRef.set([{ id: 'late' }]), false);
    assert.throws(() => conversation.replaceHistory([{ id: 'late' }]), /disposed/);
});
