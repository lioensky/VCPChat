import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';

// 删掉话题后，它的辅助对话标签要被释放，而不是一直挂着（keep 永不休眠）
const parentOf = topicId => ({ itemType: 'agent', itemId: 'agent', topicId });
const sideChat = (id, topicId) => ({ kind: 'chat', descriptor: {
    id, title: id, parent: parentOf(topicId), child: { itemType: 'agent', itemId: 'agent', topicId: `child-${id}` }
} });

test('deleting a topic disposes its side chat tabs without asking or deleting the child again', async t => {
    const dom = new JSDOM('<main class="main-content"></main><aside id="pane"><div id="tabs"></div><div id="content"><section class="side-pane-view" id="sidePaneViewNotifications"></section></div></aside>');
    const doc = dom.window.document;
    const disposed = [];
    const asked = [];
    const closed = [];
    const ctrl = createSidePaneController({
        root: doc.getElementById('pane'),
        tabListElement: doc.getElementById('tabs'),
        contentContainer: doc.getElementById('content'),
        tabTypes: [defineChatTabType({
            provider: { mountTab: async descriptor => ({
                dispose: async () => { disposed.push(descriptor.id); },
                requestClose: async () => { asked.push(descriptor.id); return { closed: false }; },
                focus() {}
            }) },
            onClosed: descriptor => { closed.push(descriptor.id); }
        })]
    });
    t.after(() => { ctrl.dispose?.(); dom.window.close(); });

    ctrl.setParent(parentOf('gone'));
    await ctrl.openTab(sideChat('orphan', 'gone'));
    ctrl.setParent(parentOf('kept'));
    await ctrl.openTab(sideChat('survivor', 'kept'));

    await ctrl.discardTabsOfDeletedTopics({ itemId: 'agent', topicIds: ['gone'] });

    assert.deepEqual(ctrl.getSnapshot().tabs.map(tab => tab.id).filter(id => id !== 'notifications'), ['survivor']);
    assert.deepEqual(disposed, ['orphan']);
    assert.deepEqual(asked, [], 'no confirmation for a conversation that no longer exists');
    assert.deepEqual(closed, [], 'the child directory was already removed with its parent');
    assert.ok(doc.querySelector('[data-tab-id="survivor"]'));
});
