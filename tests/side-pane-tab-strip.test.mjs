import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import '../modules/ui-system/state-channel.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import {
    buildSearchFields,
    filterAndRankSearchItems,
    formatRelativeTime,
    getTabSearchHint,
    getTabTypeLabel,
    findClosestCenterIndex,
    moveIdBefore,
    normalizeSearchQuery,
    resolveTabsOverflow
} from '../modules/ui-system/side-pane/side-pane-tab-utils.js';

function makeItem(title, hint = '', type = '') {
    return { title, searchFields: buildSearchFields(title, hint, type) };
}

test('search ranking: title prefix beats word prefix beats substring beats hint beats type', () => {
    const items = [
        makeItem('git review', '', ''),
        makeItem('some thing', 'https://example.com/abc', ''),
        makeItem('xxabcxx', '', ''),
        makeItem('foo abcde', '', ''),
        makeItem('abcdef', '', ''),
        makeItem('other', '', 'abc-type')
    ];
    const ranked = filterAndRankSearchItems(items, normalizeSearchQuery('abc')).map(i => i.title);
    assert.deepEqual(ranked, ['abcdef', 'foo abcde', 'xxabcxx', 'some thing', 'other']);
    // 无查询原样返回；多词必须全部命中
    assert.equal(filterAndRankSearchItems(items, []).length, items.length);
    assert.deepEqual(filterAndRankSearchItems(items, normalizeSearchQuery('abc example')).map(i => i.title), ['some thing']);
});

test('tab presentation helpers: type labels and search hints', () => {
    // 打开标签的模块给的 typeLabel 原样使用；框架类型和未知类型都有非空的默认名
    assert.equal(getTabTypeLabel({ kind: 'terminal', typeLabel: 'My Shell' }), 'My Shell');
    assert.equal(getTabTypeLabel({ kind: 'x', typeLabel: '' }, () => ({ label: 'From registry' })), 'From registry');
    for (const kind of ['notifications', 'chat', 'unknown']) assert.ok(getTabTypeLabel({ kind }), kind);
    assert.notEqual(getTabTypeLabel({ kind: 'notifications' }), getTabTypeLabel({ kind: 'chat' }));
    assert.equal(getTabSearchHint({ kind: 'browser', searchHint: 'https://a.test/x' }), 'https://a.test/x');
    assert.equal(getTabSearchHint({ kind: 'browser', url: 'https://a.test/x' }), '');
    // 半分钟内与五分钟前给出不同的相对时间，五分钟的数字要出现
    const justNow = formatRelativeTime(1000, 1000 + 30_000);
    const fiveMin = formatRelativeTime(0, 5 * 60_000);
    assert.ok(justNow);
    assert.notEqual(justNow, fiveMin);
    assert.match(fiveMin, /5/);
    assert.equal(formatRelativeTime(0, 10_000), justNow, 'everything under a minute reads the same');
});

test('resolveTabsOverflow uses the min-width budget and ignores where the add button lives', () => {
    // 3 个标签 96 + 32*2 + 4*2 = 168，加 gap 4 与按钮 28 = 200
    assert.equal(resolveTabsOverflow({ addButtonInside: true, addButtonWidth: 28, tabCount: 3, viewportWidth: 200 }), false);
    assert.equal(resolveTabsOverflow({ addButtonInside: true, addButtonWidth: 28, tabCount: 3, viewportWidth: 198 }), true);
    // 按钮在外面时视口更窄，判定结果保持一致
    assert.equal(resolveTabsOverflow({ addButtonInside: false, addButtonWidth: 28, tabCount: 3, viewportWidth: 172 }), false);
    assert.equal(resolveTabsOverflow({ addButtonInside: false, addButtonWidth: 28, tabCount: 3, viewportWidth: 170 }), true);
});

test('drag helpers: closest center and arrayMove semantics', () => {
    const rects = [{ left: 0, width: 100 }, { left: 104, width: 100 }, { left: 208, width: 100 }];
    assert.equal(findClosestCenterIndex(rects, 40), 0);
    assert.equal(findClosestCenterIndex(rects, 160), 1);
    assert.equal(findClosestCenterIndex(rects, 400), 2);
    assert.deepEqual(moveIdBefore(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
    assert.deepEqual(moveIdBefore(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
    assert.deepEqual(moveIdBefore(['a', 'b'], 'a', 'zzz'), ['a', 'b']);
});

test('SidePaneState.reorderTabs moves tabs but keeps notifications first', () => {
    let state = SidePaneState.createInitialSidePaneState({});
    state = SidePaneState.openTab(state, { id: 'a', kind: 'notes', title: 'A' });
    state = SidePaneState.openTab(state, { id: 'b', kind: 'git', title: 'B' });
    state = SidePaneState.openTab(state, { id: 'c', kind: 'terminal', title: 'C' });
    assert.deepEqual(state.tabs.map(t => t.id), ['notifications', 'a', 'b', 'c']);
    state = SidePaneState.reorderTabs(state, 'c', 'a');
    assert.deepEqual(state.tabs.map(t => t.id), ['notifications', 'c', 'a', 'b']);
    // 拖到通知标签上：通知仍在最前
    state = SidePaneState.reorderTabs(state, 'b', 'notifications');
    assert.deepEqual(state.tabs.map(t => t.id), ['notifications', 'b', 'c', 'a']);
    // 通知标签不可拖，未知 id 原样返回
    assert.equal(SidePaneState.reorderTabs(state, 'notifications', 'a'), state);
    assert.equal(SidePaneState.reorderTabs(state, 'nope', 'a'), state);
});

function setup(providers = {}) {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <button id="sidePaneTabOverviewBtn"></button>
                <div class="side-pane-tabs"></div>
                <div class="side-pane-tab-actions"><button id="addSidePaneChatBtn"></button></div>
                <div id="sidePaneTabOverviewPopover" hidden>
                    <input class="side-pane-overview-input"><div id="sidePaneOpenTabsList"></div>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications"></section>
            </div>
        </aside>
    `, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const controller = createSidePaneController({
        root,
        resizerHandle: doc.getElementById('resizerRight'),
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        providers
    });
    return { dom, doc, root, controller, tabs: root.querySelector('.side-pane-tabs') };
}

const notesProvider = {
    async mountTab(tab, view) {
        view.textContent = tab.title;
        return { async dispose() {}, async requestClose() { return { closed: true }; } };
    }
};

test('controller: reorderTab re-renders tabs in the new order', async () => {
    const { controller, tabs } = setup({ notes: notesProvider });
    await controller.openTab({ id: 'n1', kind: 'notes', title: 'N1', scopeMode: 'global' });
    await controller.openTab({ id: 'n2', kind: 'notes', title: 'N2', scopeMode: 'global' });
    controller.reorderTab('n2', 'n1');
    const order = [...tabs.querySelectorAll('.side-pane-tab-item')].map(el => el.getAttribute('data-tab-id'));
    assert.deepEqual(order, ['notifications', 'n2', 'n1']);
    controller.dispose();
});

test('controller: middle click closes a tab without activating it', async () => {
    const { controller, tabs, dom } = setup({ notes: notesProvider });
    await controller.openTab({ id: 'n1', kind: 'notes', title: 'N1', scopeMode: 'global' });
    await controller.openTab({ id: 'n2', kind: 'notes', title: 'N2', scopeMode: 'global' });
    assert.equal(controller.getSnapshot().activeTabId, 'n2');
    const n1 = tabs.querySelector('[data-tab-id="n1"].side-pane-tab-item');
    n1.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(controller.getSnapshot().tabs.map(t => t.id), ['notifications', 'n2']);
    assert.equal(controller.getSnapshot().activeTabId, 'n2');
    controller.dispose();
});

test('controller: closed non-chat tabs are remembered and can really be reopened', async () => {
    const { controller, doc } = setup({ notes: notesProvider });
    await controller.openTab({ id: 'n1', kind: 'notes', title: 'N1', scopeMode: 'global', searchHint: 'file:///x' });
    await controller.closeTab('n1');

    const closed = controller.getRecentlyClosedTabs();
    assert.equal(closed.length, 1);
    assert.equal(closed[0].id, 'n1');
    assert.equal(closed[0].tab.kind, 'notes');

    // 概览里能按搜索提示搜到，并列在"最近关闭"下
    const input = doc.querySelector('.side-pane-overview-input');
    input.value = 'file';
    input.dispatchEvent(new doc.defaultView.Event('input'));
    assert.equal(doc.querySelectorAll('.side-pane-overview-item.recently-closed').length, 1);

    await controller.reopenClosedTab('n1');
    assert.deepEqual(controller.getSnapshot().tabs.map(t => t.id), ['notifications', 'n1']);
    assert.equal(controller.getSnapshot().activeTabId, 'n1');
    assert.equal(controller.getRecentlyClosedTabs().length, 0);
    controller.dispose();
});

test('controller: tabs marked reopenable:false are not remembered; list is capped at 10', async () => {
    const { controller } = setup({ notes: notesProvider });
    await controller.openTab({ id: 'once', kind: 'notes', title: 'Once', scopeMode: 'global', reopenable: false });
    await controller.closeTab('once');
    assert.equal(controller.getRecentlyClosedTabs().length, 0);
    for (let i = 0; i < 12; i++) {
        await controller.openTab({ id: `t${i}`, kind: 'notes', title: `T${i}`, scopeMode: 'global' });
        await controller.closeTab(`t${i}`);
    }
    const closed = controller.getRecentlyClosedTabs();
    assert.equal(closed.length, 10);
    assert.equal(closed[0].id, 't11');
    controller.dispose();
});

test('controller: the tab overview is keyboard driven (arrows, Enter, Escape)', async () => {
    const { controller, doc, dom } = setup({ notes: notesProvider });
    await controller.openTab({ id: 'n1', kind: 'notes', title: 'N1', scopeMode: 'global' });
    await controller.openTab({ id: 'n2', kind: 'notes', title: 'N2', scopeMode: 'global' });
    const button = doc.getElementById('sidePaneTabOverviewBtn');
    const popover = doc.getElementById('sidePaneTabOverviewPopover');
    const input = doc.querySelector('.side-pane-overview-input');
    const press = (key) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const active = () => [...doc.querySelectorAll('.side-pane-overview-item.kbd-active')].map(el => el.getAttribute('data-tab-id'));

    button.click();
    assert.equal(popover.hidden, false);
    press('ArrowDown');
    assert.deepEqual(active(), ['notifications']);
    press('ArrowDown');
    assert.equal(active().length, 1);
    press('ArrowUp');
    assert.deepEqual(active(), ['notifications']);
    press('ArrowUp'); // 循环到最后一项
    assert.deepEqual(active(), ['n2']);

    press('ArrowUp');
    press('Enter');
    assert.equal(controller.getSnapshot().activeTabId, 'n1');
    assert.equal(popover.hidden, true);

    button.click();
    press('Escape');
    assert.equal(popover.hidden, true);

    // 屏幕阅读器要能读到方向键选中的是哪一项：combobox + listbox + aria-activedescendant
    button.click();
    const list = doc.getElementById('sidePaneOpenTabsList');
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), list.id);
    assert.equal(list.getAttribute('role'), 'listbox');
    press('ArrowDown');
    const selected = doc.querySelector('.side-pane-overview-item.kbd-active');
    assert.equal(selected.getAttribute('role'), 'option');
    assert.equal(selected.getAttribute('aria-selected'), 'true');
    assert.equal(input.getAttribute('aria-activedescendant'), selected.id);
    assert.equal(doc.getElementById(selected.id), selected);

    // 关闭按钮跟着整行重建掉了，焦点回到搜索框
    const closeBtn = doc.querySelector('.side-pane-overview-item[data-tab-id="n2"] .side-pane-tab-close');
    closeBtn.focus();
    closeBtn.click();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(doc.querySelector('.side-pane-overview-item[data-tab-id="n2"]'), null);
    assert.equal(doc.activeElement, input);
    assert.equal(input.hasAttribute('aria-activedescendant'), false, 'no stale id after a redraw');
    controller.dispose();
});

test('controller: the 通知 tab mirrors the VCPLog connection status', async () => {
    const dom = new JSDOM(`
        <aside id="vcpSidePane">
            <div class="side-pane-tabs"></div>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications"></section>
            </div>
        </aside>
    `, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    // 通知中心发布的状态：连接状态从这里读，不再看通知面板的 DOM
    const notificationState = new globalThis.VCPStateChannels.StateChannel('notification-center', {
        counts: { all: 0, pending: 0, info: 0, error: 0, resolved: 0 },
        connection: { status: 'connecting', text: 'VCPLog: 连接中...' }
    });
    const controller = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        providers: {},
        notificationState
    });
    controller.show?.();
    const tab = () => root.querySelector('.side-pane-tab[data-tab-id="notifications"]');
    const title = () => tab().querySelector('.tab-title').textContent;
    assert.equal(tab().querySelector('.side-pane-tab-status').dataset.status, 'connecting');
    // 读屏名带上通知中心发布的状态文字；标签上能看到的标题也跟着状态走
    assert.ok(tab().getAttribute('aria-label').includes('VCPLog: 连接中...'));
    const connectingTitle = title();
    assert.ok(connectingTitle);

    notificationState.publish({ ...notificationState.get(), connection: { status: 'open', text: 'VCPLog: 已连接' } });
    assert.equal(tab().querySelector('.side-pane-tab-status').dataset.status, 'open');
    assert.ok(tab().getAttribute('aria-label').includes('VCPLog: 已连接'));
    assert.ok(title());
    assert.notEqual(title(), connectingTitle);

    // 没有状态文字时不留过期的读屏名
    notificationState.publish({ ...notificationState.get(), connection: { status: 'closed', text: '' } });
    assert.equal(tab().querySelector('.side-pane-tab-status').dataset.status, 'closed');
    assert.equal(tab().hasAttribute('aria-label'), false);
    controller.dispose();
    dom.window.close();
});

test('tab strip: a collapsed pane (only padding left) keeps the add button home instead of moving it back and forth', async () => {
    const { createSidePaneTabStrip } = await import('../modules/ui-system/side-pane/side-pane-tab-strip.js');
    const dom = new JSDOM('<div id="tabs"></div><div id="actions"><button id="add"></button></div>');
    const doc = dom.window.document;
    const tabList = doc.getElementById('tabs');
    const addButton = doc.getElementById('add');
    const home = doc.getElementById('actions');
    // 收起的面板宽度为 0，标签条只剩左右内边距那几像素
    Object.defineProperty(tabList, 'clientWidth', { configurable: true, get: () => 4 });
    addButton.getBoundingClientRect = () => ({ width: 28 });
    let moves = 0;
    new dom.window.MutationObserver(records => { moves += records.length; }).observe(home, { childList: true });
    const strip = createSidePaneTabStrip({
        tabListElement: tabList,
        addButton,
        getTabs: () => [],
        getActiveTabId: () => null,
        isClosable: () => true,
        onActivate() {}, onClose() {}, onReorder() {}, onContextMenu() {}
    });
    try {
        for (let i = 0; i < 6; i++) strip.layout();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(addButton.parentElement, home);
        assert.equal(moves, 0);
    } finally {
        strip.dispose();
        dom.window.close();
    }
});

test('controller: the overview only offers recently closed tabs that would show in the current conversation', async () => {
    const { controller, doc } = setup({ notes: notesProvider });
    const topicA = { itemType: 'agent', itemId: 'agent', topicId: 'a' };
    const topicB = { itemType: 'agent', itemId: 'agent', topicId: 'b' };
    controller.setParent(topicA);
    await controller.openTab({ id: 'plan-a', kind: 'notes', title: 'Plan A', scopeMode: 'topic', parent: topicA });
    await controller.openTab({ id: 'tool', kind: 'notes', title: 'Tool', scopeMode: 'global' });
    await controller.closeTab('plan-a');
    await controller.closeTab('tool');
    controller.setParent(topicB);

    const input = doc.querySelector('.side-pane-overview-input');
    input.value = '';
    input.dispatchEvent(new doc.defaultView.Event('input'));
    const titles = [...doc.querySelectorAll('.side-pane-overview-item.recently-closed')].map(item => item.textContent);
    assert.equal(titles.length, 1, titles.join(' | '));
    assert.match(titles[0], /Tool/);

    controller.setParent(topicA);
    input.dispatchEvent(new doc.defaultView.Event('input'));
    assert.equal(doc.querySelectorAll('.side-pane-overview-item.recently-closed').length, 2, 'back in topic A both come back');
    controller.dispose();
});

test('controller: a closed tab overview is not rebuilt on every tab change, and shows fresh titles when opened', async () => {
    const { controller, doc } = setup({ notes: notesProvider });
    await controller.openTab({ id: 'n1', kind: 'notes', title: 'N1', scopeMode: 'global' });
    const list = doc.getElementById('sidePaneOpenTabsList');
    const before = [...list.children];
    controller.updateTab('n1', { title: 'Renamed' });
    assert.ok(before.length > 0 && [...list.children].every((el, i) => el === before[i]), 'the hidden overview list was left alone');
    doc.getElementById('sidePaneTabOverviewBtn').click();
    assert.ok(list.textContent.includes('Renamed'), 'opening the overview renders the current titles');
    await controller.dispose();
});
