import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildPlanModel, createPlanDetailSideProvider, planTabId, resolveDefaultProject, REFRESH_DEBOUNCE_MS } from '../modules/ui-system/side-pane/planDetailSideProvider.js';
import { getProjectForgeChangesSource } from '../modules/ui-system/sources/projectforge-changes.js';
import { waitFor } from './helpers/wait-for.mjs';

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
// 重读防抖走 lifecycle scope 的全局 setTimeout：用假时钟推过防抖，再把 promise 链冲完。
// 开了假时钟就不能再用 waitFor（它自己也靠 setTimeout）
function useFakeTimers(t) {
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
}
// 先冲微任务：scope 取消定时器是在微任务里 clearTimeout 的，真实时钟下早于到点
async function passDebounce() {
    await settle();
    mock.timers.tick(REFRESH_DEBOUNCE_MS);
    await settle();
}

const DETAIL = {
    project: { id: 'p1', name: '算法工程', status: 'active', created_by: 'Nova', updated_at: '2026-09-30T01:00:00.000Z', root: 'C:\\w', stats: { added: 83, removed: 10 } },
    todos: [
        { id: 1, title: '第一步', status: 'done', note: null, updated_by: 'Nova', updated_at: '2026-09-30T01:00:00.000Z' },
        { id: 2, title: '第二步', status: 'doing', note: '正在做', updated_by: 'Nova', updated_at: '2026-09-30T01:01:00.000Z' },
        { id: 3, title: '第三步', status: 'blocked', note: null }
    ],
    contributors: [{ maid: 'Nova', batches: 2, added: 83, removed: 10 }],
    files: [{ file_path: 'a.py', edits: 2, added: 83, removed: 10, last_node: 2 }],
    timeline: [
        { id: 2, kind: 'edit', reason: '重构', maid: 'Nova', created_at: '2026-09-30T01:01:00.000Z', files: ['a.py'], added: 22, removed: 10 },
        { id: 1, kind: 'create', reason: '创建', maid: 'Nova', created_at: '2026-09-30T01:00:00.000Z', files: ['a.py'], added: 34, removed: 0 }
    ]
};

test('buildPlanModel maps todos, counts and stats', () => {
    const model = buildPlanModel(DETAIL);
    assert.deepEqual(model.counts, { total: 3, completed: 1, inProgress: 1, pending: 1 });
    assert.equal(model.items[1].note, '正在做');
    assert.equal(model.items[2].blocked, true);
    assert.equal(model.added, 83);
    assert.equal(buildPlanModel({}).project, null);
});

test('resolveDefaultProject prefers the shared workspace, then most recently updated', async () => {
    const projects = [
        { id: 'old', workspace_id: 'ws1', updated_at: '2026-01-01' },
        { id: 'other', workspace_id: 'ws2', updated_at: '2026-09-01' },
        { id: 'gone', workspace_id: 'ws1', updated_at: '2026-12-01', deleted_at: 'x' }
    ];
    const api = {
        projectForgeListProjects: async () => ({ success: true, data: projects }),
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [{ id: 'ws1' }, { id: 'ws2' }], activeWorkspaceId: 'ws1' } })
    };
    assert.equal((await resolveDefaultProject(api, null)).id, 'old');
    assert.equal((await resolveDefaultProject(api, { getItem: () => 'ws2' })).id, 'other');
    assert.equal((await resolveDefaultProject({ ...api, gitListWorkspaces: async () => ({ success: false }) }, null)).id, 'other');
    assert.equal(await resolveDefaultProject({ projectForgeListProjects: async () => ({ success: true, data: [] }) }, null), null);
});

function makeEnv(overrides = {}) {
    const dom = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    let changed = null;
    let unsubscribed = false;
    const calls = { get: 0, opened: [], toasts: [] };
    const api = {
        projectForgeListProjects: async () => ({ success: true, data: [{ id: 'p1', name: '算法工程', updated_at: '2026-09-30' }] }),
        gitListWorkspaces: async () => ({ success: false }),
        projectForgeGetProject: async () => { calls.get += 1; return { success: true, data: DETAIL }; },
        onProjectForgeChanged: (cb) => { changed = cb; return () => { unsubscribed = true; }; },
        ...overrides
    };
    getProjectForgeChangesSource(api, { graceMs: 0 });
    const sidePaneController = {
        openTab: async (tab) => { calls.opened.push(tab); return { focus() {} }; },
        setVisible() {},
        getSnapshot: () => ({ tabs: calls.tabs || [] }),
        updateTab: (id, patch) => { calls.updated = [...(calls.updated || []), { id, ...patch }]; }
    };
    const provider = createPlanDetailSideProvider({
        document: doc, api, sidePaneController,
        uiHelper: { showToastNotification: (m) => calls.toasts.push(m) },
        onOpenProjectForge: () => { calls.forge = true; }
    });
    return { dom, doc, provider, calls, view: doc.getElementById('view'), fire: (p) => changed?.(p), wasUnsubscribed: () => unsubscribed };
}

test('openPlanDetailTab opens a per-project tab with a searchable title', async () => {
    const { provider, calls } = makeEnv();
    await provider.openPlanDetailTab();
    assert.equal(calls.opened.length, 1);
    assert.equal(calls.opened[0].id, planTabId('p1'));
    assert.equal(calls.opened[0].kind, 'plan-detail');
    assert.match(calls.opened[0].title, /算法工程/);
    assert.equal(calls.opened[0].payload.projectId, 'p1');
});

test('openPlanDetailTab tells the user instead of opening an empty tab when there is no project', async () => {
    const { provider, calls } = makeEnv({ projectForgeListProjects: async () => ({ success: true, data: [] }) });
    assert.equal(await provider.openPlanDetailTab(), null);
    assert.equal(calls.opened.length, 0);
    assert.equal(calls.toasts.length, 1);
});

test('mountTab renders plan, files, timeline and reloads on matching change events', async (t) => {
    const { provider, calls, view, fire, wasUnsubscribed } = makeEnv();
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.equal(calls.get, 1);
    assert.equal(view.querySelector('.side-plan-title').textContent, '算法工程');
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3);
    assert.equal(view.querySelector('.side-plan-todo.blocked').dataset.todoStatus, 'pending');
    assert.equal(view.querySelectorAll('.side-plan-batch').length, 2);
    assert.equal(view.querySelectorAll('.side-plan-file').length, 1);
    assert.equal(view.querySelector('.side-plan-progress').value, 1);
    assert.equal(view.querySelector('.side-plan-progress').max, 3);

    // 折叠章节
    view.querySelector('[data-plan-section="files"] .side-plan-section-title').click();
    assert.equal(view.querySelectorAll('.side-plan-file').length, 0);

    // 其他工程的变更不触发刷新，本工程的会
    useFakeTimers(t);
    fire({ projectId: 'other' });
    await passDebounce();
    assert.equal(calls.get, 1);
    fire({ projectId: 'p1' });
    await settle();
    mock.timers.tick(REFRESH_DEBOUNCE_MS - 1);
    await settle();
    assert.equal(calls.get, 1, 'the reload waits for the debounce');
    mock.timers.tick(1);
    await settle();
    assert.equal(calls.get, 2);

    // V工程按钮
    view.querySelector('[data-action="open-forge"]').click();
    assert.equal(calls.forge, true);

    await handle.dispose();
    assert.equal(wasUnsubscribed(), true);
    assert.equal(view.innerHTML, '');
});

test('the breadcrumb pill switches to any project, filters a long list and closes on Escape', async () => {
    const projects = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, name: i ? `工程${i + 1}` : '算法工程', workspace_alias: i === 4 ? 'lab' : undefined, updated_at: `2026-09-${String(10 + i).padStart(2, '0')}` }));
    projects.push({ id: 'gone', name: '已删工程', deleted_at: '2026-09-30' });
    const { provider, calls, view, doc } = makeEnv({
        projectForgeListProjects: async () => ({ success: true, data: projects }),
        projectForgeGetProject: async (id) => { calls.get += 1; return { success: true, data: { ...DETAIL, project: { ...DETAIL.project, id, name: projects.find(p => p.id === id).name } } }; }
    });
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    const pickerItems = () => view.querySelectorAll('.side-plan-picker-item');

    view.querySelector('.side-plan-crumbs').click();
    await waitFor(() => pickerItems().length, { message: 'picker did not list projects' });
    // 全局标签没有「本话题用过」分组；删掉的工程不列，最近更新的在前
    assert.equal(view.querySelectorAll('.side-plan-picker-label').length, 0);
    const ids = [...view.querySelectorAll('.side-plan-picker-item')].map(b => b.dataset.projectId);
    assert.deepEqual(ids, ['p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1']);
    const filter = view.querySelector('.side-plan-picker-filter');
    assert.equal(doc.activeElement, filter);
    filter.value = 'lab';
    filter.dispatchEvent(new doc.defaultView.Event('input'));
    assert.deepEqual([...view.querySelectorAll('.side-plan-picker-item')].map(b => b.dataset.projectId), ['p5']);
    view.querySelector('.side-plan-picker').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(view.querySelector('.side-plan-picker'), null);
    assert.equal(doc.activeElement, view.querySelector('.side-plan-crumbs'));

    // 切换工程：页面换内容，标签记住新工程并钉住
    view.querySelector('.side-plan-crumbs').click();
    await waitFor(() => view.querySelector('.side-plan-picker-item[data-project-id="p3"]'));
    view.querySelector('.side-plan-picker-item[data-project-id="p3"]').click();
    assert.equal(view.querySelector('.side-plan-picker'), null);
    await waitFor(() => view.querySelector('.side-plan-title')?.textContent === '工程3', { message: 'project did not switch' });
    assert.match(calls.updated.at(-1).title, /工程3/);
    assert.equal(calls.updated.at(-1).payload.projectId, 'p3');
    assert.equal(calls.updated.at(-1).payload.pinned, true);
    handle.dispose();
});

test('plan pages navigate by keyboard and retain their scroll positions across refreshes', async (t) => {
    const { provider, view, dom, fire } = makeEnv();
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    const body = view.querySelector('.side-plan-body');
    const selected = () => view.querySelector('[role="tab"][aria-selected="true"]');
    const panel = () => view.querySelector('[role="tabpanel"]:not([hidden])');
    assert.equal(selected().dataset.planPage, 'plan');
    assert.equal(panel().dataset.planPagePanel, 'plan');
    body.scrollTop = 120;
    selected().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(panel().dataset.planPagePanel, 'timeline');
    assert.equal(dom.window.document.activeElement, selected());
    assert.equal(selected().getAttribute('aria-controls'), panel().id);
    body.scrollTop = 60;
    selected().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(body.scrollTop, 120);
    selected().click();
    assert.equal(body.scrollTop, 120);
    selected().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(panel().dataset.planPagePanel, 'git');
    assert.ok(panel().querySelector('.side-git-container'), 'the Git page mounts when it is first shown');
    selected().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(panel().dataset.planPagePanel, 'details');
    assert.match(panel().textContent, /Nova/);
    body.scrollTop = 30;
    useFakeTimers(t);
    fire({ projectId: 'p1' });
    await passDebounce();
    assert.equal(panel().dataset.planPagePanel, 'details');
    assert.equal(body.scrollTop, 30);
    view.querySelector('[data-plan-page="timeline"]').click();
    assert.equal(body.scrollTop, 60);
    handle.reveal({ focus: { todoId: 2 } });
    assert.equal(panel().dataset.planPagePanel, 'plan');
    handle.reveal({ focus: { section: 'files' } });
    assert.equal(panel().dataset.planPagePanel, 'files');
    handle.dispose();
    dom.window.close();
});

test('a plan view put to sleep comes back on the same page and scroll position', async () => {
    const { provider, view, dom } = makeEnv();
    const first = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    view.querySelector('[data-plan-page="timeline"]').click();
    const planBody = view.querySelector('.side-plan-body');
    let shown = true;
    Object.defineProperty(planBody, 'clientHeight', { configurable: true, get: () => (shown ? 400 : 0) });
    planBody.scrollTop = 80;
    planBody.dispatchEvent(new dom.window.Event('scroll'));
    // 休眠时标签是隐藏的：display:none 的 body 读出来滚动是 0
    shown = false;
    planBody.scrollTop = 0;
    const saved = first.captureState();
    assert.deepEqual(saved, { page: 'timeline', scrollTop: 80 });
    first.dispose();

    const again = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view, { restoredState: saved });
    assert.equal(view.querySelector('[role="tabpanel"]:not([hidden])').dataset.planPagePanel, 'timeline');
    assert.equal(view.querySelector('.side-plan-body').scrollTop, 80);
    again.dispose();
    dom.window.close();
});

test('mountTab shows a retryable empty state when the project cannot be read', async () => {
    const { provider, view } = makeEnv({ projectForgeGetProject: async () => ({ success: false, error: '工程不存在' }) });
    const handle = await provider.mountTab({ id: planTabId('zz'), payload: { projectId: 'zz' } }, view);
    assert.match(view.textContent, /工程不存在/);
    const retry = view.querySelector('.side-plan-error button');
    assert.ok(retry);
    retry.click();
    assert.equal(retry.disabled, true, 'the click shows right away that a retry is running');
    assert.equal(retry.textContent, '正在重试…');
    handle.dispose();
});

test('a failed refresh keeps the last plan on screen with a retry banner', async (t) => {
    let fail = false;
    const { provider, view, fire } = makeEnv({
        projectForgeGetProject: async () => (fail ? { success: false, error: '网络断开' } : { success: true, data: DETAIL })
    });
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3);

    fail = true;
    useFakeTimers(t);
    fire({ projectId: 'p1' });
    await passDebounce();
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3, 'content is kept');
    assert.match(view.querySelector('.side-plan-stale').textContent, /网络断开/);

    fail = false;
    view.querySelector('.side-plan-stale button').click();
    await settle();
    assert.equal(view.querySelector('.side-plan-stale'), null);
    handle.dispose();
});

test('a project soft-deleted while its tab is open is marked deleted, not active', async (t) => {
    // 真实返回：软删除后 GetProject 仍然成功，status 还是 active，只多了 deleted_at / deleted_by
    let deleted = false;
    const { provider, view, fire } = makeEnv({
        projectForgeGetProject: async () => ({ success: true, data: deleted ? { ...DETAIL, project: { ...DETAIL.project, deleted_at: '2026-09-30T02:00:00.000Z', deleted_by: 'Nova' } } : DETAIL })
    });
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.equal(view.querySelector('.side-plan-chip').dataset.status, 'active');
    assert.equal(view.querySelector('.side-plan-deleted'), null);

    deleted = true;
    useFakeTimers(t);
    fire({ projectId: 'p1' });
    await passDebounce();
    assert.equal(view.querySelector('.side-plan-chip').dataset.status, 'deleted');
    assert.match(view.querySelector('.side-plan-deleted').textContent, /Nova/, 'the banner names who deleted it');
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3, 'the plan stays readable');
    handle.dispose();
});

test('a renamed project renames its tab, once', async (t) => {
    const { provider, calls, view, fire } = makeEnv();
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1', projectName: '旧名字' } }, view);
    assert.equal(calls.updated.length, 1);
    assert.match(calls.updated[0].title, /算法工程/);
    useFakeTimers(t);
    fire({ projectId: 'p1' });
    await passDebounce();
    assert.equal(calls.get, 2, 'the refresh did run');
    assert.equal(calls.updated.length, 1, 'an unchanged name does not touch the tab again');
    handle.dispose();
});

test('inside a topic the plan tab belongs to that topic and shows the project the topic used', async () => {
    const dom = new JSDOM('<div></div>');
    const opened = [];
    const toasts = [];
    const parent = { itemType: 'agent', itemId: 'nova', topicId: 't1' };
    let used = [{ id: 'p2', name: '话题工程' }];
    const provider = createPlanDetailSideProvider({
        document: dom.window.document,
        api: { projectForgeListProjects: async () => ({ success: true, data: [{ id: 'p1', name: '别的工程' }] }) },
        sidePaneController: { getSnapshot: () => ({ parent }), openTab: async (tab) => { opened.push(tab); return null; }, setVisible() {} },
        uiHelper: { showToastNotification: (m) => toasts.push(m) },
        getConversationProjects: async () => used
    });

    await provider.openPlanDetailTab();
    assert.equal(opened[0].payload.projectId, 'p2');
    assert.equal(opened[0].scopeMode, 'topic');
    assert.deepEqual(opened[0].parent, parent);
    assert.equal(opened[0].id, planTabId('p2', parent));

    // 话题没用过 V工程：不塞一个默认工程进来
    used = [];
    await provider.openPlanDetailTab();
    assert.equal(opened.length, 1);
    assert.equal(toasts.length, 1);
    dom.window.close();
});

test('the Git page opens on the project workspace and follows a project switch', async () => {
    const projects = [
        { id: 'p1', name: '算法工程', workspace_id: 'ws1', updated_at: '2026-09-30' },
        { id: 'p2', name: '旁支工程', workspace_id: 'ws2', updated_at: '2026-09-29' }
    ];
    const statusFor = [];
    const { provider, view, dom } = makeEnv({
        projectForgeListProjects: async () => ({ success: true, data: projects }),
        projectForgeGetProject: async (id) => ({ success: true, data: { ...DETAIL, project: { ...DETAIL.project, ...projects.find(p => p.id === id) } } }),
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [{ id: 'ws0', alias: 'zero', path: '/z' }, { id: 'ws1', alias: 'one', path: '/a' }, { id: 'ws2', alias: 'two', path: '/b' }], activeWorkspaceId: 'ws0' } }),
        gitStatus: async (id) => { statusFor.push(id); return { success: true, data: { isRepo: true, staged: [], conflicts: [], changes: [] } }; }
    });
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.deepEqual(statusFor, [], 'Git is not read until its page is shown');
    view.querySelector('[data-plan-page="git"]').click();
    await waitFor(() => statusFor.length, { message: 'Git status was not read' });
    assert.equal(statusFor.at(-1), 'ws1');
    assert.equal(view.querySelector('.side-git-ws-select').value, 'ws1');

    view.querySelector('.side-plan-crumbs').click();
    await waitFor(() => view.querySelector('.side-plan-picker-item[data-project-id="p2"]'));
    view.querySelector('.side-plan-picker-item[data-project-id="p2"]').click();
    await waitFor(() => statusFor.at(-1) === 'ws2', { message: 'Git did not follow the project switch' });
    assert.equal(view.querySelector('.side-plan-title').textContent, '旁支工程');
    assert.equal(view.querySelector('.side-git-ws-select').value, 'ws2');
    assert.equal(statusFor.at(-1), 'ws2');
    assert.equal(view.querySelector('.side-plan-page-tab[aria-selected="true"]').dataset.planPage, 'git');
    handle.dispose();
    dom.window.close();
});

test('a hidden plan tab reads the project once when shown again, not on every change', async (t) => {
    const { provider, calls, view, fire } = makeEnv();
    let visible = true;
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view, { occurrence: { isVisible: () => visible } });
    assert.equal(calls.get, 1);
    useFakeTimers(t);

    // 已经排上的重读在藏起来时取消
    fire({ projectId: 'p1' });
    visible = false;
    handle.suspend();
    fire({ projectId: 'p1' });
    fire({ projectId: 'p1' });
    await passDebounce();
    assert.equal(calls.get, 1);

    visible = true;
    handle.resume();
    await passDebounce();
    assert.equal(calls.get, 2);

    // 期间没有变化就不重读
    visible = false;
    handle.suspend();
    visible = true;
    handle.resume();
    await passDebounce();
    assert.equal(calls.get, 2);
    handle.dispose();
});

test('keyboard focus survives the redraws a section toggle, a batch toggle and a background refresh cause', async (t) => {
    const { provider, calls, view, dom, fire } = makeEnv();
    const doc = dom.window.document;
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    try {
        const sectionToggle = () => view.querySelector('button.side-plan-section-title');
        const key = sectionToggle().dataset.focusKey;
        sectionToggle().focus();
        sectionToggle().click();
        assert.equal(view.contains(doc.activeElement), true, 'focus is on a live element, not a removed one');
        assert.equal(doc.activeElement?.dataset?.focusKey, key, 'the section toggle keeps focus after it collapses its section');

        sectionToggle().click(); // 展开回来

        view.querySelector('[data-plan-page="timeline"]').click();
        const batchHead = () => view.querySelector('.side-plan-batch-head');
        const batchKey = batchHead().dataset.focusKey;
        batchHead().focus();
        batchHead().click();
        await settle();
        assert.equal(view.contains(doc.activeElement), true);
        assert.equal(doc.activeElement?.dataset?.focusKey, batchKey, 'the batch header keeps focus after it expands');

        const reads = calls.get;
        useFakeTimers(t);
        fire({ projectId: 'p1' });
        await passDebounce();
        assert.equal(calls.get, reads + 1, 'the background refresh ran');
        assert.equal(view.contains(doc.activeElement), true);
        assert.equal(doc.activeElement?.dataset?.focusKey, batchKey, 'a background refresh does not throw focus to <body>');
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

test('activating the plan tab puts keyboard focus inside it', async () => {
    const { provider, view, dom } = makeEnv();
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    try {
        handle.focus();
        assert.equal(view.contains(dom.window.document.activeElement), true);
    } finally { handle.dispose(); }
});

test('a focus target from the status panel is applied once and then cleared from the saved tab', async () => {
    const { provider, view, calls } = makeEnv();
    const tab = { id: planTabId('p1'), payload: { projectId: 'p1', projectName: '算法工程', pinned: true, focus: { todoId: 2 } } };
    calls.tabs = [tab];
    const handle = await provider.mountTab(tab, view);
    try {
        for (let i = 0; i < 50 && !(calls.updated || []).length; i++) await new Promise(r => setTimeout(r, 10));
        const cleared = (calls.updated || []).find(u => u.id === tab.id && u.payload && u.payload.focus === null);
        assert.ok(cleared, 'the saved tab no longer carries the focus target, so a restart or wake does not jump back');
        assert.equal(cleared.payload.projectId, 'p1', 'the rest of the payload is kept');
    } finally { handle.dispose(); }
});
