const INTERRUPT_BUTTON_HTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="1"></rect>
    </svg>
`;

/** Owns main-chat send/interrupt policy and its button projection. */
export function createMainChatSendOwner({
    button,
    messagesRoot,
    historyRef,
    selectedItemRef,
    topicIdRef,
    streamProjection,
    chatAPI,
    interruptHandler,
    getAdapter,
    getChatManager,
    messageRenderer,
    notify,
}) {
    const defaultButtonHtml = button?.innerHTML || '';
    let disposed = false;

    const isContextCurrent = context => {
        const selected = selectedItemRef.get();
        const topicId = topicIdRef.get();
        if (!context || !selected?.id || !topicId) return false;
        return (context.groupId || context.agentId) === selected.id && context.topicId === topicId;
    };

    const getInterruptibleMessage = () => {
        const history = historyRef.get();
        for (let index = history.length - 1; index >= 0; index--) {
            const message = history[index];
            if (!message || message.role !== 'assistant') continue;
            const item = messagesRoot?.querySelector(`.message-item[data-message-id="${message.id}"]`);
            const isStreaming = Boolean(item?.classList.contains('streaming'));
            if ((item?.isConnected && message.isThinking === true) || isStreaming) {
                return { ...message, isStreaming };
            }
        }

        const messageId = streamProjection?.getActiveStreamingMessageId?.();
        const context = streamProjection?.getActiveStreamingContext?.();
        if (!messageId || !isContextCurrent(context)) return null;
        const existing = history.find(message => message?.id === messageId && message.role === 'assistant');
        if (existing) return { ...existing, isStreaming: true };
        const selected = selectedItemRef.get();
        return {
            id: messageId,
            role: 'assistant',
            name: context.agentName || selected?.name || selected?.id,
            agentId: context.agentId,
            groupId: context.groupId,
            isGroupMessage: context.isGroupMessage === true,
            avatarUrl: context.avatarUrl || selected?.avatarUrl,
            avatarColor: context.avatarColor || selected?.config?.avatarCalculatedColor,
            isStreaming: true,
        };
    };

    const update = () => {
        if (disposed || !button) return false;
        const mode = getInterruptibleMessage() ? 'interrupt' : 'send';
        button.dataset.mode = mode;
        button.classList.toggle('interrupt-mode', mode === 'interrupt');
        // The send control is the main-chat composer status surface. Keep its
        // busy state synchronized with the same interruptible-stream decision
        // used for the command projection so assistive technology observes
        // the operation without relying on CSS classes or button labels.
        button.setAttribute('aria-busy', String(mode === 'interrupt'));
        button.innerHTML = mode === 'interrupt' ? INTERRUPT_BUTTON_HTML : defaultButtonHtml;
        button.title = mode === 'interrupt' ? '中止回复' : '发送消息/右键高级回复';
        button.setAttribute('aria-label', mode === 'interrupt' ? '中止回复' : '发送消息');
        return true;
    };

    const interrupt = async () => {
        const activeMessage = getInterruptibleMessage();
        if (!activeMessage || disposed) return false;
        const selected = selectedItemRef.get();
        const isGroup = activeMessage.isGroupMessage === true || selected?.type === 'group';
        let result = { success: false, error: '无法发送中止请求。' };
        if (isGroup) {
            result = typeof chatAPI?.interruptGroupRequest === 'function'
                ? await chatAPI.interruptGroupRequest(activeMessage.id)
                : { success: false, error: '群聊中止接口不可用。' };
        } else if (typeof interruptHandler?.interrupt === 'function') {
            result = await interruptHandler.interrupt(activeMessage.id);
        }
        if (disposed) return false;
        if (result.success) {
            notify?.('已发送中止信号。', 'success');
            return true;
        }

        const localOutcome = await getAdapter()?.cancelStream?.(
            activeMessage.id,
            result.error || 'interrupt-request-failed'
        );
        if (disposed) return false;
        if (!localOutcome) {
            streamProjection?.discardStreamingMessage?.(activeMessage.id);
            historyRef.set(historyRef.get().filter(message => message?.id !== activeMessage.id));
            messageRenderer?.removeMessageById?.(activeMessage.id, false);
        }
        update();
        notify?.(`中止失败：${result.error || '未知错误'}，已在本地停止。`, 'error');
        return true;
    };

    return Object.freeze({
        getInterruptibleMessage,
        update,
        interrupt,
        async handleAction() {
            if (disposed) return false;
            if (getInterruptibleMessage()) return interrupt();
            await getChatManager()?.handleSendMessage?.();
            return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
        },
    });
}
