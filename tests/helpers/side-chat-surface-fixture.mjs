// 侧栏辅助对话的完整挂载夹具：真实的 chatManager、流式桥和历史持久化，仓库、发送和保存结果由测试注入
import { JSDOM } from 'jsdom';
const R = '../../modules';
const { mountSideChatSurface } = await import(`${R}/renderer/sideChatSurfaceOwner.js`);
const { createSurfaceConversation } = await import(`${R}/chat/surfaceConversation.js`);
const { createStreamConsumerRegistry } = await import(`${R}/chat/streamConsumerRegistry.js`);
const { createVcpStreamBridge } = await import(`${R}/chat/vcpStreamBridge.js`);
const { createMainChatStreamConsumer } = await import(`${R}/renderer/mainChatStreamConsumer.js`);
const { createChatHistoryPersistence } = await import(`${R}/chat/chatHistoryPersistence.js`);

export const tick = () => new Promise(resolve => setImmediate(resolve));
let fixtureId = 0;

export async function fixture(t, { stream = false, seed = [], onSave = null, onSend = null, model = 'fixture', toasts = [] } = {}) {
    const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
    const oldWindow = globalThis.window;
    globalThis.window = dom.window;
    const { chatManager } = await import(`${R}/chatManager.js?probe=${++fixtureId}`);
    const doc = dom.window.document;
    let history = structuredClone(seed), handle, renderer, conversation;
    const requests = [], statuses = [], saves = [];
    const repository = {
        async getHistory() { return structuredClone(history); },
        async saveHistory(_id, _type, topic, messages) {
            saves.push({ topic, messages: structuredClone(messages) });
            const r = onSave ? await onSave(messages, saves.length) : null;
            if (r) return r;
            history = structuredClone(messages);
            return { success: true };
        },
    };
    const descriptor = { id: 'side', model, contextMode: 'references-only',
        parent: { itemId: 'agent', topicId: 'parent' }, child: { itemId: 'agent', topicId: 'child', config: { model, streamOutput: stream } } };
    const bridgeHolder = {};
    handle = await mountSideChatSurface(doc.getElementById('mount'), { descriptor, onStatusChange: s => statuses.push(s),
        chatCapabilities: { repository, manager: chatManager, listModels: async () => ({ ids: ['gpt-x'], favorites: new Set() }),
            uiHelper: { showToastNotification: (m, ty) => toasts.push([m, ty]) },
            createRenderer(options) {
                const root = options.root;
                renderer = {
                    async renderHistory(messages) { root.querySelectorAll('.message-item').forEach(n => n.remove()); for (const m of messages) await renderer.renderMessage(m); },
                    async renderMessage(message) {
                        const node = doc.createElement('div'); node.className = 'message-item'; node.dataset.messageId = message.id;
                        node.textContent = message.content; root.append(node); return node;
                    },
                    removeMessageById(id) { root.querySelector(`[data-message-id="${id}"]`)?.remove(); },
                    startStreamingMessage() {},
                    appendStreamChunk() {},
                    async projectStreamTerminal(id, finishReason, context, payload) {
                        const messages = conversation.historyRef.get().map(m => m.id === id
                            ? { ...m, content: payload.fullResponse, finishReason, isThinking: false } : m);
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
    bridgeHolder.bridge = bridge;
    chatManager.init({ chatRepository: repository,
        streamConsumerRegistry: { register(id, route) {
            const release = routes.register(id, route);
            release.cancel = reason => bridge.cancelOperation(id, reason);
            return release;
        } },
        electronAPI: {
            async getLatestCanvasContent() { return { content: '' }; },
            async sendToVCP(...args) {
                requests.push(args);
                if (onSend) { const r = await onSend(args, bridge); if (r) return r; }
                if (stream) { bridge.accept({ type: 'data', messageId: args[4], context: args[6], chunk: 'partial' }); return { streamingStarted: true }; }
                return { choices: [{ message: { content: 'answer' } }] };
            },
        },
        uiHelper: { showToastNotification: (m, ty) => toasts.push([m, ty]), autoResizeTextarea() {} },
        modules: { messageRenderer: renderer },
        refs: { currentSelectedItemRef: { get: () => null }, currentTopicIdRef: { get: () => null }, currentChatHistoryRef: { get: () => [], set() {} },
            attachedFilesRef: { get: () => [] }, globalSettingsRef: { get: () => ({ vcpServerUrl: 'http://fixture.invalid/v1/chat/completions' }) } },
        elements: {}, mainRendererFunctions: {},
    });
    t.after(async () => { try { await handle.dispose(); } catch {} await chatManager.dispose(); await bridge.dispose(); routes.dispose(); dom.window.close(); globalThis.window = oldWindow; });
    for (let i = 0; i < 5; i++) await tick();
    const textarea = doc.querySelector('.side-chat-textarea'), form = doc.querySelector('form');
    const untilIdle = async () => { for (let n = 0; n < 200; n++) { await tick(); if (!form.hasAttribute('aria-busy')) return; } throw new Error('Side composer did not settle'); };
    return { dom, doc, handle, requests, statuses, saves, toasts, textarea, form, untilIdle, bridge,
        getHistory: () => history, getConversation: () => conversation,
        submit(text) { textarea.value = text; form.requestSubmit(); },
        stop() { doc.querySelector('.side-chat-stop-btn').click(); },
        statusText: () => doc.querySelector('.side-chat-status-text').textContent,
        badgeHidden: () => doc.querySelector('.side-chat-persistence-badge')?.hidden,
    };
}
