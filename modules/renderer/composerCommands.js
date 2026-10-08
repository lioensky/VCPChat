/*
 * 主输入框对外提供的动作，登记成命令：
 *   composer.insert-text   往主输入框末尾追加一段文字
 * 侧栏的代码查看、辅助对话等只认命令 id，不再自己去 document 里找 #messageInput；
 * 「主聊天是不是还停在来源会话」这类检查也收在这里，由主输入框的主人判断。
 */
import '../ui-system/lifecycle-scope.js';

/**
 * @param {object} options
 * @param {HTMLTextAreaElement} options.messageInput
 * @param {{ get(): any }} options.selectedItemRef
 * @param {{ get(): string|null }} options.topicIdRef
 * @param {object} [options.uiHelper]
 * @returns {{ dispose(): void }}
 */
export function registerComposerCommands({ win, messageInput, selectedItemRef, topicIdRef, uiHelper, commands = win?.VCPContributions?.commands }) {
    const LifecycleScope = globalThis.VCPLifecycle?.LifecycleScope;
    if (!commands || !LifecycleScope) return { dispose() {} };
    const owner = new LifecycleScope('composer-commands');

    /**
     * @param {string} text
     * @param {{ gap?: 'line'|'paragraph', expect?: { itemId?: string, topicId?: string } }} [options]
     *   gap: 'line' 换一行接上（已经以换行结尾就直接接）；'paragraph' 去掉末尾空白后空一行接上。
     *   expect: 来源会话。主聊天已经切走时不插入，免得把内容填进别的话题。
     * @returns {{ inserted: true } | { inserted: false, reason: 'no-composer'|'item-mismatch'|'topic-mismatch'|'empty' }}
     */
    const insertText = (text, { gap = 'line', expect = null } = {}) => {
        if (typeof text !== 'string' || !text) return { inserted: false, reason: 'empty' };
        if (!messageInput?.isConnected || messageInput.disabled) return { inserted: false, reason: 'no-composer' };
        const currentItemId = selectedItemRef?.get?.()?.id || null;
        if (expect?.itemId && currentItemId && currentItemId !== expect.itemId) return { inserted: false, reason: 'item-mismatch' };
        const currentTopicId = topicIdRef?.get?.() || null;
        if (expect?.topicId && currentTopicId && currentTopicId !== expect.topicId) return { inserted: false, reason: 'topic-mismatch' };

        const current = messageInput.value || '';
        if (gap === 'paragraph') {
            const trimmed = current.trim();
            messageInput.value = trimmed ? `${trimmed}\n\n${text}` : text;
        } else {
            const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
            messageInput.value = current + separator + text;
        }
        uiHelper?.autoResizeTextarea?.(messageInput);
        const EventClass = messageInput.ownerDocument?.defaultView?.Event || globalThis.Event;
        messageInput.dispatchEvent(new EventClass('input', { bubbles: true }));
        messageInput.focus();
        return { inserted: true };
    };

    if (commands.get('composer.insert-text')) {
        console.warn('[Composer] command composer.insert-text is already registered');
    } else {
        commands.register({ id: 'composer.insert-text', title: '插入到主输入框', handler: insertText }, { owner, ownerId: 'main-composer' });
    }
    return Object.freeze({ dispose: () => owner.dispose('composer-disposed') });
}
