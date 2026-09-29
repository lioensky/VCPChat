'use strict';
// ProjectForge AST 符号寻址集成测试（蓝图 3.8）：
// 1. 有二进制：Outline / FindSymbol / ReadCode symbol= / EditCode symbol=（替换、删除、歧义票据）/ MoveCode 跨文件 + 整批回退 / BOM+CRLF
// 2. 降级：二进制缺失时新命令给出明确提示，旧命令不受影响
// 3. 崩溃恢复：假索引器立即退出 → 退避 → 熔断；协议不匹配 → 直接熔断
// 没有构建产物时（CI 未编译 Rust），第 1 组 skip 并说明原因。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const engine = require('../VCPDistributedServer/Plugin/ProjectForge/engine');
const SR = require('../VCPDistributedServer/Plugin/ProjectForge/symbolResolver');
const { IndexerClient, resolveDefaultBinaryPath } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');

const HAS_BIN = fs.existsSync(resolveDefaultBinaryPath());
const SKIP_BIN = HAS_BIN ? false : '未找到索引器二进制（npm run build:pf-indexer 构建后再跑）';
const quiet = { log() {}, warn() {}, error() {} };

let tmp;
let wsRoot;

const call = args => forge.processToolCall(args);
const textOf = r => r.content.filter(p => p.type === 'text').map(p => p.text).join('\n');

function init(extra = {}) {
    forge.initialize({
        dbPath: path.join(tmp, 'db', 'pf.db'),
        services: {
            workspaceService: {
                list: () => [{ id: 'ws1', alias: 'demo', path: wsRoot, enabled: true, status: 'ready' }],
                getActiveWorkspaceId: () => 'ws1',
            },
        },
        trash: async abs => fs.rmSync(abs, { force: true }),
        logger: quiet,
        ...extra,
    });
}

const FIXTURE = [
    "'use strict';",                          // 1
    'const gui = {',                          // 2
    '    /**',                                // 3
    '     * 回退单个文件',                    // 4
    '     */',                                // 5
    '    async revertFileChange(x) {',        // 6
    '        return x;',                      // 7
    '    },',                                 // 8
    '    listProjects() {',                   // 9
    '        return [];',                     // 10
    '    },',                                 // 11
    '};',                                     // 12
    '',                                       // 13
    '/** 计算 */',                            // 14
    'function calc(a) {',                     // 15
    '    return a + 1;',                      // 16
    '}',                                      // 17
    '',                                       // 18
    'class Box {',                            // 19
    '    dup() { return 1; }',                // 20
    '}',                                      // 21
    '',                                       // 22
    'class Crate {',                          // 23
    '    dup() { return 2; }',                // 24
    '}',                                      // 25
    '',                                       // 26
    'module.exports = { gui, calc, Box, Crate };', // 27
    '',
].join('\n');

test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ast-test-'));
    wsRoot = path.join(tmp, 'ws');
    fs.mkdirSync(wsRoot, { recursive: true });
    init();
});

test.after(async () => {
    await forge.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
});

async function newProject(name) {
    const r = await call({ command: 'CreateProject', name, dir: name });
    const pid = r.details.project.id;
    await call({ command: 'CreateFile', projectId: pid, path: 'src/a.js', content: FIXTURE, reason: 'fixture' });
    return { pid, root: path.join(wsRoot, name) };
}

// ---------------- 纯函数 ----------------

test('symbolResolver：地址语法、打分、歧义、区间', () => {
    assert.deepEqual(SR.splitPathSymbol('src/a.js#Store.putBlob'), { path: 'src/a.js', symbol: 'Store.putBlob' });
    assert.deepEqual(SR.splitPathSymbol('docs/#1-note.md'), { path: 'docs/#1-note.md', symbol: null });
    assert.equal(SR.normalizeRef('Store::put_blob()'), 'Store.put_blob');

    const outline = { symbols: [
        { name: 'Box', qualified: 'Box', kind: 'class', fullStart: 1, start: 1, end: 3, depth: 0 },
        { name: 'dup', qualified: 'Box.dup', kind: 'method', fullStart: 2, start: 2, end: 2, depth: 1, parent: 0 },
        { name: 'Crate', qualified: 'Crate', kind: 'class', fullStart: 4, start: 4, end: 6, depth: 0 },
        { name: 'dup', qualified: 'Crate.dup', kind: 'method', fullStart: 5, start: 5, end: 5, depth: 1, parent: 2 },
    ] };
    assert.equal(SR.resolveInOutline(outline, 'Crate::dup').symbol.start, 5);
    const amb = SR.resolveInOutline(outline, 'dup');
    assert.equal(amb.status, 'ambiguous');
    assert.equal(amb.total, 2);
    assert.equal(SR.resolveInOutline(outline, 'dup', { pick: 2 }).symbol.qualified, 'Crate.dup');
    assert.equal(SR.resolveInOutline(outline, 'dup', { line: 5 }).symbol.qualified, 'Crate.dup');
    assert.throws(() => SR.resolveInOutline(outline, 'dup', { pick: 3 }), /pick/);
    const miss = SR.resolveInOutline(outline, 'dupp');
    assert.equal(miss.status, 'notFound');
    assert.ok(miss.suggestions.length >= 1);

    const sym = { fullStart: 3, start: 6, end: 8 };
    assert.deepEqual(SR.symbolRange(sym), { startLine: 3, endLine: 8, mode: 'full' });
    assert.deepEqual(SR.symbolRange(sym, { range: 'body', context: 1, lineCount: 8 }), { startLine: 5, endLine: 8, mode: 'body' });

    // engine.enclosingScope：有 symbols 用 AST（能识别单行方法），没有则退回正则（只认出外层类）
    const idx = engine.buildIndex('class Box {\n  dup() { return 1; }\n}\n');
    assert.equal(engine.enclosingScope(idx, 2, outline.symbols), 'Box > dup');
    assert.equal(engine.enclosingScope(idx, 2), 'Box');
    assert.equal(engine.enclosingScope(idx, 2, []), 'Box', '空符号表退回正则');
});

// ---------------- 有二进制 ----------------

test('Outline / FindSymbol / ReadCode symbol=', { skip: SKIP_BIN }, async () => {
    const { pid } = await newProject('read');

    const o = await call({ command: 'Outline', projectId: pid, path: 'src/a.js' });
    const ot = textOf(o);
    assert.match(ot, /L6-8（注释自 L3） · method · `revertFileChange`/);
    assert.match(ot, /L15-17（注释自 L14） · function · `calc`/);
    const rev = o.details.files[0].symbols.find(s => s.name === 'revertFileChange');
    assert.equal(rev.qualified, 'gui.revertFileChange');

    const f = await call({ command: 'FindSymbol', projectId: pid, name: 'revertFileChange' });
    assert.equal(f.details.total, 1);
    assert.deepEqual(
        { path: f.details.hits[0].path, q: f.details.hits[0].qualified, s: f.details.hits[0].fullStart, e: f.details.hits[0].end },
        { path: 'src/a.js', q: 'gui.revertFileChange', s: 3, e: 8 },
    );

    const full = textOf(await call({ command: 'ReadCode', projectId: pid, path: 'src/a.js#gui.revertFileChange' }));
    // `N | ` 分隔符自带一个空格，其后是 4 空格缩进
    assert.match(full, /3 \| {5}\/\*\*/);
    assert.match(full, /8 \| {5}\},/);
    assert.match(full, /行范围：3-8\//);
    assert.doesNotMatch(full, /9 \| /);

    const body = textOf(await call({ command: 'ReadCode', projectId: pid, path: 'src/a.js', symbol: 'revertFileChange', range: 'body' }));
    assert.match(body, /6 \| {5}async revertFileChange/);
    assert.doesNotMatch(body, /回退单个文件/);

    const amb = textOf(await call({ command: 'ReadCode', projectId: pid, path: 'src/a.js#dup' }));
    assert.match(amb, /2 处同名定义/);
    const miss = textOf(await call({ command: 'ReadCode', projectId: pid, path: 'src/a.js#revertFileChang' }));
    assert.match(miss, /未找到符号[\s\S]*gui\.revertFileChange/);
});

test('EditCode symbol=：替换 / 删除连带 JSDoc，同名歧义走票据', { skip: SKIP_BIN }, async () => {
    const { pid, root } = await newProject('edit');
    const read = () => fs.readFileSync(path.join(root, 'src/a.js'), 'utf8');

    const rep = await call({
        command: 'EditCode', projectId: pid, path: 'src/a.js#gui.revertFileChange', reason: '改实现',
        content: '    async revertFileChange(x) {\n        return x * 2;\n    },',
    });
    assert.equal(rep.details.status, 'ok', textOf(rep));
    assert.doesNotMatch(read(), /回退单个文件/, '前置 JSDoc 应一并替换');
    assert.match(read(), /const gui = \{\n {4}async revertFileChange\(x\) \{\n {8}return x \* 2;\n {4}\},\n {4}listProjects/);

    const del = await call({ command: 'EditCode', projectId: pid, path: 'src/a.js', reason: '删除 calc', op: 'delete', symbol: 'calc' });
    assert.equal(del.details.status, 'ok', textOf(del));
    assert.doesNotMatch(read(), /计算|function calc/);

    const amb = await call({ command: 'EditCode', projectId: pid, path: 'src/a.js', reason: '改 dup', symbol: 'dup', content: '    dup() { return 20; }' });
    assert.equal(amb.details.status, 'ambiguous', textOf(amb));
    assert.match(textOf(amb), /符号 `dup` 有 2 处同名定义/);
    const ok = await call({ command: 'ResolveEdit', ticketId: amb.details.ticketId, pick: '2' });
    assert.equal(ok.details.status, 'ok', textOf(ok));
    assert.match(read(), /class Box \{\n {4}dup\(\) \{ return 1; \}/);
    assert.match(read(), /class Crate \{\n {4}dup\(\) \{ return 20; \}/);

    // 串语法：符号步骤与行号步骤共用原始快照
    const before = read();
    const lines = before.split('\n');
    const boxLine = lines.indexOf('class Box {') + 1;
    const multi = await call({
        command: 'EditCode', projectId: pid, path: 'src/a.js', reason: '串',
        symbol1: 'Box.dup', content1: '    dup() { return 10; }',
        op2: 'replace', start2: String(boxLine), end2: String(boxLine), content2: 'class Box { // box',
    });
    assert.equal(multi.details.status, 'ok', textOf(multi));
    assert.match(read(), /class Box \{ \/\/ box\n {4}dup\(\) \{ return 10; \}/);

    const nf = await call({ command: 'EditCode', projectId: pid, path: 'src/a.js', reason: 'x', symbol: 'nope', content: 'x' });
    assert.equal(nf.details.status, 'error');
    assert.match(textOf(nf), /未找到符号 `nope`/);
});

test('MoveCode symbol= 跨文件 + 整批回退；after=symbol: 落点', { skip: SKIP_BIN }, async () => {
    const { pid, root } = await newProject('move');
    const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
    await call({ command: 'CreateFile', projectId: pid, path: 'src/b.js', content: "'use strict';\n", reason: 'fixture' });

    const mv = await call({ command: 'MoveCode', projectId: pid, from: 'src/a.js#calc', to: 'src/b.js', after: 'end', reason: '搬 calc' });
    assert.equal(mv.details.status, 'ok', textOf(mv));
    assert.match(read('src/b.js'), /\/\*\* 计算 \*\/\nfunction calc\(a\) \{/);
    assert.doesNotMatch(read('src/a.js'), /calc\(a\)/);
    const rb = await call({ command: 'Rollback', projectId: pid, batch: `b${mv.details.batchId}` });
    assert.equal(rb.details.status, 'ok', textOf(rb));
    assert.equal(read('src/a.js'), FIXTURE);
    assert.equal(read('src/b.js'), "'use strict';\n");

    const cp = await call({ command: 'CopyCode', projectId: pid, from: 'src/a.js', symbol: 'calc', after: 'symbol:Crate', reason: '复制到末尾类之后' });
    assert.equal(cp.details.status, 'ok', textOf(cp));
    const t = read('src/a.js');
    assert.ok(t.indexOf('class Crate') < t.lastIndexOf('function calc'), '副本应落在 Crate 之后');
    assert.equal((t.match(/function calc/g) || []).length, 2);
});

test('BOM + CRLF 文件按符号编辑后保持换行风格', { skip: SKIP_BIN }, async () => {
    const { pid, root } = await newProject('crlf');
    const abs = path.join(root, 'src/w.js');
    const body = '/** doc */\r\nfunction w() {\r\n    return 1;\r\n}\r\nfunction v() {}\r\n';
    fs.writeFileSync(abs, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]));
    const r = await call({ command: 'EditCode', projectId: pid, path: 'src/w.js#w', reason: 'crlf', content: 'function w() {\n    return 2;\n}' });
    assert.equal(r.details.status, 'ok', textOf(r));
    const buf = fs.readFileSync(abs);
    assert.deepEqual([...buf.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    const text = buf.subarray(3).toString('utf8');
    assert.equal(text, 'function w() {\r\n    return 2;\r\n}\r\nfunction v() {}\r\n');
});

// ---------------- 降级 ----------------

test('降级：二进制缺失时新命令给提示，旧命令照常', async () => {
    await forge.cleanup();
    init({ indexerBinaryPath: path.join(tmp, 'missing', 'projectforge_indexer.exe') });
    try {
        const { pid, root } = await newProject('degrade');
        const o = textOf(await call({ command: 'Outline', projectId: pid, path: 'src/a.js' }));
        assert.match(o, /AST 索引器不可用.*lines \/ target/);
        await assert.rejects(call({ command: 'FindSymbol', projectId: pid, name: 'calc' }), /需要 AST 索引器/);
        const rc = await call({ command: 'ReadCode', projectId: pid, path: 'src/a.js#calc' });
        assert.match(textOf(rc), /AST 索引器不可用/);
        const ec = await call({ command: 'EditCode', projectId: pid, path: 'src/a.js', reason: 'x', symbol: 'calc', content: 'x' });
        assert.equal(ec.details.status, 'error');
        assert.match(textOf(ec), /AST 索引器不可用/);

        // 旧路径不受影响；find 的 scope 退回正则
        const ok = await call({ command: 'EditCode', projectId: pid, path: 'src/a.js', reason: '行号编辑', start: '16', end: '16', expect: '    return a + 1;', content: '    return a + 2;' });
        assert.equal(ok.details.status, 'ok', textOf(ok));
        assert.match(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), /return a \+ 2;/);
        const found = await call({ command: 'ReadCode', projectId: pid, path: 'src/a.js', find: 'return a + 2;' });
        assert.match(textOf(found), /in calc/);
    } finally {
        await forge.cleanup();
        init();
    }
});

// ---------------- 崩溃恢复 ----------------

async function withFakeIndexer(script, fn) {
    const file = path.join(tmp, `fake-${Date.now()}-${Math.random().toString(16).slice(2)}.js`);
    fs.writeFileSync(file, script);
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require "${file.replace(/\\/g, '/')}"`;
    const client = new IndexerClient({ binaryPath: process.execPath, logger: quiet });
    try {
        await fn(client);
    } finally {
        if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved;
        await client.stop();
    }
}

test('崩溃恢复：立即退出 → 退避降级 → 连续失败熔断', async () => {
    await withFakeIndexer('process.exit(3);\n', async client => {
        assert.equal(await client.outline('const a = 1;', 'a.js'), null);
        assert.equal(client.status().restarts, 1);
        assert.equal(client.usable, true, '首次失败只退避，不熔断');
        assert.equal(await client.outline('const b = 1;', 'a.js'), null, '退避期内直接降级');
        assert.equal(client.status().restarts, 1, '退避期内不重启');
        for (let i = 0; i < 6 && client.usable; i++) {
            client.nextStartAt = 0; // 跳过退避等待
            assert.equal(await client.outline(`const c${i} = 1;`, 'a.js'), null);
        }
        assert.equal(client.usable, false);
        assert.match(client.status().circuit, /连续失败/);
    });
});

test('崩溃恢复：协议版本不匹配直接熔断', async () => {
    const script = "process.stdout.write(JSON.stringify({ type: 'ready', protocolVersion: 99, languages: [] }) + '\\n');\nsetInterval(() => {}, 1000);\n";
    await withFakeIndexer(script, async client => {
        assert.equal(await client.outline('const a = 1;', 'a.js'), null);
        assert.equal(client.usable, false);
        assert.match(client.status().circuit, /协议版本不匹配/);
        assert.equal(client.status().running, false);
    });
});