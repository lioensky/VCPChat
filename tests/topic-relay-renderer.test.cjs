'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ compress = false, pending = true, failCompact = false } = {}) {
    const source = fs.readFileSync('modules/chatManager.js', 'utf8');
    const start = source.indexOf('    const streamCompactionRequests = new Map();');
    const end = source.indexOf('    async function prepareFlowlockContext(', start);
    assert.ok(start > 0 && end > start);
    const events = [];
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    const context = { agentId: 'a', topicId: 't', admissionToken: 'old' };
    const sandbox = {
        disposed: false, console,
        setTimeout, clearTimeout, INTERRUPT_SETTLE_MS: 10,
        globalSettingsRef: { get: () => ({ enableContextCompaction: compress }) },
        currentSelectedItemRef: { get: () => ({ id: 'a', type: 'agent', config: { contextTokenLimit: 10 } }) },
        currentTopicIdRef: { get: () => 't' },
        currentChatHistoryRef: { get: () => [] },
        effectiveContextHistory: value => value,
        estimateContextTokens: () => 100,
        notifySendStateChanged() {},
        uiHelper: {},
        compactionFlowlock: { suspendForContextCompaction() { events.push('suspend'); } },
        interruptCapability: { async interrupt() { events.push('stop'); return { success: true }; } },
        electronAPI: {
            async topicAdmissionList() {
                events.push('list');
                return { success: true, entries: pending
                    ? [{ scope, state: 'queued', message: { id: 'letter', role: 'assistant' } }] : [] };
            },
            async topicAdmissionRelay(_scope, _token, outcome) {
                events.push(outcome?.cancelled ? 'cancel' : 'relay');
                return { success: true };
            },
            async topicAdmissionFail() { assert.fail('relay cancellation must use durable pause'); },
            async topicAdmissionUncertain() { events.push('uncertain'); return { success: true }; },
        },
        async getHistory() { events.push('history'); return []; },
        async syncHistoryFromFile() { events.push('sync'); },
        contextCompactionService: {
            async compact({ onCommitted }) {
                events.push('compact');
                if (failCompact) throw new Error('compact failed');
                await onCommitted();
                return {};
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(start, end) + `
        this.check = checkStreamContextBudget;
        this.finish = finishStreamAdmissionRelay;
        this.has = hasStreamAdmissionRelay;
        this.cancel = () => { streamCompactionRequests.get('live').cancelled = true; };
    `, sandbox);
    return { events, context, sandbox,
        check: () => sandbox.check({ messageId: 'live', context, text: 'tool result' }),
        finish: () => sandbox.finish({ messageId: 'live', context }) };
}

for (const compress of [false, true]) {
    test(`tool boundary relay shares one Stop and one continuation; compression=${compress}`, async () => {
        const f = fixture({ compress });
        await Promise.all([f.check(), f.check()]);
        assert.equal(f.sandbox.has('live'), true);
        assert.equal(f.events.filter(value => value === 'stop').length, 1);
        assert.equal(f.events.includes('relay'), false, 'never hand over before persistence');
        await f.finish(); // Called only by adapter after successful persistence.
        assert.equal(f.events.filter(value => value === 'relay').length, 1);
        if (compress) assert.ok(f.events.indexOf('compact') < f.events.indexOf('relay'));
        assert.equal(f.sandbox.has('live'), false);
        assert.equal(await f.finish(), false);
    });
}

test('no pending message and no compression leaves stream untouched', async () => {
    const f = fixture({ pending: false });
    await f.check();
    assert.deepEqual(f.events, ['list']);
    assert.equal(f.sandbox.has('live'), false);
});

test('failed compression retains ownership and does not dispatch relay', async () => {
    const f = fixture({ compress: true, failCompact: true });
    await f.check();
    await assert.rejects(f.finish(), /compact failed/);
    assert.equal(f.events.includes('relay'), false);
    assert.equal(f.events.at(-1), 'uncertain');
});

test('explicit cancellation prevents relay continuation', async () => {
    const f = fixture();
    await f.check();
    f.sandbox.cancel();
    await f.finish();
    assert.equal(f.events.includes('relay'), false);
    assert.equal(f.events.at(-1), 'cancel');
});

for (const extra of [{ isGroupMessage: true }, { groupId: 'g' }, { topicId: 'sidechat_123_abcd' }]) {
    test(`tool relay excludes non-main-chat context ${JSON.stringify(extra)}`, async () => {
        const f = fixture();
        Object.assign(f.context, extra);
        await f.check();
        assert.deepEqual(f.events, []);
    });
}
test('natural terminal during pending-list await revokes the late boundary check', async () => {
    const f = fixture();
    let resolveList;
    let active = true;
    f.sandbox.electronAPI.topicAdmissionList = () => new Promise(resolve => { resolveList = resolve; });
    const checking = f.sandbox.check({
        messageId: 'live', context: f.context, text: 'tools returned',
        isActive: () => active,
    });
    active = false;
    resolveList({ success: true, entries: [{
        scope: { itemType: 'agent', itemId: 'a', topicId: 't' },
        state: 'queued', message: { id: 'letter', role: 'assistant' },
    }] });
    await checking;
    assert.deepEqual(f.events, []);
    assert.equal(f.sandbox.has('live'), false);
});
for (const mode of ['accepted-without-terminal', 'ack-never-settles']) {
    test(`relay Stop has bounded local fallback: ${mode}`, async () => {
        const f = fixture();
        f.sandbox.interruptCapability.interrupt = () => {
            f.events.push('stop');
            return mode === 'ack-never-settles'
                ? new Promise(() => {}) : Promise.resolve({ success: true });
        };
        await f.sandbox.check({
            messageId: 'live', context: f.context, text: 'result',
            cancelStream: async (_id, reason) => { f.events.push('local-cancel'); assert.match(reason, /tool-return-relay/); },
        });
        assert.equal(f.events.filter(value => value === 'local-cancel').length, 1);
        assert.equal(f.events.includes('relay'), false, 'Stop fallback is not persistence proof');
        await f.finish();
        assert.equal(f.events.at(-1), 'relay');
    });
}
test('user Stop during queue lookup revokes relay before upstream terminal arrives', async () => {
    const f = fixture();
    let resolveList;
    f.sandbox.electronAPI.topicAdmissionList = () => new Promise(resolve => { resolveList = resolve; });
    const checking = f.check();
    vm.runInContext("cancelStreamAdmissionRelay('live')", f.sandbox);
    resolveList({ success: true, entries: [{
        scope: { itemType: 'agent', itemId: 'a', topicId: 't' },
        state: 'queued', message: { id: 'letter', role: 'assistant' },
    }] });
    await checking;
    assert.deepEqual(f.events, []);
    assert.equal(f.sandbox.has('live'), false);
});
test('user Stop remains revoked across later tool boundaries until stream settles', async () => {
    const f = fixture();
    let resolveList;
    let lookups = 0;
    f.sandbox.electronAPI.topicAdmissionList = () => {
        lookups++;
        return new Promise(resolve => { resolveList = resolve; });
    };
    const checking = f.check();
    vm.runInContext("cancelStreamAdmissionRelay('live')", f.sandbox);
    resolveList({ success: true, entries: [] });
    await checking;
    await f.check();
    assert.equal(lookups, 1, 'later boundaries must not restart the cancelled lookup');
    assert.deepEqual(f.events, []);
    vm.runInContext("abandonStreamContextCompaction({ messageId: 'live', event: {} })", f.sandbox);
    assert.equal(vm.runInContext("streamBoundaryChecks.size", f.sandbox), 0);
});
test('user Stop before the first boundary prevents a later relay lookup', async () => {
    const f = fixture();
    vm.runInContext("cancelStreamAdmissionRelay('live')", f.sandbox);
    await f.check();
    assert.deepEqual(f.events, []);
    assert.equal(f.sandbox.has('live'), false);
    vm.runInContext("abandonStreamContextCompaction({ messageId: 'live', event: {} })", f.sandbox);
    assert.equal(vm.runInContext("streamBoundaryChecks.size", f.sandbox), 0);
});
test('Stop while relay IPC is pending sends the host cancellation signal once', async () => {
    const f = fixture();
    await f.check();
    let resolveRelay;
    const signals = [];
    f.sandbox.electronAPI.topicAdmissionRelay = () => new Promise(resolve => { resolveRelay = resolve; });
    f.sandbox.electronAPI.topicAdmissionCancelRelay = (scope, token) => {
        signals.push({ scope: JSON.parse(JSON.stringify(scope)), token });
        return Promise.resolve({ success: true, accepted: true });
    };
    const finishing = f.finish();
    vm.runInContext("cancelStreamAdmissionRelay('live'); cancelStreamAdmissionRelay('live')", f.sandbox);
    assert.deepEqual(signals, [{ scope: { itemType: 'agent', itemId: 'a', topicId: 't' }, token: 'old' }]);
    assert.equal(f.sandbox.has('live'), true, 'signal acceptance is not durable handover completion');
    resolveRelay({ success: true, cancelled: true, paused: true });
    await finishing;
    assert.equal(f.sandbox.has('live'), false);
});