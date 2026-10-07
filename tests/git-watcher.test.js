'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createGitWatcher, isRelevant, outermostDirs } = require('../modules/services/gitWatcher');
const { createStateSubscriptions } = require('../modules/ipc/stateSubscriptions');

const quiet = { warn: () => {}, error: () => {} };
const settle = () => new Promise(resolve => setImmediate(resolve));

/** 假的 fs.watch：记下每个被监听的目录，emit(dir, filename) 模拟一次变化 */
function fakeWatch() {
    const opened = [];
    const watch = (dir, options, listener) => {
        const watcher = new EventEmitter();
        watcher.closed = false;
        watcher.close = () => { watcher.closed = true; };
        opened.push({ dir, options, listener, watcher });
        return watcher;
    };
    const emit = (dir, filename) => opened.filter(item => item.dir === dir && !item.watcher.closed).forEach(item => item.listener('change', filename));
    return { watch, opened, emit };
}

test('isRelevant ignores object, log and lock writes in .git and nested .git / node_modules in the tree', () => {
    assert.equal(isRelevant('metadata', 'index'), true);
    assert.equal(isRelevant('metadata', 'HEAD'), true);
    assert.equal(isRelevant('metadata', path.join('refs', 'heads', 'main')), true);
    assert.equal(isRelevant('metadata', path.join('objects', 'ab', 'cdef')), false);
    assert.equal(isRelevant('metadata', path.join('logs', 'HEAD')), false);
    assert.equal(isRelevant('metadata', 'index.lock'), false);
    assert.equal(isRelevant('content', path.join('src', 'a.js')), true);
    assert.equal(isRelevant('content', path.join('node_modules', 'x', 'index.js')), false);
    assert.equal(isRelevant('content', path.join('.git', 'index')), false);
    assert.equal(isRelevant('content', null), true, 'no file name: refresh rather than miss a change');
});

test('outermostDirs drops directories already covered by a recursive parent', () => {
    const main = path.resolve('/repo/.git');
    const worktree = path.join(main, 'worktrees', 'feature');
    assert.deepEqual(outermostDirs([worktree, main, main]), [main]);
    const other = path.resolve('/elsewhere/.git');
    assert.deepEqual(outermostDirs([main, other]), [main, other]);
});

test('a burst of changes is reported once: metadata quickly, file edits after a pause, never later than their max wait', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { watch, opened, emit } = fakeWatch();
    const changes = [];
    const root = path.resolve('/repo');
    const gitDir = path.join(root, '.git');
    const watcher = createGitWatcher({
        getTargets: async () => ({ root, gitDirs: [gitDir] }),
        onChange: id => changes.push(id),
        watch,
        platform: 'win32',
        logger: quiet,
    });
    await watcher.start('ws1');
    assert.deepEqual(opened.map(item => [item.dir, item.options.recursive]), [[gitDir, true], [root, true]]);
    assert.equal(opened.every(item => item.options.persistent === false), true, 'watchers do not keep the app alive');
    assert.deepEqual(watcher.snapshot(), [{ workspaceId: 'ws1', mode: 'files', watchers: 2, changes: 0, absorbed: 0, pending: false, error: null }]);

    emit(gitDir, 'index');
    emit(gitDir, 'HEAD');
    t.mock.timers.tick(299);
    assert.deepEqual(changes, []);
    t.mock.timers.tick(1);
    assert.deepEqual(changes, ['ws1'], 'metadata changes are reported after 300ms, once');

    emit(gitDir, path.join('objects', 'aa', 'bb'));
    emit(gitDir, 'index.lock');
    emit(root, path.join('node_modules', 'pkg', 'a.js'));
    t.mock.timers.tick(10_000);
    assert.equal(changes.length, 1, 'ignored paths never trigger');

    // 编辑器一直在写：每秒一个事件，文件内容最迟 20 秒报一次，不是每几秒就读一遍状态
    for (let i = 0; i < 19; i++) {
        emit(root, path.join('src', 'a.js'));
        t.mock.timers.tick(1000);
    }
    assert.equal(changes.length, 1, 'continuous edits wait longer than metadata');
    emit(root, path.join('src', 'a.js'));
    t.mock.timers.tick(1000);
    assert.equal(changes.length, 2, 'continuous edits are reported by the content max wait');
    t.mock.timers.tick(10_000);
    assert.equal(changes.length, 2);

    // 文件一直在写的途中仓库也变了：元数据按自己的 300ms 报，顺带把这批文件改动一起报掉
    emit(root, path.join('src', 'a.js'));
    t.mock.timers.tick(1000);
    emit(gitDir, 'index');
    emit(root, path.join('src', 'a.js'));
    t.mock.timers.tick(300);
    assert.equal(changes.length, 3, 'a later file event does not push back a pending metadata report');
    t.mock.timers.tick(10_000);
    assert.equal(changes.length, 3);

    watcher.stop('ws1');
    assert.equal(opened.every(item => item.watcher.closed), true);
    assert.deepEqual(watcher.snapshot(), []);
});

test('on Linux only the git directories are watched, and that is reported as degraded once', async () => {
    const { watch, opened } = fakeWatch();
    const root = path.resolve('/repo');
    const degraded = [];
    const watcher = createGitWatcher({
        getTargets: async () => ({ root, gitDirs: [path.join(root, '.git')] }),
        onChange: () => {},
        onDegraded: (id, info) => degraded.push([id, info.mode]),
        watch, platform: 'linux', logger: quiet, exists: () => false,
    });
    await watcher.start('ws1');
    assert.deepEqual(opened.map(item => item.dir), [path.join(root, '.git')]);
    assert.equal(watcher.snapshot()[0].mode, 'metadata');
    assert.deepEqual(degraded, [['ws1', 'metadata']]);
    assert.equal(watcher.isDegraded('ws1'), true);
    opened[0].watcher.emit('error', new Error('ENOENT'));
    assert.equal(degraded.length, 1, 'reported once per watch');
    assert.equal(watcher.snapshot()[0].mode, 'failed');
    watcher.dispose();
});

test('a change the app made itself and already announced is not reported again by the watcher', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { watch, emit } = fakeWatch();
    const changes = [];
    const root = path.resolve('/repo');
    const gitDir = path.join(root, '.git');
    const watcher = createGitWatcher({ getTargets: async () => ({ root, gitDirs: [gitDir] }), onChange: id => changes.push(id), watch, platform: 'win32', logger: quiet });
    await watcher.start('ws1');
    assert.equal(watcher.isDegraded('ws1'), false);

    // git commit 写 index、refs 的途中就有事件，通知之后还可能晚到几个
    emit(gitDir, 'index');
    emit(root, 'b.txt');
    watcher.absorb('ws1');
    emit(gitDir, path.join('refs', 'heads', 'main'));
    t.mock.timers.tick(900);
    emit(gitDir, 'HEAD');
    t.mock.timers.tick(5000);
    assert.deepEqual(changes, [], 'the pending batch and late metadata events are dropped');
    assert.equal(watcher.snapshot()[0].absorbed, 1);

    emit(root, 'c.txt');
    t.mock.timers.tick(1500);
    assert.deepEqual(changes, ['ws1'], 'a file edit right after is still reported');
    emit(gitDir, 'HEAD');
    t.mock.timers.tick(300);
    assert.deepEqual(changes, ['ws1', 'ws1'], 'metadata is reported again once the window passes');
    watcher.absorb('missing');
    watcher.dispose();
});

test('stopping before the targets resolve opens nothing; a non-repo and a failed watch are reported, not thrown', async () => {
    const { watch, opened } = fakeWatch();
    let resolveTargets;
    const watcher = createGitWatcher({
        getTargets: id => (id === 'slow' ? new Promise(resolve => { resolveTargets = resolve; }) : id === 'plain' ? null : { root: '/broken', gitDirs: ['/broken/.git'] }),
        onChange: () => {},
        watch: (dir, options, listener) => {
            if (dir.startsWith('/broken')) throw new Error('EACCES');
            return watch(dir, options, listener);
        },
        platform: 'win32',
        logger: quiet,
    });
    const ready = watcher.start('slow');
    assert.equal(watcher.start('slow'), ready, 'starting twice shares one setup');
    watcher.stop('slow');
    resolveTargets({ root: '/repo', gitDirs: ['/repo/.git'] });
    await ready;
    assert.equal(opened.length, 0);
    assert.equal(watcher.isWatching('slow'), false);

    await watcher.start('plain');
    await watcher.start('broken');
    const modes = Object.fromEntries(watcher.snapshot().map(item => [item.workspaceId, item]));
    assert.equal(modes.plain.mode, 'not-repo');
    assert.equal(modes.broken.mode, 'failed');
    assert.equal(modes.broken.error, 'EACCES');
    assert.equal(watcher.isDegraded('broken'), true);
    assert.equal(watcher.isDegraded('plain'), false, 'a folder that is not a repo is not a degraded watch');
    watcher.dispose();
    assert.deepEqual(watcher.snapshot(), []);
});

test('a repository whose .git cannot be watched counts as partly watched', async () => {
    const { watch } = fakeWatch();
    const root = path.resolve('/repo');
    const degraded = [];
    const watcher = createGitWatcher({
        getTargets: async () => ({ root, gitDirs: [path.join(root, '.git')] }),
        onChange: () => {},
        onDegraded: (id, info) => degraded.push([id, info.mode]),
        watch: (dir, options, listener) => { if (dir.endsWith('.git')) throw new Error('EPERM'); return watch(dir, options, listener); },
        platform: 'win32', logger: quiet,
    });
    await watcher.start('ws1');
    assert.deepEqual(degraded, [['ws1', 'partial']]);
    watcher.dispose();
});

test('a watcher that errors (directory removed) is closed and the others keep working', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { watch, opened, emit } = fakeWatch();
    const changes = [];
    const root = path.resolve('/repo');
    const watcher = createGitWatcher({ getTargets: async () => ({ root, gitDirs: [path.join(root, '.git')] }), onChange: id => changes.push(id), watch, platform: 'darwin', logger: quiet });
    await watcher.start('ws1');
    opened[1].watcher.emit('error', new Error('EPERM'));
    assert.equal(opened[1].watcher.closed, true);
    assert.equal(watcher.snapshot()[0].watchers, 1);
    assert.equal(watcher.snapshot()[0].mode, 'metadata');
    assert.equal(watcher.isDegraded('ws1'), true, 'losing the file watch counts as degraded');
    emit(path.join(root, '.git'), 'HEAD');
    t.mock.timers.tick(300);
    assert.deepEqual(changes, ['ws1']);
    watcher.dispose();
});

// ── 主进程接线：订阅表 → 监听 → 推送 ─────────────────────────────

function loadGitHandlers() {
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: ch => handlers.delete(ch) };
    const handlerPath = require.resolve('../modules/ipc/gitHandlers');
    delete require.cache[handlerPath];
    const originalLoad = Module._load;
    Module._load = function mockElectron(request, parent, isMain) {
        if (request === 'electron') return { ipcMain, shell: { trashItem: async () => {}, showItemInFolder: () => {} } };
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return { gitHandlers: require(handlerPath), handlers };
    } finally {
        Module._load = originalLoad;
        delete require.cache[handlerPath];
    }
}

function fakeWindow(page = 'main.html') {
    const sender = new EventEmitter();
    const url = pathToFileURL(path.resolve(__dirname, '..', page)).href;
    sender.sent = [];
    sender.mainFrame = { url, detached: false };
    sender.isDestroyed = () => false;
    sender.getType = () => 'window';
    sender.getURL = () => url;
    sender.send = (channel, payload) => sender.sent.push([channel, payload]);
    return { sender, event: { sender, senderFrame: sender.mainFrame } };
}

test('a workspace is watched only while some window subscribed to it; a folder that is not a repo is reported, not thrown', async t => {
    const { gitHandlers } = loadGitHandlers();
    const { watch, opened } = fakeWatch();
    const subscriptions = createStateSubscriptions({ logger: quiet });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-watch-'));
    t.after(() => { gitHandlers.dispose(); subscriptions.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); });
    const workspaceService = { list: () => [{ id: 'ws1', alias: 'demo', path: tmp, enabled: true }] };
    gitHandlers.initialize({ workspaceService, subscriptions, watch });
    assert.deepEqual(gitHandlers.watchSnapshot(), [], 'starting the app watches nothing');

    const a = fakeWindow();
    const b = fakeWindow();
    subscriptions.subscribe(a.sender, gitHandlers.STATUS_TOPIC, 'ws1');
    subscriptions.subscribe(b.sender, gitHandlers.STATUS_TOPIC, 'ws1');
    for (let i = 0; i < 50 && gitHandlers.watchSnapshot()[0]?.mode === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(gitHandlers.watchSnapshot().map(item => [item.workspaceId, item.mode]), [['ws1', 'not-repo']], 'two windows, one watch');
    assert.equal(opened.length, 0);

    subscriptions.unsubscribe(a.sender, gitHandlers.STATUS_TOPIC, 'ws1');
    assert.equal(gitHandlers.watchSnapshot().length, 1, 'still watched for the other window');
    b.sender.emit('destroyed');
    assert.deepEqual(gitHandlers.watchSnapshot(), [], 'the last window closing stops watching');
});

test('Git registered through the domain activator is active from the start, answers on every channel, and watches nothing yet', async t => {
    const { createDomainActivator } = require('../modules/ipc/domainActivator');
    const { gitHandlers, handlers: electronHandlers } = loadGitHandlers();
    const outer = new Map();
    const activator = createDomainActivator({
        ipcMain: { handle: (ch, fn) => outer.set(ch, fn), removeHandler: ch => outer.delete(ch) },
        logger: quiet,
    });
    const subscriptions = createStateSubscriptions({ logger: quiet });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-domain-'));
    t.after(() => { activator.disposeAll(); subscriptions.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); });
    const workspaceService = { list: () => [{ id: 'ws1', alias: 'demo', path: tmp, enabled: true }] };
    activator.register('git', {
        channels: gitHandlers.CHANNELS,
        load: () => gitHandlers,
        init: (mod, { ipcMain }) => mod.initialize({ ipcMain, workspaceService, subscriptions, watch: fakeWatch().watch }),
        dispose: mod => mod.dispose(),
        eager: true,
    });

    const [git] = activator.snapshot();
    assert.deepEqual([git.name, git.state, git.channels], ['git', 'active', gitHandlers.CHANNELS.length]);
    assert.equal(electronHandlers.size, 0, 'nothing is registered on electron ipcMain directly');
    assert.deepEqual([...outer.keys()].sort(), [...gitHandlers.CHANNELS].sort());
    // Git 通道在 preload 里和 V工程 的接口放在一起，所以对的是 git: 前缀而不是 preload 的领域名
    const { describeApis } = require('../preloads/core/registry');
    const declared = [...new Set(describeApis().filter(api => String(api.channel).startsWith('git:') && api.kind !== 'subscription').map(api => api.channel))];
    assert.deepEqual(declared.sort(), [...gitHandlers.CHANNELS].sort(), 'every git: channel the preload exposes is forwarded');
    assert.deepEqual(gitHandlers.watchSnapshot(), [], 'activating does not start watching');

    const { event } = fakeWindow();
    const res = await outer.get('git:list-workspaces')(event);
    assert.deepEqual(res, { success: true, data: { workspaces: [{ id: 'ws1', alias: 'demo', path: tmp }], activeWorkspaceId: null } });
    assert.equal(activator.snapshot()[0].calls, 1);
});

const gitAvailable = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a real repository: a subscribed window hears about an edited file and a new commit', { skip: gitAvailable ? false : 'git 不可用', timeout: 60_000 }, async t => {
    const { gitHandlers, handlers } = loadGitHandlers();
    const subscriptions = createStateSubscriptions({ logger: quiet });
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-watch-repo-')));
    t.after(() => { gitHandlers.dispose(); subscriptions.dispose(); fs.rmSync(repo, { recursive: true, force: true }); });
    const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);

    const workspaceService = { list: () => [{ id: 'ws1', alias: 'demo', path: repo, enabled: true }] };
    gitHandlers.initialize({ workspaceService, subscriptions });
    const { sender, event } = fakeWindow();
    subscriptions.subscribe(sender, gitHandlers.STATUS_TOPIC, 'ws1');
    for (let i = 0; i < 50 && gitHandlers.watchSnapshot()[0]?.mode === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const mode = gitHandlers.watchSnapshot()[0]?.mode;
    assert.ok(['files', 'metadata'].includes(mode), `watching (${mode})`);

    const waitForPush = async (count, ms = 8000) => {
        const until = Date.now() + ms;
        while (sender.sent.length < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
        return sender.sent.length >= count;
    };
    // 等上一步彻底报完：监听里没有待报的一批，且一段时间没有新推送。
    // 固定等待不够：git commit 会陆续写很多文件，元数据批次最长可拖到 maxWaitMs（5s），
    // 机器忙时上一步的第二次推送会落到下一步的基线之后
    const waitForIdle = async (quietMs = 2000, ms = 20_000) => {
        const until = Date.now() + ms;
        let seen = sender.sent.length;
        let quietSince = Date.now();
        while (Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 50));
            if (sender.sent.length !== seen || gitHandlers.watchSnapshot()[0]?.pending) {
                seen = sender.sent.length;
                quietSince = Date.now();
            } else if (Date.now() - quietSince >= quietMs) return;
        }
        assert.fail('the watcher never went quiet');
    };

    // 编辑工作区文件：Linux 上只监听 .git，不要求能听到
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    if (mode === 'files') assert.equal(await waitForPush(1), true, 'an edited file is pushed');
    await waitForIdle();
    const afterEdit = sender.sent.length;

    // 在应用外（命令行）提交：index / refs 变了
    git(['commit', '-q', '-am', 'second']);
    assert.equal(await waitForPush(afterEdit + 1), true, 'an outside commit is pushed');
    assert.equal(sender.sent.every(([channel, payload]) => channel === 'git:changed' && payload.workspaceId === 'ws1'), true);

    // 应用内操作推送原因
    await waitForIdle();
    const beforeStage = sender.sent.length;
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
    const staged = await handlers.get('git:stage')(event, 'ws1', ['b.txt']);
    assert.equal(staged.success, true, staged.error);
    assert.deepEqual(sender.sent[beforeStage], ['git:changed', { workspaceId: 'ws1', reason: 'stage' }]);
    // stage 写 index 的事件不会在 300ms 后再推一次（b.txt 的写入发生在通知之前，也已包含）
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.deepEqual(sender.sent.slice(beforeStage).map(([, payload]) => payload.reason), ['stage']);
});

test('a repository the app can only partly watch tells subscribed windows, and later windows learn it on subscribing', { skip: gitAvailable ? false : 'git 不可用', timeout: 20_000 }, async t => {
    const { gitHandlers } = loadGitHandlers();
    const { watch } = fakeWatch();
    const subscriptions = createStateSubscriptions({ logger: quiet });
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-watch-degraded-')));
    t.after(() => { gitHandlers.dispose(); subscriptions.dispose(); fs.rmSync(repo, { recursive: true, force: true }); });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    const workspaceService = { list: () => [{ id: 'ws1', alias: 'demo', path: repo, enabled: true }] };
    // 工作区目录挂不上，只剩 .git
    const partialWatch = (dir, options, listener) => {
        if (path.resolve(dir) === repo) throw new Error('EMFILE');
        return watch(dir, options, listener);
    };
    gitHandlers.initialize({ workspaceService, subscriptions, watch: partialWatch });

    const a = fakeWindow();
    assert.deepEqual(subscriptions.subscribe(a.sender, gitHandlers.STATUS_TOPIC, 'ws1'), { success: true, state: { degraded: false } });
    for (let i = 0; i < 50 && !a.sender.sent.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(a.sender.sent, [['git:changed', { workspaceId: 'ws1', reason: 'watch-degraded', degraded: true }]]);

    const b = fakeWindow();
    assert.deepEqual(subscriptions.subscribe(b.sender, gitHandlers.STATUS_TOPIC, 'ws1'), { success: true, state: { degraded: true } });
});

test('on Linux the git directory is watched shallowly and refs/ recursively, never the whole object store', async () => {
    const { watch, opened } = fakeWatch();
    const root = path.resolve('/repo');
    const gitDir = path.join(root, '.git');
    const watcher = createGitWatcher({
        getTargets: async () => ({ root, gitDirs: [gitDir] }),
        onChange: () => {},
        watch, platform: 'linux', logger: quiet, exists: dir => dir === path.join(gitDir, 'refs'),
    });
    await watcher.start('ws1');
    assert.deepEqual(opened.map(item => [item.dir, item.options?.recursive]), [
        [gitDir, false],
        [path.join(gitDir, 'refs'), true]
    ]);
    watcher.dispose();
});

test('on Linux a linked worktree also watches its own git dir, where its index and HEAD live', async () => {
    const { watch, opened, emit } = fakeWatch();
    const common = path.resolve('/repo/.git');
    const own = path.join(common, 'worktrees', 'feature');
    const changes = [];
    const watcher = createGitWatcher({
        getTargets: async () => ({ root: path.resolve('/wt'), gitDirs: [own, common] }),
        onChange: id => changes.push(id),
        watch, platform: 'linux', logger: quiet, exists: dir => dir === path.join(common, 'refs'),
    });
    await watcher.start('ws1');
    assert.deepEqual(opened.map(item => [item.dir, item.options?.recursive]), [
        [own, false],
        [common, false],
        [path.join(common, 'refs'), true]
    ]);
    emit(own, 'index'); // git add 在 worktree 里
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(changes, ['ws1']);
    watcher.dispose();
});
