'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GameService } = require('../modules/services/gameService');
async function fixture(t, onCommitted) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const service = new GameService({ appDataRoot: root, integer: () => 0, onCommitted });
    await service.initialize();
    const { matchId } = await service.createMatch({
        seats: [{ kind: 'human' }, { kind: 'agent', agentId: 'a' }, { kind: 'agent', agentId: 'b' }],
        groupId: 'g', topicId: 't',
    });
    const observation = await service.getObservation(matchId, 0);
    const request = {
        submissionId: 's1', decisionId: observation.decisionId,
        revision: observation.revision, action: { type: 'bid', bid: 3, speech: '开牌。' },
    };
    return { root, service, matchId, request };
}
test('并发重复提交只生效一次，重启后仍返回原结果', async t => {
    let notifications = 0;
    const { root, service, matchId, request } = await fixture(t, () => { notifications++; });
    const results = await Promise.all([service.submit(matchId, 0, request), service.submit(matchId, 0, request)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(notifications, 1);
    const restored = new GameService({ appDataRoot: root });
    assert.deepEqual(await restored.submit(matchId, 0, request), results[0]);
    assert.equal((await restored.getObservation(matchId, 0)).revision, 1);
    await assert.rejects(restored.submit(matchId, 1, request), { code: 'SUBMISSION_CONFLICT' });
});
test('事件成功存档后等待同步，确认后重启不会再次同步', async t => {
    const { root, service, matchId, request } = await fixture(t, () => { throw new Error('offline'); });
    const result = await service.submit(matchId, 0, request);
    assert.equal(result.accepted, true);
    const pending = await service.getPendingEvents(matchId);
    assert.equal(pending.length, 2);
    assert.equal(JSON.stringify(pending).includes('"hands"'), false);
    await service.acknowledgeEvents(matchId, pending.map(event => event.id));
    assert.deepEqual(await new GameService({ appDataRoot: root }).getPendingEvents(matchId), []);
});
test('非法动作、过期决策不改变存档；写入失败不通知', async t => {
    let notifications = 0;
    const { service, matchId, request } = await fixture(t, () => { notifications++; });
    const before = await service.getObservation(matchId, 0);
    await assert.rejects(service.submit(matchId, 0, {
        ...request, action: { type: 'bid', bid: 9 },
    }), { code: 'INVALID_BID' });
    await assert.rejects(service.submit(matchId, 0, {
        ...request, revision: 99,
    }), { code: 'STALE_DECISION' });
    assert.deepEqual(await service.getObservation(matchId, 0), before);
    service.write = async () => { throw new Error('disk failure'); };
    await assert.rejects(service.submit(matchId, 0, request), /disk failure/);
    assert.deepEqual(await service.getObservation(matchId, 0), before);
    assert.equal(notifications, 0);
});
test('路径越界拒绝；损坏历史不作为新空局', async t => {
    const { service, matchId } = await fixture(t);
    await assert.rejects(service.getObservation('../elsewhere', 0), { code: 'INVALID_MATCH' });
    await fs.writeFile(service.file(matchId), '{}');
    await assert.rejects(service.getObservation(matchId, 0), { code: 'CORRUPT_SAVE' });
});
test('提交后通知可确认outbox，不在同局提交锁内自锁', { timeout: 3000 }, async t => {
    const f = await fixture(t);
    f.service.onCommitted = async ({ matchId }) => {
        const events = await f.service.getPendingEvents(matchId);
        await f.service.acknowledgeEvents(matchId, events.map(event => event.id));
    };
    assert.equal((await f.service.submit(f.matchId, 0, f.request)).accepted, true);
    assert.deepEqual(await f.service.getPendingEvents(f.matchId), []);
});