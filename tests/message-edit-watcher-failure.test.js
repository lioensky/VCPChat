'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/renderer/messageContextMenu.js', 'utf8');

test('a watcher restart failure cannot roll back a durably saved message edit', async () => {
    const dom = new JSDOM(`<!doctype html><div class="message-item">
        <div class="md-content">old content</div>
    </div>`, { runScripts: 'outside-only', url: 'https://vcpchat.local/' });
    const executableSource = source
        .replace('export function createMessageContextMenu()', 'function createMessageContextMenu()')
        .concat('\nwindow.__messageEditTestApi = createMessageContextMenu();\n');
    dom.window.eval(executableSource);

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
        markedInstance: { parse: value => value },
        uiHelper: {
            autoResizeTextarea() {},
            showToastNotification(messageText, type) { toasts.push({ message: messageText, type }); },
        },
        currentChatHistoryRef: { get: () => history, set: next => { history = [...next]; } },
        currentSelectedItemRef: {
            get: () => ({ id: 'agent-1', type: 'agent', config: { agentDataPath: '/fixture/agent-1' } }),
        },
        currentTopicIdRef: { get: () => 'topic-1' },
        historyMutationAuthority: {
            mutate: async (_descriptor, mutator) => {
                const nextHistory = mutator(history.map(entry => ({ ...entry })));
                durableWrites.push(JSON.parse(JSON.stringify(nextHistory)));
                return { result: { success: true }, history: nextHistory };
            },
        },
    }, {
        updateMessageContent(_messageId, content) { renderedContent = content; },
    });

    const messageItem = dom.window.document.querySelector('.message-item');
    dom.window.__messageEditTestApi.toggleEditMode(messageItem, message);
    const textarea = messageItem.querySelector('.message-edit-textarea');
    textarea.value = 'new durable content';
    messageItem.querySelector('.message-edit-controls button').click();

    const deadline = Date.now() + 1_000;
    while (messageItem.classList.contains('message-item-editing') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }

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
    const dom = new JSDOM(`<!doctype html><div class="message-item">
        <div class="md-content">target content</div>
    </div>`, { runScripts: 'outside-only', url: 'https://vcpchat.local/' });
    const executableSource = source
        .replace('export function createMessageContextMenu()', 'function createMessageContextMenu()')
        .concat('\nwindow.__messageEditTestApi = createMessageContextMenu();\n');
    dom.window.eval(executableSource);

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
        currentChatHistoryRef: {
            get: () => history,
            set: next => { history = [...next]; },
        },
        currentSelectedItemRef: {
            get: () => ({ id: 'group-1', type: 'group', config: {} }),
        },
        currentTopicIdRef: { get: () => 'topic-1' },
        historyMutationAuthority: {
            mutate: async (_descriptor, mutator) => {
                const nextHistory = mutator(history.map(entry => ({ ...entry })));
                durableWrites.push(JSON.parse(JSON.stringify(nextHistory)));
                history = [...nextHistory];
                return { result: { success: true }, history: nextHistory };
            },
        },
    }, {
        updateMessageContent(_messageId, content) { renderedContent = content; },
    });

    const messageItem = dom.window.document.querySelector('.message-item');
    dom.window.__messageEditTestApi.toggleEditMode(messageItem, staleMenuMessage);
    const textarea = messageItem.querySelector('.message-edit-textarea');
    textarea.value = 'edited after deletion';

    // 模拟删除另一条消息：状态管理器发布一个全新的历史数组和全新的目标对象。
    history = history
        .filter(entry => entry.id !== 'deleted-before-save')
        .map(entry => ({ ...entry }));

    messageItem.querySelector('.message-edit-controls button').click();

    const deadline = Date.now() + 1_000;
    while (messageItem.classList.contains('message-item-editing') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.equal(durableWrites.length, 1);
    assert.deepEqual(durableWrites[0].map(entry => entry.id), ['edit-target']);
    assert.equal(history[0].content, 'edited after deletion');
    assert.equal(renderedContent, 'edited after deletion');
    assert.equal(messageItem.classList.contains('message-item-editing'), false);
    assert.ok(toasts.some(toast => toast.type === 'success'));
    assert.equal(toasts.some(toast => toast.type === 'error' || toast.type === 'warning'), false);
    dom.window.close();
});
