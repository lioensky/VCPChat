'use strict';
// ProjectForge 集成测试：临时目录 + 注入的工作区门面与回收站，不触碰真实设置与系统回收站。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const { isPathInside } = require('../VCPDistributedServer/shared/fileKit/paths');
const { RustProjectStore } = require('../VCPDistributedServer/Plugin/ProjectForge/rustStore');
const { resolveDefaultBinaryPath } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');
const Database = require('better-sqlite3');

let tmp;
let wsRoot;
let dbPath;
let workspaceService;

const logger = { log() {}, warn() {}, error() {} };

function initializeForge(service = workspaceService) {
    forge.initialize({
        dbPath,
        services: { workspaceService: service },
        logger,
    });
}

function textOf(result) {
    return result.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

const call = args => forge.processToolCall(args);

// 历史 fixture 只在服务完全关闭后直写 SQL：不再复活任何旧 JS 存储层。
function withSql(file, fn) {
    const db = new Database(file);
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

async function withOfflineSql(fn) {
    await forge.cleanup();
    try {
        return withSql(dbPath, fn);
    } finally {
        initializeForge();
    }
}

test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
    wsRoot = path.join(tmp, 'ws');
    dbPath = path.join(tmp, 'db', 'pf.db');
    fs.mkdirSync(wsRoot, { recursive: true });
    workspaceService = {
        list: () => [{ id: 'ws1', alias: 'demo', path: wsRoot, enabled: true, status: 'ready' }],
        getActiveWorkspaceId: () => 'ws1',
    };
    initializeForge();
});

test.after(async () => {
    await forge.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function newProject(name) {
    const r = await call({ command: 'CreateProject', name, dir: name, todos: '写代码\n写测试' });
    return r.details.project.id;
}

test('isPathInside 拒绝前缀相同的兄弟目录', () => {
    assert.equal(isPathInside(path.join(tmp, 'ws', 'a.js'), path.join(tmp, 'ws')), true);
    assert.equal(isPathInside(path.join(tmp, 'ws2', 'a.js'), path.join(tmp, 'ws')), false);
});

test('EditCode：串内行号以原始快照为准，重叠整串拒绝', async () => {
    const pid = await newProject('seq');
    const file = path.join(wsRoot, 'seq', 'seq.txt');
    await call({ command: 'CreateFile', projectId: pid, path: 'seq.txt', content: 'a\nb\nc\nd\n', reason: 'fixture' });

    const ok = await call({
        command: 'EditCode', projectId: pid, path: 'seq.txt', reason: '按原快照行号替换',
        op1: 'replace', start1: '1', end1: '1', content1: 'A\nA2',
        op2: 'replace', start2: '3', end2: '3', content2: 'C',
    });
    assert.equal(ok.details.status, 'ok', textOf(ok));
    assert.deepEqual(ok.details.applied, [1, 2]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'A\nA2\nb\nC\nd\n');

    // 第二步引用原始快照 L2-3，与第一步 L1-2 重叠：atomic 模式整串不写。
    const bad = await call({
        command: 'EditCode', projectId: pid, path: 'seq.txt', reason: '重叠拒绝',
        op1: 'replace', start1: '1', end1: '2', content1: 'x',
        op2: 'delete', start2: '2', end2: '3',
    });
    assert.equal(bad.details.status, 'error');
    assert.equal(bad.details.errors[0].step, 2);
    assert.match(bad.details.errors[0].message, /overlap/);
    assert.match(textOf(bad), /未写入/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'A\nA2\nb\nC\nd\n');
});

test('工程生命周期：创建 → 编辑 → 歧义票据 → 回退 → 删除只动数据库', async () => {
    const pid = await newProject('life');
    const root = path.join(wsRoot, 'life');
    assert.ok(fs.existsSync(root));

    // reason 必填
    await assert.rejects(call({ command: 'CreateFile', projectId: pid, path: 'a.js', content: 'x' }), /reason/);

    const src = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n';
    const created = await call({ command: 'CreateFile', projectId: pid, path: 'src/a.js', content: src, reason: '初始化' });
    assert.equal(created.details.status, 'ok');
    assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), src);

    // 串语法：原始行号
    const edited = await call({
        command: 'EditCode', projectId: pid, path: 'src/a.js', reason: '改返回值', todo: '1',
        op1: 'replace', start1: '2', end1: '2', content1: '  return 10;\n  // extra',
        op2: 'replace', start2: '5', end2: '5', content2: '  return 20;',
    });
    assert.equal(edited.details.status, 'ok', textOf(edited));
    assert.match(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), /return 10;\n  \/\/ extra\n\}\nfunction b\(\) \{\n  return 20;/);
    assert.match(textOf(edited), /```diff/);

    // 歧义 → 票据 → ResolveEdit
    const amb = await call({ command: 'EditCode', projectId: pid, path: 'src/a.js', reason: '统一注释', target: 'function', replace: 'async function' });
    assert.equal(amb.details.status, 'ambiguous');
    assert.match(textOf(amb), /候选 2 · L5/);
    const resolved = await call({ command: 'ResolveEdit', ticketId: amb.details.ticketId, pick: '2' });
    assert.equal(resolved.details.status, 'ok', textOf(resolved));
    assert.ok(textOf(resolved).includes('- 工程：`' + pid + '`'), textOf(resolved));
    assert.match(textOf(resolved), /- reason：统一注释/);
    assert.doesNotMatch(textOf(resolved), /未回传/);
    const afterResolve = fs.readFileSync(path.join(root, 'src/a.js'), 'utf8');
    assert.match(afterResolve, /^function a\(\)/);
    assert.match(afterResolve, /async function b\(\)/);

    // 回退最近一次 → 回退回退（重做）
    const rb = await call({ command: 'Rollback', projectId: pid, batch: 'last' });
    assert.equal(rb.details.status, 'ok', textOf(rb));
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), /async/);
    const redo = await call({ command: 'Rollback', projectId: pid, batch: 'last' });
    assert.equal(redo.details.status, 'ok');
    assert.match(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), /async function b/);

    // 外部修改 → 回退冲突，force 才执行
    fs.writeFileSync(path.join(root, 'src/a.js'), 'manual\n');
    const conflict = await call({ command: 'Rollback', projectId: pid, batch: `b${created.details.batchId}` });
    assert.equal(conflict.details.status, 'conflict');

    // RemoveFile 走可回退快照，不再依赖外部回收站
    const removed = await call({ command: 'RemoveFile', projectId: pid, path: 'src/a.js', reason: '不再需要' });
    assert.equal(removed.details.removed, 1);
    assert.equal(fs.existsSync(path.join(root, 'src/a.js')), false);
    assert.ok(removed.details.batchId > 0, '删除必须产生可回退批次');
    assert.equal(removed.details.nodeIds.length, 1);
    await call({ command: 'Rollback', projectId: pid, batch: `b${removed.details.batchId}` });
    assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'manual\n');

    // 历史搜索匹配 reason，外部修改被记录
    const hist = await call({ command: 'SearchHistory', projectId: pid, keyword: '改返回值' });
    assert.ok(hist.details.count >= 1);
    const ext = await call({ command: 'SearchHistory', projectId: pid, op: 'external' });
    assert.ok(ext.details.count >= 1);

    // 报告与工程读取
    await call({ command: 'UpdateTodos', projectId: pid, done: '1,2' });
    const report = await call({ command: 'SubmitReport', projectId: pid, conclusion: '完成' });
    assert.match(textOf(report), /开发脉络/);
    const info = await call({ command: 'GetProject', projectId: pid });
    assert.match(textOf(info), /2\/2/);
    assert.match(textOf(info), /验收报告/);

    // 删除工程只动数据库
    await call({ command: 'DeleteProjects', projectIds: pid });
    assert.ok(fs.existsSync(path.join(root, 'src/a.js')));
    await assert.rejects(call({ command: 'GetProject', projectId: pid }), /不存在或已删除/);
    await assert.rejects(call({ command: 'PurgeProjects', projectIds: pid }), /confirm/);
    const purged = await call({ command: 'PurgeProjects', projectIds: pid, confirm: 'true' });
    assert.deepEqual(purged.details.purged, [pid]);
    assert.ok(fs.existsSync(path.join(root, 'src/a.js')));
});

test('ReadCode：行号、单文件行范围、find 消歧、越界拒绝', async () => {
    const pid = await newProject('read');
    await call({ command: 'CreateFile', projectId: pid, path: 'x.js', content: 'const a = 1;\nfunction f() {\n  a();\n}\nfunction g() {\n  a();\n}\n', reason: 'fixture' });
    const r = await call({ command: 'ReadCode', projectId: pid, path: 'x.js:2-3' });
    const t = textOf(r);
    assert.match(t, /2 \| function f\(\)/);
    assert.doesNotMatch(t, /function g/);
    const f = await call({ command: 'ReadCode', projectId: pid, path: 'x.js', find: 'a();' });
    assert.equal(f.details.total, 2);
    assert.match(textOf(f), /in g/);
    await assert.rejects(call({ command: 'ReadCode', projectId: pid, path: '../../outside.js' }), /越出工程根/);
});

test('删除、恢复和清理事件携带实际影响的单个或批量工程 ID', async () => {
    for (const count of [1, 2]) {
        const ids = [];
        for (let i = 0; i < count; i += 1) ids.push(await newProject(`event-${count}-${i}`));
        const events = [];
        const onChanged = payload => events.push(payload);
        forge.events.on('changed', onChanged);
        try {
            for (const command of ['DeleteProjects', 'RestoreProjects', 'DeleteProjects', 'PurgeProjects']) {
                events.length = 0;
                await call({ command, projectIds: [...ids, 'missing-event-project'], confirm: true });
                assert.equal(events.length, 1, command);
                assert.equal(events[0].action, command.toLowerCase());
                assert.deepEqual(events[0].projectIds, ids, 'only IDs changed by the operation are broadcast');
                assert.equal(events[0].projectId, count === 1 ? ids[0] : null);
            }
        } finally {
            forge.events.off('changed', onChanged);
        }
    }
});

test('EditCode：行号前缀剥除、expect 漂移、bestEffort、CRLF 保持', async () => {
    const pid = await newProject('tol');
    const file = path.join(wsRoot, 'tol', 'c.js');
    await call({ command: 'CreateFile', projectId: pid, path: 'c.js', content: 'one\ntwo\nthree\n', reason: 'fixture' });
    fs.writeFileSync(file, 'one\r\ntwo\r\nthree\r\n'); // 外部改为 CRLF
    const r = await call({
        command: 'EditCode', projectId: pid, path: 'c.js', reason: '容错', mode: 'bestEffort',
        op1: 'replace', start1: '1', end1: '1', expect1: 'three', content1: '  3 | THREE',
        op2: 'target', target2: 'not-exist', replace2: 'x',
    });
    assert.equal(r.details.status, 'ok', textOf(r));
    assert.equal(r.details.skipped.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\ntwo\r\nTHREE\r\n');
    assert.match(textOf(r), /漂移校正/);
    assert.match(textOf(r), /剥除行号前缀/);
});

test('maid：多 Agent 署名持久化、byMaid 过滤、参与者统计', async () => {
    const r = await call({ command: 'CreateProject', name: 'multi', dir: 'multi', maid: 'Nova' });
    const pid = r.details.project.id;
    assert.match(textOf(r), /@Nova/);
    await call({ command: 'CreateFile', projectId: pid, path: 'm.js', content: 'a\nb\n', reason: '初始化', maid: 'Nova' });
    await call({ command: 'EditCode', projectId: pid, path: 'm.js', reason: '改 b', start: '2', end: '2', content: 'B', maid: '{"name":"Aemeath","id":"agent-2"}' });
    await call({ command: 'Rollback', projectId: pid, batch: 'last', maid: 'Cora' });

    const byAemeath = await call({ command: 'SearchHistory', projectId: pid, byMaid: 'aemeath', maid: 'Nova' });
    assert.equal(byAemeath.details.count, 1);
    assert.equal(byAemeath.details.nodes[0].maid, 'Aemeath');

    const info = textOf(await call({ command: 'GetProject', projectId: pid }));
    for (const who of ['@Nova', '@Aemeath', '@Cora']) assert.ok(info.includes(who), `缺少 ${who}`);
    assert.match(info, /创建者：@Nova/);

    const report = textOf(await call({ command: 'SubmitReport', projectId: pid, conclusion: 'ok', maid: 'Cora' }));
    assert.match(report, /提交者：@Cora/);
    assert.match(report, /## 参与者/);
});

test('store：旧库自动补列迁移', async () => {
    const legacyDb = path.join(tmp, 'legacy.db');
    const legacy = new Database(legacyDb);
    legacy.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT, workspace_alias TEXT,
        root TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', report TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE batches (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL);`);
    legacy.prepare('INSERT INTO projects(id, name, root, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('plegacy', '旧工程', tmp, 'active', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO batches(project_id, kind, summary, created_at) VALUES (?, ?, ?, ?)')
        .run('plegacy', 'edit', '旧批次', '2020-01-01T00:00:00.000Z');
    legacy.close();

    // 真实服务打开旧库即执行补列迁移；旧行保留，新列可读。
    const binaryPath = resolveDefaultBinaryPath();
    let store = new RustProjectStore({ dbPath: legacyDb, binaryPath });
    try {
        await store.start();
        assert.equal((await store.info()).serviceSchemaVersion, 5);
        const project = await store.getProject('plegacy');
        assert.equal(project.name, '旧工程');
        assert.equal(project.subpath, '');
        assert.equal(project.created_by, null);
        assert.equal((await store.getBatch('plegacy', 1)).summary, '旧批次');
    } finally {
        await store.close();
    }

    let batchId;
    withSql(legacyDb, db => {
        const cols = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        assert.ok(cols('batches').includes('maid') && cols('batches').includes('reason'));
        assert.ok(cols('projects').includes('created_by') && cols('projects').includes('subpath'));
        assert.equal(db.prepare("SELECT name FROM projects WHERE id = 'plegacy'").get().name, '旧工程');
        batchId = Number(db.prepare('INSERT INTO batches(project_id, kind, reason, maid, created_at) VALUES (?, ?, ?, ?, ?)')
            .run('plegacy', 'edit', '迁移后写入', 'Nova', '2021-01-01T00:00:00.000Z').lastInsertRowid);
    });

    // 补列后写入的 maid/reason 与旧行一起由原生服务读回。
    store = new RustProjectStore({ dbPath: legacyDb, binaryPath });
    try {
        await store.start();
        const batch = await store.getBatch('plegacy', batchId);
        assert.equal(batch.maid, 'Nova');
        assert.equal(batch.reason, '迁移后写入');
        assert.equal((await store.getProject('plegacy')).name, '旧工程');
    } finally {
        await store.close();
    }
});
test('GUI 门面：只读浏览 + 署名单文件回退（预检 / 冲突 / force / 再回退）', async () => {
    const r = await call({ command: 'CreateProject', name: 'gui', dir: 'gui', maid: 'Nova', todos: '界面' });
    const pid = r.details.project.id;
    const file = path.join(wsRoot, 'gui', 'g.js');
    await call({ command: 'CreateFile', projectId: pid, path: 'g.js', content: 'v1\n', reason: '初始化', maid: 'Nova' });
    const edit = await call({ command: 'EditCode', projectId: pid, path: 'g.js', reason: '升级到 v2', start: '1', end: '1', content: 'v2', maid: 'Aemeath' });
    const editNode = edit.details.nodeId;

    // 只读浏览
    const list = await forge.gui.listProjects();
    const summary = list.find(p => p.id === pid);
    assert.ok(summary && summary.progress.total === 1 && summary.report === undefined);
    const detail = await forge.gui.getProject(pid);
    assert.equal(detail.timeline.length, 2);
    assert.ok(Array.isArray(detail.timeline[0].files));
    assert.deepEqual(detail.contributors.map(c => c.maid).sort(), ['Aemeath', 'Nova']);
    assert.equal((await forge.gui.searchHistory({ projectId: pid, byMaid: 'aemeath' })).length, 1);
    assert.equal((await forge.gui.searchHistory({ projectId: pid, file: 'g.js' })).length, 2);
    const node = await forge.gui.getNodeDetail(pid, editNode);
    assert.equal(node.before.text, 'v1\n');
    assert.equal(node.after.text, 'v2\n');
    assert.equal(node.batch.maid, 'Aemeath');

    // 必须署名
    await assert.rejects(forge.gui.revertFileChange({ projectId: pid, nodeId: editNode }), /署名/);

    // dryRun 不落盘
    const plan = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, signature: '主人', dryRun: true });
    assert.equal(plan.status, 'dryRun');
    assert.equal(plan.action, '恢复内容');
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2\n');

    // 外部修改 → 冲突，force 才执行
    fs.writeFileSync(file, 'manual\n');
    const conflict = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, signature: '主人' });
    assert.equal(conflict.status, 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), 'manual\n');
    const ok = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, signature: '主人', reason: '人工撤销', force: true });
    assert.equal(ok.status, 'ok');
    assert.equal(fs.readFileSync(file, 'utf8'), 'v1\n');

    // 回退批次带署名与原因，且可再回退（恢复到该节点完成时）
    const batch = await forge.gui.getBatchNodes(pid, ok.batchId);
    assert.equal(batch.batch.maid, '主人');
    assert.equal(batch.batch.reason, '人工撤销');
    const redo = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, mode: 'after', signature: '主人' });
    assert.equal(redo.status, 'conflict'); // 此后该文件还有改动（回退节点）
    const redoForced = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, mode: 'after', signature: '主人', force: true });
    assert.equal(redoForced.status, 'ok');
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2\n');
    // GUI 删除工程：仅数据库软删除，磁盘文件完好
    const delRes = await forge.gui.deleteProject(pid, '莱恩');
    assert.deepEqual(delRes, { deleted: true, projectId: pid });
    assert.ok(!(await forge.gui.listProjects()).some(p => p.id === pid));
    const deletedProj = (await forge.gui.listProjects({ includeDeleted: true })).find(p => p.id === pid);
    assert.ok(deletedProj && deletedProj.deleted_at && deletedProj.deleted_by === '莱恩');
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2\n');
    assert.ok((await forge.gui.getProject(pid)).contributors.some(c => c.maid === '主人'));
});

test('EditCode：target 字面优先、整行省略按候选显式选择、行号前缀与多义票据', async () => {
    const pid = await newProject('anchor');
    const root = path.join(wsRoot, 'anchor');
    const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
    const src = 'function a() {\n  if (x) {\n    y();\n  }\n  return 1;\n}\nfunction b() {}\n';

    // 整行省略（... / …）只回候选：即使只有一对候选也要显式 pick，不做隐式首尾配对。
    await call({ command: 'CreateFile', projectId: pid, path: 'a1.js', content: src, reason: 'fixture' });
    const elided = await call({ command: 'EditCode', projectId: pid, path: 'a1.js', reason: '整行省略', target: 'function a() {\n...\n}', content: 'function a() {}' });
    assert.equal(elided.details.status, 'ambiguous');
    assert.equal(elided.details.ambiguities[0].total, 1);
    assert.match(textOf(elided), /候选 1 · L1-6/);
    const picked = await call({ command: 'ResolveEdit', ticketId: elided.details.ticketId, pick: '1' });
    assert.equal(picked.details.status, 'ok', textOf(picked));
    assert.equal(read('a1.js'), 'function a() {}\nfunction b() {}\n');

    // 带 ReadCode 行号前缀：整块剥除前缀后仍按内容锚定，尾行可指定内层缩进。
    await call({ command: 'CreateFile', projectId: pid, path: 'a2.js', content: src, reason: 'fixture' });
    const prefixed = await call({ command: 'EditCode', projectId: pid, path: 'a2.js', reason: '行号前缀', target: '1 | function a() {\n...\n4 |   }', content: 'function a() {' });
    assert.equal(prefixed.details.status, 'ambiguous');
    assert.match(textOf(prefixed), /候选 1 · L1-4/);
    const inner = await call({ command: 'ResolveEdit', ticketId: prefixed.details.ticketId, pick: '1' });
    assert.equal(inner.details.status, 'ok', textOf(inner));
    assert.equal(read('a2.js'), 'function a() {\n  return 1;\n}\nfunction b() {}\n');

    // 行号有偏差时以内容为准：候选回传真实区间，选中后按该区间删除。
    await call({ command: 'CreateFile', projectId: pid, path: 'a3.js', content: src, reason: 'fixture' });
    const drifted = await call({ command: 'EditCode', projectId: pid, path: 'a3.js', reason: '行号偏差', target: '3 | function a() {\n…\n8 | }', content: '' });
    assert.equal(drifted.details.status, 'ambiguous');
    assert.match(textOf(drifted), /候选 1 · L1-6/);
    const removed = await call({ command: 'ResolveEdit', ticketId: drifted.details.ticketId, pick: '1' });
    assert.equal(removed.details.status, 'ok', textOf(removed));
    assert.equal(read('a3.js'), 'function b() {}\n');

    // 锚点对不上时明确报错，文件保持原样。
    await call({ command: 'CreateFile', projectId: pid, path: 'a4.js', content: src, reason: 'fixture' });
    const missing = await call({ command: 'EditCode', projectId: pid, path: 'a4.js', reason: '锚点缺失', target: 'function zzz() {\n...\n}', content: '' });
    assert.equal(missing.details.status, 'error');
    assert.match(missing.details.errors[0].message, /elision anchors not found/);
    assert.equal(read('a4.js'), src);

    // 字面能匹配时不启用整行省略（Python 的 ... 占位）。
    const py = 'def f():\n    ...\n\ndef g():\n    pass\n';
    await call({ command: 'CreateFile', projectId: pid, path: 'lit.py', content: py, reason: 'fixture' });
    const literal = await call({ command: 'EditCode', projectId: pid, path: 'lit.py', reason: '字面优先', target: 'def f():\n    ...', content: 'def f():\n    return 1' });
    assert.equal(literal.details.status, 'ok', textOf(literal));
    assert.equal(read('lit.py'), 'def f():\n    return 1\n\ndef g():\n    pass\n');

    // 多处命中照常返回候选清单，票据 pick 后才落盘。
    await call({ command: 'CreateFile', projectId: pid, path: 'twice.js', content: 'if (a) {\n  x();\n}\nif (b) {\n  x();\n}\n', reason: 'fixture' });
    const multi = await call({ command: 'EditCode', projectId: pid, path: 'twice.js', reason: '多处命中', target: '  x();\n...\n}' });
    assert.equal(multi.details.status, 'ambiguous');
    assert.equal(multi.details.ambiguities[0].total, 3);
    assert.match(textOf(multi), /候选 3 · L5-6/);
    assert.equal(read('twice.js'), 'if (a) {\n  x();\n}\nif (b) {\n  x();\n}\n');
});

test('EditCode：insert before=N / after=end', async () => {
    const pid = await newProject('ins');
    const file = path.join(wsRoot, 'ins', 'ins.txt');
    await call({ command: 'CreateFile', projectId: pid, path: 'ins.txt', content: 'a\nb\nc\n', reason: 'fixture' });
    const r = await call({
        command: 'EditCode', projectId: pid, path: 'ins.txt', reason: '三处插入',
        op1: 'insert', before1: '1', content1: 'top',
        op2: 'insert', before2: '3', content2: 'mid',
        op3: 'insert', after3: 'end', content3: 'bottom',
    });
    assert.equal(r.details.status, 'ok', textOf(r));
    assert.deepEqual(r.details.applied, [1, 2, 3]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'top\na\nb\nmid\nc\nbottom\n');
});

test('MoveCode / CopyCode：同文件剪切、跨文件剪切 + 整批回退、复制对齐缩进、歧义候选', async () => {
    const pid = await newProject('xfer');
    const root = path.join(wsRoot, 'xfer');
    const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

    // 同文件：行号均以原文为准
    await call({ command: 'CreateFile', projectId: pid, path: 'l.txt', content: 'a\nb\nc\nd\ne\n', reason: 'fixture' });
    const same = await call({ command: 'MoveCode', projectId: pid, from: 'l.txt:2-3', after: '4', reason: '调整顺序' });
    assert.equal(same.details.status, 'ok', textOf(same));
    assert.equal(read('l.txt'), 'a\nd\nb\nc\ne\n');
    await assert.rejects(call({ command: 'MoveCode', projectId: pid, from: 'l.txt:2-4', after: '3', reason: 'x' }), /源块|source block/);

    // 跨文件剪切：目标不存在时新建，两文件同批次，Rollback 整体撤销
    const lib = 'const k = 1;\nfunction helper(v) {\n  if (v) {\n    return v;\n  }\n  return k;\n}\nmodule.exports = { k };\n';
    await call({ command: 'CreateFile', projectId: pid, path: 'lib.js', content: lib, reason: 'fixture' });
    const transferArgs = {
        command: 'MoveCode', projectId: pid, from: 'lib.js', to: 'util/helper.js',
        target: '2 | function helper(v) {\n...\n7 | }', reason: '抽出 helper',
    };
    const preview = await call(transferArgs);
    assert.equal(preview.details.status, 'ambiguous');
    assert.equal(read('lib.js'), lib, '省略候选未选择前不能写源文件');
    assert.equal(fs.existsSync(path.join(root, 'util/helper.js')), false);
    const cut = await call({ ...transferArgs, pick: '1' });
    assert.equal(cut.details.status, 'ok', textOf(cut));
    assert.equal(read('lib.js'), 'const k = 1;\nmodule.exports = { k };\n');
    assert.equal(read('util/helper.js'), 'function helper(v) {\n  if (v) {\n    return v;\n  }\n  return k;\n}\n');
    assert.equal(cut.details.nodeIds.length, 2);
    const rb = await call({ command: 'Rollback', projectId: pid, batch: `b${cut.details.batchId}` });
    assert.equal(rb.details.status, 'ok', textOf(rb));
    assert.equal(read('lib.js'), lib);
    assert.equal(fs.existsSync(path.join(root, 'util/helper.js')), false);

    // 复制：源不变，缩进自动对齐到目标位置
    await call({ command: 'CreateFile', projectId: pid, path: 'cls.js', content: 'class A {\n  m() {}\n}\n', reason: 'fixture' });
    const copy = await call({ command: 'CopyCode', projectId: pid, from: 'lib.js', lines: '2-7', to: 'cls.js', after: '2', reason: '复制' });
    assert.equal(copy.details.status, 'ok', textOf(copy));
    assert.equal(read('lib.js'), lib);
    assert.equal(read('cls.js'), 'class A {\n  m() {}\n  function helper(v) {\n    if (v) {\n      return v;\n    }\n    return k;\n  }\n}\n');
    assert.match(textOf(copy), /缩进已调整/);

    // 源 target 多处命中：返回候选，pick 后执行
    await call({ command: 'CreateFile', projectId: pid, path: 'dup.txt', content: 'x\n1\nx\n2\n', reason: 'fixture' });
    const amb = await call({ command: 'CopyCode', projectId: pid, from: 'dup.txt', target: 'x', after: 'end', reason: '复制 x' });
    assert.equal(amb.details.status, 'ambiguous');
    const picked = await call({ command: 'CopyCode', projectId: pid, from: 'dup.txt', target: 'x', pick: '2', before: '1', reason: '复制 x' });
    assert.equal(picked.details.status, 'ok', textOf(picked));
    assert.equal(read('dup.txt'), 'x\nx\n1\nx\n2\n');
});

test('工程查询：默认最新 10 个、自定义数量、工作区搜索与 GUI 完整列表', async () => {
    const originalList = workspaceService.list;
    const otherRoot = path.join(tmp, 'other-ws');
    fs.mkdirSync(otherRoot, { recursive: true });
    workspaceService.list = () => [
        { id: 'ws1', alias: 'demo', path: wsRoot, enabled: true },
        { id: 'ws2', alias: 'other', path: otherRoot, enabled: true },
    ];
    const ids = [];
    try {
        // 13 个查询工程在服务关闭时直插 SQL 生成，固定 updated_at 避免毫秒排序漂移。
        await withOfflineSql(db => {
            const insert = db.prepare(`INSERT INTO projects(id, name, workspace_id, workspace_alias, root, subpath, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
            const createdAt = '2090-01-01T00:00:00.000Z';
            for (let i = 0; i < 12; i++) {
                const id = `pquery${String(i).padStart(2, '0')}`;
                ids.push(id);
                insert.run(id, `查询回归-${i}`, 'ws1', 'demo', wsRoot, `query-${i}`,
                    createdAt, new Date(Date.UTC(2090, 0, i + 1)).toISOString());
            }
            const otherId = 'pqueryother';
            ids.push(otherId);
            insert.run(otherId, '查询回归-其他工作区', 'ws2', 'other', otherRoot, 'query-other',
                createdAt, new Date(Date.UTC(2089, 11, 31)).toISOString());
        });
        const expected = ids.slice(0, 12).reverse();

        const listed = await call({ command: 'ListProjects', workspace: 'demo' });
        assert.equal(listed.details.limit, 10);
        assert.deepEqual(listed.details.projects.map(p => p.id), expected.slice(0, 10));
        const global = await call({ command: 'ListProjects' });
        assert.deepEqual(global.details.projects.map(p => p.id), expected.slice(0, 10));
        const expanded = await call({ command: 'ListProjects', query: '查询回归', limit: '20' });
        assert.equal(expanded.details.count, 13);
        assert.equal((await forge.gui.listProjects({ query: '查询回归' })).length, 13);

        const searched = await call({ command: 'SearchProjects', workspace: 'ws1', query: '查询回归' });
        assert.equal(searched.details.command, 'SearchProjects');
        assert.deepEqual(searched.details.projects.map(p => p.id), expected.slice(0, 10));
        const limited = await call({ command: 'SearchProjects', workspace: 'DEMO', keyword: '查询回归', limit: 3 });
        assert.deepEqual(limited.details.projects.map(p => p.id), expected.slice(0, 3));
        const byId = await call({ command: 'SearchProjects', workspace: 'demo', query: expected[0] });
        assert.deepEqual(byId.details.projects.map(p => p.id), [expected[0]]);
        const empty = await call({ command: 'SearchProjects', workspace: 'other', query: expected[0] });
        assert.equal(empty.details.count, 0);

        // 工作区别名变更后仍按稳定 ID 查到工程，停用工作区也可只读搜索。
        workspaceService.list = () => [
            { id: 'ws1', alias: 'renamed', path: wsRoot, enabled: false },
            { id: 'ws2', alias: 'other', path: otherRoot, enabled: true },
        ];
        const renamed = await call({ command: 'SearchProjects', workspace: 'renamed', query: '查询回归' });
        assert.deepEqual(renamed.details.projects.map(p => p.id), expected.slice(0, 10));

        await call({ command: 'DeleteProjects', projectIds: expected[0] });
        const active = await call({ command: 'SearchProjects', workspace: 'renamed', query: '查询回归' });
        assert.deepEqual(active.details.projects.map(p => p.id), expected.slice(1, 11));
        const deleted = await call({ command: 'SearchProjects', workspace: 'renamed', query: expected[0], includeDeleted: true });
        assert.equal(deleted.details.count, 1);

        for (const limit of [0, -1, 1.5, 'abc', '10abc']) {
            await assert.rejects(call({ command: 'ListProjects', limit }), /limit 必须是正整数/);
        }
        for (const workspace of [undefined, 'all', 'missing']) {
            await assert.rejects(call({ command: 'SearchProjects', workspace, query: '查询回归' }), /workspace|不存在/);
        }
        await assert.rejects(call({ command: 'SearchProjects', workspace: 'other' }), /需要 query/);
    } finally {
        workspaceService.list = originalList;
        if (ids.length) {
            await call({ command: 'DeleteProjects', projectIds: ids });
            await call({ command: 'PurgeProjects', projectIds: ids, confirm: true });
        }
    }
});
test('GUI手动验收：保留报告与作者、留痕通知、重复幂等及非法状态拒绝', async () => {
    const pid = await newProject('manual-accept');
    await assert.rejects(forge.gui.acceptProject(pid, '莱恩'), /只有待验收/);
    await assert.rejects(forge.gui.acceptProject('missing'), /不存在/);
    await call({ command: 'SubmitReport', projectId: pid, conclusion: '原施工报告', maid: 'Kerr' });
    const before = await forge.gui.getProject(pid);
    const events = [];
    const listener = e => events.push(e);
    forge.events.on('changed', listener);
    try {
        assert.deepEqual(await forge.gui.acceptProject(pid, '莱恩'), { accepted: true, projectId: pid });
        const after = await forge.gui.getProject(pid);
        assert.equal(after.project.status, 'accepted');
        assert.ok(after.project.report.startsWith(before.project.report));
        assert.match(after.project.report, /已由用户手动验收该工程/);
        assert.match(after.project.report, /署名：莱恩 · 时间：\d{4}-/);
        assert.equal(after.project.report_by, before.project.report_by);
        assert.deepEqual(after.todos, before.todos);
        assert.equal(after.project.updated_at, before.project.updated_at, '验收不应刷新 updated_at，否则列表重排');
        assert.equal(events.length, 1);
        assert.equal(events[0].action, 'gui:accept');
        await forge.gui.acceptProject(pid, '另一个署名');
        assert.equal((await forge.gui.getProject(pid)).project.report, after.project.report);
        assert.equal(events.length, 1);
        await forge.gui.deleteProject(pid, '莱恩');
        await assert.rejects(forge.gui.acceptProject(pid), /已删除/);
    } finally {
        forge.events.off('changed', listener);
    }
    const blank = await newProject('manual-accept-blank');
    await call({ command: 'SubmitReport', projectId: blank, conclusion: '待验收' });
    await forge.gui.acceptProject(blank);
    assert.match((await forge.gui.getProject(blank)).project.report, /署名：用户/);
});

test('脉络首屏100批、游标渐进与报告完整性相互独立', async () => {
    const pid = await newProject('full-report');
    const ids = [];
    // 205 批历史在服务关闭时直插 SQL 生成，避免跨 RPC 事务和双写权威。
    await withOfflineSql(db => {
        const insertBatch = db.prepare('INSERT INTO batches(project_id, kind, reason, maid, created_at) VALUES (?, ?, ?, ?, ?)');
        const insertNode = db.prepare(`INSERT INTO nodes(project_id, batch_id, file_path, op, summary, added, removed, created_at)
            VALUES (?, ?, ?, 'edit', ?, 1, 0, ?)`);
        db.transaction(() => {
            for (let i = 0; i < 205; i++) {
                const ts = new Date(Date.UTC(2080, 0, 1, 0, 0, i % 60)).toISOString();
                const batchId = Number(insertBatch.run(pid, i ? 'edit' : 'external', `原因${i}`, i ? 'Kerr' : null, ts).lastInsertRowid);
                ids.push(batchId);
                insertNode.run(pid, batchId, `file-${i}.js`, `节点${i}`, ts);
            }
        })();
    });
    const detail = await forge.gui.getProject(pid);
    assert.equal(detail.timeline.length, 100);
    assert.equal(detail.timelineHasMore, true);
    const s = forge._test.getRuntime().store;
    await s.recordBatch({
        projectId: pid,
        kind: 'edit',
        reason: '分页期间新增',
        maid: 'Nova',
        nodes: [{ filePath: 'new.js', op: 'create', summary: '分页期间新增节点' }],
    });
    const second = await forge.gui.getTimeline(pid, { beforeBatch: detail.timelineBeforeBatch });
    assert.equal(second.timeline.length, 100);
    const third = await forge.gui.getTimeline(pid, { beforeBatch: second.timelineBeforeBatch });
    assert.equal(third.timeline.length, 5);
    assert.equal(third.timelineHasMore, false);
    assert.deepEqual([...detail.timeline, ...second.timeline, ...third.timeline].map(b => b.id), [...ids].reverse());
    await assert.rejects(forge.gui.getTimeline(pid, { beforeBatch: 'bad' }), /游标/);
    const result = await call({ command: 'SubmitReport', projectId: pid, conclusion: '完整报告', maid: 'Kerr' });
    const stored = (await forge.gui.getProject(pid)).project;
    assert.match(stored.report, /file-0\.js/);
    assert.match(stored.report, /file-204\.js/);
    assert.equal((stored.report.match(/^- b\d+ ·/gm) || []).length, 206);
    assert.match(textOf(result), /分页期间新增/);
    const exported = await forge.gui.exportReport(pid);
    assert.equal((exported.markdown.match(/^### b/gm) || []).length, 206);
    assert.match(exported.markdown, /file-0\.js/);
    assert.match(exported.markdown, /外部改动（未署名）/);
    assert.equal((await forge.gui.getProject(pid)).project.updated_at, stored.updated_at);
    assert.equal((await forge.gui.getProject(pid)).project.status, 'review');
    await assert.rejects(forge.gui.exportReport('missing'), /不存在/);
    await forge.gui.deleteProject(pid, '莱恩');
    assert.match((await forge.gui.exportReport(pid)).markdown, /删除时间/);
});