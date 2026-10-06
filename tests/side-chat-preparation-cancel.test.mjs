import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';
import { createSurfaceConversation } from '../modules/chat/surfaceConversation.js';
import { createStreamConsumerRegistry } from '../modules/chat/streamConsumerRegistry.js';
import { createVcpStreamBridge } from '../modules/chat/vcpStreamBridge.js';
import { createMainChatStreamConsumer } from '../modules/renderer/mainChatStreamConsumer.js';
import { createChatHistoryPersistence } from '../modules/chat/chatHistoryPersistence.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
let fixtureId = 0;

async function fixture(t, { stage = null, error = null, stream = false } = {}) {
    const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true });
    const oldWindow = globalThis.window;
    globalThis.window = dom.window;
    const { chatManager } = await import(`../modules/chatManager.js?side-cancel=${++fixtureId}`);
    const doc = dom.window.document;
    let history = [], gateUsed = false, handle, renderer, conversation, streamedText = '';
    const gate = deferred(), entered = deferred();
    const requests = [], statuses = [];
    const waitStage = async name => {
        if (stage === name && !gateUsed) { gateUsed = true; entered.resolve(); await gate.promise; }
    };
    const repository = {
        async getHistory() { return structuredClone(history); },
        async saveHistory(_id, _type, _topic, messages) {
            if (messages.some(message => message.finishReason)) await waitStage('terminal-save');
            await waitStage('save');
            history = structuredClone(messages);
            return { success: true };
        },
    };
    const descriptor = { id: 'side', model: 'fixture', contextMode: stage === 'snapshot' ? 'parent-snapshot' : 'references-only',
        parent: { itemId: 'agent', topicId: 'parent' }, child: { itemId: 'agent', topicId: 'child', config: { model: 'fixture', streamOutput: stream } } };
    handle = await mountSideChatSurface(doc.getElementById('mount'), { descriptor, onStatusChange: state => statuses.push(state),
        chatCapabilities: { repository, manager: chatManager,
            async refreshParentSnapshot() { await waitStage('snapshot'); return { ok: true, messages: [] }; },
            createRenderer(options) {
                const root = options.root;
                renderer = {
                    async renderHistory(messages) { root.querySelectorAll('.message-item').forEach(node => node.remove()); for (const message of messages) await renderer.renderMessage(message); },
                    async renderMessage(message) {
                        const node = doc.createElement('div'); node.className = 'message-item'; node.dataset.messageId = message.id;
                        node.textContent = message.content; root.append(node); return node;
                    },
                    removeMessageById(id) { root.querySelector(`[data-message-id="${id}"]`)?.remove(); },
                    startStreamingMessage() {},
                    appendStreamChunk(_id, chunk) { streamedText += chunk; },
                    async projectStreamTerminal(id, finishReason, context, payload) {
                        const messages = conversation.historyRef.get().map(message => message.id === id
                            ? { ...message, content: payload.fullResponse, finishReason, isThinking: false } : message);
                        conversation.historyRef.set(messages);
                        await renderer.renderHistory(messages);
                        return { messageId: id, context, history: messages, content: payload.fullResponse, finishReason };
                    },
                };
                conversation = createSurfaceConversation(options.conversation);
                return { renderer, conversation, dispose() { conversation.dispose(); } };
            },
        },
    });
    const routes = createStreamConsumerRegistry(), persistence = createChatHistoryPersistence(repository);
    const bridge = createVcpStreamBridge({ createConsumer: event => createMainChatStreamConsumer(event, {
        resolveProjection: id => routes.claim(id), persistTerminal: projected => persistence.commit(projected),
    }) });
    chatManager.init({ chatRepository: repository,
        streamConsumerRegistry: { register(id, route) {
            const release = routes.register(id, route);
            release.cancel = reason => bridge.cancelOperation(id, reason);
            return release;
        } },
        electronAPI: {
            async getLatestCanvasContent() { await waitStage('prepare'); return { content: 'canvas' }; },
            async sendToVCP(...args) {
                requests.push(args);
                if (stage === 'transport') {
                    await waitStage('transport');
                    return { streamError: true, error: 'request locally aborted' };
                }
                if (stream) { bridge.accept({ type: 'data', messageId: args[4], context: args[6], chunk: 'retained partial answer' }); return { streamingStarted: true }; }
                return error ? { error } : { choices: [{ message: { content: 'answer' } }] };
            },
        },
        uiHelper: { showToastNotification() {}, autoResizeTextarea() {} },
        modules: { messageRenderer: renderer },
        refs: { currentSelectedItemRef: { get: () => null }, currentTopicIdRef: { get: () => null }, currentChatHistoryRef: { get: () => [], set() {} },
            attachedFilesRef: { get: () => [] }, globalSettingsRef: { get: () => ({ vcpServerUrl: 'http://fixture.invalid/v1/chat/completions' }) } },
        elements: {}, mainRendererFunctions: {},
    });
    t.after(async () => { gate.resolve(); await handle.dispose(); await chatManager.dispose(); await bridge.dispose(); routes.dispose(); dom.window.close(); globalThis.window = oldWindow; });
    await tick();
    const textarea = doc.querySelector('.side-chat-textarea'), form = doc.querySelector('form');
    const untilIdle = async () => { for (let n = 0; n < 100; n++) { await tick(); if (!form.hasAttribute('aria-busy')) return; } throw new Error('Side composer did not settle'); };
    return { doc, handle, requests, statuses, gate, entered, textarea, form, untilIdle,
        getHistory: () => history,
        getStreamedText: () => streamedText,
        submit(text) { textarea.value = text; form.requestSubmit(); },
        stop() { doc.querySelector('.side-chat-stop-btn').click(); },
    };
}

test('stopping while auxiliary history is saving prevents a later generation request', async t => {
    const f = await fixture(t, { stage: 'save' });
    f.submit('cancel while saving');
    await f.entered.promise;
    assert.equal(f.form.getAttribute('aria-busy'), 'true');
    f.stop(); f.stop();
    f.gate.resolve();
    await f.untilIdle();
    assert.equal(f.requests.length, 0, 'a cancelled preparation must never reach sendToVCP');
    assert.deepEqual(f.getHistory().map(message => [message.role, message.content]), [['user', 'cancel while saving']]);
    assert.equal(f.doc.querySelector('.side-chat-stop-btn').hidden, true);
    assert.equal(f.doc.querySelector('.side-chat-send-btn').hidden, false);
    assert.equal(f.statuses.at(-1).text, '已取消');
});

test('stopping during parent snapshot refresh preserves the unsent auxiliary draft and reference', async t => {
    const f = await fixture(t, { stage: 'snapshot' });
    f.handle.addReference({ id: 'reference', text: 'quoted text', sourceMessageId: 'source' });
    f.submit('unsent question');
    await f.entered.promise;
    f.stop(); f.gate.resolve();
    await f.untilIdle();
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.getHistory(), []);
    assert.equal(f.textarea.value, 'unsent question');
    assert.deepEqual(f.handle.getReferences().map(reference => reference.id), ['reference']);
    assert.equal(f.statuses.at(-1).text, '已取消');
});

test('stopping during request context preparation prevents generation and retains the submitted question', async t => {
    const f = await fixture(t, { stage: 'prepare' });
    f.submit('question {{VCPChatCanvas}}');
    await f.entered.promise;
    f.stop(); f.gate.resolve();
    await f.untilIdle();
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.getHistory().map(message => [message.role, message.content]), [['user', 'question {{VCPChatCanvas}}']]);
    assert.equal(f.statuses.at(-1).text, '已取消');
});

test('a failed upstream interrupt waits for local terminal persistence and retains the partial auxiliary answer', async t => {
    const f = await fixture(t, { stream: true, stage: 'terminal-save' });
    f.submit('question with partial answer');
    for (let n = 0; n < 100 && !f.getStreamedText(); n++) await tick();
    assert.equal(f.getStreamedText(), 'retained partial answer');
    f.stop();
    await f.entered.promise;
    assert.equal(f.form.getAttribute('aria-busy'), 'true', 'local cancellation must wait for accepted content to be saved');
    f.gate.resolve(); await f.untilIdle();
    assert.deepEqual(f.getHistory().map(message => message.content), ['question with partial answer', 'retained partial answer']);
    assert.equal(f.getHistory()[1].finishReason, 'cancelled');
    assert.match(f.doc.getElementById('mount').textContent, /retained partial answer/);
    assert.equal(f.statuses.at(-1).text, '已取消');
});

test('stopping before the first HTTP response settles as cancellation rather than a service error', async t => {
    const f = await fixture(t, { stream: true, stage: 'transport' });
    f.submit('stop while waiting for response');
    await f.entered.promise;
    f.stop(); f.gate.resolve();
    await f.untilIdle();
    assert.equal(f.statuses.at(-1).text, '已取消');
    assert.equal(f.doc.querySelector('.side-chat-status-error'), null);
    assert.deepEqual(f.getHistory().map(message => message.content), ['stop while waiting for response']);
    assert.doesNotMatch(f.doc.getElementById('mount').textContent, /发送失败|请求流式回复失败/);
});

test('a service error exits auxiliary busy state and is shown as an error', async t => {
    const f = await fixture(t, { error: '502 fixture service unavailable' });
    f.submit('a retained question');
    await f.untilIdle();
    assert.equal(f.requests.length, 1);
    assert.match(f.doc.querySelector('.side-chat-status-error').textContent, /502 fixture service unavailable/);
    assert.equal(f.doc.querySelector('.side-chat-stop-btn').hidden, true);
    assert.equal(f.textarea.disabled, false);
    assert.deepEqual(f.getHistory().map(message => message.content), ['a retained question']);
});
