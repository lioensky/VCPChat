'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../modules/game/doudizhu/rules');
const integer = () => 0;
const fresh = () => rules.create({ integer });
test('发牌守恒，公开视图不含手牌和未揭示底牌', () => {
    const state = fresh();
    assert.deepEqual(state.hands.map(hand => hand.length), [17, 17, 17]);
    assert.equal(new Set([...state.hands.flat(), ...state.bottom]).size, 54);
    assert.equal('hands' in rules.publicView(state), false);
    assert.deepEqual(rules.publicView(state).bottom, []);
    assert.deepEqual(rules.observation(state, 1).hand, state.hands[1]);
    assert.equal('hands' in rules.observation(state, 1), false);
});
test('叫3分直接成为地主，底牌公开且归地主', () => {
    const state = fresh();
    const { state: next, events } = rules.apply(state, 0, { type: 'bid', bid: 3, speech: '我来。' });
    assert.equal(next.phase, 'playing');
    assert.equal(next.turn, 0);
    assert.equal(next.landlord, 0);
    assert.equal(next.hands[0].length, 20);
    assert.deepEqual(rules.publicView(next).bottom, state.bottom);
    assert.equal(events[0].speech, '我来。');
    assert.equal(state.phase, 'bidding');
});
test('三人不叫重新发牌并轮换首叫座位', () => {
    let state = fresh();
    for (const seat of [0, 1, 2]) state = rules.apply(state, seat, { type: 'bid', bid: 0 }, { integer }).state;
    assert.equal(state.dealNumber, 2);
    assert.equal(state.turn, 1);
    assert.equal(state.bids.length, 0);
    assert.equal(state.events.at(-1).type, 'redeal');
});
test('非法叫分、越座位、危险表情URL均不改变状态', () => {
    const state = fresh();
    const before = structuredClone(state);
    for (const [seat, action, code] of [
        [1, { type: 'bid', bid: 3 }, 'NOT_YOUR_TURN'],
        [0, { type: 'bid', bid: '3' }, 'INVALID_BID'],
        [0, { type: 'bid', bid: 3, emoteUrl: 'javascript:alert(1)' }, 'INVALID_EMOTE'],
    ]) assert.throws(() => rules.apply(state, seat, action), { code });
    assert.deepEqual(state, before);
});
test('连续两次不出把首出权交还有效上家，不生成假台词', () => {
    let state = rules.apply(fresh(), 0, { type: 'bid', bid: 3 }).state;
    assert.throws(() => rules.apply(state, 0, { type: 'pass' }), { code: 'CANNOT_PASS' });
    const card = state.hands[0][0];
    state = rules.apply(state, 0, { type: 'play', cards: [card] }).state;
    assert.equal('speech' in state.events.at(-1), false);
    state = rules.apply(state, 1, { type: 'pass' }).state;
    state = rules.apply(state, 2, { type: 'pass' }).state;
    assert.equal(state.turn, 0);
    assert.equal(state.target, null);
    assert.equal(state.passes, 0);
});
test('压牌失败和出别人的牌不改变手牌；最后一张触发团队胜负', () => {
    const state = rules.apply(fresh(), 0, { type: 'bid', bid: 3 }).state;
    state.hands = [['S3'], ['S4'], ['S5']];
    assert.throws(() => rules.apply(state, 0, { type: 'play', cards: ['S4'] }), { code: 'CARD_NOT_OWNED' });
    const next = rules.apply(state, 0, { type: 'play', cards: ['S3'] }).state;
    assert.equal(next.phase, 'finished');
    assert.equal(next.winner, 'landlord');
    assert.equal(next.turn, null);
    assert.throws(() => rules.apply(next, 1, { type: 'pass' }), { code: 'FINISHED' });
    const following = structuredClone(state);
    following.turn = 1;
    assert.equal(rules.apply(following, 1, { type: 'play', cards: ['S4'] }).state.winner, 'farmers');
});
test('不同对手暗牌不会改变当前座位观察', () => {
    const a = fresh(), b = structuredClone(a);
    [b.hands[1][0], b.hands[2][0]] = [b.hands[2][0], b.hands[1][0]];
    assert.deepEqual(rules.observation(a, 0), rules.observation(b, 0));
});
test('真实发牌完整对局能结束，已出牌与剩余手牌守恒', () => {
    const { classify, beats } = require('../modules/game/doudizhu/cards');
    for (const firstSeat of [0, 1, 2]) {
        let state = rules.create({ firstSeat, integer });
        state = rules.apply(state, firstSeat, { type: 'bid', bid: 3 }).state;
        let moves = 0;
        while (state.phase !== 'finished' && moves++ < 300) {
            const seat = state.turn;
            const card = state.hands[seat].find(id => beats(classify([id]), state.target?.combination));
            state = rules.apply(state, seat, card
                ? { type: 'play', cards: [card] } : { type: 'pass' }).state;
            const played = state.events.filter(event => event.type === 'play').flatMap(event => event.cards);
            assert.equal(new Set([...played, ...state.hands.flat()]).size, 54);
            assert.equal(played.length + state.hands.flat().length, 54);
        }
        assert.equal(state.phase, 'finished');
        assert.equal(state.events.at(-1).type, 'finished');
    }
});