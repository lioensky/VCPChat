'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
    let disk = { entries: [], standaloneLeases: [] };
    let failSave = false;
    const history = [], advances = [];
    const service = new TopicMessageAdmission({
        store: {
            load: async () => structuredClone(disk.entries),
            loadState: async () => structuredClone(disk),
            save: async (entries, standaloneLeases) => {
                if (failSave) throw new Error('journal failed');
                disk = structuredClone({ entries, standaloneLeases });
            },
        },
        validate: async () => {},
        commit: async (_scope, message) => { history.push(message.id); },
        advance: async request => { advances.push(request); },
    });
    await service.initialize();
    await service.acquire(scope, 'old');
    return { service, history, advances, disk: () => disk,
        fail: () => { failSave = true; } };
}

for (const mode of ['empty', 'silent', 'reply', 'human', 'withdrawn']) {
    test(`single chat relay serial handover: ${mode}`, async () => {
        const f = await fixture();
        if (mode !== 'empty') {
            const receipt = await f.service.submit({
                scope, message: { id: 'letter', role: mode === 'human' ? 'user' : 'assistant', content: 'new' },
                triggerPolicy: mode === 'reply' ? 'reply' : 'none',
            });
            if (mode === 'withdrawn') await f.service.withdraw(scope, receipt.entryId);
        }
        const result = await f.service.relay(scope, 'old', { saved: true });
        assert.equal(result.success, true);
        await tick();
        assert.equal(f.advances.length, 1);
        assert.deepEqual(f.history, ['empty', 'withdrawn'].includes(mode) ? [] : ['letter']);
        assert.equal(f.advances[0].continuation, ['empty', 'silent', 'withdrawn'].includes(mode));
        assert.equal(f.advances[0].automatic, mode !== 'human');
        assert.equal(f.disk().standaloneLeases.length, 0);
        assert.equal((await f.service.release(scope, 'old')).code, 'STALE_LEASE');
        await f.service.dispose();
    });
}

test('relay keeps later messages behind the human hard boundary', async () => {
    const f = await fixture();
    for (const [id, role] of [['first', 'assistant'], ['human', 'user'], ['later', 'assistant']]) {
        await f.service.submit({ scope, message: { id, role, content: id } });
    }
    await f.service.relay(scope, 'old', { saved: true });
    await tick();
    assert.deepEqual(f.history, ['first', 'human']);
    assert.equal(f.advances.length, 1);
    assert.equal(f.service.snapshot(scope).find(entry => entry.message.id === 'later').committed, undefined);
    await f.service.dispose();
});

test('relay refuses unsaved, stale and group handovers without removing ownership', async () => {
    const f = await fixture();
    assert.equal((await f.service.relay(scope, 'old')).code, 'UNSAVED_TERMINAL');
    assert.equal((await f.service.relay(scope, 'stale', { saved: true })).code, 'STALE_LEASE');
    assert.equal((await f.service.relay({ ...scope, itemType: 'group' }, 'old', { saved: true })).code, 'SINGLE_CHAT_ONLY');
    assert.equal((await f.service.acquire(scope, 'other')).code, 'TOPIC_BUSY');
    await f.service.dispose();
});

test('relay journal failure retains old memory and durable ownership', async () => {
    const f = await fixture();
    f.fail();
    await assert.rejects(f.service.relay(scope, 'old', { saved: true }), /journal failed/);
    assert.equal(f.disk().standaloneLeases[0].token, 'old');
    assert.equal((await f.service.acquire(scope, 'other')).code, 'TOPIC_BUSY');
    assert.equal(f.advances.length, 0);
    await f.service.dispose();
});
test('original task relay does not consume automatic new-round budget', async () => {
    const f = await fixture();
    f.service.maxAutoRounds = 1;
    let token = 'old';
    for (let index = 0; index < 10; index++) {
        assert.equal((await f.service.relay(scope, token, { saved: true })).success, true);
        await tick();
        assert.equal(f.advances.length, index + 1);
        token = f.advances.at(-1).token;
        assert.equal(f.advances.at(-1).continuation, true);
    }
    assert.deepEqual(f.history, []);
    await f.service.release(scope, token, { saved: true });
    assert.deepEqual(f.service.snapshot(scope), []);
    await f.service.dispose();
});
test('relay cannot bypass another paused entry in the same topic', async () => {
    const f = await fixture();
    await f.service.submit({ scope, message: { id: 'paused', role: 'user', content: 'wait' } });
    f.service.entries = f.service.entries.map(entry => ({ ...entry, state: 'recovered' }));
    assert.equal((await f.service.relay(scope, 'old', { saved: true })).code, 'ADMISSION_PAUSED');
    assert.equal((await f.service.acquire(scope, 'other')).code, 'TOPIC_BUSY');
    assert.deepEqual(f.history, []);
    assert.deepEqual(f.advances, []);
    await f.service.dispose();
});

test('dispatched relay continuation restarts uncertain without chat writes or automatic generation', async () => {
    const f = await fixture();
    await f.service.relay(scope, 'old', { saved: true });
    await tick();
    const disk = structuredClone(f.disk());
    await f.service.dispose();
    const restored = new TopicMessageAdmission({
        store: {
            load: async () => structuredClone(disk.entries),
            loadState: async () => structuredClone(disk),
            save: async () => {},
        },
        validate: async () => {},
        commit: async () => assert.fail('recovery must not append continuation to chat'),
        advance: async () => assert.fail('recovery must not restart generation'),
    });
    await restored.initialize();
    await tick();
    assert.equal(restored.snapshot(scope).length, 1);
    assert.equal(restored.snapshot(scope)[0].kind, 'relay-continuation');
    assert.equal(restored.snapshot(scope)[0].state, 'uncertain');
    assert.equal((await restored.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    assert.equal(restored.leases.size, 0);
    await restored.dispose();
});
test('cancelled relay pauses pending FIFO even when another message arrives', async () => {
    const f = await fixture();
    await f.service.submit({ scope, message: { id: 'human', role: 'user', content: 'first' } });
    assert.equal((await f.service.relay(scope, 'old', { saved: true, cancelled: true })).cancelled, true);
    await f.service.submit({ scope, message: { id: 'later', role: 'user', content: 'later' } });
    await tick();
    assert.deepEqual(f.history, []);
    assert.deepEqual(f.advances, []);
    assert.equal(f.service.snapshot(scope)[0].state, 'recovered');
    assert.equal((await f.service.resume(scope)).success, true);
    await tick();
    assert.deepEqual(f.history, ['human']);
    assert.equal(f.advances.length, 1);
    await f.service.dispose();
});
for (const human of [false, true]) {
    test(`relay at automatic budget preserves pending work; human=${human}`, async () => {
        const f = await fixture();
        f.service.maxAutoRounds = 1;
        await f.service.relay(scope, 'old', { saved: true });
        await tick();
        const token = f.advances.at(-1).token;
        // Consume the next automatic round with a real partner reply request.
        await f.service.submit({ scope, message: { id: 'first', role: 'assistant', content: 'first' }, triggerPolicy: 'reply' });
        await f.service.relay(scope, token, { saved: true });
        await tick();
        const active = f.advances.at(-1).token;
        assert.equal(f.advances.length, 2);
        await f.service.submit({ scope, message: { id: 'next', role: 'assistant', content: 'next' }, triggerPolicy: 'reply' });
        if (human) await f.service.submit({ scope, message: { id: 'human', role: 'user', content: 'continue' } });
        const receipt = await f.service.relay(scope, active, { saved: true });
        await tick();
        if (human) {
            assert.equal(f.advances.length, 3);
            assert.equal(f.advances.at(-1).automatic, false);
            assert.deepEqual(f.history, ['first', 'next', 'human']);
        } else {
            assert.equal(receipt.code, 'AUTO_BUDGET_EXHAUSTED');
            assert.equal(receipt.paused, true);
            assert.equal(f.advances.length, 2);
            assert.deepEqual(f.history, ['first']);
            assert.equal(f.service.snapshot(scope)[0].message.id, 'next');
            assert.equal(f.service.snapshot(scope)[0].state, 'recovered');
            assert.equal(f.service.leases.size, 0);
            assert.equal((await f.service.resume(scope)).success, true);
            await tick();
            assert.equal(f.advances.length, 3);
            assert.deepEqual(f.history, ['first', 'next']);
        }
        await f.service.dispose();
    });
}
test('journal failure during relay admission retains visible work and never dispatches', async () => {
    const f = await fixture();
    await f.service.submit({ scope,
        message: { id: 'letter', role: 'assistant', content: 'pending' }, triggerPolicy: 'reply' });
    const originalSave = f.service.store.save;
    let writes = 0;
    f.service.store.save = async (...args) => {
        writes++;
        // First write settles old ownership. Fail the next commit-start barrier
        // once; the subsequent failure journal must retain the original message.
        if (writes === 2) throw new Error('controlled admission journal failure');
        return originalSave(...args);
    };
    await f.service.relay(scope, 'old', { saved: true });
    await tick();
    assert.deepEqual(f.history, []);
    assert.deepEqual(f.advances, []);
    const entries = f.service.snapshot(scope);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message.id, 'letter');
    assert.equal(entries[0].state, 'failed');
    assert.match(entries[0].error, /controlled admission journal failure/);
    assert.equal(f.disk().entries[0].state, 'failed');
    assert.equal(f.service.leases.size, 0);
    await f.service.dispose();
});
for (const mode of ['cancelled', 'admission-failed']) {
    test(`explicit resume preserves durable relay ownership: ${mode}`, async () => {
        const f = await fixture();
        await f.service.submit({ scope,
            message: { id: 'human', role: 'user', content: 'first' } });
        await f.service.submit({ scope,
            message: { id: 'later', role: 'user', content: 'second' } });
        if (mode === 'admission-failed') {
            const save = f.service.store.save;
            let writes = 0;
            f.service.store.save = async (...args) => {
                if (++writes === 2) throw new Error('controlled barrier failure');
                return save(...args);
            };
        }
        await f.service.relay(scope, 'old', { saved: true, cancelled: mode === 'cancelled' });
        await tick();
        assert.equal(f.advances.length, 0);
        assert.equal(f.disk().entries.find(entry => entry.message.id === 'human').relayFrom, 'old');
        assert.equal(f.disk().entries.find(entry => entry.message.id === 'later').relayFrom, undefined);
        await f.service.resume(scope);
        await tick();
        assert.equal(f.advances.length, 1);
        assert.equal(f.advances[0].relayFrom, 'old');
        assert.equal(f.advances[0].automatic, false);
        await f.service.release(scope, f.advances[0].token, { saved: true });
        await tick();
        assert.equal(f.advances.length, 2);
        assert.equal(f.advances[1].relayFrom, null);
        await f.service.dispose();
    });
}
test('paused relay ownership survives instance restart and requires explicit resume', async () => {
    const f = await fixture();
    await f.service.submit({ scope, message: { id: 'human', role: 'user', content: 'continue' } });
    await f.service.relay(scope, 'old', { saved: true, cancelled: true });
    let disk = structuredClone(f.disk());
    await f.service.dispose();
    const history = [], advances = [];
    const restored = new TopicMessageAdmission({
        store: {
            load: async () => structuredClone(disk.entries),
            loadState: async () => structuredClone(disk),
            save: async (entries, standaloneLeases) => { disk = structuredClone({ entries, standaloneLeases }); },
        },
        validate: async () => {},
        commit: async (_scope, message) => { history.push(message.id); },
        advance: async request => { advances.push(request); },
    });
    try {
        await restored.initialize();
        await tick();
        assert.deepEqual(history, []);
        assert.deepEqual(advances, []);
        assert.equal(restored.snapshot(scope)[0].relayFrom, 'old');
        assert.equal(restored.snapshot(scope)[0].state, 'recovered');
        assert.equal((await restored.resume(scope)).success, true);
        await tick();
        assert.deepEqual(history, ['human']);
        assert.equal(advances.length, 1);
        assert.equal(advances[0].relayFrom, 'old');
        assert.equal(advances[0].automatic, false);
    } finally { await restored.dispose(); }
});
test('conflicting persisted relay ownership becomes visibly paused rather than queued', async () => {
    const f = await fixture();
    for (const id of ['one', 'two']) {
        await f.service.submit({ scope,
            message: { id, role: 'assistant', content: id }, triggerPolicy: 'reply' });
    }
    // Inject conflicting recovered journal metadata, not chat message fields.
    f.service.entries = f.service.entries.map(entry => ({
        ...entry, relayFrom: entry.message.id === 'one' ? 'origin-one' : 'origin-two',
    }));
    await f.service.release(scope, 'old', { saved: true });
    await tick();
    assert.equal(f.advances.length, 0);
    assert.equal(f.service.snapshot(scope).length, 2);
    assert.ok(f.service.snapshot(scope).every(entry => entry.state === 'failed'));
    assert.ok(f.disk().entries.every(entry => entry.state === 'failed'
        && entry.error.includes('冲突')));
    assert.equal(f.service.leases.size, 0);
    await f.service.dispose();
});
for (const withdrawalFirst of [true, false]) {
    test(`withdraw versus relay is serialized; withdrawal first=${withdrawalFirst}`, async () => {
        const f = await fixture();
        try {
            const submitted = await f.service.submit({
                scope, message: { id: 'racing-letter', role: 'assistant', content: 'letter' },
                triggerPolicy: 'reply',
            });
            let withdraw, relay;
            if (withdrawalFirst) {
                withdraw = f.service.withdraw(scope, submitted.entryId);
                relay = f.service.relay(scope, 'old', { saved: true });
            } else {
                relay = f.service.relay(scope, 'old', { saved: true });
                withdraw = f.service.withdraw(scope, submitted.entryId);
            }
            const [withdrawal, handover] = await Promise.all([withdraw, relay]);
            assert.equal(handover.success, true);
            await tick();
            assert.equal(f.advances.length, 1);
            if (withdrawalFirst) {
                assert.equal(withdrawal.success, true);
                assert.deepEqual(f.history, []);
                assert.equal(f.advances[0].continuation, true);
            } else {
                assert.equal(withdrawal.success, false);
                assert.equal(withdrawal.code, 'ALREADY_COMMITTED');
                assert.deepEqual(f.history, ['racing-letter']);
                assert.equal(f.advances[0].continuation, false);
            }
        } finally { await f.service.dispose(); }
    });
}
for (const stage of [1, 2, 3, 4, 'commit']) {
    test(`Stop cancels relay during awaited barrier: ${stage}`, async () => {
        const f = await fixture();
        try {
            await f.service.submit({ scope, message: { id: 'letter', role: 'assistant', content: 'letter' },
                triggerPolicy: 'reply' });
            let entered, unblock;
            const reached = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { unblock = resolve; });
            let writes = 0;
            const save = f.service.store.save;
            f.service.store.save = async (...args) => {
                if (++writes === stage) { entered(); await gate; }
                return save(...args);
            };
            if (stage === 'commit') {
                const commit = f.service.commit;
                f.service.commit = async (...args) => { entered(); await gate; return commit(...args); };
            }
            const relay = f.service.relay(scope, 'old', { saved: true });
            await reached;
            assert.equal(f.service.cancelRelay({ ...scope, topicId: 'other' }, 'old').code, 'STALE_RELAY');
            assert.equal(f.service.cancelRelay(scope, 'wrong').code, 'STALE_RELAY');
            assert.equal(f.service.cancelRelay(scope, 'old').accepted, true);
            assert.equal(f.service.cancelRelay(scope, 'old').accepted, true, 'signal is idempotent');
            assert.deepEqual(f.advances, []);
            unblock();
            const result = await relay;
            await tick();
            assert.equal(result.code, 'RELAY_CANCELLED');
            assert.deepEqual(f.advances, []);
            assert.equal(f.service.leases.size, 0);
            assert.ok(f.disk().entries.every(entry => entry.state === 'recovered'));
            assert.equal(f.disk().entries[0].relayFrom, 'old');
            const committed = stage === 3 || stage === 4 || stage === 'commit';
            assert.deepEqual(f.history, committed ? ['letter'] : []);
            await f.service.submit({ scope, message: { id: 'later', role: 'user', content: 'later' } });
            await tick();
            assert.deepEqual(f.advances, [], 'a later message cannot bypass cancellation');
            await f.service.resume(scope);
            await tick();
            assert.equal(f.advances.length, 1);
            assert.equal(f.advances[0].relayFrom, 'old');
            assert.equal(f.history.filter(id => id === 'letter').length, 1);
        } finally { await f.service.dispose(); }
    });
}
test('relay cancellation received before queued relay starts is retained', async () => {
    const f = await fixture();
    try {
        const relay = f.service.relay(scope, 'old', { saved: true });
        assert.equal(f.service.cancelRelay(scope, 'old').accepted, true);
        assert.equal((await relay).code, 'RELAY_CANCELLED');
        await tick();
        assert.deepEqual(f.advances, []);
        assert.equal(f.service.relayAttempts.size, 0);
    } finally { await f.service.dispose(); }
});
test('cancellation after dispatch cannot claim to have stopped generation', async () => {
    const f = await fixture();
    try {
        let late;
        f.service.advance = async request => {
            f.advances.push(request);
            late = f.service.cancelRelay(scope, 'old');
        };
        await f.service.relay(scope, 'old', { saved: true });
        await tick();
        assert.equal(f.advances.length, 1);
        assert.equal(late.success, false);
        assert.ok(['RELAY_ALREADY_DISPATCHED', 'STALE_RELAY'].includes(late.code));
        assert.equal(f.service.relayAttempts.size, 0);
        assert.equal((await f.service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    } finally { await f.service.dispose(); }
});
for (const writeThenReject of [false, true]) {
    test(`cancel pause journal failure stays stopped; write then reject=${writeThenReject}`, async () => {
        const f = await fixture();
        try {
            await f.service.submit({ scope, message: { id: 'letter', role: 'assistant', content: 'letter' },
                triggerPolicy: 'reply' });
            const save = f.service.store.save;
            let writes = 0, entered, unblock;
            const reached = new Promise(resolve => { entered = resolve; });
            const gate = new Promise(resolve => { unblock = resolve; });
            f.service.store.save = async (...args) => {
                writes++;
                if (writes === 4) { entered(); await gate; }
                if (writes === 5) {
                    if (writeThenReject) await save(...args);
                    throw new Error('pause journal receipt failed');
                }
                return save(...args);
            };
            const relay = f.service.relay(scope, 'old', { saved: true });
            const rejected = assert.rejects(relay, /pause journal receipt failed/);
            await reached;
            assert.equal(f.service.cancelRelay(scope, 'old').accepted, true);
            unblock();
            await rejected;
            await tick();
            assert.deepEqual(f.advances, []);
            assert.equal(f.service.snapshot(scope)[0].state, 'recovered');
            assert.equal(f.disk().entries[0].state, writeThenReject ? 'recovered' : 'advancing');
            await f.service.submit({ scope, message: { id: 'later', role: 'user', content: 'later' } });
            await tick();
            assert.deepEqual(f.advances, []);
            assert.equal(f.disk().entries[0].state, 'recovered');
            await f.service.resume(scope);
            await tick();
            assert.equal(f.advances.length, 1);
            assert.equal(f.history.filter(id => id === 'letter').length, 1);
        } finally { await f.service.dispose(); }
    });
}