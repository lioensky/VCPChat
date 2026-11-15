'use strict';
// ProjectForge 健壮性回归测试（原生服务路径）：
// 1) 写盘前复核 hash：真实校验 worker 期间文件被外部修改时放弃写入；
// 2) Rollback 中途失败时恢复已写入文件、且不记录回退批次；
// 3) Python 校验经原生服务异步执行，期间事件循环可以继续运行。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const { ProjectServiceClient } = require('../VCPDistributedServer/Plugin/ProjectForge/serviceClient');

const binaryPath = process.env.PF_SERVICE_BINARY || path.resolve(__dirname, '../rust_projectforge_indexer/target/debug',
    process.platform === 'win32' ? 'projectforge_indexer.exe' : 'projectforge_indexer');
const requireBinary = process.env.PF_SERVICE_REQUIRE_BINARY === '1';
if (requireBinary && !fs.existsSync(binaryPath)) throw new Error(`Required Rust binary missing: ${binaryPath}`);
const hasBinary = fs.existsSync(binaryPath);

let tmp;
let wsRoot;
let forgeOptions;

const call = args => forge.processToolCall(args);
const textOf = r => r.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
const norm = s => s.replace(/\r\n/g, '\n');

test.before(() => {
    const tempRoot = process.env.PF_TEST_TEMP || path.join(__dirname, '..', '.forge', 'test-temp');
    fs.mkdirSync(tempRoot, { recursive: true });
    tmp = fs.mkdtempSync(path.join(tempRoot, 'pf-robust-'));
    wsRoot = path.join(tmp, 'ws');
    fs.mkdirSync(wsRoot, { recursive: true });
    forgeOptions = {
        dbPath: path.join(tmp, 'db', 'pf.db'),
        services: {
            workspaceService: {
                list: () => [{ id: 'ws1', alias: 'demo', path: wsRoot, enabled: true, status: 'ready' }],
                getActiveWorkspaceId: () => 'ws1',
            },
        },
        logger: { log() {}, warn() {}, error() {} },
    };
    forge.initialize(forgeOptions);
});

test.after(async () => {
    await forge.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('EditCode：代码审查期间文件被外部修改时放弃写入，不覆盖外部内容', async () => {
    assert.ok(hasBinary, `native binary missing: ${binaryPath}`);
    const projectRoot = path.join(wsRoot, 'lf1');
    const target = path.join(projectRoot, 'm.py');
    const realWorker = path.resolve(__dirname, '../VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs');
    const baseConfig = {
        version: 1, allowedRoots: [wsRoot], nodeExecutable: process.execPath,
        validationCwd: path.resolve(__dirname, '..'), validationTimeoutMs: 10000,
    };
    const setupConfig = path.join(tmp, 'lf1-setup.json');
    fs.writeFileSync(setupConfig, JSON.stringify({ ...baseConfig, validationWorker: realWorker }));
    fs.mkdirSync(projectRoot, { recursive: true });
    const dbPath = path.join(tmp, 'native-db', 'lf1.db');
    const setup = new ProjectServiceClient({ dbPath, binaryPath, configPath: setupConfig });
    try {
        await setup.start();
        await setup.request('store.createProject', {
            operationId: 'lf1-create', projectId: 'lf1', name: 'lf1', root: projectRoot, createRoot: true,
        });
        await setup.request('file.execute', {
            operationId: 'lf1-file', projectId: 'lf1', kind: 'create', reason: 'init',
            filePath: 'm.py', content: 'x = 1\n',
        });
    } finally {
        await setup.close();
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'x = 1\n');

    // The hook runs inside the real native validation worker, after planning
    // read the snapshot but before Rust re-validates the plan against disk.
    const hookWorker = path.join(tmp, 'external-change-worker.cjs');
    fs.writeFileSync(hookWorker, `'use strict';
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(target)}, 'x = 99\\n');
const { review } = require(${JSON.stringify(realWorker)});
(async () => {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const result = await review(JSON.parse(input));
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n');
})().catch(error => {
    process.stdout.write(JSON.stringify({
        ok: false, error: { code: 'VALIDATION_FAILED', message: String(error.message) },
    }) + '\\n');
    process.exitCode = 1;
});
`);
    const hookConfig = path.join(tmp, 'lf1-hook.json');
    fs.writeFileSync(hookConfig, JSON.stringify({ ...baseConfig, validationWorker: hookWorker }));
    const client = new ProjectServiceClient({ dbPath, binaryPath, configPath: hookConfig });
    try {
        await assert.rejects(
            client.request('edit.execute', {
                operationId: 'lf1-edit', projectId: 'lf1', filePath: 'm.py', reason: 'edit',
                steps: [{ step: 1, op: 'replace', start: 1, end: 1, content: 'x = 2' }],
            }),
            /file changed during validation|target changed/,
        );
        assert.equal(fs.readFileSync(target, 'utf8'), 'x = 99\n');
        assert.equal((await client.operationStatus('lf1-edit')).state, 'unknown');
    } finally {
        await client.close();
    }
});

test('Rollback：中途写入失败时补偿回滚已写部分并释放锁，解除只读后重启重试完成回退', async () => {
    const projectId = (await call({ command: 'CreateProject', name: 'lf2', dir: 'lf2' })).details.project.id;
    const a = path.join(wsRoot, 'lf2', 'a.txt');
    const b = path.join(wsRoot, 'lf2', 'b.txt');
    await call({ command: 'CreateFile', projectId, path: 'a.txt', content: 'a1\n', reason: 'init a' });
    const cb = await call({ command: 'CreateFile', projectId, path: 'b.txt', content: 'b1\n', reason: 'init b' });
    const nb = cb.details.nodeIds?.[0] ?? cb.details.nodeId;
    assert.ok(nb, textOf(cb));
    for (const [p, c] of [['a.txt', 'a2'], ['b.txt', 'b2']]) {
        const r = await call({ command: 'EditCode', projectId, path: p, start: 1, end: 1, content: c, reason: `edit ${p}` });
        assert.equal(r.details.status, 'ok', textOf(r));
    }

    fs.chmodSync(b, 0o444); // 只读文件写入报 EPERM，模拟"被编辑器占用"
    try {
        await assert.rejects(
            call({ command: 'Rollback', projectId, toNode: `n${nb}`, reason: 'test' }),
            err => {
                assert.match(err.message, /file commit conflict: apply failed at b\.txt/);
                assert.match(err.message, /os error 5|EPERM|拒绝访问/);
                return true;
            },
        );
        // 简化 conflict 模型：多文件写中途失败后立即补偿回滚已写部分并释放资源锁，
        // 不留下半套落盘或持久挂起状态，解除外部阻塞后可直接重试。
        assert.equal(norm(fs.readFileSync(a, 'utf8')), 'a2\n', '已应用的 a.txt 必须被补偿回退到回退前快照');
        assert.equal(norm(fs.readFileSync(b, 'utf8')), 'b2\n', '失败目标保持原内容');
        const hist = await call({ command: 'SearchHistory', projectId, limit: 50 });
        assert.ok(!hist.details.nodes.some(n => n.op === 'rollback'), '失败的回退不应留下 rollback 节点');
    } finally {
        fs.chmodSync(b, 0o666);
    }

    await forge.cleanup();
    forge.initialize(forgeOptions);
    assert.equal(norm(fs.readFileSync(b, 'utf8')), 'b2\n', '重启前不应假装回退已完成');
    const reopened = await call({ command: 'GetProject', projectId });
    assert.equal(reopened.details.project.id, projectId);
    assert.equal(norm(fs.readFileSync(a, 'utf8')), 'a2\n');
    assert.equal(norm(fs.readFileSync(b, 'utf8')), 'b2\n');
    // 资源锁已立即释放，解除只读后重试同一 Rollback 应直接成功。
    const ok = await call({ command: 'Rollback', projectId, toNode: `n${nb}`, reason: 'retry' });
    assert.equal(ok.details.status, 'ok', textOf(ok));
    assert.equal(norm(fs.readFileSync(a, 'utf8')), 'a1\n');
    assert.equal(norm(fs.readFileSync(b, 'utf8')), 'b1\n');
});

test('Python 校验异步执行，期间事件循环可以继续运行', async () => {
    const projectId = (await call({ command: 'CreateProject', name: 'lf3', dir: 'lf3' })).details.project.id;
    const created = await call({ command: 'CreateFile', projectId, path: 'm.py', content: 'x = 1\n', reason: 'init' });
    assert.equal(created.details.status, 'ok', textOf(created));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    let edited;
    try {
        edited = await call({ command: 'EditCode', projectId, path: 'm.py', target: 'x = 1', content: 'x = 2', reason: 'python' });
    } finally {
        clearInterval(timer);
    }
    assert.equal(edited.details.status, 'ok', textOf(edited));
    assert.equal(norm(fs.readFileSync(path.join(wsRoot, 'lf3', 'm.py'), 'utf8')), 'x = 2\n');
    assert.ok(ticks >= 1, `校验期间事件循环被阻塞（ticks=${ticks}）`);
});

test('EditCode：replace 写成 replacement 时报错，不按删除执行', async () => {
    const projectId = (await call({ command: 'CreateProject', name: 'lf4', dir: 'lf4' })).details.project.id;
    const abs = path.join(wsRoot, 'lf4', 'a.js');
    const created = await call({ command: 'CreateFile', projectId, path: 'a.js', content: 'const a = 1;\nconst b = 2;\n', reason: 'init' });
    assert.equal(created.details.status, 'ok', textOf(created));

    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'a.js', target: 'const a = 1;', replacement: 'const a = 10;', reason: 'edit' }),
        /不认识参数 replacement.*replace/,
    );
    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'a.js', op1: 'target', target1: 'const b = 2;', Replacement1: 'const b = 20;', reason: 'edit' }),
        /replacement1.*replace1/,
    );
    assert.equal(norm(fs.readFileSync(abs, 'utf8')), 'const a = 1;\nconst b = 2;\n');

    // 真实调用：Nova 沿用 oldCode/newCode 的写法，以前只说「缺少编辑内容」，等用户批完才知道白批了
    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'a.js', oldCode: 'const b = 2;', newCode: 'const b = 2;\nconst c = 3;', reason: 'append' }),
        /不认识参数 oldCode \/ newCode.*target.*replace/i,
    );
    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'a.js', old_string: 'const b = 2;', new_string: 'x', reason: 'edit' }),
        /old_string \/ new_string/i,
    );
    assert.equal(norm(fs.readFileSync(abs, 'utf8')), 'const a = 1;\nconst b = 2;\n');

    // 显式空 replace 仍是文档里的删除写法
    const removed = await call({ command: 'EditCode', projectId, path: 'a.js', target: 'const a = 1;', replace: '', reason: 'drop a' });
    assert.equal(removed.details.status, 'ok', textOf(removed));
    assert.equal(norm(fs.readFileSync(abs, 'utf8')).trim(), 'const b = 2;');
});

test('EditCode：按行替换缺 content 时报错，不把这些行删掉', async () => {
    const projectId = (await call({ command: 'CreateProject', name: 'lf5', dir: 'lf5' })).details.project.id;
    const abs = path.join(wsRoot, 'lf5', 'a.js');
    await call({ command: 'CreateFile', projectId, path: 'a.js', content: 'l1\nl2\nl3\n', reason: 'init' });

    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'a.js', start: 2, end: 2, replace: 'X', reason: 'edit' }),
        /按行替换需要 content.*replace 只配合 target/,
    );
    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'a.js', op1: 'replace', start1: 2, end1: 2, newContent1: 'X', reason: 'edit' }),
        /content1.*op1=delete/,
    );
    assert.equal(norm(fs.readFileSync(abs, 'utf8')), 'l1\nl2\nl3\n');

    // op=delete 仍按文档删行；空 content 也照旧视为替换成空
    const removed = await call({ command: 'EditCode', projectId, path: 'a.js', op: 'delete', start: 2, end: 2, reason: 'drop' });
    assert.equal(removed.details.status, 'ok', textOf(removed));
    assert.equal(norm(fs.readFileSync(abs, 'utf8')), 'l1\nl3\n');
});
