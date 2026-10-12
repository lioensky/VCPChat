'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DECK, classify, beats, sortCards } = require('../modules/game/doudizhu/cards');
const cards = specification => specification.trim().split(/\s+/).flatMap(group => {
    const [rank, amount = '1'] = group.split(':');
    if (rank === 'BJ' || rank === 'RJ') return [rank];
    return ['S', 'H', 'D', 'C'].slice(0, Number(amount)).map(suit => suit + rank);
});
const shape = specification => classify(cards(specification));
test('54张唯一实体牌，排序不修改原数组', () => {
    assert.equal(DECK.length, 54);
    assert.equal(new Set(DECK.map(card => card.id)).size, 54);
    const input = ['RJ', 'S2', 'S3', 'BJ'];
    assert.deepEqual(sortCards(input), ['S3', 'S2', 'BJ', 'RJ']);
    assert.equal(input[0], 'RJ');
});
test('基础与全部组合牌型', () => {
    for (const [specification, type] of [
        ['3', 'single'], ['3:2', 'pair'], ['3:3', 'triple'],
        ['3:4', 'bomb'], ['BJ RJ', 'rocket'],
        ['3:3 4', 'triple-single'], ['3:3 4:2', 'triple-pair'],
        ['3 4 5 6 7', 'straight'], ['3:2 4:2 5:2', 'pair-chain'],
        ['3:3 4:3', 'triple-chain'], ['3:4 4:2', 'four-singles'],
        ['3:4 4:2 5:2', 'four-pairs'],
        ['3:3 4:3 6 7', 'airplane-singles'],
        ['3:3 4:3 6:2', 'airplane-singles'],
        ['3:3 4:3 6:2 7:2', 'airplane-pairs'],
    ]) assert.equal(shape(specification)?.type, type, specification);
});
test('非法实体、重复牌及含2序列拒绝', () => {
    for (const input of [null, [], ['S3', 'S3'], ['X3'], ['S1']]) {
        assert.equal(classify(input), null);
    }
    for (const specification of [
        '3 4 5 6', 'J Q K A 2', 'K:2 A:2 2:2',
        'A:3 2:3', '3:4 4:4', '3:4 4:3 5',
        '3:3 4:3 6:4',
    ]) assert.equal(shape(specification), null, specification);
});
test('同型同长度比较，炸弹越级，王炸不可压', () => {
    assert.equal(beats(shape('4:2'), shape('3:2')), true);
    assert.equal(beats(shape('3:2'), shape('4:2')), false);
    assert.equal(beats(shape('4'), shape('3:2')), false);
    assert.equal(beats(shape('4 5 6 7 8 9'), shape('3 4 5 6 7')), false);
    assert.equal(beats(shape('3:4'), shape('A:3 2:2')), true);
    assert.equal(beats(shape('4:4'), shape('3:4')), true);
    assert.equal(beats(shape('BJ RJ'), shape('2:4')), true);
    assert.equal(beats(shape('2:4'), shape('BJ RJ')), false);
    assert.equal(beats(shape('BJ RJ'), shape('BJ RJ')), false);
    assert.equal(beats(null, null), false);
    assert.equal(beats(shape('3'), null), true);
});