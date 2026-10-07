import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    mountSideChatSurface,
    createSideChatSurfaceOwner
} from '../modules/renderer/sideChatSurfaceOwner.js';
import { installMainComposer } from './helpers/main-composer.mjs';

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
    const uiHelper = {
        showToastNotification: (msg) => { toastMessage = msg; },
        autoResizeTextarea: (el) => { if (el === mainInput) autoResized = true; }
    };
    const caps = { ...createMockChatCapabilities(), uiHelper };
    installMainComposer(dom.window, { uiHelper });

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
    for (const sel of ['.side-chat-parent-link', '.side-chat-context-toggle-btn', '.side-chat-snapshot-drawer', '.side-chat-mode-badge', '.side-chat-ref-modal-backdrop']) {
        assert.equal(container.querySelector(sel), null, `${sel} must not exist`);
    }
    assert.ok(container.querySelector('.side-chat-model-picker-btn'));
    assert.ok(container.querySelector('.side-chat-send-btn'));
    // Same tool row as the main composer: + (attach) and emoticons on the left
    assert.ok(container.querySelector('.side-chat-attach-btn.chat-quick-new-button'));
    assert.ok(container.querySelector('.side-chat-emoticon-btn.chat-emoticon-button'));

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

    assert.equal(assistantMsg.querySelector('.side-chat-send-to-main-btn'), null, 'Fill-to-main lives in the context menu, not under the bubble');
    contentDiv.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const sendBtn = doc.querySelector('#chatContextMenu [data-side-chat-action="send-to-main"]');
    assert.ok(sendBtn, 'Assistant context menu should offer send-to-main');

    sendBtn.click();
    assert.equal(doc.getElementById('chatContextMenu'), null, 'Menu closes after an action');
    assert.equal(mainInput.value, 'Here is the recommended algorithm solution.');
    assert.equal(autoResized, true, 'autoResizeTextarea should be called on mainInput');
    assert.ok(toastMessage && toastMessage.includes('已填入主聊天输入框'));

    await handle.dispose();
    dom.window.close();
});

test('side chat attaches picked files to the next send and clears them', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const container = dom.window.document.getElementById('sideContainer');
    const picks = [];
    let previewed = null;
    const caps = {
        ...createMockChatCapabilities(),
        electronAPI: {
            async selectFilesToSend(agentId, topicId) {
                picks.push([agentId, topicId]);
                return {
                    success: true,
                    attachments: [
                        { name: 'a.txt', type: 'text/plain', size: 3, internalPath: 'file:///a.txt' },
                        { name: 'bad.bin', error: 'too large' }
                    ]
                };
            }
        },
        uiHelper: {
            showToastNotification() {},
            updateAttachmentPreview(files) { previewed = files.map(f => f.originalName); }
        }
    };
    const descriptor = {
        id: 'chat-attach',
        title: 'Attach',
        parent: { itemId: 'agent-1', topicId: 'topic-parent', name: 'Agent' },
        child: { itemId: 'agent-1', topicId: 'topic-child-attach' },
        contextMode: 'references-only',
        model: 'test-model'
    };
    const handle = await mountSideChatSurface(container, { descriptor, chatCapabilities: caps });
    await new Promise(r => setTimeout(r, 10));

    const attachBtn = container.querySelector('.side-chat-attach-btn');
    assert.equal(attachBtn.disabled, false, 'enabled once history is loaded');
    assert.equal(handle.isBusy(), false, 'an idle side chat may sleep');
    attachBtn.click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(handle.isBusy(), true, 'picked files are not saved anywhere, so the view must not sleep with them');
    assert.deepEqual(picks, [['agent-1', 'topic-child-attach']]);
    assert.deepEqual(previewed, ['a.txt']);
    assert.equal(container.querySelector('.side-chat-attachment-preview').hidden, false);

    // A file alone is enough to send
    container.querySelector('.side-chat-composer').requestSubmit();
    await new Promise(r => setTimeout(r, 20));
    const sent = caps.getSentRequest();
    assert.equal(sent.attachments.length, 1);
    assert.equal(sent.attachments[0].localPath, 'file:///a.txt');
    assert.deepEqual(previewed, []);
    assert.equal(container.querySelector('.side-chat-attachment-preview').hidden, true);

    await handle.dispose();
    dom.window.close();
});

test('side chat message context menu offers per-role actions and deletes through the side renderer', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const doc = dom.window.document;
    const container = doc.getElementById('sideContainer');
    const removed = [];
    const base = createMockChatCapabilities();
    base.setHistory([
        { id: 'u1', role: 'user', content: 'raw question' },
        { id: 'a1', role: 'assistant', content: 'raw answer' }
    ]);
    const caps = {
        ...base,
        createRenderer(options) {
            const owned = base.createRenderer(options);
            owned.renderer.removeMessageById = (id, save) => removed.push([id, save]);
            return owned;
        },
        uiHelper: {
            showToastNotification() {},
            showConfirmDialog: async () => true
        }
    };
    const descriptor = {
        id: 'chat-menu',
        title: 'Menu',
        parent: { itemId: 'agent-1', topicId: 'topic-parent' },
        child: { itemId: 'agent-1', topicId: 'topic-child-menu' },
        contextMode: 'blank',
        model: 'test-model'
    };
    const handle = await mountSideChatSurface(container, { descriptor, chatCapabilities: caps });
    await new Promise(r => setTimeout(r, 20));

    const list = container.querySelector('.side-chat-messages-container');
    list.insertAdjacentHTML('beforeend',
        '<div class="message-item user" data-message-id="u1"><div class="md-content">rendered question</div></div>'
        + '<div class="message-item assistant" data-message-id="a1"><div class="md-content">rendered answer</div></div>');
    const openMenu = (sel) => {
        list.querySelector(`${sel} .md-content`).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        return [...doc.querySelectorAll('#chatContextMenu [data-side-chat-action]')].map(el => el.dataset.sideChatAction);
    };

    const userActions = openMenu('.message-item.user');
    assert.ok(userActions.includes('copy') && userActions.includes('edit-again') && userActions.includes('delete'));
    assert.ok(!userActions.includes('send-to-main'), 'Questions are not filled into the main chat');
    doc.querySelector('[data-side-chat-action="edit-again"]').click();
    assert.equal(container.querySelector('.side-chat-textarea').value, 'raw question', 'Edit-again uses the raw text');

    const assistantActions = openMenu('.message-item.assistant');
    assert.ok(assistantActions.includes('send-to-main') && assistantActions.includes('delete'));
    assert.ok(!assistantActions.includes('edit-again'));
    doc.querySelector('[data-side-chat-action="delete"]').click();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(removed, [['a1', false]], 'The side action saves first; renderer removal must not start another save');

    openMenu('.message-item.assistant');
    await handle.dispose();
    assert.equal(doc.getElementById('chatContextMenu'), null, 'Dispose closes an open side menu');
    dom.window.close();
});

test('side chat edits a message in place and regenerates an answer with the side model', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const doc = dom.window.document;
    const container = doc.getElementById('sideContainer');
    const removed = [];
    const saved = [];
    const rerendered = [];
    const base = createMockChatCapabilities();
    base.setHistory([
        { id: 'u1', role: 'user', content: 'first question', attachments: [{ name: 'a.txt', type: 'text/plain', size: 3, src: 'file:///a.txt' }] },
        { id: 'a1', role: 'assistant', content: 'first answer' }
    ]);
    const caps = {
        ...base,
        repository: {
            getHistory: async () => [
                { id: 'u1', role: 'user', content: 'first question', attachments: [{ name: 'a.txt', type: 'text/plain', size: 3, src: 'file:///a.txt' }] },
                { id: 'a1', role: 'assistant', content: 'first answer' }
            ],
            async saveHistory(itemId, itemType, topicId, history) {
                saved.push([topicId, history.map(m => m.id)]);
                return { success: true };
            }
        },
        createRenderer(options) {
            const owned = base.createRenderer(options);
            owned.renderer.removeMessageById = (id, save) => removed.push([id, save]);
            owned.renderer.updateMessageContent = (id, text) => rerendered.push([id, text]);
            return owned;
        },
        uiHelper: { showToastNotification() {} }
    };
    const descriptor = {
        id: 'chat-edit',
        title: 'Edit',
        parent: { itemId: 'agent-1', topicId: 'topic-parent' },
        child: { itemId: 'agent-1', topicId: 'topic-child-edit' },
        contextMode: 'blank',
        model: 'test-model'
    };
    const handle = await mountSideChatSurface(container, { descriptor, chatCapabilities: caps });
    await new Promise(r => setTimeout(r, 20));

    const list = container.querySelector('.side-chat-messages-container');
    list.insertAdjacentHTML('beforeend',
        '<div class="message-item user" data-message-id="u1"><div class="details-and-bubble-wrapper"><div class="md-content">first question</div></div></div>'
        + '<div class="message-item assistant" data-message-id="a1"><div class="details-and-bubble-wrapper"><div class="md-content">first answer</div></div></div>');
    const menuAction = (sel, action) => {
        list.querySelector(`${sel} .md-content`).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
        return doc.querySelector(`#chatContextMenu [data-side-chat-action="${action}"]`);
    };

    // Edit: textarea replaces the bubble, Escape cancels, save writes the side topic and re-renders
    menuAction('.message-item.assistant', 'edit').click();
    const item = list.querySelector('.message-item.assistant');
    assert.ok(item.classList.contains('side-chat-editing'));
    let input = item.querySelector('.message-edit-textarea');
    assert.equal(input.value, 'first answer');
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(item.querySelector('.message-edit-textarea'), null);
    assert.equal(saved.length, 0, 'Cancel does not save');

    menuAction('.message-item.assistant', 'edit').click();
    input = item.querySelector('.message-edit-textarea');
    input.value = 'edited answer';
    item.querySelector('[data-side-chat-edit="save"]').click();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(saved.at(-1), ['topic-child-edit', ['u1', 'a1']]);
    assert.deepEqual(rerendered, [['a1', 'edited answer']]);
    assert.equal(item.classList.contains('side-chat-editing'), false);

    // Regenerate: drops the question and answer, then resends the question with its attachments
    assert.equal(menuAction('.message-item.user', 'regenerate'), null, 'Questions have no regenerate');
    menuAction('.message-item.assistant', 'regenerate').click();
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(saved.at(-1), ['topic-child-edit', []]);
    assert.deepEqual(removed, [['u1', false], ['a1', false]]);
    const sent = caps.getSentRequest();
    assert.equal(sent.content, 'first question');
    assert.equal(sent.attachments.length, 1);
    assert.equal(sent.attachments[0].localPath, 'file:///a.txt');

    await handle.dispose();
    dom.window.close();
});

test('the side chat surface hangs under the view scope the controller passes and is torn down with it', async () => {
    const { createSidePaneRootScope } = await import('../modules/ui-system/side-pane/side-pane-occurrence.js');
    const { defineChatTabType } = await import('../modules/ui-system/side-pane/tab-types/chat.js');
    const dom = new JSDOM('<div id="tabContainer"></div>');
    const container = dom.window.document.getElementById('tabContainer');
    const caps = createMockChatCapabilities();
    let rendererDisposed = 0;
    const createRenderer = caps.createRenderer;
    caps.createRenderer = options => {
        const owned = createRenderer(options);
        return { ...owned, dispose: async () => { rendererDisposed += 1; await owned.dispose(); } };
    };
    const owner = createSideChatSurfaceOwner({ chatCapabilities: caps });
    // 标签类型把控制器给的挂载上下文原样交给 provider
    const tabType = defineChatTabType({ provider: owner });
    const view = createSidePaneRootScope(null, 'test-view');
    const descriptor = {
        id: 'chat-scope-1',
        title: 'Scope Test',
        parent: { itemId: 'agent-1', topicId: 'topic-p' },
        child: { itemId: 'agent-1', topicId: 'topic-scope' },
        contextMode: 'references-only',
        model: 'test-model'
    };
    const handle = await tabType.provider.mountTab({ descriptor }, container, { scope: view });
    const { diagnostics } = globalThis.VCPLifecycle;
    const surfaceScope = diagnostics.snapshot().find(scope => scope.parentId === view.id);
    assert.equal(surfaceScope.label, 'side-chat-chat-scope-1');
    assert.ok(surfaceScope.resources.some(resource => resource.label === 'side-chat-surface'));

    // 控制器只释放 view scope：对话面板一样被拆掉
    await view.dispose('dormant');
    assert.equal(container.children.length, 0);
    assert.equal(rendererDisposed, 1);
    assert.equal(diagnostics.snapshot().some(scope => scope.id === surfaceScope.id), false);

    // 之后再调 dispose 不会重复拆
    await handle.dispose();
    assert.equal(rendererDisposed, 1);
    dom.window.close();
});

test('a send started while regenerate is still saving the trimmed history is refused', async () => {
    const dom = new JSDOM('<div id="sideContainer"></div>');
    const doc = dom.window.document;
    const container = doc.getElementById('sideContainer');
    const base = createMockChatCapabilities();
    const initial = [{ id: 'u1', role: 'user', content: 'question' }, { id: 'a1', role: 'assistant', content: 'answer' }];
    base.setHistory(initial);
    let releaseSave;
    let saves = 0;
    const caps = {
        ...base,
        repository: {
            getHistory: async () => initial,
            saveHistory: () => { saves += 1; return saves === 1 ? new Promise(resolve => { releaseSave = () => resolve({ success: true }); }) : Promise.resolve({ success: true }); }
        },
        createRenderer(options) {
            const owned = base.createRenderer(options);
            owned.renderer.removeMessageById = () => {};
            return owned;
        },
        uiHelper: { showToastNotification() {} }
    };
    const descriptor = {
        id: 'chat-regen', title: 'R', parent: { itemId: 'agent-1', topicId: 'p' },
        child: { itemId: 'agent-1', topicId: 'c-regen' }, contextMode: 'blank', model: 'test-model'
    };
    const handle = await mountSideChatSurface(container, { descriptor, chatCapabilities: caps });
    await new Promise(r => setTimeout(r, 20));
    const list = container.querySelector('.side-chat-messages-container');
    list.insertAdjacentHTML('beforeend', '<div class="message-item assistant" data-message-id="a1"><div class="details-and-bubble-wrapper"><div class="md-content">answer</div></div></div>');
    list.querySelector('.message-item.assistant .md-content').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    doc.querySelector('#chatContextMenu [data-side-chat-action="regenerate"]').click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(saves, 1, 'regenerate is waiting on the save');
    assert.equal(handle.isBusy(), true, 'a regenerate in flight keeps the view awake');

    const textarea = container.querySelector('textarea');
    textarea.value = 'typed meanwhile';
    container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
    releaseSave();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(textarea.value, 'typed meanwhile', 'the typed text stays in the composer');
    assert.equal(caps.getSentRequest()?.content, 'question', 'only the regenerated question was sent');

    await handle.dispose();
    dom.window.close();
});
