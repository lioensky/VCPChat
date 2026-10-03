import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';

test('SidePaneController initializes and renders tabs into tabListElement', () => {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs"></div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications"></section>
            </div>
        </aside>
    `);

    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabListElement = root.querySelector('.side-pane-tabs');
    const contentContainer = root.querySelector('.side-pane-content-container');
    const resizerHandle = doc.getElementById('resizerRight');

    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement,
        contentContainer,
    });

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.visible, false);
    assert.equal(snapshot.activeTabId, 'notifications');
    assert.equal(tabListElement.children.length, 1);
    assert.equal(tabListElement.children[0].getAttribute('data-tab-id'), 'notifications');

    controller.dispose();
});

test('SidePaneController showNotifications and openChat mount views and sync visibility', async () => {
    const dom = new JSDOM(`
        <div class="main-content"></div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <div class="side-pane-tabs"></div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications"></section>
            </div>
        </aside>
    `);

    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabListElement = root.querySelector('.side-pane-tabs');
    const contentContainer = root.querySelector('.side-pane-content-container');
    const resizerHandle = doc.getElementById('resizerRight');

    let mountedDescriptor = null;
    let focused = false;
    let disposed = false;

    const mockChatProvider = {
        async mountTab(descriptor, viewElement) {
            mountedDescriptor = descriptor;
            viewElement.innerHTML = '<div class="chat-surface">Chat Ready</div>';
            return {
                focus() { focused = true; },
                async requestClose() { return { closed: true }; },
                async dispose() { disposed = true; },
            };
        },
    };

    const controller = createSidePaneController({
        root,
        resizerHandle,
        tabListElement,
        contentContainer,
        providers: { chat: mockChatProvider },
    });

    controller.showNotifications();
    assert.equal(controller.getSnapshot().visible, true);
    assert.equal(root.classList.contains('active'), true);

    const desc = {
        id: 'side-chat-test',
        parent: { itemType: 'agent', itemId: 'agent-1', topicId: 'p-1' },
        child: { itemType: 'agent', itemId: 'agent-1', topicId: 'c-1' },
        title: '测试侧聊',
    };

    await controller.openChat(desc);
    assert.equal(controller.getSnapshot().activeTabId, 'side-chat-test');
    assert.equal(tabListElement.children.length, 2);
    assert.ok(mountedDescriptor);
    assert.equal(focused, true);

    // View for chat is active, notifications view is inactive
    const notifView = doc.getElementById('sidePaneViewNotifications');
    const chatView = contentContainer.querySelector('[data-tab-id="side-chat-test"]');
    assert.equal(notifView.classList.contains('active'), false);
    assert.equal(chatView.classList.contains('active'), true);

    // Close tab
    await controller.closeTab('side-chat-test');
    assert.equal(disposed, true);
    assert.equal(controller.getSnapshot().activeTabId, 'notifications');
    assert.equal(controller.getSnapshot().visible, false, '最后一个可关的标签关掉后面板收起');
    assert.equal(tabListElement.children.length, 1);
    assert.equal(notifView.classList.contains('active'), true);
    assert.equal(contentContainer.querySelector('[data-tab-id="side-chat-test"]'), null);

    controller.dispose();
});
