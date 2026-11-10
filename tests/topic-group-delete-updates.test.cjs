'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const group = require('../Groupmodules/groupchat');

test('group deletion serializes with config/avatar updates and late updates never recreate folders', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-group-delete-'));
    t.after(() => fs.remove(root));
    group.initializePaths({ APP_DATA_ROOT_IN_PROJECT: root, USER_DATA_DIR: path.join(root, 'users') });
    const dir = path.join(root, 'AgentGroups', 'g');
    const users = path.join(root, 'users', 'g');
    await fs.outputJson(path.join(dir, 'config.json'), {
        id: 'g', name: 'group', mode: 'sequential', topics: [], modeSettings: {},
    });
    await fs.outputJson(path.join(users, 'topics', 't', 'history.json'), []);
    const avatar = { name: 'avatar.png', type: 'image/png', buffer: Buffer.from([1, 2]) };
    assert.equal((await group.saveAgentGroupAvatar('g', avatar)).success, true);
    let entered, unblock;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const updating = group.mutateGroupConfig('g', async current => {
        entered();
        await gate;
        return { ...current, name: 'before deletion' };
    });
    await reached;
    const deleting = group.deleteAgentGroup('g');
    const lateConfig = group.saveAgentGroupConfig('g', { name: 'must not revive' });
    const lateAvatar = group.saveAgentGroupAvatar('g', avatar);
    const lateTopic = group.createNewTopicForGroup('g', 'must not revive');
    const lateDeleteTopic = group.deleteGroupTopic('g', 't');
    assert.equal(await fs.pathExists(dir), true, 'delete waits for prior config update');
    unblock();
    assert.equal((await updating).success, true);
    assert.equal((await deleting).success, true);
    assert.equal((await lateConfig).success, false);
    assert.equal((await lateAvatar).success, false);
    assert.equal((await lateTopic).success, false);
    assert.equal((await lateDeleteTopic).success, false);
    assert.equal(await fs.pathExists(dir), false);
    assert.equal(await fs.pathExists(users), false);
    assert.equal((await group.saveAgentGroupConfig('g', { name: 'still deleted' })).success, false);
    assert.equal(await fs.pathExists(dir), false);
});