import { register } from './next-ui-apps.js';
import { createChatSurface } from '../chat/chatSurface.js';
import { createChatOperations } from '../chat/chatOperation.js';

function mountInteractiveChat(container, context = {}) {
    const repository = context.chat?.repository;
    const chatSnapshot = context.chat?.getSnapshot?.() || null;
    const createRenderer = context.chat?.createRenderer;
    const chatManager = context.chat?.manager;
    const scope = context.scope?.child?.('next:interactive-chat') || null;
    container.innerHTML = `<section class="vcp-standalone-chat vcp-interactive-chat" aria-label="独立聊天"><header><div><h1>独立聊天</h1><p class="vcp-standalone-chat__status">当前话题</p></div></header><div class="vcp-standalone-chat__messages" tabindex="-1" aria-label="聊天消息"></div><form class="vcp-interactive-chat__composer"><textarea aria-label="消息内容" rows="2"></textarea><button type="submit">发送</button><button type="button" data-action="cancel">取消</button><p role="status" aria-live="polite"></p></form></section>`;
    const root = container.querySelector('.vcp-standalone-chat__messages');
    const form = container.querySelector('form');
    const input = form.querySelector('textarea');
    const status = form.querySelector('[role="status"]');
    let activeOperation = null;
    let operationReady = Promise.resolve(null);
    let publishOperation = null;
    let submitInteractiveContent = null;
    if (!repository || typeof createRenderer !== 'function' || !chatSnapshot || !chatManager) {
        container.querySelector('[role="status"]').textContent = '聊天能力尚未就绪';
        return async () => { scope?.dispose?.('interactive-chat-unavailable'); container.replaceChildren(); };
    }
    const rendererOwner = createRenderer({
        root,
        mode: 'interactive',
        handleSendMessage: text => submitInteractiveContent?.(text),
    });
    const renderer = rendererOwner.renderer;
    const operations = createChatOperations({
        send: async request => {
            operationReady = new Promise(resolve => { publishOperation = resolve; });
            try {
                return await chatManager.sendMessage({
                    ...request,
                    awaitTerminal: true,
                    onOperation(operation) {
                        activeOperation = operation;
                        publishOperation?.(operation);
                        publishOperation = null;
                    },
                });
            } finally {
                publishOperation?.(null);
                publishOperation = null;
                activeOperation = null;
            }
        },
        cancel: async () => {
            const operation = activeOperation || await operationReady;
            return operation?.cancel?.('interactive-user-cancel') || false;
        }
    });
    const surface = createChatSurface({ root, renderer, repository, focusTarget: input, mode: 'interactive', operations, disposeRenderer: () => rendererOwner.dispose() });
    const onSubmit = async event => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content) return;
        form.setAttribute('aria-busy', 'true');
        input.disabled = true;
        try {
            const result = await surface.sendMessage({ content, attachments: [], input, domRenderer: surface.renderer, propagateError: true });
            input.value = '';
            const terminalType = result?.terminal?.event?.type;
            if (terminalType === 'cancelled' || terminalType === 'discarded') status.textContent = '已取消';
            else if (terminalType === 'failed') {
                const error = result.terminal.event.outcome?.transport?.error
                    || result.terminal.event.outcome?.persistence?.error
                    || '流式连接中断';
                status.textContent = `发送失败：${error?.message || error}`;
            } else status.textContent = '已发送';
        } catch (error) {
            status.textContent = `发送失败：${error.message}`;
        } finally {
            form.removeAttribute('aria-busy');
            input.disabled = false;
            input.focus();
        }
    };
    submitInteractiveContent = text => {
        input.value = String(text || '');
        form.requestSubmit();
    };
    const onCancel = async () => {
        const cancelled = await surface.cancelMessage();
        if (cancelled) status.textContent = '已取消';
    };
    form.addEventListener('submit', onSubmit);
    form.querySelector('[data-action="cancel"]').addEventListener('click', onCancel);
    const load = chatSnapshot.selectedItem?.id && chatSnapshot.topicId
        ? surface.loadHistory(chatSnapshot.selectedItem.id, chatSnapshot.selectedItem.type, chatSnapshot.topicId, { initialBatch: 5, batchSize: 10, batchDelay: 80 })
        : Promise.resolve({ stale: false, history: [] });
    load.catch(error => { status.textContent = `加载失败：${error.message}`; });
    return async () => { submitInteractiveContent = null; form.removeEventListener('submit', onSubmit); form.querySelector('[data-action="cancel"]').removeEventListener('click', onCancel); await surface.dispose(); scope?.dispose?.('interactive-chat-unmounted'); container.replaceChildren(); };
}

register({ id: 'standalone-chat-compose', title: '独立聊天', icon: 'message-circle', kind: 'internal', mount: mountInteractiveChat });
