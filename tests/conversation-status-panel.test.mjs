import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    buildCommitMessage,
    createConversationStatusPanel,
    filterBranches,
    formatShortcutLabel,
    getTodoFocusWindow,
    mapTodoItems,
    parseSwitchBlockedFiles,
    pickMiniMetric,
    pickProjectsForWorkspace,
    pickEntryMetric,
    resolveVariant
} from '../modules/ui-system/conversation-status-panel.js';
import { getProjectForgeChangesSource } from '../modules/ui-system/sources/projectforge-changes.js';
import { getGitChangesSource } from '../modules/ui-system/sources/git-changes.js';
import { selectGitWorkspace } from '../modules/ui-system/sources/git-workspace.js';
import { layoutGitGraph, parseGraphRefs } from '../modules/ui-system/git-graph-layout.js';
import { getCommandRunsSource } from '../modules/ui-system/sources/terminal-command-runs.js';

const WS = { id: 'ws1', alias: 'core', path: '/code/core' };

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

function setup({ variant = 'panel', api: overrides = {}, todos, panelOptions = {} } = {}) {
    const dom = new JSDOM('<body><main class="main-content"><header></header><div class="chat-messages-container"></div></main></body>', { url: 'http://localhost/' });
    if (variant) dom.window.localStorage.setItem('vcp-status-panel-variant', variant);
    const calls = [];
    let summary = { files: 2, added: 5, removed: 1, branch: { head: 'main', ahead: 1, behind: 0, upstream: 'origin/main' }, remotes: ['origin'] };
    const graph = [
        { hash: 'c3c3c3c', parents: ['b2b2b2b'], author: 'Roxy', time: 1790000000, subject: '第三个提交', refs: ['HEAD -> main', 'origin/main'] },
        { hash: 'b2b2b2b', parents: ['a1a1a1a'], author: 'Roxy', time: 1789990000, subject: '第二个提交', refs: ['tag: v1'] },
        { hash: 'a1a1a1a', parents: [], author: 'Roxy', time: 1789980000, subject: '初始提交', refs: [] }
    ];
    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [WS], activeWorkspaceId: null } }),
        gitChangeSummary: async () => ({ success: true, data: summary }),
        gitListBranches: async () => ({ success: true, data: { current: 'main', branches: [{ name: 'main', current: true }, { name: 'dev', current: false }] } }),
        gitSwitchBranch: async (id, name) => {
            calls.push(['switch', id, name]);
            summary = { ...summary, branch: { ...summary.branch, head: name } };
            return { success: true, data: { ok: true, status: { branch: { head: name } } } };
        },
        gitCreateBranch: async (id, name) => { calls.push(['create', id, name]); return { success: true, data: { ok: true, status: { branch: { head: name } } } }; },
        gitStatus: async () => ({ success: true, data: { staged: [], changes: [{ path: 'a.js' }, { path: 'a.js' }, { path: 'b.js' }] } }),
        gitStage: async (id, paths) => { calls.push(['stage', id, paths]); return { success: true, data: {} }; },
        gitCommit: async (id, payload) => { calls.push(['commit', id, payload.message]); return { success: true, data: { commit: 'abc1234' } }; },
        gitPush: async (id, payload) => { calls.push(['push', payload]); return { success: true, data: {} }; },
        gitCommitGraph: async (id, options) => { calls.push(['graph', options]); return { success: true, data: { commits: graph, hasMore: false } }; },
        projectForgeListProjects: async () => ({ success: true, data: [
            { id: 'p1', name: '工程一', workspace_id: 'ws1', updated_at: '2026-09-30T10:00:00Z' },
            { id: 'p2', name: '别的工作区', workspace_id: 'other', updated_at: '2026-09-30T11:00:00Z' }
        ] }),
        projectForgeGetProject: async () => ({ success: true, data: { todos: todos || [
            { seq: 1, title: '写测试', status: 'done' },
            { seq: 2, title: '收尾', status: 'doing' },
            { seq: 3, title: '发布', status: 'pending' }
        ] } }),
        onProjectForgeChanged: () => () => {},
        ...overrides
    };
    getCommandRunsSource(api, { graceMs: 0 });
    const doc = dom.window.document;
    const opened = [];
    const panel = createConversationStatusPanel({
        document: doc,
        api,
        onOpenGitTab: () => opened.push('git'),
        onOpenPlanDetail: (project, focus) => opened.push(['plan', project?.id, focus ?? null]),
        onOpenToolOutput: run => opened.push(['run', run.id]),
        uiHelper: { showToastNotification: (message, type) => calls.push(['toast', type, message]) },
        ...panelOptions
    });
    return { dom, doc, panel, calls, opened, api };
}

const q = (root, selector) => root.querySelector(selector);
const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

test('helpers: branch filtering, project selection, todo mapping and commit message', () => {
    assert.deepEqual(filterBranches([{ name: 'main' }, { name: 'Feature/a' }], 'feat').map(b => b.name), ['Feature/a']);
    assert.equal(filterBranches([{ name: 'main' }], '').length, 1);

    const projects = [
        { id: 'a', workspace_id: 'w1', updated_at: '2026-01-01' },
        { id: 'b', workspace_id: 'w1', updated_at: '2026-02-01' },
        { id: 'c', workspace_id: 'w2', updated_at: '2026-03-01' },
        { id: 'd', workspace_id: 'w1', updated_at: '2026-04-01', deleted_at: 'x' }
    ];
    assert.deepEqual(pickProjectsForWorkspace(projects, { id: 'w1' }).map(p => p.id), ['b', 'a']);
    assert.deepEqual(pickProjectsForWorkspace(projects, null), []);

    assert.deepEqual(mapTodoItems([
        { seq: 1, title: 'a', status: 'done' }, { seq: 2, title: 'b', status: 'doing' },
        { seq: 3, title: 'c', status: 'pending' }, { seq: 4, title: 'd', status: 'blocked' }
    ]).map(i => [i.status, i.blocked]), [['completed', false], ['inProgress', false], ['pending', false], ['pending', true]]);

    assert.equal(buildCommitMessage([]), '');
    assert.equal(buildCommitMessage(['src/a.js', 'b.js']), '更新 a.js、b.js');
    assert.equal(buildCommitMessage(['1', '2', '3', '4']), '更新 1、2 等 4 个文件');
});

test('helpers: todo focus window, mini metric, variant and switch-blocked parsing', () => {
    const items = n => Array.from({ length: n }, (_, i) => ({ id: String(i), content: `t${i}`, status: 'pending' }));
    assert.equal(getTodoFocusWindow(items(6)).compact, false);

    const many = items(10).map((item, i) => ({ ...item, status: i < 4 ? 'completed' : (i === 4 ? 'inProgress' : 'pending') }));
    const win = getTodoFocusWindow(many);
    assert.equal(win.compact, true);
    assert.deepEqual(win.focusItems.map(i => i.id), ['4', '5', '6']);
    assert.equal(win.precedingItems.length, 4);
    assert.equal(win.followingItems.length, 3);

    assert.equal(pickMiniMetric({ items: [{ content: '收尾', status: 'inProgress' }], git: { added: 1, removed: 0 } }).kind, 'current');
    assert.equal(pickMiniMetric({ items: [], git: { added: 1, removed: 0 } }).kind, 'changes');
    assert.equal(pickMiniMetric({ items: [{ content: 'x', status: 'completed' }], git: { added: 0, removed: 0 } }).kind, 'completed');
    assert.equal(pickMiniMetric({ items: [], git: null }), null);
    assert.deepEqual(pickMiniMetric({ items: [], git: { added: 0, removed: 0, branch: { head: 'main' } } }), { kind: 'branch', icon: 'git-branch', text: 'main' });

    assert.equal(resolveVariant({ override: 'mini', width: 2000 }), 'mini');
    assert.equal(resolveVariant({ width: 1280 }), 'panel');
    assert.equal(resolveVariant({ width: 1058 }), 'mini');
    assert.equal(resolveVariant({ width: 400 }), 'mini');

    const blocked = parseSwitchBlockedFiles('error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.js\n\tb.js\nPlease commit');
    assert.deepEqual(blocked, { files: ['src/a.js', 'b.js'], untracked: false });
    assert.equal(parseSwitchBlockedFiles('别的错误'), null);
    assert.equal(formatShortcutLabel(true), '⌘ ⏎');
    assert.equal(formatShortcutLabel(false), 'CTRL+⏎');
});

test('git graph layout: linear history stays on one lane, merges add a lane', () => {
    const linear = layoutGitGraph([
        { hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }
    ]);
    assert.equal(linear.laneCount, 1);
    assert.deepEqual(linear.rows.map(r => r.laneIndex), [0, 0, 0]);
    assert.equal(linear.rows[1].y - linear.rows[0].y, linear.rowHeight);

    const merge = layoutGitGraph([
        { hash: 'm', parents: ['a', 'b'] }, { hash: 'a', parents: ['root'] }, { hash: 'b', parents: ['root'] }, { hash: 'root', parents: [] }
    ]);
    assert.ok(merge.laneCount >= 2);
    assert.ok(merge.paths.length >= 3);

    // 分页窗口外的 parent 不应画出通向窗口底部的线
    const paged = layoutGitGraph([{ hash: 'x', parents: ['outside'] }]);
    assert.equal(paged.paths.length, 0);

    assert.deepEqual(parseGraphRefs(['HEAD -> main', 'tag: v1', 'origin/main', 'dev']), [
        { name: 'main', kind: 'head' }, { name: 'v1', kind: 'tag' }, { name: 'origin/main', kind: 'remote' }, { name: 'dev', kind: 'branch' }
    ]);
});

test('panel renders Git 变更 rows and 计划 from V工程 todos, with mini capsule fallback', async () => {
    const { doc, panel, opened, dom } = setup();
    panel.mount();
    await flush();

    const layer = q(doc, '.zc-status-layer');
    assert.equal(layer.hidden, false);
    assert.equal(q(doc, '.zc-status').dataset.displayMode, 'panel');
    assert.match(layer.textContent, /Git 变更/);
    assert.match(layer.textContent, /更改/);
    assert.match(layer.textContent, /\+5/);
    assert.match(layer.textContent, /-1/);
    assert.match(layer.textContent, /main/);
    assert.match(layer.textContent, /提交或推送/);
    assert.match(layer.textContent, /计划/);
    assert.match(layer.textContent, /1\/3/);
    assert.match(layer.textContent, /写测试/);
    assert.equal(layer.querySelectorAll('[data-plan-status="inProgress"]').length, 1);

    click(dom, [...layer.querySelectorAll('.zc-row')].find(r => r.textContent.includes('更改')));
    assert.deepEqual(opened, ['git']);
    const detail = q(layer, '.zc-section-action');
    assert.equal(detail.getAttribute('aria-label'), '打开计划详情');
    assert.equal(layer.querySelectorAll('[data-status-section="plan"] .zc-section-action').length, 1, '计划只留一个入口，不再直接开 V工程 页');
    click(dom, detail);
    assert.deepEqual(opened, ['git', ['plan', 'p1', null]]);
    assert.equal(q(layer, '.zc-plan-activity'), null, '不跟话题的面板没有话题批次');

    // 分区折叠
    click(dom, q(layer, '[data-status-section-trigger="git"]'));
    assert.equal(layer.querySelectorAll('.zc-row').length, 0);
    assert.match(q(layer, '[data-status-section="environment"]').textContent, /\+5\s*-1/);

    // 收起为胶囊
    click(dom, q(layer, '.zc-status-collapse'));
    assert.equal(q(doc, '.zc-status').dataset.displayMode, 'mini');
    assert.match(q(layer, '.zc-mini').textContent, /收尾/);
    assert.equal(dom.window.localStorage.getItem('vcp-status-panel-variant'), 'mini');
    click(dom, q(layer, '.zc-mini'));
    assert.equal(q(doc, '.zc-status').dataset.displayMode, 'panel');

    panel.dispose();
    assert.equal(q(doc, '.zc-status-layer'), null);
});

test('the expanded panel floats over the message column without pushing it aside', async () => {
    const { doc, dom, panel } = setup();
    const messages = doc.createElement('div');
    messages.id = 'chatMessages';
    messages.className = 'chat-messages';
    q(doc, '.chat-messages-container').appendChild(messages);
    panel.mount();
    await flush();
    assert.equal(q(doc, '.zc-status').dataset.displayMode, 'panel');
    assert.equal(messages.className, 'chat-messages');
    assert.equal(messages.getAttribute('style'), null);

    click(dom, q(doc, '.zc-status-collapse'));
    click(dom, q(doc, '.zc-mini'));
    assert.equal(messages.getAttribute('style'), null);
    panel.dispose();
    dom.window.close();
});

test('without git or todos the panel stays as an entry capsule that opens the Git tab', async () => {
    const { doc, dom, panel, opened } = setup({ api: {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [], activeWorkspaceId: null } })
    } });
    panel.mount();
    await flush();
    assert.equal(q(doc, '.zc-status-layer').hidden, false);
    const entry = q(doc, '.zc-mini-entry');
    assert.match(entry.textContent, /添加工作区/);
    click(dom, entry);
    assert.deepEqual(opened, ['git']);
    panel.dispose();
});

test('a workspace that is not a git repo shows a Git 变更 entry instead of disappearing', async () => {
    const { doc, panel } = setup({ api: {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [{ id: 'w', alias: 'demo', path: '/x' }], activeWorkspaceId: 'w' } }),
        gitChangeSummary: async () => ({ success: false, error: 'not a repo' }),
        projectForgeListProjects: async () => ({ success: true, data: [] })
    } });
    panel.mount();
    await flush();
    assert.match(q(doc, '.zc-mini-entry').textContent, /Git 变更/);
    panel.dispose();
});

test('pickEntryMetric asks for a workspace first', () => {
    assert.equal(pickEntryMetric({ workspaceCount: 0 }).text, '添加工作区');
    assert.equal(pickEntryMetric({ workspaceCount: 1, hasWorkspace: true }).text, 'Git 变更');
});

test('branch popover filters, switches and offers create / graph in the footer', async () => {
    const { doc, panel, calls, dom } = setup();
    panel.mount();
    await flush();

    const trigger = q(doc, '.zc-row-branch');
    click(dom, trigger);
    await flush();
    const pop = q(doc, '.zc-branch-popover');
    assert.ok(pop);
    assert.equal(pop.querySelectorAll('.zc-branch-item').length, 2);
    assert.equal(q(pop, '.zc-branch-item[data-checked="true"]').dataset.branch, 'main');
    assert.match(pop.textContent, /创建并检出新分支/);
    assert.match(pop.textContent, /Git 图谱/);
    assert.match(q(pop, '.zc-branch-dirty').textContent, /2 个文件/);

    const input = q(pop, '.zc-command-input');
    input.value = 'de';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(pop.querySelectorAll('.zc-branch-item').length, 1);

    click(dom, q(pop, '.zc-branch-item'));
    await flush();
    await flush();
    assert.deepEqual(calls.find(c => c[0] === 'switch'), ['switch', 'ws1', 'dev']);
    assert.match(q(doc, '.zc-row-branch').textContent, /dev/);
    assert.equal(q(doc, '.zc-branch-popover'), null);
    panel.dispose();
});

test('an agent changing files while the branch popover is open neither closes it nor makes the next click do nothing', async () => {
    let added = 5;
    let branchListGate = null;
    const { doc, panel, dom } = setup({ api: {
        gitChangeSummary: async () => ({ success: true, data: { files: 2, added: added++, removed: 1, branch: { head: 'main', ahead: 0, behind: 0, upstream: 'origin/main' }, remotes: ['origin'] } }),
        gitListBranches: async () => {
            if (branchListGate) await branchListGate.promise;
            return { success: true, data: { current: 'main', branches: [{ name: 'main', current: true }, { name: 'dev', current: false }] } };
        }
    } });
    panel.mount();
    await flush();

    click(dom, q(doc, '.zc-row-branch'));
    await flush();
    const pop = q(doc, '.zc-branch-popover');
    const input = q(pop, '.zc-command-input');
    input.value = 'de';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    await panel.refresh();
    await flush();
    assert.equal(q(doc, '.zc-branch-popover'), pop, 'the popover the user is typing in stays open');
    assert.equal(q(pop, '.zc-command-input').value, 'de');
    assert.match(q(doc, '.zc-status-panel, aside').textContent, /\+5/, 'the panel waits to repaint until the popover closes');

    doc.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    await flush();
    assert.equal(q(doc, '.zc-branch-popover'), null);
    assert.match(q(doc, '.zc-status-panel, aside').textContent, /\+6/, 'the deferred repaint ran once it closed');

    // 点分支按钮时正好来了一次刷新：浮层照样打开
    let release;
    branchListGate = { promise: new Promise(resolve => { release = resolve; }) };
    click(dom, q(doc, '.zc-row-branch'));
    const refreshing = panel.refresh();
    release();
    await refreshing;
    await flush();
    assert.ok(q(doc, '.zc-branch-popover'));
    panel.dispose();
});

test('create-branch dialog creates and switches', async () => {
    const { doc, panel, calls, dom } = setup();
    panel.mount();
    await flush();
    panel.openCreateBranchDialog();
    const dialog = q(doc, '.zc-dialog');
    const submit = q(dialog, 'button[type="submit"]');
    assert.equal(submit.disabled, true);
    const input = q(dialog, 'input');
    input.value = 'feature/x';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(submit.disabled, false);
    q(dialog, 'form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    assert.deepEqual(calls.find(c => c[0] === 'create'), ['create', 'ws1', 'feature/x']);
    assert.equal(q(doc, '.zc-dialog'), null);
    panel.dispose();
});

test('a checkout blocked by local changes opens the commit-and-switch flow', async () => {
    const { doc, panel, calls, dom } = setup({ api: {
        gitSwitchBranch: async () => ({ success: true, data: { ok: false, issues: [{ message: 'error: Your local changes to the following files would be overwritten by checkout:\n\ta.js\n\tb.js\nAborting' }] } })
    } });
    panel.mount();
    await flush();
    click(dom, q(doc, '.zc-row-branch'));
    await flush();
    click(dom, [...doc.querySelectorAll('.zc-branch-item')].find(i => i.dataset.branch === 'dev'));
    await flush();
    await flush();
    const dialog = q(doc, '.zc-dialog');
    assert.match(dialog.textContent, /提交更改以切换分支/);
    assert.match(dialog.textContent, /a\.js/);
    assert.equal(calls.some(c => c[0] === 'toast' && c[1] === 'error'), false);
    panel.dispose();
});

test('commit dialog stages unique paths, commits with a generated message and pushes', async () => {
    const { doc, panel, calls, dom } = setup();
    panel.mount();
    await flush();
    const opening = panel.openCommitDialog();
    await opening;
    await flush();
    const dialog = q(doc, '.zc-commit-dialog');
    assert.ok(dialog);
    assert.match(dialog.textContent, /2 个文件/);
    const actions = [...dialog.querySelectorAll('.zc-commit-action')].map(a => a.dataset.action);
    assert.deepEqual(actions, ['commit', 'commitAndPush', 'push']);

    click(dom, q(dialog, '[data-action="commitAndPush"]'));
    await flush();
    await flush();
    assert.deepEqual(calls.find(c => c[0] === 'stage'), ['stage', 'ws1', ['a.js', 'b.js']]);
    assert.deepEqual(calls.find(c => c[0] === 'commit'), ['commit', 'ws1', '更新 a.js、b.js']);
    assert.ok(calls.some(c => c[0] === 'push'));
    assert.equal(q(doc, '.zc-commit-dialog'), null);
    panel.dispose();
});

test('push dialog sets the upstream automatically for a branch without one', async () => {
    const { doc, panel, calls, dom } = setup({ api: {
        gitChangeSummary: async () => ({ success: true, data: { files: 0, added: 0, removed: 0, branch: { head: 'feat', ahead: 0, behind: 0, upstream: null }, remotes: ['origin'] } })
    } });
    panel.mount();
    await flush();
    // 没有更改、只需推送时，主按钮变成推送
    const primary = q(doc, '.zc-row-commit');
    assert.equal(primary.disabled, false);
    click(dom, primary);
    const dialog = q(doc, '.zc-dialog');
    assert.match(dialog.textContent, /推送更改/);
    click(dom, [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === '推送'));
    await flush();
    await flush();
    assert.deepEqual(calls.find(c => c[0] === 'push'), ['push', { setUpstream: true }]);
    assert.ok(calls.some(c => c[0] === 'toast' && /已推送/.test(c[2])));
    panel.dispose();
});

test('git graph dialog draws commits and lanes', async () => {
    const { doc, panel, calls, dom } = setup();
    panel.mount();
    await flush();
    await panel.openGitGraphDialog();
    const dialog = q(doc, '.zc-graph-dialog');
    assert.match(dialog.textContent, /Git 图谱/);
    assert.match(dialog.textContent, /3 个提交/);
    assert.equal(dialog.querySelectorAll('.zc-graph-row').length, 3);
    assert.equal(dialog.querySelectorAll('circle.zc-graph-node').length, 3);
    assert.ok(dialog.querySelector('.zc-ref-head'));
    assert.ok(dialog.querySelector('.zc-ref-tag'));
    assert.deepEqual(calls.find(c => c[0] === 'graph'), ['graph', { maxCount: 50, skip: 0 }]);

    click(dom, dialog.querySelectorAll('.zc-graph-row')[1]);
    assert.match(q(doc, '.zc-graph-detail').textContent, /b2b2b2b/);
    panel.dispose();
});

test('git graph keeps its scroll position on select and load more; a refresh drops a load more already in flight', async () => {
    const page = (from, count) => Array.from({ length: count }, (_, i) => {
        const n = from + i;
        return { hash: `h${String(n).padStart(6, '0')}`, parents: [`h${String(n + 1).padStart(6, '0')}`], author: 'Roxy', time: 1790000000 - n, subject: `提交 ${n}`, refs: [] };
    });
    let gate = null;
    const { doc, panel, dom } = setup({ api: {
        gitCommitGraph: async (_id, { skip }) => {
            if (gate) await gate.promise;
            return { success: true, data: { commits: page(skip, 50), hasMore: true } };
        }
    } });
    panel.mount();
    await flush();
    await panel.openGitGraphDialog();
    const dialog = q(doc, '.zc-graph-dialog');
    q(dialog, '.zc-graph-scroll').scrollTop = 900;

    click(dom, dialog.querySelectorAll('.zc-graph-row')[30]);
    assert.equal(q(dialog, '.zc-graph-scroll').scrollTop, 900, 'opening a commit detail keeps the list where it was');
    assert.match(q(doc, '.zc-graph-detail').textContent, /h000030/);

    click(dom, q(dialog, '.zc-graph-load-more'));
    await flush();
    assert.equal(dialog.querySelectorAll('.zc-graph-row').length, 100);
    assert.equal(q(dialog, '.zc-graph-scroll').scrollTop, 900, 'loading more keeps the list where it was');

    // 加载更多还没回来时刷新：旧的那页回来后不能追加到刷新后的列表上
    let release;
    gate = { promise: new Promise(resolve => { release = resolve; }) };
    click(dom, q(dialog, '.zc-graph-load-more'));
    click(dom, q(dialog, '.zc-graph-refresh'));
    gate = null;
    release();
    await flush();
    await flush();
    assert.equal(dialog.querySelectorAll('.zc-graph-row').length, 50);
    assert.equal(new Set([...dialog.querySelectorAll('.zc-graph-row')].map(row => row.dataset.hash)).size, 50);
    panel.dispose();
});

test('panel lists recent AI commands from the built-in terminal and opens their output', async () => {
    let push = null;
    let watching = false;
    const now = Date.now();
    const { doc, dom, panel, opened } = setup({ api: {
        terminalListCommandRuns: async () => ({ success: true, data: [
            { id: 'r2', command: 'npm  test', status: 'running', startedAt: now - 1000, endedAt: null },
            { id: 'r1', command: 'git status', status: 'completed', startedAt: now - 5000, endedAt: now - 4000 },
            { id: 'old', command: 'ls', status: 'completed', startedAt: now - 3 * 3600 * 1000, endedAt: now - 3 * 3600 * 1000 }
        ] }),
        terminalWatchCommandRuns: async () => { watching = true; return { success: true }; },
        onTerminalCommandRunChanged: cb => { push = cb; return () => { push = null; }; }
    } });
    panel.mount();
    await flush();
    assert.equal(watching, true);
    const rows = [...doc.querySelectorAll('[data-status-section="runs"] [data-run-id]')];
    assert.deepEqual(rows.map(row => row.dataset.runId), ['r2', 'r1'], 'runs older than the recent window are hidden');
    assert.equal(doc.querySelector('[data-status-section="runs"] .zc-section-title').textContent, '命令输出', 'same name as the side pane tab');
    assert.equal(rows[0].dataset.runStatus, 'running');
    assert.match(rows[0].textContent, /npm test/);

    push({ id: 'r2', command: 'npm  test', status: 'completed', startedAt: now - 1000, endedAt: now });
    push({ id: 'r3', command: 'echo hi', status: 'running', startedAt: now, endedAt: null });
    await flush();
    const after = [...doc.querySelectorAll('[data-status-section="runs"] [data-run-id]')];
    assert.deepEqual(after.map(row => [row.dataset.runId, row.dataset.runStatus]), [['r3', 'running'], ['r2', 'completed'], ['r1', 'completed']]);

    after[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(opened.at(-1), ['run', 'r2']);
    panel.dispose();
    assert.equal(push, null, 'the run subscription is released on dispose');
});

test('the panel shows up for running commands even without git or a plan', async () => {
    const { doc, panel } = setup({ api: {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [], activeWorkspaceId: null } }),
        terminalListCommandRuns: async () => ({ success: true, data: [{ id: 'r1', command: 'sleep 5', status: 'running', startedAt: Date.now(), endedAt: null }] }),
        onTerminalCommandRunChanged: () => () => {}
    } });
    panel.mount();
    await flush();
    assert.equal(q(doc, '.zc-status-layer').hidden, false);
    assert.equal(doc.querySelectorAll('[data-status-section]').length, 1);
    panel.dispose();
});

// ---------------------------------------------------------------- 面板跟着会话走

const REQ = body => `<<<[TOOL_REQUEST]>>>
${body}
<<<[END_TOOL_REQUEST]>>>`;
const forgeCall = projectId => REQ(`tool_name:「始」ProjectForge「末」,
command:「始」GetProject「末」,
projectId:「始」${projectId}「末」`);
const psCall = command => REQ(`tool_name:「始」PowerShellExecutor「末」,
command:「始」${command}「末」`);

function scopedSetup({ history, api = {}, panelOptions = {} }) {
    const conversation = { history, switchListeners: new Set(), historyListeners: new Set() };
    const made = setup({
        api,
        panelOptions: {
            ...panelOptions,
            getHistory: () => conversation.history,
            onConversationChange: cb => { conversation.switchListeners.add(cb); return () => conversation.switchListeners.delete(cb); },
            onHistoryChange: cb => { conversation.historyListeners.add(cb); return () => conversation.historyListeners.delete(cb); }
        }
    });
    const switchTo = async history => {
        conversation.history = history;
        conversation.switchListeners.forEach(cb => cb());
        await flush();
    };
    return { ...made, switchTo, conversation };
}

test('the title bar button shows only when the panel has something to show and hides or reopens it', async () => {
    const addToggle = doc => {
        const btn = doc.createElement('button');
        btn.id = 'toggleStatusPanelBtn';
        btn.hidden = true;
        q(doc, 'header').appendChild(btn);
        return btn;
    };
    const first = setup();
    const btn = addToggle(first.doc);
    const panel = createConversationStatusPanel({ document: first.doc, api: first.api, onOpenGitTab: () => {}, toggleButton: btn });
    panel.mount();
    await flush();
    const layer = q(first.doc, '.zc-status-layer');
    assert.equal(btn.hidden, false);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(layer.hidden, false);

    click(first.dom, btn);
    assert.equal(layer.hidden, true, '点按钮把面板藏起来');
    assert.equal(btn.hidden, false, '按钮还在，用来再打开');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(btn.getAttribute('aria-label'), '显示状态面板');
    assert.equal(first.dom.window.localStorage.getItem('vcp-status-panel-hidden'), '1');

    // 数据刷新不会把用户关掉的面板又弹出来
    await panel.refresh();
    assert.equal(layer.hidden, true);
    panel.dispose();
    assert.equal(btn.hidden, true, '面板卸下后按钮跟着藏起来');

    // 关掉的状态记住了：下次挂载仍然是关的
    const again = createConversationStatusPanel({ document: first.doc, api: first.api, onOpenGitTab: () => {}, toggleButton: btn });
    again.mount();
    await flush();
    assert.equal(btn.hidden, false);
    assert.equal(q(first.doc, '.zc-status-layer').hidden, true);
    click(first.dom, btn);
    assert.equal(q(first.doc, '.zc-status-layer').hidden, false);
    assert.equal(first.dom.window.localStorage.getItem('vcp-status-panel-hidden'), null);
    again.dispose();
    first.panel.dispose();
    first.dom.window.close();

    // 跟随会话、这个会话没有任何状态：按钮不出现
    const scoped = scopedSetup({ history: [{ role: 'user', content: '你好' }] });
    const scopedBtn = addToggle(scoped.doc);
    const scopedPanel = createConversationStatusPanel({
        document: scoped.doc, api: scoped.api, toggleButton: scopedBtn,
        getHistory: () => [{ role: 'user', content: '你好' }]
    });
    scopedPanel.mount();
    await flush();
    assert.equal(scopedBtn.hidden, true);
    assert.equal(q(scoped.doc, '.zc-status-layer').hidden, true);
    scopedPanel.dispose();
    scoped.panel.dispose();
    scoped.dom.window.close();
});

test('scoped panel: a conversation that never used a V工程 shows no status at all', async () => {
    const { doc, panel } = scopedSetup({ history: [{ role: 'user', content: '你好' }] });
    panel.mount();
    await flush();
    assert.equal(q(doc, '.zc-status-layer').hidden, true, '没有 V工程 / 命令的会话不该显示别的会话的 Git 和进程');
    panel.dispose();
});

test('scoped panel: a topic without commands or V工程 reads neither the command runs nor Git', async () => {
    const calls = [];
    const { panel, switchTo } = scopedSetup({
        history: [{ role: 'user', content: '你好' }],
        api: {
            gitListWorkspaces: async () => { calls.push('git'); return { success: true, data: { workspaces: [WS], activeWorkspaceId: null } }; },
            terminalListCommandRuns: async () => { calls.push('list'); return { success: true, data: [] }; },
            terminalWatchCommandRuns: async () => { calls.push('watch'); return { success: true }; },
            terminalUnwatchCommandRuns: async () => { calls.push('unwatch'); return { success: true }; },
            onTerminalCommandRunChanged: () => () => {}
        }
    });
    panel.mount();
    await flush();
    assert.deepEqual(calls, [], 'the terminal (and its pty) is not touched for a plain chat');

    await switchTo([{ role: 'assistant', content: psCall('npm test') }]);
    assert.deepEqual(calls, ['watch', 'list'], 'a topic that ran a command starts following the runs, still no Git');

    await switchTo([{ role: 'user', content: '随便聊聊' }]);
    assert.deepEqual(calls, ['watch', 'list', 'unwatch'], 'leaving it releases the runs again');
    panel.dispose();
});

test('scoped panel: only a topic that used a V工程 subscribes to V工程 change pushes', async () => {
    const calls = [];
    const forgeApi = {
        onProjectForgeChanged: () => { calls.push('listen'); return () => calls.push('unlisten'); },
        subscribeMainState: async topic => { calls.push(['subscribe', topic]); },
        unsubscribeMainState: async topic => { calls.push(['unsubscribe', topic]); }
    };
    const { panel, switchTo } = scopedSetup({
        history: [{ role: 'user', content: '你好' }],
        panelOptions: { projectChangesSource: getProjectForgeChangesSource(forgeApi, { graceMs: 0 }) }
    });
    panel.mount();
    await flush();
    assert.deepEqual(calls, [], 'a plain chat does not ask the main process for V工程 pushes');

    await switchTo([{ role: 'assistant', content: forgeCall('p1') }]);
    assert.deepEqual(calls, ['listen', ['subscribe', 'project-forge']]);

    await switchTo([{ role: 'user', content: '随便聊聊' }]);
    assert.deepEqual(calls.slice(2), ['unlisten', ['unsubscribe', 'project-forge']]);
    panel.dispose();
});

test('scoped panel: Git pushes follow the shown workspace and refresh it instead of polling', async () => {
    const subs = [];
    const handlers = new Set();
    let summaryCalls = 0;
    const api = {
        gitChangeSummary: async () => { summaryCalls += 1; return { success: true, data: { files: 1, added: 1, removed: 0, branch: { head: 'main' }, remotes: [] } }; },
        onGitChanged: cb => { handlers.add(cb); return () => handlers.delete(cb); },
        subscribeMainState: async (topic, key) => { subs.push(['+', topic, key]); },
        unsubscribeMainState: async (topic, key) => { subs.push(['-', topic, key]); }
    };
    const { panel, switchTo, dom, api: panelApi } = scopedSetup({ history: [{ role: 'user', content: '你好' }], api });
    getGitChangesSource(panelApi, 'ws1', { graceMs: 0 }); // 不留宽限期，dispose 后马上放掉
    const gitSubs = () => subs.filter(entry => entry[1] === 'git.status');
    // JSDOM 默认把文档当作藏着的
    const setHidden = hidden => Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
    setHidden(false);
    panel.mount();
    await flush();
    assert.deepEqual(gitSubs(), [], 'a plain chat does not watch any repository');

    await switchTo([{ role: 'assistant', content: forgeCall('p1') }]);
    assert.deepEqual(gitSubs(), [['+', 'git.status', 'ws1']]);
    const before = summaryCalls;
    handlers.forEach(cb => cb({ workspaceId: 'ws1', reason: 'files' }));
    await flush();
    assert.equal(summaryCalls, before + 1, 'a push re-reads the summary');
    handlers.forEach(cb => cb({ workspaceId: 'other', reason: 'files' }));
    await flush();
    assert.equal(summaryCalls, before + 1, 'pushes for other workspaces are ignored');

    // 页面藏着：先记下，回到前台再读
    setHidden(true);
    handlers.forEach(cb => cb({ workspaceId: 'ws1', reason: 'files' }));
    await flush();
    assert.equal(summaryCalls, before + 1);
    setHidden(false);
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await flush();
    assert.equal(summaryCalls, before + 2);
    // 切回窗口本身不再重读：变化都由推送带来
    dom.window.dispatchEvent(new dom.window.Event('focus'));
    await flush();
    assert.equal(summaryCalls, before + 2, 'focusing the window does not re-read');

    panel.dispose();
    await flush();
    assert.equal(handlers.size, 0, 'disposing stops listening');
});

test('scoped panel: switching conversation swaps the plan, the Git workspace and the command list', async () => {
    const now = Date.now();
    const runs = [
        { id: 'mine', command: 'git status', status: 'completed', startedAt: now - 2000, endedAt: now - 1000 },
        { id: 'theirs', command: 'npm test', status: 'completed', startedAt: now - 2000, endedAt: now - 1000 }
    ];
    const { doc, panel, switchTo } = scopedSetup({
        history: [{ role: 'assistant', content: [forgeCall('p1'), psCall('git status')].join('\n') }],
        api: { terminalListCommandRuns: async () => ({ success: true, data: runs }), onTerminalCommandRunChanged: () => () => {} }
    });
    panel.mount();
    await flush();
    assert.equal(q(doc, '.zc-status-layer').hidden, false);
    assert.equal(doc.querySelectorAll('[data-status-section="plan"]').length, 1, '会话用过的 p1 有进程');
    assert.equal(doc.querySelectorAll('[data-status-section="environment"]').length, 1, 'p1 所在工作区的 Git');
    assert.deepEqual([...doc.querySelectorAll('[data-run-id]')].map(row => row.dataset.runId), ['mine'], '别的会话的命令不出现');

    // 切到一个什么都没碰过的话题：整块消失
    await switchTo([{ role: 'user', content: '随便聊聊' }]);
    assert.equal(q(doc, '.zc-status-layer').hidden, true);
    assert.equal(doc.querySelectorAll('[data-status-section]').length, 0);

    // 切到只发过 npm test 的话题：只剩那一条命令，没有计划和 Git
    await switchTo([{ role: 'assistant', content: psCall('npm test') }]);
    assert.deepEqual([...doc.querySelectorAll('[data-run-id]')].map(row => row.dataset.runId), ['theirs']);
    assert.equal(doc.querySelectorAll('[data-status-section="plan"]').length, 0);
    assert.equal(doc.querySelectorAll('[data-status-section="environment"]').length, 0);
    panel.dispose();
});

test('scoped panel: the plan sums up this topic\'s batches and opens the side pane at the timeline or a todo', async () => {
    const timeline = [
        { id: 12, kind: 'edit', node_count: 2, added: 7, removed: 3, created_at: '2026-09-30 10:05:00' },
        { id: 11, kind: 'edit', node_count: 1, added: 4, removed: 0, created_at: '2026-09-30 09:00:00' },
        { id: 10, kind: 'edit', node_count: 0, added: 0, removed: 0, created_at: '2026-09-30 08:00:00' },
        { id: 9, kind: 'rollback', node_count: 1, added: 1, removed: 2, created_at: '2026-09-30 10:30:00' }
    ];
    const { dom, doc, panel, opened } = scopedSetup({
        history: [{ role: 'assistant', content: `${forgeCall('p1')}\n已施工，批次 \`b12\`。\n批次 \`b10\` 失败。\n批次 \`b77\` 是别的工程的` }],
        api: {
            projectForgeGetProject: async () => ({ success: true, data: {
                todos: [{ id: 't1', title: '写测试', status: 'done' }, { id: 't2', title: '收尾', status: 'doing' }],
                timeline
            } })
        },
        panelOptions: { getTopicKey: () => 'agent:a1:topic1' }
    });
    // 侧栏里回退产生的批次记在话题下，概要也要算上
    dom.window.localStorage.setItem('vcp-projectforge-topic-batches', JSON.stringify({ 'agent:a1:topic1': [9], other: [11] }));
    panel.mount();
    await flush();
    const activity = q(doc, '.zc-plan-activity');
    assert.ok(activity, '计划下有话题批次概要');
    assert.match(activity.textContent, /本话题 2 批/, 'b12 和回退的 b9；没有节点的 b10、别的话题的 b11、不在这个工程的 b77 都不算');
    assert.match(activity.textContent, /\+8/);
    assert.match(activity.textContent, /−5/);
    click(dom, activity);
    assert.deepEqual(opened.at(-1), ['plan', 'p1', { section: 'timeline' }]);

    const todo = [...doc.querySelectorAll('.zc-plan-item')].find(row => row.textContent.includes('收尾'));
    assert.equal(todo.getAttribute('role'), 'button');
    click(dom, todo);
    assert.deepEqual(opened.at(-1), ['plan', 'p1', { todoId: 't2' }]);
    todo.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepEqual(opened.at(-1), ['plan', 'p1', { todoId: 't2' }]);
    assert.equal(opened.filter(entry => entry[0] === 'plan').length, 3);
    panel.dispose();
});

test('scoped panel: a topic with no batches of its own shows the plan without a summary line', async () => {
    const { doc, panel } = scopedSetup({
        history: [{ role: 'assistant', content: forgeCall('p1') }],
        api: { projectForgeGetProject: async () => ({ success: true, data: { todos: [{ id: 't1', title: '写测试', status: 'doing' }], timeline: [{ id: 3, node_count: 1, added: 1, removed: 0 }] } }) }
    });
    panel.mount();
    await flush();
    assert.equal(doc.querySelectorAll('[data-status-section="plan"]').length, 1);
    assert.equal(q(doc, '.zc-plan-activity'), null);
    panel.dispose();
});

test('scoped panel: a project from another workspace brings its own plan but no unrelated Git workspace', async () => {
    const { doc, panel } = scopedSetup({ history: [{ role: 'assistant', content: forgeCall('p2') }] });
    panel.mount();
    await flush();
    assert.equal(doc.querySelectorAll('[data-status-section="plan"]').length, 1);
    assert.equal(doc.querySelectorAll('[data-status-section="environment"]').length, 0, 'p2 的工作区不在 Git 工作区列表里，不拿默认工作区顶替');
    panel.dispose();
});

test('scoped panel: a project mentioned after the history loaded appears without switching', async () => {
    const { doc, panel, conversation } = scopedSetup({ history: [{ role: 'user', content: '开始吧' }] });
    panel.mount();
    await flush();
    assert.equal(q(doc, '.zc-status-layer').hidden, true);

    conversation.history = [...conversation.history, { role: 'assistant', content: forgeCall('p1') }];
    conversation.historyListeners.forEach(cb => cb()); // 当前会话的记录写了一次
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(q(doc, '.zc-status-layer').hidden, false);
    assert.equal(doc.querySelectorAll('[data-status-section="plan"]').length, 1);

    // 卸载后不再挂着记录变化的订阅
    panel.dispose();
    assert.equal(conversation.historyListeners.size, 0);
});

test('switching workspace while staging cannot commit or push the new workspace', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let held = false;
    let current = WS;
    const { panel, doc, dom, calls } = setup({
        api: {
            gitListWorkspaces: async () => ({ success: true, data: { workspaces: [current] } }),
            gitStage: async (id) => {
                calls.push(['stage', id]);
                held = true;
                await gate;
                return { success: true };
            }
        }
    });
    try {
        panel.mount();
        await flush();
        await panel.openCommitDialog();
        click(dom, q(doc, '[data-action="commitAndPush"]'));
        await flush();
        assert.equal(held, true);

        current = { id: 'ws2', alias: 'other', path: '/code/other' };
        await panel.refresh();
        release();
        await flush();

        assert.equal(calls.some(call => call[0] === 'commit' || call[0] === 'push'), false);
        assert.equal(q(doc, '.zc-commit-dialog'), null);
    } finally {
        release();
        panel.dispose();
        dom.window.close();
    }
});

test('a panel that does not follow the conversation shows the workspace picked in the Git tab, also when another window picks one', async () => {
    const WS2 = { id: 'ws2', alias: 'docs', path: '/code/docs' };
    const reads = [];
    const { dom, panel } = setup({ api: {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [WS, WS2], activeWorkspaceId: null } }),
        gitChangeSummary: async id => { reads.push(id); return { success: true, data: { files: 1, added: 1, removed: 0, branch: { head: 'main' }, remotes: [] } }; }
    } });
    const win = dom.window;
    panel.mount();
    await flush();
    assert.deepEqual(reads, ['ws1']);

    selectGitWorkspace(win, 'ws2', { origin: 'git-tab' });
    await flush();
    assert.deepEqual(reads, ['ws1', 'ws2'], 'the Git tab in this window switched');

    // V工程 窗口写了存储：这个窗口只收到 storage 事件
    win.localStorage.setItem('vcp-projectforge-git-workspace', 'ws1');
    win.dispatchEvent(new win.StorageEvent('storage', { key: 'vcp-projectforge-git-workspace', newValue: 'ws1', oldValue: 'ws2' }));
    await flush();
    assert.deepEqual(reads, ['ws1', 'ws2', 'ws1'], 'another window switched');

    win.dispatchEvent(new win.StorageEvent('storage', { key: 'unrelated', newValue: 'x' }));
    await flush();
    assert.equal(reads.length, 3);
    panel.dispose();
});

test('a dialog with a git step in flight ignores Esc and overlay clicks, then finishes the step', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { doc, panel, calls, dom } = setup({ api: {
        gitStage: async (id, paths) => { calls.push(['stage', id, paths]); await gate; return { success: true, data: {} }; }
    } });
    try {
        panel.mount();
        await flush();
        await panel.openCommitDialog();
        click(dom, q(doc, '[data-action="commit"]'));
        await flush();
        doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const overlay = q(doc, '.zc-overlay');
        overlay.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
        assert.ok(q(doc, '.zc-commit-dialog'), 'dialog stays open while staging');
        release();
        await flush();
        assert.ok(calls.some(c => c[0] === 'commit'), 'commit still runs after the ignored Esc');
        assert.equal(q(doc, '.zc-commit-dialog'), null);
    } finally {
        release();
        panel.dispose();
    }
});

test('an idle dialog closes on Esc and returns focus to the element that opened it', async () => {
    const { doc, panel, dom } = setup();
    panel.mount();
    await flush();
    const opener = doc.createElement('button');
    doc.body.appendChild(opener);
    opener.focus();
    panel.openCreateBranchDialog();
    assert.notEqual(doc.activeElement, opener);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(q(doc, '.zc-dialog'), null);
    assert.equal(doc.activeElement, opener);
    panel.dispose();
});

test('Tab inside a dialog wraps around instead of reaching the chat behind it', async () => {
    const { doc, panel, dom } = setup();
    panel.mount();
    await flush();
    panel.openCreateBranchDialog();
    const dialog = q(doc, '.zc-dialog');
    const input = q(dialog, 'input');
    input.value = 'feat';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const buttons = [...dialog.querySelectorAll('button')].filter(b => !b.disabled);
    const last = buttons[buttons.length - 1];
    last.focus();
    const tab = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(doc.activeElement, input);
    panel.dispose();
});

test('creating a branch while another git operation runs keeps the dialog open with an error', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { doc, panel, calls, dom } = setup({ api: {
        gitSwitchBranch: async (id, name) => { calls.push(['switch', id, name]); await gate; return { success: true, data: { ok: true, status: { branch: { head: name } } } }; }
    } });
    try {
        panel.mount();
        await flush();
        click(dom, q(doc, '.zc-row-branch'));
        await flush();
        click(dom, q(doc, '.zc-branch-item[data-branch="dev"]'));
        await flush();
        assert.ok(calls.some(c => c[0] === 'switch'));
        panel.openCreateBranchDialog();
        const dialog = q(doc, '.zc-dialog');
        const input = q(dialog, 'input');
        input.value = 'feat';
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        q(dialog, 'form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await flush();
        assert.ok(q(doc, '.zc-dialog'), 'dialog stays open');
        assert.match(q(dialog, '.zc-field-error').textContent, /正在进行/);
        assert.equal(calls.some(c => c[0] === 'create'), false);
    } finally {
        release();
        await flush();
        panel.dispose();
    }
});
