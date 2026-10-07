import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
const trusted = trustedSenderFixture.createTrustedMainSender();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Test filterStableHistory and side-chat IPC handlers directly
import { filterStableHistory } from '../modules/ipc/sideChatHandlers.js';

test('filterStableHistory filters transient/streaming messages and extracts stable turns', () => {
    const rawHistory = [
        { id: 'm1', role: 'user', content: 'hello', timestamp: 1000 },
        { id: 'm2', role: 'assistant', content: 'hi there', timestamp: 2000 },
        { id: 'm3', role: 'assistant', content: 'thinking...', isStreaming: true },
        { id: 'm4', role: 'assistant', content: 'transient', transient: true },
        { id: 'm5', role: 'user', content: 'explain code', timestamp: 3000 },
        { id: 'm6', role: 'assistant', content: 'here is explanation', timestamp: 4000 },
        { id: 'm7', role: 'tool', content: 'tool output' }, // non standard user/assistant/system
    ];

    const stable = filterStableHistory(rawHistory);
    assert.equal(stable.length, 4);
    assert.equal(stable[0].id, 'm1');
    assert.equal(stable[0].content, 'hello');
    assert.equal(stable[1].id, 'm2');
    assert.equal(stable[1].content, 'hi there');
    assert.equal(stable[2].id, 'm5');
    assert.equal(stable[2].content, 'explain code');
    assert.equal(stable[3].id, 'm6');
    assert.equal(stable[3].content, 'here is explanation');
    assert.equal(stable[3].isInherited, true);
});

test('filterStableHistory drops pending streams and orphan tools, keeps tool_calls and attachments as deep clones', () => {
    const content = [{ type: 'text', text: 'initial' }];
    const raw = [
        { id: 'pending', role: 'assistant', content: 'partial', isPendingStream: true },
        { id: 'a', role: 'assistant', content: 'tool call', tool_calls: [{ id: 't' }] },
        { id: 't', role: 'tool', content: 'result', tool_call_id: 't' },
        { id: 'orphan_tool', role: 'tool', content: 'orphan without id' },
        { id: 'multi', role: 'user', content, attachments: [{ name: 'test.png' }] }
    ];

    const frozen = filterStableHistory(raw);
    content[0].text = 'mutated';

    assert.deepEqual(frozen.map(m => m.id), ['a', 't', 'multi'], 'Pending streams and orphan tools should be excluded');
    assert.ok(frozen.find(m => m.id === 'a').tool_calls, 'tool_calls should be retained');
    assert.equal(frozen.find(m => m.id === 'multi').content[0].text, 'initial', 'multimodal content should be deep-cloned');
    assert.ok(frozen.find(m => m.id === 'multi').attachments, 'attachments should be retained');
});

test('sideChatHandlers handles metadata lifecycle and snapshot creation with isolated filesystem', async (t) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-sidechat-test-'));

    t.after(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    const handlers = new Map();
    const fakeIpcMain = {
        handle(channel, handler) {
            handlers.set(channel, handler);
        }
    };

    // We can test initialize logic with fake ipcMain
    const { initialize } = await import('../modules/ipc/sideChatHandlers.js');

    // Wire fake ipcMain in place of electron's ipcMain by re-running initialization in mock scope
    const agentId = 'agent_test_1';
    const parentTopicId = 'topic_parent_1';
    const childTopicId = 'topic_child_1';

    // Create fake parent history on disk
    const parentDir = path.join(tmpDir, agentId, 'topics', parentTopicId);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(
        path.join(parentDir, 'history.json'),
        JSON.stringify([
            { id: 'msg-1', role: 'user', content: 'Parent user message' },
            { id: 'msg-2', role: 'assistant', content: 'Parent assistant response' }
        ])
    );

    // Wire fake ipcMain in place of electron's ipcMain by running real initialize
    initialize({ USER_DATA_DIR: tmpDir, mainWindow: trusted.mainWindow, ipcMain: fakeIpcMain });

    const saveMetadataHandler = (metadata) => handlers.get('side-chat:save-metadata')(trusted.event, metadata);
    const listMetadataHandler = (aId, pTopicId) => handlers.get('side-chat:list-metadata')(trusted.event, aId, pTopicId);
    const createSnapshotHandler = (aId, pTopicId, cTopicId) => handlers.get('side-chat:create-snapshot')(trusted.event, aId, pTopicId, cTopicId);

    await fs.mkdir(path.join(tmpDir, agentId, 'topics', childTopicId), { recursive: true });
    await fs.writeFile(path.join(tmpDir, agentId, 'topics', childTopicId, 'sidechat-child.json'), JSON.stringify({schemaVersion:1,ephemeral:true}));

    // 1. Create snapshot
    const snapRes = await createSnapshotHandler(agentId, parentTopicId, childTopicId);
    assert.equal(snapRes.success, true);
    assert.equal(snapRes.messages.length, 2);
    assert.equal(snapRes.snapshotBoundary.messageCount, 2);

    // Verify snapshot file exists
    const snapFile = JSON.parse(await fs.readFile(path.join(tmpDir, agentId, 'topics', childTopicId, 'parent-snapshot.json'), 'utf8'));
    assert.equal(snapFile.snapshotId, snapRes.snapshotId);

    // 2. Save metadata
    const metaPayload = {
        schemaVersion: 1,
        id: 'sidechat-test-1',
        parent: { itemType: 'agent', itemId: agentId, topicId: parentTopicId },
        child: { itemType: 'agent', itemId: agentId, topicId: childTopicId },
        title: '侧聊测试',
        contextMode: 'parent-snapshot',
        snapshotId: snapRes.snapshotId,
        snapshotBoundary: snapRes.snapshotBoundary,
        createdAt: 1000
    };
    const saveRes = await saveMetadataHandler(metaPayload);
    assert.equal(saveRes.success, true);

    // 3. List metadata
    const listRes = await listMetadataHandler(agentId, parentTopicId);
    assert.equal(listRes.success, true);
    assert.equal(listRes.items.length, 1);
    assert.equal(listRes.items[0].id, 'sidechat-test-1');
    assert.equal(listRes.items[0].title, '侧聊测试');
    // 列表从快照文件补回父话题快照与边界
    assert.equal(listRes.items[0].parentSnapshot.length, 2);
    assert.equal(listRes.items[0].snapshotBoundary.messageCount, 2);
    assert.equal((await listMetadataHandler(agentId, 'another-parent')).items.length, 0);

    // 4. Adversarial: Path traversal attempts must be rejected
    const maliciousRes = await listMetadataHandler('../../etc', null);
    assert.equal(maliciousRes.success, false);
    assert.equal(maliciousRes.error, 'INVALID_AGENT_ID');

    // 5. Adversarial: Unicode/Chinese agent and topic IDs must be preserved cleanly
    const unicodeAgentId = '智能助手小艾';
    const unicodeParentTopicId = '主对话_2026';
    const unicodeChildTopicId = '侧聊_分支1';
    const unicodeParentDir = path.join(tmpDir, unicodeAgentId, 'topics', unicodeParentTopicId);
    await fs.mkdir(unicodeParentDir, { recursive: true });
    await fs.writeFile(path.join(unicodeParentDir, 'history.json'), JSON.stringify([
        { id: 'u1', role: 'user', content: '请问你能做什么？', timestamp: 5000 },
        { id: 'u2', role: 'assistant', content: '我可以帮你分析代码。', timestamp: 6000 }
    ]), 'utf8');

    await fs.mkdir(path.join(tmpDir, unicodeAgentId, 'topics', unicodeChildTopicId), { recursive:true });
    await fs.writeFile(path.join(tmpDir, unicodeAgentId, 'topics', unicodeChildTopicId, 'sidechat-child.json'), JSON.stringify({schemaVersion:1,ephemeral:true}));
    const unicodeSnap = await createSnapshotHandler(unicodeAgentId, unicodeParentTopicId, unicodeChildTopicId);
    assert.equal(unicodeSnap.success, true);
    assert.equal(unicodeSnap.messages.length, 2);
    assert.equal(unicodeSnap.messages[0].content, '请问你能做什么？');

    // Verify snapshot written inside unicode path
    const childSnapshotFile = path.join(tmpDir, unicodeAgentId, 'topics', unicodeChildTopicId, 'parent-snapshot.json');
    const childSnapshotData = JSON.parse(await fs.readFile(childSnapshotFile, 'utf8'));
    assert.equal(childSnapshotData.messages.length, 2);
});

test('side-chat create-child/delete-child keep the child out of the topic list and never delete real topics', async (t) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-sidechat-child-'));
    t.after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });

    const handlers = new Map();
    const { initialize } = await import('../modules/ipc/sideChatHandlers.js');
    initialize({ USER_DATA_DIR: tmpDir, mainWindow: trusted.mainWindow, ipcMain: { handle: (c, h) => handlers.set(c, h) } });
    const createChild = (a) => handlers.get('side-chat:create-child')(trusted.event, a);
    const deleteChild = (a, c) => handlers.get('side-chat:delete-child')(trusted.event, a, c);

    const agentId = 'agent_child_1';
    const first = await createChild(agentId);
    const second = await createChild(agentId);
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.notEqual(first.topicId, second.topicId);

    const childDir = path.join(tmpDir, agentId, 'topics', first.topicId);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(childDir, 'history.json'), 'utf8')), []);
    // Agent config (topic list) is never touched by the child lifecycle
    await assert.rejects(fs.stat(path.join(tmpDir, agentId, 'config.json')));

    assert.equal((await createChild('../evil')).success, false);

    // Real topic dirs (no side chat marker) must never be removed
    const realDir = path.join(tmpDir, agentId, 'topics', 'topic_real');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'history.json'), '[{"id":"m1"}]');
    const refuse = await deleteChild(agentId, 'topic_real');
    assert.equal(refuse.success, false);
    assert.equal(refuse.error, 'NOT_A_SIDE_CHAT_CHILD');
    await fs.stat(path.join(realDir, 'history.json'));

    assert.equal((await deleteChild(agentId, '..')).success, false);

    const del = await deleteChild(agentId, first.topicId);
    assert.equal(del.success, true);
    await assert.rejects(fs.stat(childDir));
    // Deleting an already-removed child is idempotent
    assert.equal((await deleteChild(agentId, first.topicId)).success, true);
});

test('deleting a parent topic removes only the side chats marked as its children', async (t) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-sidechat-orphan-'));
    t.after(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
    const { removeSideChatChildrenOfParent } = await import('../modules/ipc/sideChatHandlers.js');
    const topics = path.join(tmpDir, 'agent', 'topics');
    const makeDir = async (name, marker) => {
        await fs.mkdir(path.join(topics, name), { recursive: true });
        if (marker) await fs.writeFile(path.join(topics, name, 'sidechat-child.json'), JSON.stringify(marker));
    };
    const marker = (topicId, parentTopicId) => ({ schemaVersion: 1, ephemeral: true, agentId: 'agent', topicId, parentTopicId });
    await makeDir('sidechat_a', marker('sidechat_a', 'parent'));
    await makeDir('sidechat_b', marker('sidechat_b', 'other'));
    await makeDir('sidechat_c', marker('sidechat_c', null));
    await makeDir('topic_real', null);
    await makeDir('topic_fake', { ...marker('topic_fake', 'parent'), ephemeral: false });

    const removed = await removeSideChatChildrenOfParent({ USER_DATA_DIR: tmpDir, agentId: 'agent', parentTopicId: 'parent' });
    assert.equal(removed, 1);
    assert.deepEqual((await fs.readdir(topics)).sort(), ['sidechat_b', 'sidechat_c', 'topic_fake', 'topic_real']);
    assert.equal(await removeSideChatChildrenOfParent({ USER_DATA_DIR: tmpDir, agentId: '../x', parentTopicId: 'parent' }), 0);
});
