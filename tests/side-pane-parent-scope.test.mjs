import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';

const parentOf = topicId => ({ itemType: 'agent', itemId: 'agent', topicId });
const descriptor = (id, topicId) => ({
    id,
    title: id,
    parent: parentOf(topicId),
    child: { itemType: 'agent', itemId: 'agent', topicId: `child-${id}` }
});

function createController() {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    const closed = [];
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({
            provider: { mountTab: async () => ({ dispose: async () => {}, focus() {} }) },
            onClosed: desc => closed.push(desc.id)
        })]
    });
    return { doc, ctrl, closed };
}

test('without a current conversation, topic tabs of other conversations stay off the strip', async () => {
    const { doc, ctrl } = createController();
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab({ kind: 'chat', descriptor: descriptor('side-a', 'a') });
    ctrl.setParent(parentOf('b'));
    await ctrl.openTab({ kind: 'chat', descriptor: descriptor('side-b', 'b') });

    ctrl.setParent(null);

    const stripIds = [...doc.querySelectorAll('#tabs [data-tab-id]')].map(el => el.dataset.tabId);
    assert.ok(!stripIds.includes('side-a'));
    assert.ok(!stripIds.includes('side-b'));
    ctrl.dispose?.();
});

test('close all without a current conversation does not delete other conversations\' side chats', async () => {
    const { ctrl, closed } = createController();
    ctrl.setParent(parentOf('a'));
    await ctrl.openTab({ kind: 'chat', descriptor: descriptor('side-a', 'a') });
    ctrl.setParent(parentOf('b'));
    await ctrl.openTab({ kind: 'chat', descriptor: descriptor('side-b', 'b') });

    ctrl.setParent(null);
    await ctrl.closeAllTabs();

    assert.deepEqual(closed, []);
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id).sort(), ['notifications', 'side-a', 'side-b']);
    ctrl.dispose?.();
});
