import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { defineChatTabType } from '../modules/ui-system/side-pane/tab-types/chat.js';
import { createSideChatSurfaceOwner } from '../modules/renderer/sideChatSurfaceOwner.js';
import { createSideChatDescriptor, createChildTopicForAgent } from '../modules/chat/sideChatSessionService.js';
import { fixture } from './helpers/side-chat-surface-fixture.mjs';
import { waitFor } from './helpers/wait-for.mjs';

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
        expandButton: toggleChatBtn,
        addTabButton: addChatBtn,
        tabTypes: [defineChatTabType({ provider: sideChatOwner, openSideChat })]
    });

    async function openSideChat(opts = {}) {
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

        controller.setParent(desc.parent);
        const handle = await controller.openTab({ kind: 'chat', descriptor: desc });
        if (opts.reference) {
            handle.addReference(opts.reference);
        }
        return handle;
    }

    // 1. 面板里没有标签、只登记了一个入口时，展开按钮直接打开它
    toggleChatBtn.click();
    await waitFor(() => controller.getSnapshot().tabs.length === 2 && controller.getTabHandle(controller.getSnapshot().tabs[1].id));

    assert.equal(controller.getSnapshot().visible, true);
    assert.equal(controller.getSnapshot().tabs.length, 2); // notifications + 1 chat tab

    const activeTab = controller.getSnapshot().tabs[1];
    assert.equal(activeTab.kind, 'chat');
    assert.equal(activeTab.descriptor.child.topicId, 'topic-child-999');

    // 2. Verify view was mounted
    const chatView = contentContainer.querySelector(`[data-tab-id="${activeTab.id}"]`);
    assert.ok(chatView);
    assert.equal(chatView.hidden, false);

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

    // 引用和问题的拼装见 side-chat-surface-owner.test.mjs；这里只看请求落在新建的子话题上
    await waitFor(() => sentRequest && !form.hasAttribute('aria-busy'));
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

// 停止辅助对话只取消它自己的流：同一个 chatManager / 流桥上的主聊天流照常接收
test('Dual stream concurrency: cancelling side chat does not abort main chat stream', async t => {
    const f = await fixture(t, { stream: true });
    const main = { chunks: [], settled: null };
    f.streamRoutes.register('main-stream', { kind: 'main-chat', start() {},
        append(_id, chunk) { main.chunks.push(chunk); }, settle(result) { main.settled = result; }, release() {} });
    f.bridge.accept({ type: 'data', messageId: 'main-stream', context: {}, chunk: 'main-1' });

    f.submit('Side chat question');
    await waitFor(() => f.requests.length === 1 && f.handle.isBusy());
    await waitFor(() => main.chunks.length === 1);
    const stopBtn = f.doc.querySelector('.side-chat-stop-btn');
    assert.equal(stopBtn.hidden, false);

    f.stop();
    await f.untilIdle();
    assert.equal(f.statuses.at(-1)?.code, 'cancelled');
    assert.equal(stopBtn.hidden, true);

    // 主聊天的流还登记着、还在收数据，也没有被结算
    assert.ok(f.streamRoutes.claim('main-stream'));
    f.bridge.accept({ type: 'data', messageId: 'main-stream', context: {}, chunk: 'main-2' });
    await waitFor(() => main.chunks.length === 2);
    assert.deepEqual(main.chunks, ['main-1', 'main-2']);
    assert.equal(main.settled, null);
});
