import { createChatHistoryPersistence } from './modules/chat/chatHistoryPersistence.js';
import { createChatHistoryMutationAuthority } from './modules/chat/chatHistoryMutationAuthority.js';
import { createSurfaceConversation } from './modules/chat/surfaceConversation.js';
import { createStreamTransientHistory } from './modules/chat/streamTransientHistory.js';
import { createMessageRenderer } from './modules/messageRenderer.js';
import { applyUserMessageLayoutState } from './modules/renderer/domBuilder.js';
import { createStreamProjection } from './modules/renderer/streamManager.js';
import { createMainChatEventBridge } from './modules/renderer/mainChatEventBridge.js';
import { createOwnedPreloadSubscription } from './modules/renderer/ownedPreloadSubscription.js';
import { createTopicSelectionReadiness } from './modules/renderer/topicSelectionReadiness.js';
import { createTtsSurfaceOwner } from './modules/renderer/ttsSurfaceOwner.js';
import { createMainChatAuxiliaryEventOwner } from './modules/renderer/mainChatAuxiliaryEventOwner.js';
import { createMainChatFlowlockOwner } from './modules/renderer/mainChatFlowlockOwner.js';
import { createForwardMessageOwner } from './modules/renderer/forwardMessageOwner.js';
import { createMainChatSettingsOwner } from './modules/renderer/mainChatSettingsOwner.js';
import { createDomListenerOwner } from './modules/renderer/domListenerOwner.js';
import { createMainChatThemeOwner } from './modules/renderer/mainChatThemeOwner.js';
import { createMainChatSettingsPresentationOwner } from './modules/renderer/mainChatSettingsPresentationOwner.js';
import { createMainChatAttachmentOwner } from './modules/renderer/mainChatAttachmentOwner.js';
import { createMainChatSendOwner } from './modules/renderer/mainChatSendOwner.js';

const streamManager = createStreamProjection();
const messageRenderer = createMessageRenderer({ streamManager });
import { chatManager } from './modules/chatManager.js';

window.VCPLifecycleInspector?.setStreamDiagnosticsProvider?.(() => streamManager.getDiagnostics());

// --- Globals ---
const mainChatSettingsOwner = createMainChatSettingsOwner({ initial: {
    sidebarWidth: 260,
    showHomeVisualBrand: true,
    showHomeVisualTagline: true,
    homeVisualTagline: '语义级打穿 AI、UI/UX、APP 与人类想象力的边界',
    appearanceProfile: {
        density: 'comfortable',
        radius: 'small',
        typography: 'system',
        fontScale: 'normal',
        contentWidth: 'full',
        sidebarRowHeight: 46,
        sidebarAvatarSize: 32,
        customRadius: 10,
        surface: 'translucent'
    },
    enableMiddleClickQuickAction: false,
    middleClickQuickAction: '',
    enableMiddleClickAdvanced: false,
    middleClickAdvancedDelay: 1000,
    notificationsSidebarWidth: 300,
    userName: '用户', // Default username
    doNotDisturbLogMode: false, // 勿扰模式状态（已废弃，保留兼容性）
    filterEnabled: false, // 过滤总开关状态
    filterRules: [], // 过滤规则列表
    toolAutoApprovalEnabled: false, // 工具调用默认允许总开关
    toolAutoApprovalRules: [], // 工具调用默认允许规则列表
    enableRegenerateConfirmation: true, // 重新回复确认机制开关
    flowlockContinueDelay: 5, // 心流锁续写延迟（秒）
    enableThoughtChainInjection: false, // 元思考注入上下文开关
    fileKey: '',
    enableWideChatLayout: false,
    chatPresentationMode: 'bubble',
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
    voiceLocalSettings: {
        sovitsUrl: '',
        sovitsKey: ''
    },
    voiceNetworkSettings: {
        providerUrl: 'https://api.siliconflow.cn',
        providerKey: ''
    }
} });
const initialSelectedItem = {
    id: null, // Can be agentId or groupId
    type: null, // 'agent' or 'group'
    name: null,
    avatarUrl: null,
    config: null // Store full config object for the selected item
};
const mainChatStateAuthority = createMainChatStateAuthority({ selectedItem: initialSelectedItem, topicId: null, history: [] });
const currentSelectedItemRef = mainChatStateAuthority.selectedItemRef;
const currentTopicIdRef = mainChatStateAuthority.topicIdRef;
const mainHistoryRef = mainChatStateAuthority.historyRef;
const topicSelectionReadiness = createTopicSelectionReadiness();
const chatAPI = window.chatAPI || window.electronAPI;
const STARTUP_SETTINGS_TIMEOUT_MS = 15_000;

// Plugin-facing state is read-only; mutation authority remains here.
Object.defineProperty(window, 'VCPMainChatState', {
    value: Object.freeze(mainChatStateAuthority.consumer),
    writable: false,
    configurable: false,
});
const getGlobalSettings = () => mainChatSettingsOwner.get();

// --- Main-window composition bindings ---
const {
    itemListUl, currentChatNameH3, chatMessagesDiv, messageInput, sendMessageBtn,
    attachFileBtn, emoticonTriggerBtn, quickNewTopicBtn, attachmentPreviewArea,
    chatInputCard, globalSettingsBtn, itemSettingsContainerTitle,
    selectedItemNameForSettingsSpan, agentSettingsContainer, agentSettingsForm,
    editingAgentIdInput, agentNameInput, agentAvatarInput, agentAvatarPreview,
    agentSystemPromptTextarea, agentModelInput, agentTemperatureInput,
    agentContextTokenLimitInput, agentMaxOutputTokensInput, groupSettingsContainer,
    selectItemPromptForSettings, deleteItemBtn, currentItemActionBtn,
    clearCurrentChatBtn, toggleNotificationsBtn, notificationsSidebar,
    vcpLogConnectionStatusDiv, notificationsListUl, sidebarTabButtons,
    sidebarTabContents, tabContentTopics, tabContentSettings, topicSearchInput,
    leftSidebar, rightNotificationsSidebar, resizerLeft, resizerRight,
    agentSearchInput, notificationTitleElement, digitalClockElement,
    dateDisplayElement, toggleAssistantBtn, toggleSidebarModeBtn, openModelSelectBtn,
} = createMainChatDomBindings(document);
// 模态框及其内部元素现在延迟加载，不再在顶层缓存引用
let globalSettingsForm = null;
let userAvatarInput = null;
let userAvatarPreview = null;
console.log('[Renderer EARLY CHECK] selectItemPromptForSettings element:', selectItemPromptForSettings); // 添加日志
function isContextForCurrentChat(context) {
    const currentSelectedItem = currentSelectedItemRef.get();
    const currentTopicId = currentTopicIdRef.get();
    if (!context || !currentSelectedItem?.id || !currentTopicId) return false;
    const contextItemId = context.groupId || context.agentId;
    return contextItemId === currentSelectedItem.id && context.topicId === currentTopicId;
}

// Cropped file state is now managed within modules/ui-helpers.js
let inviteAgentButtonsContainerElement; // 新增：邀请发言按钮容器的引用

// Assistant settings elements
// 模态框内部元素延迟加载
let assistantAgentContainer = null;
let assistantAgentSelect = null;

// Model selection elements
let modelSelectModal = null;
let modelList = null;
let modelSearchInput = null;
let refreshModelsBtn = null;

// UI Helper functions to be passed to modules
// The main uiHelperFunctions object is now defined in modules/ui-helpers.js
// We can reference it directly from the window object.
const uiHelperFunctions = window.uiHelperFunctions;


import searchManager from './modules/searchManager.js';
import * as interruptHandler from './modules/interruptHandler.js';
import { StartupThemeGate, loadSettingsWithTimeout } from './modules/ui-system/startup-theme-gate.js';
 
import { setupEventListeners } from './modules/event-listeners.js';
import { createChatContext } from './modules/chat/chatContext.js';
import { createChatRepository } from './modules/chat/chatRepository.js';
import { createMainChatComposition } from './modules/renderer/mainChatComposition.js';
import { createMainChatDomBindings } from './modules/renderer/mainChatDomBindings.js';
import { createMainChatStateAuthority } from './modules/chat/mainChatStateAuthority.js';
import { createNonStreamingEventConsumer } from './modules/renderer/nonStreamingEventConsumer.js';
import { createChatPresentationState } from './modules/chat/chatPresentationState.js';

const ttsSurfaceOwner = createTtsSurfaceOwner({
    subscribePlay: callback => chatAPI.onPlayTtsAudio(callback),
    subscribeStop: callback => chatAPI.onStopTtsAudio(callback),
    createAudioContext: () => new (window.AudioContext || window.webkitAudioContext)(),
    decodeBase64: value => Uint8Array.from(atob(value), character => character.charCodeAt(0)).buffer,
    updateSpeakingIndicator: (messageId, active) => uiHelperFunctions.updateSpeakingIndicator(messageId, active),
    showError: message => uiHelperFunctions.showToastNotification(message, 'error'),
});

// First production seam for the Chat Kernel migration. Legacy refs remain
// compatible while consumers move to this explicit context.
const initialChatState = mainChatStateAuthority.snapshot();
const chatContext = createChatContext({
    selectedItem: initialChatState.selectedItem,
    topicId: initialChatState.topicId,
    history: mainHistoryRef.get()
});
const chatRepository = createChatRepository(chatAPI);
const historyMutationAuthority = createChatHistoryMutationAuthority({ repository: chatRepository });
const presentationState = createChatPresentationState({ theme: document.body.classList.contains('dark-theme') ? 'dark' : 'light', activeSurface: 'main' });
let mainChatDomRenderer = null;
let mainChatSurface = null;
let mainChatAdapter = null;
let nonStreamingEventConsumer = null;
let mainChatEventBridge = null;
const ownedRendererSubscriptions = new Set();
const mainChatDomListenerOwner = createDomListenerOwner();
const topicListDomListenerOwner = createDomListenerOwner();
const mainChatAttachmentOwner = createMainChatAttachmentOwner({
    renderPreview: (files, removeAttachmentAt) => {
        uiHelperFunctions.updateAttachmentPreview(files, attachmentPreviewArea, removeAttachmentAt);
    },
});
const mainChatSendOwner = createMainChatSendOwner({
    button: sendMessageBtn,
    messagesRoot: chatMessagesDiv,
    historyRef: mainHistoryRef,
    selectedItemRef: currentSelectedItemRef,
    topicIdRef: currentTopicIdRef,
    streamProjection: streamManager,
    chatAPI,
    interruptHandler,
    getAdapter: () => mainChatAdapter,
    getChatManager: () => chatManager,
    messageRenderer,
    notify: (message, type) => uiHelperFunctions?.showToastNotification?.(message, type),
});
const mainChatSettingsPresentationOwner = createMainChatSettingsPresentationOwner({
    documentRef: document,
    settingsOwner: mainChatSettingsOwner,
    listenerOwner: mainChatDomListenerOwner,
    chatAPI,
    elements: {
        leftSidebar,
        rightNotificationsSidebar,
        vcpLogConnectionStatus: vcpLogConnectionStatusDiv,
        toggleAssistant: toggleAssistantBtn,
        toggleSidebarMode: toggleSidebarModeBtn,
    },
    notificationRenderer: window.notificationRenderer,
    messageRenderer,
    windowRef: window,
    getSettingsManager: () => window.settingsManager,
    getAppearance: () => window.VCPAppearance,
    getPretextBridge: () => window.pretextBridge,
});
ownedRendererSubscriptions.add(mainChatSettingsPresentationOwner);
ownedRendererSubscriptions.add(mainChatDomListenerOwner);
ownedRendererSubscriptions.add(topicListDomListenerOwner);
ownedRendererSubscriptions.add(mainChatAttachmentOwner);
ownedRendererSubscriptions.add(mainChatSendOwner);
mainChatSendOwner.update();
ownedRendererSubscriptions.add({
    async dispose() {
        const receipt = { promise: Promise.resolve() };
        window.dispatchEvent(new CustomEvent('vcp-appearance-studio-dispose', { detail: receipt }));
        await receipt.promise;
    },
});
window.notificationRenderer?.configureCapabilities?.({
    filterManager: window.filterManager,
    listenerOwner: mainChatDomListenerOwner,
});
window.settingsManager?.configureCapabilities?.({ settings: mainChatSettingsOwner });
window.weatherService?.configureCapabilities?.({ settings: mainChatSettingsOwner });
window.dispatchEvent(new CustomEvent('vcp-appearance-studio-configure', { detail: {
    settings: mainChatSettingsOwner,
    appearance: window.VCPAppearance,
    uiManager: window.uiManager,
    presentation: Object.freeze({ normalize: normalizeChatPresentationMode, apply: applyChatPresentationMode }),
} }));
const mainChatThemeOwner = createMainChatThemeOwner({
    settingsOwner: mainChatSettingsOwner,
    documentRef: document,
    presentationState,
    getUiManager: () => window.uiManager,
    matchMedia: query => window.matchMedia(query),
    saveSettings: settings => chatAPI.saveSettings(settings),
    pretextBridge: window.pretextBridge,
    refreshLayout: () => messageRenderer?.refreshLayoutDependentState?.(),
    syncControls: mainChatSettingsPresentationOwner.syncPresentationControls,
    captureAnchor: mainChatSettingsPresentationOwner.capturePresentationAnchor,
    restoreAnchor: mainChatSettingsPresentationOwner.restorePresentationAnchor,
    scheduleFrame: callback => requestAnimationFrame(callback),
    notify: (message, type) => uiHelperFunctions?.showToastNotification?.(message, type),
});
mainChatSettingsPresentationOwner.configureThemeOwner(mainChatThemeOwner);
ownedRendererSubscriptions.add(mainChatThemeOwner);
let releaseNextUiChatCapabilities = null;
const forwardMessageOwner = createForwardMessageOwner({
    chatAPI,
    chatManager,
    uiHelperFunctions,
    getConversation: () => ({ item: currentSelectedItemRef.get(), topicId: currentTopicIdRef.get() }),
});
ownedRendererSubscriptions.add(forwardMessageOwner);
const showForwardModal = message => forwardMessageOwner.show(message);

function createOwnedInternalChatRenderer({ root, mode = 'readonly', handleSendMessage = null, conversation = null } = {}) {
    if (!root?.querySelector) throw new TypeError('Internal chat renderer requires a Surface root');
    const conversationCapability = createSurfaceConversation({
        selectedItem: conversation?.selectedItem || currentSelectedItemRef.get(),
        topicId: conversation?.topicId ?? currentTopicIdRef.get(),
    });
    let localSettings = getGlobalSettings();
    let disposed = false;
    const streamProjection = createStreamProjection();
    const transientStreamHistory = createStreamTransientHistory({
        repository: chatRepository,
        currentHistory: {
            get: () => conversationCapability.historyRef.get(),
            replace: history => conversationCapability.historyRef.set(history),
        },
    });
    const surfacePretextPrefix = `surface-${conversationCapability.id || Date.now().toString(36)}`;
    const createSurfacePretextBridge = (bridge) => {
        if (!bridge) return null;
        const key = id => `${surfacePretextPrefix}:${id}`;
        return Object.freeze({
            isReady: () => bridge.isReady?.() === true,
            estimateHeight: (id, ...args) => bridge.estimateHeight?.(key(id), ...args),
            evict: id => bridge.evict?.(key(id)),
        });
    };
    const surfacePretextBridge = createSurfacePretextBridge(window.pretextBridge);
    const renderer = createMessageRenderer({
        streamManager: streamProjection,
        initializeStreamProjection: mode === 'interactive',
        enableContextMenu: false,
        enableMiddleClick: false,
        exposeGlobalCommands: false,
    });
    const surfaceFeedback = Object.freeze({
        resolveAttachmentFileVisual: uiHelperFunctions.resolveAttachmentFileVisual,
        getCompiledRegex: uiHelperFunctions.getCompiledRegex,
        regexFromString: uiHelperFunctions.regexFromString,
        showToastNotification: uiHelperFunctions.showToastNotification,
        scrollToBottom() {
            const scrollRoot = root.closest('.chat-messages-container') || root;
            scrollRoot.scrollTop = scrollRoot.scrollHeight;
        },
    });
    renderer.initializeMessageRenderer({
        chatRepository,
        historyMutationAuthority,
        currentChatHistoryRef: conversationCapability.historyRef,
        currentSelectedItemRef: conversationCapability.selectedItemRef,
        currentTopicIdRef: conversationCapability.topicIdRef,
        transientStreamHistory,
        viewAuthority: {
            isCurrent: context => {
                const selected = conversationCapability.selectedItemRef.get();
                const topicId = conversationCapability.topicIdRef.get();
                const itemId = context?.groupId || context?.agentId;
                return Boolean(selected?.id && topicId && itemId === selected.id && context?.topicId === topicId);
            }
        },
        globalSettingsRef: { get: () => localSettings, set: value => { localSettings = value; } },
        chatMessagesDiv: root,
        electronAPI: chatAPI,
        markedInstance,
        morphdom: window.morphdom,
            pretextBridge: surfacePretextBridge,
        flowlockProtocol: window.flowlockProtocol,
        uiHelper: surfaceFeedback,
        interruptHandler: null,
        messageCommands: { handleSendMessage },
        summarizeTopicFromMessages: async () => '',
        handleCreateBranch: async () => false,
    });
    return Object.freeze({
        renderer,
        mode,
        conversation: conversationCapability,
        async dispose() {
            if (disposed) return;
            disposed = true;
            await streamProjection.dispose();
            await renderer.disposeRootResources(root);
            renderer.disposeRendererResources();
            conversationCapability.dispose();
            localSettings = null;
        },
    });
}

const startupThemeGate = new StartupThemeGate({
    document,
    applyTheme: applyInitialThemeClass,
    statusElement: document.getElementById('startupInitializationStatus'),
});
mainChatSettingsPresentationOwner.configureStartup({
    loadSettings: loadSettingsWithTimeout,
    startupThemeGate,
});
 
 // --- Initialization ---
 mainChatDomListenerOwner.add(document, 'DOMContentLoaded', async () => {
    window.notificationRenderer?.configureCapabilities?.({
        filterManager: window.filterManager,
        listenerOwner: mainChatDomListenerOwner,
    });
    // Initialize Emoticon Manager
    if (window.emoticonManager) {
        window.emoticonManager.initialize({
            emoticonPanel: document.getElementById('emoticonPanel'),
            messageInput: document.getElementById('messageInput'),
        });
    } else {
        console.error('[RENDERER_INIT] emoticonManager module not found!');
    }

    // Initialize App Tray Manager
    if (window.trayManager) {
        window.trayManager.init();
    } else {
        console.error('[RENDERER_INIT] trayManager module not found!');
    }

    if (window.topTabManager) {
        window.topTabManager.init();
    } else {
        console.error('[RENDERER_INIT] topTabManager module not found!');
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
                currentSelectedItemRef,
            },
            mainRendererFunctions: {
                selectItem: (itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) => {
                    // Delayed binding - chatManager will be available when this is called
                    if (chatManager) {
                        return chatManager.selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig);
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
            globalSettingsRef: mainChatSettingsOwner.ref,
            currentSelectedItemRef,
            currentTopicIdRef,
            messageRenderer, // Explicit provider; initialized below
            uiHelper: uiHelperFunctions,
            mainRendererElements: mainRendererElementsForGroupRenderer, // 使用构造好的对象
            mainRendererFunctions: { // Pass shared functions with delayed binding
                loadItems: () => window.itemListManager ? window.itemListManager.loadItems() : console.error('[GroupRenderer] itemListManager not available'),
                selectItem: (itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) => {
                    if (chatManager) {
                        return chatManager.selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig);
                    } else {
                        console.error('[GroupRenderer] chatManager not available for selectItem');
                    }
                },
                highlightActiveItem: (itemId, itemType) => window.itemListManager ? window.itemListManager.highlightActiveItem(itemId, itemType) : console.error('[GroupRenderer] itemListManager not available'),
                displaySettingsForItem: () => window.settingsManager ? window.settingsManager.displaySettingsForItem() : console.error('[GroupRenderer] settingsManager not available'),
                loadTopicList: () => window.topicListManager ? window.topicListManager.loadTopicList() : console.error('[GroupRenderer] topicListManager not available'),
                getAttachedFiles: mainChatAttachmentOwner.get,
                clearAttachedFiles: mainChatAttachmentOwner.clear,
                updateAttachmentPreview: mainChatAttachmentOwner.syncPreview,
                setCroppedFile: uiHelperFunctions.setCroppedFile,
                getCroppedFile: uiHelperFunctions.getCroppedFile,
                setCurrentChatHistory: history => mainHistoryRef.set(history),
                displayTopicTimestampBubble: (itemId, itemType, topicId) => {
                    if (chatManager) {
                        return chatManager.displayTopicTimestampBubble(itemId, itemType, topicId);
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
    if (messageRenderer) {
        interruptHandler.initialize(chatAPI);

        const historyPersistence = createChatHistoryPersistence(chatRepository);
        const transientStreamHistory = createStreamTransientHistory({
            repository: chatRepository,
            currentHistory: { get: mainHistoryRef.get, replace: mainHistoryRef.set },
        });
        const renderDependencies = {
            chatRepository,
            historyMutationAuthority,
            currentChatHistoryRef: mainHistoryRef,
            transientStreamHistory,
            currentSelectedItemRef,
            currentTopicIdRef,
            globalSettingsRef: mainChatSettingsOwner.ref,
            chatMessagesDiv,
            electronAPI: chatAPI,
            markedInstance,
            morphdom: window.morphdom,
        pretextBridge: window.pretextBridge,
            flowlockProtocol: window.flowlockProtocol,
            uiHelper: uiHelperFunctions,
            showForwardModal,
            ensureAudioContext: ttsSurfaceOwner.ensureAudioContext,
            interruptHandler,
            messageCommands: {
                processFilesData: (...args) => chatManager.processFilesData(...args),
                addAttachmentsToMessage: (...args) => chatManager.addAttachmentsToMessage(...args),
                removeAttachmentFromMessage: (...args) => chatManager.removeAttachmentFromMessage(...args),
                syncNextUiEmptyStateWithMessages: (...args) => chatManager.syncNextUiEmptyStateWithMessages(...args),
                handleSendMessage: (...args) => chatManager.handleSendMessage(...args),
                updateSendButtonState: mainChatSendOwner.update,
            },
            summarizeTopicFromMessages: (messages, agentName) => {
                if (typeof window.summarizeTopicFromMessages === 'function') return window.summarizeTopicFromMessages(messages, agentName);
                console.error('[MessageRenderer] summarizeTopicFromMessages function not found on window scope.');
                return `关于 "${messages.find(m => m.role === 'user')?.content.substring(0, 15) || '...'}" (备用)`;
            },
            handleCreateBranch: selectedMessage => chatManager?.handleCreateBranch(selectedMessage),
        };
        const mainComposition = createMainChatComposition({
            root: chatMessagesDiv,
            messageInput,
            messageRenderer,
            streamProjection: streamManager,
            chatRepository,
            historyPersistence,
            presentationState,
            renderDependencies,
            chatManager,
            flowlockManager: window.flowlockManager,
            currentSelection: currentSelectedItemRef.get,
            currentTopicId: currentTopicIdRef.get,
            chatWindow: window,
            interrupt: mainChatSendOwner.interrupt,
            dispatchTerminal: detail => window.dispatchEvent(new CustomEvent('vcp-chat-stream-terminal', { detail })),
            notifySendStateChanged: mainChatSendOwner.update,
            showForwardModal,
            provideCapabilities: window.VCPNextShellController?.provideChatCapabilities,
            capabilitySnapshot: () => Object.freeze({
                selectedItem: currentSelectedItemRef.get(),
                topicId: currentTopicIdRef.get(),
            }),
            settings: mainChatSettingsOwner,
            createInternalRenderer: createOwnedInternalChatRenderer,
            disposeCapabilities: async () => {
                await mainChatEventBridge?.dispose?.();
                mainChatEventBridge = null;
                await nonStreamingEventConsumer?.dispose?.();
                nonStreamingEventConsumer = null;
                releaseNextUiChatCapabilities?.();
                releaseNextUiChatCapabilities = null;
                const subscriptions = [...ownedRendererSubscriptions].reverse();
                ownedRendererSubscriptions.clear();
                for (const subscription of subscriptions) {
                    try {
                        await subscription.dispose();
                    } catch (error) {
                        console.error('[Renderer] Owned capability disposal failed:', error);
                    }
                }
            },
        });
        mainChatAdapter = mainComposition.adapter;
        mainChatSurface = mainChatAdapter.surface;
        mainChatDomRenderer = mainChatAdapter.domRenderer;
        nonStreamingEventConsumer = createNonStreamingEventConsumer({
            renderTarget: mainChatDomRenderer,
            messageRenderer,
            viewAuthority: { isCurrent: isContextForCurrentChat },
        });
        releaseNextUiChatCapabilities = mainComposition.releaseCapabilities;

    } else {
        console.error('[RENDERER_INIT] messageRenderer module not found!');
    }

    if (window.inputEnhancer) {
        window.inputEnhancer.initializeInputEnhancer({
            messageInput: messageInput,
            dropTargetElement: chatInputCard,
            electronAPI: chatAPI,
            attachedFiles: mainChatAttachmentOwner.ref,
            updateAttachmentPreview: mainChatAttachmentOwner.syncPreview,
            getCurrentAgentId: () => currentSelectedItemRef.get()?.id,
            getCurrentTopicId: currentTopicIdRef.get,
            uiHelper: uiHelperFunctions,
            listenerOwner: mainChatDomListenerOwner,
        });
        ownedRendererSubscriptions.add({ dispose: () => window.inputEnhancer.dispose?.() });
    } else {
        console.error('[RENDERER_INIT] inputEnhancer module not found!');
    }

    const auxiliaryEventOwner = createMainChatAuxiliaryEventOwner({
        subscriptions: {
            loomShareText: chatAPI?.onLoomShareTextToInput,
            logStatus: chatAPI?.onVCPLogStatus,
            logMessage: chatAPI?.onVCPLogMessage,
            groupTopicUpdated: chatAPI?.onVCPGroupTopicUpdated,
        },
        insertSharedText: (sharedText) => {
            if (!messageInput || typeof sharedText !== 'string' || !sharedText) return;
            const start = Number.isInteger(messageInput.selectionStart)
                ? messageInput.selectionStart
                : messageInput.value.length;
            const end = Number.isInteger(messageInput.selectionEnd)
                ? messageInput.selectionEnd
                : start;
            const separator = start > 0 && !messageInput.value.slice(0, start).endsWith('\n') ? '\n\n' : '';
            const insertion = `${separator}${sharedText}`;
            messageInput.setRangeText(insertion, start, end, 'end');
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            messageInput.focus();
            uiHelperFunctions?.showToastNotification?.('Loom 页面文本已加入输入框。', 'success');
        },
        consumeLogStatus: statusUpdate => window.notificationRenderer?.updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv),
        consumeLogMessage: logData => {
            if (!window.notificationRenderer) return;
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
        },
        consumeGroupTopicUpdate: async ({ groupId, topicId, newTitle, topics }, lifecycle) => {
            const selectedItem = currentSelectedItemRef.get();
            if (selectedItem?.id !== groupId || selectedItem.type !== 'group') return;
            const config = selectedItem.config || selectedItem;
            if (config) {
                const nextConfig = { ...config };
                const topicIndex = Array.isArray(config.topics)
                    ? config.topics.findIndex(topic => topic.id === topicId)
                    : -1;
                if (topicIndex >= 0) {
                    nextConfig.topics = config.topics.map((topic, index) => (
                        index === topicIndex ? { ...topic, name: newTitle } : topic
                    ));
                } else {
                    nextConfig.topics = topics;
                }
                currentSelectedItemRef.set(selectedItem.config
                    ? { ...selectedItem, config: nextConfig }
                    : { ...selectedItem, ...nextConfig });
            }
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                await window.topicListManager.loadTopicList();
                if (!lifecycle.isActive()) return;
            }
        },
    });
    auxiliaryEventOwner.mount();
    ownedRendererSubscriptions.add(auxiliaryEventOwner);

    mainChatEventBridge = createMainChatEventBridge({
        chatAPI,
        acceptStreamEvent: eventData => mainChatAdapter?.acceptStreamEvent(eventData) === true,
        consumeNonStreamingEvent: eventData => nonStreamingEventConsumer?.consume(eventData),
    });

    // Initialize TopicListManager
    if (window.topicListManager) {
        window.topicListManager.init({
            elements: {
            topicListContainer: tabContentTopics,
            },
            electronAPI: chatAPI,
            chatRepository: chatRepository,
            refs: {
                currentSelectedItemRef,
                currentTopicIdRef,
            },
            topicSelectionReadiness,
            listenerOwner: topicListDomListenerOwner,
            uiManager: window.uiManager,
            itemListManager: window.itemListManager,
            uiHelper: uiHelperFunctions,
            mainRendererFunctions: {
                updateCurrentItemConfig: (newConfig) => {
                    const selectedItem = currentSelectedItemRef.get();
                    currentSelectedItemRef.set(selectedItem?.config
                        ? { ...selectedItem, config: newConfig }
                        : { ...selectedItem, ...newConfig });
                },
                handleTopicDeletion: (remainingTopics, deletionContext) => {
                    if (chatManager) {
                        return chatManager.handleTopicDeletion(remainingTopics, deletionContext);
                    } else {
                        console.error('[TopicListManager] chatManager not available for handleTopicDeletion');
                    }
                },
                selectTopic: (topicId) => {
                    if (chatManager) {
                        return chatManager.selectTopic(topicId);
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
    if (chatManager) {
        chatManager.init({
            chatContext,
            chatRepository,
            streamConsumerRegistry: mainChatAdapter?.streamRoutes,
            chatDomRenderer: mainChatDomRenderer,
            electronAPI: chatAPI,
            uiHelper: uiHelperFunctions,
            modules: {
                messageRenderer,
                itemListManager: window.itemListManager,
                topicListManager: window.topicListManager,
                groupRenderer: window.GroupRenderer,
                streamManager,
                interruptHandler,
            },
            refs: {
                currentSelectedItemRef,
                currentTopicIdRef,
                currentChatHistoryRef: mainHistoryRef,
                attachedFilesRef: mainChatAttachmentOwner.ref,
                globalSettingsRef: mainChatSettingsOwner.ref,
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
                updateAttachmentPreview: mainChatAttachmentOwner.syncPreview,
                // This is no longer needed as chatManager will call messageRenderer's summarizer
            },
            notifySendStateChanged: mainChatSendOwner.update
        });
        ownedRendererSubscriptions.add(chatManager);
        ownedRendererSubscriptions.add({ dispose: () => window.topicListManager.dispose?.() });
        window.dispatchEvent(new CustomEvent('vcp-main-chat-commands-configure', { detail: {
            chatManager,
            capabilities: {
                uiHelper: uiHelperFunctions,
                uiManager: window.uiManager,
                itemListManager: window.itemListManager,
                filterManager: window.filterManager,
                notificationRenderer: window.notificationRenderer,
                appearanceStudio: window.VCPAppearanceStudio,
                topTabManager: window.topTabManager,
            },
        } }));
    } else {
        console.error('[RENDERER_INIT] chatManager module not found!');
    }


    // Initialize Settings Manager
    if (window.settingsManager) {
        window.settingsManager.init({
            electronAPI: chatAPI,
            uiHelper: uiHelperFunctions,
            messageRenderer,
            refs: {
                currentSelectedItemRef,
                currentTopicIdRef,
                currentChatHistoryRef: mainHistoryRef,
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
                    chatManager.displayNoItemSelected();
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
        setupChatPresentationQuickSwitcher();
        try {
            await loadAndApplyGlobalSettings();
        } catch (error) {
            // Do not leave the startup gate closed if settings IPC fails.
            console.error('[RENDERER_INIT] Failed to load global settings:', error);
            startupThemeGate.release({ mode: 'system', message: error?.message || '设置加载失败，已使用系统主题' });
        }
        await window.itemListManager.loadItems(); // Load both agents and groups
        await chatManager.restoreLastOpenState(getGlobalSettings());

        // Initialize UI Manager after settings are loaded to ensure correct theme, widths, etc.
        if (window.uiManager) {
            ownedRendererSubscriptions.add({ dispose: () => window.uiManager.dispose?.() });
            await window.uiManager.init({
                electronAPI: chatAPI,
                refs: {
            globalSettingsRef: mainChatSettingsOwner.ref,
                },
                listenerOwner: mainChatDomListenerOwner,
                settingsManager: window.settingsManager,
                itemListManager: window.itemListManager,
                uiHelper: uiHelperFunctions,
                elements: {
                    leftSidebar: document.querySelector('.sidebar'),
                    rightNotificationsSidebar: document.getElementById('notificationsSidebar'),
                    resizerLeft: document.getElementById('resizerLeft'),
                    resizerRight: document.getElementById('resizerRight'),
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
                    globalSettingsRef: mainChatSettingsOwner.ref,
                }
            });
        } else {
            console.error('[RENDERER_INIT] filterManager module not found!');
        }

        setupEventListeners({
            chatMessagesDiv, sendMessageBtn, messageInput, attachFileBtn, globalSettingsBtn,
            globalSettingsForm, userAvatarInput,
            currentItemActionBtn, toggleNotificationsBtn,
            notificationsSidebar, agentSearchInput, leftSidebar,
            openTranslatorBtn: document.getElementById('openTranslatorBtn'),
            openNotesBtn: document.getElementById('openNotesBtn'),
            openMusicBtn: document.getElementById('openMusicBtn'),
            openCanvasBtn: document.getElementById('openCanvasBtn'),
            toggleAssistantBtn, toggleSidebarModeBtn,
            voiceChatBtn: document.getElementById('voiceChatBtn'),
            enableContextSanitizerCheckbox: document.getElementById('enableContextSanitizer'),
            contextSanitizerDepthContainer: document.getElementById('contextSanitizerDepthContainer'),
            addNetworkPathBtn: document.getElementById('addNetworkPathBtn'),
            refs: {
                currentSelectedItem: currentSelectedItemRef,
                currentTopicId: currentTopicIdRef,
                globalSettings: mainChatSettingsOwner.ref,
                attachedFiles: mainChatAttachmentOwner.ref,
                currentChatHistory: mainHistoryRef,
            },
            uiHelperFunctions,
            chatManager,
            messageRenderer,
            historyMutationAuthority,
            itemListManager: window.itemListManager,
            settingsManager: window.settingsManager,
            uiManager: window.uiManager,
            topicListManager: window.topicListManager,
            getCroppedFile: uiHelperFunctions.getCroppedFile,
            setCroppedFile: uiHelperFunctions.setCroppedFile,
            updateAttachmentPreview: mainChatAttachmentOwner.syncPreview,
            filterAgentList: uiHelperFunctions.filterAgentList,
            addNetworkPathInput: uiHelperFunctions.addNetworkPathInput,
            sendButtonAction: mainChatSendOwner.handleAction,
            normalizeChatPresentationMode,
            applyChatPresentationMode,
            applyChatBubbleLayoutSettings,
            getAppearance: () => window.VCPAppearance,
            listenerOwner: mainChatDomListenerOwner
        });

        // A visible DOM shell is not enough to call the desktop interactive:
        // template-backed modals and settings actions depend on the listeners
        // registered above.  Expose one explicit readiness point for startup
        // diagnostics and isolated Electron smoke tests.
        document.documentElement.dataset.vcpRendererReady = 'true';
        window.dispatchEvent(new CustomEvent('vcp-renderer-ready'));

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

            mainChatDomListenerOwner.add(emoticonTriggerBtn, 'click', openEmoticonPanel);
            mainChatDomListenerOwner.add(emoticonTriggerBtn, 'contextmenu', openEmoticonPanel);

            const emoticonTriggerObserver = mainChatDomListenerOwner.own(new MutationObserver(syncEmoticonTriggerButton));
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

            mainChatDomListenerOwner.add(quickNewTopicBtn, 'click', () => forwardCurrentItemAction('click'));
            mainChatDomListenerOwner.add(quickNewTopicBtn, 'contextmenu', (event) => {
                event.preventDefault();
                forwardCurrentItemAction('contextmenu');
            });

            const quickTopicObserver = mainChatDomListenerOwner.own(new MutationObserver(syncQuickNewTopicButton));
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
        if (!currentSelectedItemRef.get()?.id) {
            chatManager.displayNoItemSelected();
        }
 
        // Initialize Search Manager
        if (searchManager) {
            searchManager.init({
                electronAPI: chatAPI,
                chatRepository,
                uiHelper: uiHelperFunctions,
                refs: {
                    currentSelectedItemRef,
                    currentTopicIdRef,
                },
                modules: {
                    chatManager,
                }
            });
        } else {
            console.error('[RENDERER_INIT] searchManager module not found!');
        }

       // Emoticon URL fixer is now initialized within messageRenderer
        topicSelectionReadiness.setReady(true);

        chatAPI.toggleSelectionListener(!!getGlobalSettings().assistantEnabled);

        const pendingTopicSelection = topicSelectionReadiness.takePending();
        if (pendingTopicSelection && chatManager) {
            const pending = pendingTopicSelection;
            const selectedItem = currentSelectedItemRef.get();
            const matchesCurrentItem =
                selectedItem &&
                selectedItem.id === pending.itemId &&
                selectedItem.type === pending.itemType;

            if (matchesCurrentItem) {
                Promise.resolve(chatManager.selectTopic(pending.topicId)).catch((error) => {
                    console.error('[Renderer] Failed to replay pending topic selection:', error);
                });
            }
        }
    } catch (error) {
        topicSelectionReadiness.setReady(false);
        console.error('Error during DOMContentLoaded initialization:', error);
        startupThemeGate.release({
            mode: 'system',
            message: `初始化失败，已使用系统主题：${error?.message || '未知错误'}`,
        });
        if (chatMessagesDiv) {
            chatMessagesDiv.innerHTML = `<div class="message-item system">初始化失败: ${error?.message || '未知错误'}</div>`;
        }
    }

    // --- Agent Settings Reload Listener ---
    if (chatAPI?.onReloadAgentSettings) {
        ownedRendererSubscriptions.add(createOwnedPreloadSubscription({
            subscribe: chatAPI.onReloadAgentSettings,
            consume: async ({ agentId }, lifecycle) => {
            console.log('[Renderer] Received reload-agent-settings event for agent:', agentId);
            if (window.settingsManager && typeof window.settingsManager.reloadAgentSettings === 'function') {
                const result = await window.settingsManager.reloadAgentSettings(agentId);
                if (!lifecycle.isActive()) return;
                if (result.success && !result.skipped) {
                    console.log('[Renderer] Agent settings reloaded successfully');
                    uiHelperFunctions.showToastNotification('设置已自动更新', 'success');
                } else if (result.skipped) {
                    console.log('[Renderer] Agent settings reload skipped (not currently editing)');
                }
            }
            },
        }));
        console.log('[Renderer] Agent settings reload listener initialized');
    }
    
    // --- TTS Audio Playback and Visuals ---
    ttsSurfaceOwner.mount();
    ownedRendererSubscriptions.add({ dispose: () => ttsSurfaceOwner.dispose() });
    // --- File Watcher Listener ---
    ownedRendererSubscriptions.add(createOwnedPreloadSubscription({
        subscribe: chatAPI.onHistoryFileUpdated,
        consume: async ({ agentId, topicId, path }, lifecycle) => {
        const selectedItem = currentSelectedItemRef.get();
        if (selectedItem?.id === agentId && currentTopicIdRef.get() === topicId) {
            console.log('[Renderer] Active chat history was modified externally. Syncing...');
            if (!lifecycle.isActive()) return;
            uiHelperFunctions.showToastNotification("聊天记录已同步。", "info");
            if (chatManager && typeof chatManager.syncHistoryFromFile === 'function') {
                await chatManager.syncHistoryFromFile(agentId, selectedItem.type, topicId);
            }
        }
        },
    }));

    // --- Initialize Flowlock Module ---
    if (window.initializeFlowlockIntegration) {
        window.initializeFlowlockIntegration({
            chatManager,
            historyMutationAuthority,
            settings: mainChatSettingsOwner,
            listenerOwner: mainChatDomListenerOwner,
        });
        console.log('[Renderer] Flowlock integration initialized.');
    } else {
        console.warn('[Renderer] Flowlock integration function not found.');
    }

    // Flowlock command/request ownership is provided by MainChatFlowlockOwner.


    const flowlockOwner = createMainChatFlowlockOwner({
        subscriptions: { command: chatAPI?.onFlowlockCommand, request: chatAPI?.onFlowlockRequest },
        flowlockManager: window.flowlockManager,
        getSelectedItem: currentSelectedItemRef.get,
        messageInput,
        uiHelperFunctions: window.uiHelperFunctions,
        sendResponse: (commandData, responseData) => {
            if (!commandData?.requestId || !chatAPI?.sendFlowlockRpcResponse) return;
            chatAPI.sendFlowlockRpcResponse({ requestId: commandData.requestId, ok: responseData?.success !== false, data: responseData?.success === false ? undefined : responseData, error: responseData?.success === false ? responseData.error : undefined });
        },
    });
    flowlockOwner.mount();
    ownedRendererSubscriptions.add(flowlockOwner);

});

function loadAndApplyGlobalSettings() { return mainChatSettingsPresentationOwner.loadAndApply(); }


function applyInitialThemeClass(mode) { mainChatThemeOwner.applyInitialTheme(mode); }


function normalizeChatPresentationMode(mode) { return mainChatSettingsPresentationOwner.normalizePresentation(mode); }
function applyChatPresentationMode(mode, options = {}) { return mainChatSettingsPresentationOwner.applyPresentation(mode, options); }
function setupChatPresentationQuickSwitcher() { return mainChatSettingsPresentationOwner.setupPresentationQuickSwitcher(); }
function applyChatBubbleLayoutSettings(settings = getGlobalSettings()) { return mainChatSettingsPresentationOwner.applyLayoutSettings(settings); }
function syncGlobalSettingsToUI() { return mainChatSettingsPresentationOwner.syncSettingsToUI(); }

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
            smartypants: false      // 不使用智能标点符号
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

// Helper to get a centrally stored cropped file (agent, group, or user)
// These functions are now part of modules/ui-helpers.js and are accessed via uiHelperFunctions

// Forward modal ownership is provided by ForwardMessageOwner.
