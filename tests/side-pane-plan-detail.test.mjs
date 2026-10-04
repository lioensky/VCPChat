import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildPlanModel, createPlanDetailSideProvider, planTabId, resolveDefaultProject } from '../modules/ui-system/side-pane/planDetailSideProvider.js';

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
    const sidePaneController = {
        openTab: async (tab) => { calls.opened.push(tab); return { focus() {} }; },
        setVisible() {},
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
    assert.equal(calls.opened[0].title, '计划 · 算法工程');
    assert.equal(calls.opened[0].payload.projectId, 'p1');
});

test('openPlanDetailTab tells the user instead of opening an empty tab when there is no project', async () => {
    const { provider, calls } = makeEnv({ projectForgeListProjects: async () => ({ success: true, data: [] }) });
    assert.equal(await provider.openPlanDetailTab(), null);
    assert.equal(calls.opened.length, 0);
    assert.equal(calls.toasts.length, 1);
});

test('mountTab renders plan, files, timeline and reloads on matching change events', async () => {
    const { provider, calls, view, fire, wasUnsubscribed } = makeEnv();
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.equal(calls.get, 1);
    assert.equal(view.querySelector('.side-plan-title').textContent, '算法工程');
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3);
    assert.equal(view.querySelector('.side-plan-todo.blocked').dataset.todoStatus, 'pending');
    assert.match(view.querySelector('.side-plan-progress-text').textContent, /1\/3 已完成/);
    assert.equal(view.querySelectorAll('.side-plan-batch').length, 2);
    assert.equal(view.querySelectorAll('.side-plan-file').length, 1);
    assert.equal(view.querySelector('.side-plan-progress').value, 1);
    assert.equal(view.querySelector('.side-plan-progress').max, 3);

    // 折叠章节
    view.querySelector('[data-plan-section="files"] .side-plan-section-title').click();
    assert.equal(view.querySelectorAll('.side-plan-file').length, 0);

    // 其他工程的变更不触发刷新，本工程的会
    fire({ projectId: 'other' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(calls.get, 1);
    fire({ projectId: 'p1' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(calls.get, 2);

    // V工程按钮
    view.querySelector('.side-plan-actions .side-plan-icon-btn:last-child').click();
    assert.equal(calls.forge, true);

    handle.dispose();
    assert.equal(wasUnsubscribed(), true);
    assert.equal(view.innerHTML, '');
});

test('mountTab shows a retryable empty state when the project cannot be read', async () => {
    const { provider, view } = makeEnv({ projectForgeGetProject: async () => ({ success: false, error: '工程不存在' }) });
    const handle = await provider.mountTab({ id: planTabId('zz'), payload: { projectId: 'zz' } }, view);
    assert.match(view.textContent, /工程不存在/);
    assert.ok(view.querySelector('.side-plan-error button'));
    handle.dispose();
});

test('a failed refresh keeps the last plan on screen with a retry banner (ZCode keeps the last markdown)', async () => {
    let fail = false;
    const { provider, view, fire } = makeEnv({
        projectForgeGetProject: async () => (fail ? { success: false, error: '网络断开' } : { success: true, data: DETAIL })
    });
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3);

    fail = true;
    fire({ projectId: 'p1' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3, 'content is kept');
    assert.match(view.querySelector('.side-plan-stale').textContent, /网络断开/);

    fail = false;
    view.querySelector('.side-plan-stale button').click();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(view.querySelector('.side-plan-stale'), null);
    handle.dispose();
});

test('a project soft-deleted while its tab is open is marked deleted, not 进行中', async () => {
    // 真实返回：软删除后 GetProject 仍然成功，status 还是 active，只多了 deleted_at / deleted_by
    let deleted = false;
    const { provider, view, fire } = makeEnv({
        projectForgeGetProject: async () => ({ success: true, data: deleted ? { ...DETAIL, project: { ...DETAIL.project, deleted_at: '2026-09-30T02:00:00.000Z', deleted_by: 'Nova' } } : DETAIL })
    });
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, view);
    assert.equal(view.querySelector('.side-plan-chip').textContent, '进行中');
    assert.equal(view.querySelector('.side-plan-deleted'), null);

    deleted = true;
    fire({ projectId: 'p1' });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(view.querySelector('.side-plan-chip').textContent, '已删除');
    assert.ok(view.querySelector('.side-plan-chip.status-deleted'));
    assert.match(view.querySelector('.side-plan-deleted').textContent, /已被 Nova 删除.*RestoreProjects/);
    assert.equal(view.querySelectorAll('.side-plan-todo').length, 3, 'the plan stays readable');
    handle.dispose();
});

test('a renamed project renames its tab, once', async () => {
    const { provider, calls, view, fire } = makeEnv();
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1', projectName: '旧名字' } }, view);
    assert.equal(calls.updated.length, 1);
    assert.equal(calls.updated[0].title, '计划 · 算法工程');
    fire({ projectId: 'p1' });
    await new Promise(r => setTimeout(r, 300));
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
