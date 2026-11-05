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
// Existence only, not strategy: rank-equivalent physical cards need not be enumerated.
function canBeat(hand, previous) {
    if (!previous) return hand.length > 0;
    if (previous.type === 'rocket') return false;
    const groups = new Map();
    for (const id of hand) {
        const rank = BY_ID.get(id)?.rank;
        if (rank === undefined) throw new TypeError('Unknown card ID.');
        if (!groups.has(rank)) groups.set(rank, []);
        groups.get(rank).push(id);
    }
    const accepts = cards => beats(classify(cards), previous);
    if (groups.has(16) && groups.has(17) && accepts([groups.get(16)[0], groups.get(17)[0]])) return true;
    for (const cards of groups.values()) {
        if (cards.length === 4 && accepts(cards)) return true;
    }
    if (previous.type === 'bomb' || hand.length < previous.size) return false;

    // Build a stronger body, then search only its small wing pool.
    const shapes = {
        single: [1, 1, 0, 0], pair: [2, 1, 0, 0], triple: [3, 1, 0, 0],
        'triple-single': [3, 1, 1, 1], 'triple-pair': [3, 1, 1, 2],
        straight: [1, previous.chain, 0, 0],
        'pair-chain': [2, previous.chain, 0, 0],
        'triple-chain': [3, previous.chain, 0, 0],
        'four-singles': [4, 1, 2, 1], 'four-pairs': [4, 1, 2, 2],
        'airplane-singles': [3, previous.chain, previous.chain, 1],
        'airplane-pairs': [3, previous.chain, previous.chain, 2],
    };
    const shape = shapes[previous.type];
    if (!shape) return false;
    const [copies, length, wingCount, wingUnit] = shape;
    for (let high = previous.main + 1; high <= (length > 1 ? 14 : 17); high++) {
        const ranks = Array.from({ length }, (_, i) => high - length + 1 + i);
        if (ranks.some(rank => (groups.get(rank)?.length || 0) < copies)) continue;
        const body = ranks.flatMap(rank => groups.get(rank).slice(0, copies));
        if (!wingCount) {
            if (accepts(body)) return true;
            continue;
        }
        const pool = [...groups.entries()].filter(([rank]) => !ranks.includes(rank)).map(([, cards]) => cards);
        const suffix = new Array(pool.length + 1).fill(0);
        for (let i = pool.length - 1; i >= 0; i--) {
            suffix[i] = suffix[i + 1] + (wingUnit === 2 ? Number(pool[i].length >= 2) : pool[i].length);
        }
        const wings = [];
        const search = (index, remaining) => {
            if (remaining === 0) return accepts([...body, ...wings]);
            if (index === pool.length || suffix[index] < remaining) return false;
            const cards = pool[index];
            const max = wingUnit === 2 ? Math.min(remaining, Number(cards.length >= 2))
                : Math.min(remaining, cards.length);
            for (let count = max; count >= 0; count--) {
                const before = wings.length;
                wings.push(...cards.slice(0, count * wingUnit));
                const found = search(index + 1, remaining - count);
                wings.length = before;
                if (found) return true;
            }
            return false;
        };
        if (search(0, wingCount)) return true;
    }
    return false;
}
module.exports = { RULES_VERSION, DECK, classify, beats, sortCards, canBeat };