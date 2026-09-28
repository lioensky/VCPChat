'use strict';
// ProjectForge 集成测试：临时目录 + 注入的工作区门面与回收站，不触碰真实设置与系统回收站。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const engine = require('../VCPDistributedServer/Plugin/ProjectForge/engine');
const { isPathInside } = require('../VCPDistributedServer/shared/fileKit/paths');

let tmp;
let wsRoot;
let trashDir;

function textOf(result) {
    return result.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

const call = args => forge.processToolCall(args);

test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
    wsRoot = path.join(tmp, 'ws');
    trashDir = path.join(tmp, 'trash');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.mkdirSync(trashDir, { recursive: true });
    forge.initialize({
        dbPath: path.join(tmp, 'db', 'pf.db'),
        services: {
            workspaceService: {
                list: () => [{ id: 'ws1', alias: 'demo', path: wsRoot, enabled: true, status: 'ready' }],
                getActiveWorkspaceId: () => 'ws1',
            },
        },
        trash: async abs => fs.renameSync(abs, path.join(trashDir, `${Date.now()}-${path.basename(abs)}`)),
        logger: { log() {}, warn() {}, error() {} },
    });
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

test('引擎：串内行号以原始快照为准，重叠报错', () => {
    const src = 'a\nb\nc\nd\n';
    const ok = engine.runEditString(src, [
        { step: 1, op: 'replace', start: 1, end: 1, content: 'A\nA2' },
        { step: 2, op: 'replace', start: 3, end: 3, content: 'C' },
    ]);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.text, 'A\nA2\nb\nC\nd\n');
    const bad = engine.runEditString(src, [
        { step: 1, op: 'replace', start: 1, end: 2, content: 'x' },
        { step: 2, op: 'delete', start: 2, end: 3 },
    ]);
    assert.equal(bad.status, 'error');
    assert.match(bad.errors[0].message, /重叠/);
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

    // RemoveFile 走回收站，Rollback 可恢复
    const removed = await call({ command: 'RemoveFile', projectId: pid, path: 'src/a.js', reason: '不再需要' });
    assert.equal(removed.details.removed, 1);
    assert.equal(fs.existsSync(path.join(root, 'src/a.js')), false);
    assert.equal(fs.readdirSync(trashDir).length, 1);
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

test('store：旧库自动补列迁移', () => {
    const Database = require('better-sqlite3');
    const { ProjectStore } = require('../VCPDistributedServer/Plugin/ProjectForge/store');
    const dbPath = path.join(tmp, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT, workspace_alias TEXT,
        root TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', report TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
        CREATE TABLE batches (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL);`);
    legacy.close();
    const s = new ProjectStore(dbPath);
    const cols = t => s.db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    assert.ok(cols('batches').includes('maid') && cols('batches').includes('reason'));
    assert.ok(cols('projects').includes('created_by') && cols('projects').includes('subpath'));
    const p = s.createProject({ name: 'x', root: tmp, createdBy: 'Nova' });
    const b = s.createBatch(p.id, 'edit', 'r', 'Nova');
    assert.equal(s.getBatch(p.id, b).maid, 'Nova');
    s.close();
});
test('GUI 门面：只读浏览 + 署名单文件回退（预检 / 冲突 / force / 再回退）', async () => {
    const r = await call({ command: 'CreateProject', name: 'gui', dir: 'gui', maid: 'Nova', todos: '界面' });
    const pid = r.details.project.id;
    const file = path.join(wsRoot, 'gui', 'g.js');
    await call({ command: 'CreateFile', projectId: pid, path: 'g.js', content: 'v1\n', reason: '初始化', maid: 'Nova' });
    const edit = await call({ command: 'EditCode', projectId: pid, path: 'g.js', reason: '升级到 v2', start: '1', end: '1', content: 'v2', maid: 'Aemeath' });
    const editNode = edit.details.nodeId;

    // 只读浏览
    const list = forge.gui.listProjects();
    const summary = list.find(p => p.id === pid);
    assert.ok(summary && summary.progress.total === 1 && summary.report === undefined);
    const detail = forge.gui.getProject(pid);
    assert.equal(detail.timeline.length, 2);
    assert.ok(Array.isArray(detail.timeline[0].files));
    assert.deepEqual(detail.contributors.map(c => c.maid).sort(), ['Aemeath', 'Nova']);
    assert.equal(forge.gui.searchHistory({ projectId: pid, byMaid: 'aemeath' }).length, 1);
    assert.equal(forge.gui.searchHistory({ projectId: pid, file: 'g.js' }).length, 2);
    const node = forge.gui.getNodeDetail(pid, editNode);
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
    const batch = forge.gui.getBatchNodes(pid, ok.batchId);
    assert.equal(batch.batch.maid, '主人');
    assert.equal(batch.batch.reason, '人工撤销');
    const redo = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, mode: 'after', signature: '主人' });
    assert.equal(redo.status, 'conflict'); // 此后该文件还有改动（回退节点）
    const redoForced = await forge.gui.revertFileChange({ projectId: pid, nodeId: editNode, mode: 'after', signature: '主人', force: true });
    assert.equal(redoForced.status, 'ok');
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2\n');
    assert.ok(forge.gui.getProject(pid).contributors.some(c => c.maid === '主人'));
});

test('引擎：首尾锚定 target（带行号 / 按内容配对缩进 / 字面优先）', () => {
    const src = 'function a() {\n  if (x) {\n    y();\n  }\n  return 1;\n}\nfunction b() {}\n';

    // 不带行号：尾行优先配对与首行同缩进的 `}`，而不是内层的 `  }`
    const byContent = engine.runEditString(src, [{ step: 1, op: 'target', target: 'function a() {\n...\n}', replace: 'function a() {}' }]);
    assert.equal(byContent.status, 'ok', JSON.stringify(byContent.errors));
    assert.equal(byContent.text, 'function a() {}\nfunction b() {}\n');
    assert.match(byContent.applied[0].note, /首尾锚定命中 L1-6/);

    // 带 ReadCode 行号前缀：按行号定位，尾行可指定内层
    const byLine = engine.runEditString(src, [{ step: 1, op: 'target', target: '1 | function a() {\n...\n4 |   }', replace: 'function a() {' }]);
    assert.equal(byLine.status, 'ok', JSON.stringify(byLine.errors));
    assert.equal(byLine.text, 'function a() {\n  return 1;\n}\nfunction b() {}\n');

    // 行号有偏差时 ±drift 校正；内容对不上则报错并给出建议
    const drifted = engine.runEditString(src, [{ step: 1, op: 'target', target: '3 | function a() {\n…\n8 | }', replace: '' }]);
    assert.equal(drifted.status, 'ok', JSON.stringify(drifted.errors));
    assert.equal(drifted.text, 'function b() {}\n');
    const missing = engine.runEditString(src, [{ step: 1, op: 'target', target: 'function zzz() {\n...\n}', replace: '' }]);
    assert.equal(missing.status, 'error');
    assert.match(missing.errors[0].message, /首行/);

    // 字面能匹配时不启用首尾语法（Python 的 ... 占位）
    const py = 'def f():\n    ...\n\ndef g():\n    pass\n';
    const lit = engine.runEditString(py, [{ step: 1, op: 'target', target: 'def f():\n    ...', replace: 'def f():\n    return 1' }]);
    assert.equal(lit.text, 'def f():\n    return 1\n\ndef g():\n    pass\n');

    // 多处命中照常返回歧义
    const twice = 'if (a) {\n  x();\n}\nif (b) {\n  x();\n}\n';
    const amb = engine.runEditString(twice, [{ step: 1, op: 'target', target: '  x();\n...\n}', replace: '' }]);
    assert.equal(amb.status, 'ambiguous');
    assert.equal(amb.ambiguities[0].total, 2);
});

test('引擎：insert before=N / after=end', () => {
    const src = 'a\nb\nc\n';
    const r = engine.runEditString(src, [
        { step: 1, op: 'insert', before: 1, content: 'top' },
        { step: 2, op: 'insert', before: 3, content: 'mid' },
        { step: 3, op: 'insert', after: 'end', content: 'bottom' },
    ]);
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.equal(r.text, 'top\na\nb\nmid\nc\nbottom\n');
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
    await assert.rejects(call({ command: 'MoveCode', projectId: pid, from: 'l.txt:2-4', after: '3', reason: 'x' }), /源块/);

    // 跨文件剪切：目标不存在时新建，两文件同批次，Rollback 整体撤销
    const lib = 'const k = 1;\nfunction helper(v) {\n  if (v) {\n    return v;\n  }\n  return k;\n}\nmodule.exports = { k };\n';
    await call({ command: 'CreateFile', projectId: pid, path: 'lib.js', content: lib, reason: 'fixture' });
    const cut = await call({
        command: 'MoveCode', projectId: pid, from: 'lib.js', to: 'util/helper.js',
        target: '2 | function helper(v) {\n...\n7 | }', reason: '抽出 helper',
    });
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