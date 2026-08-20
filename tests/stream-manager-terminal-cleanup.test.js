'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const originalWindow = global.window;
const bootstrapDom = new JSDOM('<!doctype html>');
global.window = bootstrapDom.window;
test.after(() => {
    global.window = originalWindow;
    bootstrapDom.window.close();
});

const loadFactory = async () => {
    const module = await import('../modules/renderer/streamManager.js');
    const historyModule = await import('../modules/chat/streamTransientHistory.js');
    createDependencies.historyFactory = historyModule.createStreamTransientHistory;
    return module.createStreamProjection;
};

function createDependencies(dom, overrides = {}) {
    const root = dom.window.document.getElementById('chat');
    const dependencies = {
        chatRepository: {
            getHistory: async () => [],
            saveHistory: async () => ({ success: true }),
            ...overrides.chatRepository,
        },
        currentSelectedItemRef: { get: () => ({ id: 'visible-agent', type: 'agent' }) },
        currentTopicIdRef: { get: () => 'visible-topic' },
        currentChatHistoryRef: { get: () => [], set() {} },
        viewAuthority: { isCurrent: context => context?.agentId === 'visible-agent' && context?.topicId === 'visible-topic' },
        globalSettingsRef: { get: () => ({ enableSmoothStreaming: false }) },
        chatMessagesDiv: root,
        renderMessage: () => null,
        uiHelper: { scrollToBottom() {} },
        electronAPI: { onDesktopStatus: () => () => {} },
        ...overrides,
    };
    dependencies.transientStreamHistory ||= createDependencies.historyFactory({
        repository: dependencies.chatRepository,
        currentHistory: {
            get: () => dependencies.currentChatHistoryRef.get(),
            replace: history => dependencies.currentChatHistoryRef.set(history),
        },
    });
    return dependencies;
}

function normalizeDiagnostics(projection) {
    const diagnostics = { ...projection.getDiagnostics() };
    diagnostics.activeMessageIds = Array.from(diagnostics.activeMessageIds);
    return diagnostics;
}

const emptyDiagnostics = {
    activeMessageId: null,
    activeMessageIds: [],
    initialization: 0,
    activeInitializations: 0,
    contexts: 0,
    pendingHistory: 0,
    prebuffered: 0,
    pendingFinalizations: 0,
    chunkQueues: 0,
    renderTimers: 0,
    delayedCleanupTimers: 0,
    desktopPushStates: 0,
};

test('two StreamProjection owners isolate identical message identities and teardown listeners', async () => {
    const createStreamProjection = await loadFactory();
    const domA = new JSDOM('<!doctype html><div id="chat"></div>', { url: 'https://a.vcpchat.local/' });
    const domB = new JSDOM('<!doctype html><div id="chat"></div>', { url: 'https://b.vcpchat.local/' });
    const listenerCounts = new Map([[domA.window, { add: 0, remove: 0 }], [domB.window, { add: 0, remove: 0 }]]);
    for (const target of [domA.window, domB.window]) {
        const originalAdd = target.addEventListener.bind(target);
        const originalRemove = target.removeEventListener.bind(target);
        target.addEventListener = (type, listener, options) => {
            if (type === 'beforeunload') listenerCounts.get(target).add += 1;
            return originalAdd(type, listener, options);
        };
        target.removeEventListener = (type, listener, options) => {
            if (type === 'beforeunload') listenerCounts.get(target).remove += 1;
            return originalRemove(type, listener, options);
        };
    }

    const projectionA = createStreamProjection();
    const projectionB = createStreamProjection();
    projectionA.initStreamManager(createDependencies(domA));
    projectionB.initStreamManager(createDependencies(domB));
    projectionA.appendStreamChunk('same-message', { content: 'A' }, { agentId: 'a', topicId: 'topic-a' });
    projectionB.appendStreamChunk('same-message', { content: 'B' }, { agentId: 'b', topicId: 'topic-b' });

    assert.equal(projectionA.getDiagnostics().prebuffered, 1);
    assert.equal(projectionB.getDiagnostics().prebuffered, 1);
    await projectionA.dispose();
    assert.deepEqual(normalizeDiagnostics(projectionA), emptyDiagnostics);
    assert.equal(projectionB.getDiagnostics().prebuffered, 1, 'disposing A must not clear B runtime');
    await projectionB.dispose();
    assert.deepEqual(listenerCounts.get(domA.window), { add: 1, remove: 1 });
    assert.deepEqual(listenerCounts.get(domB.window), { add: 1, remove: 1 });
    domA.window.close();
    domB.window.close();
});

test('disposed StreamProjection rejects initialization and ignores every late stream event', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM('<!doctype html><div id="chat"></div>', { url: 'https://vcpchat.local/' });
    const projection = createStreamProjection();
    const dependencies = createDependencies(dom);
    projection.initStreamManager(dependencies);
    await projection.dispose();

    assert.equal(projection.appendStreamChunk('late', { content: 'late' }, { agentId: 'a', topicId: 't' }), false);
    assert.equal(await projection.startStreamingMessage({ id: 'late', agentId: 'a', topicId: 't' }), null);
    assert.equal(await projection.projectStreamTerminal('late', 'stop', { agentId: 'a', topicId: 't' }), null);
    assert.equal(projection.discardStreamingMessage('late'), false);
    assert.deepEqual(normalizeDiagnostics(projection), emptyDiagnostics);
    assert.throws(() => projection.initStreamManager(dependencies), /disposed/);
    await projection.dispose();
    dom.window.close();
});

test('StreamProjection fails fast when transient history or view authority is missing', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM('<!doctype html><div id="chat"></div>');
    const dependencies = createDependencies(dom);
    delete dependencies.transientStreamHistory;
    assert.throws(() => createStreamProjection().initStreamManager(dependencies), /explicit transient history capability/);

    const withHistory = createDependencies(dom);
    delete withHistory.viewAuthority;
    assert.throws(() => createStreamProjection().initStreamManager(withHistory), /explicit view authority/);
    dom.window.close();
});

test('owned StreamProjection completes terminal DOM projection without a cross-root side channel', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM('<!doctype html><div id="chat"><article class="message-item" data-message-id="owned"><div class="md-content"></div></article></div>', { url: 'https://vcpchat.local/' });
    const history = [];
    let scrollCount = 0;
    const projection = createStreamProjection();
    projection.initStreamManager(createDependencies(dom, {
        currentChatHistoryRef: { get: () => history, set: value => { history.splice(0, history.length, ...value); } },
        uiHelper: { scrollToBottom() { scrollCount += 1; } },
        prepareFinalTextForRender: (_messageId, text, role) => ({ text, role, depth: 0 }),
        renderPostProcessedHtml: async (content, html) => { content.textContent = html; },
    }));

    const messageItem = dom.window.document.querySelector('.message-item');
    await projection.startStreamingMessage({ id: 'owned', agentId: 'visible-agent', topicId: 'visible-topic', content: '' }, messageItem);
    const projected = await projection.projectStreamTerminal(
        'owned',
        'completed',
        { agentId: 'visible-agent', topicId: 'visible-topic' },
        { fullResponse: 'fixture terminal' },
    );

    assert.equal(projected?.content, 'fixture terminal');
    assert.equal(messageItem.classList.contains('streaming'), false);
    assert.match(messageItem.querySelector('.md-content').textContent, /fixture terminal/);
    assert.ok(scrollCount >= 2, 'start and terminal projection should scroll only their owned root capability');
    assert.deepEqual(normalizeDiagnostics(projection), emptyDiagnostics);
    await projection.dispose();
    dom.window.close();
});

test('background initialization failure releases every runtime owner', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM('<!doctype html><div id="chat"></div>', { url: 'https://vcpchat.local/' });
    const previousWindow = global.window;
    global.window = dom.window;
    dom.window.updateSendButtonState = () => {};
    try {
        const projection = createStreamProjection();
        projection.initStreamManager(createDependencies(dom, {
            chatRepository: { getHistory: async () => { throw new Error('controlled history failure'); } },
        }));
        projection.appendStreamChunk('background-message', { content: 'buffered-before-init' }, {
            agentId: 'background-agent',
            topicId: 'background-topic',
        });
        await projection.startStreamingMessage({
            id: 'background-message',
            agentId: 'background-agent',
            topicId: 'background-topic',
            content: '',
        });

        assert.deepEqual(normalizeDiagnostics(projection), emptyDiagnostics);
        await projection.dispose();
    } finally {
        global.window = previousWindow;
        dom.window.close();
    }
});

test('StreamProjection honors an owned view authority and history capability after navigation', async () => {
    const createStreamProjection = await loadFactory();
    const dom = new JSDOM('<!doctype html><div id="chat"></div>', { url: 'https://vcpchat.local/' });
    let currentView = 'visible-topic';
    let history = [];
    let writes = 0;
    const projection = createStreamProjection();
    projection.initStreamManager(createDependencies(dom, {
        currentChatHistoryRef: { get: () => history, set: value => { writes += 1; history = [...value]; } },
        viewAuthority: { isCurrent: context => context?.topicId === currentView },
        renderMessage: async message => {
            const node = dom.window.document.createElement('article');
            node.className = 'message-item';
            node.dataset.messageId = message.id;
            node.innerHTML = '<div class="md-content"></div>';
            dom.window.document.getElementById('chat').appendChild(node);
            return node;
        },
    }));

    const item = { id: 'background', agentId: 'visible-agent', topicId: 'visible-topic', content: '' };
    await projection.startStreamingMessage(item);
    currentView = 'other-topic';
    await projection.projectStreamTerminal('background', 'completed', { agentId: 'visible-agent', topicId: 'visible-topic' }, { fullResponse: 'late terminal' });

    assert.equal(writes, 1, 'history authority should receive the initialization snapshot once');
    assert.deepEqual(history.find(message => message.id === 'background')?.content, '');
    await projection.dispose();
    dom.window.close();
});
