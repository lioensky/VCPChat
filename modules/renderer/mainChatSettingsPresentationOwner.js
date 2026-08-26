/** Owns global-settings DOM projection, chat layout controls and presentation bindings. */
export function createMainChatSettingsPresentationOwner({
    documentRef,
    settingsOwner,
    listenerOwner,
    chatAPI,
    loadSettings,
    startupThemeGate,
    startupTimeoutMs = 15_000,
    elements = {},
    notificationRenderer = null,
    messageRenderer = null,
    windowRef = documentRef?.defaultView,
    getSettingsManager = () => null,
    getAppearance = () => null,
    getPretextBridge = () => null,
} = {}) {
    if (!documentRef || !settingsOwner || !listenerOwner) {
        throw new TypeError('MainChatSettingsPresentationOwner requires document, settings and listener owners.');
    }
    const document = documentRef;
    let globalSettings = settingsOwner.get();
    let themeOwner = null;
    let loadSettingsCapability = loadSettings;
    let startupThemeGateCapability = startupThemeGate;
    let disposed = false;
    let generation = 0;
    const tasks = new Set();
    const isCurrent = token => !disposed && token === generation;
    const track = value => {
        const task = Promise.resolve(value);
        tasks.add(task);
        task.finally(() => tasks.delete(task)).catch(() => {});
        return task;
    };

    async function loadAndApply() {
        const token = generation;
        if (!isCurrent(token)) return false;
        let settings;
        try {
            settings = await loadSettingsCapability(chatAPI?.loadSettings, startupTimeoutMs, '加载设置超时');
            if (!isCurrent(token)) return false;
        } catch (error) {
            startupThemeGateCapability.release({ mode: 'system', message: error?.message || '设置加载失败' });
            throw error;
        }
        if (!settings || settings.error) {
            console.warn('加载全局设置失败或无设置:', settings?.error);
            startupThemeGateCapability.release({ mode: 'system', message: settings?.error || '设置加载失败，已使用系统主题' });
            notificationRenderer?.updateVCPLogStatus?.(
                { status: 'error', message: 'VCPLog未配置' },
                elements.vcpLogConnectionStatus
            );
            return false;
        }

        settingsOwner.replace(settings);
        globalSettings = settingsOwner.get();
        startupThemeGateCapability.release({ mode: globalSettings.currentThemeMode });
        const appearanceProfile = getAppearance()?.commit(
            globalSettings.appearanceProfile,
            { uiMode: 'next', source: 'settings-load' }
        ) || globalSettings.appearanceProfile;
        const filterEnabled = globalSettings.filterEnabled
            ?? globalSettings.doNotDisturbLogMode
            ?? (windowRef?.localStorage?.getItem('doNotDisturbLogMode') === 'true');
        settingsOwner.replace({ appearanceProfile, filterEnabled });
        globalSettings = settingsOwner.get();
        windowRef?.dispatchEvent(new windowRef.CustomEvent('global-settings-updated', {
            detail: { settings: globalSettings, source: 'settings-load' }
        }));
        applyChatBubbleLayoutSettings(globalSettings);

        if (globalSettings.sidebarWidth && elements.leftSidebar) {
            elements.leftSidebar.style.width = `${globalSettings.sidebarWidth}px`;
        }
        if (elements.leftSidebar) {
            const sidebarIsActive = globalSettings.sidebarActive !== false;
            const avatarOnly = sidebarIsActive && globalSettings.sidebarAvatarOnly === true;
            elements.leftSidebar.classList.toggle('active', sidebarIsActive);
            elements.leftSidebar.classList.toggle('avatar-only', avatarOnly);
            document.querySelector('.main-content')?.classList.toggle('sidebar-active', sidebarIsActive);
        }
        if (globalSettings.notificationsSidebarWidth && elements.rightNotificationsSidebar?.classList.contains('active')) {
            elements.rightNotificationsSidebar.style.width = `${globalSettings.notificationsSidebarWidth}px`;
        }

        if (globalSettings.vcpLogUrl && globalSettings.vcpLogKey) {
            notificationRenderer?.updateVCPLogStatus?.(
                { status: 'connecting', message: '连接中...' },
                elements.vcpLogConnectionStatus
            );
            chatAPI.connectVCPLog(globalSettings.vcpLogUrl, globalSettings.vcpLogKey);
        } else {
            notificationRenderer?.updateVCPLogStatus?.(
                { status: 'error', message: 'VCPLog未配置' },
                elements.vcpLogConnectionStatus
            );
        }

        elements.toggleAssistant?.classList.toggle('active', Boolean(globalSettings.assistantEnabled));
        if (elements.toggleSidebarMode) {
            const avatarOnly = globalSettings.sidebarActive !== false && globalSettings.sidebarAvatarOnly === true;
            elements.toggleSidebarMode.classList.toggle('active', avatarOnly);
            elements.toggleSidebarMode.setAttribute('aria-pressed', String(avatarOnly));
        }
        listenerOwner.add(document, 'modal-ready', event => {
            if (event.detail?.modalId === 'globalSettingsModal' && !disposed) track(syncGlobalSettingsToUI());
        });
        messageRenderer?.setUserAvatar?.(globalSettings.userAvatarUrl);
        messageRenderer?.setUserAvatarColor?.(globalSettings.userAvatarCalculatedColor);
        return true;
    }

    const CHAT_PRESENTATION_MODES = Object.freeze(['bubble', 'panel', 'immersive']);
    const CHAT_PRESENTATION_MODE_CLASSES = CHAT_PRESENTATION_MODES.map(
        mode => `chat-presentation-${mode}`
    );

    function normalizeChatPresentationMode(mode) { return themeOwner.normalizePresentation(mode); }


    function isChatVisuallyNearBottom(scrollContainer, threshold = 64) {
        const messages = scrollContainer?.querySelector('.chat-messages');
        if (!scrollContainer || !messages) return true;

        const containerRect = scrollContainer.getBoundingClientRect();
        const messagesRect = messages.getBoundingClientRect();
        return Math.abs(messagesRect.bottom - containerRect.bottom) <= threshold;
    }

    function captureChatPresentationScrollAnchor() {
        const scrollContainer = document.querySelector('.chat-messages-container');
        if (!scrollContainer) return null;

        if (isChatVisuallyNearBottom(scrollContainer)) {
            return { scrollContainer, stickToBottom: true };
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const visibleMessages = Array.from(
            scrollContainer.querySelectorAll('.message-item[data-message-id]')
        )
            .map(element => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.bottom > containerRect.top && rect.top < containerRect.bottom)
            .sort((a, b) => a.rect.top - b.rect.top);

        const anchor = visibleMessages[0];
        if (!anchor) {
            return {
                scrollContainer,
                stickToBottom: false,
                scrollTop: scrollContainer.scrollTop
            };
        }

        return {
            scrollContainer,
            stickToBottom: false,
            messageId: anchor.element.dataset.messageId,
            viewportOffset: anchor.rect.top - containerRect.top,
            scrollTop: scrollContainer.scrollTop
        };
    }

    function restoreChatPresentationScrollAnchor(anchor) {
        if (!anchor?.scrollContainer?.isConnected) return;

        const { scrollContainer } = anchor;
        if (anchor.stickToBottom) {
            const messages = scrollContainer.querySelector('.chat-messages');
            if (!messages) return;
            const containerRect = scrollContainer.getBoundingClientRect();
            const messagesRect = messages.getBoundingClientRect();
            scrollContainer.scrollTop += messagesRect.bottom - containerRect.bottom;
            return;
        }

        const anchorElement = anchor.messageId
            ? scrollContainer.querySelector(`.message-item[data-message-id="${CSS.escape(anchor.messageId)}"]`)
            : null;

        if (!anchorElement) {
            scrollContainer.scrollTop = anchor.scrollTop;
            return;
        }

        const containerRect = scrollContainer.getBoundingClientRect();
        const currentOffset = anchorElement.getBoundingClientRect().top - containerRect.top;
        scrollContainer.scrollTop += currentOffset - anchor.viewportOffset;
    }

    function syncChatPresentationModeControls(mode = globalSettings.chatPresentationMode) {
        const normalizedMode = normalizeChatPresentationMode(mode);
        const modeControl = document.querySelector(
            `input[name="chatPresentationMode"][value="${normalizedMode}"]`
        );
        if (modeControl) modeControl.checked = true;

        document.querySelectorAll('.chat-presentation-quick-option').forEach((option) => {
            const isActive = option.dataset.presentationMode === normalizedMode;
            option.classList.toggle('active', isActive);
            option.setAttribute('aria-checked', String(isActive));
            option.tabIndex = isActive ? 0 : -1;
        });

        const bubbleOnlySettings = document.getElementById('userChatBubbleSettings');
        if (bubbleOnlySettings) {
            bubbleOnlySettings.hidden = normalizedMode !== 'bubble';
        }

        const bubbleWidthSettings = document.getElementById('chatBubbleWidthSettings');
        if (bubbleWidthSettings) {
            bubbleWidthSettings.hidden = normalizedMode !== 'bubble';
        }
    }

    function setupChatPresentationQuickSwitcher() {
        globalSettings = settingsOwner.get();
        document.querySelectorAll('.chat-presentation-quick-switcher').forEach((switcher) => {
            const options = Array.from(switcher.querySelectorAll('.chat-presentation-quick-option'));
            if (!options.length || switcher.dataset.bound === 'true') return;
            const trigger = document.querySelector(`[aria-controls="${switcher.id}"]`);
            const usesExplicitState = switcher.classList.contains('next-ui-chat-presentation-switcher');

            const setOpen = (open) => {
                switcher.classList.toggle('is-open', open);
                trigger?.setAttribute('aria-expanded', String(open));
            };

            const selectMode = async (option) => {
                const mode = option?.dataset.presentationMode;
                if (!mode) return;
                await applyChatPresentationMode(mode, {
                    persist: true,
                    preserveScroll: true,
                    notify: false,
                    source: `${switcher.id || 'chat-presentation'}-quick-switcher`
                });
            };

            if (usesExplicitState && trigger) {
                listenerOwner.add(trigger, 'click', (event) => {
                    event.stopPropagation();
                    const open = !switcher.classList.contains('is-open');
                    setOpen(open);
                    if (open) {
                        options.find(option => option.getAttribute('aria-checked') === 'true')?.focus();
                    }
                });
                listenerOwner.add(document, 'pointerdown', (event) => {
                    if (!switcher.classList.contains('is-open')) return;
                    if (switcher.contains(event.target) || trigger.contains(event.target)) return;
                    setOpen(false);
                });
                listenerOwner.add(document, 'keydown', (event) => {
                    if (event.key !== 'Escape' || !switcher.classList.contains('is-open')) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    trigger.focus();
                });
            }

            options.forEach((option) => {
                listenerOwner.add(option, 'click', async () => {
                    await selectMode(option);
                    if (usesExplicitState) setOpen(false);
                });
                listenerOwner.add(option, 'keydown', (event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();

                    const currentIndex = Math.max(0, options.indexOf(option));
                    let nextIndex = currentIndex;
                    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + options.length) % options.length;
                    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % options.length;
                    if (event.key === 'Home') nextIndex = 0;
                    if (event.key === 'End') nextIndex = options.length - 1;

                    options[nextIndex].focus();
                    selectMode(options[nextIndex]);
                });
            });

            listenerOwner.add(switcher, 'keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                if (usesExplicitState) setOpen(false);
                trigger?.focus();
                if (!usesExplicitState) trigger?.blur();
            });

            switcher.dataset.bound = 'true';
        });
        syncChatPresentationModeControls(globalSettings.chatPresentationMode);
    }

    async function applyChatPresentationMode(mode, options = {}) { return themeOwner.applyPresentation(mode, options); }


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
        document.querySelectorAll('.message-item.user').forEach((messageItem) => {
            applyUserMessageLayoutState(messageItem, settings);
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

        if (getPretextBridge() && typeof getPretextBridge().setChatFonts === 'function') {
            getPretextBridge().setChatFonts(chatFontFamily, chatCodeFontFamily);
        }

        if (document.body) {
            document.body.classList.toggle('chat-wide-layout', resolvedSettings.enableWideChatLayout === true);
        }
        applyChatPresentationMode(resolvedSettings.chatPresentationMode, {
            persist: false,
            preserveScroll: false,
            source: 'layout-settings'
        });
        applyUserChatBubbleUiState(resolvedSettings);
    }

    /**
     * 🟢 将全局设置同步到 UI 元素（仅在模态框实例化后调用）
     */
    async function syncGlobalSettingsToUI() {
        const token = generation;
        if (!isCurrent(token)) return false;
        globalSettings = settingsOwner.get();
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

        const completedUrl = getSettingsManager().completeVcpUrl(globalSettings.vcpServerUrl || '');
        safeSet('vcpServerUrl', completedUrl);
        safeSet('vcpApiKey', globalSettings.vcpApiKey || '');
        safeSet('fileKey', globalSettings.fileKey || '');
        safeSet('vcpLogUrl', globalSettings.vcpLogUrl || '');
        safeSet('vcpLogKey', globalSettings.vcpLogKey || '');
        safeSet('topicSummaryModel', globalSettings.topicSummaryModel || '');
        safeSet('continueWritingPrompt', globalSettings.continueWritingPrompt || '请继续');
        safeSet('flowlockContinueDelay', globalSettings.flowlockContinueDelay ?? 5);
        safeCheck('voiceModeLocal', (globalSettings.voiceMode || 'local') !== 'network');
        safeCheck('voiceModeNetwork', (globalSettings.voiceMode || 'local') === 'network');
        safeSet('speechRecognizerBrowserPath', globalSettings.speechRecognizerBrowserPath || '');
        safeSet('speechRecognizerPagePath', globalSettings.speechRecognizerPagePath || 'Voicechatmodules/recognizer.html');
        safeSet('voiceLocalSovitsUrl', globalSettings.voiceLocalSettings?.sovitsUrl || '');
        safeSet('voiceLocalSovitsKey', globalSettings.voiceLocalSettings?.sovitsKey || '');
        safeSet('voiceNetworkProviderUrl', globalSettings.voiceNetworkSettings?.providerUrl || '');
        safeSet('voiceNetworkProviderKey', globalSettings.voiceNetworkSettings?.providerKey || '');

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
        safeCheck('showHomeVisualBrand', globalSettings.showHomeVisualBrand !== false);
        safeCheck('showHomeVisualTagline', globalSettings.showHomeVisualTagline !== false);
        safeSet('homeVisualTagline', globalSettings.homeVisualTagline || '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
        const appearance = getAppearance()?.normalize(globalSettings.appearanceProfile, 'next');
        safeSet('appearanceDensity', appearance?.density || 'comfortable');
        safeSet('appearanceRadius', appearance?.radius || 'small');
        safeSet('appearanceTypography', appearance?.typography || 'system');
        safeSet('appearanceFontScale', appearance?.fontScale || 'normal');
        safeSet('appearanceContentWidth', appearance?.contentWidth || 'full');
        safeSet('appearanceSidebarRowHeight', appearance?.sidebarRowHeight ?? 46);
        safeSet('appearanceSidebarRowHeightValue', `${appearance?.sidebarRowHeight ?? 46}px`);
        safeSet('appearanceSidebarAvatarSize', appearance?.sidebarAvatarSize ?? 32);
        safeSet('appearanceSidebarAvatarSizeValue', `${appearance?.sidebarAvatarSize ?? 32}px`);
        safeSet('appearanceSidebarRadius', appearance?.sidebarRadius || 'tuned');
        safeCheck(`appearanceSidebarRadiusChoice-${appearance?.sidebarRadius || 'tuned'}`, true);
        safeSet('appearanceCustomRadius', appearance?.customRadius ?? 10);
        safeSet('appearanceCustomRadiusValue', `${appearance?.customRadius ?? 10}px`);
        document.getElementById('appearanceSidebarAvatarSize')?.dispatchEvent(new Event('input', { bubbles: true }));
        safeSet('appearanceSurface', appearance?.surface || 'translucent');
        safeSet('chatFontPreset', globalSettings.chatFontPreset || 'system');
        safeSet('chatFontCustom', globalSettings.chatFontCustom || '');
        safeSet('chatCodeFontPreset', globalSettings.chatCodeFontPreset || 'consolas');
        safeSet('chatCodeFontCustom', globalSettings.chatCodeFontCustom || '');
        safeSet('chatDiaryFontPreset', globalSettings.chatDiaryFontPreset || 'serif');
        safeSet('chatDiaryFontCustom', globalSettings.chatDiaryFontCustom || '');
        safeSet('chatToolFontPreset', globalSettings.chatToolFontPreset || 'system');
        safeSet('chatToolFontCustom', globalSettings.chatToolFontCustom || '');
        const presentationMode = normalizeChatPresentationMode(globalSettings.chatPresentationMode);
        safeCheck(`chatPresentationMode${presentationMode[0].toUpperCase()}${presentationMode.slice(1)}`, true);
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
        syncChatPresentationModeControls(presentationMode);

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
        const presentationModeRadios = document.querySelectorAll('input[name="chatPresentationMode"]');
        if (chatFontPresetSelect && !chatFontPresetSelect.dataset.boundFontToggle) {
            listenerOwner.add(chatFontPresetSelect, 'change', syncChatFontControls);
            chatFontPresetSelect.dataset.boundFontToggle = 'true';
        }
        if (chatCodeFontPresetSelect && !chatCodeFontPresetSelect.dataset.boundFontToggle) {
            listenerOwner.add(chatCodeFontPresetSelect, 'change', syncChatFontControls);
            chatCodeFontPresetSelect.dataset.boundFontToggle = 'true';
        }
        if (chatDiaryFontPresetSelect && !chatDiaryFontPresetSelect.dataset.boundFontToggle) {
            listenerOwner.add(chatDiaryFontPresetSelect, 'change', syncChatFontControls);
            chatDiaryFontPresetSelect.dataset.boundFontToggle = 'true';
        }
        if (chatToolFontPresetSelect && !chatToolFontPresetSelect.dataset.boundFontToggle) {
            listenerOwner.add(chatToolFontPresetSelect, 'change', syncChatFontControls);
            chatToolFontPresetSelect.dataset.boundFontToggle = 'true';
        }
        if (chatFontCustomInput && !chatFontCustomInput.dataset.boundFontPreview) {
            listenerOwner.add(chatFontCustomInput, 'input', updateFontScenarioPreview);
            chatFontCustomInput.dataset.boundFontPreview = 'true';
        }
        if (chatCodeFontCustomInput && !chatCodeFontCustomInput.dataset.boundFontPreview) {
            listenerOwner.add(chatCodeFontCustomInput, 'input', updateFontScenarioPreview);
            chatCodeFontCustomInput.dataset.boundFontPreview = 'true';
        }
        if (chatDiaryFontCustomInput && !chatDiaryFontCustomInput.dataset.boundFontPreview) {
            listenerOwner.add(chatDiaryFontCustomInput, 'input', updateFontScenarioPreview);
            chatDiaryFontCustomInput.dataset.boundFontPreview = 'true';
        }
        if (chatToolFontCustomInput && !chatToolFontCustomInput.dataset.boundFontPreview) {
            listenerOwner.add(chatToolFontCustomInput, 'input', updateFontScenarioPreview);
            chatToolFontCustomInput.dataset.boundFontPreview = 'true';
        }
        if (wideModeRadio && !wideModeRadio.dataset.boundWideChatToggle) {
            listenerOwner.add(wideModeRadio, 'change', syncWideChatLayoutControls);
            wideModeRadio.dataset.boundWideChatToggle = 'true';
        }
        if (normalModeRadio && !normalModeRadio.dataset.boundWideChatToggle) {
            listenerOwner.add(normalModeRadio, 'change', syncWideChatLayoutControls);
            normalModeRadio.dataset.boundWideChatToggle = 'true';
        }
        if (userBubbleUiToggle && !userBubbleUiToggle.dataset.boundUserBubbleToggle) {
            listenerOwner.add(userBubbleUiToggle, 'change', syncUserChatBubbleControls);
            userBubbleUiToggle.dataset.boundUserBubbleToggle = 'true';
        }
        presentationModeRadios.forEach((radio) => {
            if (radio.dataset.boundPresentationModeToggle) return;
            listenerOwner.add(radio, 'change', () => {
                if (!radio.checked) return;
                applyChatPresentationMode(radio.value, {
                    persist: true,
                    preserveScroll: true,
                    notify: false,
                    source: 'settings'
                });
            });
            radio.dataset.boundPresentationModeToggle = 'true';
        });

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
            if (!isCurrent(token)) return false;
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
            await getSettingsManager().populateAssistantAgentSelect();
            if (!isCurrent(token)) return false;
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
                if (!isCurrent(token)) return false;
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
                        listenerOwner.add(rustDebugModeEl, 'change', syncRustDebugPanelVisibility);
                        rustDebugModeEl.dataset.debugPanelBound = 'true';
                    }

                    const rustUseAssistantEl = document.getElementById('rustUseAssistant');
                    if (rustUseAssistantEl && !rustUseAssistantEl.dataset.guardPanelBound) {
                        listenerOwner.add(rustUseAssistantEl, 'change', syncRustGuardRulesVisibility);
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
                if (!isCurrent(token)) return false;
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
        return true;
    }

    return Object.freeze({
        configureThemeOwner(owner) {
            if (!owner || typeof owner.applyPresentation !== 'function') {
                throw new TypeError('MainChatSettingsPresentationOwner requires a theme owner.');
            }
            if (themeOwner && themeOwner !== owner) throw new Error('Theme owner is already configured.');
            themeOwner = owner;
        },
        configureStartup({ loadSettings: nextLoadSettings, startupThemeGate: nextStartupThemeGate } = {}) {
            if (typeof nextLoadSettings !== 'function' || !nextStartupThemeGate?.release) {
                throw new TypeError('MainChatSettingsPresentationOwner requires startup settings capabilities.');
            }
            loadSettingsCapability = nextLoadSettings;
            startupThemeGateCapability = nextStartupThemeGate;
        },
        applyInitialTheme: mode => themeOwner.applyInitialTheme(mode),
        normalizePresentation: mode => themeOwner.normalizePresentation(mode),
        applyPresentation: (mode, options) => themeOwner.applyPresentation(mode, options),
        capturePresentationAnchor: captureChatPresentationScrollAnchor,
        restorePresentationAnchor: restoreChatPresentationScrollAnchor,
        syncPresentationControls: syncChatPresentationModeControls,
        setupPresentationQuickSwitcher: setupChatPresentationQuickSwitcher,
        applyLayoutSettings: applyChatBubbleLayoutSettings,
        syncSettingsToUI: () => track(syncGlobalSettingsToUI()),
        loadAndApply: () => track(loadAndApply()),
        async dispose() {
            if (disposed) return;
            disposed = true;
            generation += 1;
            await Promise.allSettled([...tasks]);
            themeOwner = null;
            loadSettingsCapability = null;
            startupThemeGateCapability = null;
        },
    });
}
