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
    let attachedFiles = [];
    let nextHistorySaveGate = null;
    let nextHistorySaveError = null;
    let nextWatcherStartError = null;
    let nextVcpError = null;
    let nextSettingsSaveGate = null;
    let historySaveCount = 0;
    const savedSettings = [];
    const sentRequests = [];
    const topicRequests = new Map();
    const createTopicRequests = new Map();
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
        async startStreamingMessage(_message, element) {
            element?.classList.add('streaming');
            return element;
        },
    };
    const electronAPI = {
        onCanvasContentUpdate() {},
        onCanvasWindowClosed() {},
        watcherStop: async () => {},
        watcherStart: async (_path, itemId, requestedTopicId) => {
            if (nextWatcherStartError) {
                const error = nextWatcherStartError;
                nextWatcherStartError = null;
                throw error;
            }
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
        createNewTopicForAgent: itemId => {
            const pending = deferred();
            const requests = createTopicRequests.get(itemId) || [];
            requests.push(pending);
            createTopicRequests.set(itemId, requests);
            return pending.promise;
        },
        saveChatHistory: async (itemId, requestedTopicId, messages) => {
            historySaveCount += 1;
            const gate = nextHistorySaveGate;
            if (gate) {
                nextHistorySaveGate = null;
                gate.started.resolve();
                await gate.release.promise;
            }
            if (nextHistorySaveError) {
                const error = nextHistorySaveError;
                nextHistorySaveError = null;
                throw error;
            }
            histories.set(`${itemId}:${requestedTopicId}`, JSON.parse(JSON.stringify(messages)));
            return { success: true };
        },
        setTopicUnread: async () => ({ success: true }),
        sendToVCP: async (...args) => {
            sentRequests.push(args);
            if (nextVcpError) {
                const error = nextVcpError;
                nextVcpError = null;
                throw error;
            }
            return { streamingStarted: true };
        },
        saveSettings: async settings => {
            const gate = nextSettingsSaveGate;
            if (gate) {
                nextSettingsSaveGate = null;
                gate.started.resolve();
                await gate.release.promise;
            }
            savedSettings.push(JSON.parse(JSON.stringify(settings)));
            return { success: true };
        },
    };
    window.chatManager.init({
        electronAPI,
        uiHelper: { showToastNotification() {}, autoResizeTextarea() {}, openModal() {} },
        modules: {
            messageRenderer,
            itemListManager: {
                highlightActiveItem() {},
                refreshUnreadCounts() {},
                findItemById(itemId, itemType) {
                    const item = configs[itemId];
                    return item && itemType === 'agent' ? { ...item, type: 'agent' } : null;
                },
            },
            topicListManager: { loadTopicList() {} },
            groupRenderer: null,
        },
        refs: {
            currentSelectedItemRef: { get: () => selected, set: value => { selected = value; } },
            currentTopicIdRef: { get: () => topicId, set: value => { topicId = value; } },
            currentChatHistoryRef: { get: () => history, set: value => { history = value; } },
            attachedFilesRef: { get: () => attachedFiles, set: value => { attachedFiles = value; } },
            globalSettingsRef: { get: () => ({ assistantEnabled: false, vcpServerUrl: 'http://fixture.local/v1/chat', vcpApiKey: 'test' }) },
        },
        elements: {
            chatMessagesDiv: chatMessages,
            currentChatNameH3: window.document.getElementById('currentChatAgentName'),
            currentItemActionBtn: window.document.getElementById('currentItemAction'),
            messageInput: window.document.getElementById('messageInput'),
            sendMessageBtn: window.document.getElementById('sendMessageBtn'),
            attachFileBtn: window.document.getElementById('attachFileBtn'),
        },
        mainRendererFunctions: { displaySettingsForItem() {}, updateAttachmentPreview() {} },
    });
    return {
        dom,
        window,
        chatManager: window.chatManager,
        topicRequests,
        createTopicRequests,
        watcherRequests,
        sentRequests,
        configs,
        holdNextHistorySave() {
            const gate = { started: deferred(), release: deferred() };
            nextHistorySaveGate = gate;
            return gate;
        },
        failNextHistorySave(message = 'controlled save failure') {
            nextHistorySaveError = new Error(message);
        },
        failNextWatcherStart(message = 'controlled watcher failure') {
            nextWatcherStartError = new Error(message);
        },
        failNextVcpRequest(message = 'controlled VCP failure') {
            nextVcpError = new Error(message);
        },
        holdNextSettingsSave() {
            const gate = { started: deferred(), release: deferred() };
            nextSettingsSaveGate = gate;
            return gate;
        },
        savedSettings,
        historySaveCount: () => historySaveCount,
        persistedHistory(itemId, requestedTopicId) {
            return JSON.parse(JSON.stringify(histories.get(`${itemId}:${requestedTopicId}`) || []));
        },
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

test('startup restoration selects the last durable assistant and topic', async () => {
    const fixture = createFixture();
    const restoring = fixture.chatManager.restoreLastOpenState({
        lastOpenItemId: 'agent-b',
        lastOpenItemType: 'agent',
        lastOpenTopicId: 'topic-b-2',
    });
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);

    assert.equal(await restoring, true);
    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-b');
    assert.equal(state.topicId, 'topic-b-2');
    assert.deepEqual(state.history.map(message => message.id), ['b2-message']);
    fixture.dom.window.close();
});

test('an explicit selection supersedes an unfinished startup restoration', async () => {
    const fixture = createFixture();
    const restoring = fixture.chatManager.restoreLastOpenState({
        lastOpenItemId: 'agent-a',
        lastOpenItemType: 'agent',
        lastOpenTopicId: 'topic-a',
    });
    await new Promise(resolve => setImmediate(resolve));

    const selecting = fixture.chatManager.selectItem(
        'agent-b',
        'agent',
        'Agent B',
        null,
        fixture.configs['agent-b']
    );
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selecting;
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    assert.equal(await restoring, false);

    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-b');
    assert.equal(state.topicId, 'topic-b');
    assert.deepEqual(state.history.map(message => message.id), ['b-message']);
    fixture.dom.window.close();
});

test('startup restoration ignores a deleted item', async () => {
    const fixture = createFixture();
    assert.equal(await fixture.chatManager.restoreLastOpenState({
        lastOpenItemId: 'deleted-agent',
        lastOpenItemType: 'agent',
        lastOpenTopicId: 'deleted-topic',
    }), false);
    assert.equal(fixture.state().selected.id, null);
    fixture.dom.window.close();
});

test('last-open persistence is ordered and awaited across rapid topic selections', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selected;

    const firstSave = fixture.holdNextSettingsSave();
    const first = fixture.chatManager.selectTopic('topic-b-2');
    await firstSave.started.promise;
    const second = fixture.chatManager.selectTopic('topic-b');
    let firstSettled = false;
    first.then(() => { firstSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstSettled, false, 'selection resolved before its durable state was committed');

    firstSave.release.resolve();
    await Promise.all([first, second]);
    assert.equal(fixture.savedSettings.at(-1).lastOpenTopicId, 'topic-b');
    assert.equal(fixture.state().topicId, 'topic-b');
    fixture.dom.window.close();
});

test('history watcher startup failure does not block assistant navigation', async () => {
    const fixture = createFixture();
    fixture.failNextWatcherStart();
    const selection = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selection;

    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-a');
    assert.equal(state.topicId, 'topic-a');
    assert.deepEqual(state.history.map(message => message.id), ['a-message']);
    assert.deepEqual(state.visibleMessageIds.filter(id => id?.endsWith('-message')), ['a-message']);
    fixture.dom.window.close();
});

test('a send delayed before VCP dispatch cannot mutate the newly selected topic', async () => {
    const fixture = createFixture();
    const selectedA = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selectedA;

    const saveGate = fixture.holdNextHistorySave();
    fixture.window.document.getElementById('messageInput').value = 'message for A';
    const sending = fixture.chatManager.handleSendMessage();
    await saveGate.started.promise;

    const selectedB = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selectedB;
    fixture.window.document.getElementById('messageInput').value = 'draft for B';

    saveGate.release.resolve();
    await sending;

    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-b');
    assert.equal(state.topicId, 'topic-b');
    assert.equal(fixture.window.document.getElementById('messageInput').value, 'draft for B');
    assert.deepEqual(state.history.map(message => message.id), ['b-message']);
    assert.deepEqual(state.visibleMessageIds.filter(Boolean), ['b-message']);
    assert.equal(fixture.sentRequests.length, 1);
    assert.equal(fixture.sentRequests[0][6].agentId, 'agent-a');
    assert.equal(fixture.sentRequests[0][6].topicId, 'topic-a');
    fixture.dom.window.close();
});

test('a failed durable save preserves the draft and retracts the optimistic message', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    fixture.failNextHistorySave();
    fixture.window.document.getElementById('messageInput').value = 'retry this draft';
    await fixture.chatManager.handleSendMessage();

    const state = fixture.state();
    assert.equal(fixture.window.document.getElementById('messageInput').value, 'retry this draft');
    assert.deepEqual(state.history.map(message => message.id), ['a-message']);
    assert.deepEqual(state.visibleMessageIds.filter(Boolean), ['a-message']);
    assert.equal(fixture.sentRequests.length, 0);
    fixture.dom.window.close();
});

test('failed VCP startup does not rewrite history to remove an unpersisted thinking message', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    fixture.failNextVcpRequest();
    fixture.window.document.getElementById('messageInput').value = 'request that fails before streaming';
    await fixture.chatManager.handleSendMessage();

    assert.equal(fixture.historySaveCount(), 1);
    const durable = fixture.persistedHistory('agent-a', 'topic-a');
    assert.deepEqual(durable.map(message => message.role), ['assistant', 'user']);
    assert.equal(durable.some(message => message.isThinking), false);
    fixture.dom.window.close();
});

test('a second send cannot enter the same topic while the first is starting', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    const firstSave = fixture.holdNextHistorySave();
    const input = fixture.window.document.getElementById('messageInput');
    input.value = 'first concurrent message';
    const firstSend = fixture.chatManager.handleSendMessage();
    await firstSave.started.promise;

    input.value = 'second concurrent message';
    const secondSend = fixture.chatManager.handleSendMessage();
    firstSave.release.resolve();
    await Promise.all([firstSend, secondSend]);

    const durableUsers = fixture.persistedHistory('agent-a', 'topic-a')
        .filter(message => message.role === 'user')
        .map(message => message.content);
    assert.deepEqual(durableUsers, ['first concurrent message']);
    assert.equal(fixture.sentRequests.length, 1);
    assert.equal(input.value, 'second concurrent message');
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

test('a topic created for an old assistant cannot switch the new assistant view', async () => {
    const fixture = createFixture();
    const selectedA = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selectedA;

    const creating = fixture.chatManager.createNewTopicForItem('agent-a', 'agent');
    await new Promise(resolve => setImmediate(resolve));
    const selectedB = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selectedB;

    fixture.createTopicRequests.get('agent-a')[0].resolve({ success: true, topicId: 'topic-a-new', topicName: 'New A' });
    await creating;

    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-b');
    assert.equal(state.topicId, 'topic-b');
    assert.deepEqual(state.history.map(message => message.id), ['b-message']);
    assert.deepEqual(state.visibleMessageIds.filter(Boolean), ['b-message']);
    fixture.dom.window.close();
});

test('only the newest concurrent topic creation may select its result', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    const first = fixture.chatManager.createNewTopicForItem('agent-a', 'agent');
    const second = fixture.chatManager.createNewTopicForItem('agent-a', 'agent');
    await new Promise(resolve => setImmediate(resolve));
    const requests = fixture.createTopicRequests.get('agent-a');
    requests[1].resolve({ success: true, topicId: 'topic-a-newest', topicName: 'Newest' });
    await second;
    requests[0].resolve({ success: true, topicId: 'topic-a-older', topicName: 'Older' });
    await first;

    const state = fixture.state();
    assert.equal(state.topicId, 'topic-a-newest');
    assert.deepEqual(state.history, []);
    fixture.dom.window.close();
});

test('a deletion completed for an old assistant cannot rewrite the new assistant', async () => {
    const fixture = createFixture();
    const selectedB = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selectedB;

    const applied = await fixture.chatManager.handleTopicDeletion(
        [{ id: 'topic-a-new', createdAt: 4 }],
        { id: 'agent-a', type: 'agent' }
    );

    const state = fixture.state();
    assert.equal(applied, false);
    assert.equal(state.selected.id, 'agent-b');
    assert.equal(state.topicId, 'topic-b');
    assert.deepEqual(state.history.map(message => message.id), ['b-message']);
    fixture.dom.window.close();
});
