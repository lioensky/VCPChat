'use strict';
// ProjectForge 健壮性回归测试：
// 1) 写盘前复核 hash：读取与写入之间文件被外部修改时放弃写入；
// 2) Rollback 中途失败时恢复已写入文件、且不记录回退批次；
// 3) Python 校验改为异步后不再阻塞事件循环。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在加载 ProjectForge 之前替换 execFile（validator 在加载时解构引用）。
const cp = require('child_process');
const originalExecFile = cp.execFile;
let beforePythonHook = null;
cp.execFile = function patchedExecFile(...args) {
    if (beforePythonHook) {
        const hook = beforePythonHook;
        beforePythonHook = null;
        hook();
    }
    return originalExecFile.apply(this, args);
};

const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const { validateCode } = require('../VCPDistributedServer/shared/fileKit/validator');

let tmp;
let wsRoot;

const call = args => forge.processToolCall(args);
const textOf = r => r.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
const norm = s => s.replace(/\r\n/g, '\n');

test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-robust-'));
    wsRoot = path.join(tmp, 'ws');
    fs.mkdirSync(wsRoot, { recursive: true });
    forge.initialize({
        dbPath: path.join(tmp, 'db', 'pf.db'),
        services: {
            workspaceService: {
                list: () => [{ id: 'ws1', alias: 'demo', path: wsRoot, enabled: true, status: 'ready' }],
                getActiveWorkspaceId: () => 'ws1',
            },
        },
        trash: async abs => fs.rmSync(abs, { force: true }),
        logger: { log() {}, warn() {}, error() {} },
    });
});

test.after(async () => {
    cp.execFile = originalExecFile;
    await forge.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('EditCode：代码审查期间文件被外部修改时放弃写入，不覆盖外部内容', async () => {
    const projectId = (await call({ command: 'CreateProject', name: 'lf1', dir: 'lf1' })).details.project.id;
    const abs = path.join(wsRoot, 'lf1', 'm.py');
    const created = await call({ command: 'CreateFile', projectId, path: 'm.py', content: 'x = 1\n', reason: 'init' });
    assert.equal(created.details.status, 'ok', textOf(created));

    beforePythonHook = () => fs.writeFileSync(abs, 'x = 99\n');
    await assert.rejects(
        call({ command: 'EditCode', projectId, path: 'm.py', start: 1, end: 1, content: 'x = 2', reason: 'edit' }),
        /被外部修改/,
    );
    assert.equal(beforePythonHook, null, 'Python 校验钩子未被触发');
    assert.equal(fs.readFileSync(abs, 'utf8'), 'x = 99\n');
});

test('Rollback：中途写入失败时恢复已写入文件，并且不记录回退节点', async () => {
    const projectId = (await call({ command: 'CreateProject', name: 'lf2', dir: 'lf2' })).details.project.id;
    const a = path.join(wsRoot, 'lf2', 'a.txt');
    const b = path.join(wsRoot, 'lf2', 'b.txt');
    await call({ command: 'CreateFile', projectId, path: 'a.txt', content: 'a1\n', reason: 'init a' });
    const cb = await call({ command: 'CreateFile', projectId, path: 'b.txt', content: 'b1\n', reason: 'init b' });
    const nb = cb.details.nodeId;
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
                assert.match(err.message, /回退中途失败/);
                assert.match(err.message, /已写入的 1 个文件中，1 个已恢复/);
                return true;
            },
        );
        assert.equal(norm(fs.readFileSync(a, 'utf8')), 'a2\n', 'a.txt 应恢复为回退前内容');
        assert.equal(norm(fs.readFileSync(b, 'utf8')), 'b2\n');
        const hist = await call({ command: 'SearchHistory', projectId, limit: 50 });
        assert.ok(!hist.details.nodes.some(n => n.op === 'rollback'), '失败的回退不应留下 rollback 节点');
    } finally {
        fs.chmodSync(b, 0o666);
    }

    const ok = await call({ command: 'Rollback', projectId, toNode: `n${nb}`, reason: 'retry' });
    assert.equal(ok.details.status, 'ok', textOf(ok));
    assert.equal(norm(fs.readFileSync(a, 'utf8')), 'a1\n');
    assert.equal(norm(fs.readFileSync(b, 'utf8')), 'b1\n');
});

test('Python 校验异步执行，期间事件循环可以继续运行', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await validateCode('x.py', 'x = 1\n');
    clearInterval(timer);
    assert.ok(ticks >= 1, `校验期间事件循环被阻塞（ticks=${ticks}）`);
});
