'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameToolAdapter } = require('../modules/game/gameToolAdapter');
const binding = { matchId: 'm', seat: 1, decisionId: 'd', revision: 3 };
const args = { matchId: 'm', decisionId: 'd', revision: '3' };
const decode = result => JSON.parse(result.content[0].text);
test('缺失可信绑定拒绝，不接受模型参数里的身份', async () => {
    const adapter = new GameToolAdapter({ gameService: {}, authorize: async () => null });
    await assert.rejects(adapter.processToolCall({
        ...args, seat: 1, agentId: 'a', command: 'GetObservation',
    }), /可信/);
});
test('私有观察只查询可信座位，不进入公共details', async () => {
    let queried;
    const adapter = new GameToolAdapter({
        authorize: async () => binding,
        gameService: {
            getObservation: async (matchId, seat) => {
                queried = { matchId, seat };
                return { decisionId: 'd', revision: 3, hand: ['S3'] };
            },
        },
    });
    const result = await adapter.processToolCall({ ...args, seat: 2, command: 'GetObservation' });
    assert.deepEqual(queried, { matchId: 'm', seat: 1 });
    assert.deepEqual(decode(result).observation.hand, ['S3']);
    assert.equal('details' in result, false);
    assert.equal(decode(await adapter.processToolCall({
        ...args, matchId: 'other', command: 'GetObservation',
    })).code, 'BINDING_MISMATCH');
});
test('非法动作返回业务错误，同一绑定可修正；传输/磁盘错误不吞掉', async () => {
    const calls = [];
    const adapter = new GameToolAdapter({
        authorize: async () => binding,
        gameService: { submit: async (_id, seat, request) => {
            calls.push({ seat, request });
            if (request.action.type === 'bad') throw Object.assign(new Error('非法动作'), { code: 'INVALID_ACTION' });
            if (request.action.type === 'disk') throw new Error('disk unavailable');
            return { accepted: true };
        } },
    });
    assert.equal(decode(await adapter.processToolCall({
        ...args, command: 'SubmitAction', action: 'bad', submissionId: 's',
    })).code, 'INVALID_ACTION');
    assert.equal(decode(await adapter.processToolCall({
        ...args, command: 'SubmitAction', action: 'play', cards: '["S3"]', submissionId: 's',
    })).accepted, true);
    assert.deepEqual(calls[1].request.action.cards, ['S3']);
    assert.equal(calls[1].seat, 1);
    await assert.rejects(adapter.processToolCall({
        ...args, command: 'SubmitAction', action: 'disk', submissionId: 'x',
    }), /disk unavailable/);
});