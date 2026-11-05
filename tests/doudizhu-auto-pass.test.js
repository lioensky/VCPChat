'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DECK, classify, beats, canBeat } = require('../modules/game/doudizhu/cards');
const rules = require('../modules/game/doudizhu/rules');
const { GameService } = require('../modules/services/gameService');
const { GameRuntime } = require('../modules/game/gameRuntime');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cards = (...pairs) => pairs.flatMap(([rank, count]) => DECK.filter(c => c.rank === rank).slice(0, count).map(c => c.id));
const targets = [
    cards([3,1]), cards([3,2]), cards([3,3]), cards([3,4]), ['BJ','RJ'],
    cards([3,3],[8,1]), cards([3,3],[8,2]),
    cards([3,1],[4,1],[5,1],[6,1],[7,1]),
    cards([3,2],[4,2],[5,2]), cards([3,3],[4,3]),
    cards([3,4],[8,2]), cards([3,4],[8,2],[9,2]),
    cards([3,3],[4,3],[8,2]), cards([3,3],[4,3],[8,2],[9,2]),
];
function oracle(hand, previous) {
    const selected = [];
    function visit(i) {
        if (selected.length && beats(classify(selected), previous)) return true;
        if (i === hand.length) return false;
        selected.push(hand[i]);
        if (visit(i + 1)) return true;
        selected.pop();
        return visit(i + 1);
    }
    return visit(0);
}
test('全部14种牌型：压牌存在性与独立实体子集穷举一致，包含拆牌及翅膀', () => {
    assert.equal(new Set(targets.map(c => classify(c)?.type)).size, 14);
    let seed = 89123;
    const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (const target of targets) {
        const previous = classify(target);
        const stronger = target.map(id => {
            const card = DECK.find(c => c.id === id);
            return card.rank < 15 ? DECK.find(c => c.rank === card.rank + 1 && c.id[0] === id[0]).id : id;
        });
        const hands = [[], ['BJ','RJ'], cards([15,4]), stronger, [...stronger, ...DECK.map(c => c.id).filter(id => !stronger.includes(id)).slice(0, 2)]];
        for (let i = 0; i < 35; i++) {
            const deck = DECK.map(c => c.id);
            const hand = [];
            for (let j = 0, n = 5 + random(8); j < n; j++) hand.push(deck.splice(random(deck.length), 1)[0]);
            hands.push(hand);
        }
        for (const hand of hands) assert.equal(canBeat(hand, previous), oracle(hand, previous), `${previous.type}: ${hand}`);
    }
});
function playing(hands, turn = 0) {
    return { ...rules.apply(rules.create({ integer: () => 0 }), 0, { type: 'bid', bid: 3 }).state,
        hands, turn };
}
test('连续两家无解自动过、清空牌面并归还首出；同次revision且无伪台词', () => {
    const state = playing([['RJ','S3'], ['S4'], ['S5']]);
    const before = structuredClone(state);
    const result = rules.apply(state, 0, { type: 'play', cards: ['RJ'] });
    assert.deepEqual(result.events.map(e => [e.type,e.seat,e.automatic]), [['play',0,undefined],['pass',1,true],['pass',2,true]]);
    assert.equal(result.state.turn, 0);
    assert.equal(result.state.target, null);
    assert.equal(result.state.passes, 0);
    assert.equal(result.state.revision, state.revision + 1);
    assert.equal(result.events.some(e => e.speech || e.emoteUrl), false);
    assert.deepEqual(state, before);
});
test('跳过一个座位但保留能压牌的下家；炸弹和王炸不能被误跳', () => {
    for (const hand of [['RJ'], cards([3,4]), ['BJ','RJ']]) {
        const result = rules.apply(playing([['S2','S3'], ['S4'], hand]), 0, { type:'play', cards:['S2'] });
        assert.equal(result.state.turn, 2);
        assert.equal(result.state.passes, 1);
        assert.equal(result.events.length, 2);
    }
});
test('人工过牌后可自动过人类；结束和首出不自动过', () => {
    let state = playing([['S3'], ['S2','S4'], ['RJ']], 1);
    state = rules.apply(state, 1, { type:'play', cards:['S2'] }).state;
    const result = rules.apply(state, 2, { type:'pass' });
    assert.equal(result.events[1].seat, 0);
    assert.equal(result.events[1].automatic, true);
    assert.equal(result.state.turn, 1);
    assert.equal(result.state.target, null);
    assert.throws(() => rules.apply(result.state, 1, { type:'pass' }), { code:'CANNOT_PASS' });
    const end = rules.apply(playing([['RJ'], ['S4'], ['S5']]), 0, { type:'play', cards:['RJ'] });
    assert.deepEqual(end.events.map(e => e.type), ['play','finished']);
});
test('真实存档+运行时：无解Agent零邀请，自动事件outbox同步且重启重试不重复', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-auto-'));
    t.after(() => fs.rm(root, { recursive:true, force:true }));
    const service = new GameService({ appDataRoot:root, integer:() => 0 });
    const { matchId } = await service.createMatch({
        seats:[{kind:'human'}, {kind:'agent',agentId:'a'}, {kind:'agent',agentId:'b'}], groupId:'g',topicId:'t',
    });
    const record = await service.read(matchId);
    record.state = playing([['RJ','S3'], ['S4'], ['S5']]);
    await service.write(record);
    const request = {submissionId:'auto-test', decisionId:`${matchId}:${record.state.revision}`, revision:record.state.revision, action:{type:'play', cards:['RJ']}};
    const result = await service.submit(matchId, 0, request);
    assert.equal((await service.getPendingEvents(matchId)).length, 3);
    const restored = new GameService({appDataRoot:root});
    assert.deepEqual(await restored.submit(matchId, 0, request), result);
    let invitations = 0;
    const history = [];
    const runtime = new GameRuntime({
        gameService:restored,
        groupChat:{getAgentGroupConfig:async () => ({mode:'game',topics:[{id:'t'}]}),
            appendGroupHistoryMessage:async (_g,_t,m) => history.push(m)},
        loadAgent:async () => ({}), toolInstructions:async () => '',
        runAgent:async () => { invitations++; },
    });
    await runtime.continue(matchId);
    assert.equal(invitations, 0);
    assert.equal(history.length, 3);
    assert.equal(runtime.getState(matchId).status, 'waiting-human');
    assert.deepEqual(await restored.getPendingEvents(matchId), []);
    assert.equal((await restored.read(matchId)).state.turn, 0);
});
test('关闭自动过牌保留无解回合及公开发言，旧档缺省开启', () => {
    const state = playing([['RJ','S3'], ['S4'], ['S5']]);
    state.autoPass = false;
    let result = rules.apply(state, 0, {type:'play', cards:['RJ']});
    assert.equal(result.state.turn, 1);
    assert.equal(result.events.length, 1);
    result = rules.apply(result.state, 1, {type:'pass', speech:'压不住，但我还能聊！'});
    assert.equal(result.state.turn, 2);
    assert.equal(result.events[0].speech, '压不住，但我还能聊！');
    assert.equal(result.events[0].automatic, undefined);
    delete state.autoPass;
    assert.equal(rules.publicView(state).autoPass, true);
    assert.equal(rules.apply(state, 0, {type:'play',cards:['RJ']}).events.length, 3);
    assert.throws(() => rules.create({autoPass:'false'}), TypeError);
});
test('设置串行保存，不作废已邀请决策；关闭重启与续局继承', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-settings-'));
    t.after(() => fs.rm(root, {recursive:true,force:true}));
    const service = new GameService({appDataRoot:root,integer:() => 0});
    const {matchId} = await service.createMatch({
        seats:[{kind:'human'},{kind:'agent',agentId:'a'},{kind:'agent',agentId:'b'}],
        groupId:'g',topicId:'t',autoPass:false,
    });
    assert.equal((await service.getObservation(matchId,0)).autoPass, false);
    const record = await service.read(matchId);
    record.state = {...playing([['RJ','S3'],['S4'],['S5']]),autoPass:true};
    await service.write(record);
    const before = await service.getObservation(matchId,0);
    const request = {submissionId:'settings-play',revision:before.revision,decisionId:before.decisionId,action:{type:'play',cards:['RJ']}};
    const [,result] = await Promise.all([service.updateAutoPass(matchId,false),service.submit(matchId,0,request)]);
    assert.equal(result.events.length,1);
    const restored = new GameService({appDataRoot:root});
    const observation = await restored.getObservation(matchId,1);
    assert.equal(observation.autoPass,false);
    assert.equal(observation.turn,1);
    assert.equal(observation.revision,before.revision + 1);
    await assert.rejects(service.updateAutoPass(matchId,'false'),{code:'INVALID_SETTINGS'});
    const finished = await restored.read(matchId);
    finished.state.phase = 'finished';
    finished.state.turn = null;
    await restored.write(finished);
    const next = await restored.nextMatch(matchId);
    assert.equal(next.observation.autoPass,false);
    await restored.updateAutoPass(next.matchId,true);
    assert.equal((await restored.getObservation(next.matchId,0)).autoPass,true);
});