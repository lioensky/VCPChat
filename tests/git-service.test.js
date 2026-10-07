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

function createBareRepo(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-push-remote-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, ['init', '--bare', '-q']);
    git(root, ['config', 'core.hooksPath', '.vcp-test-no-hooks']);
    return root;
}

function createPushFixture(t, target = 'main') {
    const root = createRepo(t), remote = createBareRepo(t);
    git(root, ['config', 'push.default', 'simple']);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['branch', 'other']);
    git(root, ['push', '-u', 'origin', `main:refs/heads/${target}`, 'other:refs/heads/other']);
    const beforeMain = git(remote, ['rev-parse', `refs/heads/${target}`]);
    const beforeOther = git(remote, ['rev-parse', 'refs/heads/other']);
    git(root, ['checkout', '-q', 'other']);
    write(root, 'other.txt', 'private work on another branch\n');
    git(root, ['add', 'other.txt']); git(root, ['commit', '-qm', 'other private work']);
    git(root, ['checkout', '-q', 'main']);
    write(root, 'src/app.js', 'current branch update\n');
    git(root, ['add', 'src/app.js']); git(root, ['commit', '-qm', 'main update']);
    return { root, remote, target, beforeMain, beforeOther };
}

for (const setting of ['push.default=matching', 'remote.origin.push=refs/heads/*:refs/heads/*']) {
    test(`push publishes only the current branch despite ${setting}`, { skip: SKIP_GIT }, async t => {
        const f = createPushFixture(t);
        const separator = setting.indexOf('=');
        git(f.root, ['config', setting.slice(0, separator), setting.slice(separator + 1)]);
        const result = await gitService.push(f.root);
        assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), git(f.root, ['rev-parse', 'HEAD']));
        assert.equal(git(f.remote, ['rev-parse', 'refs/heads/other']), f.beforeOther);
        assert.equal(result.status.branch.ahead, 0);
    });
}

test('push uses the displayed upstream remote and its differently named branch', { skip: SKIP_GIT }, async t => {
    const f = createPushFixture(t, 'published/main');
    const alternate = createBareRepo(t);
    git(f.root, ['remote', 'add', 'review', alternate]);
    git(f.root, ['push', 'review', `${f.beforeMain}:refs/heads/main`]);
    git(f.root, ['config', 'branch.main.pushRemote', 'review']);
    git(f.root, ['config', 'push.default', 'current']);
    const result = await gitService.push(f.root);
    assert.equal(git(f.remote, ['rev-parse', 'refs/heads/published/main']), git(f.root, ['rev-parse', 'HEAD']));
    assert.equal(git(alternate, ['rev-parse', 'refs/heads/main']), f.beforeMain);
    assert.equal(git(f.remote, ['rev-parse', 'refs/heads/other']), f.beforeOther);
    assert.equal(result.status.branch.upstream, 'origin/published/main');
});

test('first push requires confirmation and publishes only the current branch', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t), remote = createBareRepo(t);
    git(root, ['branch', 'other']);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['config', 'remote.origin.push', 'refs/heads/*:refs/heads/*']);
    await assert.rejects(gitService.push(root), error => error.code === 'NO_UPSTREAM');
    const result = await gitService.push(root, { setUpstream: true });
    assert.equal(git(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads']), 'refs/heads/main');
    assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), git(root, ['rev-parse', 'HEAD']));
    assert.equal(result.status.branch.upstream, 'origin/main');
});

test('a rejected current-branch push leaves other remote branches unchanged', { skip: SKIP_GIT }, async t => {
    const f = createPushFixture(t);
    const peer = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-push-peer-'));
    t.after(() => fs.rmSync(peer, { recursive: true, force: true }));
    git(peer, ['clone', '-q', '--branch', 'main', f.remote, '.']);
    for (const [key, value] of [['user.name', 'Peer'], ['user.email', 'peer@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.vcp-test-no-hooks']]) git(peer, ['config', key, value]);
    write(peer, 'server.txt', 'someone else updated the remote\n');
    git(peer, ['add', 'server.txt']); git(peer, ['commit', '-qm', 'server update']);
    git(peer, ['push', 'origin', 'main:refs/heads/main']);
    const remoteMain = git(f.remote, ['rev-parse', 'refs/heads/main']);
    git(f.root, ['config', 'push.default', 'matching']);
    await assert.rejects(gitService.push(f.root), /rejected|non-fast-forward|fetch first/);
    assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), remoteMain);
    assert.equal(git(f.remote, ['rev-parse', 'refs/heads/other']), f.beforeOther);
});

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

for (const [from, to] of [['README.md', 'pkg/移入 文件.md'], ['pkg/sub/keep.txt', '移出 文件.txt']]) {
    test(`sub-directory commit rejects a staged rename crossing its boundary: ${from} → ${to}`, { skip: SKIP_GIT }, async t => {
        const root = createRepo(t);
        git(root, ['mv', from, to]);
        const head = git(root, ['rev-parse', 'HEAD']);
        const index = fs.readFileSync(path.join(root, '.git', 'index'));
        const content = fs.readFileSync(path.join(root, to));
        await assert.rejects(gitService.commit(path.join(root, 'pkg'), { message: 'workspace only' }), /工作区之外/);
        assert.equal(git(root, ['rev-parse', 'HEAD']), head);
        assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), index);
        assert.deepEqual(fs.readFileSync(path.join(root, to)), content);
        assert.equal(fs.existsSync(path.join(root, from)), false);
    });
}

test('sub-directory commit still accepts a rename wholly within the workspace', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    git(root, ['mv', 'pkg/sub/keep.txt', 'pkg/改名 文件.txt']);
    const result = await gitService.commit(path.join(root, 'pkg'), { message: 'rename within workspace' });
    assert.match(result.commit, /^[0-9a-f]{7,}$/);
    assert.deepEqual(result.status.staged, []);
    assert.equal(git(root, ['show', 'HEAD:pkg/改名 文件.txt']), 'keep');
    assert.equal(git(root, ['show', 'HEAD:src/app.js']), 'const a = 1;');
});

test('branches: list, create, switch and refuse unsafe cases', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    const first = await gitService.listBranches(root);
    assert.equal(first.current, 'main');
    assert.deepEqual(first.branches.map(x => [x.name, x.current]), [['main', true]]);

    const created = await gitService.createBranch(root, 'feature/one');
    assert.equal(created.ok, true);
    assert.equal(created.changed, true);
    assert.equal(git(root, ['branch', '--show-current']), 'feature/one');
    assert.equal((await gitService.listBranches(root)).current, 'feature/one');

    const same = await gitService.switchBranch(root, 'feature/one');
    assert.deepEqual([same.ok, same.changed], [true, false]);
    assert.equal((await gitService.switchBranch(root, 'main')).changed, true);
    assert.equal(git(root, ['branch', '--show-current']), 'main');

    for (const bad of ['', '  ', 'a b', 'x..y', '-oops']) {
        const result = await gitService.createBranch(root, bad);
        assert.equal(result.ok, false, bad);
        assert.equal(result.issues[0].code, 'invalid-branch-name', bad);
    }
    const missing = await gitService.switchBranch(root, 'nope');
    assert.equal(missing.ok, false);
    assert.equal(missing.issues[0].code, 'git-error');
    assert.equal(git(root, ['branch', '--show-current']), 'main');

    // a start point that looks like an option must not be parsed as one
    const odd = await gitService.createBranch(root, 'topic', '--detach');
    assert.equal(odd.ok, false);
    assert.equal(git(root, ['branch', '--show-current']), 'main');

    // a merge in progress blocks switching
    git(root, ['switch', '-q', '-c', 'other']);
    write(root, 'README.md', '# other\n');
    git(root, ['commit', '-q', '-am', 'other change']);
    git(root, ['switch', '-q', 'main']);
    write(root, 'README.md', '# main\n');
    git(root, ['commit', '-q', '-am', 'main change']);
    try { git(root, ['merge', 'other']); } catch (_error) { /* conflict expected */ }
    const blocked = await gitService.switchBranch(root, 'other');
    assert.equal(blocked.ok, false);
    assert.ok(['conflicts-present', 'operation-in-progress'].includes(blocked.issues[0].code));
});

test('commit graph pages through visible history with refs', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    for (let i = 1; i <= 4; i++) {
        write(root, `f${i}.txt`, `${i}\n`);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', `c${i}`]);
    }
    git(root, ['tag', 'v1']);
    const page1 = await gitService.getCommitGraph(root, { maxCount: 2 });
    assert.equal(page1.commits.length, 2);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.commits[0].subject, 'c4');
    assert.equal(page1.commits[0].parents.length, 1);
    assert.ok(page1.commits[0].refs.some(r => r.includes('main')));
    assert.ok(page1.commits[0].refs.some(r => r.includes('v1')));
    const page2 = await gitService.getCommitGraph(root, { maxCount: 10, skip: 2 });
    assert.deepEqual(page2.commits.map(c => c.subject), ['c2', 'c1', 'init']);
    assert.equal(page2.hasMore, false);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-empty-'));
    t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
    git(empty, ['init', '-q', '-b', 'main']);
    assert.deepEqual(await gitService.getCommitGraph(empty), { commits: [], hasMore: false });
});

test('change summary counts tracked and untracked text lines', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    let summary = await gitService.getChangeSummary(root);
    assert.deepEqual([summary.files, summary.added, summary.removed], [0, 0, 0]);

    write(root, 'src/app.js', 'const a = 2;\nconst b = 3;\n');   // +2 -1
    write(root, 'new.txt', 'a\nb\nc\n');                          // untracked +3
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    git(root, ['add', 'src/app.js']);
    summary = await gitService.getChangeSummary(root);
    assert.deepEqual([summary.files, summary.added, summary.removed], [3, 5, 1]);
    assert.equal(summary.branch.head, 'main');
});

test('non-repository directory reports isRepo=false', { skip: SKIP_GIT }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-nogit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const status = await gitService.getStatus(dir);
    assert.equal(status.isRepo, false);
});

test('git IPC accepts only exact application pages, including embedded query parameters', () => {
    const {pathToFileURL}=require('node:url');
    const projectPage=pathToFileURL(path.resolve(__dirname,'../ProjectForgemodules/projectforge.html')).href;
    const mainPage=pathToFileURL(path.resolve(__dirname,'../main.html')).href;
    assert.equal(isAllowedSenderUrl(projectPage),true);
    assert.equal(isAllowedSenderUrl(projectPage+'?vcpEmbedded=1'),true);
    assert.equal(isAllowedSenderUrl(mainPage),true);
    for(const url of ['file:///C:/attacker/main.html','file:///H:/VCP/VCPMain/VCPChat/ProjectForgemodules/projectforge.html','https://evil.example/main.html','']) assert.equal(isAllowedSenderUrl(url),false,url);
});

test('status carries per-file line counts that follow a second edit of an already modified file', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    write(root, 'src/app.js', 'const a = 1;\nconst b = 2;\n');
    let status = await gitService.getStatus(root);
    const first = status.changes.find(item => item.path === 'src/app.js');
    assert.deepEqual([first.status, first.added, first.removed], ['M', 1, 0]);

    write(root, 'src/app.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n');
    status = await gitService.getStatus(root);
    const second = status.changes.find(item => item.path === 'src/app.js');
    assert.deepEqual([second.status, second.added, second.removed], ['M', 3, 0]);

    git(root, ['add', 'src/app.js']);
    status = await gitService.getStatus(root);
    const staged = status.staged.find(item => item.path === 'src/app.js');
    assert.deepEqual([staged.added, staged.removed], [3, 0]);
});

test('reveal targets resolve against the repository root when the workspace is a subdirectory', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    const workspace = path.join(root, 'pkg');
    write(root, 'pkg/sub/keep.txt', 'changed\n');
    const status = await gitService.getStatus(workspace);
    const item = status.changes.find(entry => entry.path.endsWith('keep.txt'));
    assert.equal(item.path, 'pkg/sub/keep.txt');

    const target = await gitService.resolveRevealTarget(workspace, item.path);
    assert.equal(fs.realpathSync.native(target), fs.realpathSync.native(path.join(root, 'pkg', 'sub', 'keep.txt')));
    await assert.rejects(gitService.resolveRevealTarget(workspace, 'README.md'), /不在工作区内/);

    // 代码查看器给的是相对工作区的路径
    const fromViewer = await gitService.resolveRevealTarget(workspace, 'sub/keep.txt', { base: 'workspace' });
    assert.equal(fs.realpathSync.native(fromViewer), fs.realpathSync.native(path.join(root, 'pkg', 'sub', 'keep.txt')));
    await assert.rejects(gitService.resolveRevealTarget(workspace, '../README.md', { base: 'workspace' }), /不在工作区内/);
});

test('a GIT_DIR inherited from the launching shell does not redirect commands to another repository', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    const other = createRepo(t);
    write(other, 'only-in-other.txt', 'x\n');
    write(root, 'src/app.js', 'const a = 2;\n');
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
    Object.assign(process.env, { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, LC_ALL: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN' });
    t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

    const status = await gitService.getStatus(root);
    assert.equal(status.isRepo, true);
    assert.deepEqual(status.changes.map(item => item.path), ['src/app.js'], 'the workspace\'s own change, nothing from the other repository');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-nogit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal((await gitService.getStatus(dir)).isRepo, false);
});

test('a switch blocked by local changes reports the files in a form the commit-and-switch flow recognises', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    git(root, ['switch', '-q', '-c', 'other']);
    write(root, 'README.md', '# other\n');
    git(root, ['commit', '-q', '-am', 'other change']);
    git(root, ['switch', '-q', 'main']);
    write(root, 'README.md', '# local edit\n');
    const saved = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
    Object.assign(process.env, { LC_ALL: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN' });
    t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

    const blocked = await gitService.switchBranch(root, 'other');
    assert.equal(blocked.ok, false);
    const { parseSwitchBlockedFiles } = await import('../modules/ui-system/conversation-status-panel/helpers.js');
    assert.deepEqual(parseSwitchBlockedFiles(blocked.issues[0].message), { files: ['README.md'], untracked: false });
});

test('only the Git page read and post-write refreshes pay for per-file line counts', { skip: SKIP_GIT }, async t => {
    const root = createRepo(t);
    write(root, 'README.md', 'changed\nmore\n');
    const status = await gitService.getStatus(root);
    const card = status.changes.find(item => item.path === 'README.md');
    assert.ok(Number.isInteger(card.added), 'the Git page gets line counts');
    const branches = await gitService.listBranches(root);
    assert.ok(Array.isArray(branches.branches || branches), 'branch listing still works without counts');
});
