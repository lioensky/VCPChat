import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';

// 什么时候挂载：后台补回的标签不抢激活也不挂；打开时面板先展开；批量关闭不挂马上要关的标签
const parentOf = topicId => ({ itemType: 'agent', itemId: 'agent', topicId });
const sideChat = (id, topicId) => ({ kind: 'chat', descriptor: {
    id, title: id, parent: parentOf(topicId), child: { itemType: 'agent', itemId: 'agent', topicId: `child-${id}` }
} });

function createController() {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    const mounted = [];
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({
            provider: { mountTab: async descriptor => { mounted.push(descriptor.id); return { dispose: async () => {}, focus() {} }; } }
        })]
    });
    return { ctrl, mounted, dispose: () => { ctrl.dispose?.(); dom.window.close(); } };
}

test('a topic the user collapsed stays collapsed when its side chats come back, and nothing mounts', async t => {
    const { ctrl, mounted, dispose } = createController();
    t.after(dispose);
    ctrl.setParent(parentOf('a'));
    ctrl.setVisible(true);
    ctrl.setVisible(false);
    ctrl.setParent(parentOf('b'));
    ctrl.setParent(parentOf('a'));

    const added = await ctrl.restoreTabs([sideChat('side-a', 'a')]);

    assert.deepEqual(added, ['side-a']);
    const snapshot = ctrl.getSnapshot();
    assert.equal(snapshot.visible, false);
    assert.ok(snapshot.tabs.some(tab => tab.id === 'side-a'));
    assert.deepEqual(mounted, []);

    ctrl.setParent(parentOf('b'));
    ctrl.setParent(parentOf('a'));
    assert.equal(ctrl.getSnapshot().visible, false, 'the collapsed preference was not rewritten');
});

test('a topic whose side chats arrive after the switch opens on the one it was last showing', async t => {
    const { ctrl, mounted, dispose } = createController();
    t.after(dispose);
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab(sideChat('first', 'a'));
    await ctrl.openTab(sideChat('second', 'a'));
    ctrl.activateTab('first');
    ctrl.setParent(parentOf('b'));
    // 模拟重启后：话题 a 的辅助对话还没读回来
    await ctrl.closeTab('first', { force: true });
    await ctrl.closeTab('second', { force: true });
    mounted.length = 0;
    ctrl.setParent(parentOf('a'));
    assert.equal(ctrl.getSnapshot().visible, false);

    await ctrl.restoreTabs([sideChat('first', 'a'), sideChat('second', 'a')]);

    const snapshot = ctrl.getSnapshot();
    assert.equal(snapshot.visible, true);
    assert.equal(snapshot.activeTabId, 'first');
    assert.deepEqual(mounted, ['first']);
});

test('side chats restored while the user is on another tab of the topic stay in the background', async t => {
    const { ctrl, mounted, dispose } = createController();
    t.after(dispose);
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab(sideChat('current', 'a'));
    mounted.length = 0;

    await ctrl.restoreTabs([sideChat('older', 'a')]);

    const snapshot = ctrl.getSnapshot();
    assert.equal(snapshot.activeTabId, 'current');
    assert.equal(snapshot.visible, true);
    assert.ok(snapshot.tabs.some(tab => tab.id === 'older'));
    assert.deepEqual(mounted, []);
});

test('opening a tab expands the pane and shows its view while the provider is still mounting', async t => {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    let finishMount;
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({
            provider: { mountTab: () => new Promise(resolve => { finishMount = () => resolve({ dispose: async () => {}, focus() {} }); }) }
        })]
    });
    t.after(() => { ctrl.dispose?.(); dom.window.close(); });
    ctrl.setParent(parentOf('a'));
    assert.equal(ctrl.getSnapshot().visible, false);

    const opening = ctrl.openTab(sideChat('slow', 'a'));
    const view = doc.querySelector('#content [data-tab-id="slow"]');
    assert.ok(view);
    assert.equal(view.hidden, false);
    assert.equal(doc.getElementById('sidePaneViewNotifications').hidden, true);
    assert.equal(doc.getElementById('pane').getAttribute('aria-hidden'), 'false');

    finishMount();
    await opening;
    assert.equal(view.hidden, false);
});

test('close all does not mount the not-yet-shown tabs it is about to close', async t => {
    const { ctrl, mounted, dispose } = createController();
    t.after(dispose);
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab(sideChat('current', 'a'));
    await ctrl.restoreTabs([sideChat('one', 'a'), sideChat('two', 'a'), sideChat('three', 'a')]);
    mounted.length = 0;

    await ctrl.closeAllTabs();

    assert.deepEqual(mounted, []);
    assert.deepEqual(ctrl.getSnapshot().tabs.map(tab => tab.id), ['notifications']);
});

test('close others mounts only the tab that stays', async t => {
    const { ctrl, mounted, dispose } = createController();
    t.after(dispose);
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab(sideChat('current', 'a'));
    await ctrl.restoreTabs([sideChat('one', 'a'), sideChat('two', 'a'), sideChat('keep', 'a')]);
    mounted.length = 0;

    await ctrl.closeOtherTabs('keep');
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(mounted, ['keep']);
    assert.equal(ctrl.getSnapshot().activeTabId, 'keep');
});

test('closing a restored side chat that was never shown still asks first, and a cancel keeps it', async t => {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    const asked = [];
    const deleted = [];
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({
            provider: { mountTab: async () => ({ dispose: async () => {}, focus() {}, requestClose: async () => ({ closed: true }) }) },
            requestClose: async descriptor => { asked.push(descriptor.id); return { closed: descriptor.id !== 'keep-me' }; },
            onClosed: descriptor => { deleted.push(descriptor.id); }
        })]
    });
    t.after(() => { ctrl.dispose?.(); dom.window.close(); });
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab(sideChat('shown', 'a'));
    await ctrl.restoreTabs([sideChat('keep-me', 'a'), sideChat('drop-me', 'a')]);

    await ctrl.closeAllTabs();

    assert.deepEqual(asked.sort(), ['drop-me', 'keep-me'], 'unmounted side chats are asked through the type');
    assert.deepEqual(deleted.sort(), ['drop-me', 'shown']);
    assert.ok(ctrl.getSnapshot().tabs.some(tab => tab.id === 'keep-me'), 'cancelling keeps the tab and its history');
});

test('a side chat whose mount lands while its close is being confirmed still closes once confirmed', async t => {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    const confirm = Promise.withResolvers();
    const mount = Promise.withResolvers();
    const deleted = [];
    let disposed = 0;
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({
            provider: { mountTab: async () => { await mount.promise; return { dispose: async () => { disposed += 1; }, focus() {} }; } },
            requestClose: () => confirm.promise,
            onClosed: descriptor => { deleted.push(descriptor.id); }
        })]
    });
    t.after(() => { ctrl.dispose?.(); dom.window.close(); });
    ctrl.setParent(parentOf('a'));
    // 补回后面板按这个话题的样子展开并挂载它；挂载还在路上时用户就点了关闭
    const restoring = ctrl.restoreTabs([sideChat('later', 'a')]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(ctrl.getTabHandle('later'), null);
    const closing = ctrl.closeTab('later'); // 挂载还在路上：没有 handle，由类型确认
    mount.resolve();
    await restoring;
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(ctrl.getTabHandle('later'), 'the mount landed before the close was confirmed');
    confirm.resolve({ closed: true });
    await closing;
    assert.equal(ctrl.getSnapshot().tabs.some(tab => tab.id === 'later'), false);
    assert.deepEqual(deleted, ['later']);
    assert.equal(disposed, 1, 'the view that mounted meanwhile is released');
});

test('after a restart the pane goes back to the side chat the topic was left on, even when a saved plan tab came back first', async t => {
    const store = new Map();
    const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
    const windows = [];
    t.after(() => windows.forEach(win => win.close()));
    const make = () => {
        const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
        windows.push(dom.window);
        const doc = dom.window.document;
        const provider = { mountTab: async () => ({ dispose: async () => {}, focus() {} }) };
        return createSidePaneController({
            root: doc.getElementById('pane'), tabListElement: doc.getElementById('tabs'), contentContainer: doc.getElementById('content'),
            persistence: { storage },
            tabTypes: [defineChatTabType({ provider }), { kind: 'plan-detail', label: 'plan', icon: 'x', provider }]
        });
    };
    const first = make();
    first.restoreLayout();
    first.setParent(parentOf('a'));
    await first.openTab({ id: 'plan:a', kind: 'plan-detail', title: 'plan', scopeMode: 'topic', parent: parentOf('a'), payload: {} });
    await first.openTab(sideChat('side-a', 'a'));
    await first.dispose();

    // 启动顺序同 sidePaneWiring：setParent → restoreLayout（只带回计划标签）→ 辅助对话读回来后 restoreTabs
    const second = make();
    second.setParent(parentOf('a'));
    second.restoreLayout();
    assert.equal(second.getSnapshot().activeTabId, 'plan:a');
    await second.restoreTabs([sideChat('side-a', 'a')]);
    assert.equal(second.getSnapshot().activeTabId, 'side-a');
    assert.equal(second.getSnapshot().visible, true, 'the pane was open on this topic when the app closed');
    await second.dispose();

    // 补回之前用户自己切到了别的标签：补回的辅助对话留在后台，不把面板拽回去
    const third = make();
    t.after(() => third.dispose());
    third.setParent(parentOf('a'));
    third.restoreLayout();
    third.showNotifications();
    await third.restoreTabs([sideChat('side-a', 'a')]);
    assert.equal(third.getSnapshot().activeTabId, 'notifications');
    assert.ok(third.getSnapshot().tabs.some(tab => tab.id === 'side-a'));
});
