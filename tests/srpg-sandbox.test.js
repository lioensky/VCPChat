'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SessionStore } = require('../Gamemodules/srpg/session-store.cjs');
const { formatResult } = require('../Gamemodules/srpg/tool-result.cjs');

async function makeTempStore(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-srpg-test-'));
    t.after(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });
    return new SessionStore(dir);
}

test('默认初始化《万缕千丝：凯伊线战棋沙盘》并生成开战天刻存档点', async t => {
    const store = await makeTempStore(t);
    const out = await store.execute('shared', { command: 'GetState' });
    assert.equal(out.ok, true);
    assert.equal(out.state.activeProfile, 'profile_fe_kai');
    assert.match(out.state.profileName, /万缕千丝/);
    assert.equal(out.state.battle.mapName, '凯伊线首战 · 战术沙盘');
    assert.ok(out.state.battleText.includes('凯伊'));
    assert.ok(out.state.battleText.includes('以实玛利'));
    assert.equal(out.state.checkpoints.length, 1);
    assert.equal(out.state.checkpoints[0].id, 'cp1');
});

test('支持串行执行：移动+技能、NS2实机Manual改血瞬移与天刻之白沙Rewind回溯', async t => {
    const store = await makeTempStore(t);
    const updates = [];
    store.subscribe((_id, payload) => updates.push(payload));

    const turn1 = await store.execute('shared', {
        command1: 'Skill',
        unit1: '凯伊',
        x1: 5,
        y1: 3,
        skill1: '落星冥焰狱',
        tx1: 7,
        ty1: 3,
        command2: 'Manual',
        type2: 'stat',
        unit2: '以实玛利',
        key2: 'hp',
        value2: 25,
        note2: 'NS2实机受擦伤',
    });
    assert.equal(turn1.ok, true);
    assert.equal(turn1.results.length, 2);
    const ishmael = turn1.state.battle.units.find(u => u.name === '以实玛利');
    assert.equal(ishmael.hp, 25);
    const enemyA = turn1.state.battle.units.find(u => u.x === 6 && u.y === 2);
    assert.ok(enemyA.hp < enemyA.maxHp, '敌方前锋应受到伤害');

    const formatted = formatResult(turn1);
    const text = formatted.content[0].text;
    assert.match(text, /落星冥焰狱/);
    assert.match(text, /NS2实机受擦伤/);

    const rewound = await store.execute('shared', {
        command: 'Rewind',
        checkpointId: 'cp1',
    });
    assert.equal(rewound.ok, true);
    const ishmaelAfter = rewound.state.battle.units.find(u => u.name === '以实玛利');
    assert.equal(ishmaelAfter.hp, 30, '天刻回溯后以实玛利HP应恢复为开战满血30');
    assert.equal(rewound.state.checkpoints.length, 2, '回溯前的进度应自动保存为cp2快照');
    assert.ok(updates.length >= 2);
});

test('前端 UI syncFromUi 与后端 SessionStore 双向同源持久化', async t => {
    const store = await makeTempStore(t);
    const initial = await store.execute('shared', { command: 'GetState' });
    const modifiedBattle = structuredClone(initial.state.battle);
    modifiedBattle.units[0].hp = 19;
    const synced = await store.syncFromUi('shared', {
        settings: initial.state.settings,
        battle: modifiedBattle,
    });
    assert.equal(synced.ok, true);
    assert.equal(synced.source, 'ui');

    const reloaded = await store.execute('shared', { command: 'GetState' });
    assert.equal(reloaded.state.battle.units[0].hp, 19);
});