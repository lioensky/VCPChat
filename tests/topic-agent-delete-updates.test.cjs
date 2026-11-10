'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const AgentConfigManager = require('../modules/utils/agentConfigManager');
test('agent object deletion waits for config writes and late operations do not revive cached agents', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agent-delete-'));
    t.after(() => fs.remove(root));
    const manager = new AgentConfigManager(root);
    await manager.writeAgentConfig('a', { name: 'original' });
    let entered, unblock;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const updating = manager.updateAgentConfig('a', async current => {
        entered(); await gate; return { ...current, name: 'updated' };
    });
    await reached;
    const deleting = manager.runAgentOperation('a', async () => {
        await fs.remove(path.join(root, 'a'));
        manager.clearCache('a');
        return { success: true };
    });
    const late = manager.updateAgentConfig('a', { name: 'revived' });
    const rejected = assert.rejects(late);
    const avatar = manager.runAgentOperation('a', async () => assert.fail('deleted object operation must not execute'));
    const avatarRejected = assert.rejects(avatar);
    unblock();
    assert.equal((await updating).success, true);
    assert.equal((await deleting).success, true);
    await rejected;
    await avatarRejected;
    assert.equal(await fs.pathExists(path.join(root, 'a')), false);
    // Explicit creation still works; an ordinary update is not a creation API.
    await manager.writeAgentConfig('b', { name: 'new' });
    assert.equal((await manager.updateAgentConfig('b', { name: 'changed' })).success, true);
});
test('agent deletion cannot overtake post-config topic directory creation', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agent-after-write-'));
    t.after(() => fs.remove(root));
    const manager = new AgentConfigManager(root);
    await manager.writeAgentConfig('a', { name: 'a' });
    let entered, unblock;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const creating = manager.updateAgentConfig('a', { topics: [{ id: 't' }] }, {
        afterWrite: async () => {
            entered(); await gate;
            await fs.outputJson(path.join(root, 'a', 'topics', 't', 'history.json'), []);
        },
    });
    await reached;
    let deleted = false;
    const deleting = manager.runAgentOperation('a', async () => {
        await fs.remove(path.join(root, 'a')); deleted = true;
    });
    assert.equal(deleted, false);
    unblock();
    await creating; await deleting;
    assert.equal(await fs.pathExists(path.join(root, 'a')), false);
});