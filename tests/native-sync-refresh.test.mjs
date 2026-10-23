import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeHistoryRefresh } from '../modules/chat/nativeHistoryRefresh.js';
import { createMainChatStreamConsumer } from '../modules/renderer/mainChatStreamConsumer.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
test('native refresh waits for terminal saving after active stream ownership was removed', async () => {
    let active = true, writes = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const context = { agentId: 'a', topicId: 't' };
    const refresh = createNativeHistoryRefresh({ getSelection: () => ({ id: 'a', type: 'agent' }), getTopicId: () => 't', hasActiveStream: () => active, syncHistory: async () => { writes++; } });
    const consumer = createMainChatStreamConsumer({ messageId: 'terminal', context }, {
        beginHistoryPersistence: c => refresh.beginPersistence(c),
        projectTerminal: () => { active = false; return { messageId: 'terminal', context, history: [] }; },
        persistTerminal: async () => { await gate; return {}; },
    });
    const saving = consumer.persist({ terminal: { kind: 'completed' } });
    await tick(); assert.equal(active, false);
    refresh.consume({ ownerType: 'agent', ownerId: 'a', topicId: 't' });
    await tick(); assert.equal(writes, 0); assert.equal(refresh.diagnostics().saving, 1);
    release(); await saving; await tick(); assert.equal(writes, 1); refresh.dispose();
});
test('Owner type, topic switch, editing and teardown guard delayed remote refresh', async () => {
    let selected = { id: 'a', type: 'agent' }, topic = 't', editing = true, writes = 0;
    const refresh = createNativeHistoryRefresh({ getSelection: () => selected, getTopicId: () => topic, isEditing: () => editing, syncHistory: async () => { writes++; } });
    refresh.consume({ ownerType: 'group', ownerId: 'a', topicId: 't' });
    refresh.consume({ ownerType: 'agent', ownerId: 'a', topicId: 't' });
    await tick(); assert.equal(writes, 0);
    topic = 'new'; editing = false; await refresh.drain(); assert.equal(writes, 0);
    refresh.consume({ ownerType: 'agent', ownerId: 'a', topicId: 'new' }); await tick(); assert.equal(writes, 1);
    refresh.dispose(); refresh.consume({ ownerType: 'agent', ownerId: 'a', topicId: 'new' }); await tick(); assert.equal(writes, 1);
});
test('a terminal entering saving during an in-flight reread invalidates that refresh and is retried', async () => {
    let releaseRead, reads = 0, applied = 0;
    const gate = new Promise(resolve => { releaseRead = resolve; });
    const refresh = createNativeHistoryRefresh({ getSelection: () => ({ id: 'a', type: 'agent' }), getTopicId: () => 't', syncHistory: async (_id, _type, _topic, allowed) => { if (++reads === 1) await gate; if (allowed()) applied++; } });
    refresh.consume({ ownerType: 'agent', ownerId: 'a', topicId: 't' });
    await tick();
    const saved = refresh.beginPersistence({ agentId: 'a', topicId: 't' });
    releaseRead(); await tick(); assert.equal(applied, 0);
    saved(true); await tick(); assert.equal(applied, 1); refresh.dispose();
});
