import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { sideChatTab } from '../modules/ui-system/side-pane/tab-types/chat.js';

const openChat = (state, descriptor) => SidePaneState.openTab(state, sideChatTab(descriptor, state.tabs));
import '../modules/ui-system/state-channel.js';
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
                <button id="sidePaneHomeBtn" class="side-pane-action-btn side-pane-home-btn" type="button" aria-pressed="false"></button>
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
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
                <section class="side-pane-view" id="sidePaneViewLauncher" data-tab-id="launcher" hidden>
                    <div class="side-pane-launcher-profile" hidden>
                        <button type="button" class="side-pane-launcher-avatar"><img alt=""></button>
                        <input type="text" class="side-pane-launcher-name" readonly>
                    </div>
                    <div class="side-pane-launcher-tabs" hidden>
                        <button type="button" data-launcher-tab="tools" aria-selected="true">工具</button>
                        <button type="button" data-launcher-tab="apps" aria-selected="false">应用</button>
                    </div>
                    <section data-launcher-section="tools"><div class="side-pane-open-tab-list"></div></section>
                    <section data-launcher-section="apps" hidden><div class="side-pane-launcher-app-grid"></div></section>
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

test('Parity: the add button opens the new tab page with tool rows', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const addBtn = doc.getElementById('addSidePaneChatBtn');
    const launcherView = doc.getElementById('sidePaneViewLauncher');
    const toolsSection = launcherView.querySelector('[data-launcher-section="tools"]');
    const opened = [];
    const ctrl = createController(dom);

    // 没有入口：按钮和工具区都隐藏
    assert.equal(addBtn.hidden, true);
    assert.equal(toolsSection.hidden, true);

    // 一个入口：直接打开，不进新标签页
    const disposeChat = ctrl.registerOpenTabEntry({ id: 'chat', label: '辅助对话', icon: 'chat_bubble', open: () => opened.push('chat') });
    assert.equal(addBtn.hidden, false);
    assert.equal(addBtn.getAttribute('aria-label'), '辅助对话');
    addBtn.click();
    await tick();
    assert.deepEqual(opened, ['chat']);
    assert.notEqual(ctrl.getSnapshot().activeTabId, 'launcher');

    // 两个入口：打开新标签页，工具按 order 排成列表
    ctrl.registerOpenTabEntry({ id: 'browser', label: '浏览器', order: 50, open: () => opened.push('browser') });
    const launcherLabel = addBtn.getAttribute('aria-label');
    assert.ok(launcherLabel);
    assert.notEqual(launcherLabel, '辅助对话', '多个入口时按钮不再代表某一个入口');
    assert.equal(addBtn.hasAttribute('aria-haspopup'), false);
    addBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');
    assert.equal(launcherView.hidden, false);
    assert.equal(toolsSection.hidden, false);
    const rows = [...launcherView.querySelectorAll('[data-open-tab-entry]')];
    assert.deepEqual(rows.map(r => r.dataset.openTabEntry), ['browser', 'chat']);

    rows[1].click();
    await tick();
    assert.deepEqual(opened, ['chat', 'chat']);

    // 注销后回到单入口
    disposeChat();
    assert.equal(addBtn.getAttribute('aria-label'), '浏览器');
    assert.equal(launcherView.querySelectorAll('[data-open-tab-entry]').length, 1);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the home button always returns to the new tab page', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const homeBtn = doc.getElementById('sidePaneHomeBtn');
    const launcherView = doc.getElementById('sidePaneViewLauncher');
    const opened = [];
    const ctrl = createController(dom);
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });

    // 只有一个入口时「+」直接打开它，小房子仍然进新标签页
    ctrl.registerOpenTabEntry({ id: 'chat', label: '辅助对话', open: () => opened.push('chat') });
    homeBtn.click();
    await tick();
    assert.deepEqual(opened, []);
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');
    assert.equal(launcherView.hidden, false);
    assert.equal(homeBtn.getAttribute('aria-pressed'), 'true');

    // 切到别的标签后不再按下，点小房子回到新标签页
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s1', 'c1') });
    assert.equal(ctrl.getSnapshot().activeTabId, 's1');
    assert.equal(homeBtn.getAttribute('aria-pressed'), 'false');
    homeBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');
    assert.equal(homeBtn.getAttribute('aria-pressed'), 'true');
    assert.ok(ctrl.getSnapshot().tabs.some(tab => tab.id === 's1'));

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the new tab page shows the current assistant and its avatar edit entry', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const profile = doc.querySelector('.side-pane-launcher-profile');
    const avatar = profile.querySelector('.side-pane-launcher-avatar');
    const edits = [];
    let current = { name: 'Nova', avatarUrl: 'nova.png', onEditAvatar: () => edits.push('Nova') };
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'a', label: 'A', open() {} }, { id: 'b', label: 'B', open() {} }] }
    });

    assert.equal(profile.hidden, true, '没有提供者时不显示');
    ctrl.setLauncherProfileProvider(() => current);
    assert.equal(profile.hidden, false);
    assert.equal(profile.querySelector('.side-pane-launcher-name').value, 'Nova');
    assert.equal(profile.querySelector('img').getAttribute('src'), 'nova.png');
    assert.ok(avatar.getAttribute('aria-label'));
    avatar.click();
    assert.deepEqual(edits, ['Nova']);

    // 每次打开新标签页现取：换了助手（群组不能编辑、没有头像用默认图）
    current = { name: '群组', avatarUrl: '', onEditAvatar: null };
    doc.getElementById('addSidePaneChatBtn').click();
    await tick();
    assert.equal(profile.querySelector('.side-pane-launcher-name').value, '群组');
    const fallbackSrc = profile.querySelector('img').getAttribute('src');
    assert.ok(fallbackSrc, '没有头像时用默认图');
    assert.notEqual(fallbackSrc, 'nova.png');
    assert.equal(avatar.disabled, true);
    avatar.click();
    assert.deepEqual(edits, ['Nova']);

    current = null;
    ctrl.showLauncher();
    assert.equal(profile.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the new tab page name can be edited in place', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const name = doc.querySelector('.side-pane-launcher-name');
    const renames = [];
    let result = { success: true };
    const current = { name: 'Nova', avatarUrl: '', onRename: (value) => { renames.push(value); return result; } };
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'a', label: 'A', open() {} }, { id: 'b', label: 'B', open() {} }] }
    });
    ctrl.setLauncherProfileProvider(() => current);
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
    ctrl.setLauncherProfileProvider(() => ({ name: '群组', avatarUrl: '' }));
    assert.equal(name.readOnly, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the new tab page switches between tools and apps', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const launcher = doc.getElementById('sidePaneViewLauncher');
    const tabs = launcher.querySelector('.side-pane-launcher-tabs');
    const tools = launcher.querySelector('[data-launcher-section="tools"]');
    const apps = launcher.querySelector('[data-launcher-section="apps"]');
    const opened = [];
    const mounted = [];
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'a', label: 'A', open() {} }, { id: 'b', label: 'B', open() {} }] }
    });

    assert.equal(tabs.hidden, true, '没有应用来源时只有工具页');
    let providerCalls = 0;
    let appList = [
        { id: 'notes', label: '笔记', open: () => opened.push('notes'), mountIcon: (btn, host) => mounted.push([btn.getAttribute('data-launcher-app'), host]) },
        { id: 'dice', label: '骰子', open: () => opened.push('dice') }
    ];
    ctrl.setLauncherAppsProvider(() => {
        providerCalls += 1;
        return appList;
    });
    assert.equal(tabs.hidden, false);
    assert.equal(tools.hidden, false);
    assert.equal(apps.hidden, true);
    assert.equal(providerCalls, 0, '应用页没打开前不画图标');

    doc.getElementById('addSidePaneChatBtn').click();
    tabs.querySelector('[data-launcher-tab="apps"]').click();
    assert.equal(tools.hidden, true);
    assert.equal(apps.hidden, false);
    assert.equal(tabs.querySelector('[data-launcher-tab="apps"]').getAttribute('aria-selected'), 'true');
    const cards = [...apps.querySelectorAll('[data-launcher-app]')];
    assert.deepEqual(cards.map(card => card.textContent), ['笔记', '骰子']);
    assert.deepEqual(mounted.map(([id]) => id), ['notes'], '只有提供了 mountIcon 的应用自己画图标');
    assert.ok(cards[0].contains(mounted[0][1]), '图标画在这张卡片里');

    cards[1].click();
    await tick();
    assert.deepEqual(opened, ['dice']);

    // 再次打开新标签页停在应用页并刷新列表
    appList = [{ id: 'music', label: '音乐', open() {} }];
    ctrl.showLauncher();
    assert.equal(apps.hidden, false);
    assert.deepEqual([...apps.querySelectorAll('[data-launcher-app]')].map(card => card.getAttribute('data-launcher-app')), ['music']);

    // 撤掉应用来源后回到工具页
    ctrl.setLauncherAppsProvider(null);
    assert.equal(tabs.hidden, true);
    assert.equal(tools.hidden, false);
    assert.equal(apps.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

// 现在的页面：通知不再单独一个视图，而是新标签页里的“通知”分类
function hostNotificationsInLauncher(doc) {
    doc.getElementById('sidePaneViewNotifications').remove();
    const launcher = doc.getElementById('sidePaneViewLauncher');
    launcher.querySelector('.side-pane-launcher-tabs').insertAdjacentHTML('beforeend',
        '<button type="button" data-launcher-tab="notifications" aria-selected="false">通知<span class="side-pane-launcher-tab-status" data-status="unknown"></span></button>');
    launcher.insertAdjacentHTML('beforeend', `
        <section data-launcher-section="notifications" hidden>
            <aside id="notificationsSidebar"></aside>
        </section>`);
}

// 通知中心发布的状态（连接 + 各类计数），侧栏只读这个
function createNotificationState() {
    const channel = new globalThis.VCPStateChannels.StateChannel('notification-center', {
        counts: { all: 0, pending: 0, info: 0, error: 0, resolved: 0 },
        connection: { status: 'unknown', text: 'VCPLog: 未连接' }
    });
    return {
        channel,
        setConnection: (status, text) => channel.publish({ ...channel.get(), connection: { status, text } }),
        setCounts: counts => channel.publish({ ...channel.get(), counts: { ...channel.get().counts, ...counts } })
    };
}

test('Parity: notifications live in the new tab page instead of the tab strip', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    hostNotificationsInLauncher(doc);
    const launcher = doc.getElementById('sidePaneViewLauncher');
    const tabs = launcher.querySelector('.side-pane-launcher-tabs');
    const tools = launcher.querySelector('[data-launcher-section="tools"]');
    const notifications = launcher.querySelector('[data-launcher-section="notifications"]');
    const segment = tabs.querySelector('[data-launcher-tab="notifications"]');
    const notificationState = createNotificationState();
    let notificationsShown = 0;
    const ctrl = createController(dom, {
        controller: {
            openTabEntries: [{ id: 'a', label: 'A', open() {} }, { id: 'b', label: 'B', open() {} }],
            notificationsPanel: doc.getElementById('notificationsSidebar'),
            notificationState: notificationState.channel,
            onNotificationsShown: () => { notificationsShown += 1; }
        }
    });
    const stripTabIds = () => [...doc.querySelectorAll('.side-pane-tabs .side-pane-tab')].map(btn => btn.getAttribute('data-tab-id'));

    // 首页就是新标签页的通知分类；标签条上不再有通知标签，没有应用来源时也有切换条
    ctrl.setVisible(true, { animate: false });
    assert.deepEqual(stripTabIds(), []);
    assert.equal(launcher.hidden, false);
    assert.equal(tabs.hidden, false);
    assert.equal(tabs.querySelector('[data-launcher-tab="apps"]').hidden, true);
    assert.equal(segment.getAttribute('aria-selected'), 'true');
    assert.equal(notifications.hidden, false);
    assert.equal(tools.hidden, true);
    // 通知页露出来时收走悬浮通知（宿主接的是 notificationRenderer.dismissFloatingToasts）
    assert.equal(notificationsShown, 1);

    // 连接状态挂在通知分类上
    const segmentLabelBefore = segment.getAttribute('aria-label');
    notificationState.setConnection('open', 'VCPLog: 已连接');
    assert.equal(segment.querySelector('.side-pane-launcher-tab-status').dataset.status, 'open');
    assert.ok(segment.getAttribute('aria-label'));
    assert.notEqual(segment.getAttribute('aria-label'), segmentLabelBefore, '读屏能听到连接状态变化');

    // 切到工具：离开通知页；再点通知回来
    tabs.querySelector('[data-launcher-tab="tools"]').click();
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.LAUNCHER_TAB_ID);
    assert.equal(tools.hidden, false);
    assert.equal(notifications.hidden, true);
    assert.equal(notificationsShown, 1);
    segment.click();
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.equal(notifications.hidden, false);
    assert.equal(notificationsShown, 2);

    // 「+」打开的是工具页；打开的标签在标签条上，概览里也没有通知
    doc.getElementById('addSidePaneChatBtn').click();
    assert.equal(tools.hidden, false);
    assert.equal(notifications.hidden, true);
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s1', 'c1') });
    assert.deepEqual(stripTabIds(), ['s1']);
    assert.equal(launcher.hidden, true);
    // 概览关着时不重建，打开后看它列了什么，再关上
    doc.getElementById('sidePaneTabOverviewBtn').click();
    assert.deepEqual([...doc.querySelectorAll('#sidePaneOpenTabsList .side-pane-overview-item')].map(item => item.getAttribute('data-tab-id')), ['s1']);
    doc.getElementById('sidePaneTabOverviewBtn').click();

    // 小房子回到新标签页上次停的分类：停在工具就回工具，停在通知就回通知
    const homeBtn = doc.getElementById('sidePaneHomeBtn');
    homeBtn.click();
    assert.equal(tools.hidden, false);
    assert.equal(notifications.hidden, true);
    segment.click();
    ctrl.activateTab('s1');
    assert.equal(launcher.hidden, true);
    homeBtn.click();
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.equal(notifications.hidden, false);
    assert.equal(segment.getAttribute('aria-selected'), 'true');
    tabs.querySelector('[data-launcher-tab="tools"]').click();
    ctrl.activateTab('s1');
    homeBtn.click();
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.LAUNCHER_TAB_ID);
    assert.equal(tools.hidden, false);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the tools page shows a VCPLog card that opens the notifications', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    hostNotificationsInLauncher(doc);
    const launcher = doc.getElementById('sidePaneViewLauncher');
    const tools = launcher.querySelector('[data-launcher-section="tools"]');
    tools.insertAdjacentHTML('beforeend', `
        <div class="side-pane-launcher-group" data-launcher-group="notifications" hidden>
            <button type="button" class="side-pane-launcher-notice" data-status="unknown">
                <span class="side-pane-launcher-notice-icon"><span class="vcp-ui-icon">notifications</span><span class="side-pane-launcher-notice-dot"></span></span>
                <span class="side-pane-launcher-notice-body">
                    <span class="side-pane-launcher-notice-title"></span>
                    <span class="side-pane-launcher-notice-meta"></span>
                </span>
            </button>
        </div>`);
    const group = tools.querySelector('[data-launcher-group="notifications"]');
    const card = group.querySelector('.side-pane-launcher-notice');
    const title = card.querySelector('.side-pane-launcher-notice-title');
    const meta = card.querySelector('.side-pane-launcher-notice-meta');
    const icon = card.querySelector('.vcp-ui-icon');
    const notificationState = createNotificationState();
    const ctrl = createController(dom, {
        controller: { notificationsPanel: doc.getElementById('notificationsSidebar'), notificationState: notificationState.channel }
    });

    // 没有工具入口也显示工具页，卡片在里面
    ctrl.setVisible(true, { animate: false });
    launcher.querySelector('[data-launcher-tab="tools"]').click();
    await tick();
    assert.equal(tools.hidden, false);
    assert.equal(group.hidden, false);
    assert.equal(card.dataset.status, 'unknown');
    assert.equal(card.dataset.attention, '');
    assert.ok(title.textContent);
    assert.ok(meta.textContent);
    const offline = { title: title.textContent, icon: icon.textContent };

    // 标题和图标只说连没连上
    notificationState.setConnection('open', 'VCPLog: 已连接');
    assert.equal(card.dataset.status, 'open');
    assert.notEqual(title.textContent, offline.title);
    assert.notEqual(icon.textContent, offline.icon);
    assert.ok(meta.textContent);
    assert.equal(card.dataset.attention, '');

    // 通知中心更新计数后卡片跟着变
    notificationState.setCounts({ pending: 2, error: 1 });
    assert.match(meta.textContent, /2/);
    assert.match(meta.textContent, /1/);
    assert.equal(card.dataset.attention, 'pending');

    // 断开时把原因和计数一起放在第二行
    notificationState.setConnection('closed', 'VCPLog: 连接已断开 (1006)');
    assert.equal(card.dataset.status, 'closed');
    assert.equal(title.textContent, offline.title);
    assert.equal(icon.textContent, offline.icon);
    assert.match(meta.textContent, /1006/);
    assert.match(meta.textContent, /2/);
    assert.equal(card.dataset.attention, 'pending');
    assert.match(card.getAttribute('aria-label'), /1006/, '读屏名称带上断开原因');

    // 只剩错误时提示错误
    notificationState.setCounts({ pending: 0 });
    assert.equal(card.dataset.attention, 'error');

    card.click();
    assert.equal(ctrl.getSnapshot().activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.equal(launcher.querySelector('[data-launcher-section="notifications"]').hidden, false);
    assert.equal(tools.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the tools page lists recommended apps under the tool rows', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const tools = doc.querySelector('#sidePaneViewLauncher [data-launcher-section="tools"]');
    tools.innerHTML = `
        <div data-launcher-group="tools"><div class="side-pane-open-tab-list"></div></div>
        <div data-launcher-group="recommended" hidden>
            <button type="button" class="side-pane-launcher-group-action" hidden></button>
            <div class="side-pane-launcher-recommended-row"></div>
        </div>`;
    const recommended = tools.querySelector('[data-launcher-group="recommended"]');
    const settings = recommended.querySelector('.side-pane-launcher-group-action');
    const opened = [];
    let settingsOpened = 0;
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'a', label: 'A', open() {} }, { id: 'b', label: 'B', open() {} }] }
    });
    ctrl.setLauncherAppsProvider(() => [{ id: 'forum', label: '论坛（全部）', open: () => opened.push('apps:forum') }]);

    assert.equal(recommended.hidden, true, '没有推荐来源时不显示');
    let pinned = ['forum', 'notes'];
    ctrl.setLauncherRecommendedProvider(
        () => pinned.map(id => ({ id, label: id, open: () => opened.push(`rec:${id}`) })),
        { onSettings: () => { settingsOpened += 1; } }
    );
    ctrl.showLauncher();
    assert.equal(recommended.hidden, false);
    assert.equal(settings.hidden, false);
    assert.deepEqual([...recommended.querySelectorAll('[data-launcher-app]')].map(card => card.textContent), ['forum', 'notes']);

    // 推荐里的卡片和应用页同 id 也各开各的
    recommended.querySelector('[data-launcher-app="forum"]').click();
    await tick();
    assert.deepEqual(opened, ['rec:forum']);

    settings.click();
    assert.equal(settingsOpened, 1);

    // 常用应用改了以后刷新
    pinned = ['music'];
    ctrl.refreshLauncherRecommended();
    assert.deepEqual([...recommended.querySelectorAll('[data-launcher-app]')].map(card => card.textContent), ['music']);

    // 撤掉推荐来源后隐藏
    ctrl.setLauncherRecommendedProvider(null);
    assert.equal(recommended.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the side chat entry is not offered while a group is selected', () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    let ctrl = null;
    ctrl = createController(dom, {
        controller: {
            tabTypes: [defineChatTabType({
                provider: mockChatProvider(),
                openSideChat: () => {},
                canOpen: () => ctrl?.getSnapshot().parent?.itemType === 'agent'
            })]
        }
    });
    const listed = () => [...doc.querySelectorAll('[data-open-tab-entry]')].map(row => row.getAttribute('data-open-tab-entry'));
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    assert.deepEqual(listed(), ['selection-side-conversation']);
    // 切到群聊：控制器的 parent 变成 null，入口跟着消失，而不是点了再弹「请先选择助手」
    ctrl.setParent(null);
    assert.deepEqual(listed(), []);
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    assert.deepEqual(listed(), ['selection-side-conversation']);
    ctrl.dispose();
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

    // 外壳的 backdrop-filter 会把 fixed 菜单的定位和背后内容都带偏，所以菜单挂在 body 下
    assert.equal(contextMenu.parentNode, doc.body);

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

    // 点进浏览器标签的 webview 时主页面只会失焦，菜单也要收起
    openMenuOn('s1');
    assert.equal(contextMenu.hidden, false);
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(contextMenu.hidden, true);

    // 标签总览同理
    const overview = doc.getElementById('sidePaneTabOverviewPopover');
    doc.getElementById('sidePaneTabOverviewBtn').click();
    assert.equal(overview.hidden, false);
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(overview.hidden, true);

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
    assert.equal(doc.activeElement, tabList.querySelector('[role="tab"][data-tab-id="s1"]'), 'focus goes back to the tab, not body');

    // Tab 收起菜单，焦点回到标签
    openMenuOn('s1');
    contextMenu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(contextMenu.hidden, true);
    assert.equal(doc.activeElement, tabList.querySelector('[role="tab"][data-tab-id="s1"]'));

    // 关掉后台标签：那个标签没了，焦点落到当前标签
    await ctrl.openTab({ kind: 'chat', descriptor: createDesc('s3', 'c3') });
    await ctrl.activateTab('s1');
    openMenuOn('s3');
    contextMenu.querySelector('[data-action="close-tab"]').click();
    await tick();
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id), ['notifications', 's1']);
    assert.equal(doc.activeElement, tabList.querySelector('[role="tab"][data-tab-id="s1"]'));

    await ctrl.dispose();
    assert.notEqual(contextMenu.parentNode, doc.body, 'dispose puts the menu back');
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

// 点选模型改 getModel 见 side-chat-model-and-context.test.mjs；这里只看弹层收起和 handle.setModel
test('Parity: Side Chat Model Picker closes on selection and window blur, and follows setModel', async () => {
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

    // 选中后收起
    popover.querySelector('[data-model="claude-3-5-sonnet"]').click();
    assert.equal(popover.hidden, true);

    // 点进侧栏浏览器的 webview 时主页面只会失焦，弹层也要收起
    pickerBtn.click();
    await tick();
    assert.equal(popover.hidden, false);
    dom.window.dispatchEvent(new dom.window.Event('blur'));
    assert.equal(popover.hidden, true);

    // Direct setModel via handle
    handle.setModel('gemini-1.5-pro');
    assert.equal(handle.getModel(), 'gemini-1.5-pro');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'gemini-1.5-pro');

    await handle.dispose();
    dom.window.close();
});

test('tab type registration connects presentation, launcher availability and provider mounting', async () => {
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
    unregister();
    assert.equal(ctrl.getTabType('custom-notes'), null);
    assert.equal(doc.querySelector('[data-open-tab-entry="custom-notes"]'), null);
    await ctrl.dispose();
    dom.window.close();
});

// 旧注销不删新声明、无效声明不生效见下面几个测试；这里只看各控制器互不影响
test('tab type registrations stay local to their controller', async () => {
    const firstDOM = createParityTestDOM();
    const secondDOM = createParityTestDOM();
    const first = createController(firstDOM);
    const second = createController(secondDOM);
    first.registerTabType({ kind: 'custom', label: 'New', entry: { open() {} } });
    assert.equal(first.getTabType('custom').label, 'New');
    assert.equal(second.getTabType('custom'), null);
    assert.ok(firstDOM.window.document.querySelector('[data-open-tab-entry="custom"]'));
    assert.equal(secondDOM.window.document.querySelector('[data-open-tab-entry="custom"]'), null);
    await Promise.all([first.dispose(), second.dispose()]);
    firstDOM.window.close();
    secondDOM.window.close();
});

test('replacing a tab type without an entry removes its previous launcher action', async () => {
    const dom = createParityTestDOM();
    const ctrl = createController(dom);
    let opened = 0;
    try {
        const stale = ctrl.registerTabType({ kind: 'custom', label: 'Old', entry: { id: 'old-action', open() { opened++; } } });
        const unregister = ctrl.registerTabType({ kind: 'custom', label: 'Placeholder' });
        const oldAction = dom.window.document.querySelector('[data-open-tab-entry="old-action"]');
        oldAction?.click();
        assert.equal(oldAction, null, 'the removed declaration must not leave a live launcher action');
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

