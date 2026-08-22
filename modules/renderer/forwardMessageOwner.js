/** Owns the forward-message modal state, target selection and send operation. */
export function createForwardMessageOwner({ chatAPI, chatManager, uiHelperFunctions, getConversation, documentRef = document, reportError = console.error } = {}) {
    let message = null;
    let target = null;
    let disposed = false;
    const renderTargets = items => {
        const list = documentRef.getElementById('forwardTargetList');
        const confirm = documentRef.getElementById('confirmForwardBtn');
        if (!list) return;
        list.innerHTML = '';
        for (const item of items || []) {
            const li = documentRef.createElement('li'); li.className = 'agent-item'; li.dataset.id = item.id; li.dataset.type = item.type; li.dataset.name = item.name;
            const avatar = documentRef.createElement('img'); avatar.className = 'avatar'; avatar.src = item.avatarUrl || (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_user_avatar.png');
            const name = documentRef.createElement('span'); name.className = 'agent-name'; name.textContent = `${item.name} (${item.type === 'group' ? '群组' : 'Agent'})`;
            li.append(avatar, name); li.onclick = () => { list.querySelector('.selected')?.classList.remove('selected'); li.classList.add('selected'); target = { id: item.id, type: item.type, name: item.name }; if (confirm) confirm.disabled = false; }; list.appendChild(li);
        }
    };
    const show = async incoming => {
        if (disposed) return;
        message = incoming; target = null; uiHelperFunctions?.openModal?.('forwardMessageModal');
        const list = documentRef.getElementById('forwardTargetList'); const search = documentRef.getElementById('forwardTargetSearch'); const comment = documentRef.getElementById('forwardAdditionalComment'); const confirm = documentRef.getElementById('confirmForwardBtn');
        if (!list || !search || !comment || !confirm) { reportError('[ForwardMessageOwner] modal elements missing'); return; }
        list.innerHTML = '<li>Loading...</li>'; comment.value = ''; search.value = ''; confirm.disabled = true;
        const result = await chatAPI?.getAllItems?.(); renderTargets(result?.success ? result.items : []);
        search.oninput = () => { const term = search.value.toLowerCase(); list.querySelectorAll('.agent-item').forEach(item => { item.style.display = item.dataset.name.toLowerCase().includes(term) ? '' : 'none'; }); };
        confirm.onclick = confirmForward;
    };
    const confirmForward = async () => {
        if (disposed || !message || !target) { uiHelperFunctions?.showToastNotification?.('错误：未选择消息或转发目标。', 'error'); return; }
        const comment = documentRef.getElementById('forwardAdditionalComment')?.value?.trim() || '';
        const conversation = getConversation?.() || {};
        const result = await chatAPI?.getOriginalMessageContent?.(conversation.item?.id, conversation.item?.type, conversation.topicId, message.id);
        if (!result?.success) { uiHelperFunctions?.showToastNotification?.(`无法获取原始消息内容: ${result?.error || 'unknown error'}`, 'error'); return; }
        const original = { ...message, content: result.content }; const sender = original.name || (original.role === 'user' ? '用户' : '助手'); let content = `> 转发自 **${sender}** 的消息:\n\n`;
        content += typeof original.content === 'string' ? original.content : (original.content?.text || ''); if (comment) content += `\n\n---\n${comment}`;
        if (typeof chatManager?.handleForwardMessage !== 'function') { uiHelperFunctions?.showToastNotification?.('转发功能尚未完全实现。', 'error'); return; }
        await chatManager.handleForwardMessage(target, content, original.attachments || []); uiHelperFunctions?.showToastNotification?.(`消息已转发给 ${target.name}`, 'success'); uiHelperFunctions?.closeModal?.('forwardMessageModal'); message = null; target = null;
    };
    const dispose = async () => { disposed = true; message = null; target = null; };
    return Object.freeze({ show, confirm: confirmForward, dispose });
}
