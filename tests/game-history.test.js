'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const { GameService } = require('../modules/services/gameService');
const root = path.resolve(__dirname, '..');

test('旧存档直接列出，公开记录不含手牌，坏档隔离且越界拒绝', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vgame-history-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new GameService({ appDataRoot: dir, integer: () => 0 });
    assert.deepEqual(await service.listRecords(), { records: [], unavailable: [] });
    const { matchId } = await service.createMatch({
        seats: [{ kind: 'human', name: '莱恩' }, { kind: 'agent', name: 'Kerr', agentId: 'a' }, { kind: 'agent', name: 'Nova', agentId: 'b' }],
        groupId: 'g', topicId: 't',
    });
    const observation = await service.getObservation(matchId, 0);
    await service.submit(matchId, 0, {
        submissionId: 'history', decisionId: observation.decisionId, revision: observation.revision,
        action: { type: 'bid', bid: 3, speech: '<img src=x onerror=alert(1)>' },
    });
    const restored = new GameService({ appDataRoot: dir });
    const list = await restored.listRecords();
    assert.equal(list.records[0].matchId, matchId);
    assert.deepEqual(list.records[0].players, ['莱恩', 'Kerr', 'Nova']);
    const record = await restored.getPublicRecord(matchId);
    assert.equal(record.events[0].speech, '<img src=x onerror=alert(1)>');
    for (const key of ['hands', 'hand', 'submissions', 'pendingEvents', 'state', 'groupId', 'topicId']) {
        assert.equal(Object.hasOwn(record, key), false);
    }
    const bad = 'match-00000000-0000-0000-0000-000000000000';
    await fs.mkdir(path.dirname(service.file(bad)), { recursive: true });
    await fs.writeFile(service.file(bad), '{}');
    const partial = await restored.listRecords();
    assert.equal(partial.records.length, 1);
    assert.equal(partial.unavailable.length, 1);
    await assert.rejects(restored.getPublicRecord('../escape'), { code: 'INVALID_MATCH' });
});

test('主列表按game模式隐藏，普通同名群不误伤，刷新和缓存均不复活', async () => {
    const dom = new JSDOM('<ul id="agentList"></ul>', { runScripts: 'outside-only' });
    const w = dom.window;
    try {
        w.eval(await fs.readFile(path.join(root, 'modules/itemListManager.js'), 'utf8'));
        w.itemListManager.init({
            elements: { itemListUl: w.document.querySelector('ul') },
            electronAPI: {
                getAgents: async () => [],
                getAgentGroups: async () => [
                    { id: 'game', name: '已改名的牌桌', mode: 'game' },
                    { id: 'normal', name: '斗地主_普通聊天', mode: 'sequential' },
                ],
                loadSettings: async () => ({ combinedItemOrder: [{ type: 'group', id: 'game' }] }),
                getUnreadTopicCounts: async () => ({ success: true, counts: {} }),
            },
            refs: { currentSelectedItemRef: { get: () => null } },
            mainRendererFunctions: { selectItem() {} },
            uiHelper: { showToastNotification() {} },
        });
        for (let i = 0; i < 2; i++) {
            await w.itemListManager.loadItems();
            assert.equal(w.document.querySelector('[data-item-id="game"]'), null);
            assert.ok(w.document.querySelector('[data-item-id="normal"]'));
            assert.equal(w.itemListManager.findItemById('game', 'group'), null);
        }
    } finally { w.close(); }
});

test('大厅加载历史并安全显示台词，不启动游戏或Agent', async () => {
    const dom = new JSDOM(await fs.readFile(path.join(root, 'Gamemodules/game.html'), 'utf8'), { runScripts: 'outside-only' });
    const w = dom.window;
    let launched = 0;
    const summary = { matchId: 'test', createdAt: 1, players: ['莱恩', 'Kerr', 'Nova'], phase: 'finished', winner: 'landlord' };
    w.utilityAPI = {
        listGameRecords: async () => ({ success: true, records: [summary], unavailable: [] }),
        getGameRecord: async () => ({ success: true, ...summary, events: [{ type: 'bid', seat: 0, bid: 3, speech: '<img src=x onerror=alert(1)>' }] }),
        launchGame: async () => { launched++; },
    };
    try {
        w.eval(await fs.readFile(path.join(root, 'Gamemodules/game.js'), 'utf8'));
        await new Promise(resolve => setImmediate(resolve));
        const row = w.document.querySelector('.history-record');
        assert.match(row.textContent, /地主胜/);
        row.click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(w.document.getElementById('record-detail').hidden, false);
        assert.match(w.document.getElementById('record-events').textContent, /<img src=x/);
        assert.equal(w.document.querySelector('#record-events img'), null);
        assert.equal(launched, 0);
    } finally { w.close(); }
});