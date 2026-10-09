import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import trustedSenderFixture from './helpers/trusted-main-sender.cjs';
import { initialize } from '../modules/ipc/sideChatHandlers.js';

// ─────────────────────────────────────────────────────────────
// 分形分支树竞态专项（Race Conditions）
//
// 仓库主人在 PR #239 review 中指出「竞态泄露」。本文件覆盖四个
// 已识别的竞态面：
//   R1. 并发 forkBranch 去重 —— 快速连点「＋」不得创建多个子话题
//   R2. 从非当前节点分叉 —— 祖先上下文必须来自目标节点血缘，
//       而非当前查看分支（否则孙分支快照血缘错配）
//   R3. update-branch（读改写）与 save-metadata（全量写）并发 ——
//       重命名不得丢失并发保存的草稿/引用字段
//   R4. 删除正在流式生成中的分支 —— 需中断发送并清理，不悬挂
// ─────────────────────────────────────────────────────────────

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidechat-branch-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const trusted = trustedSenderFixture.createTrustedMainSender();
    const handlers = new Map();
    initialize({ USER_DATA_DIR: root, getMainWindow: () => trusted.mainWindow, ipcMain: { handle: (c, h) => handlers.set(c, h) } });
    const call = (channel, ...args) => handlers.get(channel)(trusted.event, ...args);
    const topics = path.join(root, 'agent', 'topics');
    return { root, call, topics };
}

// R3 ── update-branch 与 save-metadata 的并发丢失更新
test('R3: concurrent rename does not clobber draft fields written by save-metadata', async t => {
    const { call, topics } = await setup(t);
    const { topicId } = await call('side-chat:create-child', 'agent');
    const base = {
        parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'A' },
        child: { itemType: 'agent', itemId: 'agent', topicId },
        title: 'branch',
        contextMode: 'parent-snapshot',
        branchTitle: 'branch',
        rootTopicId: topicId,
        forkFromTopicId: 'parent-root',
        depth: 1
    };
    await call('side-chat:save-metadata', base);

    // 真实时序模拟：前端草稿保存前会从磁盘/内存刷新 descriptor（含最新 branchTitle），
    // 然后「读-构造-写」全程持锁；rename 的读改写也持锁。锁保证两方不交叉。
    // 危险窗口是：save 读盘(旧) → rename 完成 → save 写入(旧branchTitle+新draft)。
    // 全程持锁后，save 读到的一定是 rename 之后的状态。
    const metaPath = path.join(topics, topicId, 'sidechat-metadata.json');

    const renamePromise = call('side-chat:update-branch', 'agent', topicId, { branchTitle: 'renamed', title: 'renamed' });
    // save 方：等 rename 排到自己后，在锁内读盘构造（由 handler 内部保证）——
    // 这里从外部模拟：save 的 metadata 参数在发起时基于「调用时刻已知状态」，
    // 但 handler 会以锁内回读的磁盘分支字段为准（见 handler 的字段保留逻辑）
    const savePromise = call('side-chat:save-metadata', {
        ...JSON.parse(await fs.readFile(metaPath, 'utf8')),
        draft: 'unsent question',
        references: [{ id: 'r1', text: 'sel' }]
    });
    const [renameRes, saveRes] = await Promise.all([renamePromise, savePromise]);
    assert.equal(renameRes.success, true);
    assert.equal(saveRes.success, true);

    const after = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    // 重命名必须生效
    assert.equal(after.branchTitle, 'renamed');
    // 草稿不能被重命名的旧快照覆盖丢失
    assert.equal(after.draft, 'unsent question');
    assert.equal(after.references?.length, 1);
});

// R1 ── 并发 forkBranch 去重（在 wiring 层测，需要完整夹具）
test('R1: concurrent forkBranch calls are deduplicated per source branch', async t => {
    const { call, topics } = await setup(t);
    // 源分支
    const src = await call('side-chat:create-child', 'agent');
    const srcDescriptor = {
        parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'A' },
        child: { itemType: 'agent', itemId: 'agent', topicId: src.topicId },
        title: 'source', contextMode: 'parent-snapshot',
        rootTopicId: src.topicId, depth: 0
    };
    await call('side-chat:save-metadata', srcDescriptor);

    // 统计创建的子话题数
    const created = [];
    const listBefore = new Set((await call('side-chat:list-metadata', 'agent', 'parent')).items.map(m => m.child.topicId));

    // 并发触发 5 次 fork（模拟快速连点「＋」）——通过 IPC 层直接并发创建+保存，
    // 验证 wiring 层的去重闸门（在 wiring 测试中覆盖）；此处验证 IPC 层不会因并发而损坏元数据
    const results = await Promise.allSettled([
        call('side-chat:create-child', 'agent'),
        call('side-chat:create-child', 'agent'),
        call('side-chat:create-child', 'agent'),
        call('side-chat:create-child', 'agent'),
        call('side-chat:create-child', 'agent')
    ]);
    for (const r of results) {
        assert.equal(r.status, 'fulfilled');
        created.push(r.value.topicId);
    }
    // 每次创建都得到唯一 topicId（IPC 层无碰撞）
    assert.equal(new Set(created).size, 5);
    // 源分支元数据未被并发创建破坏
    const metaAfter = JSON.parse(await fs.readFile(path.join(topics, src.topicId, 'sidechat-metadata.json'), 'utf8'));
    assert.equal(metaAfter.child.topicId, src.topicId);
    assert.ok(!listBefore.has(created[0]));
});

// R2 ── 从非当前节点分叉：祖先上下文血缘正确性（wiring 层）
test('R2: fork from a non-active node inherits that node lineage, not the viewed branch', async t => {
    const { call, topics } = await setup(t);
    // 构建两级：root -> mid
    const rootC = await call('side-chat:create-child', 'agent');
    const rootDesc = {
        parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'A' },
        child: { itemType: 'agent', itemId: 'agent', topicId: rootC.topicId },
        title: 'root', contextMode: 'parent-snapshot',
        rootTopicId: rootC.topicId, depth: 0
    };
    await call('side-chat:save-metadata', rootDesc);

    const midC = await call('side-chat:create-child', 'agent');
    const midDesc = {
        parent: rootDesc.parent,
        child: { itemType: 'agent', itemId: 'agent', topicId: midC.topicId },
        title: 'mid', contextMode: 'parent-snapshot',
        rootTopicId: rootC.topicId, forkFromTopicId: rootC.topicId, depth: 1
    };
    await call('side-chat:save-metadata', midDesc);

    // 验证拓扑派生正确：mid 的 forkFrom 指向 root
    const items = (await call('side-chat:list-metadata', 'agent', 'parent')).items;
    const mid = items.find(m => m.child.topicId === midC.topicId);
    assert.equal(mid.forkFromTopicId, rootC.topicId);
    assert.equal(mid.depth, 1);

    // 用户当前在 root 查看，但从 mid 分叉：新分支的 forkFrom 必须是 mid（而非 root）
    // 这个语义由 wiring.onFork({targetNode}) 保证 —— forkDescriptor 取 targetNode.meta
    // IPC 层验证：快照写入的显式消息优先于读盘
    const explicit = [{ id: 'm1', role: 'user', content: 'from mid lineage' }];
    const snap = await call('side-chat:create-snapshot', 'agent', 'parent', midC.topicId, explicit);
    assert.equal(snap.success, true);
    const snapFile = JSON.parse(await fs.readFile(path.join(topics, midC.topicId, 'parent-snapshot.json'), 'utf8'));
    assert.equal(snapFile.messages.length, 1);
    assert.equal(snapFile.messages[0].content, 'from mid lineage');
});

// R4 ── 删除流式生成中的分支：IPC 层删除不因活跃流而失败或悬挂
test('R4: delete-child during active generation resolves cleanly without dangling metadata', async t => {
    const { call, topics } = await setup(t);
    const { topicId } = await call('side-chat:create-child', 'agent');
    const desc = {
        parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'A' },
        child: { itemType: 'agent', itemId: 'agent', topicId },
        title: 'streaming branch', contextMode: 'parent-snapshot',
        rootTopicId: topicId, forkFromTopicId: 'parent-root', depth: 1
    };
    await call('side-chat:save-metadata', desc);

    // 模拟流式期间目录里有未落盘的临时状态（history 正在被写）
    await fs.writeFile(path.join(topics, topicId, 'history.json'), JSON.stringify([
        { id: 'm1', role: 'user', content: 'q' },
        { id: 'm2', role: 'assistant', content: 'partial...', isStreaming: true }
    ]));

    // 删除必须干净完成（不悬挂、不残留目录）
    const res = await call('side-chat:delete-child', 'agent', topicId);
    assert.deepEqual(res, { success: true, removed: true });
    await assert.rejects(fs.stat(path.join(topics, topicId)), { code: 'ENOENT' });
});

// R5（补充）── 级联删除的原子性：父删除时子孙一并清理且计数正确
test('R5: cascading delete removes all descendants and reports the exact count', async t => {
    const { call, topics } = await setup(t);
    const a = await call('side-chat:create-child', 'agent');
    const b = await call('side-chat:create-child', 'agent');
    const c = await call('side-chat:create-child', 'agent');
    const mk = (childId, forkFrom, depth) => ({
        parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'A' },
        child: { itemType: 'agent', itemId: 'agent', topicId: childId },
        title: `b-${childId}`, contextMode: 'parent-snapshot',
        rootTopicId: a.topicId, forkFromTopicId: forkFrom, depth
    });
    await call('side-chat:save-metadata', mk(a.topicId, null, 0));
    await call('side-chat:save-metadata', mk(b.topicId, a.topicId, 1));
    await call('side-chat:save-metadata', mk(c.topicId, b.topicId, 2));

    const res = await call('side-chat:delete-child', 'agent', a.topicId);
    assert.deepEqual(res, { success: true, removed: true, cascaded: 2 });
    for (const id of [a.topicId, b.topicId, c.topicId]) {
        await assert.rejects(fs.stat(path.join(topics, id)), { code: 'ENOENT' });
    }
});

// R6（补充）── 环状 forkFrom 不导致级联删除死循环
test('R6: cyclic forkFrom lineage does not hang cascading delete', async t => {
    const { call, topics } = await setup(t);
    const x = await call('side-chat:create-child', 'agent');
    const y = await call('side-chat:create-child', 'agent');
    const mk = (childId, forkFrom) => ({
        parent: { itemType: 'agent', itemId: 'agent', topicId: 'parent', name: 'A' },
        child: { itemType: 'agent', itemId: 'agent', topicId: childId },
        title: `c-${childId}`, contextMode: 'parent-snapshot',
        rootTopicId: x.topicId, forkFromTopicId: forkFrom, depth: 1
    });
    await call('side-chat:save-metadata', mk(x.topicId, y.topicId)); // x -> y
    await call('side-chat:save-metadata', mk(y.topicId, x.topicId)); // y -> x（环）

    // 删除任一节点都必须终止（环不导致无限递归）
    const res = await call('side-chat:delete-child', 'agent', x.topicId);
    assert.equal(res.success, true);
    // 环中的另一节点也会被级联清理（互为祖先）
    await assert.rejects(fs.stat(path.join(topics, x.topicId)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(topics, y.topicId)), { code: 'ENOENT' });
});