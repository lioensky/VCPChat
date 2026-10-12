'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSeat, createSignatureAuthorizer } = require('../modules/game/gameSeatResolver');
const { GameToolAdapter } = require('../modules/game/gameToolAdapter');
const seats = [
    { kind: 'human', name: '莱恩' },
    { kind: 'agent', name: '小克', agentId: 'a' },
    { kind: 'agent', name: 'Kerr', agentId: 'b' },
];
test('本桌优先完整名字，兼容索引署名及大小写，不按全局名字找桌', () => {
    assert.equal(resolveSeat(seats, '小克'), 1);
    assert.equal(resolveSeat(seats, '[Kerr的知识]KERR'), 2);
    assert.throws(() => resolveSeat(seats, 'Nova'), /不属于/);
    assert.throws(() => resolveSeat(seats, ''), /缺少/);
    assert.throws(() => resolveSeat(seats, '小克和Kerr'), /多个/);
});
test('maid或valet解析座位，旧决策被适配器拒绝，不查询别人的手牌', async () => {
    let queried;
    const service = {
        read: async matchId => ({ matchId, seats, state: { revision: 4 } }),
        getObservation: async (matchId, seat) => {
            queried = seat;
            return { decisionId: `${matchId}:4`, revision: 4, hand: ['S3'] };
        },
    };
    const authorize = createSignatureAuthorizer(service);
    const adapter = new GameToolAdapter({ gameService: service, authorize });
    const args = { command: 'GetObservation', matchId: 'm', decisionId: 'm:4', revision: 4, valet: 'Kerr' };
    const result = await adapter.processToolCall(args);
    assert.equal(queried, 2);
    assert.deepEqual(JSON.parse(result.content[0].text).observation.hand, ['S3']);
    const stale = await adapter.processToolCall({ ...args, decisionId: 'm:3', revision: 3 });
    assert.equal(JSON.parse(stale.content[0].text).accepted, false);
    await assert.rejects(authorize({ ...args, maid: '小克' }), /不同座位/);
});