'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GameService } = require('../modules/services/gameService');
const controller = require('../VCPDistributedServer/Plugin/GameController/GameControllerService');
const decode = result => JSON.parse(result.content[0].text);
test('正式插件复用署名：非法叫分修正、成功重试返回原结果、旧新动作驳回', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-controller-'));
    t.after(async () => { controller.cleanup(); await fs.rm(root, { recursive: true, force: true }); });
    const service = new GameService({ appDataRoot: root, integer: () => 0 });
    const { matchId } = await service.createMatch({
        seats: [{ kind: 'human', name: '莱恩' },
            { kind: 'agent', name: '小克', agentId: 'a' },
            { kind: 'agent', name: 'Kerr', agentId: 'b' }],
        groupId: 'g', topicId: 't', firstSeat: 1,
    });
    controller.initialize({ services: { gameService: service } });
    const observation = await service.getObservation(matchId, 1);
    const args = {
        maid: '小克', command: 'SubmitAction', matchId,
        decisionId: observation.decisionId, revision: '0',
        submissionId: 'bid1', action: 'bid', bid: '9',
    };
    for (const revision of [undefined, null, '']) {
        const result = decode(await controller.processToolCall({ ...args, revision }));
        assert.equal(result.code, 'MISSING_DECISION_BINDING');
        assert.equal(result.stateChanged, false);
    }
    for (const change of [{ decisionId: 'event-1' }, { revision: 1 }, { revision: false }]) {
        const result = decode(await controller.processToolCall({ ...args, ...change }));
        assert.equal(result.code, 'INVALID_DECISION_BINDING');
        assert.equal(result.accepted, false);
    }
    assert.equal((await service.read(matchId)).state.revision, 0);
    assert.equal(decode(await controller.processToolCall(args)).code, 'INVALID_BID');
    args.bid = '3';
    const accepted = decode(await controller.processToolCall(args));
    assert.equal(accepted.accepted, true);
    assert.deepEqual(decode(await controller.processToolCall(args)), accepted);
    assert.equal((await service.read(matchId)).state.revision, 1);
    assert.equal(decode(await controller.processToolCall({
        ...args, submissionId: 'new-old-action',
    })).code, 'STALE_DECISION');
    assert.equal(decode(await controller.processToolCall({
        ...args, command: 'GetObservation',
    })).code, 'STALE_DECISION');
    const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname,
        '../VCPDistributedServer/Plugin/GameController/plugin-manifest.json'), 'utf8'));
    assert.equal(manifest.communication.protocol, 'direct');
});