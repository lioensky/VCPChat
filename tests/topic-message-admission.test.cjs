'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');

const scope = { itemType: 'agent', itemId: 'agent_a', topicId: 'topic_a' };
const other = { ...scope, topicId: 'topic_b' };
const msg = (id, role = 'assistant') => ({ id, role, name: role, content: id });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(options = {}) {
    let disk = options.saved || [];
    const history = [];
    const advances = [];
    const service = new TopicMessageAdmission({
        store: {
            load: async () => structuredClone(disk),
            save: async next => { disk = structuredClone(next); },
        },
        validate: async () => {},
        commit: async (target, message) => {
            if (!history.some(item => item.message.id === message.id)) {
                history.push({ target, message });
            }
        },
        advance: async request => { advances.push(request); },
        logger: { warn() {}, error() {} },
        ...options,
    });
    await service.initialize();
    return { service, history, advances, disk: () => disk };
}

test('busy topic holds messages; withdrawal wins before release', async () => {
    const { service, history } = await fixture();
    assert.equal((await service.acquire(scope, 'round-1')).success, true);
    const submitted = await service.submit({ scope, message: msg('a') });
    assert.equal(history.length, 0);
    assert.equal((await service.withdraw(scope, submitted.entryId)).success, true);
    await service.release(scope, 'round-1');
    await tick();
    assert.equal(history.length, 0);
    assert.deepEqual(service.snapshot(), []);
});

test('topic isolation and stale/unsaved terminal guards', async () => {
    const { service, history } = await fixture();
    await service.acquire(scope, 'round-1');
    await service.submit({ scope, message: msg('a') });
    await service.submit({ scope: other, message: msg('b') });
    await tick();
    assert.deepEqual(history.map(item => item.message.id), ['b']);
    assert.equal((await service.release(scope, 'old')).code, 'STALE_LEASE');
    assert.equal((await service.release(scope, 'round-1', { saved: false })).code, 'UNSAVED_TERMINAL');
    await tick();
    assert.equal(history.length, 1);
    await service.release(scope, 'round-1');
    await tick();
    assert.deepEqual(history.map(item => item.message.id), ['b', 'a']);
});

test('human message starts one round and keeps later messages pending', async () => {
    const { service, history, advances } = await fixture();
    await service.acquire(scope, 'round-1');
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    await service.submit({ scope, message: msg('later') });
    await service.release(scope, 'round-1');
    await tick();
    assert.deepEqual(history.map(item => item.message.id), ['a', 'human']);
    assert.equal(advances.length, 1);
    assert.equal(advances[0].automatic, false);
    assert.deepEqual(service.snapshot(scope).filter(entry => !entry.committed).map(entry => entry.message.id), ['later']);
    assert.deepEqual(service.snapshot(scope).filter(entry => entry.committed).map(entry => entry.message.id), ['a', 'human']);
    assert.equal((await service.resume(scope)).code, 'TOPIC_BUSY');
    const committed = service.snapshot(scope).find(entry => entry.message.id === 'human');
    assert.equal((await service.withdraw(scope, committed.entryId)).code, 'ALREADY_COMMITTED');
    await service.release(scope, advances[0].token);
    await tick();
    assert.deepEqual(history.map(item => item.message.id), ['a', 'human', 'later']);
});

test('consecutive assistant triggers coalesce; advance may call admission without deadlock', async () => {
    let service;
    const calls = [];
    ({ service } = await fixture({
        advance: async request => {
            calls.push(request);
            await service.submit({ scope: other, message: msg('callback') });
        },
    }));
    await service.acquire(scope, 'round-1');
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await service.submit({ scope, message: msg('b'), triggerPolicy: 'reply' });
    await service.release(scope, 'round-1');
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messageId, 'b');
});

test('restart pauses pending messages until explicit resume', async () => {
    const { service: first, disk } = await fixture();
    await first.acquire(scope, 'round-1');
    await first.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    const { service, history, advances } = await fixture({ saved: disk() });
    await tick();
    assert.equal(service.snapshot(scope)[0].state, 'recovered');
    assert.equal(history.length, 0);
    assert.equal(advances.length, 0);
    await service.resume(scope);
    await tick();
    assert.equal(history.length, 1);
    assert.equal(advances.length, 1);
});

test('uncertain commit stays visible and requires idempotent retry rather than withdrawal', async () => {
    const { service } = await fixture({ commit: async () => { throw new Error('disk full'); } });
    const entry = await service.submit({ scope, message: msg('a') });
    await tick();
    assert.equal(service.snapshot()[0].state, 'failed');
    assert.equal(service.snapshot()[0].error, 'disk full');
    assert.equal((await service.withdraw(scope, entry.entryId)).code, 'ALREADY_COMMITTED');
});

test('wrong topic cannot withdraw an entry; duplicate pending request is idempotent', async () => {
    const { service } = await fixture();
    await service.acquire(scope, 'round-1');
    const a = await service.submit({ scope, message: msg('a'), requestId: 'req' });
    const b = await service.submit({ scope, message: msg('b'), requestId: 'req' });
    assert.equal(a.entryId, b.entryId);
    assert.equal((await service.withdraw(other, a.entryId)).code, 'NOT_PENDING');
    assert.equal(service.snapshot().length, 1);
});

test('automatic consecutive rounds stop at local budget', async () => {
    const { service, advances, history } = await fixture({ maxAutoRounds: 1 });
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await tick();
    assert.equal(advances.length, 1);
    await service.submit({ scope, message: msg('b'), triggerPolicy: 'reply' });
    await service.release(scope, advances[0].token);
    await tick();
    assert.equal(history.length, 2);
    assert.equal(advances.length, 1);
});

test('interrupted committed batch is discarded on restart without replay', async () => {
    const first = await fixture();
    await first.service.submit({ scope, message: msg('persisted'), triggerPolicy: 'reply' });
    await tick();
    const recovered = await fixture({ saved: first.disk() });
    assert.deepEqual(recovered.service.snapshot(scope), []);
    assert.equal(recovered.history.length, 0);
    assert.equal(recovered.advances.length, 0);
    assert.equal((await recovered.service.acquire(scope, 'retry')).success, true);
});

test('rejected advance clears staging without replaying committed history', async () => {
    const { service, history } = await fixture({
        advance: async () => { throw new Error('renderer unavailable'); },
    });
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await tick();
    assert.deepEqual(service.snapshot(), []);
    assert.equal(history.length, 1);
    assert.equal((await service.acquire(scope, 'retry')).success, true);
});

test('explicit failure clears topic; stale failure cannot revoke a new round', async () => {
    const { service, advances } = await fixture();
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await tick();
    const oldToken = advances[0].token;
    assert.equal((await service.fail(scope, oldToken, 'startup failed')).cleared, true);
    assert.deepEqual(service.snapshot(), []);
    await service.submit({ scope, message: msg('later'), triggerPolicy: 'reply' });
    await tick();
    const newToken = advances[1].token;
    assert.notEqual(newToken, oldToken);
    assert.equal((await service.fail(scope, oldToken, 'late failure')).code, 'STALE_LEASE');
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    await service.release(scope, newToken);
    assert.deepEqual(service.snapshot(), []);
});

test('active self-post cannot self-wake without a source footer; visitor can advance', async () => {
    const { service, advances, history } = await fixture();
    await service.acquire(scope, 'own-round');
    await service.submit({
        scope, message: { ...msg('self'), agentId: scope.itemId }, triggerPolicy: 'reply',
    });
    assert.equal(service.snapshot()[0].triggerPolicy, 'none');
    await service.release(scope, 'own-round');
    await tick();
    assert.equal(history.length, 1);
    assert.equal(advances.length, 0);
    await service.acquire(scope, 'next-round');
    await service.submit({
        scope, message: { ...msg('visitor'), agentId: 'another-agent' }, triggerPolicy: 'reply',
    });
    await service.release(scope, 'next-round');
    await tick();
    assert.equal(advances.length, 1);
});
test('waiting speaker yields to pending commits without holding the serial lock', async () => {
    const { service, history } = await fixture();
    await service.acquire(scope, 'first');
    await service.submit({ scope, message: msg('pending') });
    const next = service.acquireWhenIdle(scope, 'next');
    await tick();
    assert.equal(service.waiters.size, 1);
    await service.release(scope, 'first');
    assert.equal((await next).success, true);
    assert.deepEqual(history.map(item => item.message.id), ['pending']);
    assert.equal(service.waiters.size, 0);
    await service.release(scope, 'next');
});

test('waiting speaker cannot overtake a pending human generation', async () => {
    const { service, advances } = await fixture();
    await service.acquire(scope, 'first');
    await service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    let acquired = false;
    const next = service.acquireWhenIdle(scope, 'next').then(value => { acquired = true; return value; });
    await service.release(scope, 'first');
    await tick();
    assert.equal(advances.length, 1);
    assert.equal(acquired, false);
    await service.release(scope, advances[0].token);
    assert.equal((await next).success, true);
    await service.release(scope, 'next');
});

test('lease wait cancellation removes listener without disturbing current owner', async () => {
    const { service } = await fixture();
    await service.acquire(scope, 'first');
    const controller = new AbortController();
    const next = service.acquireWhenIdle(scope, 'next', { signal: controller.signal });
    const rejected = assert.rejects(next, error => error.code === 'ABORT_ERR');
    await tick();
    controller.abort();
    await rejected;
    assert.equal(service.waiters.size, 0);
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    await service.release(scope, 'first');
});

test('lease wait timeout and disposal clean up their waiters', async () => {
    const { service } = await fixture();
    await service.acquire(scope, 'first');
    await assert.rejects(service.acquireWhenIdle(scope, 'timeout', { timeoutMs: 10 }),
        error => error.code === 'ADMISSION_TIMEOUT');
    assert.equal(service.waiters.size, 0);
    const waiting = service.acquireWhenIdle(scope, 'disposed');
    const rejected = assert.rejects(waiting, /Admission disposed/);
    await tick();
    await service.dispose();
    await rejected;
    assert.equal(service.waiters.size, 0);
});

test('recovered queue rejects waiting generation rather than silently resuming', async () => {
    const first = await fixture();
    await first.service.acquire(scope, 'first');
    await first.service.submit({ scope, message: msg('pending') });
    const { service, history } = await fixture({ saved: first.disk() });
    await assert.rejects(service.acquireWhenIdle(scope, 'next'),
        error => error.code === 'ADMISSION_PAUSED');
    assert.equal(history.length, 0);
    assert.equal(service.waiters.size, 0);
});
test('atomic transfer wakes an already waiting speaker without exposing an idle topic', async () => {
    const { service, advances } = await fixture();
    await service.submit({ scope, message: msg('visitor'), triggerPolicy: 'reply' });
    await tick();
    const oldToken = advances[0].token;
    const waiting = service.acquireWhenIdle(scope, 'waiting-speaker');
    await tick();
    assert.equal(service.waiters.size, 1);
    assert.equal((await service.transfer(other, oldToken, 'wrong-topic')).code, 'STALE_LEASE');
    assert.equal((await service.transfer(scope, oldToken, 'waiting-speaker')).success, true);
    assert.equal((await waiting).success, true);
    assert.equal(service.snapshot(scope)[0].leaseToken, 'waiting-speaker');
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    assert.equal((await service.release(scope, oldToken)).code, 'STALE_LEASE');
    assert.equal((await service.fail(scope, oldToken, 'late failure')).code, 'STALE_LEASE');
    await service.release(scope, 'waiting-speaker');
    assert.deepEqual(service.snapshot(scope), []);
});

test('failed transfer journal keeps previous lease and batch ownership', async () => {
    let rejectSave = false;
    let disk = [];
    const { service, advances } = await fixture({
        store: {
            load: async () => disk,
            save: async next => {
                if (rejectSave) throw new Error('transfer disk failure');
                disk = structuredClone(next);
            },
        },
    });
    await service.submit({ scope, message: msg('visitor'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    rejectSave = true;
    await assert.rejects(service.transfer(scope, token, 'next'), /transfer disk failure/);
    assert.equal(service.snapshot(scope)[0].leaseToken, token);
    assert.equal(disk[0].leaseToken, token);
    assert.equal((await service.acquire(scope, 'next')).code, 'TOPIC_BUSY');
    rejectSave = false;
    await service.release(scope, token);
});
test('handoff candidates are scoped, opt-in and removed on cancellation', async () => {
    const { service } = await fixture();
    await service.acquire(scope, 'current');
    const plainController = new AbortController();
    const groupController = new AbortController();
    const plain = service.acquireWhenIdle(scope, 'ordinary', { signal: plainController.signal });
    const member = service.acquireWhenIdle(scope, 'member', {
        signal: groupController.signal, handoffOwner: 'group-run-1',
    });
    const plainRejected = assert.rejects(plain, error => error.code === 'ABORT_ERR');
    const memberRejected = assert.rejects(member, error => error.code === 'ABORT_ERR');
    await tick();
    assert.deepEqual(service.findWaitingHandoff(scope, 'group-run-1'), { token: 'member' });
    assert.equal(service.findWaitingHandoff(other, 'group-run-1'), null);
    assert.equal(service.findWaitingHandoff(scope, 'different-run'), null);
    groupController.abort();
    await memberRejected;
    assert.equal(service.findWaitingHandoff(scope, 'group-run-1'), null);
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    plainController.abort();
    await plainRejected;
    assert.equal(service.waiters.size, 0);
    await service.release(scope, 'current');
});
test('late advance rejection cannot fail a batch already transferred to its speaker', async () => {
    let rejectAdvance;
    let request;
    const { service } = await fixture({
        advance: value => {
            request = value;
            return new Promise((_resolve, reject) => { rejectAdvance = reject; });
        },
    });
    await service.submit({ scope, message: msg('visitor'), triggerPolicy: 'reply' });
    await tick();
    assert.ok(request);
    await service.transfer(scope, request.token, 'speaker');
    rejectAdvance(new Error('old dispatcher failed late'));
    await tick();
    await service.tail;
    assert.equal(service.snapshot(scope)[0].state, 'advancing');
    assert.equal(service.snapshot(scope)[0].leaseToken, 'speaker');
    assert.equal(service.snapshot(scope)[0].error, null);
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    await service.release(scope, 'speaker');
    assert.deepEqual(service.snapshot(scope), []);
});
test('transferToWaiting selects only the explicitly owned waiting speaker', async () => {
    const { service, advances } = await fixture();
    await service.submit({ scope, message: msg('visitor'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    const waiting = service.acquireWhenIdle(scope, 'member', { handoffOwner: 'run' });
    await tick();
    assert.equal((await service.transferToWaiting(scope, token, 'wrong-run')).code, 'NO_WAITING_SPEAKER');
    assert.deepEqual(await service.transferToWaiting(scope, token, 'run'),
        { success: true, token: 'member' });
    await waiting;
    assert.equal(service.snapshot(scope)[0].leaseToken, 'member');
    await service.release(scope, 'member');
});

test('cancellation during handoff journal restores original durable ownership', async () => {
    let disk = [];
    let cancelOnSave = false;
    const controller = new AbortController();
    const { service, advances } = await fixture({
        store: {
            load: async () => disk,
            save: async next => {
                disk = structuredClone(next);
                if (cancelOnSave) {
                    cancelOnSave = false;
                    controller.abort();
                }
            },
        },
    });
    await service.submit({ scope, message: msg('visitor'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    const waiting = service.acquireWhenIdle(scope, 'departed', {
        signal: controller.signal, handoffOwner: 'run',
    });
    const rejected = assert.rejects(waiting, error => error.code === 'ABORT_ERR');
    await tick();
    cancelOnSave = true;
    assert.equal((await service.transferToWaiting(scope, token, 'run')).code, 'HANDOFF_CANCELLED');
    await rejected;
    assert.equal(service.snapshot(scope)[0].leaseToken, token);
    assert.equal(disk[0].leaseToken, token);
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    assert.equal(service.waiters.size, 0);
    await service.release(scope, token);
});
test('failed handoff restoration stays occupied and restarts paused', async () => {
    let disk = [];
    let phase = 'normal';
    const controller = new AbortController();
    const { service, advances } = await fixture({
        store: {
            load: async () => structuredClone(disk),
            save: async next => {
                if (phase === 'restore-fails') throw new Error('restore journal failed');
                disk = structuredClone(next);
                if (phase === 'cancel') {
                    phase = 'restore-fails';
                    controller.abort();
                }
            },
        },
    });
    await service.submit({ scope, message: msg('visitor'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    const waiting = service.acquireWhenIdle(scope, 'departed', {
        signal: controller.signal, handoffOwner: 'run',
    });
    const rejected = assert.rejects(waiting, error => error.code === 'ABORT_ERR');
    await tick();
    phase = 'cancel';
    await assert.rejects(service.transferToWaiting(scope, token, 'run'), /restore journal failed/);
    await rejected;
    assert.equal(service.snapshot(scope)[0].leaseToken, token);
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    const recovered = await fixture({ saved: disk });
    assert.deepEqual(recovered.service.snapshot(scope), []);
    assert.equal(recovered.advances.length, 0);
    assert.equal((await recovered.service.acquireWhenIdle(scope, 'restart')).success, true);
    phase = 'normal';
    await service.release(scope, token);
});
test('failure drops all topic staging, preserves history and isolates other ownership', async () => {
    const { service, history, advances, disk } = await fixture();
    await service.acquire(scope, 'failed');
    await service.acquire(other, 'healthy');
    await service.submit({ scope, message: msg('waiting-human', 'user'), triggerPolicy: 'reply' });
    await service.submit({ scope, message: msg('waiting-letter') });
    await service.submit({ scope: other, message: msg('other-letter') });
    const waiting = service.acquireWhenIdle(scope, 'waiting-speaker');
    const rejected = assert.rejects(waiting, error => error.code === 'ADMISSION_FAILED');
    await tick();
    assert.equal((await service.reportUncertain(scope, 'failed', 'terminated')).cleared, true);
    await rejected;
    await tick();
    assert.deepEqual(service.snapshot(scope), []);
    assert.equal(disk().some(entry => entry.scope.topicId === scope.topicId), false);
    assert.equal(history.length, 0);
    assert.equal(advances.length, 0);
    assert.equal((await service.acquire(other, 'intruder')).code, 'TOPIC_BUSY');
    assert.equal(service.snapshot(other).length, 1);
    assert.equal((await service.acquire(scope, 'retry')).success, true);
    assert.equal((await service.reportUncertain(scope, 'failed', 'late')).code, 'STALE_LEASE');
    assert.equal((await service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
});

test('late failure cannot alter a transferred batch', async () => {
    const { service, advances } = await fixture();
    await service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    await service.transfer(scope, token, 'next-owner');
    assert.equal((await service.reportUncertain(scope, token, 'late')).code, 'STALE_LEASE');
    assert.equal(service.snapshot(scope)[0].leaseToken, 'next-owner');
});

for (const state of ['advancing', 'uncertain', 'failed']) {
    test(`startup clears legacy ${state} and same-topic queued messages only`, async () => {
        const entry = { entryId: 'old', scope, message: msg('old'), state,
            committed: true, leaseToken: 'old-token' };
        const queued = { entryId: 'queued', scope, message: msg('queued'), state: 'queued' };
        const untouched = { entryId: 'other', scope: other, message: msg('other'), state: 'queued' };
        const recovered = await fixture({ saved: [entry, queued, untouched] });
        assert.deepEqual(recovered.service.snapshot(scope), []);
        assert.equal(recovered.service.snapshot(other)[0].state, 'recovered');
        assert.equal(recovered.disk().length, 1);
        assert.equal(recovered.history.length, 0);
        assert.equal(recovered.advances.length, 0);
        assert.equal((await recovered.service.acquire(scope, 'retry')).success, true);
        const again = await fixture({ saved: recovered.disk() });
        assert.deepEqual(again.service.snapshot(scope), []);
    });
}

test('failed cleanup journal still clears runtime ownership and rejects waiters', async () => {
    let disk = [];
    let rejectSave = false;
    const { service } = await fixture({ store: {
        load: async () => [],
        save: async next => {
            if (rejectSave) throw new Error('disk offline');
            disk = structuredClone(next);
        },
    } });
    await service.acquire(scope, 'failed');
    await service.submit({ scope, message: msg('pending') });
    const waiting = service.acquireWhenIdle(scope, 'waiting');
    const rejected = assert.rejects(waiting, error => error.code === 'ADMISSION_FAILED');
    await tick();
    rejectSave = true;
    await assert.rejects(service.reportUncertain(scope, 'failed', 'terminated'), /disk offline/);
    await rejected;
    assert.deepEqual(service.snapshot(scope), []);
    assert.equal(service.leases.size, 0);
    rejectSave = false;
    assert.equal((await service.acquire(scope, 'retry')).success, true);
    assert.equal(disk.length, 0);
});

test('admission records real deferral separately from durable acceptance', async () => {
    const { service } = await fixture();
    await service.acquire(scope, 'active-round');
    await service.submit({ scope, message: msg('blocked', 'user') });
    assert.equal(service.snapshot(scope).find(entry => entry.message.id === 'blocked').deferred, true);
    await service.submit({ scope: other, message: msg('idle', 'user') });
    assert.equal(service.snapshot(other).find(entry => entry.message.id === 'idle').deferred, false);
});