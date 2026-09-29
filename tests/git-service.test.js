'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const gitService = require('../modules/services/gitService');
const { isAllowedSenderUrl } = require('../modules/ipc/gitHandlers');

function gitAvailable() {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch (_error) {
        return false;
    }
}

const SKIP_GIT = gitAvailable() ? false : 'git 不可用';

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, relPath, content) {
    const target = path.join(root, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

/** 临时仓库只写本仓库的 local config，不触碰用户的全局配置。 */
function createRepo(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'VCP Test']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'core.autocrlf', 'false']);
    git(root, ['config', 'core.hooksPath', '.vcp-test-no-hooks']);
    write(root, 'src/app.js', 'const a = 1;\n');
    write(root, 'README.md', '# demo\n');
    write(root, 'pkg/sub/keep.txt', 'keep\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    return root;
}

const pairs = list => list.map(item => [item.status, item.path]);

test('parsePorcelainV2 handles branch headers, spaces, renames, conflicts and untracked files', () => {
    const raw = [
        '# branch.oid 1234abcd',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 aaa bbb src/app.js',
        '1 .M N... 100644 100644 100644 aaa aaa dir with space/文件.md',
        '2 R. N... 100644 100644 100644 aaa aaa R100 new name.js',
        'old name.js',
        'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
        '? untracked file.txt',
        '',
    ].join('\0');

    const { branch, entries } = gitService.parsePorcelainV2(Buffer.from(raw, 'utf8'));
    assert.deepEqual(branch, { oid: '1234abcd', head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });

    const groups = gitService.groupEntries(entries);
    assert.deepEqual(groups.staged.map(e => [e.status, e.path, e.origPath]), [
        ['R', 'new name.js', 'old name.js'],
        ['M', 'src/app.js', null],
    ]);
    assert.deepEqual(pairs(groups.changes), [['M', 'dir with space/文件.md'], ['U', 'untracked file.txt']]);
    assert.equal(groups.changes[1].untracked, true);
    assert.deepEqual(pairs(groups.conflicts), [['UU', 'conflict.txt']]);
});

test('chunkPaths keeps every path and splits long argument lists', () => {
    const paths = Array.from({ length: 900 }, (_, i) => `very/long/directory/name/file-${i}.js`);
    const chunks = gitService.chunkPaths(paths);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.flat(), paths);
});

test('status → stage → unstage → commit round trip on a real repository', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    write(root, 'src/app.js', 'const a = 2;\n');
    write(root, 'notes/新 文件.md', 'hello\n');
    fs.rmSync(path.join(root, 'README.md'));

    let status = await gitService.getStatus(root);
    assert.equal(status.isRepo, true);
    assert.equal(status.prefix, '');
    assert.equal(status.branch.head, 'main');
    assert.equal(status.branch.upstream, null);
    assert.deepEqual(status.staged, []);
    assert.deepEqual(pairs(status.changes), [['D', 'README.md'], ['U', 'notes/新 文件.md'], ['M', 'src/app.js']]);

    let result = await gitService.stage(root, ['src/app.js', 'notes/新 文件.md', 'README.md']);
    assert.deepEqual(pairs(result.status.staged), [['D', 'README.md'], ['A', 'notes/新 文件.md'], ['M', 'src/app.js']]);
    assert.deepEqual(result.status.changes, []);

    const stagedDiff = await gitService.getDiff(root, 'src/app.js', { staged: true });
    assert.equal(stagedDiff.before.text, 'const a = 1;\n');
    assert.equal(stagedDiff.after.text, 'const a = 2;\n');

    result = await gitService.unstage(root, ['README.md']);
    assert.deepEqual(pairs(result.status.changes), [['D', 'README.md']]);

    await assert.rejects(gitService.commit(root, { message: '   ' }), /提交信息/);

    result = await gitService.commit(root, { message: '#12 feat: 更新 app\n\n详细说明' });
    assert.match(result.commit, /^[0-9a-f]{7,}$/);
    assert.equal(git(root, ['log', '-1', '--format=%B']), '#12 feat: 更新 app\n\n详细说明');
    assert.deepEqual(result.status.staged, []);
    assert.deepEqual(pairs(result.status.changes), [['D', 'README.md']]);

    await assert.rejects(gitService.commit(root, { message: 'nothing staged' }), /没有已暂存的更改/);
    await assert.rejects(gitService.push(root, {}), /没有配置任何远端/);
});

test('unstaged diff reads the working tree; discard restores tracked files and hands untracked ones to the remover', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    write(root, 'src/app.js', 'const a = 3;\n');
    write(root, 'tmp.txt', 'x');
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));

    const diff = await gitService.getDiff(root, 'src/app.js');
    assert.equal(diff.before.text, 'const a = 1;\n');
    assert.equal(diff.after.text, 'const a = 3;\n');
    // 验证 Windows 风格 CRLF 磁盘文件在 getDiff 中被归一化为 LF，避免差异视图全局爆红
    fs.writeFileSync(path.join(root, 'crlf.txt'), 'line1\r\nline2\r\n');
    const crlfDiff = await gitService.getDiff(root, 'crlf.txt');
    assert.equal(crlfDiff.after.text, 'line1\nline2\n');
    fs.unlinkSync(path.join(root, 'crlf.txt'));
    const untrackedDiff = await gitService.getDiff(root, 'tmp.txt');
    assert.equal(untrackedDiff.before.exists, false);
    assert.equal(untrackedDiff.after.text, 'x');

    const binaryDiff = await gitService.getDiff(root, 'blob.bin');
    assert.equal(binaryDiff.after.binary, true);

    const removed = [];
    const result = await gitService.discard(root, ['src/app.js', 'tmp.txt', 'blob.bin'], {
        removeUntracked: async abs => {
            removed.push(path.basename(abs));
            fs.rmSync(abs);
        },
    });
    assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'const a = 1;\n');
    assert.deepEqual(removed.sort(), ['blob.bin', 'tmp.txt']);
    assert.equal(result.restored, 1);
    assert.equal(result.removed, 2);
    assert.deepEqual(result.status.changes, []);
});

test('sub-directory workspace: status is scoped, outside paths are rejected, commit refuses foreign staged files', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    write(root, 'src/app.js', 'changed\n');
    write(root, 'pkg/sub/keep.txt', 'changed\n');
    const workspace = path.join(root, 'pkg');

    const status = await gitService.getStatus(workspace);
    assert.equal(status.prefix, 'pkg');
    assert.deepEqual(status.changes.map(c => c.path), ['pkg/sub/keep.txt']);

    await assert.rejects(gitService.stage(workspace, ['src/app.js']), /不在工作区内/);
    await assert.rejects(gitService.stage(workspace, ['../outside.txt']), /不在工作区内/);
    await assert.rejects(gitService.stage(workspace, [path.join(root, 'pkg', 'sub', 'keep.txt')]), /相对路径/);
    await assert.rejects(gitService.stage(root, ['.git/config']), /\.git/);
    await assert.rejects(gitService.stage(workspace, []), /至少选择一个文件/);

    git(root, ['add', 'src/app.js']);
    await gitService.stage(workspace, ['pkg/sub/keep.txt']);
    await assert.rejects(gitService.commit(workspace, { message: 'scoped' }), /工作区之外/);
    assert.equal(git(root, ['rev-list', '--count', 'HEAD']), '1');
});

test('non-repository directory reports isRepo=false', { skip: SKIP_GIT }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-nogit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const status = await gitService.getStatus(dir);
    assert.equal(status.isRepo, false);
});

test('git IPC only accepts the ProjectForge page as sender', () => {
    assert.equal(isAllowedSenderUrl('file:///H:/VCP/VCPMain/VCPChat/ProjectForgemodules/projectforge.html'), true);
    assert.equal(isAllowedSenderUrl('file:///H:/VCP/VCPMain/VCPChat/ProjectForgemodules/projectforge.html?vcpEmbedded=1'), true);
    assert.equal(isAllowedSenderUrl('file:///C:/Program%20Files/VCP/resources/app.asar/ProjectForgemodules/projectforge.html'), true);
    assert.equal(isAllowedSenderUrl('file:///H:/VCP/VCPMain/VCPChat/Forummodules/forum.html'), false);
    assert.equal(isAllowedSenderUrl('https://evil.example/ProjectForgemodules/projectforge.html'), false);
    assert.equal(isAllowedSenderUrl(''), false);
});