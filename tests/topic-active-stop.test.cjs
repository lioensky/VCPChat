'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
const other = { ...scope, topicId: 'other' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(overrides = {}) {
    let disk = [];
    const history = [], requests = [];
    const service = new TopicMessageAdmission({
        store: { load: async () => [], save: async next => { disk = structuredClone(next); } },
        validate: async () => {},
        commit: async (_scope, message) => history.push(message),
        advance: async request => { requests.push(request); },
        ...overrides,
    });
    await service.initialize();
    return { service, history, requests, disk: () => disk };
}
const post = (service, target, id) => service.submit({
    scope: target, message: { id, role: 'user', content: id }, triggerPolicy: 'reply',
});

test('Stop cancels pending IDs, retains active owner and leaves history and other topics intact', async () => {
    const f = await fixture();
    await f.service.acquire(scope, 'active');
    await f.service.acquire(other, 'other-active');
    await post(f.service, scope, 'old');
    await post(f.service, other, 'other-old');
    await f.service.cancelPending(scope);
    assert.equal(f.service.snapshot(scope).length, 0);
    assert.equal(f.service.leases.size, 2);
    assert.equal((await f.service.acquire(scope, 'new')).code, 'TOPIC_BUSY');
    assert.equal(f.service.snapshot(other).length, 1);
    assert.equal(f.history.length, 0);
    await f.service.release(scope, 'active', { saved: true });
    await tick();
    assert.equal(f.requests.length, 0);
    await post(f.service, scope, 'fresh');
    await tick();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].messageId, 'fresh');
    await f.service.dispose();
});

test('Stop retains advancing batch until its exact owner saves; resume cannot revive cancelled followers', async () => {
    const f = await fixture();
    await post(f.service, scope, 'trigger');
    await tick();
    const token = f.requests[0].token;
    await post(f.service, scope, 'follower');
    await f.service.cancelPending(scope);
    assert.equal(f.service.snapshot(scope).length, 1);
    assert.equal(f.service.snapshot(scope)[0].cancellationRequested, true);
    assert.equal((await f.service.resume(scope)).code, 'TOPIC_BUSY');
    await f.service.release(scope, token, { saved: true });
    await f.service.resume(scope);
    await tick();
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.history.map(message => message.id), ['trigger']);
    assert.deepEqual(f.disk(), []);
    await f.service.dispose();
});

for (const stage of ['commit', 'advancing']) {
    test(`Stop during ${stage} barrier prevents dispatch without erasing committed history`, async () => {
        let enter, unblock;
        const entered = new Promise(resolve => { enter = resolve; });
        const blocked = new Promise(resolve => { unblock = resolve; });
        let armed = true, disk = [];
        const history = [], requests = [];
        const f = await fixture({
            store: {
                load: async () => [],
                save: async next => {
                    if (stage === 'advancing' && armed && next.some(entry => entry.state === 'advancing')) {
                        armed = false; enter(); await blocked;
                    }
                    disk = structuredClone(next);
                },
            },
            commit: async (_scope, message) => {
                history.push(message);
                if (stage === 'commit' && armed) { armed = false; enter(); await blocked; }
            },
            advance: async request => { requests.push(request); },
        });
        await post(f.service, scope, 'trigger');
        await entered;
        const stopped = f.service.cancelPending(scope);
        const fresh = post(f.service, scope, 'fresh');
        unblock();
        await stopped;
        await fresh;
        await tick();
        assert.deepEqual(requests.map(request => request.messageId), ['fresh']);
        assert.deepEqual(history.map(message => message.id), ['trigger', 'fresh']);
        assert.equal(disk.some(entry => entry.message.id === 'trigger'), false);
        await f.service.dispose();
    });
}

test('durably cancelled followers stay absent after restart and explicit resume', async () => {
    const f = await fixture();
    await f.service.acquire(scope, 'active');
    await post(f.service, scope, 'old');
    await f.service.cancelPending(scope);
    await f.service.release(scope, 'active', { saved: true });
    const disk = structuredClone(f.disk());
    await f.service.dispose();
    let runs = 0;
    const restored = new TopicMessageAdmission({
        store: { load: async () => disk, save: async () => {} },
        validate: async () => {}, commit: async () => assert.fail('cancelled message resurrected'),
        advance: async () => { runs++; },
    });
    await restored.initialize();
    await restored.resume(scope);
    await tick();
    assert.equal(runs, 0);
    assert.deepEqual(restored.snapshot(scope), []);
    await restored.dispose();
});

test('Stop includes a submission whose acceptance journal is still being written', async () => {
    let enter, unblock, armed = true;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { unblock = resolve; });
    const requests = [], history = [];
    const f = await fixture({
        store: { load: async () => [], save: async next => {
            if (armed && next.some(entry => entry.message.id === 'accepting')) {
                armed = false; enter(); await blocked;
            }
        } },
        commit: async (_scope, message) => history.push(message),
        advance: async request => requests.push(request),
    });
    const accepting = post(f.service, scope, 'accepting');
    await entered;
    const stopped = f.service.cancelPending(scope);
    unblock();
    await accepting;
    await stopped;
    await tick();
    assert.equal(requests.length, 0);
    assert.equal(history.length, 0);
    assert.deepEqual(f.service.snapshot(scope), []);
    await f.service.dispose();
});

test('active Stop during relay journal removes old continuation but preserves a later submission', async () => {
    let enter, unblock, armed = false;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { unblock = resolve; });
    const requests = [];
    const f = await fixture({
        store: { load: async () => [], save: async next => {
            if (armed && next.some(entry => entry.kind === 'relay-continuation')) {
                armed = false; enter(); await blocked;
            }
        } },
        advance: async request => requests.push(request),
    });
    await f.service.acquire(scope, 'old');
    armed = true;
    const relay = f.service.relay(scope, 'old', { saved: true });
    await entered;
    const stopped = f.service.cancelPending(scope);
    const fresh = post(f.service, scope, 'fresh');
    unblock();
    await relay;
    await stopped;
    await fresh;
    await tick();
    assert.deepEqual(requests.map(request => request.messageId), ['fresh']);
    assert.equal(f.service.snapshot(scope).some(entry => entry.kind === 'relay-continuation'), false);
    await f.service.dispose();
});