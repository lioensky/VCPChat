'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/renderer/messageContextMenu.js', 'utf8');

async function setupContextMenuDom(html) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://vcpchat.local/' });
    Object.assign(dom.window, await import('../modules/chat/contextCompactionState.js'));
    const executableSource = source
        .replace(/^import .*contextCompactionState\.js';\s*/m, '')
        .replace('export function createMessageContextMenu()', 'function createMessageContextMenu()')
        .concat('\nwindow.__messageEditTestApi = createMessageContextMenu();\n');
    dom.window.eval(executableSource);
    return dom;
}

test('a watcher restart failure cannot roll back a durably saved message edit', async () => {
    const dom = await setupContextMenuDom(`<!doctype html><div class="message-item">
        <div class="md-content">old content</div>
    </div>`);

    let history = [{ id: 'message-1', role: 'assistant', content: 'old content' }];
    const message = history[0];
    const durableWrites = [];
    const toasts = [];
    let watcherRestarts = 0;
    let renderedContent = null;
    dom.window.__messageEditTestApi.initializeContextMenu({
        electronAPI: {
            watcherBegin: async () => ({ success: true, token: 'edit-lease' }),
            watcherStart: async () => {
                watcherRestarts += 1;
                throw new Error('controlled watcher restart failure');
            },
        },
        chatRepository: {
            saveHistory: async (_itemId, _type, _topicId, nextHistory) => {
                durableWrites.push(JSON.parse(JSON.stringify(nextHistory)));
                return { success: true };
            },
        },
        historyMutationAuthority: {
            mutate: async (_target, mutator) => {
                const nextHistory = mutator(history);
                history = nextHistory;
                durableWrites.push(JSON.parse(JSON.stringify(nextHistory)));
                return {
                    history: nextHistory,
                    mutatedMessage: nextHistory.find(m => m.id === message.id)
                };
            }
        },
        markedInstance: { parse: value => value },
        uiHelper: {
            autoResizeTextarea() {},
            showToastNotification(messageText, type) {
                toasts.push({ message: messageText, type });
            },
        },
        currentChatHistoryRef: {
            get: () => history,
            set: next => { history = [...next]; },
        },
        currentSelectedItemRef: {
            get: () => ({ id: 'group-1', type: 'group', config: { agentDataPath: 'C:\\dummy' } }),
        },
        currentTopicIdRef: { get: () => 'topic-1' },
    }, {
        updateMessageContent: (id, text) => {
            renderedContent = text;
        },
    });

    const messageItem = dom.window.document.querySelector('.message-item');
    dom.window.__messageEditTestApi.toggleEditMode(messageItem, message);
    assert.equal(messageItem.classList.contains('message-item-editing'), true);

    const textarea = messageItem.querySelector('.message-edit-textarea');
    textarea.value = 'new durable content';

    const saveButton = messageItem.querySelector('.message-edit-controls button');
    await saveButton.onclick();

    assert.equal(watcherRestarts, 1);
    assert.equal(durableWrites.length, 1);
    assert.equal(durableWrites[0][0].content, 'new durable content');
    assert.equal(history[0].content, 'new durable content');
    assert.equal(message.content, 'new durable content');
    assert.equal(renderedContent, 'new durable content');
    assert.equal(messageItem.classList.contains('message-item-editing'), false);
    assert.ok(toasts.some(toast => toast.type === 'success'));
    assert.equal(toasts.some(toast => toast.type === 'error'), false);
    dom.window.close();
});

test('editing survives deletion of another message and replacement of the history array', async () => {
    const dom = await setupContextMenuDom(`<!doctype html><div class="message-item">
        <div class="md-content">target content</div>
    </div>`);

    let history = [
        { id: 'deleted-before-save', role: 'assistant', content: 'remove me' },
        { id: 'edit-target', role: 'user', content: 'target content' },
    ];
    const staleMenuMessage = history[1];
    const durableWrites = [];
    const toasts = [];
    let renderedContent = null;

    dom.window.__messageEditTestApi.initializeContextMenu({
        electronAPI: {},
        markedInstance: { parse: value => value },
        uiHelper: {
            autoResizeTextarea() {},
            showToastNotification(messageText, type) { toasts.push({ message: messageText, type }); },
        },
        historyMutationAuthority: {
            mutate: async (_target, mutator) => {
                const nextHistory = mutator(history);
                history = nextHistory;
                durableWrites.push(JSON.parse(JSON.stringify(nextHistory)));
                return {
                    history: nextHistory,
                    mutatedMessage: nextHistory.find(m => m.id === staleMenuMessage.id)
                };
            }
        },
        currentChatHistoryRef: {
            get: () => history,
            set: next => { history = [...next]; },
        },
        currentSelectedItemRef: {
            get: () => ({ id: 'group-1', type: 'group', config: {} }),
        },
        currentTopicIdRef: { get: () => 'topic-1' },
        chatRepository: {
            saveHistory: async (_itemId, _type, _topicId, nextHistory) => {
                durableWrites.push(JSON.parse(JSON.stringify(nextHistory)));
                return { success: true };
            },
        },
    }, {
        updateMessageContent: (id, text) => {
            renderedContent = text;
        },
    });

    const messageItem = dom.window.document.querySelector('.message-item');
    dom.window.__messageEditTestApi.toggleEditMode(messageItem, staleMenuMessage);

    // Simulate an external action (like a stream deletion or sync) replacing the history array
    history = [
        { id: 'edit-target', role: 'user', content: 'target content' },
    ];

    const textarea = messageItem.querySelector('.message-edit-textarea');
    textarea.value = 'updated target content';

    const saveButton = messageItem.querySelector('.message-edit-controls button');
    await saveButton.onclick();

    assert.equal(durableWrites.length, 1);
    assert.equal(durableWrites[0].length, 1);
    assert.equal(durableWrites[0][0].id, 'edit-target');
    assert.equal(durableWrites[0][0].content, 'updated target content');
    assert.equal(history[0].content, 'updated target content');
    assert.equal(staleMenuMessage.content, 'updated target content');
    assert.equal(renderedContent, 'updated target content');
    assert.equal(messageItem.classList.contains('message-item-editing'), false);
    assert.ok(toasts.some(toast => toast.type === 'success'));
    assert.equal(toasts.some(toast => toast.type === 'error' || toast.type === 'warning'), false);
    dom.window.close();
});

test('a visible edited bubble is restored when a concurrent history snapshot temporarily omits it', async () => {
    const dom = await setupContextMenuDom(`<!doctype html><div id="chatMessages">
        <div class="message-item" data-message-id="before"><div class="md-content">before</div></div>
        <div class="message-item" data-message-id="edit-target"><div class="md-content">target content</div></div>
        <div class="message-item" data-message-id="after"><div class="md-content">after</div></div>
    </div>`);

    const staleBubbleMessage = {
        id: 'edit-target',
        role: 'user',
        content: 'target content',
        timestamp: 2,
    };
    let history = [
        { id: 'before', role: 'assistant', content: 'before', timestamp: 1 },
        { id: 'after', role: 'assistant', content: 'after', timestamp: 3 },
    ];
    let committedHistory = null;
    const toasts = [];
    const chatMessagesDiv = dom.window.document.getElementById('chatMessages');

    dom.window.__messageEditTestApi.initializeContextMenu({
        chatMessagesDiv,
        electronAPI: {},
        markedInstance: { parse: value => value },
        uiHelper: {
            autoResizeTextarea() {},
            showToastNotification(messageText, type) { toasts.push({ message: messageText, type }); },
        },
        historyMutationAuthority: {
            mutate: async (_target, mutator) => {
                const nextHistory = mutator(history);
                history = nextHistory;
                committedHistory = JSON.parse(JSON.stringify(nextHistory));
                return {
                    history: nextHistory,
                    mutatedMessage: nextHistory.find(m => m.id === staleBubbleMessage.id)
                };
            }
        },
        currentChatHistoryRef: {
            get: () => history,
            set: next => { history = [...next]; },
        },
        currentSelectedItemRef: {
            get: () => ({ id: 'group-1', type: 'group', config: {} }),
        },
        currentTopicIdRef: { get: () => 'topic-1' },
        chatRepository: {
            saveHistory: async (_itemId, _type, _topicId, nextHistory) => {
                committedHistory = JSON.parse(JSON.stringify(nextHistory));
                return { success: true };
            },
        },
    }, {
        updateMessageContent: (id, text) => {
            const contentDiv = dom.window.document.querySelector('.message-item[data-message-id="edit-target"] .md-content');
            if (contentDiv) contentDiv.textContent = text;
        },
    });

    const targetItem = dom.window.document.querySelector('.message-item[data-message-id="edit-target"]');
    dom.window.__messageEditTestApi.toggleEditMode(targetItem, staleBubbleMessage);

    const textarea = targetItem.querySelector('.message-edit-textarea');
    textarea.value = 'restored concurrent target content';

    const saveButton = targetItem.querySelector('.message-edit-controls button');
    await saveButton.onclick();

    assert.ok(committedHistory, 'history must be saved');
    assert.equal(committedHistory.length, 3);
    assert.deepEqual(committedHistory.map(entry => entry.id), ['before', 'edit-target', 'after']);
    assert.equal(committedHistory[1].content, 'restored concurrent target content');
    assert.equal(history.length, 3);
    assert.deepEqual(history.map(entry => entry.id), ['before', 'edit-target', 'after']);
    assert.equal(history[1].content, 'restored concurrent target content');

    const editedBubble = dom.window.document.querySelector('.message-item[data-message-id="edit-target"]');
    assert.ok(editedBubble, 'edited bubble must be present in DOM');
    assert.equal(editedBubble.classList.contains('message-item-editing'), false);
    assert.equal(editedBubble.querySelector('.md-content').textContent, 'restored concurrent target content');
    assert.ok(toasts.some(toast => toast.type === 'success'));
    assert.equal(toasts.some(toast => toast.type === 'error' || toast.type === 'warning'), false);
    dom.window.close();
});