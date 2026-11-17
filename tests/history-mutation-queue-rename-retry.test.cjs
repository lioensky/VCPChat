'use strict';
// history.json 被别的程序以“只允许读共享”打开时，覆盖改名在 Windows 上报 EPERM，
// 这次保存原来直接失败。用真的 PowerShell 进程占住文件，验证保存会等它放开。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HistoryMutationQueue, renameWithRetry } = require('../modules/services/historyMutationQueue');

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows rename semantics only' };

function holdFile(file, ms) {
    const script = `$f = [IO.File]::Open($env:VCP_HOLD_PATH, 'Open', 'Read', 'Read'); `
        + `[Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, env: { ...process.env, VCP_HOLD_PATH: file },
    });
    const exited = new Promise(resolve => child.on('exit', resolve));
    const locked = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve(); });
        child.on('error', reject);
        exited.then(code => reject(new Error(`holder exited before locking (${code})`)));
    });
    return { child, locked, exited };
}

async function tempDir(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-history-retry-'));
    t.after(() => fs.remove(root));
    return root;
}

test('a history save waits out a reader that blocks the rename', windowsOnly, async t => {
    const userDataDir = await tempDir(t);
    let internalSaves = 0;
    const queue = new HistoryMutationQueue({ userDataDir, fileWatcher: { signalInternalSave: () => internalSaves++ } });
    const descriptor = { itemType: 'agent', itemId: 'agent_a', topicId: 'topic_a' };
    await queue.replace(descriptor, [{ id: 'm1', role: 'user', content: '问题' }]);
    const historyPath = queue.getHistoryPath('agent_a', 'topic_a');
    internalSaves = 0;

    const holder = holdFile(historyPath, 1500);
    t.after(() => holder.child.kill());
    await holder.locked;
    const started = Date.now();
    await queue.replace(descriptor, [
        { id: 'm1', role: 'user', content: '问题' },
        { id: 'm2', role: 'assistant', content: '这条回复在文件被占着时写完' },
    ]);
    assert.ok(Date.now() - started >= 500, 'the save should have waited for the reader');
    assert.ok(internalSaves > 1, 'each retry re-marks the write as internal for the file watcher');
    const saved = await fs.readJson(historyPath);
    assert.deepEqual(saved.map(message => message.id), ['m1', 'm2']);
    const leftovers = (await fs.readdir(path.dirname(historyPath))).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    await holder.exited;
    await queue.dispose();
});

test('the save gives up after the last delay and reports the original error', windowsOnly, async t => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'history.json');
    const source = path.join(dir, 'history.json.tmp');
    await fs.writeJson(target, []);
    await fs.writeJson(source, [{ id: 'new' }]);
    const holder = holdFile(target, 3000);
    t.after(() => holder.child.kill());
    await holder.locked;
    let retries = 0;
    await assert.rejects(
        renameWithRetry(source, target, { delays: [20, 20], onRetry: () => retries++ }),
        error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code),
    );
    assert.equal(retries, 2);
    holder.child.kill();
    await holder.exited;
    assert.deepEqual(await fs.readJson(target), []);
});

test('a target that can never be replaced fails at once without waiting', windowsOnly, async t => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'history.json');
    const source = path.join(dir, 'history.json.tmp');
    await fs.ensureDir(target); // 目标是文件夹：等多久都不会好
    await fs.writeJson(source, []);
    const sleeps = [];
    await assert.rejects(renameWithRetry(source, target, { sleep: async ms => { sleeps.push(ms); } }));
    assert.deepEqual(sleeps, []);
});

test('other platforms keep the single rename attempt', windowsOnly, async t => {
    const dir = await tempDir(t);
    const target = path.join(dir, 'history.json');
    const source = path.join(dir, 'history.json.tmp');
    await fs.writeJson(target, []);
    await fs.writeJson(source, []);
    const holder = holdFile(target, 1500);
    t.after(() => holder.child.kill());
    await holder.locked;
    const sleeps = [];
    await assert.rejects(renameWithRetry(source, target, { platform: 'linux', sleep: async ms => { sleeps.push(ms); } }));
    assert.deepEqual(sleeps, []);
    holder.child.kill();
    await holder.exited;
});
