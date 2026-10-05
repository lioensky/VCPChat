import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

import { createGitFileDiffResolver, findStatusItem, normalizeFsPath, toWorkspaceRelative } from '../modules/ui-system/git-file-diff.js';
import { createMessageFileChanges } from '../modules/ui-system/message-file-changes.js';
import { createPlanDetailSideProvider } from '../modules/ui-system/side-pane/planDetailSideProvider.js';

const require = createRequire(import.meta.url);
const gitService = require('../modules/services/gitService.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (check()) return true;
        await wait(30);
    }
    return false;
}

function backedApi(workspaces, calls = []) {
    const wrap = async (name, fn) => {
        calls.push(name);
        try { return { success: true, data: await fn() }; } catch (error) { return { success: false, error: error.message }; }
    };
    const rootOf = id => workspaces.find(ws => ws.id === id).path;
    return {
        gitListWorkspaces: () => wrap('list', () => ({ workspaces, activeWorkspaceId: workspaces[0]?.id || null })),
        gitStatus: id => wrap('status', () => gitService.getStatus(rootOf(id))),
        gitDiff: (id, rel, options = {}) => wrap('diff', () => gitService.getDiff(rootOf(id), rel, options))
    };
}

function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-file-diff-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'committed.js'), 'x\n');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'one\nTWO\nthree\nfour\n');
    fs.writeFileSync(path.join(repo, 'fresh.js'), 'a\nb\n');
    fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 255]));
    return { root, repo };
}

test('path helpers: separators, case, longest workspace root and suffix matching', () => {
    assert.equal(normalizeFsPath('.\\src\\a.js'), 'src/a.js');
    const workspaces = [{ id: 'a', path: 'D:\\work' }, { id: 'b', path: 'D:\\work\\sub' }];
    assert.deepEqual(toWorkspaceRelative('d:/WORK/sub/x/y.js', workspaces), { workspace: workspaces[1], relPath: 'x/y.js' });
    assert.equal(toWorkspaceRelative('D:/worker/x.js', workspaces), null, 'sibling folder with the same prefix is not inside');
    assert.equal(toWorkspaceRelative('src/a.js', workspaces), null, 'relative paths have no workspace');
    const status = { isRepo: true, changes: [{ path: 'src/a.js' }], staged: [{ path: 'src/b.js' }], conflicts: [] };
    assert.equal(findStatusItem(status, 'SRC/A.JS').staged, false);
    assert.equal(findStatusItem(status, 'proj/src/b.js').staged, true);
    assert.equal(findStatusItem(status, 'a.js').path, 'src/a.js', 'a unique suffix matches');
    const ambiguous = { isRepo: true, changes: [{ path: 'x/a.js' }, { path: 'y/a.js' }], staged: [], conflicts: [] };
    assert.equal(findStatusItem(ambiguous, 'a.js'), null, 'an ambiguous suffix does not guess');
    assert.equal(findStatusItem(ambiguous, 'y/a.js').path, 'y/a.js');
    assert.equal(findStatusItem({ isRepo: false }, 'src/a.js'), null);
});

test('resolver reads +N -N from a real repository and distinguishes clean / outside / binary', async () => {
    const { repo } = makeRepo();
    const calls = [];
    const resolver = createGitFileDiffResolver({ api: backedApi([{ id: 'ws1', alias: 'demo', path: repo }], calls) });

    const edited = await resolver.resolve(path.join(repo, 'src', 'a.js'));
    assert.equal(edited.state, 'ready');
    assert.deepEqual([edited.added, edited.removed], [2, 1]);
    assert.equal(edited.path, 'src/a.js');

    const untracked = await resolver.resolve(path.join(repo, 'fresh.js').replace(/\\/g, '/'));
    assert.deepEqual([untracked.state, untracked.added, untracked.removed], ['ready', 2, 0]);

    assert.equal((await resolver.resolve(path.join(repo, 'committed.js'))).state, 'clean');
    assert.equal((await resolver.resolve(path.join(repo, 'bin.dat'))).state, 'unavailable');
    assert.equal(await resolver.resolve(path.join(os.tmpdir(), 'elsewhere', 'x.js')), null);

    // relative paths are matched against each workspace's status by suffix
    const relative = await resolver.resolve('src/a.js');
    assert.equal(relative.state, 'ready');
    assert.equal(await resolver.resolve('nope/missing.js'), null);

    // status and diff results are cached briefly so a long summary does not hammer git
    const before = calls.filter(name => name === 'status').length;
    await resolver.resolve(path.join(repo, 'src', 'a.js'));
    assert.equal(calls.filter(name => name === 'status').length, before);
});

test('resolver degrades quietly without a git api, without workspaces and outside a repository', async () => {
    assert.equal(await createGitFileDiffResolver({ api: null }).resolve('C:/x.js'), null);
    assert.equal(await createGitFileDiffResolver({ api: backedApi([]) }).resolve('C:/x.js'), null);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-not-a-repo-'));
    fs.writeFileSync(path.join(plain, 'a.txt'), 'x');
    const resolver = createGitFileDiffResolver({ api: backedApi([{ id: 'w', alias: 'plain', path: plain }]) });
    assert.equal(await resolver.resolve(path.join(plain, 'a.txt')), null);
});

const toolBlock = (command, filePath) => `<<<[TOOL_REQUEST]>>>\ntool_name:「始」FileOperator「末」,\ncommand:「始」${command}「末」,\npath:「始」${filePath}「末」\n<<<[END_TOOL_REQUEST]>>>`;

test('file summary fetches stats only when expanded and opens the diff from the counts', async () => {
    const { repo } = makeRepo();
    const resolver = createGitFileDiffResolver({ api: backedApi([{ id: 'ws1', alias: 'demo', path: repo }]) });
    const dom = new JSDOM('<div id="chatMessages"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    const requested = [];
    const diffs = [];
    const content = [toolBlock('WriteFile', path.join(repo, 'src', 'a.js')), toolBlock('WriteFile', path.join(repo, 'committed.js')), toolBlock('WriteFile', 'Z:/not/in/workspace.js')].map(request => request + '\n[[VCP调用结果信息汇总:- 工具名称: FileOperator\n- 执行状态: success\n- 返回内容: okVCP调用结果结束]]').join('\n');
    const controller = createMessageFileChanges({
        document: doc,
        messagesRoot: root,
        getHistory: () => [{ id: 'm1', role: 'assistant', content }],
        getDiffStats: async (filePath) => { requested.push(filePath); return resolver.resolve(filePath); },
        openDiff: filePath => diffs.push(filePath)
    });
    controller.mount();
    const item = doc.createElement('div');
    item.className = 'message-item assistant';
    item.dataset.messageId = 'm1';
    item.innerHTML = '<div class="details-and-bubble-wrapper"><div class="md-content">x</div></div>';
    root.appendChild(item);
    await wait(60);
    const panel = root.querySelector('.vcp-file-changes');
    assert.ok(panel);
    assert.deepEqual(requested, [], 'nothing is queried while collapsed');

    panel.open = true;
    panel.dispatchEvent(new dom.window.Event('toggle'));
    assert.ok(await waitFor(() => panel.querySelector('.vcp-file-changes-counts')));
    const rows = [...panel.querySelectorAll('li')];
    assert.equal(rows[0].querySelector('.text-diff-added').textContent, '+2');
    assert.equal(rows[0].querySelector('.text-diff-removed').textContent, '-1');
    assert.equal(rows[1].querySelector('.vcp-file-changes-stats').textContent, '无未提交改动');
    assert.equal(rows[2].querySelector('.vcp-file-changes-stats').textContent, '', 'files outside any workspace show nothing');

    rows[0].querySelector('.vcp-file-changes-counts').click();
    assert.deepEqual(diffs, [path.join(repo, 'src', 'a.js')]);

    panel.dispatchEvent(new dom.window.Event('toggle'));
    await wait(30);
    assert.equal(requested.length, 3, 'stats are requested once per panel');
    controller.dispose();
});

test('opening the plan tab on its Git page with a focus path expands that file, both for a new and an already-mounted tab', async () => {
    const { repo } = makeRepo();
    git(repo, 'add', 'fresh.js');
    const win = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true }).window;
    const view = win.document.getElementById('host');
    const api = backedApi([{ id: 'ws1', alias: 'demo', path: repo }]);
    let mounted = null;
    const opened = [];
    const sidePaneController = {
        getSnapshot: () => ({ parent: null, tabs: [] }),
        getTabHandle: () => mounted,
        openTab: async (descriptor) => {
            opened.push(descriptor.id);
            if (!mounted) mounted = await provider.mountTab(descriptor, view);
            return mounted;
        },
        updateTab() {},
        setVisible() {}
    };
    const provider = createPlanDetailSideProvider({ document: win.document, api, sidePaneController });
    const expandedPaths = () => [...view.querySelectorAll('.side-git-row.is-expanded')].map(row => row.closest('.side-git-card').dataset.path);
    const selectedPage = () => view.querySelector('.side-plan-page-tab[aria-selected="true"]')?.dataset.planPage;
    try {
        // no V工程 project exists, the Git page still opens; the new tab picks up the focus (an unstaged file)
        await provider.openPlanDetailTab({ page: 'git', focusPath: path.join(repo, 'src', 'a.js') });
        assert.deepEqual(opened, ['plan-detail:none']);
        assert.ok(await waitFor(() => expandedPaths().join() === 'src/a.js'));
        assert.ok(await waitFor(() => view.querySelector('[data-path="src/a.js"] .side-git-diff-table')));
        assert.equal(view.querySelector('.side-git-source-select').value, 'unstaged');
        assert.equal(selectedPage(), 'git');
        assert.equal(view.querySelector('.side-plan-title').textContent, '选择工程');

        // back on the plan page, then the already-mounted tab is asked for a staged file
        view.querySelector('[data-plan-page="plan"]').click();
        assert.equal(selectedPage(), 'plan');
        await provider.openPlanDetailTab({ page: 'git', focusPath: path.join(repo, 'fresh.js') });
        assert.equal(selectedPage(), 'git');
        assert.ok(await waitFor(() => expandedPaths().join() === 'fresh.js'));
        assert.equal(view.querySelector('.side-git-source-select').value, 'staged');
        assert.equal(view.querySelectorAll('.side-git-container').length, 1, 'the Git view is mounted once');
    } finally {
        mounted?.dispose();
    }
});
