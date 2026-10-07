/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

export function createSideChatComposerState({
    store,
    onStatusChange,
    root,
    sendBtn,
    statusText,
    textarea,
    toolButtons = []
}) {
    // code：给调用方/测试的机器可读状态（如 'cancelled'），与文案无关
    function updateStatus(text, type = 'normal', code = null) {
        if (store.isDisposed) return;
        // Like the main composer, progress is shown by the send/stop button; only failures get text.
        const shown = type === 'error' ? text : '';
        statusText.textContent = shown;
        statusText.title = shown;
        statusText.className = 'side-chat-status-text' + (type === 'error' ? ' side-chat-status-error' : '');
        statusText.dataset.statusType = type;
        if (code) statusText.dataset.statusCode = code;
        else delete statusText.dataset.statusCode;
        onStatusChange?.({ text, type, code });
    }

    function updateEmptyState() {
        if (!root) return;
        const emptyState = root.querySelector('.side-chat-empty-state');
        if (!emptyState) return;
        const messageItems = root.querySelectorAll('.message-item');
        emptyState.hidden = messageItems.length > 0;
    }

    function updateComposerState() {
        if (store.isDisposed) return;
        const hasText = Boolean(textarea.value.trim());
        const hasRefs = store.references.length > 0;
        sendBtn.disabled = !store.isHistoryLoaded || !store.currentModel || store.isDeletingMessage;
        for (const button of toolButtons) {
            if (button) button.disabled = !store.isHistoryLoaded || textarea.disabled;
        }
        sendBtn.title = store.isDeletingMessage ? '正在保存删除' : (store.currentModel ? '发送 (Enter)' : '请先选择模型');
        if (!hasText && hasRefs && store.currentDescriptor.contextMode !== 'parent-snapshot') {
            textarea.placeholder = '输入针对引用的问题... (直接回车可发送引用)';
        } else {
            textarea.placeholder = '输入消息... (Enter 发送, Shift+Enter 换行)';
        }
    }

    return Object.freeze({ updateStatus, updateEmptyState, updateComposerState, dispose() {  } });
}
