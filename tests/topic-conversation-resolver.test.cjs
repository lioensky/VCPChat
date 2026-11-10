'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createTopicConversationResolver } = require('../modules/services/topicConversationResolver');

test('resolve agent/group, reject ambiguous ids, deleted history, games and traversal', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-topic-resolver-'));
    t.after(() => fs.remove(root));
    const agentDir = path.join(root, 'Agents');
    const groupDir = path.join(root, 'AgentGroups');
    const userDataDir = path.join(root, 'UserData');
    const resolver = createTopicConversationResolver({ agentDir, groupDir, userDataDir });
    async function create(type, id, topicId, extra = {}) {
        await fs.outputJson(path.join(type === 'agent' ? agentDir : groupDir, id, 'config.json'),
            { topics: [{ id: topicId }], ...extra });
        await fs.outputJson(path.join(userDataDir, id, 'topics', topicId, 'history.json'), []);
    }
    await create('agent', 'a', 'topic_a');
    await create('group', 'g', 'topic_g');
    assert.equal((await resolver.resolve({ topicId: 'topic_a' })).scope.itemId, 'a');
    assert.equal((await resolver.resolve({ topicId: 'topic_g' })).scope.itemType, 'group');
    await create('group', 'duplicate', 'topic_a');
    await assert.rejects(resolver.resolve({ topicId: 'topic_a' }), /不唯一/);
    assert.equal((await resolver.resolve({ topicId: 'topic_a', itemId: 'a', itemType: 'agent' })).scope.itemId, 'a');
    await assert.rejects(resolver.resolve({ topicId: '../escape' }), /Invalid/);
    await assert.rejects(resolver.resolve({ topicId: 'topic_a', itemId: 'a' }), /itemType/);
    await create('group', 'game', 'topic_game', { mode: 'game' });
    await assert.rejects(resolver.resolve({ topicId: 'topic_game' }), /游戏/);
    await fs.remove(path.join(userDataDir, 'a', 'topics', 'topic_a'));
    await assert.rejects(resolver.validate({ itemType: 'agent', itemId: 'a', topicId: 'topic_a' }), /历史不存在/);
    assert.equal(await fs.pathExists(path.join(userDataDir, 'a', 'topics', 'topic_a')), false);
});