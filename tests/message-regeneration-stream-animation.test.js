'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/renderer/messageContextMenu.js', 'utf8');

for (const scenario of ['agent-prompt', 'tavern-only', 'all-workspaces', 'conflict', 'busy', 'nonstream']) {
test(`streaming regeneration expands workspace before transport: ${scenario}`, async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="chat"></div>',
        { runScripts: 'outside-only', url: 'https://vcpchat.local/' }
    );
    Object.assign(dom.window, await import('../modules/chat/contextCompactionState.js'));
    Object.assign(dom.window, await import('../modules/chat/chatContextPipeline.js'));
    dom.window.structuredClone = structuredClone;
    const executableSource = source
        .replace(/^import .*;\s*/gm, '')
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
    // Deliberately different from the visible projection: reproduce the reported bug.
    const durableHistory = structuredClone(history);
    durableHistory[1].admissionTerminal = true;
    const selectedItem = {
        id: 'agent-1',
        type: 'agent',
        name: 'Nova',
        avatarUrl: 'nova.png',
        config: {},
    };
    dom.window.TavernRulesEngine = require('../modules/tavernRulesEngine');
    const snapshot = {
        success: true,
        activeWorkspaceId: scenario === 'all-workspaces' ? null : 'workspace-agent-1',
        rules: [{
            id: 'workspace', type: 'system_suffix', enabled: true, scope: 'agent',
            wrap: false, content: 'TAVERN {{VCPChatWorkSpace}}',
        }],
    };
    let sentMessages = null;
    const callOrder = [];
    let renderedPlaceholder = null;
    let startedMessage = null;
    let startedItem = null;

    const refs = {
        electronAPI: {
            getChatHistory: async () => structuredClone(durableHistory),
            topicAdmissionAcquire: async () => {
                callOrder.push('acquire');
                return { success: scenario !== 'busy', code: 'TOPIC_BUSY' };
            },
            topicAdmissionRelease: async () => { callOrder.push('release'); return { success: true }; },
            topicAdmissionUncertain: async () => { callOrder.push('uncertain'); return { success: true }; },
            topicAdmissionPersistAssistant: async (_scope, message) => {
                callOrder.push('persist');
                assert.ok(message.admissionToken);
                return { success: true, history: [durableHistory[0], message] };
            },
            getAgentConfig: async () => ({
                id: 'agent-1',
                name: 'Nova',
                model: 'fixture-model',
                streamOutput: scenario !== 'nonstream',
                systemPrompt: scenario === 'tavern-only' ? '' : 'PERSONA {{VCPChatWorkSpace}}',
            }),
            resolveConversationContext: async owner => {
                assert.equal(owner.type, 'agent');
                assert.equal(owner.id, 'agent-1');
                return snapshot;
            },
            expandWorkspacePlaceholders: async (text, receivedSnapshot) => {
                assert.equal(receivedSnapshot, snapshot);
                assert.match(text, /TAVERN \{\{VCPChatWorkSpace\}\}/);
                callOrder.push('expand');
                return {
                    success: true,
                    text: text.replaceAll('{{VCPChatWorkSpace}}',
                        snapshot.activeWorkspaceId ? 'TREE_AGENT_1' : '尚未选择工作区'),
                };
            },
            sendToVCP: async (_url, _key, messages) => {
                sentMessages = messages;
                callOrder.push('transport');
                return scenario === 'nonstream'
                    ? { response: { choices: [{ message: { content: 'new reply' } }] } }
                    : { streamingStarted: true };
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
            mutate: async (_descriptor, transform) => ({
                history: await transform(scenario === 'conflict'
                    ? [...structuredClone(durableHistory), { id: 'new', role: 'user', content: 'late arrival' }]
                    : structuredClone(durableHistory)),
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

    if (scenario === 'busy' || scenario === 'conflict') {
        assert.deepEqual(callOrder, scenario === 'busy' ? ['acquire'] : ['acquire', 'release']);
        assert.equal(sentMessages, null, 'busy/conflict must not dispatch');
        assert.equal(history.length, 2, 'conflict must not truncate visible history');
        dom.window.__messageRegenerationTestApi.dispose();
        dom.window.close();
        return;
    }
    if (scenario === 'nonstream') {
        assert.deepEqual(callOrder, ['acquire', 'expand', 'transport', 'persist', 'release']);
        assert.equal(history.at(-1).content, 'new reply');
        dom.window.__messageRegenerationTestApi.dispose();
        dom.window.close();
        return;
    }
    assert.deepEqual(callOrder, ['acquire', 'expand', 'projection', 'transport']);
    assert.ok(startedMessage.context.admissionToken, 'stream persistence owns lease release');
    const system = sentMessages.find(message => message.role === 'system').content;
    assert.doesNotMatch(system, /\{\{VCPChatWorkSpace/);
    assert.match(system, scenario === 'all-workspaces' ? /尚未选择工作区/ : /TREE_AGENT_1/);
    assert.match(system, /TAVERN/);
    assert.equal(history.some(message => JSON.stringify(message).includes('TREE_AGENT_1')), false);
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
}