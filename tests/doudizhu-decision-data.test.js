'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../modules/game/doudizhu/rules');
const { decisionData, cardName } = require('../modules/game/doudizhu/decisionData');
const { formatInvite } = require('../Groupmodules/modes/gamePrompts');
test('本轮从首出起记录动作，连续两家不出后清空并递增', () => {
    let state = rules.apply(rules.create({ integer: () => 0 }), 0, { type: 'bid', bid: 3 }).state;
    const card = state.hands[0][0];
    state = rules.apply(state, 0, { type: 'play', cards: [card], speech: '不应进入本轮摘要' }).state;
    state = rules.apply(state, 1, { type: 'pass' }).state;
    let o = rules.observation(state, 2);
    assert.deepEqual(o.currentTrick.actions.map(a => a.type), ['play', 'pass']);
    assert.equal(o.currentTrick.consecutivePasses, 1);
    assert.equal('speech' in o.currentTrick.actions[0], false);
    assert.equal(o.cardTracker.bySeat[0].count, 1);
    assert.equal(o.cardTracker.played.count, 1);
    assert.equal(o.cardTracker.unplayed.count, 53);
    assert.equal(o.cardTracker.otherPlayersPool.count, state.hands[0].length + state.hands[1].length);
    state = rules.apply(state, 2, { type: 'pass' }).state;
    o = rules.observation(state, 0);
    assert.equal(o.currentTrick.number, 2);
    assert.deepEqual(o.currentTrick.actions, []);
    assert.equal(o.cardTracker.played.count, 1);
    const swapped = structuredClone(state);
    [swapped.hands[1][0], swapped.hands[2][0]] = [swapped.hands[2][0], swapped.hands[1][0]];
    assert.deepEqual(rules.observation(swapped, 0), o);
});
test('重发牌边界之前的出牌不计入本次统计，叫分未知池包含底牌', () => {
    const o = rules.observation(rules.create({ integer: () => 0 }), 0);
    o.events = [
        { type: 'play', seat: 1, cards: ['RJ'], combination: { type: 'single' } },
        { type: 'redeal', dealNumber: 2 },
    ];
    const data = decisionData(o);
    assert.equal(data.cardTracker.played.count, 0);
    assert.equal(data.cardTracker.otherPlayersPool.count, 37);
    assert.equal(data.cardTracker.otherPlayersPool.includesUndealtBottom, true);
    assert.deepEqual(data.currentTrick.actions, []);
});
test('Markdown显示玩家阵营、可读牌名及统计，不复制台词或分配他家暗牌', () => {
    let state = rules.apply(rules.create({ integer: () => 0 }), 0, { type: 'bid', bid: 3 }).state;
    state = rules.apply(state, 0, { type: 'play', cards: [state.hands[0][0]] }).state;
    const o = {
        ...rules.observation(state, 1), matchId: 'm', decisionId: 'm:2',
        players: [{ seat: 0, name: '莱恩' }, { seat: 1, name: '小克' }, { seat: 2, name: 'Nova' }],
    };
    const text = formatInvite({ observation: o });
    assert.match(text, /小克（你）/);
    assert.match(text, /莱恩 · 地主 · 对手/);
    assert.match(text, /Nova · 农民 · 队友/);
    assert.match(text, /### 当前出牌轮/);
    assert.match(text, /### 记牌器/);
    assert.match(text, /全桌累计已出（1张）/);
    assert.match(text, /其他两家合计未出牌/);
    assert.match(text, /不代表任何单家手牌/);
    assert.equal(cardName('SQ'), '黑桃Q');
    assert.equal(cardName('BJ'), '小王');
});