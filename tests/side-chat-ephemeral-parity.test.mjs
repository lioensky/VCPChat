import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
import { createSideChatDescriptor } from '../modules/chat/sideChatSessionService.js';

function createTestDOM() {
    return new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <button id="sidePaneTabOverviewBtn" class="side-pane-action-btn" type="button"></button>
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                    <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button"></button>
                </div>
                <div id="sidePaneTabOverviewPopover" class="side-pane-tab-overview-popover" hidden>
                    <div id="sidePaneOpenTabsList"></div>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
                <section class="side-pane-view" id="sidePaneViewLauncher" data-tab-id="launcher" hidden></section>
            </div>
        </aside>
    `);
}

test('Parity: closing a side chat only releases runtime and stays reopenable from recentlyClosedTabs', async () => {
    const dom = createTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');

    let disposedRuntime = false;
    let mounts = 0;
    const mockChatProvider = {
        async mountTab(desc, view) {
            mounts += 1;
            return {
                descriptor: desc,
                focus() {},
                async requestClose() { return { closed: true }; },
                async dispose() { disposedRuntime = true; }
            };
        }
    };

    const closedDescriptors = [];
    const openedDescriptors = [];
    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        tabTypes: [defineChatTabType({
            provider: mockChatProvider,
            onOpened: async (desc) => {
                openedDescriptors.push(desc);
            },
            onClosed: async (desc) => {
                closedDescriptors.push(desc);
            }
        })]
    });

    const desc = createSideChatDescriptor({
        parent: { itemId: 'agent-alpha', topicId: 'main-topic' },
        childTopicId: 'child-topic-1',
        title: 'Side Chat'
    });

    ctrl.setParent(desc.parent);
    await ctrl.openTab({ kind: 'chat', descriptor: desc });
    assert.equal(ctrl.getSnapshot().tabs.length, 2); // notifications + side chat
    assert.equal(ctrl.getSnapshot().activeTabId, desc.id);
    assert.equal(openedDescriptors.length, 1, 'opening a new side chat tab must notify the type');

    // Close the side chat tab: view goes away, records are untouched
    await ctrl.closeTab(desc.id);

    // 1. Runtime must be completely disposed
    assert.equal(disposedRuntime, true, 'Runtime handle must be disposed on close');

    // 2. View element must be removed from DOM
    const views = content.querySelectorAll(`.side-pane-view[data-tab-id="${desc.id}"]`);
    assert.equal(views.length, 0, 'View element must be removed from DOM');

    // 3. the chat tab type's onClosed must be notified so the record can be marked closed
    assert.equal(closedDescriptors.length, 1);
    assert.equal(closedDescriptors[0].id, desc.id);

    // 4. Closing is not deletion: the tab stays available under "recently closed"
    assert.equal(ctrl.getRecentlyClosedTabs().some(entry => entry.id === desc.id), true,
        'a closed side chat must remain reopenable');

    // 5. Reopening from another entry (e.g. the branch rail) clears the stale recently-closed entry
    await ctrl.openTab({ kind: 'chat', descriptor: desc });
    assert.equal(ctrl.getRecentlyClosedTabs().some(entry => entry.id === desc.id), false);
    await ctrl.closeTab(desc.id);

    const reopened = await ctrl.reopenClosedTab(desc.id);
    assert.ok(reopened, 'reopenClosedTab returns the mounted handle');
    assert.equal(ctrl.getSnapshot().tabs.some(tab => tab.id === desc.id), true);
    assert.equal(mounts, 3, 'reopening mounts the side chat again');
    assert.equal(openedDescriptors.length, 3, 'reopening notifies the type that the record is open again');

    await ctrl.dispose();
    dom.window.close();
});
