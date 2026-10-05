/* side-chat/message-edit.js
 * In-place editing of a side chat message. The edited text is written back to
 * the side topic only; the main chat history watcher is left alone.
 */
'use strict';

export function createSideChatMessageEditor({
    doc,
    getHistory,
    setHistory,
    saveHistory,
    rerender,
    isBusy,
    toast
}) {
    let active = null;

    function textOf(message) {
        const content = message?.content;
        if (typeof content === 'string') return content;
        return typeof content?.text === 'string' ? content.text : '';
    }

    function close() {
        if (!active) return;
        const { messageItem, editor } = active;
        editor.remove();
        messageItem.classList.remove('side-chat-editing');
        active = null;
    }

    async function save() {
        if (!active || active.saving) return;
        const { messageItem, messageId, input } = active;
        if (isBusy?.()) {
            toast?.('回复生成中，结束后再保存', 'warning');
            return;
        }
        const history = getHistory() || [];
        const index = history.findIndex(m => m?.id === messageId);
        if (index === -1) {
            toast?.('这条消息已不在历史中', 'warning');
            close();
            return;
        }
        const newText = input.value;
        const old = history[index];
        if (newText === textOf(old)) {
            close();
            return;
        }
        const content = old.content && typeof old.content === 'object'
            ? { ...old.content, text: newText }
            : newText;
        const next = history.slice();
        next[index] = { ...old, content };

        active.saving = true;
        let result;
        try {
            result = await saveHistory(next);
        } catch (error) {
            result = { error: error?.message || String(error) };
        }
        if (!active || active.messageItem !== messageItem) return;
        active.saving = false;
        if (result && (result.success === false || result.error)) {
            toast?.(`保存失败：${result.error || '未知错误'}`, 'error');
            return;
        }
        setHistory(next);
        close();
        rerender(messageId, newText);
    }

    function start(messageItem, message) {
        if (!messageItem || !message?.id) return;
        if (active?.messageItem === messageItem) {
            active.input.focus();
            return;
        }
        close();

        const editor = doc.createElement('div');
        editor.className = 'side-chat-message-editor';
        const input = doc.createElement('textarea');
        input.className = 'message-edit-textarea';
        input.value = textOf(message);
        input.setAttribute('aria-label', '编辑消息');

        const controls = doc.createElement('div');
        controls.className = 'message-edit-controls';
        const saveBtn = doc.createElement('button');
        saveBtn.type = 'button';
        saveBtn.dataset.sideChatEdit = 'save';
        saveBtn.innerHTML = '<i class="fas fa-save"></i> 保存';
        const cancelBtn = doc.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.dataset.sideChatEdit = 'cancel';
        cancelBtn.innerHTML = '<i class="fas fa-times"></i> 取消';
        controls.append(saveBtn, cancelBtn);
        editor.append(input, controls);

        saveBtn.addEventListener('click', (e) => { e.stopPropagation(); void save(); });
        cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
            }
        });

        const column = messageItem.querySelector('.details-and-bubble-wrapper') || messageItem;
        const contentDiv = column.querySelector('.md-content');
        if (contentDiv?.nextSibling) column.insertBefore(editor, contentDiv.nextSibling);
        else column.appendChild(editor);
        messageItem.classList.add('side-chat-editing');
        active = { messageItem, messageId: message.id, input, editor, saving: false };
        input.focus();
        input.setSelectionRange?.(input.value.length, input.value.length);
    }

    return Object.freeze({
        start,
        close,
        isEditing: (messageId) => Boolean(active && (!messageId || active.messageId === messageId)),
        dispose: close
    });
}
