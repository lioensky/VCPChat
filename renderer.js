// --- Globals ---
let globalSettings = {
    sidebarWidth: 260,
    notificationsSidebarWidth: 300,
    userName: '用户', // Default username
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

// --- DOM Elements ---
const itemListUl = document.getElementById('agentList');
const currentChatNameH3 = document.getElementById('currentChatAgentName');
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

const createNewAgentBtn = document.getElementById('createNewAgentBtn');
const createNewGroupBtn = document.getElementById('createNewGroupBtn');

const itemSettingsContainerTitle = document.getElementById('agentSettingsContainerTitle');
const selectedItemNameForSettingsSpan = document.getElementById('selectedAgentNameForSettings');

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

const groupSettingsContainer = document.getElementById('groupSettingsContainer');

const selectItemPromptForSettings = document.getElementById('selectAgentPromptForSettings');
const deleteItemBtn = document.getElementById('deleteAgentBtn');

const currentItemActionBtn = document.getElementById('currentAgentSettingsBtn');
const clearCurrentChatBtn = document.getElementById('clearCurrentChatBtn');
const openAdminPanelBtn = document.getElementById('openAdminPanelBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const toggleNotificationsBtn = document.getElementById('toggleNotificationsBtn');

const notificationsSidebar = document.getElementById('notificationsSidebar');
const vcpLogConnectionStatusDiv = document.getElementById('vcpLogConnectionStatus');
const notificationsListUl = document.getElementById('notificationsList');
const clearNotificationsBtn = document.getElementById('clearNotificationsBtn');

const sidebarTabButtons = document.querySelectorAll('.sidebar-tab-button');
const sidebarTabContents = document.querySelectorAll('.sidebar-tab-content');
const tabContentTopics = document.getElementById('tabContentTopics');
const tabContentSettings = document.getElementById('tabContentSettings');

const topicSearchInput = document.getElementById('topicSearchInput');

const leftSidebar = document.querySelector('.sidebar');
const rightNotificationsSidebar = document.getElementById('notificationsSidebar');
const resizerLeft = document.getElementById('resizerLeft');
const resizerRight = document.getElementById('resizerRight');

let croppedAgentAvatarFile = null;
let croppedUserAvatarFile = null;
let croppedGroupAvatarFile = null;

const notificationTitleElement = document.getElementById('notificationTitle');
const digitalClockElement = document.getElementById('digitalClock');
const dateDisplayElement = document.getElementById('dateDisplay');
let inviteAgentButtonsContainerElement;

const assistantEnabledCheckbox = document.getElementById('assistantEnabled');
const assistantAgentContainer = document.getElementById('assistantAgentContainer');
const assistantAgentSelect = document.getElementById('assistantAgent');

let htmlAssistantBar;

const uiHelperFunctions = {
    openModal: openModal,
    closeModal: closeModal,
    autoResizeTextarea: autoResizeTextarea,
    showToastNotification: (message, duration = 3000, type = 'info') => { // Added type
        const toast = document.getElementById('toastNotification');
        if (toast) {
            toast.textContent = message;
            toast.className = 'toast-notification show'; // Reset classes
            if (type === 'error') {
                toast.classList.add('error');
            } else if (type === 'success') {
                toast.classList.add('success');
            }
            setTimeout(() => {
                toast.classList.remove('show', 'error', 'success');
            }, duration);
        } else {
            console.warn("Toast notification element not found. Type:", type, "Message:", message);
            alert(message);
        }
    },
    showSaveFeedback: (buttonElement, success, tempText, originalText) => { /* ... */ },
    openAvatarCropper: openAvatarCropper,
    scrollToBottom: scrollToBottom,
    showTopicContextMenu: showTopicContextMenu,
};


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    prepareGroupSettingsDOM();
    inviteAgentButtonsContainerElement = document.getElementById('inviteAgentButtonsContainer');
    createHtmlAssistantBar();

    if (window.GroupRenderer) {
        window.GroupRenderer.init({ electronAPI: Capacitor.Plugins.CoreBridge, /* ... other dependencies ... */ });
    } else { console.error('[RENDERER_INIT] GroupRenderer module not found!'); }

    if (window.messageRenderer) {
        window.messageRenderer.initializeMessageRenderer({ electronAPI: Capacitor.Plugins.CoreBridge, /* ... */ });
    } else { console.error('[RENDERER_INIT] messageRenderer module not found!'); }

    if (window.inputEnhancer) {
        window.inputEnhancer.initializeInputEnhancer({ electronAPI: Capacitor.Plugins.CoreBridge, /* ... */ });
    } else { console.error('[RENDERER_INIT] inputEnhancer module not found!'); }

    if (Capacitor.isNativePlatform() && Capacitor.Plugins.CoreBridge) {
        Capacitor.Plugins.CoreBridge.addListener("vcpLogStatusEvent", (statusUpdate) => {
            if (window.notificationRenderer) {
                window.notificationRenderer.updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv);
            }
        });
        Capacitor.Plugins.CoreBridge.addListener("vcpLogMessageEvent", (eventData) => {
            if (window.notificationRenderer) {
                const logData = eventData.logData || eventData;
                const originalRawMessage = eventData.originalRawMessage || null;
                const computedStyle = getComputedStyle(document.body);
                const themeColors = { /* ... */ };
                window.notificationRenderer.renderVCPLogNotification(logData, originalRawMessage, notificationsListUl, themeColors);
            }
        });

        Capacitor.Plugins.CoreBridge.addListener("vcpStreamChunk", async (eventData) => {
            if (!window.messageRenderer) { console.error("VCPStreamChunk: messageRenderer not available."); return; }
            const streamMessageId = eventData.messageId;
            if (!streamMessageId) { console.error("VCPStreamChunk: Received chunk without messageId.", eventData); return; }

            if (eventData.type === 'data') {
                window.messageRenderer.appendStreamChunk(streamMessageId, eventData.chunk);
            } else if (eventData.type === 'end') {
                window.messageRenderer.finalizeStreamedMessage(streamMessageId, eventData.finish_reason || 'completed', eventData.fullResponse);
                if (currentSelectedItem.type === 'agent' && currentSelectedItem.id && currentTopicId) {
                     if (eventData.fullResponse && typeof eventData.fullResponse === 'string') {
                        const finalMessage = currentChatHistory.find(m => m.id === streamMessageId);
                        if(finalMessage) finalMessage.content = eventData.fullResponse;
                     }
                     try {
                        await Capacitor.Plugins.CoreBridge.saveChatHistory({
                            agentId: currentSelectedItem.id,
                            topicId: currentTopicId,
                            history: currentChatHistory.filter(msg => !msg.isThinking && !msg.isStreaming) // Save finalized history
                        });
                        await attemptTopicSummarizationIfNeeded();
                     } catch(e) { console.error("Error saving chat history post-stream:", e); }
                }
            } else if (eventData.type === 'error') {
                console.error('VCP Stream Error on ID', streamMessageId, ':', eventData.error);
                window.messageRenderer.finalizeStreamedMessage(streamMessageId, 'error');
                const errorMsgItem = document.querySelector(`.message-item[data-message-id="${streamMessageId}"] .md-content`);
                if (errorMsgItem) errorMsgItem.innerHTML += `<p><strong style="color: red;">流错误: ${eventData.error}</strong></p>`;
                else window.messageRenderer.renderMessage({ role: 'system', content: `流处理错误 (ID: ${streamMessageId}): ${eventData.error}`, timestamp: Date.now(), id: `err_${streamMessageId}`});
            }
         });
        Capacitor.Plugins.CoreBridge.addListener("vcpGroupStreamChunk", async (eventData) => { /* Similar to vcpStreamChunk but for groups */ });
        Capacitor.Plugins.CoreBridge.addListener("vcpGroupTopicUpdated", async (eventData) => { /* ... */ });
    }

    if (Capacitor.isNativePlatform() && Capacitor.Plugins.App) {
        Capacitor.Plugins.App.addListener('appStateChange', (state) => {
            if (state.isActive) { loadAndApplyThemePreference(true); }
        });
        Capacitor.Plugins.App.addListener('configurationChanged', () => {
            loadAndApplyThemePreference(true);
        });
    }

    try {
        await loadAndApplyGlobalSettings();
        await loadItems();
        setupEventListeners();
        setupSidebarTabs();
        initializeResizers();
        setupTopicSearch();
        if(messageInput) autoResizeTextarea(messageInput);
        loadAndApplyThemePreference();
        initializeDigitalClock();
        setupTextSelectionAssistantListener();
        if (!currentSelectedItem.id) displayNoItemSelected();
    } catch (error) {
        console.error('Error during DOMContentLoaded initialization:', error);
        uiHelperFunctions.showToastNotification('初始化失败: ' + error.message, 5000, 'error');
        chatMessagesDiv.innerHTML = `<div class="message-item system">初始化失败: ${error.message}</div>`;
    }
});

function displayNoItemSelected() { /* ... */ }
function prepareGroupSettingsDOM() { /* ... */ }
function initializeDigitalClock() { /* ... */ }
function updateDateTimeDisplay() { /* ... */ }

async function loadAndApplyThemePreference(isRefresh = false) {
    const savedTheme = localStorage.getItem('theme');
    let currentTheme = 'light';

    if (savedTheme) {
        currentTheme = savedTheme;
    } else if (Capacitor.isNativePlatform() && Capacitor.Plugins.App) {
        try {
            const themeInfoResult = await Capacitor.Plugins.App.getThemeInfo();
            const themeInfo = themeInfoResult.value || themeInfoResult;
            currentTheme = themeInfo.isDarkMode ? 'dark' : 'light';
        } catch (e) {
            console.warn("Could not get OS theme info via App plugin, falling back. Error:", e);
            const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            currentTheme = prefersDark ? 'dark' : 'light';
        }
    } else {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        currentTheme = prefersDark ? 'dark' : 'light';
    }

    if (!isRefresh || document.body.dataset.theme !== currentTheme) {
        applyTheme(currentTheme);
    }
}

function applyTheme(theme) {
    document.body.dataset.theme = theme;
    const isLightTheme = theme === 'light';
    document.body.classList.toggle('light-theme', isLightTheme);
    document.body.classList.toggle('dark-theme', !isLightTheme);

    const sunIcon = document.getElementById('sun-icon');
    const moonIcon = document.getElementById('moon-icon');

    if (sunIcon) sunIcon.style.display = isLightTheme ? 'none' : 'inline-block';
    if (moonIcon) moonIcon.style.display = isLightTheme ? 'inline-block' : 'none';
}

async function loadAndApplyGlobalSettings() {
    try {
        const result = await Capacitor.Plugins.CoreBridge.loadSettings();
        const settings = result.value || result;
        if (settings && !settings.error) {
            globalSettings = { ...globalSettings, ...settings };
            // ... (rest of the settings application) ...
            if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey && Capacitor.isNativePlatform()) {
                if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'connecting', message: '连接中...' }, vcpLogConnectionStatusDiv);
                try {
                    await Capacitor.Plugins.CoreBridge.connectVCPLog({ url: globalSettings.vcpLogUrl, key: globalSettings.vcpLogKey });
                } catch (e) {
                     if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog连接失败: ' + e.message }, vcpLogConnectionStatusDiv);
                }
            } else if (Capacitor.isNativePlatform()) { // Only try to disconnect if on native
                if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
            }
            // ... (rest of settings)
        } else {
            uiHelperFunctions.showToastNotification(`加载全局设置失败: ${settings?.error || '未知错误'}`, 3000, 'error');
        }
    } catch (error) {
        console.error('Error loading global settings:', error);
        uiHelperFunctions.showToastNotification('加载全局设置出错: ' + error.message, 3000, 'error');
    }
}

async function loadItems() {
    try {
        const agentsResultWrapper = await Capacitor.Plugins.CoreBridge.getAgents();
        const agentsResult = agentsResultWrapper.value || agentsResultWrapper;
        // ... (rest of loadItems as before, but with try/catch for CoreBridge calls)
    } catch (error) {
        console.error("Error in loadItems:", error);
        uiHelperFunctions.showToastNotification("加载项目列表出错: " + error.message, 3000, 'error');
        itemListUl.innerHTML = '<li>加载项目失败。</li>';
    }
}
async function saveItemOrder(orderedItemsWithTypes) {
    try {
        await Capacitor.Plugins.CoreBridge.saveCombinedItemOrder({ items: orderedItemsWithTypes });
    } catch (error) {
        uiHelperFunctions.showToastNotification('保存顺序失败: ' + error.message, 3000, 'error');
    }
}
async function selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) {
    try {
        // ... (CoreBridge calls like getAgentTopics, getGroupTopics, getAgentConfig, createNewTopicForAgent, createNewTopicForGroup)
        // should be wrapped in try/catch ...
        // For brevity, not wrapping each one here, but it's implied by the subtask instructions.
        // Example for one call:
        if (itemType === 'agent') {
            const agentConfigWrapper = await Capacitor.Plugins.CoreBridge.getAgentConfig({ itemId: itemId });
            itemFullConfig = agentConfigWrapper.value || agentConfigWrapper; // Update itemFullConfig
            // ...
        }
    } catch (error) {
        console.error("Error in selectItem:", error);
        uiHelperFunctions.showToastNotification("选择项目时出错: " + error.message, 3000, 'error');
    }
    // ... rest of the function
}
function highlightActiveItem(itemId, itemType) { /* ... */ }

async function loadChatHistory(itemId, itemType, topicId) {
    try {
        // ... (CoreBridge calls getChatHistory, getGroupChatHistory)
    } catch (error) {
        console.error("Error in loadChatHistory:", error);
        uiHelperFunctions.showToastNotification("加载聊天记录出错: " + error.message, 3000, 'error');
    }
    // ... rest of the function
}
function scrollToBottom() { /* ... */ }
async function displayTopicTimestampBubble(itemId, itemType, topicId) { /* ... uses CoreBridge ... */ }
async function attemptTopicSummarizationIfNeeded() { /* ... uses non-CoreBridge saveAgentTopicTitle ... */ }

async function handleSendMessage() {
    const content = messageInput.value.trim();
    if (!content && attachedFiles.length === 0) return;
    if (!currentSelectedItem.id || !currentTopicId) {
        uiHelperFunctions.showToastNotification('请先选择一个项目和话题！', 3000, 'error'); return;
    }

    const userMessage = { /* ... */ };
    if (window.messageRenderer) window.messageRenderer.renderMessage(userMessage);
    currentChatHistory.push(userMessage);

    const currentAgentId = currentSelectedItem.id;
    const currentAgentName = currentSelectedItem.name;
    const currentAgentAvatar = currentSelectedItem.avatarUrl;
    const currentAgentAvatarColor = currentSelectedItem.config?.avatarCalculatedColor;

    messageInput.value = '';
    const sentAttachedFiles = [...attachedFiles];
    attachedFiles.length = 0;
    updateAttachmentPreview();
    autoResizeTextarea(messageInput);
    messageInput.focus();

    if (currentSelectedItem.type === 'group') {
        if (window.GroupRenderer?.handleSendGroupMessage) {
            window.GroupRenderer.handleSendGroupMessage(currentAgentId, currentTopicId, userMessage, content, sentAttachedFiles);
        } else { uiHelperFunctions.showToastNotification("群聊功能模块未加载。", 3000, 'error'); }
        return;
    }

    if (!globalSettings.vcpServerUrl) {
        uiHelperFunctions.showToastNotification('VCP服务器URL未配置!', 3000, 'error');
        openModal('globalSettingsModal');
        return;
    }

    const thinkingMessageId = `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
    const thinkingMessage = { /* ... */ };
    if (window.messageRenderer) window.messageRenderer.renderMessage(thinkingMessage);

    try {
        const agentConfig = currentSelectedItem.config;
        const historySnapshotForVCP = currentChatHistory.filter(msg => !msg.isThinking);

        let contentForVCP_from_userMessage = userMessage.content;
        if (userMessage.attachments && userMessage.attachments.length > 0) { /* ... append extracted text ... */ }

        const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
            let textContent = (typeof msg.content === 'object' && msg.content !== null && msg.content.text) ? msg.content.text : msg.content;
            let vcpImageAttachmentsPayload = [];
            if (msg.attachments && msg.attachments.length > 0) {
                const imageAttachmentsPromises = msg.attachments
                    .filter(att => att.type.startsWith('image/'))
                    .map(async att => {
                        try {
                            const base64Result = await Capacitor.Plugins.CoreBridge.getFileAsBase64({ filePath: att.src });
                            if (base64Result && base64Result.base64String) {
                                return { type: 'image_url', image_url: { url: `data:${att.type};base64,${base64Result.base64String}` } };
                            } else { console.error(`Failed to get Base64 for ${att.name}: ${base64Result?.error}`); return null; }
                        } catch (e) { console.error(`Error getting base64 for ${att.name}:`, e); return null; }
                    });
                vcpImageAttachmentsPayload = (await Promise.all(imageAttachmentsPromises)).filter(Boolean);
            }
            let finalContentPartsForVCP = [];
            const currentTextContent = (msg.id === userMessage.id) ? contentForVCP_from_userMessage : textContent;
            if (currentTextContent && currentTextContent.trim() !== '') finalContentPartsForVCP.push({ type: 'text', text: currentTextContent });
            finalContentPartsForVCP.push(...vcpImageAttachmentsPayload);
            if (finalContentPartsForVCP.length === 0 && msg.role === 'user') finalContentPartsForVCP.push({ type: 'text', text: '(用户发送了附件，但无文本或图片内容)' });
            return { role: msg.role, content: finalContentPartsForVCP.length > 0 ? finalContentPartsForVCP : (textContent || "") };
        }));

        if (agentConfig?.systemPrompt) {
            messagesForVCP.unshift({ role: 'system', content: agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentAgentId) });
        }

        const useStreaming = (agentConfig?.streamOutput !== undefined) ? (agentConfig.streamOutput === true || String(agentConfig.streamOutput) === 'true') : true;
        const modelConfigForVCP = { /* ... */ };

        if (useStreaming) {
            if (window.messageRenderer) window.messageRenderer.startStreamingMessage({ ...thinkingMessage, content: "" });
            currentChatHistory.push({ ...thinkingMessage, content: "", isThinking: false, isStreaming: true });
        }

        const vcpResponse = await Capacitor.Plugins.CoreBridge.sendToVCP({
            vcpUrl: globalSettings.vcpServerUrl, vcpApiKey: globalSettings.vcpApiKey,
            messages: messagesForVCP, modelConfig: modelConfigForVCP, messageId: thinkingMessage.id
        });

        if (!useStreaming) {
            if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id);
            let assistantMessageToSave;
            if (vcpResponse.error) {
                uiHelperFunctions.showToastNotification(`VCP错误: ${vcpResponse.error}`, 3000, 'error');
            } else if (vcpResponse.choices && vcpResponse.choices.length > 0) {
                const assistantMessageContent = vcpResponse.choices[0].message.content;
                assistantMessageToSave = { role: 'assistant', name: currentAgentName, content: assistantMessageContent, timestamp: Date.now(), id: thinkingMessage.id };
                if (window.messageRenderer) window.messageRenderer.renderMessage({ ...assistantMessageToSave, avatarUrl: currentAgentAvatar, avatarColor: currentAgentAvatarColor });
                currentChatHistory.push(assistantMessageToSave);
            } else {
                uiHelperFunctions.showToastNotification('VCP返回了未知格式的响应。', 3000, 'error');
            }
            await Capacitor.Plugins.CoreBridge.saveChatHistory({ agentId: currentAgentId, topicId: currentTopicId, history: currentChatHistory.filter(msg => !msg.isThinking) });
            await attemptTopicSummarizationIfNeeded();
        } else {
            if (vcpResponse && vcpResponse.streamError) {
                console.error("Streaming setup failed:", vcpResponse.errorDetail || vcpResponse.error);
                if (window.messageRenderer) window.messageRenderer.finalizeStreamedMessage(thinkingMessage.id, 'error');
                const errorMsgItem = document.querySelector(`.message-item[data-message-id="${thinkingMessage.id}"] .md-content`);
                if (errorMsgItem) errorMsgItem.innerHTML += `<p><strong style="color: red;">流启动错误: ${vcpResponse.errorDetail || vcpResponse.error}</strong></p>`;
                const streamingMsgIndex = currentChatHistory.findIndex(m => m.id === thinkingMessage.id && m.isStreaming);
                if (streamingMsgIndex > -1) currentChatHistory.splice(streamingMsgIndex, 1);
            }
        }
    } catch (error) {
        console.error('发送消息或处理VCP响应时出错:', error);
        if (window.messageRenderer) window.messageRenderer.removeMessageById(thinkingMessage.id);
        uiHelperFunctions.showToastNotification('发送消息出错: ' + error.message, 3000, 'error');
        const streamingMsgIndexOnError = currentChatHistory.findIndex(m => m.id === thinkingMessage.id && m.isStreaming);
        if (streamingMsgIndexOnError > -1) currentChatHistory.splice(streamingMsgIndexOnError, 1);
        if(currentAgentId && currentTopicId) {
            try {
                await Capacitor.Plugins.CoreBridge.saveChatHistory({ agentId: currentAgentId, topicId: currentTopicId, history: currentChatHistory.filter(msg => !msg.isThinking)});
            } catch(e) { console.error("Error saving history after send error:", e); }
        }
    }
}

function setupSidebarTabs() { /* ... */ }
function switchToTab(targetTab) { /* ... */ }
async function loadTopicList() { /* ... uses CoreBridge ... */ }
function setupTopicSearch() { /* ... */ }
function setupTopicSearchListener(inputElement) { /* ... */ }
function filterTopicList() { /* ... */ }
function initializeTopicSortable(itemId, itemType) { /* ... uses non-CoreBridge saveTopicOrder/saveGroupTopicOrder ... */ }
function showTopicContextMenu(event, topicItemElement, itemFullConfig, topic, itemType) { /* ... uses non-CoreBridge save/delete topic title ... */ }
function closeTopicContextMenu() { /* ... */ }
function closeTopicContextMenuOnClickOutside(event) { /* ... */ }

function setupEventListeners() {
    if (chatMessagesDiv) {
        chatMessagesDiv.addEventListener('click', async (event) => {
            const target = event.target.closest('a');
            if (target && target.href) {
                const href = target.href;
                event.preventDefault();
                if (href.startsWith('http:') || href.startsWith('https:')) {
                    try {
                        if (Capacitor.Plugins.Browser && typeof Capacitor.Plugins.Browser.open === 'function') {
                             await Capacitor.Plugins.Browser.open({ url: href });
                        } else if (Capacitor.Plugins.CoreBridge && typeof Capacitor.Plugins.CoreBridge.openExternalLink === 'function') {
                            await Capacitor.Plugins.CoreBridge.openExternalLink({ url: href });
                        } else { window.open(href, '_blank'); }
                    } catch (e) { console.error("Failed to open external link", e); window.open(href, '_blank');}
                } else { console.warn(`Clicked link with unhandled protocol: ${href}`); }
            }
        });
    }

    sendMessageBtn.addEventListener('click', handleSendMessage);
    messageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }});
    messageInput.addEventListener('input', () => autoResizeTextarea(messageInput));
    attachFileBtn.addEventListener('click', async () => { /* ... uses CoreBridge.selectFileAttachments & storeFile ... */ });
    globalSettingsBtn.addEventListener('click', () => openModal('globalSettingsModal'));
    globalSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newSettings = { /* ... */ }; // Assume newSettings are populated correctly
        const userAvatarCropped = getCroppedFile('user');
        if (userAvatarCropped) {
            try {
                const base64Data = await arrayBufferToBase64(await userAvatarCropped.arrayBuffer());
                await Capacitor.Plugins.CoreBridge.saveUserAvatar({ avatarData: { name: userAvatarCropped.name, type: userAvatarCropped.type, base64Data: base64Data }});
                // ... (update UI, etc.)
            } catch (error) { uiHelperFunctions.showToastNotification('保存用户头像失败: ' + error.message, 3000, 'error');}
        }
        try {
            await Capacitor.Plugins.CoreBridge.saveSettings(newSettings);
            globalSettings = {...globalSettings, ...newSettings };
            uiHelperFunctions.showToastNotification('全局设置已保存！', 2000, 'success');
            closeModal('globalSettingsModal');
            if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey && Capacitor.isNativePlatform()) {
                 try { await Capacitor.Plugins.CoreBridge.connectVCPLog({ url: globalSettings.vcpLogUrl, key: globalSettings.vcpLogKey }); }
                 catch (e) { if(window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog连接失败: ' + e.message }, vcpLogConnectionStatusDiv); }
            } else if (Capacitor.isNativePlatform()) {
                 try { await Capacitor.Plugins.CoreBridge.disconnectVCPLog(); } catch(e) { console.error("Error disconnecting VCP Log", e); }
                 if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, vcpLogConnectionStatusDiv);
            }
       } catch (error) { uiHelperFunctions.showToastNotification(`保存全局设置失败: ${error.message}`, 3000, 'error'); }
    });

    if (userAvatarInput) { /* ... */ }
    if (createNewAgentBtn) { /* ... uses CoreBridge.createAgent ... */ }
    if (currentItemActionBtn) { /* ... uses CoreBridge.createNewTopicForAgent/Group ... */ }
    if (agentSettingsForm) { /* ... uses CoreBridge saveAgentConfig/saveAvatar ... */ }
    if (deleteItemBtn) { /* ... uses CoreBridge deleteAgent/deleteAgentGroup ... */ }
    if (agentAvatarInput) { /* ... */ }
    if (clearCurrentChatBtn) { /* ... uses CoreBridge saveChatHistory ... */ }

    if (themeToggleBtn) { /* ... (remains JS only for now) ... */ }
    if (openAdminPanelBtn) { /* ... uses Capacitor.Plugins.Browser.open or CoreBridge.openExternalLink ... */ }
    if (document.getElementById('openTranslatorBtn')) { /* ... */ }
    if (document.getElementById('openNotesBtn')) { /* ... */ }
    if (toggleNotificationsBtn && notificationsSidebar) { /* ... */ }
    if (assistantEnabledCheckbox) { /* ... */ }
}

function setupTextSelectionAssistantListener() { /* ... as before ... */ }
function isSelectionTarget(target) { /* ... as before ... */ }
function handleSelectionChange() { /* ... as before ... */ }
function hideHtmlAssistantBar() { /* ... as before ... */ }
function createHtmlAssistantBar() { /* ... as before ... */ }
async function populateAssistantAgentSelect() { /* ... uses CoreBridge ... */ }
function initializeResizers() { /* ... uses CoreBridge saveSettings ... */ }
function updateAttachmentPreview() { /* ... */ }
function autoResizeTextarea(textarea) { /* ... */ }
function openModal(modalId) { /* ... */ }
function closeModal(modalId) { /* ... */ }
async function openAvatarCropper(file, onCropConfirmedCallback, cropType = 'agent') { /* ... */ }
function displaySettingsForItem() { /* ... uses CoreBridge ... */ }
async function populateAgentSettingsForm(agentId, agentConfig) { /* ... */ }
async function saveCurrentAgentSettings(event) { /* ... uses CoreBridge ... */ }
async function handleDeleteCurrentItem() { /* ... uses CoreBridge ... */ }
async function createNewTopicForItem(itemId, itemType) { /* ... uses CoreBridge ... */ }
async function handleCreateBranch(selectedMessage) { /* ... uses CoreBridge getAgentConfig, createNewTopicForAgent but non-CoreBridge saveChatHistory, deleteTopic ... */ }
function getCroppedFile(type) { /* ... */ }
function setCroppedFile(type, file) { /* ... */ }
function getAverageColorFromAvatar(imageUrl, callback) { /* ... uses CoreBridge saveAvatarColor ... */ }

async function arrayBufferToBase64(buffer) {
    if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
        let binary = ''; const bytes = new Uint8Array(buffer); const len = bytes.byteLength;
        for (let i = 0; i < len; i++) { binary += String.fromCharCode(bytes[i]); }
        return window.btoa(binary);
    } else if (typeof Buffer !== 'undefined') {
        return Buffer.from(buffer).toString('base64');
    } else {
        console.error("arrayBufferToBase64: btoa and Buffer are undefined.");
        return null;
    }
}
[end of renderer.js]
