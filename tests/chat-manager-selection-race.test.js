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

function createFixture(options = {}) {
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
    window.buildDefaultMessageContent = async ({ message }) => [{
        type: 'text',
        text: typeof message?.content === 'string' ? message.content : '',
    }];
    window.updateFirstTextPart = (content, transform) => {
        const parts = Array.isArray(content) ? content.map(part => ({ ...part })) : [];
        const index = parts.findIndex(part => part?.type === 'text');
        if (index >= 0) parts[index].text = transform(parts[index].text || '');
        return parts;
    };
    const chatManagerSource = fs.readFileSync('modules/chatManager.js', 'utf8')
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/chat\/singleChatRequestOrchestrator\.js['"];\s*/, '')
        .replace(/\bexport\s+(?=const\s+chatManager\b)/, '');
    window.eval(`${chatManagerSource}\nwindow.__testChatManager = chatManager;`);
    window.chatManager = window.__testChatManager;

    let selected = Object.freeze({ id: null, type: null, name: null, avatarUrl: null, config: null });
    let topicId = null;
    let history = [];
    let attachedFiles = [];
    const attachmentRef = {
        get: () => attachedFiles,
        set: value => { attachedFiles = value; },
        append: value => { attachedFiles = [...attachedFiles, value]; return attachedFiles; },
    };
    let nextHistorySaveGate = null;
    let nextHistoryReadGate = null;
    let nextHistorySaveError = null;
    let nextWatcherStartError = null;
    let nextVcpError = null;
    let nextVcpGate = null;
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
    let canvasContentListener = null;
    let canvasClosedListener = null;
    let canvasDisposals = 0;
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
        onCanvasContentUpdate(listener) {
            if (options.failCanvasRegistration) throw new Error('controlled canvas listener failure');
            canvasContentListener = listener;
            return () => { canvasDisposals += 1; };
        },
        onCanvasWindowClosed(listener) {
            canvasClosedListener = listener;
            return () => { canvasDisposals += 1; };
        },
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
        getChatHistory: async (itemId, requestedTopicId) => {
            const gate = nextHistoryReadGate;
            if (gate) {
                nextHistoryReadGate = null;
                gate.started.resolve();
                await gate.release.promise;
            }
            return histories.get(`${itemId}:${requestedTopicId}`) || [];
        },
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
            const gate = nextVcpGate;
            if (gate) {
                nextVcpGate = null;
                gate.started.resolve();
                await gate.release.promise;
            }
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
    const singleChatRequestOrchestrator = {
        async buildRequest({ settings, agentConfig, history, messageId, context }) {
            return {
                messages: history
                    .filter(message => message?.isThinking !== true)
                    .map(message => ({ role: message.role, content: message.content })),
                modelConfig: {
                    model: agentConfig.model || 'fixture-model',
                    stream: true,
                },
                messageId,
                context,
                settings,
            };
        },
        async sendPrepared(request, settings) {
            return electronAPI.sendToVCP(
                settings.vcpServerUrl,
                settings.vcpApiKey,
                request.messages,
                request.modelConfig,
                request.messageId,
                false,
                request.context,
            );
        },
    };
    let initError = null;
    try {
        window.chatManager.init({
        singleChatRequestOrchestrator,
        chatRepository: {
            getHistory: (itemId, _itemType, requestedTopicId) => electronAPI.getChatHistory(itemId, requestedTopicId),
            saveHistory: (itemId, _itemType, requestedTopicId, messages) => electronAPI.saveChatHistory(itemId, requestedTopicId, messages),
        },
        electronAPI,
        uiHelper: { showToastNotification() {}, autoResizeTextarea() {}, openModal() {} },
        modules: {
            messageRenderer,
            streamManager: options.streamProjection || null,
            itemListManager: {
                highlightActiveItem() {},
                refreshUnreadCounts() {},
                findItemById(itemId, itemType) {
                    const item = configs[itemId];
                    return item && itemType === 'agent' ? { ...item, type: 'agent' } : null;
                },
            },
            topicListManager: { loadTopicList: () => options.topicListProjection?.promise },
            groupRenderer: null,
        },
        refs: {
            currentSelectedItemRef: { get: () => selected, set: value => { selected = Object.freeze({ ...value }); } },
            currentTopicIdRef: { get: () => topicId, set: value => { topicId = value; } },
            currentChatHistoryRef: { get: () => history, set: value => { history = value; } },
            attachedFilesRef: attachmentRef,
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
    } catch (error) {
        initError = error;
    }
    return {
        dom,
        window,
        chatManager: window.chatManager,
        initError,
        topicRequests,
        createTopicRequests,
        watcherRequests,
        sentRequests,
        attachmentRef,
        configs,
        holdNextHistorySave() {
            const gate = { started: deferred(), release: deferred() };
            nextHistorySaveGate = gate;
            return gate;
        },
        holdNextHistoryRead() {
            const gate = { started: deferred(), release: deferred() };
            nextHistoryReadGate = gate;
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
        holdNextVcpRequest() {
            const gate = { started: deferred(), release: deferred() };
            nextVcpGate = gate;
            return gate;
        },
        holdNextSettingsSave() {
            const gate = { started: deferred(), release: deferred() };
            nextSettingsSaveGate = gate;
            return gate;
        },
        savedSettings,
        historySaveCount: () => historySaveCount,
        canvas: {
            emitContent: value => canvasContentListener?.(value),
            emitClosed: () => canvasClosedListener?.(),
            disposalCount: () => canvasDisposals,
        },
        persistedHistory(itemId, requestedTopicId) {
            return JSON.parse(JSON.stringify(histories.get(`${itemId}:${requestedTopicId}`) || []));
        },
        setPersistedHistory(itemId, requestedTopicId, messages) {
            histories.set(`${itemId}:${requestedTopicId}`, JSON.parse(JSON.stringify(messages)));
        },
        setCurrentHistory(messages) {
            history = messages;
        },
        state: () => ({
            selected,
            topicId,
            rememberedTopicId: selected.id
                ? window.localStorage.getItem(`lastActiveTopic_${selected.id}_${selected.type}`)
                : null,
            history: [...history],
            attachedFiles: [...attachedFiles],
            visibleMessageIds: [...chatMessages.querySelectorAll('.message-item:not(.topic-timestamp-bubble)')]
                .map(element => element.dataset.messageId),
        }),
    };
}

test('ChatManager publishes readiness only after synchronous listener setup completes', () => {
    const fixture = createFixture({ failCanvasRegistration: true });
    assert.match(fixture.initError?.message || '', /controlled canvas listener failure/);
    assert.equal(fixture.chatManager.isReady(), false);
});

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

test('startup restoration waits for the topic projection consumer', async () => {
    const topicListProjection = deferred();
    const fixture = createFixture({ topicListProjection });
    let restored = false;
    const restoring = fixture.chatManager.restoreLastOpenState({
        lastOpenItemId: 'agent-b',
        lastOpenItemType: 'agent',
        lastOpenTopicId: 'topic-b-2',
    }).then(result => {
        restored = result;
        return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(restored, false, 'restoration resolved before the topic projection completed');
    topicListProjection.resolve();
    assert.equal(await restoring, true);
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

test('an attachment added while the outgoing message is persisting remains in the draft', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    const firstAttachment = {
        file: { name: 'sent.txt', type: 'text/plain', size: 4 },
        originalName: 'sent.txt',
        localPath: '/tmp/sent.txt',
    };
    fixture.attachmentRef.append(firstAttachment);
    fixture.window.document.getElementById('messageInput').value = 'send with attachment';
    const saveGate = fixture.holdNextHistorySave();
    const sending = fixture.chatManager.handleSendMessage();
    await saveGate.started.promise;

    const lateAttachment = {
        file: { name: 'next.txt', type: 'text/plain', size: 4 },
        originalName: 'next.txt',
        localPath: '/tmp/next.txt',
    };
    fixture.attachmentRef.append(lateAttachment);
    saveGate.release.resolve();
    await sending;

    assert.deepEqual(fixture.state().attachedFiles, [firstAttachment, lateAttachment]);
    assert.equal(fixture.window.document.getElementById('messageInput').value, 'send with attachment');
    fixture.dom.window.close();
});

test('stream ownership is published before upstream startup resolves', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    const vcpGate = fixture.holdNextVcpRequest();
    fixture.window.document.getElementById('messageInput').value = 'wait for upstream';
    const sending = fixture.chatManager.handleSendMessage();
    await vcpGate.started.promise;

    const stateWhileConnecting = fixture.state();
    const pendingAssistant = stateWhileConnecting.history.find(message => message.role === 'assistant' && message.isThinking);
    assert.ok(pendingAssistant, 'the source history must own the pending assistant before upstream acknowledgement');
    assert.ok(
        fixture.window.document
            .querySelector(`[data-message-id="${pendingAssistant.id}"]`)
            ?.classList.contains('streaming'),
        'the pending assistant must expose active stream styling during upstream startup'
    );

    vcpGate.release.resolve();
    await sending;
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

test('ChatManager dispose retracts Canvas subscriptions and ignores late Canvas events', async () => {
    const fixture = createFixture();
    const input = fixture.window.document.getElementById('messageInput');
    fixture.canvas.emitContent({ content: 'before-dispose' });
    assert.match(input.value, /VCPChatCanvas/);
    input.value = 'stable';

    await fixture.chatManager.dispose();
    await fixture.chatManager.dispose();
    fixture.canvas.emitContent({ content: 'late' });
    fixture.canvas.emitClosed();

    assert.equal(fixture.canvas.disposalCount(), 2);
    assert.equal(input.value, 'stable');
    assert.equal(fixture.chatManager.isReady(), false);
    fixture.dom.window.close();
});

test('a history-file sync resolving after selection changes cannot mutate the new conversation', async () => {
    const fixture = createFixture();
    const selectedB = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selectedB;

    fixture.setPersistedHistory('agent-b', 'topic-b', [
        { id: 'late-b-message', role: 'assistant', content: 'Late B', timestamp: 4 },
    ]);
    const historyRead = fixture.holdNextHistoryRead();
    const sync = fixture.chatManager.syncHistoryFromFile('agent-b', 'agent', 'topic-b');
    await historyRead.started.promise;

    const selectedA = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selectedA;
    historyRead.release.resolve();
    await sync;

    const state = fixture.state();
    assert.equal(state.selected.id, 'agent-a');
    assert.equal(state.topicId, 'topic-a');
    assert.deepEqual(state.history.map(message => message.id), ['a-message']);
    assert.deepEqual(state.visibleMessageIds.filter(Boolean), ['a-message']);
    fixture.dom.window.close();
});

test('a history-file sync resolving after dispose cannot mutate history or the DOM', async () => {
    const fixture = createFixture();
    const selected = fixture.chatManager.selectItem('agent-b', 'agent', 'Agent B', null, fixture.configs['agent-b']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-b').resolve(fixture.configs['agent-b'].topics);
    await selected;

    fixture.setPersistedHistory('agent-b', 'topic-b', [
        { id: 'late-b-message', role: 'assistant', content: 'Late B', timestamp: 4 },
    ]);
    const historyRead = fixture.holdNextHistoryRead();
    const sync = fixture.chatManager.syncHistoryFromFile('agent-b', 'agent', 'topic-b');
    await historyRead.started.promise;
    const beforeDispose = fixture.state();
    const disposal = fixture.chatManager.dispose();
    historyRead.release.resolve();
    await Promise.all([sync, disposal]);

    const state = fixture.state();
    assert.deepEqual(state.history, beforeDispose.history);
    assert.deepEqual(state.visibleMessageIds, beforeDispose.visibleMessageIds);
    fixture.dom.window.close();
});

test('history projection keeps an active stream in the newest batch and final floor', async () => {
    const pendingMessage = {
        id: 'pending-stream-floor',
        role: 'assistant',
        content: '',
        isThinking: true,
        timestamp: 100,
    };
    const fixture = createFixture({
        streamProjection: {
            snapshotConversation: () => [{
                messageId: pendingMessage.id,
                message: pendingMessage,
                context: {
                    agentId: 'agent-a',
                    topicId: 'topic-a',
                    isGroupMessage: false,
                },
                accumulatedText: '',
                streamOperationId: 'pending-operation',
            }],
            async reconcileConversation() {
                return [];
            },
        },
    });
    fixture.setPersistedHistory('agent-a', 'topic-a', Array.from({ length: 24 }, (_, index) => ({
        id: `history-floor-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history ${index}`,
        timestamp: index + 1,
    })));

    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    const state = fixture.state();
    assert.equal(state.history.at(-1)?.id, pendingMessage.id);
    assert.equal(state.visibleMessageIds.at(-1), pendingMessage.id);
    assert.equal(
        state.visibleMessageIds.filter(messageId => messageId === pendingMessage.id).length,
        1,
        'progressive history projection must not duplicate the active stream floor'
    );
    fixture.dom.window.close();
});

test('history load reconciles an active stream after replacing the Surface projection', async () => {
    let reconcileCalls = [];
    const fixture = createFixture({
        streamProjection: {
            async reconcileConversation(identity) {
                reconcileCalls.push(identity);
                return [];
            },
        },
    });
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    assert.equal(reconcileCalls.length, 1);
    assert.equal(reconcileCalls[0].itemType, 'agent');
    assert.equal(reconcileCalls[0].itemId, 'agent-a');
    assert.equal(reconcileCalls[0].topicId, 'topic-a');
    fixture.dom.window.close();
});

test('history sync does not delete a terminal message that commits while the file read is in flight', async () => {
    let active = true;
    const fixture = createFixture({
        streamProjection: {
            getActiveStreamingMessageId: () => active ? 'tool-terminal' : null,
        },
    });
    const selected = fixture.chatManager.selectItem('agent-a', 'agent', 'Agent A', null, fixture.configs['agent-a']);
    await new Promise(resolve => setImmediate(resolve));
    fixture.topicRequests.get('agent-a').resolve(fixture.configs['agent-a'].topics);
    await selected;

    fixture.setPersistedHistory('agent-a', 'topic-a', [
        { id: 'a-message', role: 'assistant', content: 'A', timestamp: 1 },
    ]);
    const historyRead = fixture.holdNextHistoryRead();
    const sync = fixture.chatManager.syncHistoryFromFile('agent-a', 'agent', 'topic-a');
    await historyRead.started.promise;

    // Simulate the terminal commit arriving after the file read began.
    active = false;
    fixture.setCurrentHistory([
        ...fixture.state().history,
        { id: 'tool-terminal', role: 'assistant', content: 'tool result', timestamp: 2 },
    ]);
    historyRead.release.resolve();
    await sync;

    assert.ok(fixture.state().history.some(message => message.id === 'tool-terminal'));
    fixture.dom.window.close();
});
