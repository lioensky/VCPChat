'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const servicePath = require.resolve('../modules/services/gitService');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
env.GIT_TERMINAL_PROMPT = '0';
function git(root, ...args) {
    return cp.execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd: root, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-outcome-'));
    t.after(() => {
        const resolved = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
        assert.equal(path.dirname(resolved), parent);
        assert.ok(path.basename(resolved).startsWith('vcp-git-outcome-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const repos = ['a', 'b'].map(name => {
        const repo = path.join(root, name);
        fs.mkdirSync(repo);
        git(repo, 'init', '-q', '-b', 'main');
        for (const [key, value] of [['user.name', 'Outcome Test'], ['user.email', 'test@example.invalid'],
            ['commit.gpgsign', 'false'], ['core.hooksPath', '.no-hooks'], ['core.autocrlf', 'false']]) {
            git(repo, 'config', key, value);
        }
        fs.writeFileSync(path.join(repo, 'file.txt'), 'baseline\n');
        git(repo, 'add', 'file.txt');
        git(repo, 'commit', '-qm', 'baseline');
        return repo;
    });
    return { root, a: repos[0], b: repos[1] };
}

// Execute real Git commands. Only replace one read callback after the write exits zero.
function faultAfterWrite(root, operation, read = 'status') {
    const original = cp.execFile, saved = require.cache[servicePath];
    const trace = { completed: false, injected: false };
    cp.execFile = (file, args, options, callback) => {
        const target = path.resolve(options.cwd) === path.resolve(root);
        const failRead = target && trace.completed && !trace.injected && args.includes(read);
        return original(file, args, options, (error, stdout, stderr) => {
            if (target && args.includes(operation) && !error) trace.completed = true;
            if (failRead) {
                trace.injected = true;
                const failure = new Error('Injected read failure after successful Git write');
                failure.code = 'EIO';
                callback(failure, stdout, Buffer.from(failure.message));
            } else callback(error, stdout, stderr);
        });
    };
    try {
        delete require.cache[servicePath];
        return { service: require(servicePath), trace };
    } finally {
        cp.execFile = original;
        if (saved) require.cache[servicePath] = saved;
        else delete require.cache[servicePath];
    }
}

for (const operation of ['stage', 'unstage', 'discard', 'commit', 'push', 'switchBranch', 'createBranch']) {
    test(`${operation}: successful real write remains successful when its status refresh fails`, async t => {
        const { root, a, b } = fixture(t);
        const beforeA = git(a, 'rev-parse', 'HEAD'), beforeB = git(b, 'rev-parse', 'HEAD');
        fs.writeFileSync(path.join(a, 'file.txt'), 'user change\n');
        if (['unstage', 'commit', 'push'].includes(operation)) git(a, 'add', 'file.txt');
        let remote;
        if (operation === 'push') {
            git(a, 'commit', '-qm', 'publish this change');
            remote = path.join(root, 'remote');
            fs.mkdirSync(remote);
            git(remote, 'init', '--bare', '-q');
            git(a, 'remote', 'add', 'origin', remote);
        }
        if (['switchBranch', 'createBranch'].includes(operation)) {
            git(a, 'restore', 'file.txt');
            if (operation === 'switchBranch') git(a, 'branch', 'review');
        }
        const command = { stage: 'add', unstage: 'restore', discard: 'restore', commit: 'commit',
            push: 'push', switchBranch: 'switch', createBranch: 'switch' }[operation];
        const { service, trace } = faultAfterWrite(a, command);
        const result = operation === 'commit' ? await service.commit(a, { message: 'user commit' })
            : operation === 'push' ? await service.push(a, { setUpstream: true })
            : ['switchBranch', 'createBranch'].includes(operation) ? await service[operation](a, 'review')
            : await service[operation](a, ['file.txt']);
        assert.equal(trace.completed, true);
        assert.equal(trace.injected, true);
        assert.equal(result.status, null);
        assert.match(result.warning, /刷新 Git 状态失败/);
        assert.match(result.warning, /操作已完成/);
        assert.match(result.statusError, /Injected read failure/);
        assert.equal(git(b, 'rev-parse', 'HEAD'), beforeB);
        assert.equal(git(b, 'status', '--porcelain'), '');
        if (operation === 'stage') assert.equal(git(a, 'diff', '--cached', '--name-only'), 'file.txt');
        if (operation === 'unstage') assert.equal(git(a, 'diff', '--cached', '--name-only'), '');
        if (operation === 'discard') assert.equal(fs.readFileSync(path.join(a, 'file.txt'), 'utf8'), 'baseline\n');
        if (operation === 'commit') {
            assert.notEqual(git(a, 'rev-parse', 'HEAD'), beforeA);
            assert.equal(git(a, 'log', '-1', '--format=%s'), 'user commit');
            assert.match(result.commit, /^[0-9a-f]{7,}$/);
        }
        if (operation === 'push') assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(a, 'rev-parse', 'HEAD'));
        if (['switchBranch', 'createBranch'].includes(operation)) {
            assert.equal(result.ok, true);
            assert.equal(result.changed, true);
            assert.equal(git(a, 'branch', '--show-current'), 'review');
        }
    });
}

test('commit stays acknowledged even when reading its new hash fails', async t => {
    const { a } = fixture(t);
    const before = git(a, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(a, 'file.txt'), 'change\n');
    git(a, 'add', 'file.txt');
    const { service, trace } = faultAfterWrite(a, 'commit', 'rev-parse');
    const result = await service.commit(a, { message: 'acknowledged commit' });
    assert.equal(trace.injected, true);
    assert.notEqual(git(a, 'rev-parse', 'HEAD'), before);
    assert.equal(result.commit, null);
    assert.match(result.warning, /提交编号读取失败/);
    assert.equal(result.status.staged.length, 0);
});

test('a real Git write failure is still rejected and changes no index', async t => {
    const { a } = fixture(t);
    fs.writeFileSync(path.join(a, 'file.txt'), 'change\n');
    fs.writeFileSync(path.join(a, '.git', 'index.lock'), 'external lock');
    const { service, trace } = faultAfterWrite(a, 'add');
    await assert.rejects(service.stage(a, ['file.txt']), /index.lock/);
    assert.equal(trace.completed, false);
    assert.equal(trace.injected, false);
    assert.equal(git(a, 'diff', '--cached', '--name-only'), '');
});
