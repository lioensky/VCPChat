import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopicSelectionReadiness } from '../modules/renderer/topicSelectionReadiness.js';

test('topic selection readiness defers and consumes the latest selection without ambient state', () => {
    const readiness = createTopicSelectionReadiness();
    assert.equal(readiness.isReady(), false);
    readiness.defer({ itemId: 'agent-a', itemType: 'agent', topicId: 'topic-a' });
    readiness.defer({ itemId: 'agent-a', itemType: 'agent', topicId: 'topic-b' });
    assert.deepEqual(readiness.takePending(), { itemId: 'agent-a', itemType: 'agent', topicId: 'topic-b' });
    assert.equal(readiness.takePending(), null);

    readiness.setReady(true);
    assert.equal(readiness.isReady(), true);
    readiness.defer({ itemId: 'agent-a', itemType: 'agent', topicId: 'topic-c' });
    assert.deepEqual(readiness.takePending(), { itemId: 'agent-a', itemType: 'agent', topicId: 'topic-c' });
    readiness.setReady(false);
    assert.equal(readiness.isReady(), false);
});

test('topic selection readiness clearPending revokes a queued selection', () => {
    const readiness = createTopicSelectionReadiness();
    readiness.defer({ itemId: 'agent-a', itemType: 'agent', topicId: 'topic-a' });
    readiness.clearPending();
    assert.equal(readiness.takePending(), null);
});
