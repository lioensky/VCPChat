const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function createFixture() {
    const dom = new JSDOM(`<!doctype html><html data-ui-mode="next"><body>
        <main class="main-content"><div class="chat-messages-container"><div id="chatMessages"></div></div>
            <div id="nextUiEmptyState" aria-hidden="true"></div>
        </main>
        <h3 id="currentChatAgentName"></h3>
        <button id="currentItemAction"></button>
        <textarea id="messageInput"></textarea>
        <button id="sendMessageBtn"></button>
        <button id="attachFileBtn"></button>
        <ul class="topic-list" id="topicList"></ul>
    </body></html>`, { runScripts: 'outside-only', url: 'https://vcpchat.local/' });
    const { window } = dom;
    window.eval(fs.readFileSync('modules/chatManager.js', 'utf8'));

    let selected = { id: null, type: null, name: null, avatarUrl: null, config: null };
    let topicId = null;
    let history = [];
    const topicRequests = new Map();
    const watcherRequests = new Map();
    const histories = new Map([
        ['agent-a:topic-a', [{ id: 'a-message', role: 'assistant', content: 'A', timestamp: 1 }]],
        ['agent-b:topic-b', [{ id: 'b-message', role: 'assistant', content: 'B', timestamp: 2 }]],
        ['agent-b:topic-b-2', [{ id: 'b2-message', role: 'assistant', content: 'B2', timestamp: 3 }]],
    ]);
    const configs = {
        'agent-a': { id: 'agent-a', name: 'Agent A', agentDataPath: '/tmp/a', topics: [{ id: 'topic-a', createdAt: 1 }] },
        'agent-b': { id: 'agent-b', name: 'Agent B', agentDataPath: '/tmp/b', topics: [{ id: 'topic-b', createdAt: 2 }, { id: 'topic-b-2', createdAt: 3 }] },
    };
    const chatMessages = window.document.getElementById('chatMessages');
    const messageRenderer = {
        setCurrentSelectedItem() {}, setCurrentTopicId() {}, setCurrentItemAvatar() {}, setCurrentItemAvatarColor() {},
        clearChat() { chatMessages.textContent = ''; },
        async renderMessage(message) {
            const element = window.document.createElement('div');
            element.className = `message-item${message.isThinking ? ' streaming' : ''}`;
            element.dataset.messageId = message.id || `system-${Date.now()}`;
            chatMessages.append(element);
            return element;
        },
        removeMessageById(id) { chatMessages.querySelector(`[data-message-id="${id}"]`)?.remove(); },
        async renderHistory(messages) {
            for (const message of messages) {
                const element = window.document.createElement('div');
                element.className = 'message-item';
                element.dataset.messageId = message.id;
                chatMessages.append(element);
            }
        },
    };
    const electronAPI = {
        onCanvasContentUpdate() {},
        onCanvasWindowClosed() {},
        watcherStop: async () => {},
        watcherStart: async (_path, itemId, requestedTopicId) => {
            const pending = watcherRequests.get(`${itemId}:${requestedTopicId}`);
            if (pending) await pending.promise;
        },
        getAgentTopics: itemId => {
            const pending = deferred();
            topicRequests.set(itemId, pending);
            return pending.promise;
        },
        getChatHistory: async (itemId, requestedTopicId) => histories.get(`${itemId}:${requestedTopicId}`) || [],
        getAgentConfig: async itemId => configs[itemId],
        saveSettings: async () => ({ success: true }),
    };
    window.chatManager.init({
        electronAPI,
        uiHelper: { showToastNotification() {} },
        modules: {
            messageRenderer,
            itemListManager: { highlightActiveItem() {} },
            topicListManager: { loadTopicList() {} },
            groupRenderer: null,
        },
        refs: {
            currentSelectedItemRef: { get: () => selected, set: value => { selected = value; } },
            currentTopicIdRef: { get: () => topicId, set: value => { topicId = value; } },
            currentChatHistoryRef: { get: () => history, set: value => { history = value; } },
            attachedFilesRef: { get: () => [], set() {} },
            globalSettingsRef: { get: () => ({ assistantEnabled: false }) },
        },
        elements: {
            chatMessagesDiv: chatMessages,
            currentChatNameH3: window.document.getElementById('currentChatAgentName'),
            currentItemActionBtn: window.document.getElementById('currentItemAction'),
            messageInput: window.document.getElementById('messageInput'),
            sendMessageBtn: window.document.getElementById('sendMessageBtn'),
            attachFileBtn: window.document.getElementById('attachFileBtn'),
        },
        mainRendererFunctions: { displaySettingsForItem() {} },
    });
    return {
        dom,
        window,
        chatManager: window.chatManager,
        topicRequests,
        watcherRequests,
        configs,
        state: () => ({
            selected,
            topicId,
            rememberedTopicId: selected.id
                ? window.localStorage.getItem(`lastActiveTopic_${selected.id}_${selected.type}`)
                : null,
            history: [...history],
            visibleMessageIds: [...chatMessages.querySelectorAll('.message-item:not(.topic-timestamp-bubble)')]
                .map(element => element.dataset.messageId),
        }),
    };
}

test('a late assistant selection cannot overwrite the newer assistant topic and history', async () => {
    const fixture = createFixture();
    const selectA = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    const selectB = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selectB;
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selectA;

    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-b');
    assert.equal(state.topicId, 'topic-b');
    assert.equal(state.rememberedTopicId, 'topic-b');
    assert.deepEqual(state.history.map(message => message.id), ['b-message']);
    assert.deepEqual(state.visibleMessageIds.filter(id => id?.endsWith('-message')), ['b-message']);
    fixture.dom.window.close();
});

test('a late topic watcher cannot replace a newer topic history', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selected;

    const slowWatcher = deferred();
    fixture.watcherRequests.set('agent-b:topic-b-2', slowWatcher);
    const first = fixture.chatManager.selectTopic('topic-b-2');
    await new Promise(resolve => setImmediate(resolve));
    const second = fixture.chatManager.selectTopic('topic-b');
    await second;
    slowWatcher.resolve();
    await first;

    const state = fixture.state();
    assert.equal(state.topicId, 'topic-b');
    assert.equal(state.rememberedTopicId, 'topic-b');
    assert.deepEqual(state.history.map(message => message.id), ['b-message']);
    assert.deepEqual(state.visibleMessageIds.filter(id => id?.endsWith('-message')), ['b-message']);
    fixture.dom.window.close();
});
