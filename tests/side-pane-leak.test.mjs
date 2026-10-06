// 回收验收：每种副屏标签反复开关、反复休眠唤醒之后，scope、资源、状态通道订阅、共享数据源持有者、
// 主进程订阅和页面里的节点都回到起点
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { createTerminalSideProvider } from '../modules/ui-system/side-pane/terminalSideProvider.js';
import { createPlanDetailSideProvider } from '../modules/ui-system/side-pane/planDetailSideProvider.js';
import { createModelTrajectorySideProvider } from '../modules/ui-system/side-pane/modelTrajectorySideProvider.js';
import { createToolOutputSideProvider } from '../modules/ui-system/side-pane/toolOutputSideProvider.js';
import { getProjectForgeChangesSource } from '../modules/ui-system/sources/projectforge-changes.js';
import { getCommandRunsSource } from '../modules/ui-system/sources/terminal-command-runs.js';

const CYCLES = 20;
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 0));
};

const PROJECT = {
    project: { id: 'p1', name: '工程', status: 'active', updated_at: '2026-09-30T01:00:00.000Z', root: 'C:\\w' },
    todos: [{ id: 1, title: '第一步', status: 'doing' }],
    contributors: [], files: [], timeline: []
};

function fixture() {
    const dom = new JSDOM(`<body>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <div class="side-pane-tabs"></div>
            <div class="side-pane-content-container"></div>
        </aside></body>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const listeners = new Map();
    const subscribe = name => callback => {
        listeners.set(name, (listeners.get(name) || 0) + 1);
        return () => listeners.set(name, listeners.get(name) - 1);
    };
    const calls = { creates: 0, kills: 0, watches: 0, unwatches: 0 };
    const api = {
        terminalCreate: async () => ({ success: true, data: { id: `t${++calls.creates}` } }),
        terminalKill: async () => { calls.kills++; return { success: true }; },
        terminalRestart: async () => ({ success: true }),
        onTerminalData: subscribe('terminal-data'),
        onTerminalClear: subscribe('terminal-clear'),
        onTerminalExit: subscribe('terminal-exit'),
        gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }),
        projectForgeListProjects: async () => ({ success: true, data: [PROJECT.project] }),
        projectForgeGetProject: async () => ({ success: true, data: PROJECT }),
        onProjectForgeChanged: subscribe('projectforge'),
        modelTrajectoryList: async () => ({ success: true, data: { records: [], truncated: false, total: 0 } }),
        modelTrajectoryWatch: async () => { calls.watches++; return { success: true }; },
        modelTrajectoryUnwatch: async () => { calls.unwatches++; return { success: true }; },
        onModelTrajectoryChanged: subscribe('trajectory'),
        terminalListCommandRuns: async () => ({ success: true, data: [] }),
        terminalGetCommandRun: async () => ({ success: false }),
        terminalWatchCommandRuns: async () => ({ success: true }),
        terminalUnwatchCommandRuns: async () => ({ success: true }),
        onTerminalCommandRunChanged: subscribe('command-runs')
    };
    // 没有宽限期：最后一个持有者离开就退订，便于和起点比较
    getProjectForgeChangesSource(api, { graceMs: 0 });
    getCommandRunsSource(api, { graceMs: 0 });

    const controller = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        dormancy: { maxLiveViews: 1 }
    });
    class Terminal {
        constructor() { this.cols = 80; this.rows = 24; }
        open(screen) { screen.append(doc.createElement('textarea')); }
        onData() { return { dispose() {} }; }
        onResize() { return { dispose() {} }; }
        loadAddon() {} focus() {} write() {} clear() {} reset() {} dispose() {}
    }
    const providers = {
        terminal: createTerminalSideProvider({ document: doc, api, sidePaneController: controller,
            xtermLoader: async () => ({ Terminal, FitAddon: null }) }),
        'plan-detail': createPlanDetailSideProvider({ document: doc, api, sidePaneController: controller, uiHelper: {} }),
        'model-trajectory': createModelTrajectorySideProvider({ document: doc, api, sidePaneController: controller, uiHelper: {},
            getConversation: () => ({ item: { id: 'agent1', name: 'A' }, topicId: 't1' }) }),
        'tool-output': createToolOutputSideProvider({ document: doc, api, sidePaneController: controller, uiHelper: {} })
    };
    Object.entries(providers).forEach(([kind, provider]) => controller.registerProvider(kind, provider));
    const opens = {
        terminal: () => providers.terminal.openTerminalTab(),
        'plan-detail': () => providers['plan-detail'].openPlanDetailTab({ projectId: 'p1', projectName: '工程' }),
        'model-trajectory': () => providers['model-trajectory'].openModelTrajectoryTab(),
        'tool-output': () => providers['tool-output'].openToolOutputTab()
    };

    const { diagnostics } = globalThis.VCPLifecycle;
    const measure = () => ({
        scopes: diagnostics.summary().activeScopes,
        resources: diagnostics.summary().activeResources,
        channelSubscribers: globalThis.VCPStateChannels.diagnostics().reduce((sum, c) => sum + c.subscribers, 0),
        sourceHolders: globalThis.VCPSharedSources.diagnostics().reduce((sum, s) => sum + s.holders, 0),
        sourcesRunning: globalThis.VCPSharedSources.diagnostics().filter(s => s.running || s.polling).length,
        ipcListeners: [...listeners.values()].reduce((sum, n) => sum + n, 0),
        nodes: doc.body.querySelectorAll('*').length,
        views: controller.getViewResidency()
    });
    return { dom, controller, opens, calls, measure,
        async cleanup() { await controller.dispose(); dom.window.close(); } };
}

// 通知标签是常驻的，不参与开关
const openTabIds = controller => controller.getSnapshot().tabs.filter(tab => tab.closable !== false).map(tab => tab.id);

test(`opening and closing every tab type ${CYCLES} times returns to where it started`, async () => {
    const h = fixture();
    try {
        // 预热一轮：懒加载、通道注册之类只发生一次的东西不算泄漏
        for (const open of Object.values(h.opens)) {
            await open();
            await settle();
            for (const id of openTabIds(h.controller)) await h.controller.closeTab(id);
            await settle();
        }
        const baseline = h.measure();

        for (let i = 0; i < CYCLES; i++) {
            for (const open of Object.values(h.opens)) {
                await open();
                await settle();
                for (const id of openTabIds(h.controller)) await h.controller.closeTab(id);
                await settle();
            }
        }
        assert.deepEqual(h.measure(), baseline);
        assert.equal(h.calls.kills, h.calls.creates, 'every shell that was started was ended');
        assert.equal(h.calls.watches, h.calls.unwatches, 'every trajectory watch was released');
    } finally { await h.cleanup(); }
});

test(`views put to sleep and woken ${CYCLES} times leave nothing behind`, async () => {
    const h = fixture();
    try {
        for (const open of Object.values(h.opens)) await open();
        await settle();
        const ids = openTabIds(h.controller);
        // 只能有一个视图挂着：切到哪个标签，别的都休眠
        for (const id of ids) { h.controller.activateTab(id); await settle(); }
        const baseline = h.measure();
        assert.equal(baseline.views.live.length, 1);
        assert.equal(baseline.views.dormant.length, ids.length - 1);
        const shells = h.calls.creates;

        for (let i = 0; i < CYCLES; i++) {
            for (const id of ids) { h.controller.activateTab(id); await settle(); }
        }
        const after = h.measure();
        assert.deepEqual({ ...after, views: null }, { ...baseline, views: null });
        assert.equal(after.views.live.length, 1);
        assert.equal(h.calls.creates, shells, 'the terminal kept its shell through every sleep');
        assert.equal(h.calls.kills, 0);

        for (const id of ids) await h.controller.closeTab(id);
        await settle();
        assert.equal(h.calls.kills, h.calls.creates);
        assert.deepEqual(h.controller.getViewResidency(), { live: [], dormant: [] });
    } finally { await h.cleanup(); }
});
