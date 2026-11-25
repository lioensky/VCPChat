// Keep the failed terminal in memory for this window, independently of its DOM.
export function createUnsavedReplyRecovery(root, services) {
    const doc = root.ownerDocument;
    const pending = new Map();
    const keyOf = (context, id) => JSON.stringify([context?.agentId, context?.topicId, id]);
    let observer;

    function refresh() {
        const itemId = services.getSelection()?.id;
        const topicId = services.getTopicId();
        for (const entry of pending.values()) {
            if (entry.context.agentId !== itemId || entry.context.topicId !== topicId) {
                entry.notice.remove();
                entry.preview?.remove();
                continue;
            }
            const nodes = root.querySelectorAll('.message-item[data-message-id]');
            const original = Array.from(nodes).find(node => node !== entry.preview
                && node.dataset.messageId === entry.message.id);
            if (original) entry.preview?.remove();
            if (!original && !root.contains(entry.preview)) {
                const bubble = doc.createElement('article');
                bubble.className = 'message-item assistant';
                bubble.dataset.messageId = entry.message.id;
                const body = doc.createElement('div');
                body.className = 'md-content';
                body.style.whiteSpace = 'pre-wrap';
                body.textContent = entry.message.content;
                bubble.append(body);
                root.append(bubble);
                entry.preview = bubble;
            }
            const host = original || entry.preview;
            host.dataset.vcpPersistenceState = 'unsaved';
            if (entry.notice.parentNode !== host) host.append(entry.notice);
        }
    }

    function retain(projected, error) {
        const { context, messageId } = projected;
        if (!context?.agentId || !context.topicId || context.isGroupMessage ||
            context.topicId === 'assistant_chat' || context.topicId.startsWith('sidechat_')) return;
        const key = keyOf(context, messageId);
        const terminal = projected.history?.find(m => m.id === messageId && m.role === 'assistant');
        if (!terminal || pending.has(key)) return;
        const message = structuredClone(terminal);
        const notice = doc.createElement('div');
        notice.setAttribute('role', 'status');
        const label = doc.createElement('span');
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = '重试保存';
        const failed = reason => { label.textContent = `回复未保存：${reason?.message || reason} `; };
        failed(error);
        notice.append(label, button);
        const entry = { context: { ...context }, message, notice, preview: null };
        pending.set(key, entry);
        button.addEventListener('click', async () => {
            if (button.disabled || !pending.has(key)) return;
            button.disabled = true;
            label.textContent = '正在保存原回复 ';
            try {
                await services.historyPersistence.commit({ messageId, context: entry.context,
                    content: message.content, history: [message], finishReason: message.finishReason });
            } catch (writeError) {
                failed(writeError);
                button.disabled = false;
                return;
            }
            pending.delete(key);
            const host = notice.parentNode;
            notice.remove();
            if (host) {
                host.dataset.vcpPersistenceState = 'saved';
                delete host.dataset.vcpPersistenceError;
                host.removeAttribute('aria-label');
                host.removeAttribute('title');
            }
            if (!pending.size) { observer?.disconnect(); observer = null; }
        });
        if (!observer) {
            observer = new doc.defaultView.MutationObserver(refresh);
            observer.observe(root, { childList: true, subtree: true });
        }
        refresh();
    }
    return {
        retain,
        has: (context, id) => pending.has(keyOf(context, id)),
        dispose() {
            observer?.disconnect();
            for (const entry of pending.values()) {
                entry.notice.remove();
                entry.preview?.remove();
            }
            pending.clear();
        },
    };
}