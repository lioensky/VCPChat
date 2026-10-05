import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { sideChatTab } from '../modules/ui-system/side-pane/tab-types/chat.js';

const openChat = (state, descriptor) => SidePaneState.openTab(state, sideChatTab(descriptor, state.tabs));
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
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
                <div id="sidePaneTabContextMenu" class="side-pane-context-menu" role="menu" hidden>
                    <button type="button" role="menuitem" data-action="close-tab">关闭当前标签页</button>
                    <button type="button" role="menuitem" data-action="close-others">关闭其他标签页</button>
                    <button type="button" role="menuitem" data-action="close-all">关闭所有标签页</button>
                </div>
                <div id="sidePaneAddMenu" class="side-pane-context-menu" role="menu" hidden>
                    <div data-add-menu-group="tools"></div>
                    <div class="side-pane-add-menu-separator" hidden></div>
                    <div class="side-pane-add-menu-heading" hidden>应用</div>
                    <div data-add-menu-group="apps" hidden></div>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewHome" data-tab-id="notifications">
                    <div class="side-pane-home-profile" hidden>
                        <button type="button" class="side-pane-home-avatar"><img alt=""></button>
                        <input type="text" class="side-pane-home-name" readonly>
                    </div>
                    <aside id="notificationsSidebar">
                        <div id="vcpLogConnectionStatus" data-status="unknown"><span class="notifications-status-text">VCPLog: 未连接</span></div>
                        <ul id="notificationsList"></ul>
                    </aside>
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
        expandButton: doc.getElementById('toggleSidePaneChatBtn'),
        addTabButton: doc.getElementById('addSidePaneChatBtn'),
        tabTypes: [defineChatTabType({ provider: mockChatProvider(options.disposed) })],
        ...options.controller
    });
}

test('Parity: closing the last closable tab of the conversation collapses the pane', () => {
    const parent = { itemType: 'agent', itemId: 'agent-1', topicId: 'parent' };
    let s = SidePaneState.setParent(SidePaneState.createInitialSidePaneState({ visible: true }), parent);
    s = openChat(s, createDesc('s1', 'c1'));
    s = openChat(s, createDesc('other', 'c9', 'other-topic'));
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
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('other', 'c9', 'other-topic') });
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s1', 'c1') });
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s2', 'c2') });
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s3', 'c3') });

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

test('Parity: the add button opens a small menu of tool entries', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const addBtn = doc.getElementById('addSidePaneChatBtn');
    const menu = doc.getElementById('sidePaneAddMenu');
    const opened = [];
    const ctrl = createController(dom);
    const labels = () => [...menu.querySelectorAll('[data-open-tab-entry] .side-pane-menu-item-label')].map(el => el.textContent);

    // 没有入口：按钮隐藏
    assert.equal(addBtn.hidden, true);

    // 一个入口、没有应用：直接打开，不弹菜单
    const disposeChat = ctrl.registerOpenTabEntry({ id: 'chat', label: '辅助对话', icon: 'chat_bubble', open: () => opened.push('chat') });
    assert.equal(addBtn.hidden, false);
    assert.equal(addBtn.getAttribute('aria-label'), '辅助对话');
    assert.equal(addBtn.hasAttribute('aria-haspopup'), false);
    addBtn.click();
    await tick();
    assert.deepEqual(opened, ['chat']);
    assert.equal(menu.hidden, true);

    // 两个入口：弹菜单，按 order 排；菜单不改变当前标签
    ctrl.registerOpenTabEntry({ id: 'browser', label: '浏览器', order: 50, open: () => opened.push('browser') });
    assert.equal(addBtn.getAttribute('aria-label'), '新标签页');
    assert.equal(addBtn.getAttribute('aria-haspopup'), 'menu');
    const before = ctrl.getSnapshot();
    addBtn.click();
    assert.equal(menu.hidden, false);
    assert.equal(addBtn.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(labels(), ['浏览器', '辅助对话']);
    assert.equal(doc.activeElement, menu.querySelector('[data-open-tab-entry="browser"]'));
    assert.equal(ctrl.getSnapshot().activeTabId, before.activeTabId);
    assert.equal(ctrl.getSnapshot().visible, before.visible);
    assert.equal(menu.querySelector('.side-pane-add-menu-separator').hidden, true, '没有应用时不画分隔线');

    // 方向键移动，Esc 收起并把焦点还给「+」
    menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.activeElement, menu.querySelector('[data-open-tab-entry="chat"]'));
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(menu.hidden, true);
    assert.equal(addBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, addBtn);

    // 点一项：打开并收起菜单
    addBtn.click();
    menu.querySelector('[data-open-tab-entry="chat"]').click();
    await tick();
    assert.deepEqual(opened, ['chat', 'chat']);
    assert.equal(menu.hidden, true);

    // 点外面收起
    addBtn.click();
    doc.getElementById('chatMessages').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(menu.hidden, true);

    // 注销后回到单入口
    disposeChat();
    assert.equal(addBtn.getAttribute('aria-label'), '浏览器');
    assert.deepEqual(labels(), ['浏览器']);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the add menu lists apps under the tool entries', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const addBtn = doc.getElementById('addSidePaneChatBtn');
    const menu = doc.getElementById('sidePaneAddMenu');
    const apps = menu.querySelector('[data-add-menu-group="apps"]');
    const heading = menu.querySelector('.side-pane-add-menu-heading');
    const separator = menu.querySelector('.side-pane-add-menu-separator');
    const opened = [];
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'chat', label: '辅助对话', open: () => opened.push('chat') }] }
    });

    let providerCalls = 0;
    let list = [
        { id: 'notes', label: '笔记', title: '笔记（在独立窗口中打开）', iconSvg: '<svg class="tray-notes"></svg>', open: () => opened.push('notes') },
        { id: 'dice', label: '骰子', open: () => opened.push('dice') }
    ];
    ctrl.setAddMenuAppsProvider(() => {
        providerCalls += 1;
        return list;
    });
    // 有应用来源时，就算只有一个入口也弹菜单
    assert.equal(addBtn.getAttribute('aria-label'), '新标签页');
    assert.equal(providerCalls, 0, '菜单没打开前不读应用');

    addBtn.click();
    assert.equal(menu.hidden, false);
    assert.equal(providerCalls, 1);
    assert.equal(apps.hidden, false);
    assert.equal(heading.hidden, false);
    assert.equal(separator.hidden, false);
    const rows = [...apps.querySelectorAll('[data-add-menu-app]')];
    assert.deepEqual(rows.map(row => row.querySelector('.side-pane-menu-item-label').textContent), ['笔记', '骰子']);
    assert.equal(rows[0].title, '笔记（在独立窗口中打开）');
    assert.ok(rows[0].querySelector('.side-pane-add-menu-app-icon svg.tray-notes'));
    assert.equal(rows[1].querySelector('.side-pane-add-menu-app-icon .vcp-ui-icon').textContent, 'app-window', '没有图标时用默认图标');

    // 方向键从入口走到应用
    menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(doc.activeElement, rows[1]);

    rows[1].click();
    await tick();
    assert.deepEqual(opened, ['dice']);
    assert.equal(menu.hidden, true);

    // 每次打开现取
    list = [];
    addBtn.click();
    assert.equal(providerCalls, 2);
    assert.equal(apps.hidden, true);
    assert.equal(heading.hidden, true);
    assert.equal(separator.hidden, true);
    addBtn.click();
    assert.equal(menu.hidden, true, '再点「+」收起');

    // 撤掉应用来源后回到单入口直接打开
    ctrl.setAddMenuAppsProvider(null);
    assert.equal(addBtn.getAttribute('aria-label'), '辅助对话');
    addBtn.click();
    await tick();
    assert.deepEqual(opened, ['dice', 'chat']);
    assert.equal(menu.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the home page shows the current assistant and its avatar edit entry', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const profile = doc.querySelector('.side-pane-home-profile');
    const avatar = profile.querySelector('.side-pane-home-avatar');
    const edits = [];
    let current = { name: 'Nova', avatarUrl: 'nova.png', onEditAvatar: () => edits.push('Nova') };
    const ctrl = createController(dom);

    assert.equal(profile.hidden, true, '没有提供者时不显示');
    ctrl.setHomeProfileProvider(() => current);
    assert.equal(profile.hidden, false);
    assert.equal(profile.querySelector('.side-pane-home-name').value, 'Nova');
    assert.equal(profile.querySelector('img').getAttribute('src'), 'nova.png');
    assert.equal(avatar.getAttribute('aria-label'), '编辑头像');
    avatar.click();
    assert.deepEqual(edits, ['Nova']);

    // 每次回到首页现取：换了助手（群组不能编辑、没有头像用默认图）
    current = { name: '群组', avatarUrl: '', onEditAvatar: null };
    ctrl.showNotifications();
    assert.equal(profile.querySelector('.side-pane-home-name').value, '群组');
    assert.equal(profile.querySelector('img').getAttribute('src'), 'assets/default_avatar.png');
    assert.equal(avatar.disabled, true);
    avatar.click();
    assert.deepEqual(edits, ['Nova']);

    current = null;
    ctrl.activateTab(SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.equal(profile.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the home page name can be edited in place', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const name = doc.querySelector('.side-pane-home-name');
    const renames = [];
    let result = { success: true };
    const current = { name: 'Nova', avatarUrl: '', onRename: (value) => { renames.push(value); return result; } };
    const ctrl = createController(dom);
    ctrl.setHomeProfileProvider(() => current);
    assert.equal(name.readOnly, false);

    const key = (value) => name.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }));

    // Esc 放弃
    name.focus();
    name.value = '临时';
    key('Escape');
    await tick();
    assert.equal(name.value, 'Nova');
    assert.deepEqual(renames, []);

    // 空名字不保存
    name.focus();
    name.value = '   ';
    key('Enter');
    await tick();
    assert.equal(name.value, 'Nova');
    assert.deepEqual(renames, []);

    // 回车保存，去掉首尾空格
    name.focus();
    name.value = ' Nova 2 ';
    key('Enter');
    await tick();
    assert.deepEqual(renames, ['Nova 2']);
    assert.equal(name.value, 'Nova 2');

    // 保存失败时恢复原名
    result = { error: 'disk' };
    name.focus();
    name.value = 'Nova 3';
    key('Enter');
    await tick();
    assert.deepEqual(renames, ['Nova 2', 'Nova 3']);
    assert.equal(name.value, 'Nova 2');

    // 没有改名入口时只读
    ctrl.setHomeProfileProvider(() => ({ name: '群组', avatarUrl: '' }));
    assert.equal(name.readOnly, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the home tab is pinned first in the strip and hosts the notifications', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const home = doc.getElementById('sidePaneViewHome');
    const ctrl = createController(dom);
    const stripTabIds = () => [...doc.querySelectorAll('.side-pane-tabs .side-pane-tab')].map(btn => btn.getAttribute('data-tab-id'));
    const homeTab = () => doc.querySelector('.side-pane-tabs .side-pane-tab-item.is-home');

    ctrl.setVisible(true, { animate: false });
    assert.deepEqual(stripTabIds(), ['notifications']);
    assert.equal(homeTab().querySelector('.side-pane-tab-close'), null, '首页不能关');
    assert.equal(homeTab().querySelector('.tab-icon').textContent, 'house');
    assert.equal(homeTab().draggable, false);
    assert.equal(home.hidden, false);
    assert.ok(home.contains(doc.getElementById('notificationsSidebar')));

    // 打开的标签排在首页后面；切过去首页隐藏，点首页回来
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s1', 'c1') });
    assert.deepEqual(stripTabIds(), ['notifications', 's1']);
    assert.equal(home.hidden, true);
    homeTab().querySelector('.side-pane-tab').click();
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.equal(home.hidden, false);

    // 换话题：首页留着，别的话题的标签不显示
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'other' });
    assert.deepEqual(stripTabIds(), ['notifications']);

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
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s1', 'c1') });

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

    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s2', 'c2') });
    openMenuOn('s1');
    contextMenu.querySelector('[data-action="close-others"]').click();
    await tick();
    assert.equal(contextMenu.hidden, true);
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id), ['notifications', 's1']);
    assert.equal(ctrl.getSnapshot().activeTabId, 's1');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the expand button opens the home page when the conversation has no tabs', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');
    const ctrl = createController(dom, {
        controller: {
            openTabEntries: [
                { id: 'chat', label: '辅助对话', open() {} },
                { id: 'browser', label: '浏览器', open() {} }
            ]
        }
    });

    assert.equal(toggleBtn.hidden, false);
    toggleBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.equal(doc.getElementById('sidePaneViewHome').hidden, false);
    assert.equal(doc.getElementById('sidePaneAddMenu').hidden, true, '展开侧栏不弹「+」菜单');
    assert.equal(toggleBtn.hidden, true, '面板展开后标题栏按钮隐藏');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the expand button opens notifications while approvals are pending', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');
    const opened = [];
    const ctrl = createController(dom, {
        controller: {
            openTabEntries: [
                { id: 'chat', label: '辅助对话', open: () => opened.push('chat') },
                { id: 'browser', label: '浏览器', open: () => opened.push('browser') }
            ]
        }
    });

    // 角标由 notificationCenter 写在侧栏按钮上
    toggleBtn.dataset.pendingCount = '2';
    toggleBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.equal(ctrl.getSnapshot().activeTabId, 'notifications');
    assert.deepEqual(opened, []);

    toggleBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().visible, false, '展开时再点仍是收起');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the pane width ratio ignores the stale key and never measures against the window', async () => {
    const widthAfterOpen = async (settings) => {
        const dom = createParityTestDOM();
        const root = dom.window.document.getElementById('vcpSidePane');
        const ctrl = createController(dom, { controller: { settingsRef: { get: () => settings, set() {} } } });
        ctrl.setVisible(true, { animate: false });
        await tick();
        // JSDOM 没有布局：父元素宽度为 0，拖动换算不能退回窗口宽度
        ctrl.setPreferredWidth(451);
        const width = root.style.width;
        await ctrl.dispose();
        dom.window.close();
        return width;
    };

    // 旧键曾按整窗宽度存了偏小的比例，弃用后回到默认 45%
    assert.equal(await widthAfterOpen({ notificationsSidebarRatio: 0.2435 }), '45%');
    assert.equal(await widthAfterOpen({ sidePaneWidthRatio: 0.3 }), '30%');
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
    const html = fs.readFileSync(new URL('../main.html', import.meta.url), 'utf8');
    const css = [...html.matchAll(/href="(styles\/ui-system\/side-pane-[^"]+\.css)"/g)]
        .map(([, href]) => fs.readFileSync(new URL(`../${href}`, import.meta.url), 'utf8')).join('');

    // The pane sits inside the workspace card, so its only edge is a hairline
    // on the left, drawn with the same token as the card border.
    assert.match(css, /html #vcpSidePane:where\(\.vcp-ui-scope, \.vcp-ui-scope \*\) \{[^}]*border-left:\s*1px solid var\(--next-panel-edge/);
    // Main panel and main content are outside .vcp-ui-scope: scoped rules for
    // them would never match, so the side pane stylesheet must not carry any.
    assert.doesNotMatch(css, /#nextUiMainPanel:where\(\.vcp-ui-scope/);
    assert.doesNotMatch(css, /\.main-content[^{]*:where\(\.vcp-ui-scope/);

    assert.match(css, /html \.side-pane-tab-bar[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
    // VCPLog status lives on the home tab, so the panel has no second header row.
    assert.doesNotMatch(css, /\.notifications-header/);
});


test('tab type registration connects presentation, add-menu availability and provider mounting', async () => {
    const dom = createParityTestDOM();
    const ctrl = createController(dom);
    const doc = dom.window.document;
    let available = false;
    const mounted = [];
    const unregister = ctrl.registerTabType({
        kind: 'custom-notes', label: 'Custom notes', icon: 'edit_note', searchHint: 'memo',
        provider: { mountTab: async tab => { mounted.push(tab.id); return { dispose() {} }; } },
        entry: { id: 'custom-notes', order: 2, isAvailable: () => available,
            open: () => ctrl.openTab({ id: 'custom-notes:1', kind: 'custom-notes', title: 'One' }) }
    });
    assert.equal(doc.querySelector('[data-open-tab-entry="custom-notes"]'), null);
    available = true;
    ctrl.refreshOpenTabEntries();
    const entry = doc.querySelector('[data-open-tab-entry="custom-notes"]');
    assert.match(entry.textContent, /Custom notes/);
    entry.click();
    await tick();
    assert.deepEqual(mounted, ['custom-notes:1']);
    const tab = ctrl.getSnapshot().tabs.find(tab => tab.id === 'custom-notes:1');
    assert.equal(tab.icon, 'edit_note');
    assert.equal(tab.typeLabel, 'Custom notes');
    assert.equal(tab.searchHint, 'memo');
    assert.equal(doc.querySelector('[data-tab-id="custom-notes:1"] .vcp-side-pane-icon-base').textContent, 'edit_note');
    unregister();
    assert.equal(ctrl.getTabType('custom-notes'), null);
    assert.equal(doc.querySelector('[data-open-tab-entry="custom-notes"]'), null);
    await ctrl.dispose();
    dom.window.close();
});

test('tab type registrations stay local and stale unregistration cannot remove a replacement', async () => {
    const firstDOM = createParityTestDOM();
    const secondDOM = createParityTestDOM();
    const first = createController(firstDOM);
    const second = createController(secondDOM);
    const stale = first.registerTabType({ kind: 'custom', label: 'Old', entry: { open() {} } });
    first.registerTabType({ kind: 'custom', label: 'New', entry: { open() {} } });
    stale();
    assert.equal(first.getTabType('custom').label, 'New');
    assert.equal(second.getTabType('custom'), null);
    assert.match(firstDOM.window.document.querySelector('[data-open-tab-entry="custom"]').textContent, /New/);
    assert.throws(() => first.registerTabType({ kind: 'invalid', label: 'Invalid', entry: {} }), TypeError);
    assert.equal(first.getTabType('invalid'), null);
    await Promise.all([first.dispose(), second.dispose()]);
    firstDOM.window.close();
    secondDOM.window.close();
});

test('replacing a tab type without an entry removes its previous add-menu action', async () => {
    const dom = createParityTestDOM();
    const ctrl = createController(dom);
    let opened = 0;
    try {
        const stale = ctrl.registerTabType({ kind: 'custom', label: 'Old', entry: { id: 'old-action', open() { opened++; } } });
        const unregister = ctrl.registerTabType({ kind: 'custom', label: 'Placeholder' });
        const oldAction = dom.window.document.querySelector('[data-open-tab-entry="old-action"]');
        oldAction?.click();
        assert.equal(oldAction, null, 'the removed declaration must not leave a live add-menu action');
        assert.equal(opened, 0);
        stale();
        assert.equal(ctrl.getTabType('custom').label, 'Placeholder');
        unregister();
        assert.equal(ctrl.getTabType('custom'), null);
    } finally {
        await ctrl.dispose();
        dom.window.close();
    }
});

test('replacing a tab type without a provider cannot mount through the retired provider', async () => {
    const dom = createParityTestDOM();
    const ctrl = createController(dom);
    let mounts = 0;
    try {
        ctrl.registerTabType({ kind: 'custom', label: 'Old', provider: { mountTab() { mounts++; return {}; } } });
        ctrl.registerTabType({ kind: 'custom', label: 'Placeholder' });
        assert.equal(await ctrl.openTab({ id: 'placeholder', kind: 'custom' }), null);
        assert.equal(mounts, 0, 'no provider on the replacement means a placeholder');
    } finally {
        await ctrl.dispose();
        dom.window.close();
    }
});

test('entry identity changes replace the whole declaration, while invalid replacements keep the old one', async () => {
    const dom = createParityTestDOM();
    const ctrl = createController(dom);
    const opened = [];
    try {
        const stale = ctrl.registerTabType({ kind: 'custom', label: 'Old', entry: { id: 'old-action', open() { opened.push('old'); } } });
        assert.throws(() => ctrl.registerTabType({ kind: 'custom', label: 'Invalid', entry: {} }), TypeError);
        assert.equal(ctrl.getTabType('custom').label, 'Old');
        dom.window.document.querySelector('[data-open-tab-entry="old-action"]').click();
        const unregister = ctrl.registerTabType({ kind: 'custom', label: 'New', entry: { id: 'new-action', open() { opened.push('new'); } } });
        assert.equal(dom.window.document.querySelector('[data-open-tab-entry="old-action"]'), null);
        stale();
        dom.window.document.querySelector('[data-open-tab-entry="new-action"]').click();
        assert.deepEqual(opened, ['old', 'new']);
        unregister();
        assert.equal(dom.window.document.querySelector('[data-open-tab-entry="new-action"]'), null);
    } finally {
        await ctrl.dispose();
        dom.window.close();
    }
});
