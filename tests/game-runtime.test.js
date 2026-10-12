'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GameService } = require('../modules/services/gameService');
const { GameRuntime } = require('../modules/game/gameRuntime');

test('开桌到两Agent行动：只同步已提交事件，私有手牌只进入各自invite', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-runtime-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const service = new GameService({ appDataRoot: root, integer: () => 0 });
    const history = [], requests = [];
    let group;
    const backend = {
        createAgentGroup: async (_name, config) => {
            group = { ...config, id: 'g', topics: [{ id: 't' }] };
            return { success: true, agentGroup: group };
        },
        getAgentGroupConfig: async () => group,
        appendGroupHistoryMessage: async (_g, _t, message) => {
            if (!history.some(entry => entry.id === message.id)) history.push(message);
        },
    };
    const runtime = new GameRuntime({
        gameService: service, groupChat: backend,
        loadAgent: async id => ({ id, name: id, model: 'fake-model' }),
        toolInstructions: async () => '工具契约（测试适配器）',
        runAgent: async decision => {
            requests.push({ ...decision, history: structuredClone(history) });
            await service.submit(decision.matchId, decision.seat, {
                submissionId: `agent-${decision.seat}`,
                revision: decision.observation.revision,
                decisionId: decision.observation.decisionId,
                action: { type: 'pass', speech: decision.seat === 1 ? '不要。' : '' },
            });
        },
    });
    const table = await runtime.openTable({ agentIds: ['a', 'b'], userName: '莱恩' });
    assert.equal(group.mode, 'game');
    assert.equal(group.modeSettings.game.gameTypeId, 'doudizhu');
    let observation = await service.getObservation(table.matchId, 0);
    await runtime.submitHuman(table.matchId, {
        submissionId: 'human-bid', decisionId: observation.decisionId,
        revision: observation.revision, action: { type: 'bid', bid: 3 },
    });
    observation = await service.getObservation(table.matchId, 0);
    await runtime.submitHuman(table.matchId, {
        submissionId: 'human-play', decisionId: observation.decisionId,
        revision: observation.revision,
        action: { type: 'play', cards: [observation.hand[0]], speech: '接招。' },
    });
    await runtime.continue(table.matchId);
    assert.deepEqual(requests.map(request => request.agentId), ['a', 'b']);
    assert.match(requests[0].invitePrompt, /你的手牌：/);
    assert.doesNotMatch(requests[0].invitePrompt, /"events":|工具契约（测试适配器）/);
    assert.deepEqual(requests[0].observation.hand, (await service.read(table.matchId)).state.hands[1]);
    assert.deepEqual(requests[1].observation.hand, (await service.read(table.matchId)).state.hands[2]);
    assert.match(JSON.stringify(requests[1].history), /不要/);
    assert.doesNotMatch(JSON.stringify(history), /"hands":|"hand":|工具契约/);
    assert.equal(history.length, 5);
    assert.equal(new Set(history.map(message => message.id)).size, 5);
    assert.equal((await service.getObservation(table.matchId, 0)).turn, 0);
    assert.equal(runtime.getState(table.matchId).status, 'waiting-human');
    assert.deepEqual(await service.getPendingEvents(table.matchId), []);
    await assert.rejects(runtime.openTable({ agentIds: ['a', 'a'] }), /不同/);
});
test('公开历史故障不把已保存的人类动作变成失败，恢复继续同步', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-sync-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const service = new GameService({ appDataRoot: root, integer: () => 0 });
    let offline = true;
    const group = { mode: 'game', topics: [{ id: 't' }] };
    const runtime = new GameRuntime({
        gameService: service,
        groupChat: {
            getAgentGroupConfig: async () => group,
            appendGroupHistoryMessage: async () => {
                if (offline) throw new Error('history offline');
            },
        },
        loadAgent: async () => ({}), toolInstructions: async () => '',
        runAgent: async () => { throw new Error('不应邀请'); },
    });
    const { matchId } = await service.createMatch({
        seats: [{ kind: 'human' }, { kind: 'agent', agentId: 'a' }, { kind: 'agent', agentId: 'b' }],
        groupId: 'g', topicId: 't',
    });
    const observation = await service.getObservation(matchId, 0);
    const result = await runtime.submitHuman(matchId, {
        submissionId: 's', decisionId: observation.decisionId, revision: 0,
        action: { type: 'bid', bid: 3 },
    });
    assert.equal(result.accepted, true);
    assert.equal(result.synchronizationPending, true);
    assert.equal((await service.read(matchId)).state.revision, 1);
    assert.equal((await service.getPendingEvents(matchId)).length, 2);
    offline = false;
    await runtime.continue(matchId);
    assert.deepEqual(await service.getPendingEvents(matchId), []);
});