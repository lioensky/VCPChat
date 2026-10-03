import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { createSideChatSurfaceOwner } from '../modules/renderer/sideChatSurfaceOwner.js';
import { createSideChatDescriptor, createChildTopicForAgent } from '../modules/chat/sideChatSessionService.js';

test('Full Side Chat lifecycle integration: open, refer, send, and close', async () => {
    const markup = `
      <aside class="vcp-side-pane" id="vcpSidePane">
        <div class="side-pane-tabs"></div>
        <div class="side-pane-content-container">
          <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
        </div>
      </aside>
      <button id="toggleSidePaneChatBtn"></button>
      <button id="closeSidePaneBtn"></button>
      <button id="addSidePaneChatBtn"></button>
    `;
    const dom = new JSDOM(markup);
    const doc = dom.window.document;

    let sentRequest = null;
    let cancelCalled = false;
    let currentHistory = [];

    const mockCapabilities = {
        repository: {
            async getHistory() { return currentHistory; },
            async saveHistory() { return { success: true }; }
        },
        createRenderer: ({ root, conversation }) => {
            return {
                renderer: {
                    async renderHistory(h) { currentHistory = h; },
                    async dispose() {}
                },
                conversation: {
                    selectedItemRef: { get: () => conversation.selectedItem },
                    topicIdRef: { get: () => conversation.topicId },
                    historyRef: { get: () => currentHistory, set: (h) => { currentHistory = h; } },
                    replaceHistory: (h) => { currentHistory = h; },
                    dispose: () => {}
                },
                dispose: async () => {}
            };
        },
        manager: {
            async sendMessage(req) {
                sentRequest = req;
                req.onOperation?.({
                    cancel: async () => { cancelCalled = true; return true; }
                });
                return { terminal: { event: { type: 'completed' } } };
            }
        }
    };

    const mockElectronAPI = {
        async createSideChatChild() {
            return { success: true, topicId: 'topic-child-999' };
        }
    };

    const sideChatOwner = createSideChatSurfaceOwner({
        chatCapabilities: mockCapabilities
    });

    const sidePane = doc.getElementById('vcpSidePane');
    const tabsContainer = doc.querySelector('.side-pane-tabs');
    const contentContainer = doc.querySelector('.side-pane-content-container');
    const toggleChatBtn = doc.getElementById('toggleSidePaneChatBtn');
    const addChatBtn = doc.getElementById('addSidePaneChatBtn');

    let currentItem = { id: 'agent-alice', type: 'agent', name: 'Alice' };
    let currentTopicId = 'topic-alice-main';

    const controller = createSidePaneController({
        root: sidePane,
        tabListElement: tabsContainer,
        contentContainer,
        toggleChatBtn,
        addChatTabBtn: addChatBtn,
        providers: {
            chat: sideChatOwner
        },
        openTabEntries: [{ id: 'selection-side-conversation', label: '辅助对话', open: () => controller.openSideChat({ forceNew: true }) }],
        onOpenSideChat: async (opts = {}) => {
            const createRes = await createChildTopicForAgent({
                electronAPI: mockElectronAPI,
                agentId: currentItem.id,
                topicTitle: opts.title || '侧聊 1'
            });
            assert.equal(createRes.ok, true);

            const desc = createSideChatDescriptor({
                parent: { itemId: currentItem.id, topicId: currentTopicId, name: currentItem.name },
                childTopicId: createRes.topicId,
                title: opts.title || '侧聊 1',
                model: 'test-model'
            });

            const handle = await controller.openChat(desc);
            if (opts.reference) {
                handle.addReference(opts.reference);
            }
            return handle;
        }
    });

    // 1. 面板里没有标签、只登记了一个入口时，展开按钮直接打开它
    toggleChatBtn.click();
    await new Promise(r => setTimeout(r, 20));

    // Verify side pane is active and visible
    assert.equal(sidePane.classList.contains('active'), true);
    assert.equal(controller.getSnapshot().visible, true);
    assert.equal(controller.getSnapshot().tabs.length, 2); // notifications + 1 chat tab

    const activeTab = controller.getSnapshot().tabs[1];
    assert.equal(activeTab.kind, 'chat');
    assert.equal(activeTab.descriptor.child.topicId, 'topic-child-999');

    // 2. Verify view was mounted
    const chatView = contentContainer.querySelector(`[data-tab-id="${activeTab.id}"]`);
    assert.ok(chatView);
    assert.equal(chatView.classList.contains('active'), true);

    const textarea = chatView.querySelector('.side-chat-textarea');
    assert.ok(textarea);

    // 3. Add selection reference
    const handle = controller.getTabHandle(activeTab.id);
    assert.ok(handle);
    handle.addReference({ id: 'ref-1', text: 'Important context line', sourceMessageId: 'm-1' });

    assert.equal(handle.getReferences().length, 1);
    const refCard = chatView.querySelector('.side-chat-reference-box');
    assert.ok(refCard);
    assert.ok(refCard.textContent.includes('Important context line'));

    // 4. Send message
    textarea.value = '请分析该行内容';
    const form = chatView.querySelector('form');
    form.requestSubmit();

    await new Promise(r => setTimeout(r, 20));

    assert.ok(sentRequest);
    assert.ok(sentRequest.content.includes('引用：「'));
    assert.ok(sentRequest.content.includes('Important context line'));
    assert.ok(sentRequest.content.includes('请分析该行内容'));
    assert.equal(sentRequest.conversation.topicIdRef.get(), 'topic-child-999');

    // 5. Close chat tab
    await controller.closeTab(activeTab.id);

    assert.equal(controller.getSnapshot().tabs.length, 1);
    assert.equal(controller.getSnapshot().activeTabId, 'notifications');
    assert.equal(contentContainer.querySelector(`[data-tab-id="${activeTab.id}"]`), null);

    // Cleanup
    controller.dispose();
    dom.window.close();
});

test('Dual stream concurrency: cancelling side chat does not abort main chat stream', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const container = dom.window.document.getElementById('sideContainer');

    let mainCancelled = false;
    let sideCancelled = false;

    const mockMainOperation = {
        cancel: async () => { mainCancelled = true; return true; }
    };
    const mockSideOperation = {
        cancel: async () => { sideCancelled = true; return true; }
    };

    const mockCapabilities = {
        repository: {
            async getHistory() { return []; },
            async saveHistory() { return { success: true }; }
        },
        createRenderer: ({ conversation }) => ({
            renderer: { async renderHistory() {}, async dispose() {} },
            conversation: {
                selectedItemRef: { get: () => conversation.selectedItem },
                topicIdRef: { get: () => conversation.topicId },
                historyRef: { get: () => [], set: () => {} },
                replaceHistory: () => [],
                dispose: () => {}
            },
            dispose: async () => {}
        }),
        manager: {
            async sendMessage(req) {
                req.onOperation?.(mockSideOperation);
                return new Promise((resolve) => {
                    // Simulates ongoing stream
                    setTimeout(() => {
                        resolve({ terminal: { event: { type: sideCancelled ? 'cancelled' : 'completed' } } });
                    }, 50);
                });
            }
        }
    };

    const descriptor = {
        id: 'chat-side-stream-1',
        title: '并发流测试',
        parent: { itemId: 'agent-1', topicId: 'topic-main' },
        child: { itemId: 'agent-1', topicId: 'topic-side' },
        contextMode: 'references-only',
        model: 'test-model'
    };

    const sideChatOwner = createSideChatSurfaceOwner({
        chatCapabilities: mockCapabilities
    });

    const handle = await sideChatOwner.mountTab(descriptor, container);
    await new Promise(r => setTimeout(r, 10));

    // Submit side chat message
    const textarea = container.querySelector('.side-chat-textarea');
    textarea.value = 'Side chat question';
    const form = container.querySelector('form');
    form.requestSubmit();

    // Verify side chat is busy/generating
    const stopBtn = container.querySelector('.side-chat-stop-btn');
    assert.equal(stopBtn.hidden, false);

    // Click stop on side chat
    stopBtn.click();
    await new Promise(r => setTimeout(r, 60));

    // Side chat was cancelled, main chat was untouched
    assert.equal(sideCancelled, true);
    assert.equal(mainCancelled, false);

    await handle.dispose();
    dom.window.close();
});

test('Parent context snapshot inheritance (P1): child sends frozen parent context without persisting it to child topic', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const container = dom.window.document.getElementById('sideContainer');

    let sentRequest = null;
    let savedTopicHistory = null;

    const mockCapabilities = {
        repository: {
            async getHistory() { return []; },
            async saveHistory(itemId, itemType, topicId, history) {
                savedTopicHistory = history;
                return { success: true };
            }
        },
        createRenderer: ({ conversation }) => ({
            renderer: { async renderHistory() {}, async dispose() {} },
            conversation: {
                selectedItemRef: { get: () => conversation.selectedItem },
                topicIdRef: { get: () => conversation.topicId },
                historyRef: { get: () => [], set: () => {} },
                replaceHistory: () => [],
                dispose: () => {}
            },
            dispose: async () => {}
        }),
        manager: {
            async sendMessage(req) {
                sentRequest = req;
                return { terminal: { event: { type: 'completed' } } };
            }
        }
    };

    const parentHistory = [
        { role: 'user', content: 'Parent question 1' },
        { role: 'assistant', content: 'Parent answer 1' }
    ];

    const descriptor = {
        id: 'chat-side-inheritance-1',
        title: '上下文继承测试',
        parent: { itemId: 'agent-1', topicId: 'topic-main' },
        child: { itemId: 'agent-1', topicId: 'topic-side' },
        contextMode: 'parent-snapshot',
        model: 'test-model',
        parentSnapshot: parentHistory
    };

    const sideChatOwner = createSideChatSurfaceOwner({
        chatCapabilities: mockCapabilities
    });

    const handle = await sideChatOwner.mountTab(descriptor, container);
    await new Promise(r => setTimeout(r, 10));

    // Submit side chat message
    const textarea = container.querySelector('.side-chat-textarea');
    textarea.value = 'Child question 1';
    const form = container.querySelector('form');
    form.requestSubmit();

    await new Promise(r => setTimeout(r, 20));

    assert.ok(sentRequest);
    assert.equal(typeof sentRequest.conversation.getContextHistory, 'function');
    const inherited = sentRequest.conversation.getContextHistory();
    assert.equal(inherited.length, 2);
    assert.equal(inherited[0].content, 'Parent question 1');
    assert.equal(inherited[1].content, 'Parent answer 1');

    await handle.dispose();
    dom.window.close();
});
