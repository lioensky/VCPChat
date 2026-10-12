'use strict';

const RULES_VERSION = 'doudizhu-standard-v1';
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['S', 'H', 'D', 'C'];
const DECK = Object.freeze([
    ...RANKS.flatMap((rank, index) => SUITS.map(suit => Object.freeze({
        id: `${suit}${rank}`, rank: index + 3,
    }))),
    Object.freeze({ id: 'BJ', rank: 16 }),
    Object.freeze({ id: 'RJ', rank: 17 }),
]);
const BY_ID = new Map(DECK.map(card => [card.id, card]));
function consecutive(ranks) {
    return ranks.length > 0 && ranks.at(-1) <= 14
        && ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1);
}
function classify(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20
        || new Set(ids).size !== ids.length || ids.some(id => !BY_ID.has(id))) return null;
    const counts = new Map();
    for (const id of ids) {
        const rank = BY_ID.get(id).rank;
        counts.set(rank, (counts.get(rank) || 0) + 1);
    }
    const ranks = [...counts.keys()].sort((a, b) => a - b);
    const n = ids.length;
    const result = (type, main, chain = 1) => ({ type, main, chain, size: n });
    const all = count => ranks.every(rank => counts.get(rank) === count);
    if (n === 2 && counts.has(16) && counts.has(17)) return result('rocket', 17);
    if (ranks.length === 1) {
        return result(({ 1: 'single', 2: 'pair', 3: 'triple', 4: 'bomb' })[n], ranks[0]);
    }
    const triple = ranks.find(rank => counts.get(rank) === 3);
    const quad = ranks.find(rank => counts.get(rank) === 4);
    if (n === 4 && triple !== undefined) return result('triple-single', triple);
    if (n === 5 && triple !== undefined && ranks.some(rank => counts.get(rank) === 2)) {
        return result('triple-pair', triple);
    }
    if (n >= 5 && all(1) && consecutive(ranks)) return result('straight', ranks.at(-1), n);
    if (n >= 6 && n % 2 === 0 && all(2) && consecutive(ranks)) {
        return result('pair-chain', ranks.at(-1), n / 2);
    }
    if (n >= 6 && n % 3 === 0 && all(3) && consecutive(ranks)) {
        return result('triple-chain', ranks.at(-1), n / 3);
    }
    if (n === 6 && quad !== undefined) return result('four-singles', quad);
    if (n === 8 && quad !== undefined && ranks.length === 3
        && ranks.filter(rank => rank !== quad).every(rank => counts.get(rank) === 2)) {
        return result('four-pairs', quad);
    }
    // Require exactly three cards for every body rank; wings cannot reuse body ranks.
    for (const [type, unit] of [['airplane-singles', 4], ['airplane-pairs', 5]]) {
        const length = n / unit;
        if (!Number.isInteger(length) || length < 2) continue;
        for (let low = 3; low + length - 1 <= 14; low++) {
            const body = Array.from({ length }, (_, index) => low + index);
            if (!body.every(rank => counts.get(rank) === 3)) continue;
            const wings = ranks.filter(rank => !body.includes(rank));
            if (type === 'airplane-singles'
                ? wings.reduce((sum, rank) => sum + counts.get(rank), 0) === length
                : wings.length === length && wings.every(rank => counts.get(rank) === 2)) {
                return result(type, body.at(-1), length);
            }
        }
    }
    return null;
}
function beats(candidate, previous) {
    if (!candidate) return false;
    if (!previous) return true;
    if (previous.type === 'rocket') return false;
    if (candidate.type === 'rocket') return true;
    if (candidate.type === 'bomb' && previous.type !== 'bomb') return true;
    return candidate.type === previous.type && candidate.size === previous.size
        && candidate.chain === previous.chain && candidate.main > previous.main;
}
function sortCards(ids) {
    return [...ids].sort((a, b) => {
        if (!BY_ID.has(a) || !BY_ID.has(b)) throw new TypeError('Unknown card ID.');
        return BY_ID.get(a).rank - BY_ID.get(b).rank || a.localeCompare(b);
    });
}
module.exports = { RULES_VERSION, DECK, classify, beats, sortCards };