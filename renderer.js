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
const attachmentPreviewArea = document.getElementById('attachmentPreviewArea');

const globalSettingsBtn = document.getElementById('globalSettingsBtn');
const globalSettingsModal = document.getElementById('globalSettingsModal');
const globalSettingsForm = document.getElementById('globalSettingsForm');
const userAvatarInput = document.getElementById('userAvatarInput');
const userAvatarPreview = document.getElementById('userAvatarPreview');

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
const openAdminPanelBtn = document.getElementById('openAdminPanelBtn');
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

let croppedAgentAvatarFile = null; // For agent avatar
let croppedUserAvatarFile = null; // For user avatar
let croppedGroupAvatarFile = null; // For group avatar, to be managed by GroupRenderer or centrally

const notificationTitleElement = document.getElementById('notificationTitle');
const digitalClockElement = document.getElementById('digitalClock');
const dateDisplayElement = document.getElementById('dateDisplay');
let inviteAgentButtonsContainerElement; // 新增：邀请发言按钮容器的引用

// Assistant settings elements
const toggleAssistantBtn = document.getElementById('toggleAssistantBtn'); // New button
const assistantAgentContainer = document.getElementById('assistantAgentContainer');
const assistantAgentSelect = document.getElementById('assistantAgent');

// Model selection elements
const openModelSelectBtn = document.getElementById('openModelSelectBtn');
const modelSelectModal = document.getElementById('modelSelectModal');
const modelList = document.getElementById('modelList');
const modelSearchInput = document.getElementById('modelSearchInput');
const refreshModelsBtn = document.getElementById('refreshModelsBtn');

// UI Helper functions to be passed to modules
// The main uiHelperFunctions object is now defined in modules/ui-helpers.js
// We can reference it directly from the window object.
const uiHelperFunctions = window.uiHelperFunctions;


import searchManager from './modules/searchManager.js';
import { initialize as initializeEmoticonFixer } from './modules/renderer/emoticonUrlFixer.js';
import * as interruptHandler from './modules/interruptHandler.js';
 
 // --- Initialization ---
 document.addEventListener('DOMContentLoaded', async () => {

    // 确保在GroupRenderer初始化之前，其容器已准备好
    prepareGroupSettingsDOM();
    inviteAgentButtonsContainerElement = document.getElementById('inviteAgentButtonsContainer'); // 新增：获取容器引用

    // Initialize ItemListManager first as other modules might depend on the item list
    if (window.itemListManager) {
        window.itemListManager.init({
            elements: {
                itemListUl: itemListUl,
            },
            electronAPI: window.electronAPI,
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
            electronAPI: window.electronAPI,
            globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
            currentSelectedItemRef: { get: () => currentSelectedItem, set: (val) => currentSelectedItem = val },
            currentTopicIdRef: { get: () => currentTopicId, set: (val) => currentTopicId = val },
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
                updateAttachmentPreview: updateAttachmentPreview,
                setCroppedFile: setCroppedFile,
                getCroppedFile: getCroppedFile,
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
        interruptHandler.initialize(window.electronAPI);

        window.messageRenderer.initializeMessageRenderer({
            currentChatHistoryRef: { get: () => currentChatHistory, set: (val) => currentChatHistory = val },
            currentSelectedItemRef: { get: () => currentSelectedItem, set: (val) => currentSelectedItem = val },
            currentTopicIdRef: { get: () => currentTopicId, set: (val) => currentTopicId = val },
            globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
            chatMessagesDiv: chatMessagesDiv,
            electronAPI: window.electronAPI,
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
            electronAPI: window.electronAPI,
            attachedFiles: { get: () => attachedFiles, set: (val) => attachedFiles = val }, // Corrected: pass as attachedFiles
            updateAttachmentPreview: updateAttachmentPreview,
            getCurrentAgentId: () => currentSelectedItem.id, // Corrected: pass a function that returns the ID
            getCurrentTopicId: () => currentTopicId,
            uiHelper: uiHelperFunctions,
        });
    } else {
        console.error('[RENDERER_INIT] inputEnhancer module not found!');
    }


    window.electronAPI.onVCPLogStatus((statusUpdate) => {
        if (window.notificationRenderer) {
            window.notificationRenderer.updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv);
        }
    });
    window.electronAPI.onVCPLogMessage((logData, originalRawMessage) => {
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
            window.notificationRenderer.renderVCPLogNotification(logData, originalRawMessage, notificationsListUl, themeColors);
        }
    });

    // Unified listener for all VCP stream events (agent and group)
    window.electronAPI.onVCPStreamEvent(async (eventData) => {
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

        console.log(`[onVCPStreamEvent] Received event type '${type}' for msg ${messageId}. Relevant to current view: ${isRelevantToCurrentView}`, context);

        // Data model updates should ALWAYS happen, regardless of the current view.
        // UI updates (creating new DOM elements) should only happen if the view is relevant.
        switch (type) {
            case 'data':
                window.messageRenderer.appendStreamChunk(messageId, chunk, context);
                break;

            case 'end':
                window.messageRenderer.finalizeStreamedMessage(messageId, finish_reason || 'completed', context);
                if (context && !context.isGroupMessage) {
                    // This can run in the background
                    await window.chatManager.attemptTopicSummarizationIfNeeded();
                }
                break;

            case 'error':
                console.error('VCP Stream Error on ID', messageId, ':', error, 'Context:', context);
                window.messageRenderer.finalizeStreamedMessage(messageId, 'error', context);
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
    window.electronAPI.onVCPGroupTopicUpdated(async (eventData) => {
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
            electronAPI: window.electronAPI,
            refs: {
                currentSelectedItemRef: { get: () => currentSelectedItem },
                currentTopicIdRef: { get: () => currentTopicId },
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
            electronAPI: window.electronAPI,
            uiHelper: uiHelperFunctions,
            modules: {
                messageRenderer: window.messageRenderer,
                itemListManager: window.itemListManager,
                topicListManager: window.topicListManager,
                groupRenderer: window.GroupRenderer,
            },
            refs: {
                currentSelectedItemRef: { get: () => currentSelectedItem, set: (val) => currentSelectedItem = val },
                currentTopicIdRef: { get: () => currentTopicId, set: (val) => currentTopicId = val },
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
                updateAttachmentPreview: updateAttachmentPreview,
                // This is no longer needed as chatManager will call messageRenderer's summarizer
            }
        });
    } else {
        console.error('[RENDERER_INIT] chatManager module not found!');
    }


    // Initialize UI Manager first (handles theme, resizers, title bar, clock)
    if (window.uiManager) {
        window.uiManager.init({
            electronAPI: window.electronAPI,
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

    // Initialize Settings Manager
    if (window.settingsManager) {
        window.settingsManager.init({
            electronAPI: window.electronAPI,
            uiHelper: uiHelperFunctions,
            refs: {
                currentSelectedItemRef: { get: () => currentSelectedItem, set: (val) => currentSelectedItem = val },
                currentTopicIdRef: { get: () => currentTopicId, set: (val) => currentTopicId = val },
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
                agentSystemPromptTextarea: document.getElementById('agentSystemPrompt'),
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
                setCroppedFile: setCroppedFile,
                getCroppedFile: getCroppedFile,
                updateChatHeader: (text) => { if (currentChatNameH3) currentChatNameH3.textContent = text; },
                onItemDeleted: async () => {
                    window.chatManager.displayNoItemSelected();
                    await window.itemListManager.loadItems();
                }
            }
        });
    } else {
        console.error('[RENDERER_INIT] settingsManager module not found!');
    }

    try {
        await loadAndApplyGlobalSettings();
        await window.itemListManager.loadItems(); // Load both agents and groups

        // Initialize Filter Manager
        if (window.filterManager) {
            window.filterManager.init({
                electronAPI: window.electronAPI,
                uiHelper: uiHelperFunctions,
                refs: {
                    globalSettingsRef: { get: () => globalSettings, set: (newSettings) => globalSettings = newSettings },
                }
            });
        } else {
            console.error('[RENDERER_INIT] filterManager module not found!');
        }

        setupEventListeners();
        window.topicListManager.setupTopicSearch(); // Ensure this is called after DOM for topic search input is ready
        if(messageInput) uiHelperFunctions.autoResizeTextarea(messageInput);

        // Set default view if no item is selected
        if (!currentSelectedItem.id) {
            window.chatManager.displayNoItemSelected();
        }

        // Initialize Search Manager
        if (searchManager) {
            searchManager.init({
                electronAPI: window.electronAPI,
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
    } catch (error) {
        console.error('Error during DOMContentLoaded initialization:', error);
        chatMessagesDiv.innerHTML = `<div class="message-item system">初始化失败: ${error.message}</div>`;
    }

    console.log('[Renderer DOMContentLoaded END] createNewGroupBtn textContent:', document.getElementById('createNewGroupBtn')?.textContent);
    
    // --- TTS Audio Playback and Visuals ---
    setupTtsListeners();
    // --- File Watcher Listener ---
    window.electronAPI.onHistoryFileUpdated(({ agentId, topicId, path }) => {
        if (currentSelectedItem && currentSelectedItem.id === agentId && currentTopicId === topicId) {
            console.log('[Renderer] Active chat history was modified externally. Syncing...');
            uiHelperFunctions.showToastNotification("聊天记录已同步。", "info");
            if (window.chatManager && typeof window.chatManager.syncHistoryFromFile === 'function') {
                window.chatManager.syncHistoryFromFile(agentId, currentSelectedItem.type, topicId);
            }
        }
    });

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
    window.electronAPI.onPlayTtsAudio(async ({ audioData, msgId, sessionId }) => {
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
                updateSpeakingIndicator(currentPlayingMsgId, false);
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
                updateSpeakingIndicator(currentPlayingMsgId, false);
            }
            // 开启当前新的动画
            currentPlayingMsgId = msgId;
            updateSpeakingIndicator(currentPlayingMsgId, true);
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

    window.electronAPI.onStopTtsAudio(() => {
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
            updateSpeakingIndicator(currentPlayingMsgId, false);
            currentPlayingMsgId = null;
        }
    });

    // 移除旧的 onSovitsStatusChanged 监听器，因为它不再准确
    // window.electronAPI.onSovitsStatusChanged(...)

    function updateSpeakingIndicator(msgId, isSpeaking) {
        const messageItem = document.querySelector(`.message-item[data-message-id="${msgId}"]`);
        if (messageItem) {
            const avatarElement = messageItem.querySelector('.chat-avatar');
            if (avatarElement) {
                if (isSpeaking) {
                    avatarElement.classList.add('speaking');
                } else {
                    avatarElement.classList.remove('speaking');
                }
            }
        }
    }
}

function prepareGroupSettingsDOM() {
    // This function is called early in DOMContentLoaded.
    // It ensures the container for group settings exists.
    // The actual content (form fields) will be managed by GroupRenderer.
    if (!document.getElementById('groupSettingsContainer')) {
        const settingsTab = document.getElementById('tabContentSettings');
        if (settingsTab) {
            const groupContainerHTML = `<div id="groupSettingsContainer" style="display: none;"></div>`;
            settingsTab.insertAdjacentHTML('beforeend', groupContainerHTML);
            console.log("[Renderer] groupSettingsContainer placeholder created.");
        } else {
            console.error("[Renderer] Could not find tabContentSettings to append group settings DOM placeholder.");
        }
    }
     // Ensure createNewGroupBtn has its text updated
     if (createNewAgentBtn) {
         createNewAgentBtn.textContent = '创建 Agent';
     }
     if (createNewGroupBtn) {
         createNewGroupBtn.textContent = '创建 Group';
         console.log('[Renderer prepareGroupSettingsDOM] createNewGroupBtn textContent set to:', createNewGroupBtn.textContent);
         createNewGroupBtn.style.display = 'inline-block'; // Make it visible
     }
}


async function loadAndApplyGlobalSettings() {
    const settings = await window.electronAPI.loadSettings();
    if (settings && !settings.error) {
        globalSettings = { ...globalSettings, ...settings }; // Merge with defaults
        document.getElementById('userName').value = globalSettings.userName || '用户';
        // Ensure the loaded URL is displayed in its complete form
        const completedUrl = window.settingsManager.completeVcpUrl(globalSettings.vcpServerUrl || '');
        document.getElementById('vcpServerUrl').value = completedUrl;
        document.getElementById('vcpApiKey').value = globalSettings.vcpApiKey || '';
        document.getElementById('vcpLogUrl').value = globalSettings.vcpLogUrl || '';
        document.getElementById('vcpLogKey').value = globalSettings.vcpLogKey || '';
        document.getElementById('topicSummaryModel').value = globalSettings.topicSummaryModel || '';
        
        // --- Load Network Notes Paths ---
        const networkNotesPathsContainer = document.getElementById('networkNotesPathsContainer');
        networkNotesPathsContainer.innerHTML = ''; // Clear existing
        const paths = Array.isArray(settings.networkNotesPaths)
            ? settings.networkNotesPaths
            : (settings.networkNotesPath ? [settings.networkNotesPath] : []);
        
        if (paths.length === 0) {
            // Add one empty path input if none are saved
            addNetworkPathInput('');
        } else {
            paths.forEach(path => addNetworkPathInput(path));
        }
        // --- End Load Network Notes Paths ---

        // Load smooth streaming settings
        document.getElementById('enableAgentBubbleTheme').checked = globalSettings.enableAgentBubbleTheme === true;
        document.getElementById('enableSmoothStreaming').checked = globalSettings.enableSmoothStreaming === true;
        document.getElementById('minChunkBufferSize').value = globalSettings.minChunkBufferSize !== undefined ? globalSettings.minChunkBufferSize : 1;
        document.getElementById('smoothStreamIntervalMs').value = globalSettings.smoothStreamIntervalMs !== undefined ? globalSettings.smoothStreamIntervalMs : 25;


        if (globalSettings.userAvatarUrl && userAvatarPreview) {
            userAvatarPreview.src = globalSettings.userAvatarUrl; // Already has timestamp from main
            userAvatarPreview.style.display = 'block';
        } else if (userAvatarPreview) {
            userAvatarPreview.src = '#';
            userAvatarPreview.style.display = 'none';
        }
        if (window.messageRenderer) { // Update messageRenderer with user avatar info
            window.messageRenderer.setUserAvatar(globalSettings.userAvatarUrl);
            window.messageRenderer.setUserAvatarColor(globalSettings.userAvatarCalculatedColor);
        }


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
            window.electronAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
        } else {
            if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
        }
        
        // Load assistant settings
        // The container is now always visible in settings, just the agent selection.
        assistantAgentContainer.style.display = 'block';
        await window.settingsManager.populateAssistantAgentSelect();
        if (globalSettings.assistantAgent) {
            assistantAgentSelect.value = globalSettings.assistantAgent;
        }

        // Set the initial state of the new toggle button in the main UI
        if (toggleAssistantBtn) {
            if (globalSettings.assistantEnabled) {
                toggleAssistantBtn.classList.add('active');
            } else {
                toggleAssistantBtn.classList.remove('active');
            }
        }
        
        // Initial toggle of the listener based on settings
        window.electronAPI.toggleSelectionListener(globalSettings.assistantEnabled);

        // Load distributed server setting
        document.getElementById('enableDistributedServer').checked = globalSettings.enableDistributedServer === true;
        document.getElementById('agentMusicControl').checked = globalSettings.agentMusicControl === true;
        document.getElementById('enableVcpToolInjection').checked = globalSettings.enableVcpToolInjection === true;
        document.getElementById('enableContextSanitizer').checked = globalSettings.enableContextSanitizer === true;  
        document.getElementById('contextSanitizerDepth').value = globalSettings.contextSanitizerDepth !== undefined ? globalSettings.contextSanitizerDepth : 2;  
        // 同时更新深度容器的显示状态  
        const contextSanitizerDepthContainer = document.getElementById('contextSanitizerDepthContainer');  
        if (contextSanitizerDepthContainer) {  
            contextSanitizerDepthContainer.style.display = globalSettings.enableContextSanitizer === true ? 'block' : 'none';  
        }
        // Load filter mode setting (migrate from old doNotDisturbLogMode if exists)
        let filterEnabled = globalSettings.filterEnabled;
        if (filterEnabled === undefined) {
            // Migrate from old doNotDisturbLogMode setting for backward compatibility
            const oldDoNotDisturbMode = globalSettings.doNotDisturbLogMode || (localStorage.getItem('doNotDisturbLogMode') === 'true');
            filterEnabled = oldDoNotDisturbMode;
            globalSettings.filterEnabled = filterEnabled;
            // Also migrate to new setting name for consistency
            globalSettings.doNotDisturbLogMode = filterEnabled;
        }

        if (filterEnabled) {
            doNotDisturbBtn.classList.add('active');
            globalSettings.filterEnabled = true;
        } else {
            doNotDisturbBtn.classList.remove('active');
            globalSettings.filterEnabled = false;
        }

        // Load filter rules
        if (!Array.isArray(globalSettings.filterRules)) {
            globalSettings.filterRules = [];
        }

        // Load middle click quick action settings
        document.getElementById('enableMiddleClickQuickAction').checked = globalSettings.enableMiddleClickQuickAction === true;
        document.getElementById('middleClickQuickAction').value = globalSettings.middleClickQuickAction || '';

        // Load advanced middle click settings
        document.getElementById('enableMiddleClickAdvanced').checked = globalSettings.enableMiddleClickAdvanced === true;
        const advancedDelayInput = document.getElementById('middleClickAdvancedDelay');
        const delayValue = globalSettings.middleClickAdvancedDelay || 1000;
        advancedDelayInput.value = delayValue >= 1000 ? delayValue : 1000; // Ensure minimum 1000ms

        // Load regenerate confirmation setting
        const regenerateConfirmationCheckbox = document.getElementById('enableRegenerateConfirmation');
        if (regenerateConfirmationCheckbox) {
            regenerateConfirmationCheckbox.checked = globalSettings.enableRegenerateConfirmation !== false;
        }

        // Show/hide containers based on enable settings
        const middleClickContainer = document.getElementById('middleClickQuickActionContainer');
        const middleClickAdvancedContainer = document.getElementById('middleClickAdvancedContainer');
        const middleClickAdvancedSettings = document.getElementById('middleClickAdvancedSettings');

        if (middleClickContainer) {
            middleClickContainer.style.display = globalSettings.enableMiddleClickQuickAction === true ? 'block' : 'none';
        }
        if (middleClickAdvancedContainer) {
            middleClickAdvancedContainer.style.display = globalSettings.enableMiddleClickQuickAction === true ? 'block' : 'none';
        }
        if (middleClickAdvancedSettings) {
            middleClickAdvancedSettings.style.display = globalSettings.enableMiddleClickAdvanced === true ? 'block' : 'none';
        }

        // Apply the theme mode from settings on startup
        if (globalSettings.currentThemeMode && window.electronAPI) {
            console.log(`[Renderer] Applying initial theme mode from settings: ${globalSettings.currentThemeMode}`);
            window.electronAPI.setThemeMode(globalSettings.currentThemeMode);
        }

    } else {
        console.warn('加载全局设置失败或无设置:', settings?.error);
        if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
    }
}
// --- Chat Functionality ---
// --- UI Event Listeners & Helpers ---
function addNetworkPathInput(path = '') {
    const container = document.getElementById('networkNotesPathsContainer');
    const inputGroup = document.createElement('div');
    inputGroup.className = 'network-path-input-group';

    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'networkNotesPath';
    input.placeholder = '例如 \\\\NAS\\Shared\\Notes';
    input.value = path;
    input.style.flexGrow = '1';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '删除';
    removeBtn.className = 'sidebar-button small-button danger-button'; // Re-use existing styles
    removeBtn.style.width = 'auto';
    removeBtn.onclick = () => {
        inputGroup.remove();
    };

    inputGroup.appendChild(input);
    inputGroup.appendChild(removeBtn);
    container.appendChild(inputGroup);
}

function setupEventListeners() {
    const voiceChatBtn = document.getElementById('voiceChatBtn');

    if (voiceChatBtn) {
        voiceChatBtn.addEventListener('click', () => {
            if (currentSelectedItem && currentSelectedItem.type === 'agent' && currentSelectedItem.id) {
                window.electronAPI.openVoiceChatWindow({ agentId: currentSelectedItem.id });
            } else {
                uiHelperFunctions.showToastNotification('请先选择一个Agent才能开始语音聊天。', 'info');
            }
        });
    }

    if (chatMessagesDiv) {
        chatMessagesDiv.addEventListener('click', (event) => {
            const target = event.target.closest('a');
            if (target && target.href) {
                const href = target.href;
                event.preventDefault(); // Prevent default navigation for all links within chat

                if (href.startsWith('#')) { // Internal page anchors
                    console.log('Internal anchor link clicked:', href);
                    // Allow default or custom scroll if desired, for now, Electron handles it if it's a valid ID
                    return;
                }
                if (href.toLowerCase().startsWith('javascript:')) {
                    console.warn('JavaScript link clicked, ignoring.');
                    return;
                }
                // For http, https, file protocols, open externally
                // For http, https, file, magnet protocols, open externally
                if (href.startsWith('http:') || href.startsWith('https:') || href.startsWith('file:') || href.startsWith('magnet:')) {
                    if (window.electronAPI && window.electronAPI.sendOpenExternalLink) {
                        window.electronAPI.sendOpenExternalLink(href);
                    } else {
                        console.warn('[Renderer] electronAPI.sendOpenExternalLink is not available.');
                    }
                } else {
                    console.warn(`[Renderer] Clicked link with unhandled protocol: ${href}`);
                }
            }
        });
    } else {
        console.error('[Renderer] chatMessagesDiv not found during setupEventListeners.');
    }

    sendMessageBtn.addEventListener('click', () => window.chatManager.handleSendMessage());
    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            window.chatManager.handleSendMessage();
        }
    });
    messageInput.addEventListener('input', () => uiHelperFunctions.autoResizeTextarea(messageInput));

    attachFileBtn.addEventListener('click', async () => {
        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelperFunctions.showToastNotification("请先选择一个项目和话题以上传附件。", 'error');
            return;
        }
        const result = await window.electronAPI.selectFilesToSend(currentSelectedItem.id, currentTopicId);

        if (result && result.success && result.attachments && result.attachments.length > 0) {
            result.attachments.forEach(att => {
                if (att.error) {
                    console.error(`Error processing selected file ${att.name || 'unknown'}: ${att.error}`);
                    uiHelperFunctions.showToastNotification(`处理文件 ${att.name || '未知文件'} 失败: ${att.error}`, 'error');
                } else {
                    // Ensure `file` object structure is consistent for `updateAttachmentPreview`
                    attachedFiles.push({
                        file: { name: att.name, type: att.type, size: att.size }, // Standard File-like object
                        localPath: att.internalPath, // Path from fileManager
                        originalName: att.name,
                        _fileManagerData: att // Full object from fileManager for reference
                    });
                }
            });
            updateAttachmentPreview();
        } else if (result && !result.success && result.attachments && result.attachments.length === 0) {
            console.log('[Renderer] File selection cancelled or no files selected.');
        } else if (result && result.error) {
            uiHelperFunctions.showToastNotification(`选择文件时出错: ${result.error}`, 'error');
        }
    });
    
 
    globalSettingsBtn.addEventListener('click', () => uiHelperFunctions.openModal('globalSettingsModal'));
    globalSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // --- Collect Network Notes Paths ---
        const networkNotesPathsContainer = document.getElementById('networkNotesPathsContainer');
        const pathInputs = networkNotesPathsContainer.querySelectorAll('input[name="networkNotesPath"]');
        const networkNotesPaths = Array.from(pathInputs).map(input => input.value.trim()).filter(path => path); // Filter out empty paths
        // --- End Collect Network Notes Paths ---

        const newSettings = { // Read directly from globalSettings for widths
            userName: document.getElementById('userName').value.trim() || '用户',
            enableMiddleClickQuickAction: document.getElementById('enableMiddleClickQuickAction').checked,
            middleClickQuickAction: document.getElementById('middleClickQuickAction').value,
            enableMiddleClickAdvanced: document.getElementById('enableMiddleClickAdvanced').checked,
            middleClickAdvancedDelay: Math.max(1000, parseInt(document.getElementById('middleClickAdvancedDelay').value, 10) || 1000),
            enableRegenerateConfirmation: document.getElementById('enableRegenerateConfirmation').checked,
            vcpServerUrl: window.settingsManager.completeVcpUrl(document.getElementById('vcpServerUrl').value.trim()),
            vcpApiKey: document.getElementById('vcpApiKey').value,
            vcpLogUrl: document.getElementById('vcpLogUrl').value.trim(),
            vcpLogKey: document.getElementById('vcpLogKey').value.trim(),
            topicSummaryModel: document.getElementById('topicSummaryModel').value.trim(),
            networkNotesPaths: networkNotesPaths, // Use the new array
            sidebarWidth: globalSettings.sidebarWidth, // Keep existing value if not changed by resizer
            notificationsSidebarWidth: globalSettings.notificationsSidebarWidth, // Keep existing
            // userAvatarUrl and userAvatarCalculatedColor are handled by saveUserAvatar
            enableAgentBubbleTheme: document.getElementById('enableAgentBubbleTheme').checked,
            enableSmoothStreaming: document.getElementById('enableSmoothStreaming').checked,
            minChunkBufferSize: parseInt(document.getElementById('minChunkBufferSize').value, 10) || 1,
            smoothStreamIntervalMs: parseInt(document.getElementById('smoothStreamIntervalMs').value, 10) || 25,
            // assistantEnabled is no longer part of the form, it's managed by the toggle button
            assistantAgent: assistantAgentSelect.value,
            enableDistributedServer: document.getElementById('enableDistributedServer').checked,
            agentMusicControl: document.getElementById('agentMusicControl').checked,
            enableVcpToolInjection: document.getElementById('enableVcpToolInjection').checked,
            enableContextSanitizer: document.getElementById('enableContextSanitizer').checked,
            contextSanitizerDepth: parseInt(document.getElementById('contextSanitizerDepth').value, 10) || 0,
        };

        const userAvatarCropped = getCroppedFile('user'); // Use central getter
        if (userAvatarCropped) {
            try {
                const arrayBuffer = await userAvatarCropped.arrayBuffer();
                const avatarSaveResult = await window.electronAPI.saveUserAvatar({
                    name: userAvatarCropped.name,
                    type: userAvatarCropped.type,
                    buffer: arrayBuffer
                });
                if (avatarSaveResult.success) {
                    globalSettings.userAvatarUrl = avatarSaveResult.avatarUrl;
                    userAvatarPreview.src = avatarSaveResult.avatarUrl; // Already has timestamp
                    userAvatarPreview.style.display = 'block';
                    if (window.messageRenderer) {
                        window.messageRenderer.setUserAvatar(avatarSaveResult.avatarUrl);
                    }
                    if (avatarSaveResult.needsColorExtraction && window.electronAPI && window.electronAPI.saveAvatarColor) {
                        if (window.getDominantAvatarColor) {
                            window.getDominantAvatarColor(avatarSaveResult.avatarUrl).then(avgColor => {
                                if (avgColor) {
                                    window.electronAPI.saveAvatarColor({ type: 'user', id: 'user_global', color: avgColor })
                                        .then((saveColorResult) => {
                                            if (saveColorResult && saveColorResult.success) {
                                                globalSettings.userAvatarCalculatedColor = avgColor; // Update global state
                                                if (window.messageRenderer) window.messageRenderer.setUserAvatarColor(avgColor);
                                            } else {
                                                console.warn("Failed to save user avatar color:", saveColorResult?.error);
                                            }
                                        }).catch(err => console.error("Error saving user avatar color:", err));
                                }
                            });
                        }
                    }
                    setCroppedFile('user', null); // Clear centrally
                    userAvatarInput.value = ''; // Clear file input
                } else {
                    uiHelperFunctions.showToastNotification(`保存用户头像失败: ${avatarSaveResult.error}`, 'error');
                }
            } catch (readError) {
                uiHelperFunctions.showToastNotification(`读取用户头像文件失败: ${readError.message}`, 'error');
            }
        }

        const result = await window.electronAPI.saveSettings(newSettings);
        if (result.success) {
            globalSettings = {...globalSettings, ...newSettings }; // Update local globalSettings
            uiHelperFunctions.showToastNotification('全局设置已保存！部分设置（如通知URL/Key）可能需要重新连接生效。');
            uiHelperFunctions.closeModal('globalSettingsModal');
            if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
                 window.electronAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
            } else {
                 window.electronAPI.disconnectVCPLog();
                 if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
            }
       } else {
           uiHelperFunctions.showToastNotification(`保存全局设置失败: ${result.error}`, 'error');
        }
    });

    const addNetworkPathBtn = document.getElementById('addNetworkPathBtn');
    if (addNetworkPathBtn) {
        addNetworkPathBtn.addEventListener('click', () => addNetworkPathInput());
    }

    if (userAvatarInput) {
        userAvatarInput.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                uiHelperFunctions.openAvatarCropper(file, (croppedFile) => {
                    setCroppedFile('user', croppedFile); // Use central setter
                    if (userAvatarPreview) {
                        userAvatarPreview.src = URL.createObjectURL(croppedFile);
                        userAvatarPreview.style.display = 'block';
                    }
                }, 'user'); // Pass type to cropper
            } else {
                if (userAvatarPreview) userAvatarPreview.style.display = 'none';
                setCroppedFile('user', null);
            }
        });
    }

    // "Create Agent" button
    if (createNewAgentBtn) {
        createNewAgentBtn.textContent = '创建 Agent'; // Update text
        createNewAgentBtn.style.width = 'auto'; // Adjust width
        createNewAgentBtn.addEventListener('click', async () => {
            const defaultAgentName = `新Agent_${Date.now()}`;
            const result = await window.electronAPI.createAgent(defaultAgentName); // No initial config
            if (result.success) {
                await window.itemListManager.loadItems(); // Reload combined list
                // Select the new agent and open its settings
                await window.chatManager.selectItem(result.agentId, 'agent', result.agentName, null, result.config);
                window.uiManager.switchToTab('settings'); // displaySettingsForItem will be called by selectItem or switchToTab
            } else {
                uiHelperFunctions.showToastNotification(`创建Agent失败: ${result.error}`, 'error');
            }
        });
    }
    // "Create Group" button (listener typically in GroupRenderer.init or similar)
    if (createNewGroupBtn) {
        createNewGroupBtn.style.display = 'inline-block'; // Make it visible
        // The actual click listener for createNewGroupBtn should be in GroupRenderer.js
        // to keep group creation logic encapsulated there.
        // If GroupRenderer.handleCreateNewGroup needs to be called from here:
        // createNewGroupBtn.addEventListener('click', () => {
        //    if(window.GroupRenderer) window.GroupRenderer.handleCreateNewGroup();
        // });
    }


    currentItemActionBtn.addEventListener('click', async () => {
        if (!currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification("请先选择一个项目。", 'error');
            return;
        }
        await window.chatManager.createNewTopicForItem(currentSelectedItem.id, currentSelectedItem.type);
    });


    clearNotificationsBtn.addEventListener('click', () => {
        notificationsListUl.innerHTML = '';
    });



    const openTranslatorBtn = document.getElementById('openTranslatorBtn');
    const openNotesBtn = document.getElementById('openNotesBtn');
    if (openAdminPanelBtn) {
        openAdminPanelBtn.style.display = 'inline-block'; // Should be visible by default
        // Add event listener for middle click quick action enable toggle
        const enableMiddleClickCheckbox = document.getElementById('enableMiddleClickQuickAction');
        const middleClickContainer = document.getElementById('middleClickQuickActionContainer');
        const middleClickAdvancedContainer = document.getElementById('middleClickAdvancedContainer');

        if (enableMiddleClickCheckbox && middleClickContainer && middleClickAdvancedContainer) {
            enableMiddleClickCheckbox.addEventListener('change', () => {
                const isEnabled = enableMiddleClickCheckbox.checked;
                middleClickContainer.style.display = isEnabled ? 'block' : 'none';
                middleClickAdvancedContainer.style.display = isEnabled ? 'block' : 'none';
            });
        }

        // Add event listener for advanced middle click enable toggle
        const enableMiddleClickAdvancedCheckbox = document.getElementById('enableMiddleClickAdvanced');
        const middleClickAdvancedSettings = document.getElementById('middleClickAdvancedSettings');

        if (enableMiddleClickAdvancedCheckbox && middleClickAdvancedSettings) {
            enableMiddleClickAdvancedCheckbox.addEventListener('change', () => {
                middleClickAdvancedSettings.style.display = enableMiddleClickAdvancedCheckbox.checked ? 'block' : 'none';
            });
        }

        // Add event listener for middle click quick action selection to control regenerate confirmation visibility
        const middleClickQuickActionSelect = document.getElementById('middleClickQuickAction');
        const regenerateConfirmationContainer = document.getElementById('regenerateConfirmationContainer');

        if (enableMiddleClickCheckbox && middleClickQuickActionSelect && regenerateConfirmationContainer) {
            const updateRegenerateConfirmationVisibility = () => {
                const isMiddleClickEnabled = enableMiddleClickCheckbox.checked;
                const selectedAction = middleClickQuickActionSelect.value;
                const shouldShowConfirmation = isMiddleClickEnabled && selectedAction === 'regenerate';

                regenerateConfirmationContainer.style.display = shouldShowConfirmation ? 'block' : 'none';
            };

            // Initial check
            updateRegenerateConfirmationVisibility();

            // Listen for changes on both controls
            enableMiddleClickCheckbox.addEventListener('change', updateRegenerateConfirmationVisibility);
            middleClickQuickActionSelect.addEventListener('change', updateRegenerateConfirmationVisibility);
        }

        // Add validation for middle click advanced delay input
        const middleClickAdvancedDelayInput = document.getElementById('middleClickAdvancedDelay');
        if (middleClickAdvancedDelayInput) {
            middleClickAdvancedDelayInput.addEventListener('input', (e) => {
                const value = parseInt(e.target.value, 10);
                if (value < 1000) {
                    e.target.value = 1000;
                    uiHelperFunctions.showToastNotification('九宫格出现延迟不能小于1000ms，已自动调整', 'info');
                }
            });

            middleClickAdvancedDelayInput.addEventListener('blur', (e) => {
                const value = parseInt(e.target.value, 10);
                if (isNaN(value) || value < 1000) {
                    e.target.value = 1000;
                    uiHelperFunctions.showToastNotification('九宫格出现延迟不能小于1000ms，已自动调整', 'info');
                }
            });
        }

        // Test middle click grid button has been removed as requested

        openAdminPanelBtn.addEventListener('click', async () => {
            if (globalSettings.vcpServerUrl) {
                if (window.electronAPI && window.electronAPI.sendOpenExternalLink) {
                    try {
                        const apiUrl = new URL(globalSettings.vcpServerUrl);
                        let adminPanelUrl = `${apiUrl.protocol}//${apiUrl.host}`;
                        if (!adminPanelUrl.endsWith('/')) {
                            adminPanelUrl += '/';
                        }
                        adminPanelUrl += 'AdminPanel/'; // Standard path

                        window.electronAPI.sendOpenExternalLink(adminPanelUrl);
                    } catch (e) {
                        console.error('构建管理面板URL失败:', e);
                        uiHelperFunctions.showToastNotification('无法构建管理面板URL。请检查VCP服务器URL。', 'error');
                    }
                } else {
                    console.warn('[Renderer] electronAPI.sendOpenExternalLink is not available.');
                    uiHelperFunctions.showToastNotification('无法打开管理面板：功能不可用。', 'error');
                }
            } else {
                uiHelperFunctions.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error');
                openModal('globalSettingsModal');
            }
        });
    }

    if (openTranslatorBtn) {
        console.log('[Renderer] openTranslatorBtn found. Adding event listener.');
        openTranslatorBtn.addEventListener('click', async () => {
            if (window.electronAPI && window.electronAPI.openTranslatorWindow) {
                await window.electronAPI.openTranslatorWindow();
            } else {
                console.warn('[Renderer] electronAPI.openTranslatorWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开翻译助手：功能不可用。', 'error');
            }
        });
    }

    if (openNotesBtn) {
        openNotesBtn.addEventListener('click', async () => {
            if (window.electronAPI && window.electronAPI.openNotesWindow) {
                await window.electronAPI.openNotesWindow();
            } else {
                console.warn('[Renderer] electronAPI.openNotesWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开笔记：功能不可用。', 'error');
            }
        });
    }

    const openMusicBtn = document.getElementById('openMusicBtn');
    if (openMusicBtn) {
        openMusicBtn.addEventListener('click', () => {
            // Correct way to send IPC message via preload script
            if (window.electron) {
                window.electron.send('open-music-window');
            } else {
                console.error('Music Player: electron context bridge not found.');
            }
        });
    }

    const openCanvasBtn = document.getElementById('openCanvasBtn');
    if (openCanvasBtn) {
        openCanvasBtn.addEventListener('click', () => {
            if (window.electronAPI && window.electronAPI.openCanvasWindow) {
                window.electronAPI.openCanvasWindow();
            } else {
                console.error('Canvas: electronAPI.openCanvasWindow not found.');
            }
        });
    }

    if (toggleNotificationsBtn && notificationsSidebar) {
        toggleNotificationsBtn.addEventListener('click', () => {
            window.electronAPI.sendToggleNotificationsSidebar(); // Send to main
        });

        // 新增：右键单击打开VCP信息流监控面板
        toggleNotificationsBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            console.log('Right-click on toggleNotificationsBtn detected, opening RAG Observer.');
            if (window.electronAPI && window.electronAPI.openRAGObserverWindow) {
                window.electronAPI.openRAGObserverWindow();
            } else {
                console.error('electronAPI.openRAGObserverWindow is not defined!');
                uiHelperFunctions.showToastNotification('功能缺失: preload.js需要更新。', 'error');
            }
        });

        // Listen for main process to actually toggle
        window.electronAPI.onDoToggleNotificationsSidebar(() => {
            const isActive = notificationsSidebar.classList.toggle('active');
            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.classList.toggle('notifications-sidebar-active', isActive);
            }
            if (isActive && globalSettings.notificationsSidebarWidth) {
                 notificationsSidebar.style.width = `${globalSettings.notificationsSidebarWidth}px`;
            }
        });
    }

    if (toggleAssistantBtn) {
        toggleAssistantBtn.addEventListener('click', async () => {
            const isActive = toggleAssistantBtn.classList.toggle('active');
            globalSettings.assistantEnabled = isActive;

            // Notify main process immediately
            window.electronAPI.toggleSelectionListener(isActive);

            // Save the setting immediately
            const result = await window.electronAPI.saveSettings({
                ...globalSettings, // Send all settings to avoid overwriting
                assistantEnabled: isActive
            });

            if (result.success) {
                uiHelperFunctions.showToastNotification(`划词助手已${isActive ? '开启' : '关闭'}`, 'info');
            } else {
                uiHelperFunctions.showToastNotification(`设置划词助手状态失败: ${result.error}`, 'error');
                // Revert UI on failure
                toggleAssistantBtn.classList.toggle('active', !isActive);
                globalSettings.assistantEnabled = !isActive;
            }
        });
    }
    if (agentSearchInput) {
        agentSearchInput.addEventListener('input', (e) => {
            filterAgentList(e.target.value);
        });
    }

    if (minimizeToTrayBtn) {
        minimizeToTrayBtn.addEventListener('click', () => {
            // This will be handled by a function exposed on the electronAPI
            // which in turn sends an IPC message to the main process.
            window.electronAPI.minimizeToTray();
        });
    }

    const enableContextSanitizerCheckbox = document.getElementById('enableContextSanitizer');
    const contextSanitizerDepthContainer = document.getElementById('contextSanitizerDepthContainer');

    if (enableContextSanitizerCheckbox && contextSanitizerDepthContainer) {
        enableContextSanitizerCheckbox.addEventListener('change', () => {
            contextSanitizerDepthContainer.style.display = enableContextSanitizerCheckbox.checked ? 'block' : 'none';
        });
    }

    // 添加全局键盘快捷键监听器
    document.addEventListener('keydown', (e) => {
        // Ctrl+S 或 Command+S 保存设置快捷键
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
            e.preventDefault();

            // 检查当前是否在设置页面
            const tabContentSettings = document.getElementById('tabContentSettings');
            if (tabContentSettings && tabContentSettings.classList.contains('active')) {
                handleQuickSaveSettings();
            }
        }

        // Ctrl+E 或 Command+E 导出话题快捷键
        if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
            e.preventDefault();

            // 检查当前是否有话题打开
            if (currentTopicId && currentSelectedItem.id) {
                handleQuickExportTopic();
            }
        }
    });
}
    // --- Dynamic Seam Fixer Width ---
    const seamFixer = document.getElementById('title-bar-seam-fixer');

    if (seamFixer && notificationsSidebar) {
        const setSeamFixerWidth = () => {
            // Use getBoundingClientRect for precise width, including borders/padding.
            const sidebarWidth = notificationsSidebar.getBoundingClientRect().width;
            // When the sidebar is visible (width > 0), add a 2px offset to account for the resizer.
            const offset = sidebarWidth > 0 ? 3 : 0;
            seamFixer.style.right = `${sidebarWidth + offset}px`;
        };

        // Use ResizeObserver to watch for width changes (e.g., from dragging the resizer).
        const resizeObserver = new ResizeObserver(setSeamFixerWidth);
        resizeObserver.observe(notificationsSidebar);

        // Use MutationObserver to watch for class/style changes (e.g., toggling the 'active' class).
        // This is crucial because toggling the sidebar might not fire a resize event immediately.
        const mutationObserver = new MutationObserver(setSeamFixerWidth);
        mutationObserver.observe(notificationsSidebar, { attributes: true, attributeFilter: ['class', 'style'] });

        // Set the initial width on load.
        setSeamFixerWidth();
    }
    // --- End Dynamic Seam Fixer Width ---


 


function filterAgentList(searchTerm) {
    const lowerCaseSearchTerm = searchTerm.toLowerCase().trim();
    const items = itemListUl.querySelectorAll('li'); // Get all list items

    items.forEach(item => {
        const nameElement = item.querySelector('.agent-name');
        if (nameElement) {
            const name = nameElement.textContent.toLowerCase();
            if (name.includes(lowerCaseSearchTerm)) {
                item.style.display = ''; // Reset to default display style from CSS
            } else {
                item.style.display = 'none';
            }
        }
    });
}

function updateAttachmentPreview() {
    if (!attachmentPreviewArea) {
        console.error('[Renderer] updateAttachmentPreview: attachmentPreviewArea is null or undefined!');
        return;
    }

    attachmentPreviewArea.innerHTML = ''; // Clear previous previews
    if (attachedFiles.length === 0) {
        attachmentPreviewArea.style.display = 'none';
        return;
    }
    attachmentPreviewArea.style.display = 'flex'; // Show the area

    attachedFiles.forEach((af, index) => {
        const prevDiv = document.createElement('div');
        prevDiv.className = 'attachment-preview-item';
        prevDiv.title = af.originalName || af.file.name;

        const fileType = af.file.type;

        if (fileType.startsWith('image/')) {
            const thumbnailImg = document.createElement('img');
            thumbnailImg.className = 'attachment-thumbnail-image';
            thumbnailImg.src = af.localPath; // Assumes localPath is a usable URL (e.g., file://)
            thumbnailImg.alt = af.originalName || af.file.name;
            thumbnailImg.onerror = () => { // Fallback to icon if image fails to load
                thumbnailImg.remove(); // Remove broken image
                const iconSpanFallback = document.createElement('span');
                iconSpanFallback.className = 'file-preview-icon';
                iconSpanFallback.textContent = '⚠️'; // Error/fallback icon
                prevDiv.prepend(iconSpanFallback); // Add fallback icon at the beginning
            };
            prevDiv.appendChild(thumbnailImg);
        } else {
            const iconSpan = document.createElement('span');
            iconSpan.className = 'file-preview-icon';
            if (fileType.startsWith('audio/')) {
                iconSpan.textContent = '🎵';
            } else if (fileType.startsWith('video/')) {
                iconSpan.textContent = '🎞️';
            } else if (fileType.includes('pdf')) {
                iconSpan.textContent = '📄';
            } else {
                iconSpan.textContent = '📎';
            }
            prevDiv.appendChild(iconSpan);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-preview-name';
        const displayName = af.originalName || af.file.name;
        nameSpan.textContent = displayName.length > 20 ? displayName.substring(0, 17) + '...' : displayName;
        prevDiv.appendChild(nameSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-preview-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.title = '移除此附件';
        removeBtn.onclick = () => {
            attachedFiles.splice(index, 1);
            updateAttachmentPreview();
        };
        prevDiv.appendChild(removeBtn);

        attachmentPreviewArea.appendChild(prevDiv);
    });
}




 
let markedInstance;
if (window.marked && typeof window.marked.Marked === 'function') { // Ensure Marked is a constructor
    try {
        markedInstance = new window.marked.Marked({
            sanitize: false,
            gfm: true,
            breaks: true,
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
function getCroppedFile(type) {
    if (type === 'agent') return croppedAgentAvatarFile;
    if (type === 'group') return croppedGroupAvatarFile;
    if (type === 'user') return croppedUserAvatarFile;
    return null;
}

// Helper to set a centrally stored cropped file
function setCroppedFile(type, file) {
    if (type === 'agent') croppedAgentAvatarFile = file;
    else if (type === 'group') croppedGroupAvatarFile = file;
    else if (type === 'user') croppedUserAvatarFile = file;
}

// --- Forward Message Functionality ---
let messageToForward = null;
let selectedForwardTarget = null;

async function showForwardModal(message) {
    messageToForward = message;
    selectedForwardTarget = null; // Reset selection
    const modal = document.getElementById('forwardMessageModal');
    const targetList = document.getElementById('forwardTargetList');
    const searchInput = document.getElementById('forwardTargetSearch');
    const commentInput = document.getElementById('forwardAdditionalComment');
    const confirmBtn = document.getElementById('confirmForwardBtn');

    targetList.innerHTML = '<li>Loading...</li>';
    commentInput.value = '';
    searchInput.value = '';
    confirmBtn.disabled = true;

    uiHelperFunctions.openModal('forwardMessageModal');

    const result = await window.electronAPI.getAllItems();
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
    const originalMessageResult = await window.electronAPI.getOriginalMessageContent(
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
window.getCroppedFile = getCroppedFile;
window.setCroppedFile = setCroppedFile;
window.ensureAudioContext = () => { /* Placeholder, will be defined in setupTtsListeners */ };
window.showForwardModal = showForwardModal;

// Make globalSettings accessible for notification renderer
window.globalSettings = globalSettings;

// Make filter functions globally accessible for notification renderer
window.checkMessageFilter = (messageTitle) => {
    if (window.filterManager) {
        return window.filterManager.checkMessageFilter(messageTitle);
    }
    // Fallback if the manager is not available
    return null;
};

// --- 快捷键处理函数 ---

/**
 * 处理快速保存设置的快捷键功能
 */
function handleQuickSaveSettings() {
    console.log('[快捷键] 执行快速保存设置');

    // 检查当前选中的项目
    if (!currentSelectedItem.id) {
        uiHelperFunctions.showToastNotification('请先选择一个Agent或群组', 'warning');
        return;
    }

    // 检查是否有未保存的更改
    const agentSettingsForm = document.getElementById('agentSettingsForm');
    if (agentSettingsForm && currentSelectedItem.type === 'agent') {
        // 对于Agent设置，直接提交表单
        if (agentSettingsForm) {
            // 创建并派发一个假的表单提交事件
            const fakeEvent = new Event('submit', {
                bubbles: true,
                cancelable: true
            });
            agentSettingsForm.dispatchEvent(fakeEvent);
        } else {
            uiHelperFunctions.showToastNotification('Agent设置表单不可用', 'error');
        }
    } else if (currentSelectedItem.type === 'group') {
        // 对于群组设置，直接提交表单
        const groupSettingsForm = document.getElementById('groupSettingsForm');
        if (groupSettingsForm) {
            // 创建并派发一个假的表单提交事件
            const fakeEvent = new Event('submit', {
                bubbles: true,
                cancelable: true
            });
            groupSettingsForm.dispatchEvent(fakeEvent);
        } else {
            uiHelperFunctions.showToastNotification('群组设置表单不可用', 'error');
        }
    } else {
        uiHelperFunctions.showToastNotification('当前没有可保存的设置', 'info');
    }
}

/**
 * 处理快速导出话题的快捷键功能
 */
async function handleQuickExportTopic() {
    console.log('[快捷键] 执行快速导出话题');

    if (!currentTopicId || !currentSelectedItem.id) {
        uiHelperFunctions.showToastNotification('请先选择并打开一个话题', 'warning');
        return;
    }

    try {
        // 获取当前话题的名称
        let topicName = '未命名话题';
        if (currentSelectedItem.config && currentSelectedItem.config.topics) {
            const currentTopic = currentSelectedItem.config.topics.find(t => t.id === currentTopicId);
            if (currentTopic) {
                topicName = currentTopic.name;
            }
        }

        // 获取聊天消息内容
        const chatMessagesDiv = document.getElementById('chatMessages');
        if (!chatMessagesDiv) {
            uiHelperFunctions.showToastNotification('错误：找不到聊天内容容器', 'error');
            return;
        }

        const messageItems = chatMessagesDiv.querySelectorAll('.message-item');
        if (messageItems.length === 0) {
            uiHelperFunctions.showToastNotification('此话题没有可见的聊天内容可导出', 'info');
            return;
        }

        // 构建Markdown内容
        let markdownContent = `# 话题: ${topicName}\n\n`;
        let extractedCount = 0;

        messageItems.forEach((item) => {
            if (item.classList.contains('system') || item.classList.contains('thinking')) {
                return;
            }

            const senderElement = item.querySelector('.sender-name');
            const contentElement = item.querySelector('.md-content');

            if (senderElement && contentElement) {
                const sender = senderElement.textContent.trim().replace(':', '');
                let content = contentElement.innerText || contentElement.textContent || "";
                content = content.trim();

                if (sender && content) {
                    markdownContent += `**${sender}**: ${content}\n\n---\n\n`;
                    extractedCount++;
                }
            }
        });

        if (extractedCount === 0) {
            uiHelperFunctions.showToastNotification('未能从当前话题中提取任何有效对话内容', 'warning');
            return;
        }

        // 调用导出功能
        const result = await window.electronAPI.exportTopicAsMarkdown({
            topicName: topicName,
            markdownContent: markdownContent
        });

        if (result.success) {
            uiHelperFunctions.showToastNotification(`话题 "${topicName}" 已成功导出到: ${result.path}`, 'success');
        } else {
            uiHelperFunctions.showToastNotification(`导出话题失败: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[快捷键] 导出话题时发生错误:', error);
        uiHelperFunctions.showToastNotification(`导出话题时发生错误: ${error.message}`, 'error');
    }
}
