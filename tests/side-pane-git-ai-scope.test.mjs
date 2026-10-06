import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGitView, filterAiTouched, latestAiBatch, followGitWorkspace } from '../modules/ui-system/side-pane/git/git-view.js';
import { getProjectForgeChangesSource } from '../modules/ui-system/sources/projectforge-changes.js';
import { getGitChangesSource } from '../modules/ui-system/sources/git-changes.js';

const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

test('filterAiTouched aligns absolute / relative / windows paths by suffix', () => {
    const items = [{ path: 'src/a.js' }, { path: 'docs/b.md' }, { path: 'README.md' }];
    assert.deepEqual(filterAiTouched(items, ['C:\\work\\proj\\src\\a.js']).map(i => i.path), ['src/a.js']);
    assert.deepEqual(filterAiTouched(items, ['./README.md', 'b.md']).map(i => i.path), ['docs/b.md', 'README.md']);
    assert.deepEqual(filterAiTouched(items, []), []);
    assert.deepEqual(filterAiTouched(items, ['other/c.js']), []);
});

test('latestAiBatch picks the newest batch', () => {
    const batch = latestAiBatch({
        project: { name: '算法工程' },
        timeline: [
            { id: 3, kind: 'edit', reason: '最新', maid: 'Nova', created_at: '2026-09-30T01:00:00Z', files: ['a.js'] },
            { id: 2, kind: 'create', reason: '较早', files: ['b.js'] }
        ]
    });
    assert.equal(batch.id, 3);
    assert.equal(batch.reason, '最新');
    assert.equal(batch.projectName, '算法工程');
    assert.equal(latestAiBatch({ timeline: [] }), null);
});

function makeEnv({ batches } = {}) {
    const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const win = dom.window;
    // JSDOM 不做布局，offsetParent 总是 null；这里当作挂在文档里就看得见
    Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected ? this.parentNode : null; } });
    const view = win.document.getElementById('host');
    const state = { forgeHandler: null, gitHandlers: new Set(), statusCalls: 0, subscriptions: [] };
    let timeline = batches;
    const api = {
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [{ id: 'ws1', alias: 'demo', path: '/repo' }, { id: 'ws2', alias: 'other', path: '/other' }], activeWorkspaceId: 'ws1' } }),
        gitStatus: async () => {
            state.statusCalls += 1;
            return { success: true, data: { isRepo: true, branch: { head: 'main' }, remotes: [], staged: [], conflicts: [], changes: [
                { path: 'src/a.js', status: 'M' }, { path: 'docs/b.md', status: 'M' }, { path: 'notes.txt', status: 'U' }
            ] } };
        },
        gitDiff: async () => ({ success: true, data: { before: { exists: true, text: '' }, after: { exists: true, text: 'x' } } }),
        projectForgeListProjects: async () => ({ success: true, data: [{ id: 'p1', name: '算法工程', workspace_id: 'ws1', updated_at: '2026-09-30' }] }),
        projectForgeGetProject: async () => ({ success: true, data: { project: { name: '算法工程' }, timeline } }),
        onProjectForgeChanged: (cb) => { state.forgeHandler = cb; return () => { state.forgeHandler = null; }; },
        onGitChanged: (cb) => { state.gitHandlers.add(cb); return () => state.gitHandlers.delete(cb); },
        subscribeMainState: async (topic, key) => { state.subscriptions.push(['+', topic, key]); return { success: true }; },
        unsubscribeMainState: async (topic, key) => { state.subscriptions.push(['-', topic, key]); return { success: true }; }
    };
    // 不留宽限期：视图一释放，变更源就取消对 V工程 / Git 推送的监听
    getProjectForgeChangesSource(api, { graceMs: 0 });
    getGitChangesSource(api, 'ws1', { graceMs: 0 });
    getGitChangesSource(api, 'ws2', { graceMs: 0 });
    state.pushGit = (payload) => [...state.gitHandlers].forEach(cb => cb(payload));
    const gitView = { mount: async () => { const handle = mountGitView(view, { api }); await handle.ready; return handle; } };
    return { win, view, gitView, state, api, setTimeline: (t) => { timeline = t; } };
}

const gitSubs = (state) => state.subscriptions.filter(entry => entry[1] === 'git.status');
const files = (view) => [...view.querySelectorAll('.side-git-card')].map(card => card.dataset.path);

test('the 上一轮 source narrows changes to the newest V工程 batch and follows V工程 updates', async () => {
    const { win, view, gitView, state, setTimeline } = makeEnv({
        batches: [
            { id: 2, kind: 'edit', reason: '重构 a', maid: 'Nova', created_at: '2026-09-30 01:00:00', files: ['C:\\repo\\src\\a.js'] },
            { id: 1, kind: 'create', reason: '较早', files: ['docs/b.md'] }
        ]
    });
    const handle = await gitView.mount();
    try {
        assert.equal(files(view).length, 3, 'default source lists the unstaged changes');
        const select = view.querySelector('.side-git-source-select');
        assert.ok([...select.options].some(o => o.value === 'ai-last' && o.textContent === '上一轮'));

        select.value = 'ai-last';
        select.dispatchEvent(new win.Event('change'));
        await wait();
        assert.deepEqual(files(view), ['src/a.js']);
        assert.equal(view.querySelector('.side-git-ai-banner'), null, 'no extra banner');

        // V工程 记了新一批：不用手动刷新
        setTimeline([{ id: 3, kind: 'edit', reason: '改文档', files: ['docs/b.md', 'notes.txt'] }]);
        state.forgeHandler({ projectId: 'p1' });
        await wait(200);
        assert.deepEqual(files(view).sort(), ['docs/b.md', 'notes.txt']);

        // 批次里的文件都已提交
        setTimeline([{ id: 4, kind: 'edit', reason: '已提交的', files: ['gone.js'] }]);
        state.forgeHandler({ projectId: 'p1' });
        await wait(200);
        assert.equal(view.querySelector('.side-git-empty-title').textContent, '上一轮的改动已经没有未提交内容');

        // 没有任何批次
        setTimeline([]);
        state.forgeHandler({ projectId: 'p1' });
        await wait(200);
        assert.equal(view.querySelector('.side-git-empty-title').textContent, '当前工作区还没有上一轮文件改动');

        select.value = 'unstaged';
        select.dispatchEvent(new win.Event('change'));
        await wait();
        assert.equal(files(view).length, 3);
    } finally {
        await handle.dispose();
        assert.equal(state.forgeHandler, null, 'V工程 subscription released');
    }
});

test('a pushed repository change refreshes the tab; only the shown workspace is subscribed', async () => {
    const { gitView, state } = makeEnv({ batches: [] });
    const handle = await gitView.mount();
    try {
        assert.deepEqual(gitSubs(state), [['+', 'git.status', 'ws1']]);
        const before = state.statusCalls;
        state.pushGit({ workspaceId: 'ws1', reason: 'commit' });
        await wait();
        assert.equal(state.statusCalls, before + 1);

        state.pushGit({ workspaceId: 'ws2', reason: 'files' });
        await wait();
        assert.equal(state.statusCalls, before + 1, 'other workspaces are ignored');
    } finally {
        await handle.dispose();
    }
    assert.deepEqual(gitSubs(state).at(-1), ['-', 'git.status', 'ws1'], 'disposing releases the subscription');
    assert.equal(state.gitHandlers.size, 0);
});

test('a change while the side pane is collapsed is read when the tab is shown again', async () => {
    const { win, view, gitView, state } = makeEnv({ batches: [] });
    const handle = await gitView.mount();
    const pane = win.document.createElement('div');
    pane.className = 'vcp-side-pane';
    win.document.body.appendChild(pane);
    pane.appendChild(view);
    try {
        pane.setAttribute('aria-hidden', 'true');
        const before = state.statusCalls;
        state.pushGit({ workspaceId: 'ws1', reason: 'files' });
        await wait();
        assert.equal(state.statusCalls, before, 'nothing is read while hidden');

        pane.setAttribute('aria-hidden', 'false');
        handle.refreshIfStale();
        await wait();
        assert.equal(state.statusCalls, before + 1);
        handle.refreshIfStale();
        await wait();
        assert.equal(state.statusCalls, before + 1, 'read once, then up to date');
    } finally {
        await handle.dispose();
    }
});

test('following a topic workspace switches the mounted tab and moves the subscription', async () => {
    const { win, view, gitView, state } = makeEnv({ batches: [] });
    const handle = await gitView.mount();
    try {
        followGitWorkspace(win, 'ws2');
        await wait();
        assert.equal(view.querySelector('.side-git-ws-select, select:not(.side-git-source-select)')?.value, 'ws2');
        assert.deepEqual(gitSubs(state).slice(-2), [['-', 'git.status', 'ws1'], ['+', 'git.status', 'ws2']]);
        assert.equal(win.localStorage.getItem('vcp-projectforge-git-workspace'), 'ws2');
    } finally {
        await handle.dispose();
    }
});

test('a legacy stored "all" source falls back to unstaged', async () => {
    const { win, view, gitView } = makeEnv({ batches: [] });
    win.localStorage.setItem('vcp-side-pane-git-source', 'all');
    const handle = await gitView.mount();
    try {
        assert.equal(view.querySelector('.side-git-source-select').value, 'unstaged');
    } finally {
        await handle.dispose();
    }
});
