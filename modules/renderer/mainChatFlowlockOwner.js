import { createOwnedPreloadSubscription } from './ownedPreloadSubscription.js';

/** Owns plugin Flowlock commands and their request/response lifecycle for the main chat Surface. */
export function createMainChatFlowlockOwner({ subscriptions = {}, flowlockManager, getSelectedItem, messageInput, uiHelperFunctions, sendResponse, reportError = console.error } = {}) {
    const receipts = []; let mounted = false; let disposed = false;
    const respond = (data, result, lifecycle = null) => {
        if (disposed || lifecycle?.isActive?.() === false || !data?.requestId || typeof sendResponse !== 'function') return;
        try { sendResponse(data, result); } catch (error) { reportError('[MainChatFlowlockOwner] response failed', error); }
    };
    const resize = () => uiHelperFunctions?.autoResizeTextarea?.(messageInput);
    const handle = async (data = {}, lifecycle = null) => {
        if (disposed || lifecycle?.isActive?.() === false) return;
        const { command, agentId, topicId, prompt, promptSource, target, oldText, newText } = data;
        const targetAgentId = agentId || getSelectedItem?.()?.id;
        try {
            if (!flowlockManager) { respond(data, { command, success: false, error: 'flowlockManager not available' }, lifecycle); return; }
            switch (command) {
                case 'start': if (!targetAgentId || !topicId) throw new Error('Missing agentId or topicId for start command'); await flowlockManager.start(targetAgentId, topicId, { startImmediately: false }); if (disposed || lifecycle?.isActive?.() === false) return; break;
                case 'stop': if (!targetAgentId) throw new Error('Missing agentId for stop command'); await flowlockManager.stop(targetAgentId); if (disposed || lifecycle?.isActive?.() === false) return; break;
                case 'promptee': if (!targetAgentId || !prompt) throw new Error('Missing target agent or prompt for promptee command'); flowlockManager.setCustomPrompt(targetAgentId, prompt); break;
                case 'prompter': if (!promptSource) throw new Error('Missing promptSource for prompter command'); if (messageInput) { const value = messageInput.value || ''; messageInput.value = value + (value ? ' ' : '') + `[来自: ${promptSource}]`; resize(); } break;
                case 'clear': if (messageInput) { messageInput.value = ''; resize(); } break;
                case 'remove': if (!target) throw new Error('Missing target for remove command'); if (messageInput) { messageInput.value = (messageInput.value || '').split(target).join(''); resize(); } break;
                case 'edit': if (!oldText || newText === undefined) throw new Error('Missing oldText or newText for edit command'); if (messageInput) { const value = messageInput.value || ''; const index = value.indexOf(oldText); if (index !== -1) messageInput.value = value.slice(0, index) + newText + value.slice(index + oldText.length); resize(); } break;
                case 'get': if (!messageInput) throw new Error('Message input element not found'); respond(data, { command: 'get', success: true, content: messageInput.value || '' }, lifecycle); return;
                case 'status': { const state = targetAgentId ? flowlockManager.getSession?.(targetAgentId) : null; respond(data, { command: 'status', success: true, status: { isActive: state?.status === 'active', isProcessing: !!state?.activeMessageId, agentId: state?.agentId || targetAgentId || null, topicId: state?.topicId || null, session: state, activeAgents: flowlockManager.getActiveAgents?.() || [] } }, lifecycle); return; }
                default: throw new Error(`Unknown flowlock command: ${command}`);
            }
            respond(data, { command, success: true }, lifecycle);
        } catch (error) { reportError('[MainChatFlowlockOwner] command failed', error); respond(data, { command, success: false, error: error?.message || String(error) }, lifecycle); }
    };
    const mount = () => { if (disposed) throw new Error('MainChatFlowlockOwner is disposed'); if (mounted) return; mounted = true; for (const subscribe of [subscriptions.command, subscriptions.request]) if (typeof subscribe === 'function') receipts.push(createOwnedPreloadSubscription({ subscribe, consume: handle, reportError })); };
    const dispose = async () => { if (disposed) return; disposed = true; await Promise.allSettled(receipts.splice(0).map(receipt => receipt.dispose())); };
    return Object.freeze({ mount, dispose, handle });
}
