import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDE_PANE_LAYOUT_KEY } from '../modules/ui-system/side-pane/side-pane-persistence.js';

// sidePaneWiring / sideChatWiring 下面的测试都会真的跑；宿主绑定只在 Electron 里用，这里至少保证它能被解析
test('side pane host bindings module parses and exports its factory', async () => {
    const host = await import('../modules/renderer/sidePaneHostBindings.js');
    assert.equal(typeof host.createSidePaneHostBindings, 'function');
});

test('restoring side chats in the background keeps the tab the user was looking at', async () => {
    const { JSDOM } = await import('jsdom');
    const { createSideChatWiring } = await import('../modules/renderer/sideChatWiring.js');
    const dom = new JSDOM('<!doctype html><body></body>');
    const parent = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-1' };
    let state = { parent, tabs: [{ id: 'browser:1', kind: 'browser' }], activeTabId: 'browser:1' };
    const restoredBatches = [];
    const controller = {
        getSnapshot: () => state,
        async openTab() { throw new Error('restoring must not open (activate and expand) tabs'); },
        async restoreTabs(raws) {
            restoredBatches.push(raws.length);
            const tabs = raws.map(raw => ({ id: `chat:${raw.descriptor.child.topicId}`, kind: 'chat', descriptor: raw.descriptor }));
            state = { ...state, tabs: [...state.tabs, ...tabs] };
            return tabs.map(tab => tab.id);
        }
    };
    const chatAPI = {
        listSideChatMetadata: async () => ({ success: true, items: [{
            parent, child: { itemId: 'agent-1', topicId: 'child-1' }, title: '辅助对话 1', draft: '草稿'
        }] })
    };
    const wiring = createSideChatWiring({
        doc: dom.window.document, win: dom.window, chatAPI, chatRepository: null, chatManager: null, uiHelper: null,
        createRenderer: () => null, selectedItemRef: { get: () => null }, topicIdRef: { get: () => 'topic-1' },
        historyRef: { get: () => [] }, getController: () => controller
    });
    try {
        await wiring.restoreSessions('agent-1', 'topic-1');
        assert.ok(state.tabs.some(t => t.id === 'chat:child-1'));
        assert.equal(state.activeTabId, 'browser:1');
        assert.deepEqual(restoredBatches, [1]);
    } finally {
        wiring.dispose?.();
        dom.window.close();
    }
});

test('startup restores the saved layout against the current conversation: a pane saved open on another topic never flashes open', async () => {
    const { JSDOM } = await import('jsdom');
    const { initWorkspaceSidePane } = await import('../modules/renderer/sidePaneWiring.js');
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>', { url: 'http://localhost/' });
    const win = dom.window;
    const doc = win.document;
    const topicA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    win.localStorage.setItem(SIDE_PANE_LAYOUT_KEY, JSON.stringify({
        version: 1,
        tabs: [{ id: 'plan:a', kind: 'plan-detail', title: '计划', closable: true, scopeMode: 'topic', parent: topicA, payload: { projectId: 'p1' } }],
        activeTabId: 'plan:a', visible: true, activeByParent: [], collapsedByParent: []
    }));
    const root = doc.getElementById('pane');
    const classHistory = [];
    new win.MutationObserver(records => records.forEach(record => classHistory.push(record.oldValue || '')))
        .observe(root, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    const chatAPI = new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : async () => ({ success: false })) });
    const subscriptions = [];
    const controller = initWorkspaceSidePane({
        document: doc, window: win,
        elements: { root, tabList: doc.getElementById('tabs'), contentContainer: doc.getElementById('content') },
        chatAPI, chatRepository: null, chatManager: { onSelectionChange: () => () => {} }, uiHelper: null,
        createRenderer: () => null, settingsRef: { get: () => ({}) },
        selectedItemRef: { get: () => ({ id: 'agent-1', type: 'agent' }) }, topicIdRef: { get: () => 'topic-b' },
        historyRef: { get: () => [] }, subscriptions: { add: owner => subscriptions.push(owner) }
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    classHistory.push(root.className);
    try {
        assert.ok(controller.getSnapshot().tabs.some(tab => tab.id === 'plan:a'), 'the saved tab was restored');
        assert.equal(controller.getSnapshot().visible, false);
        assert.equal(classHistory.some(className => /\bactive\b/.test(className)), false, `pane never opened: ${classHistory.join(' | ')}`);
        // 副屏不再往主窗口挂全局函数，别的模块走命令
        assert.equal(win.vcpSidePaneController, undefined);
        assert.equal(win.openModelTrajectory, undefined);
    } finally {
        for (const owner of subscriptions.reverse()) await owner.dispose?.();
        win.close();
    }
});

test('a never-shown side chat asks before its history is deleted, and an empty one closes quietly', async () => {
    const { JSDOM } = await import('jsdom');
    const { createSideChatWiring } = await import('../modules/renderer/sideChatWiring.js');
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const confirms = [];
    let answer = false;
    const histories = { full: [{ id: 'm1', role: 'user', content: 'hi' }], empty: [] };
    const chatAPI = { getChatHistory: async (_agentId, topicId) => histories[topicId] };
    const uiHelper = { showConfirmDialog: async message => { confirms.push(message); return answer; }, showToastNotification() {} };
    const wiring = createSideChatWiring({
        doc: dom.window.document, win: dom.window, chatAPI, chatRepository: null, chatManager: null, uiHelper,
        createRenderer: () => null, selectedItemRef: { get: () => null }, topicIdRef: { get: () => 'topic-1' },
        historyRef: { get: () => [] }, getController: () => ({ getSnapshot: () => ({ tabs: [] }) })
    });
    try {
        const descriptor = topicId => ({ id: `side-${topicId}`, title: '辅助对话 1', parent: { itemId: 'agent-1', topicId: 'topic-1' }, child: { itemId: 'agent-1', topicId } });
        assert.deepEqual(await wiring.requestTabClose(descriptor('full')), { closed: false, reason: 'USER_CANCELED' });
        assert.equal(confirms.length, 1);
        answer = true;
        assert.deepEqual(await wiring.requestTabClose(descriptor('full')), { closed: true });
        assert.deepEqual(await wiring.requestTabClose(descriptor('empty')), { closed: true });
        assert.equal(confirms.length, 2, 'an empty side chat closes without a question');
    } finally {
        wiring.dispose?.();
        dom.window.close();
    }
});
