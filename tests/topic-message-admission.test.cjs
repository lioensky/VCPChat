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

test('committed batch survives restart without duplicate commit and cannot be withdrawn', async () => {
    const first = await fixture();
    await first.service.submit({ scope, message: msg('persisted'), triggerPolicy: 'reply' });
    await tick();
    assert.equal(first.advances.length, 1);
    const entry = first.service.snapshot()[0];
    assert.equal(entry.committed, true);
    const recovered = await fixture({ saved: first.disk() });
    assert.equal((await recovered.service.withdraw(scope, entry.entryId)).code, 'ALREADY_COMMITTED');
    assert.equal(recovered.service.snapshot(scope)[0].state, 'uncertain');
    assert.equal((await recovered.service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    await tick();
    assert.equal(recovered.history.length, 0);
    assert.equal(recovered.advances.length, 0);
    assert.equal(recovered.service.snapshot(scope)[0].leaseToken, entry.leaseToken);
    assert.match(recovered.service.snapshot(scope)[0].error, /终稿与工具执行结果待核实/);
});

test('rejected advance is visible and resumes only explicitly', async () => {
    const { service, history } = await fixture({
        advance: async () => { throw new Error('renderer unavailable'); },
    });
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await tick();
    assert.equal(service.snapshot()[0].state, 'failed');
    assert.equal(service.snapshot()[0].committed, true);
    assert.equal(history.length, 1);
    await tick();
    assert.equal(history.length, 1);
    assert.equal((await service.resume(scope)).success, true);
    await tick();
    assert.equal(history.length, 1);
});

test('explicit startup failure pauses batch; stale failure cannot revoke a resumed round', async () => {
    const { service, advances, history } = await fixture();
    await service.submit({ scope, message: msg('a'), triggerPolicy: 'reply' });
    await tick();
    const oldToken = advances[0].token;
    assert.equal((await service.fail(scope, oldToken, 'startup failed')).success, true);
    assert.equal(service.snapshot()[0].state, 'failed');
    await service.submit({ scope, message: msg('later') });
    await tick();
    assert.equal(history.length, 1);
    assert.equal(advances.length, 1);
    await service.resume(scope);
    await tick();
    assert.equal(advances.length, 2);
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
    assert.equal(recovered.service.snapshot(scope)[0].state, 'uncertain');
    assert.equal(recovered.advances.length, 0);
    await assert.rejects(recovered.service.acquireWhenIdle(scope, 'restart'),
        error => error.code === 'ADMISSION_PAUSED');
    phase = 'normal';
    await service.release(scope, token);
});
test('uncertain execution is durable and visible without releasing ownership or allowing retry', async () => {
    const { service, advances, disk } = await fixture();
    await service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    assert.equal((await service.reportUncertain(scope, token, new Error('save unknown'))).retained, true);
    assert.equal(service.snapshot(scope)[0].state, 'uncertain');
    assert.equal(disk()[0].error, 'save unknown');
    assert.equal((await service.resume(scope)).code, 'TOPIC_BUSY');
    assert.equal((await service.acquire(scope, 'another')).code, 'TOPIC_BUSY');
    assert.equal((await service.withdraw(scope, service.snapshot(scope)[0].entryId)).code, 'ALREADY_COMMITTED');
    assert.equal((await service.release(scope, token, { saved: true })).success, true);
    assert.equal(service.snapshot(scope).length, 0);
});

test('late uncertain report cannot alter a transferred batch', async () => {
    const { service, advances } = await fixture();
    await service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    await tick();
    const token = advances[0].token;
    await service.transfer(scope, token, 'next-owner');
    assert.equal((await service.reportUncertain(scope, token, 'late failure')).code, 'STALE_LEASE');
    assert.equal(service.snapshot(scope)[0].state, 'advancing');
    assert.equal(service.snapshot(scope)[0].leaseToken, 'next-owner');
    await service.release(scope, 'next-owner');
});

test('uncertain terminal survives repeated restarts without offering generation retry', async () => {
    const first = await fixture();
    await first.service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    await tick();
    await first.service.reportUncertain(scope, first.advances[0].token, 'terminal save unknown');
    const recovered = await fixture({ saved: first.disk() });
    assert.equal(recovered.service.snapshot(scope)[0].state, 'uncertain');
    assert.equal(recovered.service.snapshot(scope)[0].error, 'terminal save unknown');
    assert.equal((await recovered.service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    await assert.rejects(recovered.service.acquireWhenIdle(scope, 'new-generation'),
        error => error.code === 'ADMISSION_PAUSED');
    const entry = recovered.service.snapshot(scope)[0];
    assert.equal((await recovered.service.withdraw(scope, entry.entryId)).code, 'ALREADY_COMMITTED');
    await recovered.service.submit({ scope, message: msg('later') });
    await tick();
    assert.equal(recovered.advances.length, 0);
    assert.equal(recovered.history.length, 0);
    const again = await fixture({ saved: recovered.disk() });
    assert.equal(again.service.snapshot(scope)[0].state, 'uncertain');
    assert.equal((await again.service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    assert.equal(again.advances.length, 0);
});

test('standalone lease failure journals diagnostics without inserting a chat message', async () => {
    const first = await fixture();
    await first.service.acquire(scope, 'standalone');
    await first.service.submit({ scope, message: msg('waiting') });
    await first.service.reportUncertain(scope, 'standalone', 'independent save unknown');
    await first.service.reportUncertain(scope, 'standalone', 'updated diagnosis');
    const diagnostics = first.service.snapshot(scope).filter(entry => entry.kind === 'lease-diagnostic');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].error, 'updated diagnosis');
    assert.equal(first.history.length, 0);
    const recovered = await fixture({ saved: first.disk() });
    assert.equal((await recovered.service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    assert.equal(recovered.advances.length, 0);
    assert.equal((await recovered.service.withdraw(scope, diagnostics[0].entryId)).code, 'ALREADY_COMMITTED');
    await first.service.release(scope, 'standalone', { saved: true });
    await tick();
    assert.deepEqual(first.history.map(item => item.message.id), ['waiting']);
    assert.equal(first.service.snapshot(scope).some(entry => entry.kind === 'lease-diagnostic'), false);
});

test('recovered standalone diagnosis blocks queued human messages before its FIFO position', async () => {
    const first = await fixture();
    await first.service.acquire(scope, 'standalone');
    await first.service.submit({ scope, message: msg('waiting-human', 'user'), triggerPolicy: 'reply' });
    await first.service.reportUncertain(scope, 'standalone', 'previous execution unknown');
    const recovered = await fixture({ saved: first.disk() });
    await recovered.service.submit({ scope, message: msg('new-arrival'), triggerPolicy: 'reply' });
    await recovered.service.submit({ scope: other, message: msg('other-topic') });
    await tick();
    assert.equal(recovered.advances.length, 0);
    assert.deepEqual(recovered.history.map(item => item.message.id), ['other-topic']);
    assert.equal(recovered.service.snapshot(scope).filter(entry => entry.kind !== 'lease-diagnostic')
        .some(entry => entry.commitStarted), false);
    assert.equal((await recovered.service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
});

test('reconciliation requires evidence and idle ownership, then pauses remaining queue', async () => {
    const first = await fixture();
    await first.service.submit({ scope, message: msg('human', 'user'), triggerPolicy: 'reply' });
    await tick();
    const token = first.advances[0].token;
    const entryId = first.service.snapshot(scope)[0].entryId;
    await first.service.reportUncertain(scope, token, 'unknown');
    assert.equal((await first.service.reconcile(scope, entryId)).code, 'TOPIC_BUSY');
    let verified = false;
    const checks = [];
    const recovered = await fixture({
        saved: first.disk(),
        verifyTerminal: async (target, lease) => {
            checks.push({ target, lease });
            return verified ? { verified: true, messageId: 'saved-terminal' } : { verified: false };
        },
    });
    assert.equal((await recovered.service.reconcile(other, entryId)).code, 'NOT_UNCONFIRMED');
    assert.equal((await recovered.service.reconcile(scope, entryId)).code, 'TERMINAL_UNCONFIRMED');
    await recovered.service.submit({ scope, message: msg('queued-human', 'user'), triggerPolicy: 'reply' });
    verified = true;
    const result = await recovered.service.reconcile(scope, entryId);
    assert.equal(result.messageId, 'saved-terminal');
    assert.equal(checks.at(-1).lease, token);
    assert.deepEqual(checks.at(-1).target, scope);
    assert.equal(recovered.service.snapshot(scope)[0].state, 'recovered');
    await recovered.service.submit({ scope, message: msg('later') });
    await tick();
    assert.equal(recovered.advances.length, 0);
    assert.equal(recovered.history.length, 0);
    assert.equal((await recovered.service.reconcile(scope, entryId)).code, 'NOT_UNCONFIRMED');
    await recovered.service.resume(scope);
    await tick();
    assert.equal(recovered.advances.length, 1);
    assert.deepEqual(recovered.history.map(item => item.message.id), ['queued-human']);
});

test('reconciliation verifier and journal failures cannot discard an uncertain batch', async () => {
    const saved = [{
        entryId: 'uncertain-entry', scope, message: msg('human', 'user'),
        state: 'uncertain', committed: true, commitStarted: true, leaseToken: 'lease',
    }];
    const unavailable = await fixture({ saved });
    assert.equal((await unavailable.service.reconcile(scope, 'uncertain-entry')).code, 'VERIFICATION_UNAVAILABLE');
    const failed = await fixture({
        saved,
        verifyTerminal: async () => { throw new Error('history unavailable'); },
    });
    await assert.rejects(failed.service.reconcile(scope, 'uncertain-entry'), /history unavailable/);
    assert.equal(failed.service.snapshot(scope).length, 1);
    const journal = await fixture({
        store: {
            load: async () => structuredClone(saved),
            save: async () => { throw new Error('journal unavailable'); },
        },
        verifyTerminal: async () => ({ verified: true, messageId: 'terminal' }),
    });
    await assert.rejects(journal.service.reconcile(scope, 'uncertain-entry'), /journal unavailable/);
    assert.equal(journal.service.snapshot(scope)[0].state, 'uncertain');
});

test('admission records real deferral separately from durable acceptance', async () => {
    const { service } = await fixture();
    await service.acquire(scope, 'active-round');
    await service.submit({ scope, message: msg('blocked', 'user') });
    assert.equal(service.snapshot(scope).find(entry => entry.message.id === 'blocked').deferred, true);
    await service.submit({ scope: other, message: msg('idle', 'user') });
    assert.equal(service.snapshot(other).find(entry => entry.message.id === 'idle').deferred, false);
});