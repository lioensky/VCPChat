import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

function createTopicBindingTestDOM() {
    return new JSDOM(`
        <div class="main-content">
            <div class="chat-messages" id="chatMessages"></div>
        </div>
        <button id="toggleSidePaneChatBtn" class="header-button" type="button" aria-label="侧边聊天"></button>
        <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button" aria-label="关闭侧栏"></button>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
            </div>
        </aside>
    `);
}

const createDesc = (id, parentTopic, childTopic) => ({
    id,
    title: `侧聊-${id}`,
    parent: { itemType: 'agent', itemId: 'agent-1', topicId: parentTopic },
    child: { itemType: 'agent', itemId: 'agent-1', topicId: childTopic },
    contextMode: 'references-only'
});

test('ZCode Parity: Switching to a topic with no side chats automatically collapses the side pane', async () => {
    const dom = createTopicBindingTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');

    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        toggleChatBtn: toggleBtn,
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        }
    });

    // 1. Topic A has a side chat open
    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    ctrl.setParent(parentA);
    await ctrl.openChat(createDesc('side-a1', 'topic-a', 'child-a1'));

    assert.equal(ctrl.getSnapshot().visible, true, 'Side pane should be visible for Topic A');
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a1');
    assert.equal(root.classList.contains('active'), true);
    assert.equal(root.classList.contains('collapsed'), false);
    // 面板展开时标题栏的展开按钮隐藏，由面板自己的收起按钮接手
    assert.equal(toggleBtn.hidden, true);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');

    // 2. Switch to Topic B which has NO side chats -> should automatically collapse!
    const parentB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };
    ctrl.setParent(parentB);

    assert.equal(ctrl.getSnapshot().visible, false, 'Side pane MUST automatically collapse for topic without side chats');
    assert.equal(root.classList.contains('active'), false);
    assert.equal(root.classList.contains('collapsed'), true);
    assert.equal(toggleBtn.hidden, false);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');

    await ctrl.dispose();
    dom.window.close();
});

test('ZCode Parity: Switching back to a topic with side chats restores tabs and auto-expands', async () => {
    const dom = createTopicBindingTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');

    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        toggleChatBtn: toggleBtn,
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        }
    });

    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    const parentB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };

    // Topic A opens side-a1
    ctrl.setParent(parentA);
    await ctrl.openChat(createDesc('side-a1', 'topic-a', 'child-a1'));

    // Switch to Topic B (empty -> collapses)
    ctrl.setParent(parentB);
    assert.equal(ctrl.getSnapshot().visible, false);

    // Switch back to Topic A (has side-a1 -> auto-expands and restores side-a1)
    ctrl.setParent(parentA);
    assert.equal(ctrl.getSnapshot().visible, true, 'Should auto-expand when returning to topic with side chats');
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a1');
    assert.equal(root.classList.contains('active'), true);
    assert.equal(root.classList.contains('collapsed'), false);

    await ctrl.dispose();
    dom.window.close();
});

test('ZCode Parity: Explicit collapse preference is remembered per topic (sidePaneCollapsedByOwner)', async () => {
    const dom = createTopicBindingTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');
    const closeBtn = doc.getElementById('closeSidePaneBtn');

    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        toggleChatBtn: toggleBtn,
        closeSidePaneBtn: closeBtn,
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        }
    });

    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    const parentB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };

    ctrl.setParent(parentA);
    await ctrl.openChat(createDesc('side-a1', 'topic-a', 'child-a1'));
    assert.equal(ctrl.getSnapshot().visible, true);

    // User explicitly clicks close button on Topic A
    closeBtn.click();
    assert.equal(ctrl.getSnapshot().visible, false);

    // Switch to Topic B
    ctrl.setParent(parentB);
    assert.equal(ctrl.getSnapshot().visible, false);

    // Switch back to Topic A: user had explicitly collapsed Topic A, so it STAYS collapsed!
    ctrl.setParent(parentA);
    assert.equal(ctrl.getSnapshot().visible, false, 'Should preserve user explicit collapsed preference for Topic A');
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a1');

    // Clicking toggle button on Topic A re-expands it
    toggleBtn.click();
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a1');

    await ctrl.dispose();
    dom.window.close();
});

test('ZCode Parity: Per-topic active tab is remembered (activeTabByOwner)', async () => {
    const dom = createTopicBindingTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');

    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        }
    });

    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    const parentB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };

    ctrl.setParent(parentA);
    await ctrl.openChat(createDesc('side-a1', 'topic-a', 'child-a1'));
    await ctrl.openChat(createDesc('side-a2', 'topic-a', 'child-a2'));
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a2');

    // User switches active tab to side-a1
    ctrl.activateTab('side-a1');
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a1');

    // Switch to Topic B and open side-b1
    ctrl.setParent(parentB);
    await ctrl.openChat(createDesc('side-b1', 'topic-b', 'child-b1'));
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-b1');

    // Switch back to Topic A -> restores side-a1 (the tab user was viewing on Topic A)
    ctrl.setParent(parentA);
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-a1', 'Should restore preferred active tab for Topic A');

    // Switch back to Topic B -> restores side-b1
    ctrl.setParent(parentB);
    assert.equal(ctrl.getSnapshot().activeTabId, 'side-b1', 'Should restore preferred active tab for Topic B');

    await ctrl.dispose();
    dom.window.close();
});

test('ZCode Parity: Closing the last side chat tab automatically collapses side pane', async () => {
    const dom = createTopicBindingTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');

    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        }
    });

    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    ctrl.setParent(parentA);
    await ctrl.openChat(createDesc('side-a1', 'topic-a', 'child-a1'));
    assert.equal(ctrl.getSnapshot().visible, true);

    // Close the only side chat tab for Topic A
    await ctrl.closeTab('side-a1');

    assert.equal(ctrl.getSnapshot().visible, false, 'Side pane MUST automatically collapse when last chat tab is closed');
    assert.equal(root.classList.contains('collapsed'), true);

    await ctrl.dispose();
    dom.window.close();
});

test('ZCode Parity: toggleChatBtn only operates on current parent chat tabs', async () => {
    const dom = createTopicBindingTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');

    let openedForTopic = null;
    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        toggleChatBtn: toggleBtn,
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        },
        openTabEntries: [{ id: 'selection-side-conversation', label: '辅助对话', open: () => ctrl.openSideChat({ forceNew: true }) }],
        onOpenSideChat: async () => {
            openedForTopic = ctrl.getSnapshot().parent?.topicId;
        }
    });

    const parentA = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-a' };
    const parentB = { itemType: 'agent', itemId: 'agent-1', topicId: 'topic-b' };

    // Topic A has side-a1
    ctrl.setParent(parentA);
    await ctrl.openChat(createDesc('side-a1', 'topic-a', 'child-a1'));

    // Switch to Topic B (0 tabs)
    ctrl.setParent(parentB);
    assert.equal(ctrl.getSnapshot().visible, false);

    // Clicking toggle button on Topic B MUST NOT activate side-a1 from Topic A!
    toggleBtn.click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(openedForTopic, 'topic-b', 'Should trigger onOpenSideChat for Topic B, NOT activate Topic A tab');

    await ctrl.dispose();
    dom.window.close();
});
