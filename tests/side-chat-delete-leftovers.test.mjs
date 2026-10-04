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
