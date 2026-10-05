import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
import { createSideChatDescriptor } from '../modules/chat/sideChatSessionService.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

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
                <section class="side-pane-view active" id="sidePaneViewHome" data-tab-id="notifications"></section>
            </div>
        </aside>
    `);
}

test('ZCode Parity: createSideChatDescriptor defines ephemeral: true and type: selection-side-chat', () => {
    const desc = createSideChatDescriptor({
        parent: { itemId: 'agent-alpha', topicId: 'main-topic' },
        childTopicId: 'child-topic-1',
        title: '短暂型选区侧聊'
    });

    assert.equal(desc.type, 'selection-side-chat');
    assert.equal(desc.ephemeral, true);
    assert.equal(desc.child.topicId, 'child-topic-1');
});

test('ZCode Parity: Closing selection-side-chat destroys runtime and is explicitly excluded from recentlyClosedTabs', async () => {
    const dom = createTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');

    let disposedRuntime = false;
    const mockChatProvider = {
        async mountTab(desc, view) {
            return {
                descriptor: desc,
                focus() {},
                async requestClose() { return { closed: true }; },
                async dispose() { disposedRuntime = true; }
            };
        }
    };

    const closedDescriptors = [];
    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        tabTypes: [defineChatTabType({
            provider: mockChatProvider,
            onClosed: async (desc) => {
                closedDescriptors.push(desc);
            }
        })]
    });

    const desc = createSideChatDescriptor({
        parent: { itemId: 'agent-alpha', topicId: 'main-topic' },
        childTopicId: 'child-topic-1',
        title: 'Ephemeral Side Chat'
    });

    await ctrl.openTab({ kind: 'chat', descriptor: desc });
    assert.equal(ctrl.getSnapshot().tabs.length, 2); // notifications + side chat
    assert.equal(ctrl.getSnapshot().activeTabId, desc.id);

    // Close the ephemeral side chat tab
    await ctrl.closeTab(desc.id);

    // 1. Runtime must be completely disposed
    assert.equal(disposedRuntime, true, 'Runtime handle must be disposed on close');

    // 2. View element must be removed from DOM
    const views = content.querySelectorAll(`.side-pane-view[data-tab-id="${desc.id}"]`);
    assert.equal(views.length, 0, 'View element must be removed from DOM');

    // 3. the chat tab type's onClosed must be notified with the descriptor for logical tab cleanup
    assert.equal(closedDescriptors.length, 1);
    assert.equal(closedDescriptors[0].id, desc.id);

    // 4. Tab must NOT appear in Tab Overview as a recently closed tab (ZCode useAppPanels.ts:1334)
    const overviewBtn = doc.getElementById('sidePaneTabOverviewBtn');
    overviewBtn.click();
    await tick();

    const recentlyClosedItems = doc.querySelectorAll('.side-pane-overview-item.recently-closed');
    assert.equal(recentlyClosedItems.length, 0, 'selection-side-chat must be explicitly excluded from recentlyClosedTabs');

    await ctrl.dispose();
    dom.window.close();
});
