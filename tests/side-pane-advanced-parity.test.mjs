import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function createParityTestDOM() {
    return new JSDOM(`
        <div class="main-content">
            <div class="chat-messages" id="chatMessages"></div>
        </div>
        <button id="toggleSidePaneChatBtn" type="button"></button>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <button id="sidePaneTabOverviewBtn" class="side-pane-action-btn" type="button"></button>
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                    <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button"></button>
                </div>
                <div id="sidePaneTabOverviewPopover" class="side-pane-tab-overview-popover" role="dialog" hidden>
                    <div id="sidePaneOpenTabsList"></div>
                </div>
                <div id="sidePaneAddMenuPopover" class="side-pane-add-menu-popover" role="menu" hidden></div>
                <div id="sidePaneTabContextMenu" class="side-pane-context-menu" role="menu" hidden>
                    <button type="button" role="menuitem" data-action="close-tab">关闭当前标签页</button>
                    <button type="button" role="menuitem" data-action="close-others">关闭其他标签页</button>
                    <button type="button" role="menuitem" data-action="close-all">关闭所有标签页</button>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
                <section class="side-pane-view" id="sidePaneViewLauncher" data-tab-id="launcher" hidden>
                    <div class="side-pane-open-tab-list"></div>
                </section>
            </div>
        </aside>
    `);
}

const createDesc = (id = 's1', child = 'child-1', parentTopic = 'parent') => ({
    id,
    title: `侧聊-${id}`,
    parent: { itemType: 'agent', itemId: 'agent-1', topicId: parentTopic, name: 'Agent' },
    child: { itemType: 'agent', itemId: 'agent-1', topicId: child },
    contextMode: 'references-only'
});

const mockChatProvider = (disposed = []) => ({
    async mountTab(desc) {
        return {
            focus() {},
            async requestClose() { return { closed: true }; },
            async dispose() { disposed.push(desc.id); }
        };
    }
});

function createController(dom, options = {}) {
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    return createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        toggleChatBtn: doc.getElementById('toggleSidePaneChatBtn'),
        addChatTabBtn: doc.getElementById('addSidePaneChatBtn'),
        providers: { chat: mockChatProvider(options.disposed) },
        ...options.controller
    });
}

test('Parity: closing the last closable tab of the conversation collapses the pane', () => {
    const parent = { itemType: 'agent', itemId: 'agent-1', topicId: 'parent' };
    let s = SidePaneState.setParent(SidePaneState.createInitialSidePaneState({ visible: true }), parent);
    s = SidePaneState.openChatTab(s, createDesc('s1', 'c1'));
    s = SidePaneState.openChatTab(s, createDesc('other', 'c9', 'other-topic'));
    assert.deepEqual(SidePaneState.getClosableVisibleTabs(s).map(t => t.id), ['s1']);

    // 另一个话题的标签不算：关掉 s1 后当前对话已经没有可关的标签
    const closed = SidePaneState.closeTab(s, 's1');
    assert.equal(closed.visible, false);
    assert.equal(closed.activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.ok(closed.tabs.some(t => t.id === 'other'));

    // 批量关闭时中间步骤不收起
    const kept = SidePaneState.closeTab(s, 's1', { collapseWhenEmpty: false });
    assert.equal(kept.visible, true);

    // 通知页不能关
    assert.equal(SidePaneState.closeTab(s, SidePaneState.NOTIFICATIONS_TAB_ID), s);
});

test('Parity: close-others and close-all only touch the current conversation', async () => {
    const dom = createParityTestDOM();
    const disposed = [];
    const ctrl = createController(dom, { disposed });

    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'other-topic' });
    await ctrl.openChat(createDesc('other', 'c9', 'other-topic'));
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openChat(createDesc('s1', 'c1'));
    await ctrl.openChat(createDesc('s2', 'c2'));
    await ctrl.openChat(createDesc('s3', 'c3'));

    await ctrl.closeOtherTabs('s2');
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id).sort(), ['notifications', 'other', 's2']);
    assert.equal(ctrl.getSnapshot().activeTabId, 's2');
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.deepEqual(disposed.sort(), ['s1', 's3']);

    await ctrl.closeAllTabs();
    assert.ok(disposed.includes('s2'));
    assert.equal(disposed.includes('other'), false, '别的话题的标签不受影响');
    assert.equal(ctrl.getSnapshot().visible, false, '当前对话的标签全关后收起');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the add button follows the registered entries', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const addBtn = doc.getElementById('addSidePaneChatBtn');
    const addMenu = doc.getElementById('sidePaneAddMenuPopover');
    const opened = [];
    const ctrl = createController(dom);

    // 没有入口：按钮隐藏
    assert.equal(addBtn.hidden, true);

    // 一个入口：直接打开，不弹菜单
    const disposeChat = ctrl.registerOpenTabEntry({ id: 'chat', label: '辅助对话', icon: 'chat_bubble', open: () => opened.push('chat') });
    assert.equal(addBtn.hidden, false);
    assert.equal(addBtn.getAttribute('aria-label'), '辅助对话');
    assert.equal(addBtn.hasAttribute('aria-haspopup'), false);
    addBtn.click();
    await tick();
    assert.deepEqual(opened, ['chat']);
    assert.equal(addMenu.hidden, true);

    // 两个入口：弹出菜单，按 order 排序
    ctrl.registerOpenTabEntry({ id: 'browser', label: '浏览器', order: 50, open: () => opened.push('browser') });
    assert.equal(addBtn.getAttribute('aria-haspopup'), 'menu');
    addBtn.click();
    assert.equal(addMenu.hidden, false);
    assert.equal(addBtn.getAttribute('aria-expanded'), 'true');
    const items = [...addMenu.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(items.map(i => i.querySelector('.side-pane-menu-item-label').textContent), ['浏览器', '辅助对话']);
    assert.equal(doc.activeElement, items[0], '打开菜单后焦点落在第一项');

    items[1].click();
    await tick();
    assert.deepEqual(opened, ['chat', 'chat']);
    assert.equal(addMenu.hidden, true);

    // Esc 关闭并把焦点还给按钮
    addBtn.click();
    assert.equal(addMenu.hidden, false);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(addMenu.hidden, true);
    assert.equal(doc.activeElement, addBtn);

    // 点外面关闭
    addBtn.click();
    doc.getElementById('chatMessages').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(addMenu.hidden, true);

    // 注销后回到单入口
    disposeChat();
    assert.equal(addBtn.getAttribute('aria-label'), '浏览器');
    assert.equal(addMenu.querySelectorAll('[role="menuitem"]').length, 1);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: entries can hide themselves with isAvailable', () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    let available = false;
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'x', label: 'X', open() {}, isAvailable: () => available }] }
    });
    assert.equal(doc.getElementById('addSidePaneChatBtn').hidden, true);
    available = true;
    ctrl.refreshOpenTabEntries();
    assert.equal(doc.getElementById('addSidePaneChatBtn').hidden, false);
    assert.throws(() => ctrl.registerOpenTabEntry({ id: 'bad' }), TypeError);
    ctrl.dispose();
    dom.window.close();
});

test('Parity: tab context menu is scoped, keyboard friendly and closes on Escape', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const tabList = doc.querySelector('.side-pane-tabs');
    const contextMenu = doc.getElementById('sidePaneTabContextMenu');
    const ctrl = createController(dom);

    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openChat(createDesc('s1', 'c1'));

    const openMenuOn = (tabId) => tabList.querySelector(`[data-tab-id="${tabId}"]`).dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { clientX: 200, clientY: 100, bubbles: true, cancelable: true }));
    const isDisabled = (action) => contextMenu.querySelector(`[data-action="${action}"]`).disabled;

    // 只有一个可关的标签：关闭其他不可用
    openMenuOn('s1');
    assert.equal(contextMenu.hidden, false);
    assert.equal(isDisabled('close-tab'), false);
    assert.equal(isDisabled('close-others'), true);
    assert.equal(isDisabled('close-all'), false);
    assert.equal(doc.activeElement, contextMenu.querySelector('[data-action="close-tab"]'));

    // 方向键在可用项之间移动
    contextMenu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.activeElement, contextMenu.querySelector('[data-action="close-all"]'));

    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(contextMenu.hidden, true);

    // 通知页不能关，但能关掉其他
    openMenuOn('notifications');
    assert.equal(isDisabled('close-tab'), true);
    assert.equal(isDisabled('close-others'), false);

    await ctrl.openChat(createDesc('s2', 'c2'));
    openMenuOn('s1');
    contextMenu.querySelector('[data-action="close-others"]').click();
    await tick();
    assert.equal(contextMenu.hidden, true);
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id), ['notifications', 's1']);
    assert.equal(ctrl.getSnapshot().activeTabId, 's1');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the expand button shows the launcher when several entries exist', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');
    const launcherView = doc.getElementById('sidePaneViewLauncher');
    const opened = [];
    const ctrl = createController(dom, {
        controller: {
            openTabEntries: [
                { id: 'chat', label: '辅助对话', open: () => opened.push('chat') },
                { id: 'browser', label: '浏览器', open: () => opened.push('browser') }
            ]
        }
    });

    assert.equal(toggleBtn.hidden, false);
    toggleBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');
    assert.equal(launcherView.hidden, false);
    assert.equal(doc.getElementById('sidePaneViewNotifications').hidden, true);
    assert.equal(toggleBtn.hidden, true, '面板展开后标题栏按钮隐藏');

    const buttons = launcherView.querySelectorAll('[data-open-tab-entry]');
    assert.equal(buttons.length, 2);
    buttons[1].click();
    await tick();
    assert.deepEqual(opened, ['browser']);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: Side Chat Model Picker supports interactive switching', async () => {
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;

    let selected;
    const caps = {
        repository: { getHistory: async () => [], saveHistory: async () => ({ success: true }) },
        createRenderer({ conversation }) {
            selected = conversation.selectedItem;
            return {
                renderer: { renderHistory: async () => {} },
                conversation: { selectedItemRef: { get: () => selected }, topicIdRef: { get: () => 'c1' }, historyRef: { get: () => [] } },
                dispose: async () => {}
            };
        },
        manager: { sendMessage: async () => ({ terminal: { event: { type: 'completed' } } }) },
        listModels: async () => ({ ids: ['claude-3-5-sonnet', 'gemini-1.5-pro'], favorites: new Set() })
    };

    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDesc('s1', 'c1'),
        chatCapabilities: caps
    });
    await tick();

    const pickerBtn = doc.querySelector('.side-chat-model-picker-btn');
    const popover = doc.querySelector('.side-chat-model-popover');
    assert.ok(pickerBtn, 'Should have model picker button');
    assert.ok(popover, 'Should have model popover');

    // Click button to toggle popover
    pickerBtn.click();
    await tick();
    assert.equal(popover.hidden, false);

    // Click claude-3-5-sonnet
    const claudeItem = popover.querySelector('[data-model="claude-3-5-sonnet"]');
    assert.ok(claudeItem);
    claudeItem.click();

    assert.equal(handle.getModel(), 'claude-3-5-sonnet');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'claude-3-5-sonnet');
    assert.equal(popover.hidden, true);

    // Direct setModel via handle
    handle.setModel('gemini-1.5-pro');
    assert.equal(handle.getModel(), 'gemini-1.5-pro');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'gemini-1.5-pro');

    await handle.dispose();
    dom.window.close();
});

test('Side pane divider and header hairlines', () => {
    const css = fs.readFileSync(new URL('../styles/ui-system/side-pane.css', import.meta.url), 'utf8');

    // The pane sits inside the workspace card, so its only edge is a hairline
    // on the left, drawn with the same token as the card border.
    assert.match(css, /html #vcpSidePane:where\(\.vcp-ui-scope, \.vcp-ui-scope \*\) \{[^}]*border-left:\s*1px solid var\(--next-panel-edge/);
    // Main panel and main content are outside .vcp-ui-scope: scoped rules for
    // them would never match, so the side pane stylesheet must not carry any.
    assert.doesNotMatch(css, /#nextUiMainPanel:where\(\.vcp-ui-scope/);
    assert.doesNotMatch(css, /\.main-content[^{]*:where\(\.vcp-ui-scope/);

    assert.match(css, /html \.side-pane-tab-bar[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
    assert.match(css, /html #vcpSidePane \.notifications-header[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
});
