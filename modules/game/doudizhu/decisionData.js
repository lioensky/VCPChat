'use strict';
const { DECK, sortCards } = require('./cards');
function cardName(id) {
    if (id === 'BJ') return '小王';
    if (id === 'RJ') return '大王';
    const suit = { S: '黑桃', H: '红桃', D: '方块', C: '梅花' }[id[0]];
    if (!suit || !DECK.some(card => card.id === id)) throw new Error('Unknown card ID.');
    return suit + id.slice(1);
}
function rankCounts(cards) {
    const counts = {};
    for (const card of cards) {
        const rank = card === 'BJ' ? '小王' : card === 'RJ' ? '大王' : card.slice(1);
        counts[rank] = (counts[rank] || 0) + 1;
    }
    return counts;
}
function decisionData(observation) {
    // Discard earlier deals. No dependence on hidden hands or chat text.
    const events = observation.events || [];
    let start = 0;
    for (let i = 0; i < events.length; i++) {
        if (['redeal', 'new-match'].includes(events[i].type)) start = i + 1;
    }
    const bySeat = [[], [], []];
    let actions = [], passes = 0, roundNumber = 1;
    for (const event of events.slice(start)) {
        if (event.type === 'play') {
            bySeat[event.seat].push(...event.cards);
            actions.push({
                seat: event.seat, type: 'play', cards: [...event.cards],
                combination: { ...event.combination },
            });
            passes = 0;
        } else if (event.type === 'pass') {
            actions.push({ seat: event.seat, type: 'pass' });
            if (++passes === 2) {
                actions = [];
                passes = 0;
                roundNumber++;
            }
        }
    }
    const played = sortCards(bySeat.flat());
    const known = new Set([...played, ...observation.hand]);
    const unplayed = DECK.map(card => card.id).filter(id => !played.includes(id));
    const unknown = DECK.map(card => card.id).filter(id => !known.has(id));
    return {
        currentTrick: { number: roundNumber, actions, consecutivePasses: passes },
        cardTracker: {
            dealNumber: observation.dealNumber,
            bySeat: bySeat.map((cards, seat) => ({
                seat, cards: sortCards(cards), count: cards.length, ranks: rankCounts(cards),
            })),
            played: { count: played.length, ranks: rankCounts(played) },
            unplayed: { count: unplayed.length, ranks: rankCounts(unplayed) },
            otherPlayersPool: {
                count: unknown.length, ranks: rankCounts(unknown),
                includesUndealtBottom: observation.landlord === null,
            },
        },
    };
}
module.exports = { cardName, rankCounts, decisionData };