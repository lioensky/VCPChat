import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CONVERSATION_CURRENT_CHANNEL,
    getConversationCurrentChannel,
    publishConversationSelection,
    bumpConversationHistory,
    watchConversationCurrent,
    watchConversationHistory
} from '../modules/ui-system/sources/conversation-current.js';

test('conversation.current is one shared channel, created on first use', () => {
    const channel = getConversationCurrentChannel();
    assert.equal(channel, globalThis.VCPStateChannels.get(CONVERSATION_CURRENT_CHANNEL));
    assert.equal(getConversationCurrentChannel(), channel);
    assert.deepEqual({ ...channel.get() }, { itemId: null, itemType: null, topicId: null, historyRevision: 0 });
});

test('history writes only reach history watchers while the conversation stays the same', () => {
    publishConversationSelection({ itemId: 'agent-a', itemType: 'agent', topicId: 't1' });
    const history = [];
    const changes = [];
    const offHistory = watchConversationHistory(value => history.push(value.historyRevision));
    const offCurrent = watchConversationCurrent((value, prev) => changes.push([prev.topicId, value.topicId]));
    const start = getConversationCurrentChannel().get().historyRevision;

    bumpConversationHistory();
    bumpConversationHistory();
    assert.deepEqual(history, [start + 1, start + 2]);

    // 切会话：历史订阅者不收（换了会话由切换订阅者重新读），修订号接着往上走
    publishConversationSelection({ itemId: 'agent-a', itemType: 'agent', topicId: 't2' });
    assert.deepEqual(history, [start + 1, start + 2]);
    assert.deepEqual(changes.at(-1), ['t1', 't2']);
    assert.equal(getConversationCurrentChannel().get().historyRevision, start + 2);

    // 同一个会话再确认一次不算变化
    const before = changes.length;
    publishConversationSelection({ itemId: 'agent-a', itemType: 'agent', topicId: 't2' });
    assert.equal(changes.length, before);

    offHistory();
    offCurrent();
    bumpConversationHistory();
    assert.deepEqual(history, [start + 1, start + 2]);
    assert.equal(changes.length, before);
});

test('a missing selection is published as nulls, not undefined', () => {
    publishConversationSelection({ itemId: undefined, topicId: undefined });
    const value = getConversationCurrentChannel().get();
    assert.equal(value.itemId, null);
    assert.equal(value.itemType, null);
    assert.equal(value.topicId, null);
    assert.ok(Object.isFrozen(value));
});
