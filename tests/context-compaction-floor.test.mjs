import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextCompactionService } from '../modules/chat/contextCompactionService.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
import { effectiveContextHistory } from '../modules/chat/contextCompactionState.js';
import { assembleRequestMessages } from '../modules/chat/chatContextPipeline.js';

const scope = { itemId: 'agent', itemType: 'agent', topicId: 'topic' };
const settings = { enableContextCompaction: true, contextCompactionModel: 'compressor' };
const floor = (id, content = id) => ({ id, role: 'user', content, timestamp: 1 });
const ids = history => history.map(message => message.id);

function fixture(history, onRequest = () => {}) {
    let durable = structuredClone(history);
    const states = [];
    const service = createContextCompactionService({
        historyMutationAuthority: createChatHistoryMutationAuthority({
            repository: {
                getHistory: async () => structuredClone(durable),
                saveHistory: async (_id, _type, _topic, next) => {
                    durable = structuredClone(next);
                    return { success: true };
                },
            },
        }),
        request: async ({ state }) => {
            states.push(structuredClone(state));
            await onRequest(durable);
            return `report-${states.length}`;
        },
    });
    return {
        states, service,
        history: () => structuredClone(durable),
        compact: throughMessageId => service.compact({
            scope, settings, history: structuredClone(durable), throughMessageId,
        }),
    };
}

test('selected floor is inclusive; checkpoint inserts after it without consuming the tail', async () => {
    const original = [floor('a'), floor('b'), floor('c')];
    const f = fixture(original);
    const { message } = await f.compact('b');
    assert.deepEqual(f.states[0].messages.map(entry => entry.content), ['a', 'b']);
    assert.deepEqual(ids(f.history()), ['a', 'b', message.id, 'c']);
    assert.deepEqual(f.history().filter(entry => entry.id !== message.id), original);
    assert.deepEqual(ids(effectiveContextHistory(f.history())), [message.id, 'c']);
    f.service.dispose();
});

test('multiple floors relay only the nearest preceding report and inherit diary state', async () => {
    const diary = '<<<DailyNoteStart>>>\nContent:日记正文\n<<<DailyNoteEnd>>>';
    const f = fixture([floor('a', diary), floor('b'), floor('c'), floor('d')]);
    const first = await f.compact('a');
    const second = await f.compact('c');
    assert.deepEqual(f.states[1].messages.map(entry => entry.content), ['report-1', 'b', 'c']);
    assert.equal(f.states[1].previousCheckpoint, 'report-1');
    assert.deepEqual(second.message.contextCompaction.diaries, first.message.contextCompaction.diaries);
    assert.equal(second.message.contextCompaction.diaries.length, 1);
    assert.deepEqual(ids(f.history()), ['a', first.message.id, 'b', 'c', second.message.id, 'd']);
    const third = await f.compact();
    assert.deepEqual(f.states[2].messages.map(entry => entry.content), ['report-2', 'd']);
    assert.deepEqual(ids(effectiveContextHistory(f.history())), [third.message.id]);
    f.service.dispose();
});

test('inserting before an existing later checkpoint cannot import future state or supersede it', async () => {
    const f = fixture([floor('a'), floor('b'), floor('c'), floor('d')]);
    const later = await f.compact('c');
    const earlier = await f.compact('a');
    assert.deepEqual(f.states[1].messages.map(entry => entry.content), ['a']);
    assert.equal(f.states[1].previousCheckpoint, null);
    assert.deepEqual(ids(f.history()), ['a', earlier.message.id, 'b', 'c', later.message.id, 'd']);
    assert.deepEqual(ids(effectiveContextHistory(f.history())), [later.message.id, 'd']);

    // Real outbound assembly also follows floor order, not checkpoint creation time.
    const { messagesForVCP } = await assembleRequestMessages({
        electronAPI: {}, agentConfig: {}, context: { agentId: 'agent' }, history: f.history(),
    });
    assert.equal(messagesForVCP.length, 2);
    assert.equal(messagesForVCP[0].content[0].text, later.message.content);
    assert.equal(messagesForVCP[1].content[0].text, 'd');

    // A branch before the later checkpoint uses the earlier checkpoint instead.
    const branch = f.history().slice(0, 3);
    assert.deepEqual(ids(effectiveContextHistory(branch)), [earlier.message.id, 'b']);
    f.service.dispose();
});

test('tail changes are preserved and do not invalidate a selected-prefix snapshot', async () => {
    const f = fixture([floor('a'), floor('b')], durable => {
        durable[1].content = 'edited tail';
        durable.push(floor('new'));
    });
    const result = await f.compact('a');
    assert.deepEqual(ids(f.history()), ['a', result.message.id, 'b', 'new']);
    assert.equal(f.history()[2].content, 'edited tail');
    f.service.dispose();
});

for (const [name, change] of [
    ['content edit', durable => { durable[0].content = 'changed'; }],
    ['boundary removal', durable => { durable.splice(0, 1); }],
    ['boundary reorder', durable => { durable.reverse(); }],
]) {
    test(`selected prefix rejects concurrent ${name}`, async () => {
        const f = fixture([floor('a'), floor('b')], change);
        await assert.rejects(f.compact('a'), /历史已变化|截止楼层/);
        assert.equal(f.history().some(entry => entry.contextCompaction), false);
        f.service.dispose();
    });
}

test('missing floor fails before model request instead of falling back to whole-topic compression', async () => {
    const f = fixture([floor('a')]);
    await assert.rejects(f.compact('missing'), /截止楼层/);
    assert.equal(f.states.length, 0);
    assert.deepEqual(ids(f.history()), ['a']);
    f.service.dispose();
});

test('compressing a checkpoint floor relays its report, not archived raw messages', async () => {
    const f = fixture([floor('a'), floor('b')]);
    const first = await f.compact('a');
    const second = await f.compact(first.message.id);
    assert.deepEqual(f.states[1].messages.map(entry => entry.content), ['report-1']);
    assert.deepEqual(ids(f.history()), ['a', first.message.id, second.message.id, 'b']);
    assert.deepEqual(ids(effectiveContextHistory(f.history())), [second.message.id, 'b']);
    f.service.dispose();
});