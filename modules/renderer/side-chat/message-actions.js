/* side-chat/message-actions.js
 * Right-click menu for side chat messages: edit, copy, fill into the main
 * composer, put a question back into the side composer, read mode, regenerate,
 * trajectory and delete.
 * It reuses the main chat menu element (#chatContextMenu), so only one message
 * menu is open at a time and it looks the same.
 */
'use strict';

const MENU_ID = 'chatContextMenu';

export function createSideChatMessageActions({
    store,
    chatCapabilities,
    descriptor,
    doc,
    root,
    textarea,
    getHistory,
    saveHistory,
    removeMessage,
    isBusy,
    onDeletingChange,
    onComposerFilled,
    editMessage,
    regenerate,
    updateEmptyState,
    pinToBottomIfSticky
}) {
    const win = doc.defaultView;
    const uiHelper = chatCapabilities?.uiHelper;
    const toast = (message, type) => uiHelper?.showToastNotification?.(message, type);

    function extractTextFromContentDiv(contentDiv) {
        if (!contentDiv) return '';
        const clone = contentDiv.cloneNode(true);
        clone.querySelectorAll?.(
            '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, .message-attachments, .message-attachment-remove-btn, style, script'
        )?.forEach?.(el => el.remove());
        return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function rawText(message) {
        const content = message?.content;
        if (typeof content === 'string') return content;
        return typeof content?.text === 'string' ? content.text : '';
    }

    function resolveMessage(messageItem) {
        const id = messageItem.dataset?.messageId;
        const history = getHistory?.() || [];
        const found = (id && history.find(m => m?.id === id)) || messageItem._vcpMessageModel;
        if (found) return found;
        const role = ['user', 'assistant', 'system'].find(r => messageItem.classList?.contains(r));
        return role ? { id, role } : null;
    }

    function fillMainComposer(text) {
        const commands = win?.VCPContributions?.commands;
        if (!commands?.get('composer.insert-text')) {
            toast('未找到主聊天输入框', 'error');
            return;
        }
        const parent = descriptor.parent || {};
        const result = commands.execute('composer.insert-text', text, {
            gap: 'paragraph',
            expect: { itemId: parent.itemId, topicId: parent.topicId }
        });
        if (result?.inserted) toast('已填入主聊天输入框', 'success');
        else if (result?.reason === 'item-mismatch') toast(`主聊天当前不在来源助手（${parent.name || parent.itemId}），已阻止填入`, 'warning');
        else if (result?.reason === 'topic-mismatch') toast(`主聊天当前不在来源话题（${parent.topicId}），已阻止填入`, 'warning');
        else toast('未找到主聊天输入框', 'error');
    }

    function fillSideComposer(text) {
        if (!textarea || textarea.disabled) {
            toast('输入框暂不可用', 'warning');
            return;
        }
        const currentVal = textarea.value ? textarea.value.trim() : '';
        textarea.value = currentVal ? `${currentVal}\n\n${text}` : text;
        const EventClass = win?.Event || globalThis.Event;
        textarea.dispatchEvent(new EventClass('input', { bubbles: true }));
        onComposerFilled?.();
        textarea.focus();
    }

    async function copyText(text, doneMessage) {
        try {
            await win?.navigator?.clipboard?.writeText(text);
            toast(doneMessage, 'success');
        } catch (error) {
            toast(`复制失败：${error?.message || error}`, 'error');
        }
    }

    function selectionIn(messageItem) {
        const sel = win?.getSelection?.();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
        try {
            const range = sel.getRangeAt(0);
            if (!messageItem.contains(range.commonAncestorContainer)) return '';
        } catch {
            return '';
        }
        return sel.toString().trim();
    }

    // 打开菜单的那条消息：Esc、Tab 或执行菜单项后焦点回到这里
    let returnFocusTo = null;

    function closeMenu({ restoreFocus = false } = {}) {
        doc.getElementById(MENU_ID)?.remove();
        const target = returnFocusTo;
        returnFocusTo = null;
        if (restoreFocus && target?.isConnected) target.focus?.({ preventScroll: true });
    }

    // 消息列表和话题列表一样只占一个 Tab 停靠点（Radix 的 roving tabindex）：
    // 上下键、Home、End 在消息间移动，Shift+F10 或菜单键打开这条消息的菜单。
    function messageItems() {
        return root ? [...root.querySelectorAll('.message-item')] : [];
    }

    function setMessageTabStop(target) {
        for (const item of messageItems()) item.tabIndex = item === target ? 0 : -1;
    }

    function ensureMessageTabStop() {
        const items = messageItems();
        if (!items.length) return;
        items.forEach(item => {
            if (!item.hasAttribute('tabindex')) item.tabIndex = -1;
            if (!item.hasAttribute('aria-keyshortcuts')) item.setAttribute('aria-keyshortcuts', 'Shift+F10');
        });
        if (!items.some(item => item.tabIndex === 0)) items[items.length - 1].tabIndex = 0;
    }

    function onMessageFocusIn(event) {
        if (event.target?.classList?.contains('message-item') && root.contains(event.target)) setMessageTabStop(event.target);
    }

    function onMessageKeydown(event) {
        const current = event.target;
        if (!current?.classList?.contains('message-item') || event.altKey || event.ctrlKey || event.metaKey) return;
        const items = messageItems();
        const index = items.indexOf(current);
        if (index < 0) return;
        let next = null;
        if (event.key === 'ArrowDown') next = items[Math.min(items.length - 1, index + 1)];
        else if (event.key === 'ArrowUp') next = items[Math.max(0, index - 1)];
        else if (event.key === 'Home') next = items[0];
        else if (event.key === 'End') next = items[items.length - 1];
        else return;
        event.preventDefault();
        setMessageTabStop(next);
        next.focus();
        next.scrollIntoView?.({ block: 'nearest' });
    }

    function onMenuKeydown(event) {
        const menu = event.currentTarget;
        if (event.key === 'Tab') {
            event.preventDefault();
            closeMenu({ restoreFocus: true });
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            if (event.target?.getAttribute?.('role') !== 'menuitem') return;
            event.preventDefault();
            event.target.click();
            return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        if (!items.length) return;
        event.preventDefault();
        const current = items.indexOf(doc.activeElement);
        let next = 0;
        if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
        else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        items[next].focus();
    }

    function onOutsidePointer(event) {
        const menu = doc.getElementById(MENU_ID);
        if (menu?.dataset.sideChatMenu === 'true' && !menu.contains(event.target)) closeMenu();
    }

    function onKeydown(event) {
        if (event.key !== 'Escape') return;
        const ours = doc.getElementById(MENU_ID)?.dataset.sideChatMenu === 'true';
        closeMenu({ restoreFocus: ours });
    }

    function buildMenu(messageItem, message) {
        const isAssistant = message.role === 'assistant';
        const isUser = message.role === 'user';
        const unfinished = messageItem.classList.contains('streaming') || messageItem.classList.contains('thinking') || message.isThinking;
        const contentDiv = messageItem.querySelector('.md-content');
        const renderedText = () => extractTextFromContentDiv(contentDiv);
        const selected = selectionIn(messageItem);
        const busy = Boolean(isBusy?.());
        const items = [];
        const add = (action, icon, label, run, className) => items.push({ action, icon, label, run, className });

        // 生成中不改历史：流结束时会把整段历史写回，改动会被覆盖
        if (message.id && typeof editMessage === 'function' && !unfinished && !busy) {
            add('edit', 'fa-edit', '编辑消息', () => editMessage(messageItem, message));
        }

        if (selected) add('copy-selection', 'fa-i-cursor', '复制选中', () => copyText(selected, '已复制选中的文字。'));
        add('copy', 'fa-copy', '复制文本', () => copyText(renderedText(), '已复制渲染后的文本。'));

        if (isAssistant && !unfinished) {
            add('send-to-main', 'fa-reply', '填入主聊', () => {
                const text = renderedText();
                if (!text) toast('无可填入的文本内容', 'warning');
                else fillMainComposer(text);
            });
        }
        if (isUser) {
            add('edit-again', 'fa-pen', '重新编辑', () => {
                const text = rawText(message) || renderedText();
                if (text) fillSideComposer(text);
            });
        }

        const openText = chatCapabilities?.electronAPI?.openTextInNewWindow;
        if (typeof openText === 'function' && !unfinished) {
            add('read-mode', 'fa-book-reader', '阅读模式', () => {
                const text = rawText(message) || renderedText();
                const theme = doc.body?.classList.contains('light-theme') ? 'light' : 'dark';
                openText(text, `阅读: ${String(message.id || '辅助对话').slice(0, 10)}...`, theme);
            }, 'info-item');
        }

        if (isAssistant && message.id && typeof regenerate === 'function' && !unfinished && !busy) {
            add('regenerate', 'fa-sync-alt', '重新回复', () => regenerate(message.id), 'regenerate-text');
        }

        const commands = win?.VCPContributions?.commands;
        if (isAssistant && message.id && commands?.get('sidepane.open-trajectory')) {
            // 这条回复记在子话题下，轨迹要看子话题，不是主聊天当前的话题
            const conversation = descriptor?.child?.itemId && descriptor.child.topicId
                ? { item: { id: descriptor.child.itemId, name: descriptor.title || '辅助对话' }, topicId: descriptor.child.topicId }
                : null;
            add('trajectory', 'fa-route', '查看调用轨迹', () => commands.execute('sidepane.open-trajectory', { requestId: message.id, conversation }));
        }

        if (message.id && typeof removeMessage === 'function' && typeof saveHistory === 'function' && !unfinished && !busy) {
            add('delete', 'fa-trash-alt', '删除消息', async () => {
                const preview = (rawText(message) || renderedText() || '[消息内容无法预览]');
                const confirmed = typeof uiHelper?.showConfirmDialog === 'function'
                    ? await uiHelper.showConfirmDialog(`确定要删除此消息吗？\n"${preview.substring(0, 50)}${preview.length > 50 ? '...' : ''}"`, '删除确认', '删除', '取消', true)
                    : true;
                if (!confirmed || store.isDisposed || isBusy?.()) return;
                const history = getHistory?.() || [];
                if (!history.some(item => item?.id === message.id)) return;
                onDeletingChange?.(true);
                try {
                    // Keep the visible message and live history until the child topic accepts the write.
                    const saved = await saveHistory(history.filter(item => item?.id !== message.id));
                    if (saved?.success === false || saved?.error) {
                        throw new Error(saved.error || '保存历史出错');
                    }
                    if (store.isDisposed) return;
                    await removeMessage(message.id);
                    updateEmptyState();
                } catch (error) {
                    console.error('[SideChat] Failed to delete message:', error);
                    if (!store.isDisposed) toast('删除失败：历史记录未保存，消息已保留。请重试。', 'error');
                } finally {
                    onDeletingChange?.(false);
                }
            }, 'danger-item');
        }

        const menu = doc.createElement('div');
        menu.id = MENU_ID;
        menu.className = 'context-menu';
        menu.dataset.sideChatMenu = 'true';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '消息操作');
        menu.addEventListener('keydown', onMenuKeydown);
        for (const item of items) {
            const el = doc.createElement('div');
            el.className = item.className ? `context-menu-item ${item.className}` : 'context-menu-item';
            el.dataset.sideChatAction = item.action;
            el.setAttribute('role', 'menuitem');
            el.tabIndex = -1;
            el.innerHTML = `<i class="fas ${item.icon}" aria-hidden="true"></i> `;
            el.append(item.label);
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                closeMenu({ restoreFocus: true });
                void item.run();
            });
            menu.appendChild(el);
        }
        return menu;
    }

    function placeMenu(menu, event) {
        menu.style.visibility = 'hidden';
        menu.style.position = 'fixed';
        doc.body.appendChild(menu);
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const viewWidth = win?.innerWidth || 0;
        const viewHeight = win?.innerHeight || 0;
        let top = event.clientY;
        let left = event.clientX;
        // 放不下就翻到指针上方/左边，展开动画也从指针那一角开始
        if (top + height > viewHeight) {
            top = Math.max(5, event.clientY - height);
            menu.dataset.openUp = 'true';
        }
        if (left + width > viewWidth) {
            left = Math.max(5, event.clientX - width);
            menu.dataset.openLeft = 'true';
        }
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.visibility = 'visible';
    }

    function onContextMenu(event) {
        if (store.isDisposed) return;
        const messageItem = event.target?.closest?.('.message-item');
        if (!messageItem || !root.contains(messageItem)) return;
        // 正在编辑的输入区、图片等保留各自的原生菜单
        if (event.target.closest('textarea, input, img, video')) return;
        const message = resolveMessage(messageItem);
        if (!message || (message.role !== 'assistant' && message.role !== 'user')) return;
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        // 键盘（Shift+F10 / 菜单键）打开时没有指针坐标，贴着这条消息出菜单
        let anchor = event;
        if (!event.clientX && !event.clientY && typeof messageItem.getBoundingClientRect === 'function') {
            const rect = messageItem.getBoundingClientRect();
            anchor = { clientX: rect.left + 16, clientY: rect.top + 16 };
        }
        const menu = buildMenu(messageItem, message);
        placeMenu(menu, anchor);
        returnFocusTo = messageItem.tabIndex >= 0 || messageItem.hasAttribute('tabindex') ? messageItem : null;
        menu.querySelector('[role="menuitem"]')?.focus?.({ preventScroll: true });
    }

    root?.addEventListener('contextmenu', onContextMenu);
    root?.addEventListener('keydown', onMessageKeydown);
    root?.addEventListener('focusin', onMessageFocusIn);
    ensureMessageTabStop();
    doc.addEventListener('click', onOutsidePointer, true);
    doc.addEventListener('keydown', onKeydown, true);

    const MutationObserverClass = win?.MutationObserver || globalThis.MutationObserver;
    let messageObserver = null;
    if (MutationObserverClass && root) {
        messageObserver = new MutationObserverClass(() => {
            if (store.isDisposed) return;
            ensureMessageTabStop();
            updateEmptyState();
            pinToBottomIfSticky();
        });
        messageObserver.observe(root, { childList: true, subtree: true });
    }

    return Object.freeze({
        extractTextFromContentDiv,
        dispose() {
            messageObserver?.disconnect?.();
            root?.removeEventListener('contextmenu', onContextMenu);
            root?.removeEventListener('keydown', onMessageKeydown);
            root?.removeEventListener('focusin', onMessageFocusIn);
            doc.removeEventListener('click', onOutsidePointer, true);
            doc.removeEventListener('keydown', onKeydown, true);
            const menu = doc.getElementById(MENU_ID);
            if (menu?.dataset.sideChatMenu === 'true') menu.remove();
        }
    });
}
