'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/renderer/messageContextMenu.js', 'utf8');

test('streaming regeneration starts projection with the rendered thinking placeholder before transport', async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="chat"></div>',
        { runScripts: 'outside-only', url: 'https://vcpchat.local/' }
    );
    const executableSource = source
        .replace(
            'export function createMessageContextMenu()',
            'function createMessageContextMenu()'
        )
        .concat('\nwindow.__messageRegenerationTestApi = createMessageContextMenu();\n');
    dom.window.eval(executableSource);

    const history = [
        {
            id: 'user-1',
            role: 'user',
            content: 'hello',
            timestamp: 100,
        },
        {
            id: 'assistant-1',
            role: 'assistant',
            content: 'old response',
            timestamp: 200,
        },
    ];
    const selectedItem = {
        id: 'agent-1',
        type: 'agent',
        name: 'Nova',
        avatarUrl: 'nova.png',
        config: {},
    };
    const callOrder = [];
    let renderedPlaceholder = null;
    let startedMessage = null;
    let startedItem = null;

    const refs = {
        electronAPI: {
            getAgentConfig: async () => ({
                id: 'agent-1',
                name: 'Nova',
                model: 'fixture-model',
                streamOutput: true,
            }),
            sendToVCP: async () => {
                callOrder.push('transport');
                return { streamingStarted: true };
            },
        },
        uiHelper: {
            showToastNotification() {},
            scrollToBottom() {},
        },
        currentChatHistoryRef: {
            get: () => history,
            set: next => history.splice(0, history.length, ...next),
        },
        currentSelectedItemRef: { get: () => selectedItem },
        currentTopicIdRef: { get: () => 'topic-1' },
        globalSettingsRef: {
            get: () => ({
                vcpServerUrl: 'http://fixture.local/v1/chat',
                vcpApiKey: 'secret',
            }),
        },
        historyMutationAuthority: {
            replace: async (_descriptor, nextHistory) => ({
                history: nextHistory,
                result: { success: true },
            }),
        },
        messageCommands: { updateSendButtonState() {} },
    };

    const dependencies = {
        async renderMessage(message) {
            const item = dom.window.document.createElement('article');
            item.className = 'message-item thinking assistant';
            item.dataset.messageId = message.id;
            item.innerHTML =
                '<div class="md-content"><span class="thinking-indicator">思考中' +
                '<span class="thinking-indicator-dots">...</span></span></div>';
            dom.window.document.getElementById('chat').appendChild(item);
            renderedPlaceholder = item;
            return item;
        },
        async startStreamingMessage(message, messageItem) {
            callOrder.push('projection');
            startedMessage = message;
            startedItem = messageItem;
            messageItem.classList.add('streaming', 'thinking');
            return messageItem;
        },
        removeMessageById() {},
    };

    dom.window.__messageRegenerationTestApi.initializeContextMenu(refs, dependencies);
    await dom.window.__messageRegenerationTestApi.handleRegenerateResponse(history[1]);

    assert.deepEqual(callOrder, ['projection', 'transport']);
    assert.equal(startedItem, renderedPlaceholder);
    assert.equal(startedMessage.id, renderedPlaceholder.dataset.messageId);
    assert.equal(startedMessage.content, '');
    assert.equal(startedMessage.isThinking, true);
    assert.equal(startedMessage.context.agentId, 'agent-1');
    assert.equal(startedMessage.context.topicId, 'topic-1');
    assert.equal(renderedPlaceholder.classList.contains('streaming'), true);
    assert.equal(renderedPlaceholder.classList.contains('thinking'), true);
    assert.ok(
        renderedPlaceholder.querySelector(
            '.thinking-indicator .thinking-indicator-dots'
        )
    );

    dom.window.__messageRegenerationTestApi.dispose();
    dom.window.close();
});