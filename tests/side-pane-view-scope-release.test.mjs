import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createSidePaneRootScope } from '../modules/ui-system/side-pane/side-pane-occurrence.js';
import { createCodeViewerSideProvider } from '../modules/ui-system/side-pane/codeViewerSideProvider.js';
import { createPlanDetailSideProvider, planTabId, REFRESH_DEBOUNCE_MS } from '../modules/ui-system/side-pane/planDetailSideProvider.js';
import { createBrowserSideProvider } from '../modules/ui-system/side-pane/browserSideProvider.js';
import { getProjectForgeChangesSource } from '../modules/ui-system/sources/projectforge-changes.js';

// 控制器让标签休眠或挂载被取消时只释放 view scope，不一定先调 handle.dispose：
// 这里只释放 scope，确认标签登记过的东西一样都不剩
const { diagnostics } = globalThis.VCPLifecycle;
const scopesUnder = view => diagnostics.snapshot().filter(scope => scope.parentId === view.id);

test('releasing only the view scope detaches every control of the code viewer', async () => {
    const dom = new JSDOM('<section id="view"></section>', { url: 'https://vcpchat.local/' });
    const doc = dom.window.document;
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        async gitListWorkspaces() { return { success: true, data: { workspaces: [{ id: 'w', path: '/repo' }], activeWorkspaceId: 'w' } }; },
        async sourceListFiles() { return { success: true, data: { files: ['a.js'] } }; },
        async sourceReadFile() { return { success: true, data: { text: 'const a = 1;\n' } }; }
    } });
    const view = createSidePaneRootScope(null, 'test-view');
    const element = doc.getElementById('view');
    const handle = await provider.mountTab({ title: '代码', payload: {} }, element, { scope: view });
    try {
        assert.ok(scopesUnder(view).length > 0, 'the viewer owns a scope under the view');
        assert.ok(view.resourceSummary().byType.listener > 0, 'the controls listen through the view scope');

        const picker = element.querySelector('.side-code-picker');
        const toggle = element.querySelector('[data-action="toggle-picker"]');
        const collapsed = picker.classList.contains('is-collapsed');
        await view.dispose('dormant');
        toggle.click();
        assert.equal(picker.classList.contains('is-collapsed'), collapsed, 'the toggle no longer reacts');
        assert.equal(scopesUnder(view).length, 0);
        assert.equal(view.resourceSummary().byType.listener ?? 0, 0);
        assert.equal(view.resourceSummary().resources, 0);
    } finally {
        await handle.dispose();
        dom.window.close();
    }
});

test('a code viewer whose view is released while it is still loading gives up instead of mounting', async () => {
    const dom = new JSDOM('<section id="view"></section>', { url: 'https://vcpchat.local/' });
    const doc = dom.window.document;
    let finishList;
    const provider = createCodeViewerSideProvider({ document: doc, uiHelper: null, api: {
        gitListWorkspaces: () => new Promise(resolve => { finishList = resolve; }),
        async sourceListFiles() { return { success: true, data: { files: [] } }; },
        async sourceReadFile() { return { success: true, data: { text: '' } }; }
    } });
    const view = createSidePaneRootScope(null, 'test-view');
    const element = doc.getElementById('view');
    const mounting = provider.mountTab({ title: '代码', payload: {} }, element, { scope: view });
    await new Promise(resolve => setImmediate(resolve));
    await view.dispose('mount-canceled');
    finishList({ success: true, data: { workspaces: [{ id: 'w', path: '/repo' }], activeWorkspaceId: 'w' } });
    assert.equal(await mounting, null);
    assert.equal(element.innerHTML, '');
    dom.window.close();
});

test('releasing only the view scope stops the plan page following project changes', async (t) => {
    const dom = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    let changed = null;
    let gets = 0;
    const api = {
        projectForgeListProjects: async () => ({ success: true, data: [{ id: 'p1', name: '算法工程', updated_at: '2026-09-30' }] }),
        gitListWorkspaces: async () => ({ success: false }),
        projectForgeGetProject: async () => { gets += 1; return { success: true, data: { project: { id: 'p1', name: '算法工程' }, todos: [], batches: [], files: [] } }; },
        onProjectForgeChanged: cb => { changed = cb; return () => { changed = null; }; }
    };
    getProjectForgeChangesSource(api, { graceMs: 0 });
    const provider = createPlanDetailSideProvider({
        document: doc, api,
        sidePaneController: { openTab: async () => null, setVisible() {}, updateTab() {} },
        uiHelper: { showToastNotification() {} }
    });
    const view = createSidePaneRootScope(null, 'test-view');
    const handle = await provider.mountTab({ id: planTabId('p1'), payload: { projectId: 'p1' } }, doc.getElementById('view'), { scope: view });
    try {
        assert.equal(typeof changed, 'function');
        assert.ok(view.resourceSummary().resources > 0);
        // 释放前已经排上一次防抖重读：释放后推过防抖也不能再读
        mock.timers.enable({ apis: ['setTimeout'] });
        t.after(() => mock.timers.reset());
        const before = gets;
        changed({ projectId: 'p1' });
        await view.dispose('dormant');
        assert.equal(changed, null, 'the push subscription is returned');
        assert.equal(scopesUnder(view).length, 0);
        mock.timers.tick(REFRESH_DEBOUNCE_MS);
        for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve));
        assert.equal(gets, before, 'no debounced reload fires after the release');
    } finally {
        await handle.dispose();
        dom.window.close();
    }
});

test('releasing only the view scope removes the browser tab and its popup subscription', async () => {
    const dom = new JSDOM('<div id="view"></div>');
    const doc = dom.window.document;
    let openTabListener = null;
    const provider = createBrowserSideProvider({
        document: doc,
        api: { onBrowserOpenTab: fn => { openTabListener = fn; return () => { openTabListener = null; }; } },
        sidePaneController: { getSnapshot: () => ({ tabs: [] }), openTab: async () => null, setVisible() {}, updateTab() {} },
        notify: () => {}
    });
    const view = createSidePaneRootScope(null, 'test-view');
    const element = doc.getElementById('view');
    const handle = await provider.mountTab({ id: 'browser:1', kind: 'browser', payload: {} }, element, { scope: view });
    try {
        assert.equal(typeof openTabListener, 'function');
        assert.ok(view.resourceSummary().resources > 0);
        await view.dispose('dormant');
        assert.equal(openTabListener, null, 'the last browser tab gives the popup push back');
        assert.equal(scopesUnder(view).length, 0);
        assert.equal(view.resourceSummary().resources, 0);
    } finally {
        await handle.dispose();
        dom.window.close();
    }
});
