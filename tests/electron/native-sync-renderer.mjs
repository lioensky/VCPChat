import { createChatRepository } from '../../modules/chat/chatRepository.js';
import { createMainChatStateAuthority } from '../../modules/chat/mainChatStateAuthority.js';
import { createChatHistoryPersistence } from '../../modules/chat/chatHistoryPersistence.js';
import { createChatDomRenderer } from '../../modules/chat/chatDomRenderer.js';
import { createNativeHistoryRefresh } from '../../modules/chat/nativeHistoryRefresh.js';
import { createMainChatStreamConsumer } from '../../modules/renderer/mainChatStreamConsumer.js';
import { chatManager } from '../../modules/chatManager.js';
import { createMessageRenderer } from '../../modules/messageRenderer.js';
import { createStreamProjection } from '../../modules/renderer/streamManager.js';
import { createStreamTransientHistory } from '../../modules/chat/streamTransientHistory.js';
import { createChatHistoryMutationAuthority } from '../../modules/chat/chatHistoryMutationAuthority.js';
import { Marked } from '../../node_modules/marked/lib/marked.esm.js';
import morphdom from '../../node_modules/morphdom/dist/morphdom-esm.js';

const params = new URLSearchParams(location.search);
const root = document.getElementById('chatMessages');
const api = window.chatAPI;
const state = createMainChatStateAuthority();
const repository = createChatRepository(api);
const persistence = createChatHistoryPersistence(repository);
let active = false, saving = null, releaseSave = null, refreshCount = 0;
const streamProjection = createStreamProjection();
const renderer = createMessageRenderer({ streamManager: streamProjection, enableContextMenu: false, enableMiddleClick: false, exposeGlobalCommands: false, initializeStreamProjection: false });
const domRenderer = createChatDomRenderer({ root, renderer });
const settings = { assistantEnabled: false, enableContextCompaction: false, enableSmoothStreaming: false, enableAiMessageButtons: false, userName: 'Isolated User', userAvatarUrl: 'assets/default_user_avatar.png' };
const settingsRef = { get: () => settings, set: value => Object.assign(settings, value) };
renderer.initializeMessageRenderer({
    chatMessagesDiv: root, electronAPI: api, chatRepository: repository,
    historyMutationAuthority: createChatHistoryMutationAuthority({ repository }),
    transientStreamHistory: createStreamTransientHistory({ repository, currentHistory: { get: state.historyRef.get, replace: state.historyRef.set } }),
    markedInstance: new Marked(), morphdom, chatDomRenderer: domRenderer,
    uiHelper: { scrollToBottom() {}, showToastNotification() {} },
    currentChatHistoryRef: state.historyRef, currentSelectedItemRef: state.selectedItemRef, currentTopicIdRef: state.topicIdRef, globalSettingsRef: settingsRef,
    summarizeTopicFromMessages: async () => null, handleCreateBranch: async () => null,
});
chatManager.init({
    electronAPI: api, chatRepository: repository,
    uiHelper: { showToastNotification() {}, autoResizeTextarea() {}, openModal() {} },
    modules: { messageRenderer: renderer, chatDomRenderer: domRenderer, streamManager: { getActiveStreamingMessageId: () => active ? 'terminal' : null }, itemListManager: { highlightActiveItem() {} }, topicListManager: {} },
    refs: { currentSelectedItemRef: state.selectedItemRef, currentTopicIdRef: state.topicIdRef, currentChatHistoryRef: state.historyRef, attachedFilesRef: { get: () => [], set() {} }, globalSettingsRef: settingsRef },
    elements: { chatMessagesDiv: root, currentChatNameH3: document.getElementById('currentChatAgentName'), currentItemActionBtn: document.getElementById('currentItemAction'), messageInput: document.getElementById('messageInput'), sendMessageBtn: document.getElementById('sendMessageBtn'), attachFileBtn: document.getElementById('attachFileBtn') },
    mainRendererFunctions: { displaySettingsForItem() {}, updateAttachmentPreview() {} },
});
const refresh = createNativeHistoryRefresh({
    getSelection: state.selectedItemRef.get, getTopicId: state.topicIdRef.get,
    hasActiveStream: () => active,
    syncHistory: async (...args) => { refreshCount++; await chatManager.syncHistoryFromFile(...args); },
});
const off = api.onHistoryFileUpdated(event => refresh.consume(event));
function select(itemId = 'agent-a', itemType = 'agent', topicId = 'topic-a') {
    state.setSelectedItem({ id: itemId, type: itemType, name: itemId, config: { topics: [{ id: topicId }] } });
    state.setTopicId(topicId); state.historyRef.set([]); renderer.clearChat();
    renderer.setCurrentSelectedItem(state.selectedItemRef.get()); renderer.setCurrentTopicId(topicId);
    document.getElementById('heading').textContent = `${params.get('client')} — ${itemType}:${itemId}/${topicId}`;
}
select();
window.nativeSyncTest = {
    async save(history) {
        const { selectedItem: s, topicId } = state.snapshot();
        await repository.getHistory(s.id, s.type, topicId);
        return repository.saveHistory(s.id, s.type, topicId, history);
    },
    snapshot() { return { ...state.consumer.snapshot(), visible: [...root.querySelectorAll('[data-message-id]')].map(e => ({ id: e.dataset.messageId, text: e.textContent })), refreshCount, refresh: refresh.diagnostics() }; },
    select,
    sendGroup(id, text) { const s = state.snapshot(); return api.sendGroupChatMessage(s.selectedItem.id, s.topicId, { id, content: { text } }); },
    redoGroup(messageId) { const s = state.snapshot(); return api.redoGroupChatMessage(s.selectedItem.id, s.topicId, messageId, 'member'); },
    async beginTerminal() {
        active = true;
        const s = state.snapshot(), context = { agentId: s.selectedItem.id, topicId: s.topicId };
        const message = { id: 'terminal', role: 'assistant', content: 'Terminal result retained while saving', timestamp: 300 };
        const gate = new Promise(resolve => { releaseSave = resolve; });
        const consumer = createMainChatStreamConsumer({ messageId: message.id, context }, {
            beginHistoryPersistence: c => refresh.beginPersistence(c),
            projectTerminal: async () => { active = false; state.historyRef.set([...state.historyRef.get(), message]); await domRenderer.renderMessage(message, true); return { messageId: message.id, context, history: state.historyRef.get(), content: message.content }; },
            persistTerminal: async value => { await gate; return persistence.commit(value); },
        });
        saving = consumer.persist({ terminal: { kind: 'completed' } });
        await new Promise(resolve => setTimeout(resolve, 15));
        return this.snapshot();
    },
    async finishTerminal() { releaseSave(); await saving; await refresh.drain(); return this.snapshot(); },
    async dispose() { off(); refresh.dispose(); await chatManager.dispose(); await renderer.disposeRootResources(root); renderer.disposeRendererResources(); await streamProjection.dispose(); },
};
