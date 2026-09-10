import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AgentEditSession = require('../modules/settings/agent-edit-session.js');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('save snapshots remain immutable and preserve edits made in flight', async () => {
    const started = deferred();
    const release = deferred();
    const writes = [];
    const session = new AgentEditSession({
        agentId: 'A',
        config: { name: 'base' },
        revision: 'r0',
        transport: async (agentId, transaction) => {
            writes.push({ agentId, transaction: structuredClone(transaction) });
            if (writes.length === 1) {
                started.resolve();
                await release.promise;
            }
            return { success: true, currentRevision: `r${writes.length}` };
        },
    });
    session.edit({ name: 'first' });
    const first = session.flush();
    await started.promise;
    session.edit({ name: 'second' });
    const second = session.flush();
    release.resolve();
    await first;
    assert.equal(session.dirty, true);
    await second;
    assert.equal(session.dirty, false);
    assert.equal(session.base.name, 'second');
    assert.equal(writes[0].transaction.patch.name, 'first');
    assert.equal(writes[1].transaction.patch.name, 'second');
    assert.equal(writes[1].transaction.expectedRevision, 'r1');
    assert.ok(Object.isFrozen(session.draft));
});

test('failed save retains the draft and retries against the same revision', async () => {
    const writes = [];
    const session = new AgentEditSession({
        agentId: 'A',
        config: { originalSystemPrompt: 'base' },
        revision: 'r0',
        transport: async (agentId, transaction) => {
            writes.push({ agentId, transaction });
            return writes.length === 1
                ? { success: false, status: 'failed', error: 'disk unavailable' }
                : { success: true, currentRevision: 'r1' };
        },
    });
    session.edit({ originalSystemPrompt: '' });
    assert.equal((await session.flush()).success, false);
    assert.equal(session.dirty, true);
    assert.equal(session.draft.originalSystemPrompt, '');
    assert.equal(session.base.originalSystemPrompt, 'base');
    assert.equal((await session.flush()).success, true);
    assert.equal(writes[1].transaction.expectedRevision, 'r0');
    assert.equal(session.base.originalSystemPrompt, '');
});

test('conflict blocks blind retry and prevents closing a dirty session', async () => {
    let calls = 0;
    const session = new AgentEditSession({
        agentId: 'A',
        config: { name: 'base' },
        revision: 'r0',
        transport: async () => {
            calls += 1;
            return { success: false, status: 'conflict', currentRevision: 'external' };
        },
    });
    session.edit({ name: 'local' });
    await session.flush();
    session.edit({ name: 'new local' });
    assert.equal((await session.close()).status, 'conflict');
    assert.equal(calls, 1);
    assert.equal(session.closed, false);
    assert.equal(session.dirty, true);
    assert.equal(session.revision, 'r0');
    assert.equal(session.draft.name, 'new local');
});

test('Agent queues do not reassign a delayed save to another Agent', async () => {
    const release = deferred();
    const writes = [];
    const makeSession = agentId => new AgentEditSession({
        agentId,
        config: { name: agentId },
        revision: 'r0',
        transport: async (targetId, transaction) => {
            if (targetId === 'A') await release.promise;
            writes.push({ targetId, patch: structuredClone(transaction.patch) });
            return { success: true, currentRevision: 'r1' };
        },
    });
    const a = makeSession('A');
    const b = makeSession('B');
    a.edit({ name: 'edited A' });
    const pending = a.flush();
    b.edit({ name: 'edited B' });
    await b.flush();
    release.resolve();
    await pending;
    assert.deepEqual(writes, [
        { targetId: 'B', patch: { name: 'edited B' } },
        { targetId: 'A', patch: { name: 'edited A' } },
    ]);
});