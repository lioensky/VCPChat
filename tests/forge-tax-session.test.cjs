'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionStore } = require('../Gamemodules/forge-tax/session-store.cjs');
test('整串顺序、单推送、持久化恢复及身份隔离', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ft-session-'));
    try {
        const store = new SessionStore(dir);
        await store.execute('agent:kerr', { command: 'StartGame', seed: 12 });
        const engine = await store.load('agent:kerr');
        engine.s.cash = 10000;
        await store.save('agent:kerr', engine);
        let publications = 0;
        store.subscribe(() => publications++);
        const r = await store.execute('agent:kerr', {
            command1: 'BuyItem', itemId1: 'protect',
            command2: 'UseItem', itemId2: 'protect', swordId2: 's1',
            command3: 'Hammer', swordId3: 's1', count3: '1',
            command4: 'GetState'
        });
        assert.equal(r.ok, true);
        assert.equal(r.results.length, 4);
        assert.equal(r.results[1].state.swords[0].protection, true);
        assert.equal(r.results[2].state.swords[0].protection, false);
        assert.equal(publications, 1);
        assert.deepEqual((await new SessionStore(dir).execute('agent:kerr', { command: 'GetState' })).state, r.state);
        assert.equal((await store.execute('agent:nova', { command: 'GetState' })).ok, false);
        const resumed = await store.execute('agent:kerr', { command: 'StartGame', seed: 999 });
        assert.equal(resumed.ok, true);
        assert.equal(resumed.results[0].resumed, true);
        assert.deepEqual(resumed.state, r.state);
        assert.equal(publications, 1);
        const restarted = await store.execute('agent:kerr', { command: 'StartGame', overwrite: true, seed: 999 });
        assert.equal(restarted.results[0].resumed, false);
        assert.equal(restarted.state.seed, 999);
        assert.equal(restarted.state.revision, 0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('失败即停，保留此前购买，不执行裸锤；队列中查询看到整串完成', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ft-session-'));
    try {
        const store = new SessionStore(dir);
        await store.execute('human:local', { command: 'StartGame', seed: 2 });
        const engine = await store.load('human:local'); engine.s.cash = 1000;
        await store.save('human:local', engine);
        const pending = store.execute('human:local', {
            command1: 'BuyItem', itemId1: 'protect',
            command2: 'UseItem', itemId2: 'protect', swordId2: 'missing',
            command3: 'Hammer', swordId3: 's1', count3: 10
        });
        const query = store.execute('human:local', { command: 'GetState' });
        const r = await pending;
        assert.equal(r.failedStep, 2); assert.equal(r.partial, true);
        assert.equal(r.skipped.length, 1);
        assert.equal(r.state.items.protect, 1);
        assert.equal(r.state.swords[0].hits, 0);
        assert.deepEqual((await query).state, r.state);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('纯查询不发布事件，过期查询版本拒绝', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ft-query-'));
    try {
        const store = new SessionStore(dir);
        await store.execute('agent:test', { command: 'StartGame', seed: 1 });
        let updates = 0;
        store.subscribe(() => updates++);
        assert.equal((await store.execute('agent:test', { command: 'GetState' })).ok, true);
        assert.equal((await store.execute('agent:test', { command: 'GetState', revision: 999 })).ok, false);
        assert.equal(updates, 0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});