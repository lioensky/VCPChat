'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');

async function fixture(t, { absent = false, undoCreation = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'side-revert-record-'));
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    const sentinel = path.join(b, 'untouched.txt');
    fs.writeFileSync(sentinel, 'other workspace\n');
    forge.initialize({ dbPath: path.join(root, 'pf.db'), config: { AST_INDEX_ENABLED: false },
        services: { workspaceService: { list: () => [
            { id: 'a', alias: 'a', path: a, enabled: true },
            { id: 'b', alias: 'b', path: b, enabled: true },
        ] } }, logger: { log() {}, warn() {} },
        trash: async file => fs.promises.rename(file, path.join(root, 'trashed.txt')),
    });
    let restorePermissions = () => {};
    t.after(async () => {
        restorePermissions();
        await forge.cleanup();
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith('side-revert-record-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const projectId = (await forge.processToolCall({ command: 'CreateProject', workspace: 'a', name: 'record failure', dir: 'project' })).details.project.id;
    const created = await forge.processToolCall({ command: 'CreateFile', projectId, path: 'file.txt', content: 'v1\n', reason: 'initial' });
    const edit = await forge.processToolCall({ command: 'EditCode', projectId, path: 'file.txt', start: 1, end: 1, content: 'v2', reason: 'edit' });
    const nodeId = undoCreation ? created.details.nodeId : edit.details.nodeId;
    const file = path.join(a, 'project', 'file.txt');
    const original = Buffer.from('manual content\r\n\0binary bytes\n');
    if (absent) fs.unlinkSync(file);
    else fs.writeFileSync(file, original);
    const request = { projectId, nodeId, mode: 'before', signature: 'private user' };
    const plan = await forge.gui.revertFileChange({ ...request, dryRun: true });
    const store = forge._test.getRuntime().store;
    const before = forge.gui.getProject(projectId).timeline.map(batch => batch.id);
    store.db.exec("CREATE TRIGGER reject_rollback_node BEFORE INSERT ON nodes WHEN NEW.op = 'rollback' BEGIN SELECT RAISE(ABORT, 'record failure'); END;");
    const attempt = () => forge.gui.revertFileChange({ ...request, force: true, expectedHash: plan.expectedHash });
    const assertUntouchedRecords = () => {
        assert.deepEqual(forge.gui.getProject(projectId).timeline.map(batch => batch.id), before);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'other workspace\n');
    };
    return { root, file, original, absent, plan, request, store, attempt, assertUntouchedRecords,
        setRestorePermissions(fn) { restorePermissions = fn; } };
}

for (const [label, options] of [
    ['existing file', {}], ['absent file', { absent: true }], ['trashed file', { undoCreation: true }],
]) {
    test(`side revert compensates a real SQLite node failure (${label})`, async t => {
        const f = await fixture(t, options);
        await assert.rejects(f.attempt(), /原文件已恢复.*record failure/);
        if (f.absent) assert.equal(fs.existsSync(f.file), false);
        else assert.deepEqual(fs.readFileSync(f.file), f.original);
        f.assertUntouchedRecords();
        const recoveryDir = path.join(f.root, 'recovery');
        assert.deepEqual(fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir) : [], []);
        f.store.db.exec('DROP TRIGGER reject_rollback_node');
        const result = await f.attempt();
        assert.equal(result.status, 'ok');
        if (options.undoCreation) assert.equal(fs.existsSync(f.file), false);
        else assert.equal(fs.readFileSync(f.file, 'utf8'), 'v1\n');
    });
}

test('an unavailable recovery directory prevents the live revert', async t => {
    const f = await fixture(t);
    fs.writeFileSync(path.join(f.root, 'recovery'), 'not a directory');
    await assert.rejects(f.attempt(), /EEXIST|ENOTDIR/);
    assert.deepEqual(fs.readFileSync(f.file), f.original);
    f.assertUntouchedRecords();
});

test('a real denied file write preserves the original and permits a later retry', async t => {
    const f = await fixture(t);
    fs.chmodSync(f.file, 0o444);
    f.setRestorePermissions(() => fs.chmodSync(f.file, 0o666));
    await assert.rejects(f.attempt(), /原文件已恢复.*EACCES|原文件已恢复.*EPERM/);
    assert.deepEqual(fs.readFileSync(f.file), f.original);
    f.assertUntouchedRecords();
    fs.chmodSync(f.file, 0o666);
    f.store.db.exec('DROP TRIGGER reject_rollback_node');
    assert.equal((await f.attempt()).status, 'ok');
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'v1\n');
});

test('failed compensation retains the exact before image and names its usable path', async t => {
    const f = await fixture(t);
    const transaction = f.store.transaction.bind(f.store);
    f.store.transaction = callback => {
        try { return transaction(callback); }
        catch (error) { fs.chmodSync(f.file, 0o444); throw error; }
    };
    f.setRestorePermissions(() => fs.chmodSync(f.file, 0o666));
    let error;
    try { await f.attempt(); } catch (caught) { error = caught; }
    assert.match(error?.message, /自动恢复失败.*原文件副本保留在/);
    const recovery = path.join(f.root, 'recovery');
    const files = fs.readdirSync(recovery);
    assert.equal(files.length, 1);
    const backup = path.join(recovery, files[0]);
    assert.ok(error.message.includes(backup));
    assert.deepEqual(fs.readFileSync(backup), f.original);
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'v1\n');
    f.assertUntouchedRecords();
});
