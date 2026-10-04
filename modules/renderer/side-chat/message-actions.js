/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

export function createSideChatMessageActions({
    store,
    chatCapabilities,
    descriptor,
    doc,
    root,
    updateEmptyState,
    pinToBottomIfSticky
}) {
    function extractTextFromContentDiv(contentDiv) {
        if (!contentDiv) return '';
        const clone = contentDiv.cloneNode(true);
        clone.querySelectorAll?.(
            '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, .message-attachments, .message-attachment-remove-btn, .side-chat-message-actions, style, script'
        )?.forEach?.(el => el.remove());
        return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function attachMessageActions(messageItem) {
        if (!messageItem || messageItem.hasAttribute?.('data-has-side-action')) return;
        if (messageItem.classList?.contains('user')) return;
        messageItem.setAttribute('data-has-side-action', 'true');

        const actionsDiv = doc.createElement('div');
        actionsDiv.className = 'side-chat-message-actions';

        const sendToMainBtn = doc.createElement('button');
        sendToMainBtn.type = 'button';
        sendToMainBtn.className = 'side-chat-send-to-main-btn';
        sendToMainBtn.title = '将此回答填入主聊天输入框';
        sendToMainBtn.innerHTML = '<span class="vcp-ui-icon">reply</span> 填入主聊';

        sendToMainBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const contentDiv = messageItem.querySelector('.md-content');
            const cleanText = extractTextFromContentDiv(contentDiv);
            if (!cleanText) {
                chatCapabilities?.uiHelper?.showToastNotification?.('无可填入的文本内容', 'warning');
                return;
            }

            const mainInput = doc.querySelector('#messageInput');
            if (mainInput) {
                const curItem = typeof chatCapabilities?.getCurrentItem === 'function' ? chatCapabilities.getCurrentItem() : null;
                const parentItemId = descriptor.parent?.itemId;
                if (curItem && parentItemId && curItem.id !== parentItemId) {
                    chatCapabilities?.uiHelper?.showToastNotification?.(`主聊天当前不在来源助手（${descriptor.parent?.name || parentItemId}），已阻止填入`, 'warning');
                    return;
                }
                const inputTopic = mainInput.getAttribute('data-current-topic')
                    || (typeof chatCapabilities?.getCurrentTopic === 'function' ? chatCapabilities.getCurrentTopic() : null);
                const parentTopic = descriptor.parent?.topicId;
                if (inputTopic && parentTopic && inputTopic !== parentTopic) {
                    chatCapabilities?.uiHelper?.showToastNotification?.(`主聊天当前不在来源话题（${parentTopic}），已阻止填入`, 'warning');
                    return;
                }
                const currentVal = mainInput.value ? mainInput.value.trim() : '';
                mainInput.value = currentVal ? `${currentVal}\n\n${cleanText}` : cleanText;
                chatCapabilities?.uiHelper?.autoResizeTextarea?.(mainInput);
                const EventClass = doc.defaultView?.Event || globalThis.Event;
                mainInput.dispatchEvent(new EventClass('input', { bubbles: true }));
                mainInput.focus();
                chatCapabilities?.uiHelper?.showToastNotification?.('已填入主聊天输入框', 'success');
            } else {
                chatCapabilities?.uiHelper?.showToastNotification?.('未找到主聊天输入框', 'error');
            }
        });

        actionsDiv.appendChild(sendToMainBtn);
        // 放在气泡下方，而不是作为 .message-item 的第三个 flex 子项挤到行尾
        const bubbleColumn = messageItem.querySelector('.details-and-bubble-wrapper') || messageItem;
        bubbleColumn.appendChild(actionsDiv);
    }

    const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;

    let messageObserver = null;

    function syncMessageActions() {
        if (store.isDisposed || !root) return;
        const items = root.querySelectorAll('.message-item:not([data-has-side-action])');
        items.forEach(item => {
            if (!item.classList?.contains('streaming')) {
                attachMessageActions(item);
            }
        });
        updateEmptyState();
    }

    if (MutationObserverClass && root) {
        messageObserver = new MutationObserverClass(() => {
            syncMessageActions();
            pinToBottomIfSticky();
        });
        messageObserver.observe(root, { childList: true, subtree: true });
    }

    return Object.freeze({ extractTextFromContentDiv, attachMessageActions, syncMessageActions, dispose() { messageObserver?.disconnect?.(); } });
}
