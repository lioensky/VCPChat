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
    textarea
}) {
    function updateStatus(text, type = 'normal') {
        if (store.isDisposed) return;
        // Like the main composer, progress is shown by the send/stop button; only failures get text.
        const shown = type === 'error' ? text : '';
        statusText.textContent = shown;
        statusText.title = shown;
        statusText.className = 'side-chat-status-text' + (type === 'error' ? ' side-chat-status-error' : '');
        onStatusChange?.({ text, type });
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
        sendBtn.disabled = !store.isHistoryLoaded || !store.currentModel;
        sendBtn.title = store.currentModel ? '发送 (Enter)' : '请先选择模型';
        if (!hasText && hasRefs && store.currentDescriptor.contextMode !== 'parent-snapshot') {
            textarea.placeholder = '输入针对引用的问题... (直接回车可发送引用)';
        } else {
            textarea.placeholder = '输入消息... (Enter 发送, Shift+Enter 换行)';
        }
    }

    return Object.freeze({ updateStatus, updateEmptyState, updateComposerState, dispose() {  } });
}
