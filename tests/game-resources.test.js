'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { GameService } = require('../modules/services/gameService');
const { GameResourceManager } = require('../modules/game/gameResourceManager');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'game-resources-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const gameService = new GameService({ appDataRoot: root, integer: () => 0 });
    await gameService.initialize();
    const groups = new Map([['game', { id: 'game', name: 'game', mode: 'game' }],
        ['orphan', { id: 'orphan', mode: 'game' }], ['normal', { id: 'normal', mode: 'sequential' }]]);
    for (const id of groups.keys()) {
        await fs.mkdir(path.join(root, 'AgentGroups', id), { recursive: true });
        await fs.mkdir(path.join(root, 'UserData', id), { recursive: true });
    }
    const runtime = { gameService, maintenance: false, resourceOperations: 0,
        getState: () => ({ running: false }), groupChat: {
            getAgentGroups: async () => [...groups.values()],
            getAgentGroupConfig: async id => groups.get(id) || null,
            deleteAgentGroup: async id => {
                await fs.rm(path.join(root, 'AgentGroups', id), { recursive: true });
                await fs.rm(path.join(root, 'UserData', id), { recursive: true, force: true });
                groups.delete(id); return { success: true };
            },
        } };
    const create = groupId => gameService.createMatch({ groupId, topicId: 't',
        seats: [{ kind: 'human' }, { kind: 'agent', agentId: 'a' }, { kind: 'agent', agentId: 'b' }] });
    return { root, runtime, groups, create, manager: new GameResourceManager(runtime) };
}
test('shared game group removes all saves and orphan; normal and main settings unchanged', async t => {
    const f = await fixture(t);
    const a = await f.create('game'), b = await f.create('game');
    const settings = Buffer.from('{"combinedItemOrder":[{"id":"game","type":"group"}],"secret":"untouched"}');
    await fs.writeFile(path.join(f.root, 'settings.json'), settings);
    const inventory = await f.manager.inventory();
    assert.equal(inventory.sessions.find(s => s.groupId === 'game').records.length, 2);
    assert.equal(inventory.sessions.some(s => s.groupId === 'normal'), false);
    const result = await f.manager.remove(['game', 'orphan', 'normal']);
    assert.deepEqual(result.results.map(r => r.success), [true, true, false], JSON.stringify(result));
    await assert.rejects(f.runtime.gameService.read(a.matchId), { code: 'ENOENT' });
    await assert.rejects(f.runtime.gameService.read(b.matchId), { code: 'ENOENT' });
    assert.ok(f.groups.has('normal'));
    assert.deepEqual(await fs.readFile(path.join(f.root, 'settings.json')), settings);
    assert.equal(f.runtime.maintenance, false);
});
test('active request, in-flight operations, malformed ids and changed mode fail closed', async t => {
    const f = await fixture(t);
    await f.create('game');
    f.runtime.getState = () => ({ running: true });
    assert.equal((await f.manager.remove(['game'])).results[0].success, false);
    f.runtime.resourceOperations = 1;
    await assert.rejects(f.manager.remove(['game']), /尚未结束/);
    f.runtime.resourceOperations = 0;
    await assert.rejects(f.manager.remove(['../normal']), /有效/);
    f.runtime.getState = () => ({ running: false });
    f.groups.get('game').mode = 'sequential';
    assert.equal((await f.manager.remove(['game'])).results[0].success, false);
    assert.ok(f.groups.has('game'));
});
test('unknown corrupt association blocks backend cleanup', async t => {
    const f = await fixture(t);
    const a = await f.create('game');
    await fs.writeFile(f.runtime.gameService.file(a.matchId), '{}');
    assert.equal((await f.manager.remove(['orphan'])).results[0].success, false);
    assert.ok(f.groups.has('orphan'));
});
test('group failure keeps retry entry after saves removed', async t => {
    const f = await fixture(t);
    await f.create('game');
    const original = f.runtime.groupChat.deleteAgentGroup;
    f.runtime.groupChat.deleteAgentGroup = async () => ({ success: false, error: 'injected failure' });
    assert.equal((await f.manager.remove(['game'])).results[0].success, false);
    assert.ok(f.groups.has('game'));
    f.runtime.groupChat.deleteAgentGroup = original;
    assert.equal((await f.manager.remove(['game'])).results[0].success, true);
});
test('hall requires explicit confirmation and refreshes resources after removal', async () => {
    const { JSDOM } = require('jsdom');
    const root = path.resolve(__dirname, '..');
    const dom = new JSDOM(await fs.readFile(path.join(root, 'Gamemodules/game.html'), 'utf8'), { runScripts: 'outside-only' });
    const w = dom.window;
    let removed = 0;
    w.utilityAPI = {
        listGameRecords: async () => ({ success: true, records: [], unavailable: [] }),
        listGameResources: async () => ({ success: true, unavailable: [], sessions: removed ? [] :
            [{ groupId: 'game', name: '<img src=x>', running: false, records: [] }] }),
        removeGameResources: async request => {
            assert.deepEqual([...request.groupIds], ['game']);
            removed++; return { success: true, results: [{ groupId: 'game', success: true }] };
        },
    };
    try {
        w.eval(await fs.readFile(path.join(root, 'Gamemodules/game.js'), 'utf8'));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(w.document.querySelector('#game-resources img'), null);
        w.document.querySelector('#game-resources input').checked = true;
        w.document.getElementById('prepare-remove').click();
        assert.equal(removed, 0);
        assert.equal(w.document.getElementById('remove-confirmation').hidden, false);
        w.document.getElementById('confirm-remove').click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(removed, 1);
        assert.equal(w.document.querySelectorAll('#game-resources input').length, 0);
    } finally { w.close(); }
});