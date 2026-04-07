// --- Globals ---
let globalSettings = {
    sidebarWidth: 260,
    enableMiddleClickQuickAction: false,
    middleClickQuickAction: '',
    enableMiddleClickAdvanced: false,
    middleClickAdvancedDelay: 1000,
    notificationsSidebarWidth: 300,
    userName: '用户', // Default username
    doNotDisturbLogMode: false, // 勿扰模式状态（已废弃，保留兼容性）
    filterEnabled: false, // 过滤总开关状态
    filterRules: [], // 过滤规则列表
    enableRegenerateConfirmation: true, // 重新回复确认机制开关
    flowlockContinueDelay: 5, // 心流锁续写延迟（秒）
    enableThoughtChainInjection: false, // 元思考注入上下文开关
    enableWideChatLayout: false,
    chatBubbleMaxWidthDefault: 82,
    chatBubbleMaxWidthNotifications: 90,
    chatBubbleMaxWidthNarrow: 85,
    chatBubbleMaxWidthWideDefault: 92,
    chatBubbleMaxWidthWideNotifications: 96,
    chatBubbleMaxWidthWideNarrow: 92,
    chatFontPreset: 'system',
    chatFontCustom: '',
    chatCodeFontPreset: 'consolas',
    chatCodeFontCustom: '',
    chatDiaryFontPreset: 'serif',
    chatDiaryFontCustom: '',
    chatToolFontPreset: 'system',
    chatToolFontCustom: '',
    enableUserChatBubbleUi: true,
    showUserMetaInChatBubbleUi: true,
    voiceMode: 'local',
    speechRecognizerBrowserPath: '',
    speechRecognizerPagePath: 'Voicechatmodules/recognizer.html',
    voiceNetworkSettings: {
        sovitsUrl: 'https://api.siliconflow.cn',
        sovitsKey: ''
    },
    voiceLocalSettings: {
        providerUrl: '',
        providerKey: ''
    }
};
// Unified selected item state
let currentSelectedItem = {
    id: null, // Can be agentId or groupId
    type: null, // 'agent' or 'group'
    name: null,
    avatarUrl: null,
    config: null // Store full config object for the selected item
};
let currentTopicId = null;
let currentChatHistory = [];
window.__vcpRendererReady = false;
window.__vcpPendingTopicSelection = null;
const chatAPI = window.chatAPI || window.electronAPI;

// 暴露到window对象以便其他模块访问
window.currentSelectedItem = currentSelectedItem;
window.currentTopicId = currentTopicId;
let attachedFiles = [];
let audioContext = null;
let currentAudioSource = null;
let ttsAudioQueue = []; // 新增：TTS音频播放队列
let isTtsPlaying = false; // 新增：TTS播放状态标志
let currentPlayingMsgId = null; // 新增：跟踪当前播放的msgId以控制UI
let currentTtsSessionId = -1; // 新增：会话ID，用于处理异步时序问题

// --- DOM Elements ---
const itemListUl = document.getElementById('agentList'); // Renamed from agentListUl to itemListUl
const currentChatNameH3 = document.getElementById('currentChatAgentName'); // Will show Agent or Group name
const chatMessagesDiv = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendMessageBtn = document.getElementById('sendMessageBtn');
const attachFileBtn = document.getElementById('attachFileBtn');
const emoticonTriggerBtn = document.getElementById('emoticonTriggerBtn');
const quickNewTopicBtn = document.getElementById('quickNewTopicBtn');
const attachmentPreviewArea = document.getElementById('attachmentPreviewArea');
const chatInputCard = document.querySelector('.chat-input-card');

const globalSettingsBtn = document.getElementById('globalSettingsBtn');
// 模态框及其内部元素现在延迟加载，不再在顶层缓存引用
let globalSettingsForm = null;
let userAvatarInput = null;
let userAvatarPreview = null;

const createNewAgentBtn = document.getElementById('createNewAgentBtn'); // Text will change
const createNewGroupBtn = document.getElementById('createNewGroupBtn'); // New button

const itemSettingsContainerTitle = document.getElementById('agentSettingsContainerTitle'); // Will be itemSettingsContainerTitle
const selectedItemNameForSettingsSpan = document.getElementById('selectedAgentNameForSettings'); // Will show Agent or Group name

// Agent specific settings elements (will be hidden if a group is selected)
const agentSettingsContainer = document.getElementById('agentSettingsContainer');
const agentSettingsForm = document.getElementById('agentSettingsForm');
const editingAgentIdInput = document.getElementById('editingAgentId');
const agentNameInput = document.getElementById('agentNameInput');
const agentAvatarInput = document.getElementById('agentAvatarInput');
const agentAvatarPreview = document.getElementById('agentAvatarPreview');
const agentSystemPromptTextarea = document.getElementById('agentSystemPrompt');
const agentModelInput = document.getElementById('agentModel');
const agentTemperatureInput = document.getElementById('agentTemperature');
const agentContextTokenLimitInput = document.getElementById('agentContextTokenLimit');
const agentMaxOutputTokensInput = document.getElementById('agentMaxOutputTokens');

// Group specific settings elements (placeholder, grouprenderer.js will populate)
const groupSettingsContainer = document.getElementById('groupSettingsContainer'); // This should be the div renderer creates

const selectItemPromptForSettings = document.getElementById('selectAgentPromptForSettings'); // Will be "Select an item..."
console.log('[Renderer EARLY CHECK] selectItemPromptForSettings element:', selectItemPromptForSettings); // 添加日志
const deleteItemBtn = document.getElementById('deleteAgentBtn'); // Will be deleteItemBtn for agent or group

const currentItemActionBtn = document.getElementById('currentAgentSettingsBtn'); // Text will change (e.g. "New Topic" / "New Group Topic")
const clearCurrentChatBtn = document.getElementById('clearCurrentChatBtn');
const openForumBtn = document.getElementById('openForumBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const toggleNotificationsBtn = document.getElementById('toggleNotificationsBtn');

const notificationsSidebar = document.getElementById('notificationsSidebar');
const vcpLogConnectionStatusDiv = document.getElementById('vcpLogConnectionStatus');
const notificationsListUl = document.getElementById('notificationsList');
const clearNotificationsBtn = document.getElementById('clearNotificationsBtn');
const doNotDisturbBtn = document.getElementById('doNotDisturbBtn');

const sidebarTabButtons = document.querySelectorAll('.sidebar-tab-button');
const sidebarTabContents = document.querySelectorAll('.sidebar-tab-content');
const tabContentTopics = document.getElementById('tabContentTopics');
const tabContentSettings = document.getElementById('tabContentSettings');

const topicSearchInput = document.getElementById('topicSearchInput'); // Should be in tabContentTopics
const DEFAULT_SEND_BUTTON_HTML = sendMessageBtn?.innerHTML || '';
const INTERRUPT_SEND_BUTTON_HTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
        fill="none" stroke="none" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"></rect>
    </svg>
`;

function isContextForCurrentChat(context) {
    if (!context || !currentSelectedItem?.id || !currentTopicId) return false;
    const contextItemId = context.groupId || context.agentId;
    return contextItemId === currentSelectedItem.id && context.topicId === currentTopicId;
}

function getInterruptibleMessageForCurrentChat() {
    if (Array.isArray(currentChatHistory) && currentChatHistory.length > 0) {
        for (let i = currentChatHistory.length - 1; i >= 0; i--) {
            const message = currentChatHistory[i];
            if (!message || message.role !== 'assistant') continue;

            const messageItem = chatMessagesDiv?.querySelector(`.message-item[data-message-id="${message.id}"]`);
            const isStreaming = Boolean(messageItem?.classList.contains('streaming'));
            if (message.isThinking === true || isStreaming) {
                return { ...message, isStreaming };
            }
        }
    }

    const activeStreamingMessageId = window.streamManager?.getActiveStreamingMessageId?.();
    const activeStreamingContext = window.streamManager?.getActiveStreamingContext?.();
    if (!activeStreamingMessageId || !isContextForCurrentChat(activeStreamingContext)) {
        return null;
    }

    const activeStreamingMessage = currentChatHistory.find(
        (message) => message?.id === activeStreamingMessageId && message.role === 'assistant'
    );
    if (activeStreamingMessage) {
        return { ...activeStreamingMessage, isStreaming: true };
    }

    return {
        id: activeStreamingMessageId,
        role: 'assistant',
        name: activeStreamingContext.agentName || currentSelectedItem?.name || currentSelectedItem?.id,
        agentId: activeStreamingContext.agentId,
        groupId: activeStreamingContext.groupId,
        isGroupMessage: activeStreamingContext.isGroupMessage === true,
        avatarUrl: activeStreamingContext.avatarUrl || currentSelectedItem?.avatarUrl,
        avatarColor: activeStreamingContext.avatarColor || currentSelectedItem?.config?.avatarCalculatedColor,
        isStreaming: true
    };
}

function updateSendButtonState() {
    if (!sendMessageBtn) return;

    const nextMode = getInterruptibleMessageForCurrentChat() ? 'interrupt' : 'send';
    sendMessageBtn.dataset.mode = nextMode;
    sendMessageBtn.classList.toggle('interrupt-mode', nextMode === 'interrupt');
    sendMessageBtn.innerHTML = nextMode === 'interrupt' ? INTERRUPT_SEND_BUTTON_HTML : DEFAULT_SEND_BUTTON_HTML;
    sendMessageBtn.title = nextMode === 'interrupt' ? '中止回复' : '发送消息 (Ctrl+Enter)';
}

async function interruptActiveResponseFromSendButton() {
    const activeMessage = getInterruptibleMessageForCurrentChat();
    if (!activeMessage) return false;

    const isGroupMessage = activeMessage.isGroupMessage === true || currentSelectedItem?.type === 'group';
    const messageContext = {
        agentId: activeMessage.agentId || (isGroupMessage ? null : currentSelectedItem?.id),
        groupId: activeMessage.groupId || (isGroupMessage ? currentSelectedItem?.id : null),
        topicId: currentTopicId,
        isGroupMessage,
        agentName: activeMessage.name || currentSelectedItem?.name || currentSelectedItem?.id,
        avatarUrl: activeMessage.avatarUrl || currentSelectedItem?.avatarUrl,
        avatarColor: activeMessage.avatarColor || currentSelectedItem?.config?.avatarCalculatedColor
    };

    let result = { success: false, error: '无法发送中止请求。' };
    if (isGroupMessage) {
        if (chatAPI && typeof chatAPI.interruptGroupRequest === 'function') {
            result = await chatAPI.interruptGroupRequest(activeMessage.id);
        } else {
            result = { success: false, error: '群聊中止接口不可用。' };
        }
    } else if (interruptHandler && typeof interruptHandler.interrupt === 'function') {
        result = await interruptHandler.interrupt(activeMessage.id);
    }

    if (window.messageRenderer && typeof window.messageRenderer.finalizeStreamedMessage === 'function') {
        await window.messageRenderer.finalizeStreamedMessage(
            activeMessage.id,
            'cancelled_by_user',
            messageContext,
            { error: '用户已中止回复。' }
        );
    }

    updateSendButtonState();

    if (result.success) {
        uiHelperFunctions?.showToastNotification?.('已发送中止信号。', 'success');
        return true;
    }

    uiHelperFunctions?.showToastNotification?.(`中止失败：${result.error || '未知错误'}`, 'error');
    return true;
}

async function handleSendButtonAction() {
    if (getInterruptibleMessageForCurrentChat()) {
        await interruptActiveResponseFromSendButton();
        return;
    }

    if (window.chatManager && typeof window.chatManager.handleSendMessage === 'function') {
        await window.chatManager.handleSendMessage();
    }
}

window.updateSendButtonState = updateSendButtonState;
window.handleSendButtonAction = handleSendButtonAction;
updateSendButtonState();

const leftSidebar = document.querySelector('.sidebar');
const rightNotificationsSidebar = document.getElementById('notificationsSidebar');
const resizerLeft = document.getElementById('resizerLeft');
const resizerRight = document.getElementById('resizerRight');

const minimizeBtn = document.getElementById('minimize-btn');
const maximizeBtn = document.getElementById('maximize-btn');
const restoreBtn = document.getElementById('restore-btn');
const closeBtn = document.getElementById('close-btn');
const settingsBtn = document.getElementById('settings-btn'); // DevTools button
const minimizeToTrayBtn = document.getElementById('minimize-to-tray-btn');
const agentSearchInput = document.getElementById('agentSearchInput');

// Cropped file state is now managed within modules/ui-helpers.js

const notificationTitleElement = document.getElementById('notificationTitle');
const digitalClockElement = document.getElementById('digitalClock');
const dateDisplayElement = document.getElementById('dateDisplay');
let inviteAgentButtonsContainerElement; // 新增：邀请发言按钮容器的引用

// Assistant settings elements
const toggleAssistantBtn = document.getElementById('toggleAssistantBtn'); // New button
// 模态框内部元素延迟加载
let assistantAgentContainer = null;
let assistantAgentSelect = null;

// Model selection elements
const openModelSelectBtn = document.getElementById('openModelSelectBtn');
let modelSelectModal = null;
let modelList = null;
let modelSearchInput = null;
let refreshModelsBtn = null;

// UI Helper functions to be passed to modules
// The main uiHelperFunctions object is now defined in modules/ui-helpers.js
// We can reference it directly from the window object.
const uiHelperFunctions = window.uiHelperFunctions;


import searchManager from './modules/searchManager.js';
import { initialize as initializeEmoticonFixer } from './modules/renderer/emoticonUrlFixer.js';
import * as interruptHandler from './modules/interruptHandler.js';
 
import { setupEventListeners } from './modules/event-listeners.js';
 
 // --- Initialization ---
 document.addEventListener('DOMContentLoaded', async () => {
    // Initialize Emoticon Manager
    if (window.emoticonManager) {
        window.emoticonManager.initialize({
            emoticonPanel: document.getElementById('emoticonPanel'),
            messageInput: document.getElementById('messageInput'),
        });
    } else {
        console.error('[RENDERER_INIT] emoticonManager module not found!');
    }

    // 确保在GroupRenderer初始化之前，其容器已准备好
    uiHelperFunctions.prepareGroupSettingsDOM();
    inviteAgentButtonsContainerElement = document.getElementById('inviteAgentButtonsContainer'); // 新增：获取容器引用

    // Initialize ItemListManager first as other modules might depend on the item list
    if (window.itemListManager) {
        window.itemListManager.init({
            elements: {
                itemListUl: itemListUl,
            },
            electronAPI: chatAPI,
            refs: {
                currentSelectedItemRef: { get: () => currentSelectedItem },
            },
            mainRendererFunctions: {
                selectItem: (itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) => {
                    // Delayed binding - chatManager will be available when this is called
                    if (window.chatManager) {
                        return window.chatManager.selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig);
                    } else {
                        console.error('[ItemListManager] chatManager not available for selectItem');
                    }
                },
            },
            uiHelper: uiHelperFunctions // Pass the entire uiHelper object
        });
    } else {
        console.error('[RENDERER_INIT] itemListManager module not found!');
    }


    if (window.GroupRenderer) {
        const mainRendererElementsForGroupRenderer = {
            topicListUl: document.getElementById('topicList'),
            messageInput: messageInput,
            sendMessageBtn: sendMessageBtn,
            attachFileBtn: attachFileBtn,
            currentChatNameH3: currentChatNameH3,
            currentItemActionBtn: currentItemActionBtn,
            clearCurrentChatBtn: clearCurrentChatBtn,
            agentSettingsContainer: agentSettingsContainer,
            groupSettingsContainer: document.getElementById('groupSettingsContainer'),
            selectItemPromptForSettings: selectItemPromptForSettings, // 这个是我们关心的
            selectedItemNameForSettingsSpan: selectedItemNameForSettingsSpan, // 新增：传递这个引用
            itemListUl: itemListUl,
        };
        console.log('[Renderer PRE-INIT GroupRenderer] mainRendererElements to be passed:', mainRendererElementsForGroupRenderer);
        console.log('[Renderer PRE-INIT GroupRenderer] selectItemPromptForSettings within that object:', mainRendererElementsForGroupRenderer.selectItemPromptForSettings);

        window.GroupRenderer.init({
            electronAPI: chatAPI,
            globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
            currentSelectedItemRef: {
                get: () => currentSelectedItem,
                set: (val) => {
                    currentSelectedItem = val;
                    window.currentSelectedItem = val;
                }
            },
            currentTopicIdRef: {
                get: () => currentTopicId,
                set: (val) => {
                    currentTopicId = val;
                    window.currentTopicId = val;
                }
            },
            messageRenderer: window.messageRenderer, // Will be initialized later, pass ref
            uiHelper: uiHelperFunctions,
            mainRendererElements: mainRendererElementsForGroupRenderer, // 使用构造好的对象
            mainRendererFunctions: { // Pass shared functions with delayed binding
                loadItems: () => window.itemListManager ? window.itemListManager.loadItems() : console.error('[GroupRenderer] itemListManager not available'),
                selectItem: (itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) => {
                    if (window.chatManager) {
                        return window.chatManager.selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig);
                    } else {
                        console.error('[GroupRenderer] chatManager not available for selectItem');
                    }
                },
                highlightActiveItem: (itemId, itemType) => window.itemListManager ? window.itemListManager.highlightActiveItem(itemId, itemType) : console.error('[GroupRenderer] itemListManager not available'),
                displaySettingsForItem: () => window.settingsManager ? window.settingsManager.displaySettingsForItem() : console.error('[GroupRenderer] settingsManager not available'),
                loadTopicList: () => window.topicListManager ? window.topicListManager.loadTopicList() : console.error('[GroupRenderer] topicListManager not available'),
                getAttachedFiles: () => attachedFiles,
                clearAttachedFiles: () => { attachedFiles.length = 0; },
                updateAttachmentPreview: () => uiHelperFunctions.updateAttachmentPreview(attachedFiles, attachmentPreviewArea),
                setCroppedFile: uiHelperFunctions.setCroppedFile,
                getCroppedFile: uiHelperFunctions.getCroppedFile,
                setCurrentChatHistory: (history) => currentChatHistory = history,
                displayTopicTimestampBubble: (itemId, itemType, topicId) => {
                    if (window.chatManager) {
                        return window.chatManager.displayTopicTimestampBubble(itemId, itemType, topicId);
                    } else {
                        console.error('[GroupRenderer] chatManager not available for displayTopicTimestampBubble');
                    }
                },
                switchToTab: (tab) => window.uiManager ? window.uiManager.switchToTab(tab) : console.error('[GroupRenderer] uiManager not available'),
                // saveItemOrder is now in itemListManager
            },
            inviteAgentButtonsContainerRef: { get: () => inviteAgentButtonsContainerElement }, // 新增：传递引用
        });
        console.log('[Renderer POST-INIT GroupRenderer] window.GroupRenderer.init has been called.');
    } else {
        console.error('[RENDERER_INIT] GroupRenderer module not found!');
    }

    // Initialize other modules after GroupRenderer, in case they depend on its setup
    if (window.messageRenderer) {
        interruptHandler.initialize(chatAPI);

        window.messageRenderer.initializeMessageRenderer({
            currentChatHistoryRef: { get: () => currentChatHistory, set: (val) => currentChatHistory = val },
            currentSelectedItemRef: {
                get: () => currentSelectedItem,
                set: (val) => {
                    currentSelectedItem = val;
                    window.currentSelectedItem = val;
                }
            },
            currentTopicIdRef: {
                get: () => currentTopicId,
                set: (val) => {
                    currentTopicId = val;
                    window.currentTopicId = val;
                }
            },
            globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
            chatMessagesDiv: chatMessagesDiv,
            electronAPI: chatAPI,
            markedInstance: markedInstance, // Assuming marked.js is loaded
            uiHelper: uiHelperFunctions,
            interruptHandler: interruptHandler, // Pass the handler
            summarizeTopicFromMessages: (messages, agentName) => {
                // Directly use the function from the summarizer module, which should be on the window scope
                if (typeof window.summarizeTopicFromMessages === 'function') {
                    return window.summarizeTopicFromMessages(messages, agentName);
                } else {
                    console.error('[MessageRenderer] summarizeTopicFromMessages function not found on window scope.');
                    return `关于 "${messages.find(m=>m.role==='user')?.content.substring(0,15) || '...'}" (备用)`;
                }
            },
            handleCreateBranch: (selectedMessage) => {
                if (window.chatManager) {
                    return window.chatManager.handleCreateBranch(selectedMessage);
                } else {
                    console.error('[MessageRenderer] chatManager not available for handleCreateBranch');
                }
            }
        });

        // Pass the new function to the context menu
        window.messageRenderer.setContextMenuDependencies({
            showForwardModal: showForwardModal,
        });

    } else {
        console.error('[RENDERER_INIT] messageRenderer module not found!');
    }

    if (window.inputEnhancer) {
        window.inputEnhancer.initializeInputEnhancer({
            messageInput: messageInput,
            dropTargetElement: chatInputCard,
            electronAPI: chatAPI,
            attachedFiles: { get: () => attachedFiles, set: (val) => attachedFiles = val },
            updateAttachmentPreview: () => uiHelperFunctions.updateAttachmentPreview(attachedFiles, attachmentPreviewArea),
            getCurrentAgentId: () => currentSelectedItem.id, // Corrected: pass a function that returns the ID
            getCurrentTopicId: () => currentTopicId,
            uiHelper: uiHelperFunctions,
        });
    } else {
        console.error('[RENDERER_INIT] inputEnhancer module not found!');
    }


    chatAPI.onVCPLogStatus((statusUpdate) => {
        if (window.notificationRenderer) {
            window.notificationRenderer.updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv);
        }
    });
    chatAPI.onVCPLogMessage((logData) => {
        if (window.notificationRenderer) {
            const computedStyle = getComputedStyle(document.body);
            const themeColors = {
                notificationBg: computedStyle.getPropertyValue('--notification-bg').trim(),
                accentBg: computedStyle.getPropertyValue('--accent-bg').trim(),
                highlightText: computedStyle.getPropertyValue('--highlight-text').trim(),
                borderColor: computedStyle.getPropertyValue('--border-color').trim(),
                primaryText: computedStyle.getPropertyValue('--primary-text').trim(),
                secondaryText: computedStyle.getPropertyValue('--secondary-text').trim()
            };
            // 修复：只传递一个 logData 参数，第二个参数显式传递 null，以匹配 preload 定义
            window.notificationRenderer.renderVCPLogNotification(logData, null, notificationsListUl, themeColors);
        }
    });

    // Unified listener for all VCP stream events (agent and group)
    chatAPI.onVCPStreamEvent(async (eventData) => {
        if (!window.messageRenderer) {
            console.error("onVCPStreamEvent: messageRenderer not available.");
            return;
        }

        const { type, messageId, context, chunk, error, finish_reason, fullResponse } = eventData;

        if (!messageId) {
            console.error("onVCPStreamEvent: Received event without a messageId. Cannot process.", eventData);
            return;
        }

        // --- Asynchronous Logic: Update data model regardless of UI state ---
        // This is where you would update a global or context-specific data store
        // For now, we pass the context to the messageRenderer which handles the history array.

        // --- UI Logic: Only render if the message's context matches the current view ---
        // Directly use the global variables `currentSelectedItem` and `currentTopicId` from the renderer's scope.
        // The `...Ref` objects are not defined in this scope.
        const isRelevantToCurrentView = context &&
            currentSelectedItem && // Ensure currentSelectedItem is not null
            (context.groupId ? context.groupId === currentSelectedItem.id : context.agentId === currentSelectedItem.id) &&
            context.topicId === currentTopicId;

        // console.log(`[onVCPStreamEvent] Received event type '${type}' for msg ${messageId}. Relevant to current view: ${isRelevantToCurrentView}`, context);

        // Data model updates should ALWAYS happen, regardless of the current view.
        // UI updates (creating new DOM elements) should only happen if the view is relevant.
        switch (type) {
            case 'data':
                window.messageRenderer.appendStreamChunk(messageId, chunk, context);
                break;

            case 'end':
                window.messageRenderer.finalizeStreamedMessage(
                    messageId,
                    finish_reason || 'completed',
                    context,
                    { fullResponse, error }
                );
                if (context && !context.isGroupMessage) {
                    // This can run in the background
                    await window.chatManager.attemptTopicSummarizationIfNeeded();
                }
                
                // --- Flowlock: 检查是否需要自动触发续写 ---
                if (window.flowlockManager) {
                    const flowlockState = window.flowlockManager.getState();
                    console.log('[Flowlock] End event received. State:', flowlockState, 'isRelevantToCurrentView:', isRelevantToCurrentView);
                    
                    if (flowlockState.isActive && !flowlockState.isProcessing && isRelevantToCurrentView) {
                        console.log('[Flowlock] ✓ All conditions met, triggering continue writing...');
                        
                        // 使用全局设置中的延迟
                        const delaySeconds = globalSettings.flowlockContinueDelay !== undefined ? globalSettings.flowlockContinueDelay : 5;
                        const delayMilliseconds = delaySeconds * 1000;
                        console.log(`[Flowlock] Using delay of ${delaySeconds}s (${delayMilliseconds}ms)`);

                        // 延迟指定时间确保消息完全渲染，然后直接调用续写函数
                        setTimeout(() => {
                            if (window.flowlockManager && window.flowlockManager.getState().isActive) {
                                console.log('[Flowlock] Calling handleContinueWriting now...');
                                
                                // 触发心跳动画
                                const chatNameElement = document.getElementById('currentChatAgentName');
                                if (chatNameElement) {
                                    chatNameElement.classList.add('flowlock-heartbeat');
                                    // 动画结束后移除类
                                    setTimeout(() => {
                                        chatNameElement.classList.remove('flowlock-heartbeat');
                                    }, 800);
                                }
                                
                                // 获取输入框内容作为提示词
                                const messageInput = document.getElementById('messageInput');
                                const customPrompt = messageInput ? messageInput.value.trim() : '';
                                console.log('[Flowlock] Using custom prompt from input:', customPrompt || '(empty, will use default)');
                                
                                // 直接调用续写函数，使用输入框内容或空字符串（将使用默认提示词）
                                if (window.handleContinueWriting) {
                                    window.flowlockManager.isProcessing = true;
                                    window.handleContinueWriting(customPrompt).then(() => {
                                        console.log('[Flowlock] Continue writing completed');
                                        window.flowlockManager.isProcessing = false;
                                        window.flowlockManager.retryCount = 0; // 重置重试计数
                                    }).catch((error) => {
                                        console.error('[Flowlock] Continue writing failed:', error);
                                        window.flowlockManager.isProcessing = false;
                                        window.flowlockManager.retryCount++;
                                        
                                        if (window.flowlockManager.retryCount >= window.flowlockManager.maxRetries) {
                                            console.error('[Flowlock] Max retries reached, stopping flowlock');
                                            if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                                                window.uiHelperFunctions.showToastNotification('心流锁续写失败次数过多，已自动停止', 'error');
                                            }
                                            window.flowlockManager.stop();
                                        } else {
                                            console.log(`[Flowlock] Retry ${window.flowlockManager.retryCount}/${window.flowlockManager.maxRetries}`);
                                            if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                                                window.uiHelperFunctions.showToastNotification(`心流锁续写失败，正在重试 (${window.flowlockManager.retryCount}/${window.flowlockManager.maxRetries})`, 'warning');
                                            }
                                        }
                                    });
                                } else {
                                    console.error('[Flowlock] handleContinueWriting function not found!');
                                }
                            } else {
                                console.log('[Flowlock] Flowlock was stopped before timeout, skipping continue writing');
                            }
                        }, delayMilliseconds);
                    } else {
                        console.log('[Flowlock] Conditions not met:', {
                            isActive: flowlockState.isActive,
                            isProcessing: flowlockState.isProcessing,
                            isRelevantToCurrentView: isRelevantToCurrentView
                        });
                    }
                }
                break;

            case 'error':
                console.error('VCP Stream Error on ID', messageId, ':', error, 'Context:', context);
                
                // --- Recovery Logic: Use accumulated text from main if fullResponse is missing ---
                let finalContent = fullResponse || eventData.accumulatedResponse || "";
                if (finalContent && finalContent.trim() !== "") {
                    // Add a visual indicator that the stream was cut short
                    finalContent += "\n\n> [!WARNING]\n> **流式响应中断**: " + (error || "未知连接错误") + "。已保存已接收的部分内容。";
                }

                window.messageRenderer.finalizeStreamedMessage(
                    messageId,
                    'error',
                    context,
                    { fullResponse: finalContent, error }
                );
                
                // --- Flowlock: 处理错误情况，重置状态并可能触发下一次续写 ---
                if (window.flowlockManager) {
                    const flowlockState = window.flowlockManager.getState();
                    console.log('[Flowlock] Error event received. State:', flowlockState, 'isRelevantToCurrentView:', isRelevantToCurrentView);
                    
                    // 重置processing状态
                    if (window.flowlockManager.isProcessing) {
                        console.log('[Flowlock] Resetting isProcessing state due to error');
                        window.flowlockManager.isProcessing = false;
                    }
                    
                    // 如果心流锁仍然激活且相关，触发下一次续写（即使出错也继续）
                    if (flowlockState.isActive && isRelevantToCurrentView) {
                        console.log('[Flowlock] Flowlock still active after error, will trigger next continue writing');
                        
                        const errorDelaySeconds = globalSettings.flowlockContinueDelay !== undefined ? globalSettings.flowlockContinueDelay : 5;
                        const errorDelayMilliseconds = errorDelaySeconds * 1000;
                        console.log(`[Flowlock] Using error recovery delay of ${errorDelaySeconds}s (${errorDelayMilliseconds}ms)`);

                        setTimeout(() => {
                            if (window.flowlockManager && window.flowlockManager.getState().isActive) {
                                console.log('[Flowlock] Triggering continue writing after error...');
                                
                                // 触发心跳动画
                                const chatNameElement = document.getElementById('currentChatAgentName');
                                if (chatNameElement) {
                                    chatNameElement.classList.add('flowlock-heartbeat');
                                    setTimeout(() => {
                                        chatNameElement.classList.remove('flowlock-heartbeat');
                                    }, 800);
                                }
                                
                                // 获取输入框内容作为提示词
                                const messageInput = document.getElementById('messageInput');
                                const customPrompt = messageInput ? messageInput.value.trim() : '';
                                console.log('[Flowlock] Using custom prompt from input:', customPrompt || '(empty, will use default)');
                                
                                // 触发续写
                                if (window.handleContinueWriting) {
                                    window.flowlockManager.isProcessing = true;
                                    window.handleContinueWriting(customPrompt).then(() => {
                                        console.log('[Flowlock] Continue writing completed after error recovery');
                                        window.flowlockManager.isProcessing = false;
                                        window.flowlockManager.retryCount = 0;
                                    }).catch((error) => {
                                        console.error('[Flowlock] Continue writing failed after error recovery:', error);
                                        window.flowlockManager.isProcessing = false;
                                        window.flowlockManager.retryCount++;
                                        
                                        if (window.flowlockManager.retryCount >= window.flowlockManager.maxRetries) {
                                            console.error('[Flowlock] Max retries reached, stopping flowlock');
                                            if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                                                window.uiHelperFunctions.showToastNotification('心流锁续写失败次数过多，已自动停止', 'error');
                                            }
                                            window.flowlockManager.stop();
                                        }
                                    });
                                }
                            }
                        }, errorDelayMilliseconds);
                    }
                }
                
                if (isRelevantToCurrentView) {
                    const errorMsgItem = document.querySelector(`.message-item[data-message-id="${messageId}"] .md-content`);
                    if (errorMsgItem) {
                        errorMsgItem.innerHTML += `<p><strong style="color: red;">流错误: ${error}</strong></p>`;
                    } else {
                        window.messageRenderer.renderMessage({
                            role: 'system',
                            content: `流处理错误 (ID: ${messageId}): ${error}`,
                            timestamp: Date.now(),
                            id: `err_${messageId}`
                        });
                    }
                }
                break;
            
            // These events create new message bubbles, so they should only execute if the view is relevant.
            case 'agent_thinking':
                // Use startStreamingMessage for both visible and non-visible chats to ensure proper initialization
                console.log(`[Renderer onVCPStreamEvent AGENT_THINKING] Initializing streaming for ${context.agentName} (msgId: ${messageId})`);
                // 直接调用 streamManager 的 startStreamingMessage，它会处理所有初始化
                if (window.streamManager && typeof window.streamManager.startStreamingMessage === 'function') {
                    window.streamManager.startStreamingMessage({
                        id: messageId,
                        role: 'assistant',
                        name: context.agentName,
                        agentId: context.agentId,
                        avatarUrl: context.avatarUrl,
                        avatarColor: context.avatarColor,
                        content: '思考中...',
                        timestamp: Date.now(),
                        isThinking: true,
                        isGroupMessage: context.isGroupMessage || false,
                        groupId: context.groupId,
                        topicId: context.topicId,
                        context: context // Pass the full context
                    });
                } else if (window.messageRenderer && typeof window.messageRenderer.startStreamingMessage === 'function') {
                    // Fallback to messageRenderer if streamManager not available
                    window.messageRenderer.startStreamingMessage({
                        id: messageId,
                        role: 'assistant',
                        name: context.agentName,
                        agentId: context.agentId,
                        avatarUrl: context.avatarUrl,
                        avatarColor: context.avatarColor,
                        content: '思考中...',
                        timestamp: Date.now(),
                        isThinking: true,
                        isGroupMessage: context.isGroupMessage || false,
                        groupId: context.groupId,
                        topicId: context.topicId,
                        context: context
                    });
                }
                break;

            case 'start':
                // START事件时，思考消息应该已经存在了
                // 我们只需要确保消息已经初始化，如果没有则初始化
                console.log(`[Renderer onVCPStreamEvent START] Processing start event for ${context.agentName} (msgId: ${messageId})`);
                
                // 确保消息被初始化（如果agent_thinking被跳过）
                if (window.streamManager && typeof window.streamManager.startStreamingMessage === 'function') {
                    // streamManager 会检查消息是否已存在，避免重复初始化
                    window.streamManager.startStreamingMessage({
                        id: messageId,
                        role: 'assistant',
                        name: context.agentName,
                        agentId: context.agentId,
                        avatarUrl: context.avatarUrl,
                        avatarColor: context.avatarColor,
                        content: '',
                        timestamp: Date.now(),
                        isThinking: false,
                        isGroupMessage: context.isGroupMessage || false,
                        groupId: context.groupId,
                        topicId: context.topicId,
                        context: context
                    });
                } else if (window.messageRenderer && typeof window.messageRenderer.startStreamingMessage === 'function') {
                    window.messageRenderer.startStreamingMessage({
                        id: messageId,
                        role: 'assistant',
                        name: context.agentName,
                        agentId: context.agentId,
                        avatarUrl: context.avatarUrl,
                        avatarColor: context.avatarColor,
                        content: '',
                        timestamp: Date.now(),
                        isThinking: false,
                        isGroupMessage: context.isGroupMessage || false,
                        groupId: context.groupId,
                        topicId: context.topicId,
                        context: context
                    });
                }
                
                if (isRelevantToCurrentView) {
                     console.log(`[Renderer onVCPStreamEvent START] UI updated for visible chat ${context.agentName} (msgId: ${messageId})`);
                } else {
                    console.log(`[Renderer onVCPStreamEvent START] History updated for non-visible chat ${context.agentName} (msgId: ${messageId})`);
                }
                break;

            case 'full_response':
                // This also needs to update history unconditionally and render only if relevant.
                // `renderFullMessage` should handle this logic.
                if (isRelevantToCurrentView) {
                    console.log(`[Renderer onVCPStreamEvent FULL_RESPONSE] Rendering for ${context.agentName} (msgId: ${messageId})`);
                    window.messageRenderer.renderFullMessage(messageId, fullResponse, context.agentName, context.agentId);
                } else {
                    // If not relevant, we need a way to update the history without rendering.
                    // Let's assume `renderFullMessage` needs a flag or we need a new function.
                    // For now, let's add a placeholder to history.
                    console.log(`[Renderer onVCPStreamEvent FULL_RESPONSE] History update for non-visible chat needed for msgId: ${messageId}`);
                    // This part is tricky. The message might not exist in history yet.
                    // Let's ensure `renderFullMessage` can handle this.
                    window.messageRenderer.renderFullMessage(messageId, fullResponse, context.agentName, context.agentId);
                }
                break;

            case 'no_ai_response':
                 console.log(`[onVCPStreamEvent] No AI response needed for messageId: ${messageId}. Message: ${eventData.message}`);
                break;

            case 'remove_message':
                if (isRelevantToCurrentView) {
                    console.log(`[onVCPStreamEvent] Removing message ${messageId} from UI.`);
                    window.messageRenderer.removeMessageById(messageId, false); // false: don't save history again
                }
                break;

            default:
                console.warn(`[onVCPStreamEvent] Received unhandled event type: '${type}'`, eventData);
        }
    });

    // Listener for group topic title updates
    chatAPI.onVCPGroupTopicUpdated(async (eventData) => {
        const { groupId, topicId, newTitle, topics } = eventData;
        console.log(`[Renderer] Received topic update for group ${groupId}, topic ${topicId}: "${newTitle}"`);
        if (currentSelectedItem.id === groupId && currentSelectedItem.type === 'group') {
            // Update the currentSelectedItem's config if it's the active group
            const config = currentSelectedItem.config || currentSelectedItem;
            if (config && config.topics) {
                const topicIndex = config.topics.findIndex(t => t.id === topicId);
                if (topicIndex !== -1) {
                    config.topics[topicIndex].name = newTitle;
                } else { // Topic might be new or ID changed, replace topics array
                    config.topics = topics;
                }
            } else if (config) {
                config.topics = topics;
            }


            // If the topics tab is active, reload the list
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                await window.topicListManager.loadTopicList();
            }
            // Removed toast notification as per user feedback
            // if (uiHelperFunctions && uiHelperFunctions.showToastNotification) {
            //      uiHelperFunctions.showToastNotification(`群组 "${currentSelectedItem.name}" 的话题 "${newTitle}" 已自动总结并更新。`);
            // }
            console.log(`群组 "${currentSelectedItem.name}" 的话题 "${newTitle}" 已自动总结并更新 (通知已移除).`);
        }
    });


    // Initialize TopicListManager
    if (window.topicListManager) {
        window.topicListManager.init({
            elements: {
                topicListContainer: tabContentTopics,
            },
            electronAPI: chatAPI,
            refs: {
                currentSelectedItemRef: {
                    get: () => currentSelectedItem
                },
                currentTopicIdRef: {
                    get: () => currentTopicId
                },
            },
            uiHelper: uiHelperFunctions,
            mainRendererFunctions: {
                updateCurrentItemConfig: (newConfig) => {
                    if (currentSelectedItem.config) {
                        currentSelectedItem.config = newConfig;
                    } else {
                        Object.assign(currentSelectedItem, newConfig);
                    }
                },
                handleTopicDeletion: (remainingTopics) => {
                    if (window.chatManager) {
                        return window.chatManager.handleTopicDeletion(remainingTopics);
                    } else {
                        console.error('[TopicListManager] chatManager not available for handleTopicDeletion');
                    }
                },
                selectTopic: (topicId) => {
                    if (window.chatManager) {
                        return window.chatManager.selectTopic(topicId);
                    } else {
                        console.error('[TopicListManager] chatManager not available for selectTopic');
                    }
                },
            }
        });
    } else {
        console.error('[RENDERER_INIT] topicListManager module not found!');
    }

    // Initialize ChatManager
    if (window.chatManager) {
        window.chatManager.init({
            electronAPI: chatAPI,
            uiHelper: uiHelperFunctions,
            modules: {
                messageRenderer: window.messageRenderer,
                itemListManager: window.itemListManager,
                topicListManager: window.topicListManager,
                groupRenderer: window.GroupRenderer,
            },
            refs: {
                currentSelectedItemRef: {
                    get: () => currentSelectedItem,
                    set: (val) => {
                        currentSelectedItem = val;
                        window.currentSelectedItem = val;
                    }
                },
                currentTopicIdRef: {
                    get: () => currentTopicId,
                    set: (val) => {
                        currentTopicId = val;
                        window.currentTopicId = val;
                    }
                },
                currentChatHistoryRef: { get: () => currentChatHistory, set: (val) => currentChatHistory = val },
                attachedFilesRef: { get: () => attachedFiles, set: (val) => attachedFiles = val },
                globalSettingsRef: { get: () => globalSettings },
            },
            elements: {
                chatMessagesDiv: chatMessagesDiv,
                currentChatNameH3: currentChatNameH3,
                currentItemActionBtn: currentItemActionBtn,
                clearCurrentChatBtn: clearCurrentChatBtn,
                messageInput: messageInput,
                sendMessageBtn: sendMessageBtn,
                attachFileBtn: attachFileBtn,
            },
            mainRendererFunctions: {
                displaySettingsForItem: () => window.settingsManager.displaySettingsForItem(),
                updateAttachmentPreview: () => uiHelperFunctions.updateAttachmentPreview(attachedFiles, attachmentPreviewArea),
                // This is no longer needed as chatManager will call messageRenderer's summarizer
            }
        });
    } else {
        console.error('[RENDERER_INIT] chatManager module not found!');
    }


    // Initialize Settings Manager
    if (window.settingsManager) {
        window.settingsManager.init({
            electronAPI: chatAPI,
            uiHelper: uiHelperFunctions,
            refs: {
                currentSelectedItemRef: {
                    get: () => currentSelectedItem,
                    set: (val) => {
                        currentSelectedItem = val;
                        window.currentSelectedItem = val;
                    }
                },
                currentTopicIdRef: {
                    get: () => currentTopicId,
                    set: (val) => {
                        currentTopicId = val;
                        window.currentTopicId = val;
                    }
                },
                currentChatHistoryRef: { get: () => currentChatHistory, set: (val) => currentChatHistory = val },
            },
            elements: {
                agentSettingsContainer: document.getElementById('agentSettingsContainer'),
                groupSettingsContainer: document.getElementById('groupSettingsContainer'),
                selectItemPromptForSettings: document.getElementById('selectAgentPromptForSettings'),
                itemSettingsContainerTitle: document.getElementById('agentSettingsContainerTitle'),
                selectedItemNameForSettingsSpan: document.getElementById('selectedAgentNameForSettings'),
                deleteItemBtn: document.getElementById('deleteAgentBtn'),
                agentSettingsForm: document.getElementById('agentSettingsForm'),
                editingAgentIdInput: document.getElementById('editingAgentId'),
                agentNameInput: document.getElementById('agentNameInput'),
                agentAvatarInput: document.getElementById('agentAvatarInput'),
                agentAvatarPreview: document.getElementById('agentAvatarPreview'),
                // agentSystemPromptTextarea removed - now using PromptManager
                agentModelInput: document.getElementById('agentModel'),
                agentTemperatureInput: document.getElementById('agentTemperature'),
                agentContextTokenLimitInput: document.getElementById('agentContextTokenLimit'),
                agentMaxOutputTokensInput: document.getElementById('agentMaxOutputTokens'),
                // Model selection elements
                openModelSelectBtn: openModelSelectBtn,
                modelSelectModal: modelSelectModal,
                modelList: modelList,
                modelSearchInput: modelSearchInput,
                refreshModelsBtn: refreshModelsBtn,
                topicSummaryModelInput: document.getElementById('topicSummaryModel'),
                openTopicSummaryModelSelectBtn: document.getElementById('openTopicSummaryModelSelectBtn'),
                // TTS Elements
                agentTtsVoiceSelect: document.getElementById('agentTtsVoice'),
                refreshTtsModelsBtn: document.getElementById('refreshTtsModelsBtn'),
                agentTtsSpeedSlider: document.getElementById('agentTtsSpeed'),
                ttsSpeedValueSpan: document.getElementById('ttsSpeedValue'),
            },
            mainRendererFunctions: {
                setCroppedFile: uiHelperFunctions.setCroppedFile,
                getCroppedFile: uiHelperFunctions.getCroppedFile,
                updateChatHeader: (text) => { if (currentChatNameH3) currentChatNameH3.textContent = text; },
                onItemDeleted: async () => {
                    window.chatManager.displayNoItemSelected();
                    await window.itemListManager.loadItems();
                }
            }
        });

        // Pre-warm PromptManager to avoid first-click delay (Singleton Pattern)
        if (window.settingsManager.prewarmPromptManager) {
            window.settingsManager.prewarmPromptManager();
        }
    } else {
        console.error('[RENDERER_INIT] settingsManager module not found!');
    }

    try {
        await loadAndApplyGlobalSettings();
        await window.itemListManager.loadItems(); // Load both agents and groups

        // Initialize UI Manager after settings are loaded to ensure correct theme, widths, etc.
        if (window.uiManager) {
            await window.uiManager.init({
                electronAPI: chatAPI,
                refs: {
                    globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
                },
                elements: {
                    leftSidebar: document.querySelector('.sidebar'),
                    rightNotificationsSidebar: document.getElementById('notificationsSidebar'),
                    resizerLeft: document.getElementById('resizerLeft'),
                    resizerRight: document.getElementById('resizerRight'),
                    minimizeBtn: document.getElementById('minimize-btn'),
                    maximizeBtn: document.getElementById('maximize-btn'),
                    restoreBtn: document.getElementById('restore-btn'),
                    closeBtn: document.getElementById('close-btn'),
                    settingsBtn: document.getElementById('settings-btn'),
                    themeToggleBtn: document.getElementById('themeToggleBtn'),
                    digitalClockElement: document.getElementById('digitalClock'),
                    dateDisplayElement: document.getElementById('dateDisplay'),
                    notificationTitleElement: document.getElementById('notificationTitle'),
                    sidebarTabButtons: sidebarTabButtons,
                    sidebarTabContents: sidebarTabContents,
                }
            });
        } else {
            console.error('[RENDERER_INIT] uiManager module not found!');
        }

        // Initialize Filter Manager
        if (window.filterManager) {
            window.filterManager.init({
                electronAPI: chatAPI,
                uiHelper: uiHelperFunctions,
                refs: {
                    globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
                }
            });
        } else {
            console.error('[RENDERER_INIT] filterManager module not found!');
        }

        setupEventListeners({
            chatMessagesDiv, sendMessageBtn, messageInput, attachFileBtn, globalSettingsBtn,
            globalSettingsForm, userAvatarInput, createNewAgentBtn, createNewGroupBtn,
            currentItemActionBtn, clearNotificationsBtn, openForumBtn, toggleNotificationsBtn,
            notificationsSidebar, agentSearchInput, minimizeToTrayBtn, leftSidebar,
            openTranslatorBtn: document.getElementById('openTranslatorBtn'),
            openNotesBtn: document.getElementById('openNotesBtn'),
            openMusicBtn: document.getElementById('openMusicBtn'),
            openCanvasBtn: document.getElementById('openCanvasBtn'),
            toggleAssistantBtn,
            voiceChatBtn: document.getElementById('voiceChatBtn'),
            enableContextSanitizerCheckbox: document.getElementById('enableContextSanitizer'),
            contextSanitizerDepthContainer: document.getElementById('contextSanitizerDepthContainer'),
            seamFixer: document.getElementById('title-bar-seam-fixer'),
            addNetworkPathBtn: document.getElementById('addNetworkPathBtn'),
            refs: {
                currentSelectedItem: { get: () => currentSelectedItem },
                currentTopicId: { get: () => currentTopicId },
                globalSettings: { get: () => globalSettings },
                attachedFiles: { get: () => attachedFiles, set: (val) => attachedFiles = val },
                currentChatHistory: { get: () => currentChatHistory, set: (val) => currentChatHistory = val },
            },
            uiHelperFunctions,
            chatManager: window.chatManager,
            itemListManager: window.itemListManager,
            settingsManager: window.settingsManager,
            uiManager: window.uiManager,
            topicListManager: window.topicListManager,
            getCroppedFile: uiHelperFunctions.getCroppedFile,
            setCroppedFile: uiHelperFunctions.setCroppedFile,
            updateAttachmentPreview: () => uiHelperFunctions.updateAttachmentPreview(attachedFiles, attachmentPreviewArea),
            filterAgentList: uiHelperFunctions.filterAgentList,
            addNetworkPathInput: uiHelperFunctions.addNetworkPathInput
        });

        // Emoticon panel event listener
        if (attachFileBtn && emoticonTriggerBtn && window.emoticonManager) {
            const syncEmoticonTriggerButton = () => {
                emoticonTriggerBtn.disabled = attachFileBtn.disabled;
            };

            const openEmoticonPanel = (e) => {
                e.preventDefault();
                if (emoticonTriggerBtn.disabled) return;
                window.emoticonManager.togglePanel(emoticonTriggerBtn);
            };

            emoticonTriggerBtn.addEventListener('click', openEmoticonPanel);
            emoticonTriggerBtn.addEventListener('contextmenu', openEmoticonPanel);

            const emoticonTriggerObserver = new MutationObserver(syncEmoticonTriggerButton);
            emoticonTriggerObserver.observe(attachFileBtn, {
                attributes: true,
                attributeFilter: ['disabled']
            });

            syncEmoticonTriggerButton();
        }

        window.topicListManager.setupTopicSearch(); // Ensure this is called after DOM for topic search input is ready
        if(messageInput) uiHelperFunctions.autoResizeTextarea(messageInput);

        if (quickNewTopicBtn && currentItemActionBtn) {
            const syncQuickNewTopicButton = () => {
                const isVisible = window.getComputedStyle(currentItemActionBtn).display !== 'none';
                const buttonLabel = currentItemActionBtn.querySelector('.button-label')?.textContent?.trim();

                quickNewTopicBtn.style.display = 'inline-flex';
                quickNewTopicBtn.disabled = !isVisible;
                quickNewTopicBtn.title = currentItemActionBtn.title || '新建聊天话题';

                if (buttonLabel) {
                    quickNewTopicBtn.setAttribute('aria-label', buttonLabel);
                }
            };

            const forwardCurrentItemAction = (eventName) => {
                if (quickNewTopicBtn.disabled) return;
                currentItemActionBtn.dispatchEvent(new MouseEvent(eventName, {
                    bubbles: true,
                    cancelable: true,
                    view: window
                }));
            };

            quickNewTopicBtn.addEventListener('click', () => forwardCurrentItemAction('click'));
            quickNewTopicBtn.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                forwardCurrentItemAction('contextmenu');
            });

            const quickTopicObserver = new MutationObserver(syncQuickNewTopicButton);
            quickTopicObserver.observe(currentItemActionBtn, {
                attributes: true,
                attributeFilter: ['style', 'title'],
                childList: true,
                subtree: true,
                characterData: true
            });

            syncQuickNewTopicButton();
        }

        // Set default view if no item is selected
        if (!currentSelectedItem.id) {
            window.chatManager.displayNoItemSelected();
        }
 
        // Initialize Search Manager
        if (searchManager) {
            searchManager.init({
                electronAPI: chatAPI,
                uiHelper: uiHelperFunctions,
                refs: {
                    currentSelectedItemRef: { get: () => currentSelectedItem },
                },
                modules: {
                    chatManager: window.chatManager,
                }
            });
        } else {
            console.error('[RENDERER_INIT] searchManager module not found!');
        }

       // Emoticon URL fixer is now initialized within messageRenderer
        window.__vcpRendererReady = true;

        chatAPI.toggleSelectionListener(!!globalSettings.assistantEnabled);

        if (window.__vcpPendingTopicSelection && window.chatManager) {
            const pending = window.__vcpPendingTopicSelection;
            window.__vcpPendingTopicSelection = null;
            const matchesCurrentItem =
                currentSelectedItem &&
                currentSelectedItem.id === pending.itemId &&
                currentSelectedItem.type === pending.itemType;

            if (matchesCurrentItem) {
                Promise.resolve(window.chatManager.selectTopic(pending.topicId)).catch((error) => {
                    console.error('[Renderer] Failed to replay pending topic selection:', error);
                });
            }
        }
    } catch (error) {
        window.__vcpRendererReady = false;
        console.error('Error during DOMContentLoaded initialization:', error);
        chatMessagesDiv.innerHTML = `<div class="message-item system">初始化失败: ${error.message}</div>`;
    }

    console.log('[Renderer DOMContentLoaded END] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
    
    // --- Agent Settings Reload Listener ---
    if (chatAPI?.onReloadAgentSettings) {
        chatAPI.onReloadAgentSettings(async ({ agentId }) => {
            console.log('[Renderer] Received reload-agent-settings event for agent:', agentId);
            if (window.settingsManager && typeof window.settingsManager.reloadAgentSettings === 'function') {
                const result = await window.settingsManager.reloadAgentSettings(agentId);
                if (result.success && !result.skipped) {
                    console.log('[Renderer] Agent settings reloaded successfully');
                    uiHelperFunctions.showToastNotification('设置已自动更新', 'success');
                } else if (result.skipped) {
                    console.log('[Renderer] Agent settings reload skipped (not currently editing)');
                }
            }
        });
        console.log('[Renderer] Agent settings reload listener initialized');
    }
    
    // --- TTS Audio Playback and Visuals ---
    setupTtsListeners();
    // --- File Watcher Listener ---
    chatAPI.onHistoryFileUpdated(({ agentId, topicId, path }) => {
        if (currentSelectedItem && currentSelectedItem.id === agentId && currentTopicId === topicId) {
            console.log('[Renderer] Active chat history was modified externally. Syncing...');
            uiHelperFunctions.showToastNotification("聊天记录已同步。", "info");
            if (window.chatManager && typeof window.chatManager.syncHistoryFromFile === 'function') {
                window.chatManager.syncHistoryFromFile(agentId, currentSelectedItem.type, topicId);
            }
        }
    });

    // --- Initialize Flowlock Module ---
    if (window.initializeFlowlockIntegration) {
        window.initializeFlowlockIntegration();
        console.log('[Renderer] Flowlock integration initialized.');
    } else {
        console.warn('[Renderer] Flowlock integration function not found.');
    }

    // --- Listen for Flowlock commands from plugins (via main process) ---
    if (chatAPI?.onFlowlockCommand) {
        const respondToFlowlockRequest = (commandData, responseData) => {
            if (!commandData?.requestId || !chatAPI?.sendFlowlockRpcResponse) {
                return;
            }

            chatAPI.sendFlowlockRpcResponse({
                requestId: commandData.requestId,
                ok: responseData?.success !== false,
                data: responseData?.success === false ? undefined : responseData,
                error: responseData?.success === false ? responseData.error : undefined,
            });
        };

        const flowlockCommandHandler = async (commandData) => {
            console.log('[Renderer] Received flowlock command from plugin:', commandData);
            
            if (!window.flowlockManager) {
                console.error('[Renderer] flowlockManager not available');
                respondToFlowlockRequest(commandData, {
                    command: commandData?.command,
                    success: false,
                    error: 'flowlockManager not available'
                });
                return;
            }
            
            const { command, agentId, topicId, prompt, promptSource } = commandData;
            
            try {
                switch (command) {
                    case 'start':
                        // Start flowlock for the specified agent and topic
                        if (agentId && topicId) {
                            await window.flowlockManager.start(agentId, topicId, false);
                            console.log(`[Renderer] Flowlock started for agent: ${agentId}, topic: ${topicId}`);
                        } else {
                            console.error('[Renderer] Missing agentId or topicId for start command');
                        }
                        break;
                        
                    case 'stop':
                        // Stop flowlock
                        await window.flowlockManager.stop();
                        console.log('[Renderer] Flowlock stopped');
                        break;
                        
                    case 'promptee':
                        // Set custom prompt and append to input
                        if (prompt) {
                            const messageInput = document.getElementById('messageInput');
                            if (messageInput) {
                                const currentValue = messageInput.value;
                                messageInput.value = currentValue + (currentValue ? ' ' : '') + prompt;
                                console.log(`[Renderer] Prompt appended to input: "${prompt}"`);
                                // Auto-resize textarea after content change
                                if (window.uiHelperFunctions && window.uiHelperFunctions.autoResizeTextarea) {
                                    window.uiHelperFunctions.autoResizeTextarea(messageInput);
                                }
                            }
                        } else {
                            console.error('[Renderer] Missing prompt for promptee command');
                        }
                        break;
                        
                    case 'prompter':
                        // Get content from external source and append to input
                        if (promptSource) {
                            // TODO: Implement fetching from external source
                            // For now, just log the source
                            console.log(`[Renderer] Prompter source: ${promptSource}`);
                            // Placeholder: treat promptSource as the actual prompt for now
                            const messageInput = document.getElementById('messageInput');
                            if (messageInput) {
                                const currentValue = messageInput.value;
                                messageInput.value = currentValue + (currentValue ? ' ' : '') + `[来自: ${promptSource}]`;
                                console.log(`[Renderer] Prompter content appended from source: ${promptSource}`);
                                // Auto-resize textarea after content change
                                if (window.uiHelperFunctions && window.uiHelperFunctions.autoResizeTextarea) {
                                    window.uiHelperFunctions.autoResizeTextarea(messageInput);
                                }
                            }
                        } else {
                            console.error('[Renderer] Missing promptSource for prompter command');
                        }
                        break;
                        
                    case 'clear':
                        // Clear all content in input box
                        {
                            const messageInput = document.getElementById('messageInput');
                            if (messageInput) {
                                messageInput.value = '';
                                console.log('[Renderer] Input box cleared');
                                // Auto-resize textarea after content change
                                if (window.uiHelperFunctions && window.uiHelperFunctions.autoResizeTextarea) {
                                    window.uiHelperFunctions.autoResizeTextarea(messageInput);
                                }
                            }
                        }
                        break;
                        
                    case 'remove':
                        // Remove specific text from input
                        {
                            const { target } = commandData;
                            if (target) {
                                const messageInput = document.getElementById('messageInput');
                                if (messageInput) {
                                    const currentValue = messageInput.value;
                                    // Remove all occurrences of target text
                                    messageInput.value = currentValue.split(target).join('');
                                    console.log(`[Renderer] Removed "${target}" from input`);
                                    // Auto-resize textarea after content change
                                    if (window.uiHelperFunctions && window.uiHelperFunctions.autoResizeTextarea) {
                                        window.uiHelperFunctions.autoResizeTextarea(messageInput);
                                    }
                                }
                            } else {
                                console.error('[Renderer] Missing target for remove command');
                            }
                        }
                        break;
                        
                    case 'edit':
                        // Edit (diff) specific text in input - find oldText and replace with newText
                        {
                            const { oldText, newText } = commandData;
                            if (oldText && newText !== undefined) {
                                const messageInput = document.getElementById('messageInput');
                                if (messageInput) {
                                    const currentValue = messageInput.value;
                                    // Replace first occurrence only (diff-style)
                                    const index = currentValue.indexOf(oldText);
                                    if (index !== -1) {
                                        messageInput.value = currentValue.substring(0, index) + newText + currentValue.substring(index + oldText.length);
                                        console.log(`[Renderer] Edited text: "${oldText}" → "${newText}"`);
                                        // Auto-resize textarea after content change
                                        if (window.uiHelperFunctions && window.uiHelperFunctions.autoResizeTextarea) {
                                            window.uiHelperFunctions.autoResizeTextarea(messageInput);
                                        }
                                    } else {
                                        console.warn(`[Renderer] oldText "${oldText}" not found in input`);
                                    }
                                }
                            } else {
                                console.error('[Renderer] Missing oldText or newText for edit command');
                            }
                        }
                        break;
                        
                    case 'get':
                        // Get current input box content and return it
                        {
                            const messageInput = document.getElementById('messageInput');
                            if (messageInput) {
                                const content = messageInput.value;
                                console.log(`[Renderer] Retrieved input box content: "${content}"`);
                                respondToFlowlockRequest(commandData, {
                                    command: 'get',
                                    success: true,
                                    content: content
                                });
                            } else {
                                console.error('[Renderer] Message input element not found');
                                respondToFlowlockRequest(commandData, {
                                    command: 'get',
                                    success: false,
                                    error: 'Message input element not found'
                                });
                            }
                        }
                        break;
                        
                    case 'status':
                        // Get current flowlock status and return it
                        {
                            if (window.flowlockManager) {
                                const state = window.flowlockManager.getState();
                                console.log(`[Renderer] Retrieved flowlock status:`, state);
                                respondToFlowlockRequest(commandData, {
                                    command: 'status',
                                    success: true,
                                    status: {
                                        isActive: state.isActive,
                                        isProcessing: state.isProcessing,
                                        agentId: state.agentId,
                                        topicId: state.topicId
                                    }
                                });
                            } else {
                                console.error('[Renderer] flowlockManager not available');
                                respondToFlowlockRequest(commandData, {
                                    command: 'status',
                                    success: false,
                                    error: 'flowlockManager not available'
                                });
                            }
                        }
                        break;
                        
                    default:
                        console.error(`[Renderer] Unknown flowlock command: ${command}`);
                }
            } catch (error) {
                console.error('[Renderer] Error executing flowlock command:', error);
            }
        };

        chatAPI.onFlowlockCommand(flowlockCommandHandler);
        if (chatAPI.onFlowlockRequest) {
            chatAPI.onFlowlockRequest(flowlockCommandHandler);
        }
        console.log('[Renderer] Flowlock command listener initialized');
    }

});

function setupTtsListeners() {
    // This function is now called from ensureAudioContext, not on body events
    const initAudioContext = () => {
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log("[TTS Renderer] AudioContext initialized successfully.");
                return true;
            } catch (e) {
                console.error("[TTS Renderer] Failed to initialize AudioContext:", e);
                uiHelperFunctions.showToastNotification("无法初始化音频播放器。", "error");
                return false;
            }
        }
        return true;
    };

    // Expose a function to be called on demand
    window.ensureAudioContext = initAudioContext;

    // 新的TTS播放逻辑：使用sessionId来处理异步时序问题
    chatAPI.onPlayTtsAudio(async ({ audioData, msgId, sessionId }) => {
        // 如果收到的sessionId小于当前的，说明是过时的事件，直接忽略
        if (sessionId < currentTtsSessionId) {
            console.log(`[TTS Renderer] Discarding stale audio data from old session ${sessionId}. Current session is ${currentTtsSessionId}.`);
            return;
        }

        // 如果sessionId大于当前的，说明是一个全新的播放请求
        if (sessionId > currentTtsSessionId) {
            console.log(`[TTS Renderer] New TTS session ${sessionId} started. Clearing old queue.`);
            currentTtsSessionId = sessionId;
            // 清空队列，扔掉所有可能属于更旧会话的音频块
            ttsAudioQueue = [];
        }
        
        // 只有当sessionId匹配时，才将音频加入队列
        console.log(`[TTS Renderer] Received audio data for msgId ${msgId} (session ${sessionId}). Pushing to queue.`);
        if (!audioContext) {
            console.warn("[TTS Renderer] AudioContext not initialized. Buffering audio but cannot play yet.");
        }
        ttsAudioQueue.push({ audioData, msgId });
        processTtsQueue(); // 尝试处理队列
    });

    async function processTtsQueue() {
        if (isTtsPlaying || ttsAudioQueue.length === 0) {
            // 如果队列为空且没有在播放，确保关闭所有动画
            if (!isTtsPlaying && currentPlayingMsgId) {
                uiHelperFunctions.updateSpeakingIndicator(currentPlayingMsgId, false);
                currentPlayingMsgId = null;
            }
            return;
        }

        if (!audioContext) {
            console.warn("[TTS Renderer] AudioContext not ready. Waiting to process TTS queue.");
            return;
        }

        isTtsPlaying = true;
        const { audioData, msgId } = ttsAudioQueue.shift();

        // 更新UI动画
        if (currentPlayingMsgId !== msgId) {
            // 关闭上一个正在播放的动画（如果有）
            if (currentPlayingMsgId) {
                uiHelperFunctions.updateSpeakingIndicator(currentPlayingMsgId, false);
            }
            // 开启当前新的动画
            currentPlayingMsgId = msgId;
            uiHelperFunctions.updateSpeakingIndicator(currentPlayingMsgId, true);
        }

        try {
            const audioBuffer = await audioContext.decodeAudioData(
                Uint8Array.from(atob(audioData), c => c.charCodeAt(0)).buffer
            );

            // 关键修复：在异步解码后，再次检查停止标志，防止竞态条件
            if (!isTtsPlaying) {
                console.log("[TTS Renderer] Stop command received during audio decoding. Aborting playback.");
                // onStopTtsAudio已经处理了状态重置，这里只需中止即可
                return;
            }
            
            currentAudioSource = audioContext.createBufferSource();
            currentAudioSource.buffer = audioBuffer;
            currentAudioSource.connect(audioContext.destination);
            
            currentAudioSource.onended = () => {
                console.log(`[TTS Renderer] Playback finished for a chunk of msgId ${msgId}.`);
                isTtsPlaying = false;
                currentAudioSource = null;
                processTtsQueue(); // 播放下一个
            };

            currentAudioSource.start(0);
            console.log(`[TTS Renderer] Starting playback for a chunk of msgId ${msgId}.`);

        } catch (error) {
            console.error("[TTS Renderer] Error decoding or playing TTS audio from queue:", error);
            uiHelperFunctions.showToastNotification(`播放音频失败: ${error.message}`, "error");
            isTtsPlaying = false;
            processTtsQueue(); // 即使失败也尝试处理下一个
        }
    }

    chatAPI.onStopTtsAudio(() => {
        console.error("!!!!!!!!!! [TTS RENDERER] STOP EVENT RECEIVED !!!!!!!!!!");
        
        // 关键：增加会话ID，使所有后续到达的、属于旧会话的play-tts-audio事件全部失效
        currentTtsSessionId++;
        console.log(`[TTS Renderer] Stop event incremented session ID to ${currentTtsSessionId}.`);

        console.log("Clearing TTS queue, stopping current audio source, and resetting state.");
        
        ttsAudioQueue = []; // 1. 清空前端队列
        
        if (currentAudioSource) {
            console.log("Found active audio source. Stopping it now.");
            currentAudioSource.onended = null; // 2. 阻止onended回调
            currentAudioSource.stop();        // 3. 停止当前音频
            currentAudioSource = null;
        } else {
            console.warn("Stop event received, but no active audio source was found.");
        }
        
        isTtsPlaying = false; // 4. 重置播放状态标志

        // 5. 确保关闭当前的播放动画
        if (currentPlayingMsgId) {
            console.log(`Closing speaking indicator for message ID: ${currentPlayingMsgId}`);
            uiHelperFunctions.updateSpeakingIndicator(currentPlayingMsgId, false);
            currentPlayingMsgId = null;
        }
    });

    // 移除旧的 onSovitsStatusChanged 监听器，因为它不再准确
    // window.electronAPI.onSovitsStatusChanged(...)

    // This function has been moved to modules/ui-helpers.js
}

// This function has been moved to modules/ui-helpers.js


async function loadAndApplyGlobalSettings() {
    const settings = await chatAPI.loadSettings();
    if (settings && !settings.error) {
        globalSettings = { ...globalSettings, ...settings }; // Merge with defaults
        window.globalSettings = globalSettings;
        applyChatBubbleLayoutSettings(globalSettings);
        
        // 🟢 优化：仅更新始终存在的 UI 元素
        if (globalSettings.sidebarWidth && leftSidebar) {
            leftSidebar.style.width = `${globalSettings.sidebarWidth}px`;
        }
        if (globalSettings.notificationsSidebarWidth && rightNotificationsSidebar) {
            if (rightNotificationsSidebar.classList.contains('active')) {
                rightNotificationsSidebar.style.width = `${globalSettings.notificationsSidebarWidth}px`;
            }
        }

        if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'connecting', message: '连接中...' }, vcpLogConnectionStatusDiv);
            chatAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
        } else {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
        }

        // Set the initial state of the new toggle button in the main UI
        if (toggleAssistantBtn) {
            toggleAssistantBtn.classList.toggle('active', !!globalSettings.assistantEnabled);
        }
        // Selection listener startup moved to post-renderer-ready stage.

        // Load filter mode setting
        let filterEnabled = globalSettings.filterEnabled ?? globalSettings.doNotDisturbLogMode ?? (localStorage.getItem('doNotDisturbLogMode') === 'true');
        globalSettings.filterEnabled = filterEnabled;
        doNotDisturbBtn.classList.toggle('active', !!filterEnabled);

        // 🟢 核心逻辑：监听模态框就绪事件，届时再同步模态框内部 UI
        document.addEventListener('modal-ready', (e) => {
            const { modalId } = e.detail;
            if (modalId === 'globalSettingsModal') {
                syncGlobalSettingsToUI();
            }
        });

        if (window.messageRenderer) {
            window.messageRenderer.setUserAvatar(globalSettings.userAvatarUrl);
            window.messageRenderer.setUserAvatarColor(globalSettings.userAvatarCalculatedColor);
        }
    } else {
        console.warn('加载全局设置失败或无设置:', settings?.error);
        if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
    }
}

function clampChatBubbleWidthPercent(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(98, Math.max(50, parsed));
}

const CHAT_FONT_PRESETS = Object.freeze({
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"',
    segoe: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    ubuntu: '"Ubuntu", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif',
    pingfang: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", sans-serif',
    'source-han': '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", sans-serif',
    serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, serif'
});

const CHAT_CODE_FONT_PRESETS = Object.freeze({
    cascadia: '"Cascadia Code", "Consolas", "JetBrains Mono", monospace',
    fira: '"Fira Code", "Consolas", "JetBrains Mono", monospace',
    consolas: '"Consolas", "Monaco", "Courier New", monospace',
    system: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    jetbrains: '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace',
    monaspace: '"Monaspace Neon", "JetBrains Mono", "Cascadia Code", monospace'
});

const TOOL_CARD_FONT_PRESETS = Object.freeze({
    ...CHAT_FONT_PRESETS,
    cascadia: CHAT_CODE_FONT_PRESETS.cascadia,
    fira: CHAT_CODE_FONT_PRESETS.fira,
    consolas: CHAT_CODE_FONT_PRESETS.consolas,
    jetbrains: CHAT_CODE_FONT_PRESETS.jetbrains,
    monaspace: CHAT_CODE_FONT_PRESETS.monaspace
});

function sanitizeFontFamilyValue(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/[\r\n]+/g, ' ');
}

function resolveFontFamilyFromPreset(presetMap, presetKey, customValue, fallbackKey) {
    const normalizedPreset = typeof presetKey === 'string' ? presetKey : fallbackKey;
    if (normalizedPreset === 'custom') {
        return sanitizeFontFamilyValue(customValue) || presetMap[fallbackKey];
    }
    return presetMap[normalizedPreset] || presetMap[fallbackKey];
}

function resolveChatFontFamily(settings = globalSettings) {
    return resolveFontFamilyFromPreset(
        CHAT_FONT_PRESETS,
        settings?.chatFontPreset,
        settings?.chatFontCustom,
        'system'
    );
}

function resolveChatCodeFontFamily(settings = globalSettings) {
    return resolveFontFamilyFromPreset(
        CHAT_CODE_FONT_PRESETS,
        settings?.chatCodeFontPreset,
        settings?.chatCodeFontCustom,
        'consolas'
    );
}

function resolveDiaryFontFamily(settings = globalSettings) {
    return resolveFontFamilyFromPreset(
        CHAT_FONT_PRESETS,
        settings?.chatDiaryFontPreset,
        settings?.chatDiaryFontCustom,
        'serif'
    );
}

function resolveToolFontFamily(settings = globalSettings) {
    return resolveFontFamilyFromPreset(
        TOOL_CARD_FONT_PRESETS,
        settings?.chatToolFontPreset,
        settings?.chatToolFontCustom,
        'system'
    );
}

function syncChatFontControl(selectId, customRowId) {
    const presetSelect = document.getElementById(selectId);
    const customRow = document.getElementById(customRowId);
    if (!presetSelect || !customRow) return;
    customRow.style.display = presetSelect.value === 'custom' ? 'block' : 'none';
}

function updateFontScenarioPreview() {
    const bodyFontFamily = resolveChatFontFamily({
        chatFontPreset: document.getElementById('chatFontPreset')?.value || 'system',
        chatFontCustom: document.getElementById('chatFontCustom')?.value || ''
    });
    const codeFontFamily = resolveChatCodeFontFamily({
        chatCodeFontPreset: document.getElementById('chatCodeFontPreset')?.value || 'consolas',
        chatCodeFontCustom: document.getElementById('chatCodeFontCustom')?.value || ''
    });
    const diaryFontFamily = resolveDiaryFontFamily({
        chatDiaryFontPreset: document.getElementById('chatDiaryFontPreset')?.value || 'serif',
        chatDiaryFontCustom: document.getElementById('chatDiaryFontCustom')?.value || ''
    });
    const toolFontFamily = resolveToolFontFamily({
        chatToolFontPreset: document.getElementById('chatToolFontPreset')?.value || 'system',
        chatToolFontCustom: document.getElementById('chatToolFontCustom')?.value || ''
    });

    const bodyEl = document.getElementById('scenarioPreviewBody');
    const codeEl = document.getElementById('scenarioPreviewCode');
    const diaryEl = document.getElementById('scenarioPreviewDiary');
    const toolEl = document.getElementById('scenarioPreviewTool');

    if (bodyEl) bodyEl.style.fontFamily = bodyFontFamily;
    if (codeEl) codeEl.style.fontFamily = codeFontFamily;
    if (diaryEl) diaryEl.style.fontFamily = diaryFontFamily;
    if (toolEl) toolEl.style.fontFamily = toolFontFamily;
}

function ensureScenarioFontSettingsMount(previewId, mountId) {
    const previewEl = document.getElementById(previewId);
    if (!previewEl) return null;

    const card = previewEl.closest('.scenario-preview-card');
    if (!card) return null;

    let mountEl = document.getElementById(mountId);
    if (!mountEl) {
        mountEl = document.createElement('div');
        mountEl.id = mountId;
        mountEl.className = 'scenario-preview-settings-slot';
        const noteEl = card.querySelector('.scenario-preview-note');
        if (noteEl) {
            card.insertBefore(mountEl, noteEl);
        } else {
            card.appendChild(mountEl);
        }
    }

    return mountEl;
}

function mountChatFontSettingGroups() {
    [
        {
            groupId: 'chatFontSettingsGroup',
            previewId: 'scenarioPreviewBody',
            mountId: 'chatFontSettingsMount'
        },
        {
            groupId: 'chatCodeFontSettingsGroup',
            previewId: 'scenarioPreviewCode',
            mountId: 'chatCodeFontSettingsMount'
        }
    ].forEach(({ groupId, previewId, mountId }) => {
        const groupEl = document.getElementById(groupId);
        const mountEl = ensureScenarioFontSettingsMount(previewId, mountId);
        if (!groupEl || !mountEl) return;

        if (groupEl.parentElement !== mountEl) {
            mountEl.appendChild(groupEl);
        }

        groupEl.style.marginTop = '0';
        groupEl.style.marginBottom = '0';
    });
}

function syncChatFontControls() {
    mountChatFontSettingGroups();
    syncChatFontControl('chatFontPreset', 'chatFontCustomRow');
    syncChatFontControl('chatCodeFontPreset', 'chatCodeFontCustomRow');
    syncChatFontControl('chatDiaryFontPreset', 'chatDiaryFontCustomRow');
    syncChatFontControl('chatToolFontPreset', 'chatToolFontCustomRow');
    updateFontScenarioPreview();
}

function syncWideChatLayoutControls() {
    const wideModeRadio = document.getElementById('chatLayoutModeWide');
    const widthSettings = document.getElementById('chatBubbleWidthSettings');
    if (!wideModeRadio || !widthSettings) return;
    widthSettings.style.display = wideModeRadio.checked ? 'block' : 'none';
}

function syncUserChatBubbleControls() {
    const bubbleUiToggle = document.getElementById('enableUserChatBubbleUi');
    const metaSettings = document.getElementById('userChatBubbleMetaSettings');
    if (!bubbleUiToggle || !metaSettings) return;
    metaSettings.style.display = bubbleUiToggle.checked ? 'flex' : 'none';
}

function applyUserChatBubbleUiState(settings = globalSettings) {
    const applyLayoutState = window.domBuilder?.applyUserMessageLayoutState;
    if (typeof applyLayoutState !== 'function') return;

    document.querySelectorAll('.message-item.user').forEach((messageItem) => {
        applyLayoutState(messageItem, settings);
    });
}

function applyChatBubbleLayoutSettings(settings = globalSettings) {
    const rootStyle = document.documentElement.style;
    const resolvedSettings = settings || {};
    const chatFontFamily = resolveChatFontFamily(resolvedSettings);
    const chatCodeFontFamily = resolveChatCodeFontFamily(resolvedSettings);
    const diaryFontFamily = resolveDiaryFontFamily(resolvedSettings);
    const toolFontFamily = resolveToolFontFamily(resolvedSettings);

    const defaultWidth = clampChatBubbleWidthPercent(resolvedSettings.chatBubbleMaxWidthDefault, 82);
    const notificationsWidth = clampChatBubbleWidthPercent(resolvedSettings.chatBubbleMaxWidthNotifications, 90);
    const narrowWidth = clampChatBubbleWidthPercent(resolvedSettings.chatBubbleMaxWidthNarrow, 85);
    const wideDefaultWidth = clampChatBubbleWidthPercent(resolvedSettings.chatBubbleMaxWidthWideDefault, 92);
    const wideNotificationsWidth = clampChatBubbleWidthPercent(resolvedSettings.chatBubbleMaxWidthWideNotifications, 96);
    const wideNarrowWidth = clampChatBubbleWidthPercent(
        resolvedSettings.chatBubbleMaxWidthWideNarrow,
        wideDefaultWidth
    );

    rootStyle.setProperty('--chat-bubble-max-width', `${defaultWidth}%`);
    rootStyle.setProperty('--chat-bubble-max-width-notifications', `${notificationsWidth}%`);
    rootStyle.setProperty('--chat-bubble-max-width-narrow', `${narrowWidth}%`);
    rootStyle.setProperty('--chat-bubble-max-width-wide', `${wideDefaultWidth}%`);
    rootStyle.setProperty('--chat-bubble-max-width-wide-notifications', `${wideNotificationsWidth}%`);
    rootStyle.setProperty('--chat-bubble-max-width-wide-narrow', `${wideNarrowWidth}%`);
    rootStyle.setProperty('--vcp-chat-font-family', chatFontFamily);
    rootStyle.setProperty('--vcp-chat-code-font-family', chatCodeFontFamily);
    rootStyle.setProperty('--vcp-diary-font-family', diaryFontFamily);
    rootStyle.setProperty('--vcp-tool-card-font-family', toolFontFamily);
    rootStyle.setProperty('--font-family', chatFontFamily);
    rootStyle.setProperty('--font-family-sans-serif', chatFontFamily);
    rootStyle.setProperty('--font-family-monospace', chatCodeFontFamily);

    if (window.pretextBridge && typeof window.pretextBridge.setChatFonts === 'function') {
        window.pretextBridge.setChatFonts(chatFontFamily, chatCodeFontFamily);
    }

    if (document.body) {
        document.body.classList.toggle('chat-wide-layout', resolvedSettings.enableWideChatLayout === true);
    }
    applyUserChatBubbleUiState(resolvedSettings);
}

/**
 * 🟢 将全局设置同步到 UI 元素（仅在模态框实例化后调用）
 */
async function syncGlobalSettingsToUI() {
    const safeSet = (id, value, prop = 'value') => {
        const el = document.getElementById(id);
        if (el) el[prop] = value;
    };
    const safeCheck = (id, checked) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!checked;
    };
    const syncRustDebugPanelVisibility = () => {
        const rustDebugModeEl = document.getElementById('rustDebugMode');
        const rustDebugPanelEl = document.getElementById('rustDebugPanel');
        if (rustDebugPanelEl) {
            rustDebugPanelEl.style.display = rustDebugModeEl?.checked ? 'block' : 'none';
        }
    };
    const joinKeywords = (value) => Array.isArray(value) ? value.join('\n') : '';
    const shouldShowRustGuardRules = () => {
        const useRust = document.getElementById('rustUseAssistant')?.checked === true;
        return useRust;
    };
    const syncRustGuardRulesVisibility = () => {
        const container = document.getElementById('rustGuardRulesContainer');
        if (container) {
            container.style.display = shouldShowRustGuardRules() ? 'block' : 'none';
        }
    };

    safeSet('userName', globalSettings.userName || '用户');
    
    const borderColor = globalSettings.userAvatarBorderColor || '#3d5a80';
    safeSet('userAvatarBorderColor', borderColor);
    safeSet('userAvatarBorderColorText', borderColor);
    
    const nameColor = globalSettings.userNameTextColor || '#ffffff';
    safeSet('userNameTextColor', nameColor);
    safeSet('userNameTextColorText', nameColor);
    
    safeCheck('userUseThemeColorsInChat', globalSettings.userUseThemeColorsInChat);
    
    const completedUrl = window.settingsManager.completeVcpUrl(globalSettings.vcpServerUrl || '');
    safeSet('vcpServerUrl', completedUrl);
    safeSet('vcpApiKey', globalSettings.vcpApiKey || '');
    safeSet('vcpLogUrl', globalSettings.vcpLogUrl || '');
    safeSet('vcpLogKey', globalSettings.vcpLogKey || '');
    safeSet('topicSummaryModel', globalSettings.topicSummaryModel || '');
    safeSet('continueWritingPrompt', globalSettings.continueWritingPrompt || '请继续');
    safeSet('flowlockContinueDelay', globalSettings.flowlockContinueDelay ?? 5);
    safeCheck('voiceModeLocal', (globalSettings.voiceMode || 'local') !== 'network');
    safeCheck('voiceModeNetwork', (globalSettings.voiceMode || 'local') === 'network');
    safeSet('speechRecognizerBrowserPath', globalSettings.speechRecognizerBrowserPath || '');
    safeSet('speechRecognizerPagePath', globalSettings.speechRecognizerPagePath || 'Voicechatmodules/recognizer.html');
    safeSet('voiceNetworkSovitsUrl', globalSettings.voiceNetworkSettings?.sovitsUrl || '');
    safeSet('voiceNetworkSovitsKey', globalSettings.voiceNetworkSettings?.sovitsKey || '');
    safeSet('voiceLocalProviderUrl', globalSettings.voiceLocalSettings?.providerUrl || '');
    safeSet('voiceLocalProviderKey', globalSettings.voiceLocalSettings?.providerKey || '');
    
    // Network Notes Paths
    const networkNotesPathsContainer = document.getElementById('networkNotesPathsContainer');
    if (networkNotesPathsContainer) {
        networkNotesPathsContainer.innerHTML = '';
        const paths = Array.isArray(globalSettings.networkNotesPaths) ? globalSettings.networkNotesPaths : (globalSettings.networkNotesPath ? [globalSettings.networkNotesPath] : []);
        if (paths.length === 0) {
            uiHelperFunctions.addNetworkPathInput('');
        } else {
            paths.forEach(path => uiHelperFunctions.addNetworkPathInput(path));
        }
    }

    safeCheck('enableAgentBubbleTheme', globalSettings.enableAgentBubbleTheme !== false);
    safeCheck('enableSmoothStreaming', globalSettings.enableSmoothStreaming === true);
    safeSet('chatFontPreset', globalSettings.chatFontPreset || 'system');
    safeSet('chatFontCustom', globalSettings.chatFontCustom || '');
    safeSet('chatCodeFontPreset', globalSettings.chatCodeFontPreset || 'consolas');
    safeSet('chatCodeFontCustom', globalSettings.chatCodeFontCustom || '');
    safeSet('chatDiaryFontPreset', globalSettings.chatDiaryFontPreset || 'serif');
    safeSet('chatDiaryFontCustom', globalSettings.chatDiaryFontCustom || '');
    safeSet('chatToolFontPreset', globalSettings.chatToolFontPreset || 'system');
    safeSet('chatToolFontCustom', globalSettings.chatToolFontCustom || '');
    safeCheck('chatLayoutModeWide', globalSettings.enableWideChatLayout === true);
    safeCheck('chatLayoutModeNormal', globalSettings.enableWideChatLayout !== true);
    safeCheck('enableUserChatBubbleUi', globalSettings.enableUserChatBubbleUi !== false);
    safeCheck('showUserMetaInChatBubbleUi', globalSettings.showUserMetaInChatBubbleUi !== false);
    safeSet('chatBubbleMaxWidthWideDefault', clampChatBubbleWidthPercent(globalSettings.chatBubbleMaxWidthWideDefault, 92));
    safeSet('chatBubbleMaxWidthWideNotifications', clampChatBubbleWidthPercent(globalSettings.chatBubbleMaxWidthWideNotifications, 96));
    safeSet(
        'chatBubbleMaxWidthWideNarrow',
        clampChatBubbleWidthPercent(
            globalSettings.chatBubbleMaxWidthWideNarrow,
            clampChatBubbleWidthPercent(globalSettings.chatBubbleMaxWidthWideDefault, 92)
        )
    );
    safeSet('minChunkBufferSize', globalSettings.minChunkBufferSize ?? 16);
    safeSet('smoothStreamIntervalMs', globalSettings.smoothStreamIntervalMs ?? 100);
    syncChatFontControls();
    syncWideChatLayoutControls();
    syncUserChatBubbleControls();

    const chatFontPresetSelect = document.getElementById('chatFontPreset');
    const chatFontCustomInput = document.getElementById('chatFontCustom');
    const chatCodeFontPresetSelect = document.getElementById('chatCodeFontPreset');
    const chatCodeFontCustomInput = document.getElementById('chatCodeFontCustom');
    const chatDiaryFontPresetSelect = document.getElementById('chatDiaryFontPreset');
    const chatDiaryFontCustomInput = document.getElementById('chatDiaryFontCustom');
    const chatToolFontPresetSelect = document.getElementById('chatToolFontPreset');
    const chatToolFontCustomInput = document.getElementById('chatToolFontCustom');
    const wideModeRadio = document.getElementById('chatLayoutModeWide');
    const normalModeRadio = document.getElementById('chatLayoutModeNormal');
    const userBubbleUiToggle = document.getElementById('enableUserChatBubbleUi');
    if (chatFontPresetSelect && !chatFontPresetSelect.dataset.boundFontToggle) {
        chatFontPresetSelect.addEventListener('change', syncChatFontControls);
        chatFontPresetSelect.dataset.boundFontToggle = 'true';
    }
    if (chatCodeFontPresetSelect && !chatCodeFontPresetSelect.dataset.boundFontToggle) {
        chatCodeFontPresetSelect.addEventListener('change', syncChatFontControls);
        chatCodeFontPresetSelect.dataset.boundFontToggle = 'true';
    }
    if (chatDiaryFontPresetSelect && !chatDiaryFontPresetSelect.dataset.boundFontToggle) {
        chatDiaryFontPresetSelect.addEventListener('change', syncChatFontControls);
        chatDiaryFontPresetSelect.dataset.boundFontToggle = 'true';
    }
    if (chatToolFontPresetSelect && !chatToolFontPresetSelect.dataset.boundFontToggle) {
        chatToolFontPresetSelect.addEventListener('change', syncChatFontControls);
        chatToolFontPresetSelect.dataset.boundFontToggle = 'true';
    }
    if (chatFontCustomInput && !chatFontCustomInput.dataset.boundFontPreview) {
        chatFontCustomInput.addEventListener('input', updateFontScenarioPreview);
        chatFontCustomInput.dataset.boundFontPreview = 'true';
    }
    if (chatCodeFontCustomInput && !chatCodeFontCustomInput.dataset.boundFontPreview) {
        chatCodeFontCustomInput.addEventListener('input', updateFontScenarioPreview);
        chatCodeFontCustomInput.dataset.boundFontPreview = 'true';
    }
    if (chatDiaryFontCustomInput && !chatDiaryFontCustomInput.dataset.boundFontPreview) {
        chatDiaryFontCustomInput.addEventListener('input', updateFontScenarioPreview);
        chatDiaryFontCustomInput.dataset.boundFontPreview = 'true';
    }
    if (chatToolFontCustomInput && !chatToolFontCustomInput.dataset.boundFontPreview) {
        chatToolFontCustomInput.addEventListener('input', updateFontScenarioPreview);
        chatToolFontCustomInput.dataset.boundFontPreview = 'true';
    }
    if (wideModeRadio && !wideModeRadio.dataset.boundWideChatToggle) {
        wideModeRadio.addEventListener('change', syncWideChatLayoutControls);
        wideModeRadio.dataset.boundWideChatToggle = 'true';
    }
    if (normalModeRadio && !normalModeRadio.dataset.boundWideChatToggle) {
        normalModeRadio.addEventListener('change', syncWideChatLayoutControls);
        normalModeRadio.dataset.boundWideChatToggle = 'true';
    }
    if (userBubbleUiToggle && !userBubbleUiToggle.dataset.boundUserBubbleToggle) {
        userBubbleUiToggle.addEventListener('change', syncUserChatBubbleControls);
        userBubbleUiToggle.dataset.boundUserBubbleToggle = 'true';
    }

    // User Avatar Preview
    const userAvatarPreview = document.getElementById('userAvatarPreview');
    const userAvatarWrapper = userAvatarPreview?.closest('.agent-avatar-wrapper');
    if (userAvatarPreview) {
        if (globalSettings.userAvatarUrl) {
            userAvatarPreview.src = globalSettings.userAvatarUrl;
            userAvatarPreview.style.display = 'block';
            userAvatarWrapper?.classList.remove('no-avatar');
        } else {
            userAvatarPreview.src = '#';
            userAvatarPreview.style.display = 'none';
            userAvatarWrapper?.classList.add('no-avatar');
        }
    }

    // 加载论坛配置并填充管理员账号/密码
    try {
        const forumConfig = await chatAPI.loadForumConfig();
        if (forumConfig && !forumConfig.error) {
            safeSet('adminUsername', forumConfig.username || '');
            safeSet('adminPassword', forumConfig.password || '');
        }
    } catch (err) {
        console.warn('[Renderer] Failed to load forum config for global settings:', err);
    }

    // Assistant Select
    const assistantAgentSelect = document.getElementById('assistantAgent');
    if (assistantAgentSelect) {
        await window.settingsManager.populateAssistantAgentSelect();
        assistantAgentSelect.value = globalSettings.assistantAgent || '';
    }

    safeCheck('enableDistributedServer', globalSettings.enableDistributedServer === true);
    safeCheck('agentMusicControl', globalSettings.agentMusicControl === true);
    safeCheck('enableVcpToolInjection', globalSettings.enableVcpToolInjection === true);
    safeCheck('enableThoughtChainInjection', globalSettings.enableThoughtChainInjection === true);
    safeCheck('enableContextSanitizer', globalSettings.enableContextSanitizer === true);
    safeSet('contextSanitizerDepth', globalSettings.contextSanitizerDepth ?? 2);
    
    const contextSanitizerDepthContainer = document.getElementById('contextSanitizerDepthContainer');
    if (contextSanitizerDepthContainer) {
        contextSanitizerDepthContainer.style.display = globalSettings.enableContextSanitizer === true ? 'block' : 'none';
    }

    safeCheck('enableAiMessageButtons', globalSettings.enableAiMessageButtons !== false);
    safeCheck('enableMiddleClickQuickAction', globalSettings.enableMiddleClickQuickAction === true);
    safeSet('middleClickQuickAction', globalSettings.middleClickQuickAction || '');
    safeCheck('enableMiddleClickAdvanced', globalSettings.enableMiddleClickAdvanced === true);
    safeSet('middleClickAdvancedDelay', Math.max(1000, globalSettings.middleClickAdvancedDelay ?? 1000));
    safeCheck('enableRegenerateConfirmation', globalSettings.enableRegenerateConfirmation !== false);

    if (chatAPI?.getRustAssistantConfig) {
        try {
            const rustConfig = await chatAPI.getRustAssistantConfig();
            if (rustConfig && !rustConfig.error) {
                safeCheck('rustUseAssistant', rustConfig.useRustAssistant === true);
                safeCheck('rustDebugMode', rustConfig.debugMode === true);
                safeSet('rustWhitelistKeywords', joinKeywords(rustConfig.whitelist || []));
                safeSet('rustBlacklistKeywords', joinKeywords(rustConfig.blacklist || []));
                safeSet('rustScreenshotApps', joinKeywords(rustConfig.screenshotApps || []));
                syncRustDebugPanelVisibility();
                syncRustGuardRulesVisibility();

                const rustDebugModeEl = document.getElementById('rustDebugMode');
                if (rustDebugModeEl && !rustDebugModeEl.dataset.debugPanelBound) {
                    rustDebugModeEl.addEventListener('change', syncRustDebugPanelVisibility);
                    rustDebugModeEl.dataset.debugPanelBound = 'true';
                }

                const rustUseAssistantEl = document.getElementById('rustUseAssistant');
                if (rustUseAssistantEl && !rustUseAssistantEl.dataset.guardPanelBound) {
                    rustUseAssistantEl.addEventListener('change', syncRustGuardRulesVisibility);
                    rustUseAssistantEl.dataset.guardPanelBound = 'true';
                }

            }
        } catch (error) {
            console.warn('[Renderer] Failed to sync Rust assistant config:', error);
        }
    }

    if (chatAPI?.getAssistantRuntimeStatus && document.getElementById('rustDebugMode')?.checked) {
        try {
            const runtime = await chatAPI.getAssistantRuntimeStatus();
            if (runtime && runtime.success) {
                const modeText = runtime.mode === 'rust'
                    ? 'Rust'
                    : (runtime.mode === 'disabled' ? 'Disabled' : runtime.mode || 'Unknown');
                const desiredText = runtime.desiredMode === 'rust'
                    ? 'Rust'
                    : (runtime.desiredMode === 'disabled' ? 'Disabled' : runtime.desiredMode || 'Unknown');
                const activeText = runtime.active ? '运行中' : '未运行';
                const debugReasonText = runtime.lastDebugReason || '无';
                const forwardedCount = runtime.forwardedEventCount || 0;
                const sidecarActiveText = runtime.rustSidecarListenerActive === null
                    ? '未知'
                    : (runtime.rustSidecarListenerActive ? '是' : '否');
                const processAliveText = runtime.adapterProcessAlive ? '运行中' : '未运行';
                const processPidText = runtime.adapterProcessPid ? String(runtime.adapterProcessPid) : '无';
                const autoFallbackCount = runtime.runtimeFallbackTrace?.autoFallbackCount || 0;
                const autoFallbackReason = runtime.runtimeFallbackTrace?.lastAutoFallbackReason || '无';
                const receivedCount = runtime.integrationTrace?.receivedSelectionCount || 0;
                const showAttemptCount = runtime.integrationTrace?.showAttemptCount || 0;
                const showErrorText = runtime.integrationTrace?.lastShowError || '无';
                safeSet('assistantRuntimeMode', modeText, 'textContent');
                safeSet('assistantRuntimeDesiredMode', desiredText, 'textContent');
                safeSet('assistantRuntimeActive', activeText, 'textContent');
                safeSet('assistantRuntimeDebugReason', debugReasonText, 'textContent');
                safeSet('assistantRuntimeForwardedCount', String(forwardedCount), 'textContent');
                safeSet('assistantRuntimeSidecarActive', sidecarActiveText, 'textContent');
                safeSet('assistantRuntimeProcessAlive', processAliveText, 'textContent');
                safeSet('assistantRuntimeProcessPid', processPidText, 'textContent');
                safeSet('assistantRuntimeAutoFallbackCount', String(autoFallbackCount), 'textContent');
                safeSet('assistantRuntimeAutoFallbackReason', autoFallbackReason, 'textContent');
                safeSet('assistantRuntimeReceivedCount', String(receivedCount), 'textContent');
                safeSet('assistantRuntimeShowAttemptCount', String(showAttemptCount), 'textContent');
                safeSet('assistantRuntimeShowError', showErrorText, 'textContent');
            }
        } catch (error) {
            console.warn('[Renderer] Failed to load assistant runtime status:', error);
        }
    }

    // Visibility toggles
    const middleClickContainer = document.getElementById('middleClickQuickActionContainer');
    if (middleClickContainer) middleClickContainer.style.display = globalSettings.enableMiddleClickQuickAction ? 'block' : 'none';
    const middleClickAdvancedContainer = document.getElementById('middleClickAdvancedContainer');
    if (middleClickAdvancedContainer) middleClickAdvancedContainer.style.display = globalSettings.enableMiddleClickQuickAction ? 'block' : 'none';
    const middleClickAdvancedSettings = document.getElementById('middleClickAdvancedSettings');
    if (middleClickAdvancedSettings) middleClickAdvancedSettings.style.display = globalSettings.enableMiddleClickAdvanced ? 'block' : 'none';
}

// --- Chat Functionality ---
// --- UI Event Listeners & Helpers ---
// These functions have been moved to modules/ui-helpers.js

// This function has been moved to modules/ui-helpers.js
 
let markedInstance;
if (window.marked && typeof window.marked.Marked === 'function') { // Ensure Marked is a constructor
    try {
        markedInstance = new window.marked.Marked({
            gfm: true,              // 启用 GitHub Flavored Markdown
            tables: true,           // 启用表格支持
            breaks: true,          // 🟢 自动将换行符转换为 <br>
            pedantic: false,        // 不使用严格的 Markdown 规则
            sanitize: false,        // 不清理 HTML（允许内嵌 HTML）
            smartLists: true,       // 使用更智能的列表行为
            smartypants: false,     // 不使用智能标点符号
            highlight: function(code, lang) {
                if (window.hljs) {
                    const language = window.hljs.getLanguage(lang) ? lang : 'plaintext';
                    return window.hljs.highlight(code, { language }).value;
                }
                return code; // Fallback for safety
            }
        });
        // Optional: Add custom processing like quote spans if needed
    } catch (err) {
        console.warn("Failed to initialize marked, using basic fallback.", err);
        markedInstance = { parse: (text) => `<p>${String(text || '').replace(/\n/g, '<br>')}</p>` };
    }
} else {
    console.warn("Marked library not found or not in expected format, Markdown rendering will be basic.");
    markedInstance = { parse: (text) => `<p>${String(text || '').replace(/\n/g, '<br>')}</p>` };
}
 
window.addEventListener('contextmenu', (e) => {
    // Allow context menu for text input fields
    if (e.target.closest('textarea, input[type="text"], .message-item .md-content')) { // Also allow on rendered message content
        // Standard context menu will appear
    } else {
        // e.preventDefault(); // Optionally prevent context menu elsewhere
    }
}, false);
 
// Helper to get a centrally stored cropped file (agent, group, or user)
// These functions are now part of modules/ui-helpers.js and are accessed via uiHelperFunctions

// --- Forward Message Functionality ---
let messageToForward = null;
let selectedForwardTarget = null;

async function showForwardModal(message) {
    messageToForward = message;
    selectedForwardTarget = null; // Reset selection
    
    // 🟢 修复：先调用 openModal 确保从模板实例化 DOM 元素
    uiHelperFunctions.openModal('forwardMessageModal');

    const modal = document.getElementById('forwardMessageModal');
    const targetList = document.getElementById('forwardTargetList');
    const searchInput = document.getElementById('forwardTargetSearch');
    const commentInput = document.getElementById('forwardAdditionalComment');
    const confirmBtn = document.getElementById('confirmForwardBtn');

    if (!targetList || !searchInput || !commentInput || !confirmBtn) {
        console.error("[Forward Modal] Elements not found even after modal open!");
        return;
    }

    targetList.innerHTML = '<li>Loading...</li>';
    commentInput.value = '';
    searchInput.value = '';
    confirmBtn.disabled = true;

    const result = await chatAPI.getAllItems();
    if (result.success) {
        renderForwardTargetList(result.items);
    } else {
        targetList.innerHTML = '<li>Failed to load targets.</li>';
    }

    searchInput.oninput = () => {
        const searchTerm = searchInput.value.toLowerCase();
        const items = targetList.querySelectorAll('.agent-item');
        items.forEach(item => {
            const name = item.dataset.name.toLowerCase();
            if (name.includes(searchTerm)) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    };

    confirmBtn.onclick = handleConfirmForward;
}

function renderForwardTargetList(items) {
    const targetList = document.getElementById('forwardTargetList');
    const confirmBtn = document.getElementById('confirmForwardBtn');
    targetList.innerHTML = '';

    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'agent-item';
        li.dataset.id = item.id;
        li.dataset.type = item.type;
        li.dataset.name = item.name;

        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.src = item.avatarUrl || (item.type === 'group' ? 'assets/default_group_avatar.png' : 'assets/default_user_avatar.png');
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'agent-name';
        nameSpan.textContent = `${item.name} (${item.type === 'group' ? '群组' : 'Agent'})`;

        li.appendChild(avatar);
        li.appendChild(nameSpan);

        li.onclick = () => {
            const currentSelected = targetList.querySelector('.selected');
            if (currentSelected) {
                currentSelected.classList.remove('selected');
            }
            li.classList.add('selected');
            selectedForwardTarget = { id: item.id, type: item.type, name: item.name };
            confirmBtn.disabled = false;
        };
        targetList.appendChild(li);
    });
}

async function handleConfirmForward() {
    if (!messageToForward || !selectedForwardTarget) {
        uiHelperFunctions.showToastNotification('错误：未选择消息或转发目标。', 'error');
        return;
    }

    const additionalComment = document.getElementById('forwardAdditionalComment').value.trim();
    
    // We need to get the original message from history to ensure we have all data
    const originalMessageResult = await chatAPI.getOriginalMessageContent(
        currentSelectedItem.id,
        currentSelectedItem.type,
        currentTopicId,
        messageToForward.id
    );

    if (!originalMessageResult.success) {
        uiHelperFunctions.showToastNotification(`无法获取原始消息内容: ${originalMessageResult.error}`, 'error');
        return;
    }
    
    const originalMessage = { ...messageToForward, content: originalMessageResult.content };

    let forwardedContent = '';
    const senderName = originalMessage.name || (originalMessage.role === 'user' ? '用户' : '助手');
    forwardedContent += `> 转发自 **${senderName}** 的消息:\n\n`;
    
    let originalText = '';
    if (typeof originalMessage.content === 'string') {
        originalText = originalMessage.content;
    } else if (originalMessage.content && typeof originalMessage.content.text === 'string') {
        originalText = originalMessage.content.text;
    }
    
    forwardedContent += originalText;

    if (additionalComment) {
        forwardedContent += `\n\n---\n${additionalComment}`;
    }

    const attachments = originalMessage.attachments || [];

    // This is a simplified send. We might need a more robust solution
    // that re-uses the logic from chatManager.handleSendMessage
    // For now, let's create a new function in chatManager for this.
    if (window.chatManager && typeof window.chatManager.handleForwardMessage === 'function') {
        window.chatManager.handleForwardMessage(selectedForwardTarget, forwardedContent, attachments);
        uiHelperFunctions.showToastNotification(`消息已转发给 ${selectedForwardTarget.name}`, 'success');
    } else {
        uiHelperFunctions.showToastNotification('转发功能尚未完全实现。', 'error');
        console.error('chatManager.handleForwardMessage is not defined');
    }

    uiHelperFunctions.closeModal('forwardMessageModal');
    messageToForward = null;
    selectedForwardTarget = null;
}
// Expose these functions globally for ui-helpers.js
// Expose the new helper functions on the window object for modules that need them
// These are no longer needed as uiHelperFunctions handles them directly
window.ensureAudioContext = () => { /* Placeholder, will be defined in setupTtsListeners */ };
window.showForwardModal = showForwardModal;

// Make globalSettings accessible for notification renderer
window.applyChatBubbleLayoutSettings = applyChatBubbleLayoutSettings;
window.globalSettings = globalSettings;

// Make filter functions globally accessible for notification renderer
window.checkMessageFilter = (messageTitle) => {
    if (window.filterManager) {
        return window.filterManager.checkMessageFilter(messageTitle);
    }
    // Fallback if the manager is not available
    return null;
};
