'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GameService } = require('../modules/services/gameService');
const { GameRuntime } = require('../modules/game/gameRuntime');
const rules = require('../modules/game/doudizhu/rules');
const { classify, beats } = require('../modules/game/doudizhu/cards');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-next-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const service = new GameService({ appDataRoot: root, integer: () => 0 });
    const table = await service.createMatch({
        groupId: 'g', topicId: 't',
        seats: [{ kind: 'human', name: '莱恩' },
            { kind: 'agent', agentId: 'a', name: '小克' },
            { kind: 'agent', agentId: 'b', name: 'Nova' }],
    });
    return { root, service, table };
}
async function finish(service, matchId) {
    const record = await service.read(matchId);
    let state = rules.apply(record.state, 0, { type: 'bid', bid: 3 }).state;
    let steps = 0;
    while (state.phase !== 'finished' && steps++ < 300) {
        const card = state.hands[state.turn].find(id => beats(classify([id]), state.target?.combination));
        state = rules.apply(state, state.turn, card
            ? { type: 'play', cards: [card] } : { type: 'pass' }).state;
    }
    assert.equal(state.phase, 'finished');
    record.state = state;
    await service.write(record);
    return record;
}
test('未结束禁止续局；结束后并发及重启重试只取得同一下一局', async t => {
    const { root, service, table } = await fixture(t);
    await assert.rejects(service.nextMatch(table.matchId), { code: 'MATCH_NOT_FINISHED' });
    const previous = await finish(service, table.matchId);
    const [a, b] = await Promise.all([service.nextMatch(table.matchId), service.nextMatch(table.matchId)]);
    assert.equal(a.matchId, b.matchId);
    assert.notEqual(a.matchId, table.matchId);
    const next = await service.read(a.matchId);
    assert.deepEqual(next.seats, previous.seats);
    assert.equal(next.groupId, 'g');
    assert.equal(next.topicId, 't');
    assert.equal(next.state.phase, 'bidding');
    assert.equal(next.state.revision, 0);
    assert.deepEqual(next.state.hands.map(hand => hand.length), [17, 17, 17]);
    assert.equal(next.pendingEvents[0].type, 'new-match');
    assert.deepEqual((await service.read(table.matchId)).state, previous.state);
    assert.equal((await new GameService({ appDataRoot: root }).nextMatch(table.matchId)).matchId, a.matchId);
});
test('下一局已落盘但父关联写失败：重试不重新发牌', async t => {
    const { service, table } = await fixture(t);
    await finish(service, table.matchId);
    const write = service.write.bind(service);
    let failed = false;
    service.write = async record => {
        if (record.matchId === table.matchId && record.nextMatchId && !failed) {
            failed = true;
            throw new Error('parent write failed');
        }
        return write(record);
    };
    await assert.rejects(service.nextMatch(table.matchId), /parent write failed/);
    const dirs = await fs.readdir(service.root);
    const childId = dirs.find(id => id !== table.matchId);
    const child = await service.read(childId);
    const retried = await service.nextMatch(table.matchId);
    assert.equal(retried.matchId, childId);
    assert.deepEqual((await service.read(childId)).state, child.state);
});
test('运行时保留公共历史，只追加一次新局边界，不创建第二个群聊', async t => {
    const { service, table } = await fixture(t);
    await finish(service, table.matchId);
    const history = [{ id: 'old', content: '上一把的聊天' }];
    const runtime = new GameRuntime({
        gameService: service, loadAgent: async () => ({}), toolInstructions: async () => '',
        runAgent: async () => { throw new Error('首叫是用户，不应请求模型'); },
        groupChat: {
            getAgentGroupConfig: async () => ({ mode: 'game', topics: [{ id: 't' }] }),
            createAgentGroup: async () => { throw new Error('续局不应新建群聊'); },
            appendGroupHistoryMessage: async (g, topic, message) => {
                assert.equal(g, 'g'); assert.equal(topic, 't');
                if (!history.some(item => item.id === message.id)) history.push(message);
            },
        },
    });
    const next = await runtime.nextTable(table.matchId);
    await runtime.nextTable(table.matchId);
    assert.equal(history.length, 2);
    assert.equal(history[0].content, '上一把的聊天');
    assert.match(history[1].content, /新一局开始/);
    assert.doesNotMatch(history[1].content, /"hand"/);
    await runtime.continue(next.matchId);
    assert.equal(runtime.getState(next.matchId).status, 'waiting-human');
    assert.deepEqual(await service.getPendingEvents(next.matchId), []);
});