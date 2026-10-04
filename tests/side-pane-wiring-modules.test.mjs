import test from 'node:test';
import assert from 'node:assert/strict';

// 渲染进程的副屏接线只在 Electron 里跑，其他测试大多按文本读它们；这里至少保证整张导入图能被解析，
// 语法错误不会等到窗口白屏才发现
test('side pane renderer wiring modules parse and export their factories', async () => {
    const sidePane = await import('../modules/renderer/sidePaneWiring.js');
    const sideChat = await import('../modules/renderer/sideChatWiring.js');
    const host = await import('../modules/renderer/sidePaneHostBindings.js');
    assert.equal(typeof sidePane.initWorkspaceSidePane, 'function');
    assert.equal(typeof sideChat.createSideChatWiring, 'function');
    assert.equal(typeof host.createSidePaneHostBindings, 'function');
});

test('restoring side chats in the background keeps the tab the user was looking at', async () => {
    const { JSDOM } = await import('jsdom');
    const { createSideChatWiring } = await import('../modules/renderer/sideChatWiring.js');
    const dom = new JSDOM('<!doctype html><body></body>');
    const parent = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-1' };
    let state = { parent, tabs: [{ id: 'browser:1', kind: 'browser' }], activeTabId: 'browser:1' };
    const activations = [];
    const controller = {
        getSnapshot: () => state,
        async openTab(raw) {
            const id = `chat:${raw.descriptor.child.topicId}`;
            state = { ...state, tabs: [...state.tabs, { id, kind: 'chat', descriptor: raw.descriptor }], activeTabId: id };
            return null;
        },
        activateTab(tabId, options) {
            activations.push([tabId, options]);
            state = { ...state, activeTabId: tabId };
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
        assert.deepEqual(activations, [['browser:1', { focus: false }]]);
    } finally {
        wiring.dispose?.();
        dom.window.close();
    }
});
