import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    mountSideChatSurface,
    createSideChatSurfaceOwner
} from '../modules/renderer/sideChatSurfaceOwner.js';

function createMockChatCapabilities() {
    let sentRequest = null;
    let cancelCalled = false;
    let currentHistory = [];

    const mockRepository = {
        async getHistory(itemId, itemType, topicId) {
            return currentHistory;
        },
        async saveHistory() {
            return { success: true };
        }
    };

    const mockCreateRenderer = ({ root, mode, conversation, handleSendMessage }) => {
        let rendererDisposed = false;
        return {
            renderer: {
                async renderHistory(history) {
                    currentHistory = history;
                },
                async dispose() {
                    rendererDisposed = true;
                }
            },
            conversation: {
                selectedItemRef: { get: () => conversation.selectedItem },
                topicIdRef: { get: () => conversation.topicId },
                historyRef: { get: () => currentHistory, set: (h) => { currentHistory = h; } },
                replaceHistory: (h) => { currentHistory = h; },
                dispose: () => {}
            },
            dispose: async () => {
                rendererDisposed = true;
            }
        };
    };

    const mockManager = {
        async sendMessage(request) {
            sentRequest = request;
            let cancelled = false;
            const op = {
                cancel: async (reason) => {
                    cancelled = true;
                    cancelCalled = true;
                    return true;
                }
            };
            request.onOperation?.(op);
            // Simulate short completion
            if (cancelled) {
                return { terminal: { event: { type: 'cancelled' } } };
            }
            return { terminal: { event: { type: 'completed' } } };
        }
    };

    return {
        repository: mockRepository,
        createRenderer: mockCreateRenderer,
        manager: mockManager,
        getSentRequest: () => sentRequest,
        wasCancelCalled: () => cancelCalled,
        setHistory: (h) => { currentHistory = h; }
    };
}

test('mountSideChatSurface builds shell, loads history, and transitions to ready', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const container = dom.window.document.getElementById('sideContainer');
    const caps = createMockChatCapabilities();

    const descriptor = {
        id: 'chat-test-1',
        title: '测试侧边聊天',
        parent: { itemId: 'agent-1', topicId: 'topic-parent', name: 'Agent One' },
        child: { itemId: 'agent-1', topicId: 'topic-child-1' },
        contextMode: 'references-only',
        model: 'test-model'
    };

    const handle = await mountSideChatSurface(container, {
        descriptor,
        chatCapabilities: caps
    });

    assert.ok(handle);
    assert.equal(handle.descriptor.id, 'chat-test-1');

    // Check DOM elements
    const titleEl = container.querySelector('.side-chat-topic-title');
    assert.equal(titleEl.textContent, '测试侧边聊天');

    const textarea = container.querySelector('.side-chat-textarea');
    assert.ok(textarea);

    const sendBtn = container.querySelector('.side-chat-send-btn');
    assert.ok(sendBtn);

    // Wait for history load tick
    await new Promise(r => setTimeout(r, 10));

    const statusText = container.querySelector('.side-chat-status-text');
    assert.equal(statusText.textContent, '', 'no always-on status text');
    assert.equal(textarea.disabled, false);

    await handle.dispose();
    dom.window.close();
});

test('submitting side chat formats reference cards and dispatches message', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const container = dom.window.document.getElementById('sideContainer');
    const caps = createMockChatCapabilities();

    const descriptor = {
        id: 'chat-test-2',
        title: '侧聊引用测试',
        parent: { itemId: 'agent-1', topicId: 'topic-parent', name: 'Agent One' },
        child: { itemId: 'agent-1', topicId: 'topic-child-2' },
        contextMode: 'references-only',
        model: 'test-model'
    };

    const handle = await mountSideChatSurface(container, {
        descriptor,
        chatCapabilities: caps
    });

    await new Promise(r => setTimeout(r, 10));

    // Add reference
    handle.addReference({ id: 'ref-1', text: 'function calculate() { return 42; }', sourceMessageId: 'm1' });
    assert.equal(handle.getReferences().length, 1);

    const refCard = container.querySelector('.side-chat-reference-box');
    assert.ok(refCard);
    assert.ok(refCard.textContent.includes('function calculate()'));

    // Input text and submit
    const textarea = container.querySelector('.side-chat-textarea');
    textarea.value = '解释这段代码';
    const form = container.querySelector('form');
    form.requestSubmit();

    await new Promise(r => setTimeout(r, 20));

    const sent = caps.getSentRequest();
    assert.ok(sent);
    assert.ok(sent.content.includes('引用：「'));
    assert.ok(sent.content.includes('function calculate()'));
    assert.ok(sent.content.includes('解释这段代码'));

    // References cleared after successful submission
    assert.equal(handle.getReferences().length, 0);

    await handle.dispose();
    dom.window.close();
});

test('createSideChatSurfaceOwner wraps mountTab provider contract', async () => {
    const dom = new JSDOM('<div id="tabContainer"></div>');
    const container = dom.window.document.getElementById('tabContainer');
    const caps = createMockChatCapabilities();

    const owner = createSideChatSurfaceOwner({ chatCapabilities: caps });
    assert.equal(typeof owner.mountTab, 'function');

    const descriptor = {
        id: 'chat-test-3',
        title: 'Provider Test',
        parent: { itemId: 'agent-1', topicId: 'topic-p' },
        child: { itemId: 'agent-1', topicId: 'topic-c' },
        contextMode: 'references-only',
        model: 'test-model'
    };

    const handle = await owner.mountTab(descriptor, container);
    assert.ok(handle);
    const closeRes = await handle.requestClose();
    assert.equal(closeRes.closed, true);

    await handle.dispose();
    assert.equal(container.children.length, 0);
    dom.window.close();
});

test('mountSideChatSurface keeps a minimal composer and offers send-to-main on assistant messages', async () => {
    let autoResized = false;
    const dom = new JSDOM(`
        <div>
            <textarea id="messageInput"></textarea>
            <div id="sideContainer"></div>
        </div>
    `);
    const doc = dom.window.document;
    const container = doc.getElementById('sideContainer');
    const mainInput = doc.getElementById('messageInput');

    let toastMessage = null;
    const caps = {
        ...createMockChatCapabilities(),
        uiHelper: {
            showToastNotification: (msg) => { toastMessage = msg; },
            autoResizeTextarea: (el) => { if (el === mainInput) autoResized = true; }
        }
    };

    const parentSnapshot = [
        { id: 'p1', role: 'user', content: 'What is Python?' },
        { id: 'p2', role: 'assistant', content: 'Python is a high-level programming language.' }
    ];

    const descriptor = {
        id: 'chat-test-p1',
        title: 'P1 Context Side Chat',
        parent: { itemId: 'agent-1', topicId: 'topic-parent', name: 'Master Agent' },
        child: { itemId: 'agent-1', topicId: 'topic-child-p1' },
        contextMode: 'parent-snapshot',
        model: 'test-model',
        parentSnapshot
    };

    const handle = await mountSideChatSurface(container, {
        descriptor,
        chatCapabilities: caps
    });

    // 1. The composer stays like the main one: no parent link / context button / drawer / 引用 button
    for (const sel of ['.side-chat-parent-link', '.side-chat-context-toggle-btn', '.side-chat-snapshot-drawer', '.side-chat-mode-badge', '.side-chat-attach-btn', '.side-chat-ref-modal-backdrop']) {
        assert.equal(container.querySelector(sel), null, `${sel} must not exist`);
    }
    assert.ok(container.querySelector('.side-chat-model-picker-btn'));
    assert.ok(container.querySelector('.side-chat-send-btn'));

    // 2. The inherited snapshot still feeds the model
    assert.equal(handle.descriptor.parentSnapshot.length, 2);

    // 3. Check send-to-main action on assistant message
    const msgContainer = container.querySelector('.side-chat-messages-container');
    const assistantMsg = doc.createElement('div');
    assistantMsg.className = 'message-item assistant';
    const contentDiv = doc.createElement('div');
    contentDiv.className = 'md-content';
    contentDiv.textContent = 'Here is the recommended algorithm solution.';
    assistantMsg.appendChild(contentDiv);
    msgContainer.appendChild(assistantMsg);

    // Give MutationObserver a tick to run or trigger observer
    await new Promise(r => setTimeout(r, 20));

    const sendBtn = assistantMsg.querySelector('.side-chat-send-to-main-btn');
    assert.ok(sendBtn, 'Assistant message should have send-to-main button');

    sendBtn.click();
    assert.equal(mainInput.value, 'Here is the recommended algorithm solution.');
    assert.equal(autoResized, true, 'autoResizeTextarea should be called on mainInput');
    assert.ok(toastMessage && toastMessage.includes('已填入主聊天输入框'));

    await handle.dispose();
    dom.window.close();
});
