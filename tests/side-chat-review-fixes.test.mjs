import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
import { initialize } from '../modules/ipc/sideChatHandlers.js';
import { branchMetaToReopenArgs, createSideChatWiring } from '../modules/renderer/sideChatWiring.js';

// ─────────────────────────────────────────────────────────────
// A. branchMetaToReopenArgs：祖先快照与边界必须完整透传（P1#2）
// ─────────────────────────────────────────────────────────────
test('A1: branchMetaToReopenArgs carries parentSnapshot and snapshotBoundary through reopen', () => {
    const parentSnapshot = [{ id: 's1', role: 'user', content: 'ancestor' }];
    const snapshotBoundary = { lastMessageId: 's1', capturedAt: 123, messageCount: 1 };
    const args = branchMetaToReopenArgs({
        id: 'side-1',
        parent: { itemId: 'agent-1', topicId: 'topic-parent' },
        child: { itemId: 'agent-1', topicId: 'child-1' },
        title: 'B', contextMode: 'parent-snapshot', snapshotId: 'snap-1',
        parentSnapshot, snapshotBoundary,
        rootTopicId: 'root', forkFromTopicId: 'root', depth: 1
    });
    assert.deepEqual(args.parentSnapshot, parentSnapshot);
    assert.deepEqual(args.snapshotBoundary, snapshotBoundary);
    assert.equal(args.snapshotId, 'snap-1');
});

test('A2: branchMetaToReopenArgs defaults missing snapshot to empty array, boundary to null', () => {
    const args = branchMetaToReopenArgs({
        parent: { itemId: 'agent-1', topicId: 'topic-parent' },
        child: { itemId: 'agent-1', topicId: 'child-1' }
    });
    assert.deepEqual(args.parentSnapshot, []);
    assert.equal(args.snapshotBoundary, null);
});

// ─────────────────────────────────────────────────────────────
// B/C. wiring 层：collectBranchContext（P1#1）与 deleteBranch 时序（P1#3）
// ─────────────────────────────────────────────────────────────
function makeWiring({ chatAPI, controller, topicId = 'topic-parent' }) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const wiring = createSideChatWiring({
        doc: dom.window.document, win: dom.window, chatAPI,
        chatRepository: null, chatManager: null,
        uiHelper: { showToastNotification() {} },
        createRenderer: () => null,
        selectedItemRef: { get: () => ({ id: 'agent-1', type: 'agent' }) },
        topicIdRef: { get: () => topicId },
        historyRef: { get: () => [] },
        getController: () => controller
    });
    test.after(async () => { wiring.dispose?.(); dom.window.close(); });
    return wiring;
}

const descriptorOf = (childTopicId) => ({
    parent: { itemId: 'agent-1', topicId: 'topic-parent' },
    child: { itemId: 'agent-1', topicId: childTopicId }
});

const branchMeta = (childTopicId, parentTopicId = 'root', extra = {}) => ({
    id: `meta-${childTopicId}`,
    parent: { itemType: 'agent', itemId: 'agent-1', topicId: parentTopicId },
    child: { itemType: 'agent', itemId: 'agent-1', topicId: childTopicId },
    title: childTopicId, contextMode: 'parent-snapshot', snapshotId: 'snap-1',
    parentSnapshot: [], forkFromTopicId: parentTopicId, depth: 1,
    createdAt: 1, ...extra
});

test('B1: collectBranchContext reports busy when any mounted instance of the target is busy', async () => {
    const childTopicId = 'sidechat_1700000000001_b';
    const controller = {
        getSnapshot: () => ({ tabs: [
            { kind: 'chat', descriptor: { child: { topicId: 'sidechat_other' } } },
            { kind: 'chat', descriptor: { child: { topicId: childTopicId } } }
        ]}),
        getTabHandle: () => ({ isBusy: () => true })
    };
    const wiring = makeWiring({ chatAPI: {}, controller });
    const res = await wiring.collectBranchContext({ childTopicId, currentDescriptor: descriptorOf(childTopicId) });
    assert.deepEqual(res, { busy: true });
});

test('B2: collectBranchContext assembles snapshot + own history from disk by target identity', async () => {
    const childTopicId = 'sidechat_1700000000002_b';
    const snapMsg = { id: 's1', role: 'user', content: 'ancestor' };
    const ownMsg = { id: 'o1', role: 'assistant', content: 'own reply' };
    const pendingMsg = { id: 'p1', role: 'assistant', content: 'streaming', isStreaming: true };
    const chatAPI = {
        listSideChatMetadata: async () => ({ success: true, items: [
            branchMeta(childTopicId, 'root', { parentSnapshot: [snapMsg] })
        ]}),
        getChatHistory: async () => [ownMsg, pendingMsg]
    };
    const controller = { getSnapshot: () => ({ tabs: [] }), getTabHandle: () => null };
    const wiring = makeWiring({ chatAPI, controller });
    const res = await wiring.collectBranchContext({ childTopicId, currentDescriptor: descriptorOf(childTopicId) });
    assert.equal(res.busy, false);
    assert.equal(res.messages.length, 2, 'pending/streaming messages must be filtered out');
    assert.equal(res.messages[0].content, 'ancestor');
    assert.equal(res.messages[1].content, 'own reply');
});

test('B3: collectBranchContext returns null when target metadata is absent', async () => {
    const chatAPI = { listSideChatMetadata: async () => ({ success: true, items: [] }) };
    const controller = { getSnapshot: () => ({ tabs: [] }), getTabHandle: () => null };
    const wiring = makeWiring({ chatAPI, controller });
    const res = await wiring.collectBranchContext({ childTopicId: 'sidechat_missing', currentDescriptor: descriptorOf('x') });
    assert.equal(res, null);
});

test('C1: deleteBranch retires the tab (discard) BEFORE deleting disk data', async () => {
    const childTopicId = 'sidechat_1700000000003_b';
    const order = [];
    const chatAPI = {
        listSideChatMetadata: async () => ({ success: true, items: [branchMeta(childTopicId)] }),
        deleteSideChatChild: async () => { order.push('delete-disk'); return { success: true }; }
    };
    let tabs = [{ id: 'tab-b', kind: 'chat', descriptor: descriptorOf(childTopicId) }];
    const controller = {
        getSnapshot: () => ({ tabs }),
        closeTab: async (tabId, options) => {
            order.push(`closeTab:${tabId}:discard=${options.discard}`);
            tabs = tabs.filter(tab => tab.id !== tabId);
        }
    };
    // 当前正在查看另一个分支：删除后不触发返航，专注验证时序
    const currentDescriptor = {
        parent: { itemId: 'agent-1', topicId: 'topic-parent' },
        child: { itemId: 'agent-1', topicId: 'sidechat_viewing_other' }
    };
    const wiring = makeWiring({ chatAPI, controller });
    await wiring.deleteBranch({ childTopicId, currentDescriptor });
    assert.deepEqual(order, ['closeTab:tab-b:discard=true', 'delete-disk']);
});

test('C2: deleteBranch retires every open descendant tab before the single disk delete', async () => {
    const rootId = 'sidechat_1700000000004_root';
    const childId = 'sidechat_1700000000005_child';
    const retired = [];
    const chatAPI = {
        listSideChatMetadata: async () => ({ success: true, items: [
            branchMeta(rootId, 'above'),
            branchMeta(childId, rootId)
        ]}),
        deleteSideChatChild: async () => ({ success: true })
    };
    let tabs = [
        { id: 'tab-root', kind: 'chat', descriptor: descriptorOf(rootId) },
        { id: 'tab-child', kind: 'chat', descriptor: { ...descriptorOf(childId), forkFromTopicId: rootId } }
    ];
    const controller = {
        getSnapshot: () => ({ tabs }),
        closeTab: async (tabId, options) => {
            retired.push(`${tabId}:${options.discard}`);
            tabs = tabs.filter(tab => tab.id !== tabId);
        }
    };
    const currentDescriptor = {
        parent: { itemId: 'agent-1', topicId: 'topic-parent' },
        child: { itemId: 'agent-1', topicId: 'sidechat_viewing_other' }
    };
    const wiring = makeWiring({ chatAPI, controller });
    await wiring.deleteBranch({ childTopicId: rootId, currentDescriptor });
    assert.equal(retired.length, 2, 'both root and descendant tabs must be retired');
    assert.ok(retired.every(e => e.endsWith(':true')));
});

// ─────────────────────────────────────────────────────────────
// D. 主进程级联删除（P1#4）：后代等权确权 + cascaded 真实删除数
// ─────────────────────────────────────────────────────────────
async function setupIpc(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidechat-reviewfix-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const trusted = trustedSenderFixture.createTrustedMainSender();
    const handlers = new Map();
    initialize({ USER_DATA_DIR: root, getMainWindow: () => trusted.mainWindow,
        ipcMain: { handle: (c, h) => handlers.set(c, h) } });
    const call = (channel, ...args) => handlers.get(channel)(trusted.event, ...args);
    const topics = path.join(root, 'agent', 'topics');
    return { root, call, topics };
}

const exists = (p) => fs.stat(p).then(() => true, () => false);

// 构造一个确权完整的侧聊后代目录（marker + metadata + snapshot）
async function makeChild(topics, topicId, parentId) {
    const dir = path.join(topics, topicId);
    await fs.mkdir(dir, { recursive: true });
    const writeJson = (file, obj) => fs.writeFile(file, JSON.stringify(obj, null, 2));
    await writeJson(path.join(dir, 'sidechat-child.json'), {
        schemaVersion: 1, ephemeral: true, agentId: 'agent',
        topicId, parentTopicId: parentId, createdAt: 1
    });
    await writeJson(path.join(dir, 'history.json'), []);
    await writeJson(path.join(dir, 'sidechat-metadata.json'), {
        schemaVersion: 1, id: `side-${topicId}`,
        parent: { itemType: 'agent', itemId: 'agent', topicId: parentId },
        child: { itemType: 'agent', itemId: 'agent', topicId },
        title: topicId, contextMode: 'parent-snapshot', snapshotId: null,
        forkFromTopicId: parentId, depth: 1, status: 'ready',
        open: true, createdAt: 1
    });
    await writeJson(path.join(dir, 'parent-snapshot.json'), {
        snapshotId: null, parentTopicId: parentId, messages: [],
        snapshotBoundary: { lastMessageId: null, capturedAt: 1, messageCount: 0 }
    });
}

test('D1: deleting a root cascades to verified descendants and cascaded counts actual removals', async t => {
    const { call, topics } = await setupIpc(t);
    const { topicId: rootId } = await call('side-chat:create-child', 'agent');
    const childId = 'sidechat_1700000000010_child';
    const grandId = 'sidechat_1700000000011_grand';
    await makeChild(topics, childId, rootId);
    await makeChild(topics, grandId, childId);

    const res = await call('side-chat:delete-child', 'agent', rootId);
    assert.equal(res.success, true);
    assert.equal(res.cascaded, 2, 'cascaded must be the number actually removed');
    for (const id of [rootId, childId, grandId]) {
        assert.equal(await exists(path.join(topics, id)), false);
    }
});

test('D2: a directory with matching metadata but no child marker aborts the cascade; root is preserved', async t => {
    const { call, topics } = await setupIpc(t);
    const { topicId: rootId } = await call('side-chat:create-child', 'agent');
    const goodId = 'sidechat_1700000000012_good';
    const badId = 'sidechat_1700000000013_bad';
    await makeChild(topics, goodId, rootId);

    // 非法目录：metadata 血缘指向 good（会被 collectDescendants 收集），但没有 child marker
    const badDir = path.join(topics, badId);
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'sidechat-metadata.json'), JSON.stringify({
        schemaVersion: 1, id: `side-${badId}`,
        parent: { itemType: 'agent', itemId: 'agent', topicId: goodId },
        child: { itemType: 'agent', itemId: 'agent', topicId: badId },
        title: badId, contextMode: 'parent-snapshot',
        forkFromTopicId: goodId, depth: 2, status: 'ready',
        open: true, createdAt: 1
    }));

    const res = await call('side-chat:delete-child', 'agent', rootId);
    assert.equal(res.success, false);
    assert.equal(res.error, 'CASCADE_PARTIAL_FAILED');
    assert.equal(res.cascaded, 1, 'only the verified good descendant was removed');
    assert.ok(res.failed.some(f => f.topicId === badId && f.error === 'NOT_A_SIDE_CHAT_CHILD'));
    assert.equal(await exists(path.join(topics, rootId)), true, 'root must survive a partial failure');
    assert.equal(await exists(path.join(topics, goodId)), false);
    assert.equal(await exists(path.join(topics, badId)), true, 'unverified directory must never be removed');
});

test('C3: failed metadata listing prevents disk deletion', async () => {
    let deletes = 0;
    const wiring = makeWiring({
        chatAPI: {
            listSideChatMetadata: async () => ({ success: false, error: 'READ_FAILED' }),
            deleteSideChatChild: async () => { deletes++; return { success: true }; }
        },
        controller: { getSnapshot: () => ({ tabs: [] }) }
    });
    await assert.rejects(wiring.deleteBranch({ childTopicId: 'root', currentDescriptor: descriptorOf('other') }), /READ_FAILED/);
    assert.equal(deletes, 0);
});

test('C4: a tab which remains alive prevents disk deletion', async () => {
    let deletes = 0;
    const wiring = makeWiring({
        chatAPI: {
            listSideChatMetadata: async () => ({ success: true, items: [] }),
            deleteSideChatChild: async () => { deletes++; return { success: true }; }
        },
        controller: {
            getSnapshot: () => ({ tabs: [{ id: 'root-tab', kind: 'chat', descriptor: descriptorOf('root') }] }),
            closeTab: async () => {}
        }
    });
    await assert.rejects(wiring.deleteBranch({ childTopicId: 'root', currentDescriptor: descriptorOf('other') }), /未能关闭/);
    assert.equal(deletes, 0);
});

test('B4: mounted target owner supplies its live context without disk reads', async () => {
    const descriptor = descriptorOf('target');
    const messages = [{ role: 'user', content: 'live target context' }];
    const wiring = makeWiring({
        chatAPI: {
            listSideChatMetadata: async () => { throw new Error('unexpected disk read'); }
        },
        controller: {
            getSnapshot: () => ({ tabs: [{ id: 'target-tab', kind: 'chat', descriptor }] }),
            getTabHandle: () => ({
                isBusy: () => false,
                collectBranchContext: async () => ({ busy: false, descriptor, messages })
            })
        }
    });
    const result = await wiring.collectBranchContext({ childTopicId: 'target', currentDescriptor: descriptorOf('other') });
    assert.deepEqual(result, { busy: false, descriptor, messages });
});

test('D3: unreadable descendant metadata aborts the cascade before deleting any child', async t => {
    const { call, topics } = await setupIpc(t);
    const { topicId: rootId } = await call('side-chat:create-child', 'agent');
    const goodId = 'sidechat_1700000000020_good';
    const corruptId = 'sidechat_1700000000021_corrupt';
    await makeChild(topics, goodId, rootId);

    const corruptDir = path.join(topics, corruptId);
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, 'sidechat-metadata.json'), '{ invalid json');

    const res = await call('side-chat:delete-child', 'agent', rootId);
    assert.equal(res.success, false);
    assert.equal(res.error, 'CASCADE_SCAN_FAILED');
    assert.equal(await exists(path.join(topics, rootId)), true, 'root must remain when the full cascade cannot be scanned');
    assert.equal(await exists(path.join(topics, goodId)), true, 'no descendant should be removed before scanning completes');
});

test('C5: deleteBranch surfaces the readable cascade scan error message', async () => {
    const childTopicId = 'sidechat_1700000000030_root';
    const wiring = makeWiring({
        chatAPI: {
            listSideChatMetadata: async () => ({ success: true, items: [branchMeta(childTopicId)] }),
            deleteSideChatChild: async () => ({
                success: false,
                error: 'CASCADE_SCAN_FAILED',
                message: '无法读取侧聊分支元数据 damaged'
            })
        },
        controller: { getSnapshot: () => ({ tabs: [] }) }
    });

    await assert.rejects(
        wiring.deleteBranch({ childTopicId, currentDescriptor: descriptorOf('viewing-other') }),
        error => error.message === '无法读取侧聊分支元数据 damaged' && error.code === 'CASCADE_SCAN_FAILED'
    );
});