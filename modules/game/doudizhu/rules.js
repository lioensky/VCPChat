'use strict';
const { randomInt } = require('node:crypto');
const { DECK, RULES_VERSION, classify, beats, sortCards } = require('./cards');

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}
function deal(integer = randomInt) {
    const deck = DECK.map(card => card.id);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = integer(i + 1);
        if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError('Invalid random index.');
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return {
        hands: [0, 1, 2].map(index => sortCards(deck.slice(index * 17, index * 17 + 17))),
        bottom: deck.slice(51),
    };
}
function create({ firstSeat = 0, integer = randomInt } = {}) {
    if (![0, 1, 2].includes(firstSeat)) throw new RangeError('Invalid first seat.');
    return {
        rulesVersion: RULES_VERSION, revision: 0, phase: 'bidding',
        turn: firstSeat, firstSeat, dealNumber: 1,
        ...deal(integer), bids: [], highestBid: 0, bidder: null,
        landlord: null, target: null, passes: 0, winner: null,
        events: [],
    };
}
function expression(action) {
    const speech = action.speech ?? '';
    const emoteUrl = action.emoteUrl ?? '';
    if (typeof speech !== 'string' || speech.length > 2000) fail('INVALID_SPEECH', '发言须为不超过2000字符的文本。');
    if (typeof emoteUrl !== 'string' || emoteUrl.length > 2048) fail('INVALID_EMOTE', '表情URL无效。');
    if (emoteUrl) {
        let url;
        try { url = new URL(emoteUrl); } catch { fail('INVALID_EMOTE', '表情URL无效。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            fail('INVALID_EMOTE', '表情仅支持无凭证的HTTP/HTTPS URL。');
        }
    }
    return { ...(speech ? { speech } : {}), ...(emoteUrl ? { emoteUrl } : {}) };
}
function apply(state, seat, action, { integer = randomInt } = {}) {
    if (state.rulesVersion !== RULES_VERSION) fail('RULES_VERSION', '不支持的规则版本。');
    if (state.phase === 'finished') fail('FINISHED', '对局已结束。');
    if (![0, 1, 2].includes(seat) || seat !== state.turn) fail('NOT_YOUR_TURN', '现在不是你的行动窗口。');
    if (!action || typeof action !== 'object' || Array.isArray(action)) fail('INVALID_ACTION', '动作参数无效。');
    const words = expression(action);
    const next = structuredClone(state);
    const events = [];
    const publish = fields => {
        const event = { id: `event-${next.events.length + 1}`, ...fields };
        next.events.push(event);
        events.push(event);
    };
    if (state.phase === 'bidding') {
        if (action.type !== 'bid' || !Number.isInteger(action.bid) || action.bid < 0 || action.bid > 3
            || (action.bid !== 0 && action.bid <= state.highestBid)) {
            fail('INVALID_BID', '请选择不叫(0)，或高于当前叫分的1、2、3分。');
        }
        next.bids.push({ seat, bid: action.bid });
        if (action.bid > next.highestBid) {
            next.highestBid = action.bid;
            next.bidder = seat;
        }
        publish({ phase: 'bidding', seat, type: 'bid', bid: action.bid, ...words });
        if (action.bid === 3 || next.bids.length === 3) {
            if (next.bidder === null) {
                Object.assign(next, deal(integer), {
                    bids: [], highestBid: 0, bidder: null,
                    firstSeat: (state.firstSeat + 1) % 3,
                    turn: (state.firstSeat + 1) % 3,
                    dealNumber: state.dealNumber + 1,
                });
                publish({ phase: 'bidding', type: 'redeal', dealNumber: next.dealNumber });
            } else {
                next.landlord = next.bidder;
                next.hands[next.landlord] = sortCards([...next.hands[next.landlord], ...next.bottom]);
                next.phase = 'playing';
                next.turn = next.landlord;
                publish({ phase: 'playing', type: 'landlord', seat: next.landlord, bottom: [...next.bottom] });
            }
        } else next.turn = (seat + 1) % 3;
    } else if (state.phase === 'playing') {
        if (action.type === 'pass') {
            if (!state.target || state.target.seat === seat) fail('CANNOT_PASS', '新一轮首出不能不出。');
            next.passes += 1;
            publish({ phase: 'playing', seat, type: 'pass', ...words });
            if (next.passes === 2) {
                next.turn = state.target.seat;
                next.target = null;
                next.passes = 0;
            } else next.turn = (seat + 1) % 3;
        } else if (action.type === 'play') {
            const combination = classify(action.cards);
            if (!combination) fail('INVALID_COMBINATION', '不是合法牌型，或包含重复/未知实体牌。');
            if (!action.cards.every(card => state.hands[seat].includes(card))) {
                fail('CARD_NOT_OWNED', '只能出自己手里的实体牌。');
            }
            if (!beats(combination, state.target?.combination)) fail('CANNOT_BEAT', '该牌不能压过当前有效上家牌。');
            const selected = new Set(action.cards);
            next.hands[seat] = next.hands[seat].filter(card => !selected.has(card));
            next.target = { seat, cards: sortCards(action.cards), combination };
            next.passes = 0;
            publish({
                phase: 'playing', seat, type: 'play', cards: [...next.target.cards],
                combination, remaining: next.hands[seat].length, ...words,
            });
            if (next.hands[seat].length === 0) {
                next.phase = 'finished';
                next.turn = null;
                next.winner = seat === next.landlord ? 'landlord' : 'farmers';
                publish({ phase: 'finished', type: 'finished', seat, winner: next.winner });
            } else next.turn = (seat + 1) % 3;
        } else fail('INVALID_ACTION', '出牌阶段仅支持play或pass。');
    } else fail('INVALID_PHASE', '未知对局阶段。');
    next.revision += 1;
    return { state: next, events };
}
function publicView(state) {
    return structuredClone({
        rulesVersion: state.rulesVersion, revision: state.revision,
        phase: state.phase, turn: state.turn, dealNumber: state.dealNumber,
        bids: state.bids, highestBid: state.highestBid, landlord: state.landlord,
        bottom: state.landlord === null ? [] : state.bottom,
        remaining: state.hands.map(hand => hand.length),
        target: state.target, winner: state.winner, events: state.events,
    });
}
function observation(state, seat) {
    if (![0, 1, 2].includes(seat)) throw new RangeError('Invalid observation seat.');
    const view = publicView(state);
    return {
        ...view, seat, hand: [...state.hands[seat]],
        ...require('./decisionData').decisionData({ ...view, hand: state.hands[seat] }),
        canPass: state.phase === 'playing' && state.turn === seat
            && state.target !== null && state.target.seat !== seat,
    };
}
module.exports = { create, apply, publicView, observation };