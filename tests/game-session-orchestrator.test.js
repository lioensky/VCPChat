'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameSessionOrchestrator } = require('../Groupmodules/gameSessionOrchestrator');
function fixture(runAgent, appendEvent = async () => {}) {
    const record = {
        groupId: 'g', topicId: 't',
        seats: [{ kind: 'human' }, { kind: 'agent', agentId: 'a' }, { kind: 'agent', agentId: 'b' }],
        state: { phase: 'playing', turn: 1, revision: 0 }, pendingEvents: [],
    };
    const service = {
        read: async () => structuredClone(record),
        getObservation: async (_id, seat) => ({
            seat, revision: record.state.revision,
            decisionId: `m:${record.state.revision}`, hand: [`private-${seat}`],
        }),
        acknowledgeEvents: async (_id, ids) => {
            record.pendingEvents = record.pendingEvents.filter(event => !ids.includes(event.id));
        },
    };
    const orchestrator = new GameSessionOrchestrator({
        gameService: service, appendEvent,
        runAgent: request => runAgent(request, record),
    });
    return { record, orchestrator };
}
test('按规则邀请两个Agent，然后停在用户；同局并发启动共用请求', async () => {
    const requests = [];
    const { orchestrator } = fixture(async (request, record) => {
        requests.push(request);
        record.state.revision++;
        record.state.turn = (record.state.turn + 1) % 3;
    });
    const first = orchestrator.start('m');
    assert.equal(orchestrator.start('m'), first);
    await first;
    assert.deepEqual(requests.map(request => request.agentId), ['a', 'b']);
    assert.deepEqual(requests.map(request => request.observation.hand), [['private-1'], ['private-2']]);
    assert.equal(orchestrator.getState('m').status, 'waiting-human');
    assert.equal(orchestrator.getState('m').running, false);
});
test('只说话未提交：初邀加两次提醒，然后暂停，不假装过牌', async () => {
    const reminders = [];
    const { record, orchestrator } = fixture(async request => reminders.push(request.reminder));
    await orchestrator.start('m');
    assert.deepEqual(reminders, [false, true, true]);
    assert.equal(record.state.revision, 0);
    assert.equal(record.state.turn, 1);
    assert.equal(orchestrator.getState('m').reason, 'decision_not_submitted');
});
test('公开事件同步失败时保留outbox且不请求模型，恢复可重试', async () => {
    let fail = true, calls = 0;
    const published = [];
    const { record, orchestrator } = fixture(async (_request, state) => {
        calls++;
        state.state.turn = 0;
        state.state.revision++;
    }, async payload => {
        if (fail) throw new Error('history unavailable');
        published.push(payload.messageId);
    });
    record.pendingEvents.push({ id: 'event-1', type: 'pass' });
    await assert.rejects(orchestrator.start('m'), /history unavailable/);
    assert.equal(calls, 0);
    assert.equal(record.pendingEvents.length, 1);
    fail = false;
    await orchestrator.start('m');
    assert.deepEqual(published, ['m:event-1']);
    assert.equal(record.pendingEvents.length, 0);
    assert.equal(calls, 1);
});
test('停止后等当前请求完成，不邀请下一座位', async () => {
    const requests = [];
    let orchestrator;
    ({ orchestrator } = fixture(async (request, record) => {
        requests.push(request.agentId);
        orchestrator.stop('m');
        record.state.turn = 2;
        record.state.revision++;
    }));
    await orchestrator.start('m');
    assert.deepEqual(requests, ['a']);
    assert.equal(orchestrator.getState('m').reason, 'stopped');
});