import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPlanDetailSideProvider, planTabId, FILTER_DEBOUNCE_MS } from '../modules/ui-system/side-pane/planDetailSideProvider.js';
import { buildTopicActivity, locateTopicBatches, narrowSearchRows, searchParams, TIMELINE_LIMIT } from '../modules/ui-system/side-pane/plan-detail/topic-activity.js';
import { readRevertBatches } from '../modules/ui-system/conversation-scope.js';
import { waitFor } from './helpers/wait-for.mjs';

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const node = (id, batchId, file, op = 'edit', added = 1, removed = 0) => ({ id, batch_id: batchId, file_path: file, op, added, removed, created_at: '2026-10-01T01:00:00.000Z' });
const BATCHES = {
    2: { batch: { id: 2, kind: 'edit', reason: '本话题的重构', maid: 'Nova', created_at: '2026-10-01T02:00:00.000Z' }, nodes: [node(3, 2, 'a.py', 'edit', 5, 2), node(4, 2, 'b.py', 'create', 7, 0)] },
    1: { batch: { id: 1, kind: 'create', reason: '别的话题建的', maid: 'Ari', created_at: '2026-10-01T01:00:00.000Z' }, nodes: [node(1, 1, 'a.py', 'create', 30, 0)] }
};
const DETAIL = {
    project: { id: 'p1', name: '算法工程', status: 'active', root: 'C:\\w', report: '验收：全部通过', rootInfo: { writable: true }, stats: { nodeCount: 3, fileCount: 2, added: 42, removed: 2 } },
    todos: [{ id: 7, title: '第一步', status: 'done' }, { id: 8, title: '第二步', status: 'doing' }],
    contributors: [{ maid: 'Nova', batches: 1 }, { maid: 'Ari', batches: 1 }],
    files: [{ file_path: 'a.py', edits: 2 }, { file_path: 'b.py', edits: 1 }],
    timeline: [
        { id: 2, kind: 'edit', reason: '本话题的重构', maid: 'Nova', created_at: '2026-10-01T02:00:00.000Z', files: ['a.py', 'b.py'], added: 12, removed: 2 },
        { id: 1, kind: 'create', reason: '别的话题建的', maid: 'Ari', created_at: '2026-10-01T01:00:00.000Z', files: ['a.py'], added: 30, removed: 0 }
    ]
};

function makeTopicEnv({ batchIds = [2, 99], projects = null, api: extra = {} } = {}) {
    const dom = new JSDOM('<div id="view"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
    const doc = dom.window.document;
    const parent = { itemType: 'agent', itemId: 'nova', topicId: 't1' };
    const calls = { getBatch: [], search: [], revert: [], forge: [], toasts: [], updated: [] };
    const api = {
        projectForgeListProjects: async () => ({ success: true, data: projects || [
            { id: 'p1', name: '算法工程', progress: { total: 2 } },
            { id: 'p2', name: '旁支工程', progress: { total: 0 } }
        ] }),
        projectForgeGetProject: async (id) => ({ success: true, data: id === 'p1' ? DETAIL : { ...DETAIL, project: { ...DETAIL.project, id: 'p2', name: '旁支工程' }, timeline: [] } }),
        projectForgeGetBatch: async (pid, bid) => {
            calls.getBatch.push([pid, bid]);
            return BATCHES[bid] && pid === 'p1' ? { success: true, data: BATCHES[bid] } : { success: false, error: `批次 b${bid} 不存在` };
        },
        projectForgeSearchHistory: async (params) => {
            calls.search.push(params);
            return { success: true, data: [
                { ...node(3, 2, 'a.py'), maid: 'Nova', reason: '本话题的重构' },
                { ...node(1, 1, 'a.py', 'create'), maid: 'Ari' },
                { ...node(5, 2, 'src/a.py'), maid: 'Nova' }
            ] };
        },
        projectForgeGetNode: async (pid, nid) => ({ success: true, data: {
            node: { ...node(nid, 2, 'a.py'), reason: '改了一行' },
            batch: BATCHES[2].batch,
            todo: { seq: 1, title: '第一步' },
            before: { exists: true, text: 'a\nb\nc\n' },
            after: { exists: true, text: 'a\nB\nc\n' },
            laterChanges: 0
        } }),
        projectForgeRevertFile: async (args) => {
            calls.revert.push(args);
            if (args.dryRun) return { success: true, data: { status: 'dryRun', label: '撤销 n3', action: '写回改动前内容', conflicts: [] } };
            return { success: true, data: { status: 'ok', batchId: 12, maid: args.signature } };
        },
        onProjectForgeChanged: () => () => {},
        ...extra
    };
    const sidePaneController = {
        getSnapshot: () => ({ parent, tabs: [] }),
        openTab: async () => null,
        setVisible() {},
        updateTab: (id, patch) => calls.updated.push({ id, ...patch })
    };
    const provider = createPlanDetailSideProvider({
        document: doc, api, sidePaneController,
        uiHelper: { showToastNotification: (m, type) => calls.toasts.push([m, type]) },
        getTopicScope: () => ({ projectIds: ['p1', 'p2'], batchIds: new Set(batchIds) }),
        onOpenProjectForge: (id) => calls.forge.push(id)
    });
    const tab = { id: planTabId('p1', parent), kind: 'plan-detail', parent, payload: {} };
    return { dom, doc, provider, calls, tab, view: doc.getElementById('view'), storage: dom.window.localStorage };
}

test('topic-activity: only batches inside this project\'s timeline range are looked up', () => {
    const timeline = [{ id: 9 }, { id: 5 }];
    assert.deepEqual(locateTopicBatches(timeline, [9, 7, 3]), { inTimeline: [9], older: [] });
    const full = Array.from({ length: TIMELINE_LIMIT }, (_, i) => ({ id: 1000 - i }));
    assert.deepEqual(locateTopicBatches(full, [1000, 500, 900]), { inTimeline: [1000, 900], older: [500] });
    assert.deepEqual(locateTopicBatches([], [1]), { inTimeline: [], older: [] });
});

test('topic-activity: batches roll up into files, contributors and stats; empty batches are skipped', () => {
    const activity = buildTopicActivity([BATCHES[1], BATCHES[2], null, { batch: { id: 3 }, nodes: [] }]);
    assert.deepEqual(activity.batches.map(b => b.id), [2, 1]);
    assert.deepEqual(activity.stats, { batchCount: 2, nodeCount: 3, fileCount: 2, added: 42, removed: 2, lastAt: '2026-10-01T02:00:00.000Z' });
    assert.deepEqual(activity.files.map(f => [f.file_path, f.edits]), [['b.py', 1], ['a.py', 2]]);
    // 批数相同按最近施工排
    assert.deepEqual(activity.contributors.map(c => c.maid), ['Nova', 'Ari']);
});

test('topic-activity: filter params and topic narrowing', () => {
    assert.deepEqual(searchParams('p1', { keyword: 'x', file: 'a', exactFile: '', maid: 'Nova', op: 'edit', content: 'c' }),
        { projectId: 'p1', limit: 500, keyword: 'x', file: 'a', byMaid: 'Nova', op: 'edit', content: 'c' });
    assert.equal(searchParams('p1', { exactFile: 'src/a.py', file: 'zzz' }).file, 'src/a.py');
    const rows = [{ batch_id: 2, file_path: 'a.py' }, { batch_id: 1, file_path: 'a.py' }, { batch_id: 2, file_path: 'src/a.py' }];
    assert.equal(narrowSearchRows(rows, { topicBatchIds: new Set([2]) }).length, 2);
    assert.equal(narrowSearchRows(rows, { topicBatchIds: new Set([2]), exactFile: 'a.py' }).length, 1);
    assert.equal(narrowSearchRows(rows, {}).length, 3);
});

test('a topic tab shows only the topic\'s batches, its stats, the project switch and the other-topic hint', async () => {
    const { provider, calls, tab, view, dom } = makeTopicEnv();
    const handle = await provider.mountTab(tab, view);
    // b99 不在这个工程的时间线范围内，不去查
    assert.deepEqual(calls.getBatch, [['p1', 2]]);
    assert.deepEqual([...view.querySelectorAll('.side-plan-batch')].map(li => li.dataset.batchId), ['2']);
    const stats = view.querySelector('.side-plan-stats').dataset;
    assert.deepEqual([stats.batches, stats.nodes, stats.files], ['1', '2', '2'], 'stats count only this topic\'s batches');
    assert.equal(view.querySelector('.side-plan-crumbs .side-plan-context').dataset.scope, 'topic', 'the scope lives in the breadcrumb');
    assert.equal(view.querySelector('.side-plan-crumbs').getAttribute('aria-haspopup'), 'listbox');
    // b1 在时间线里但不属于本话题
    assert.equal(view.querySelector('.side-plan-other-hint').dataset.count, '1');
    view.querySelector('.side-plan-other-hint .side-plan-link').click();
    view.querySelector('[data-action="open-forge"]').click();
    assert.deepEqual(calls.forge, ['p1', 'p1']);

    // 展开批次 → 节点行
    view.querySelector('.side-plan-batch-head').click();
    assert.deepEqual([...view.querySelectorAll('.side-plan-node-row')].map(b => b.dataset.nodeId), ['3', '4']);

    // 报告默认收起
    assert.equal(view.querySelector('.side-plan-report'), null);
    view.querySelector('[data-plan-section="report"] .side-plan-section-title').click();
    assert.equal(view.querySelector('.side-plan-report').textContent, '验收：全部通过');

    // 面包屑胶囊打开工程菜单：话题用过的工程单独一组排在前面，当前工程打勾
    view.querySelector('.side-plan-crumbs').click();
    await waitFor(() => view.querySelector('.side-plan-picker-item'), { message: 'picker did not list projects' });
    assert.equal(view.querySelector('.side-plan-crumbs').getAttribute('aria-expanded'), 'true');
    assert.equal(view.querySelectorAll('.side-plan-picker-label').length, 1);
    assert.deepEqual([...view.querySelectorAll('.side-plan-picker-item')].map(b => b.dataset.projectId), ['p1', 'p2']);
    assert.equal(view.querySelector('.side-plan-picker-item[aria-selected="true"]').dataset.projectId, 'p1');
    // 切换到话题用过的另一个工程（切换并钉住标签见 side-pane-plan-detail）：那里本话题没有施工
    view.querySelector('.side-plan-picker-item[data-project-id="p2"]').click();
    await waitFor(() => view.querySelector('.side-plan-title')?.textContent === '旁支工程', { message: 'project did not switch' });
    assert.ok(view.querySelector('[data-plan-section="timeline"]'));
    assert.equal(view.querySelectorAll('.side-plan-batch').length, 0);
    assert.equal(view.querySelector('.side-plan-other-hint'), null);
    handle.dispose();
    dom.window.close();
});

test('clicking a file filters the timeline to that exact file within this topic', async () => {
    const { provider, calls, tab, view, dom } = makeTopicEnv();
    const handle = await provider.mountTab(tab, view);
    [...view.querySelectorAll('.side-plan-file-btn')].find(b => b.querySelector('.side-plan-file-name').textContent === 'a.py').click();
    await waitFor(() => view.querySelector('.side-plan-filter-results .side-plan-node-row'), { message: 'filter results did not render' });
    assert.equal(view.querySelector('[role="tab"][aria-selected="true"]').dataset.planPage, 'timeline');
    assert.equal(view.querySelector('[role="tabpanel"]:not([hidden])').dataset.planPagePanel, 'timeline');
    assert.equal(calls.search.at(-1).file, 'a.py');
    // 只剩本话题批次里、路径完全一致的那一条
    assert.deepEqual([...view.querySelectorAll('.side-plan-filter-results .side-plan-node-row')].map(b => b.dataset.nodeId), ['3']);
    assert.ok(view.querySelector('.side-plan-file-btn.is-active'));
    view.querySelector('.side-plan-filter-clear').click();
    assert.equal(view.querySelector('.side-plan-filter-results'), null);
    assert.ok(view.querySelector('.side-plan-timeline'));

    // 点参与者按人筛选
    view.querySelector('.side-plan-contributor-btn').click();
    await waitFor(() => calls.search.at(-1)?.byMaid, { message: 'contributor filter did not search' });
    assert.equal(calls.search.at(-1).byMaid, 'Nova');
    handle.dispose();
    dom.window.close();
});

for (const settlement of ['resolve', 'reject']) {
    test(`editing a history filter immediately invalidates an older ${settlement} before debounce`, async () => {
        const requests = [];
        const { provider, tab, view, dom } = makeTopicEnv({ api: {
            projectForgeSearchHistory(params) {
                const request = Promise.withResolvers();
                requests.push({ params, ...request });
                return request.promise;
            }
        } });
        const handle = await provider.mountTab(tab, view);
        try {
            [...view.querySelectorAll('.side-plan-file-btn')].find(button => button.querySelector('.side-plan-file-name').textContent === 'a.py').click();
            const input = view.querySelector('[data-filter="keyword"]');
            input.focus();
            input.value = 'new criterion';
            input.dispatchEvent(new dom.window.Event('input'));
            if (settlement === 'resolve') requests[0].resolve({ success: true, data: [node(777, 2, 'a.py')] });
            else requests[0].reject(new Error('old filter failed'));
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(requests.length, 1, 'the new debounced read has not started');
            assert.equal(view.querySelector('[data-node-id="777"]'), null);
            assert.doesNotMatch(view.querySelector('.side-plan-filter-results').textContent, /old filter failed/);
            assert.equal(view.querySelector('.side-plan-filter-results').getAttribute('aria-busy'), 'true', 'shows the new filter as loading');
            assert.equal(dom.window.document.activeElement.dataset.filter, 'keyword');
            const operation = view.querySelector('[data-filter="op"]');
            operation.value = 'edit';
            operation.dispatchEvent(new dom.window.Event('change'));
            assert.equal(requests[1].params.keyword, 'new criterion');
            requests[1].resolve({ success: true, data: [node(888, 2, 'a.py')] });
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(view.querySelector('[data-node-id="888"]'));
            assert.equal(view.querySelector('[data-node-id="777"]'), null);
        } finally {
            handle.dispose();
            dom.window.close();
        }
    });
}

test('typing into the history filter with an input method keeps the same input element until composition ends', async (t) => {
    const requests = [];
    const { provider, tab, view, dom } = makeTopicEnv({ api: {
        projectForgeSearchHistory(params) {
            requests.push(params);
            return Promise.resolve({ success: true, data: [] });
        }
    } });
    const handle = await provider.mountTab(tab, view);
    // 筛选防抖走 lifecycle scope 的全局 setTimeout
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());
    try {
        const input = view.querySelector('[data-filter="keyword"]');
        input.focus();
        input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
        input.value = 'zhong';
        input.dispatchEvent(new dom.window.InputEvent('input', { isComposing: true }));
        await settle();
        mock.timers.tick(FILTER_DEBOUNCE_MS);
        await settle();
        assert.equal(view.querySelector('[data-filter="keyword"]'), input, 'the composing input is not replaced');
        assert.equal(requests.length, 0, 'no search while composing');

        input.value = '中';
        input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));
        await settle();
        mock.timers.tick(FILTER_DEBOUNCE_MS);
        await settle();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].keyword, '中');
        assert.equal(dom.window.document.activeElement.dataset.filter, 'keyword');
    } finally {
        handle.dispose();
        dom.window.close();
    }
});

test('a node opens its diff and can be reverted with a remembered signature; the revert joins the topic', async () => {
    const { provider, calls, tab, view, dom, storage } = makeTopicEnv();
    const handle = await provider.mountTab(tab, view);
    view.querySelector('.side-plan-batch-head').click();
    view.querySelector('.side-plan-node-row').click();
    await waitFor(() => view.querySelector('.side-plan-diff'), { message: 'node diff did not open' });
    assert.ok(view.querySelector('.side-plan-node'));
    assert.ok(view.querySelector('.side-plan-diff .diff-line.add'));
    assert.ok(view.querySelector('.side-plan-diff .diff-line.del'));
    assert.match(view.querySelector('.side-plan-node-todo').textContent, /第一步/);

    // 没署名不让回退
    view.querySelector('.side-plan-revert-before').click();
    await settle();
    assert.equal(calls.revert.length, 0);
    assert.equal(calls.toasts.at(-1)[1], 'error');

    view.querySelector('.side-plan-signature').value = '小明';
    view.querySelector('.side-plan-revert-before').click();
    await waitFor(() => calls.revert.length === 1, { message: 'dry run did not start' });
    assert.deepEqual(calls.revert[0], { projectId: 'p1', nodeId: 3, mode: 'before', signature: '小明', reason: '', dryRun: true });
    assert.equal(view.querySelector('.side-plan-revert-confirm').hidden, false);
    view.querySelector('.side-plan-revert-ok').click();
    await waitFor(() => !view.querySelector('.side-plan-node'), { message: 'revert did not return to the list' });
    assert.equal(calls.revert[1].force, false);
    assert.equal(calls.revert[1].dryRun, undefined);
    assert.deepEqual(readRevertBatches(storage, 'agent:nova:t1'), [12]);
    // 回到列表
    assert.ok(view.querySelector('.side-plan-timeline'));
    // 再打开节点：署名记住了
    if (!view.querySelector('.side-plan-node-row')) view.querySelector('.side-plan-batch-head').click();
    view.querySelector('.side-plan-node-row').click();
    await waitFor(() => view.querySelector('.side-plan-signature'), { message: 'node did not reopen' });
    assert.equal(view.querySelector('.side-plan-signature').value, '小明');
    handle.dispose();
    dom.window.close();
});

test('reveal focuses a todo or a section, opening it when collapsed', async () => {
    const { provider, tab, view, dom } = makeTopicEnv();
    // JSDOM 没有排版：用 getClientRects 模拟标签还没显示 / 已显示
    let shown = false;
    dom.window.Element.prototype.getClientRects = function getClientRects() { return shown ? [{}] : []; };
    const handle = await provider.mountTab({ ...tab, payload: { focus: { todoId: 8 } } }, view);
    assert.equal(view.querySelector('.side-plan-todo[data-todo-id="8"]').classList.contains('is-flash'), false, '新开的标签还没显示，先不定位');
    shown = true;
    await waitFor(() => view.querySelector('.side-plan-todo[data-todo-id="8"]').classList.contains('is-flash'), { message: '显示出来后再滚过去' });
    handle.reveal({ focus: { section: 'report' } });
    assert.ok(view.querySelector('[data-plan-section="report"]').classList.contains('is-flash'));
    assert.ok(view.querySelector('.side-plan-report'));
    handle.dispose();
    dom.window.close();
});

test('a background refresh with a filter on swaps the results in place instead of flashing "正在筛选…"', async () => {
    const requests = [];
    const { provider, tab, view, dom } = makeTopicEnv({ api: {
        projectForgeSearchHistory(params) {
            const request = Promise.withResolvers();
            requests.push({ params, ...request });
            return request.promise;
        }
    } });
    const handle = await provider.mountTab(tab, view);
    try {
        [...view.querySelectorAll('.side-plan-file-btn')].find(button => button.querySelector('.side-plan-file-name').textContent === 'a.py').click();
        requests[0].resolve({ success: true, data: [node(777, 2, 'a.py')] });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(view.querySelector('[data-node-id="777"]'));

        handle.focus(); // 切回标签：后台重读一次，筛选也跟着重跑
        for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(requests.length, 2);
        assert.doesNotMatch(view.querySelector('.side-plan-filter-results').textContent, /正在筛选/);
        assert.ok(view.querySelector('[data-node-id="777"]'), 'the previous results stay while the new ones load');
        requests[1].resolve({ success: true, data: [node(888, 2, 'a.py')] });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(view.querySelector('[data-node-id="888"]'));
    } finally {
        handle.dispose();
        dom.window.close();
    }
});
