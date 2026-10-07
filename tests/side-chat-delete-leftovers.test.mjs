import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialize, removeSideChatChildrenOfParent } from '../modules/ipc/sideChatHandlers.js';
import trustedFixture from './helpers/trusted-main-sender.cjs';

// 删到一半留下的空侧聊目录（标记已经没了）也要能清掉，但有内容的目录、不是侧聊名字的目录一律不碰
async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidechat-leftover-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const trusted = trustedFixture.createTrustedMainSender();
    const handlers = new Map();
    initialize({ USER_DATA_DIR: root, getMainWindow: () => trusted.mainWindow, ipcMain: { handle: (c, h) => handlers.set(c, h) } });
    const call = (channel, ...args) => handlers.get(channel)(trusted.event, ...args);
    const topics = path.join(root, 'agent', 'topics');
    return { root, call, topics };
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

test('delete-child removes the whole child directory, marker included', async t => {
    const { call, topics } = await setup(t);
    const { topicId } = await call('side-chat:create-child', 'agent');
    await fs.writeFile(path.join(topics, topicId, 'note.txt'), 'x');
    assert.deepEqual(await call('side-chat:delete-child', 'agent', topicId), { success: true, removed: true });
    assert.equal(await exists(path.join(topics, topicId)), false);
});

test('delete-child clears an empty leftover side-chat directory but not a real topic', async t => {
    const { call, topics } = await setup(t);
    const leftover = 'sidechat_1791125667330_dc63f3';
    await fs.mkdir(path.join(topics, leftover), { recursive: true });
    assert.deepEqual(await call('side-chat:delete-child', 'agent', leftover), { success: true, removed: true });
    assert.equal(await exists(path.join(topics, leftover)), false);

    const withContent = 'sidechat_1791125811786_0db08c';
    await fs.mkdir(path.join(topics, withContent));
    await fs.writeFile(path.join(topics, withContent, 'history.json'), '[]');
    assert.equal((await call('side-chat:delete-child', 'agent', withContent)).error, 'NOT_A_SIDE_CHAT_CHILD');
    assert.equal(await exists(path.join(topics, withContent, 'history.json')), true);

    await fs.mkdir(path.join(topics, 'topic_real'));
    assert.equal((await call('side-chat:delete-child', 'agent', 'topic_real')).error, 'NOT_A_SIDE_CHAT_CHILD');
    assert.equal(await exists(path.join(topics, 'topic_real')), true);
});

test('deleting a parent topic also sweeps empty leftover side-chat directories', async t => {
    const { root, topics } = await setup(t);
    await fs.mkdir(path.join(topics, 'sidechat_1_aa'), { recursive: true });
    await fs.mkdir(path.join(topics, 'sidechat_2_bb'));
    await fs.writeFile(path.join(topics, 'sidechat_2_bb', 'history.json'), '[]');
    await fs.mkdir(path.join(topics, 'topic_empty'));

    assert.equal(await removeSideChatChildrenOfParent({ USER_DATA_DIR: root, agentId: 'agent', parentTopicId: 'parent' }), 1);
    assert.equal(await exists(path.join(topics, 'sidechat_1_aa')), false);
    assert.equal(await exists(path.join(topics, 'sidechat_2_bb', 'history.json')), true);
    assert.equal(await exists(path.join(topics, 'topic_empty')), true);
});

// 创建到一半失败的侧聊（有标记、没绑父话题、没元数据、记录为空）不会出现在任何列表里；删任一父话题时顺带清掉，
// 但刚建的（可能还在创建中）和已经有内容的都不碰
test('deleting a parent also clears abandoned half-created side chats, never fresh or non-empty ones', async t => {
    const { root, call, topics } = await setup(t);
    const marker = (topicId, createdAt) => JSON.stringify({ schemaVersion: 1, ephemeral: true, agentId: 'agent', topicId, parentTopicId: null, createdAt });
    const make = async (topicId, createdAt, history = '[]') => {
        await fs.mkdir(path.join(topics, topicId), { recursive: true });
        await fs.writeFile(path.join(topics, topicId, 'sidechat-child.json'), marker(topicId, createdAt));
        await fs.writeFile(path.join(topics, topicId, 'history.json'), history);
    };
    const old = Date.now() - 60 * 60 * 1000;
    await make('sidechat_1791000000000_aaaaaa', old);
    await make('sidechat_1791000000001_bbbbbb', Date.now());
    await make('sidechat_1791000000002_cccccc', old, '[{"id":"m","role":"user","content":"keep"}]');
    const { topicId: fresh } = await call('side-chat:create-child', 'agent');

    assert.equal(await removeSideChatChildrenOfParent({ USER_DATA_DIR: root, agentId: 'agent', parentTopicId: 'topic_other' }), 1);
    assert.equal(await exists(path.join(topics, 'sidechat_1791000000000_aaaaaa')), false);
    for (const kept of ['sidechat_1791000000001_bbbbbb', 'sidechat_1791000000002_cccccc', fresh]) {
        assert.equal(await exists(path.join(topics, kept)), true, kept);
    }
});
