const byId = (document, id) => document.getElementById(id);

/**
 * Resolves the fixed main-window DOM contract once at the composition edge.
 * Feature modules receive these nodes explicitly; they must not rediscover
 * the main document through ambient globals.
 */
export function createMainChatDomBindings(document) {
    if (!document?.getElementById || !document?.querySelector) {
        throw new TypeError('MainChatDomBindings requires an owning document');
    }

    const bindings = {
        itemListUl: byId(document, 'agentList'),
        currentChatNameH3: byId(document, 'currentChatAgentName'),
        chatMessagesDiv: byId(document, 'chatMessages'),
        messageInput: byId(document, 'messageInput'),
        sendMessageBtn: byId(document, 'sendMessageBtn'),
        attachFileBtn: byId(document, 'attachFileBtn'),
        emoticonTriggerBtn: byId(document, 'emoticonTriggerBtn'),
        quickNewTopicBtn: byId(document, 'quickNewTopicBtn'),
        attachmentPreviewArea: byId(document, 'attachmentPreviewArea'),
        chatInputCard: document.querySelector('.chat-input-card'),
        globalSettingsBtn: byId(document, 'globalSettingsBtn'),
        itemSettingsContainerTitle: byId(document, 'agentSettingsContainerTitle'),
        selectedItemNameForSettingsSpan: byId(document, 'selectedAgentNameForSettings'),
        agentSettingsContainer: byId(document, 'agentSettingsContainer'),
        agentSettingsForm: byId(document, 'agentSettingsForm'),
        editingAgentIdInput: byId(document, 'editingAgentId'),
        agentNameInput: byId(document, 'agentNameInput'),
        agentAvatarInput: byId(document, 'agentAvatarInput'),
        agentAvatarPreview: byId(document, 'agentAvatarPreview'),
        agentSystemPromptTextarea: byId(document, 'agentSystemPrompt'),
        agentModelInput: byId(document, 'agentModel'),
        agentTemperatureInput: byId(document, 'agentTemperature'),
        agentContextTokenLimitInput: byId(document, 'agentContextTokenLimit'),
        agentMaxOutputTokensInput: byId(document, 'agentMaxOutputTokens'),
        groupSettingsContainer: byId(document, 'groupSettingsContainer'),
        selectItemPromptForSettings: byId(document, 'selectAgentPromptForSettings'),
        deleteItemBtn: byId(document, 'deleteAgentBtn'),
        currentItemActionBtn: byId(document, 'currentAgentSettingsBtn'),
        clearCurrentChatBtn: byId(document, 'clearCurrentChatBtn'),
        toggleNotificationsBtn: byId(document, 'toggleNotificationsBtn'),
        notificationsSidebar: byId(document, 'notificationsSidebar'),
        vcpLogConnectionStatusDiv: byId(document, 'vcpLogConnectionStatus'),
        notificationsListUl: byId(document, 'notificationsList'),
        sidebarTabButtons: document.querySelectorAll('.sidebar-tab-button'),
        sidebarTabContents: document.querySelectorAll('.sidebar-tab-content'),
        tabContentTopics: byId(document, 'tabContentTopics'),
        tabContentSettings: byId(document, 'tabContentSettings'),
        topicSearchInput: byId(document, 'topicSearchInput'),
        leftSidebar: document.querySelector('.sidebar'),
        rightNotificationsSidebar: byId(document, 'notificationsSidebar'),
        resizerLeft: byId(document, 'resizerLeft'),
        resizerRight: byId(document, 'resizerRight'),
        agentSearchInput: byId(document, 'agentSearchInput'),
        notificationTitleElement: byId(document, 'notificationTitle'),
        digitalClockElement: byId(document, 'digitalClock'),
        dateDisplayElement: byId(document, 'dateDisplay'),
        toggleAssistantBtn: byId(document, 'toggleAssistantBtn'),
        toggleSidebarModeBtn: byId(document, 'toggleSidebarModeBtn'),
        openModelSelectBtn: byId(document, 'openModelSelectBtn'),
    };

    for (const required of ['itemListUl', 'chatMessagesDiv', 'messageInput', 'sendMessageBtn']) {
        if (!bindings[required]) throw new Error(`MainChatDomBindings missing required node: ${required}`);
    }
    return Object.freeze(bindings);
}
