/**
 * 主窗口这一侧的桌宠桥：桌宠和主窗口之间的往来都在这里（由 ./index.js 装上）。
 * 桌宠的开关和设置都在全局设置「桌宠」分区里，不经过这里。
 */
import { createDeskPetSendBridge } from './sendBridge.js';
import { requestSettingsSection } from '../../modules/settings/extensions.js';

export function installDeskPetBridge({ chatAPI, refs, itemListManager, chatManager, sendMessageBtn, globalSettingsBtn }) {
    // 桌宠上说的话：切到那个 Agent，按正常流程发送（历史、话题、流式都照旧）。
    const sendFromPet = createDeskPetSendBridge({
        getSelectedItem: () => refs.currentSelectedItem.get(),
        getTopicId: () => refs.currentTopicId.get(),
        findAgent: agentId => itemListManager?.findItemById?.(agentId, 'agent') || null,
        selectItem: item => chatManager.selectItem(item.id, item.type || 'agent', item.name, item.avatarUrl, item.config || item),
        sendMessage: request => chatManager.handleSendMessage(request),
        startTopic: item => chatManager.createNewTopicForItem(item.id, 'agent'),
        isBusy: () => sendMessageBtn.dataset.mode === 'interrupt',
        storeFiles: (agentId, topicId, files) => chatAPI.handleFileDrop(agentId, topicId, files),
    });
    chatAPI.onDeskPetSendRequest?.(async ({ requestId, agentId, text, files, newTopic, deadline } = {}) => {
        let result;
        try {
            result = await sendFromPet({ agentId, text, files, newTopic: newTopic === true, deadline });
        } catch (error) {
            result = { success: false, error: error.message };
        }
        chatAPI.deskPetSendResult?.({ requestId, result });
    });
    chatAPI.onDeskPetWhereRequest?.(({ requestId } = {}) => {
        const item = refs.currentSelectedItem.get();
        chatAPI.deskPetWhereResult?.({ requestId, where: { itemId: item?.id || null, topicId: refs.currentTopicId.get() || null } });
    });
    chatAPI.onDeskPetOpenTopic?.(async ({ agentId, topicId } = {}) => {
        try {
            if (refs.currentSelectedItem.get()?.id !== agentId) {
                const item = itemListManager?.findItemById?.(agentId, 'agent');
                if (!item) return;
                await chatManager.selectItem(item.id, 'agent', item.name, item.avatarUrl, item.config || item);
            }
            if (refs.currentTopicId.get() !== topicId) await chatManager.selectTopic(topicId);
        } catch (error) {
            console.warn('[DeskPet] open topic failed:', error);
        }
    });

    // 工具审批：通知栏里待批的请求转给桌宠一份；桌宠上点的允许/拒绝按通知卡的流程应答，答完（哪边答的都算）叫桌宠收起
    window.addEventListener('vcp:tool-approval-pending', event => chatAPI.deskPetApprovalOffer?.(event.detail));
    window.addEventListener('vcp:tool-approval-settled', event => chatAPI.deskPetApprovalSettled?.(event.detail?.requestId));
    chatAPI.onDeskPetApprovalAnswer?.(({ requestId, approved } = {}) => {
        window.notificationRenderer?.answerToolApproval?.(requestId, approved);
    });

    // 桌宠上点了停止：那条回复正显示在聊天里就按停止键走（界面状态一起收好）；
    // 已经切到别的话题了就直接让主进程中止那条请求
    chatAPI.onDeskPetInterrupt?.(async ({ messageId } = {}) => {
        if (typeof messageId !== 'string' || !messageId) return;
        const shown = [...document.querySelectorAll('#chatMessages .message-item.streaming')]
            .some(item => item.dataset.messageId === messageId);
        if (shown && sendMessageBtn.dataset.mode === 'interrupt') {
            sendMessageBtn.click();
            return;
        }
        try {
            await chatAPI.interruptVcpRequest?.({ messageId });
        } catch (error) {
            console.warn('[DeskPet] interrupt failed:', error);
        }
    });
    // 托盘、桌宠右键里的「桌宠设置…」：打开全局设置，切到桌宠分区（设置壳搭好时自己切过去）
    chatAPI.onDeskPetSettingsOpen?.(() => {
        requestSettingsSection('deskpet');
        if (!document.getElementById('globalSettingsModal')?.classList.contains('active')) globalSettingsBtn?.click();
    });
}
