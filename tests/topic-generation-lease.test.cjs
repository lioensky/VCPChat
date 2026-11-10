'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withTopicGenerationLease } = require('../modules/services/topicGenerationLease');
const scope = { itemType: 'group', itemId: 'g', topicId: 't' };

function fixture(operation, overrides = {}) {
    const calls = [];
    const admission = {
        acquire: async (...args) => { calls.push(['acquire', ...args]); return { success: true }; },
        release: async (...args) => { calls.push(['release', ...args]); return { success: true }; },
        ...overrides,
    };
    return { calls, run: () => withTopicGenerationLease({ admission, scope, token: 'lease', operation }) };
}

test('busy lease never executes generation', async () => {
    let started = false;
    const f = fixture(async () => { started = true; }, {
        acquire: async () => ({ success: false, code: 'MESSAGES_PENDING' }),
    });
    await assert.rejects(f.run(), error => error.code === 'MESSAGES_PENDING');
    assert.equal(started, false);
});

test('preparation failure releases exact lease and retains original error', async () => {
    const error = new Error('prepare failed');
    const f = fixture(async () => { throw error; });
    await assert.rejects(f.run(), value => value === error);
    assert.deepEqual(f.calls[1], ['release', scope, 'lease', { saved: true }]);
});

test('dispatch alone never releases even when operation returns normally', async () => {
    const f = fixture(async lifecycle => { lifecycle.dispatched(); return 'stream started'; });
    assert.equal(await f.run(), 'stream started');
    assert.equal(f.calls.length, 1);
});

test('durable terminal releases even if a later UI effect fails', async () => {
    const error = new Error('UI failed');
    const f = fixture(async lifecycle => {
        lifecycle.dispatched();
        lifecycle.committed();
        throw error;
    });
    await assert.rejects(f.run(), value => value === error);
    assert.equal(f.calls[1][0], 'release');
});

test('uncertain save retains lease', async () => {
    const f = fixture(async lifecycle => { lifecycle.dispatched(); throw new Error('disk failed'); });
    await assert.rejects(f.run(), /disk failed/);
    assert.equal(f.calls.length, 1);
});

test('release failure does not erase original generation error', async () => {
    const original = new Error('prepare failed');
    const f = fixture(async () => { throw original; }, {
        release: async () => ({ success: false, code: 'STALE_LEASE' }),
    });
    await assert.rejects(f.run(), error =>
        error instanceof AggregateError && error.errors[0] === original
        && /STALE_LEASE/.test(error.errors[1].message));
});
test('wait mode delegates cancellation and timeout to idle admission before executing', async () => {
    const calls = [];
    const controller = new AbortController();
    const admission = {
        acquire: async () => { throw new Error('must not bypass waiting'); },
        acquireWhenIdle: async (...args) => { calls.push(args); return { success: true }; },
        release: async () => ({ success: true }),
    };
    await withTopicGenerationLease({
        admission, scope, token: 'waiting', wait: true,
        signal: controller.signal, timeoutMs: 500,
        operation: async lifecycle => { lifecycle.dispatched(); lifecycle.committed(); },
    });
    assert.deepEqual(calls, [[scope, 'waiting', { signal: controller.signal, timeoutMs: 500 }]]);
});

test('both group generation requests retain configured authorization', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../Groupmodules/groupchat.js'), 'utf8');
    assert.doesNotMatch(source, /globalSettingsUnusedNeverRead/);
    assert.equal(source.match(/'Authorization': `Bearer \$\{globalVcpSettings\.vcpApiKey\}`/g)?.length, 2);
});
test('explicit orchestration handoff owner reaches idle admission unchanged', async () => {
    const calls = [];
    const admission = {
        acquire: async () => { throw new Error('unexpected immediate acquire'); },
        acquireWhenIdle: async (...args) => {
            calls.push(args);
            return { success: true };
        },
        release: async () => ({ success: true }),
    };
    await withTopicGenerationLease({
        admission, scope, token: 'member', wait: true,
        handoffOwner: 'group-run-42',
        operation: async () => 'prepared without dispatch',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].handoffOwner, 'group-run-42');
});

test('dispatched failure journals uncertainty without releasing and preserves original error', async () => {
    const original = new Error('terminal unknown');
    const reports = [];
    const f = fixture(async lifecycle => { lifecycle.dispatched(); throw original; }, {
        reportUncertain: async (...args) => { reports.push(args); return { success: true }; },
    });
    await assert.rejects(f.run(), error => error === original);
    assert.deepEqual(reports, [[scope, 'lease', original]]);
    assert.equal(f.calls.length, 1);
});

test('uncertainty journal failure retains both errors without releasing', async () => {
    const original = new Error('terminal unknown');
    const diagnostic = new Error('journal unavailable');
    const f = fixture(async lifecycle => { lifecycle.dispatched(); throw original; }, {
        reportUncertain: async () => { throw diagnostic; },
    });
    await assert.rejects(f.run(), error => error instanceof AggregateError
        && error.errors[0] === original && error.errors[1] === diagnostic);
    assert.equal(f.calls.length, 1);
});

test('generation lifecycle exposes the exact acquired token to terminal persistence', async () => {
    let received;
    const f = fixture(async lifecycle => { received = lifecycle.token; });
    await f.run();
    assert.equal(received, 'lease');
    assert.equal(f.calls[0][2], received);
});