import { applyUserMessageLayoutState } from './domBuilder.js';
import { syncDependentRows } from '../ui-system/settings/dependent-rows.js';

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
    let globalSettingsReadyListenerBound = false;
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
        if (!globalSettingsReadyListenerBound) {
            listenerOwner.add(document, 'modal-ready', event => {
                if (event.detail?.modalId === 'globalSettingsModal' && !disposed) track(syncGlobalSettingsToUI());
            });
            globalSettingsReadyListenerBound = true;
        }
        messageRenderer?.setUserAvatar?.(globalSettings.userAvatarUrl);
        messageRenderer?.setUserAvatarColor?.(globalSettings.userAvatarCalculatedColor);
        return true;
    }

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

        // 阶段 3 扁平化：气泡相关条件行挂在 appearance 分区下并自带
        // data-visible-when；这里只负责重估行可见性。
        const form = document.getElementById('globalSettingsForm');
        if (form) syncDependentRows(form);
    }

    function setupChatPresentationQuickSwitcher() {
        globalSettings = settingsOwner.get();
        document.querySelectorAll('.chat-presentation-quick-switcher').forEach((switcher) => {
            const options = Array.from(switcher.querySelectorAll('.chat-presentation-quick-option'));
            if (!options.length || switcher.dataset.bound === 'true') return;
            const trigger = document.querySelector(`[aria-controls="${switcher.id}"]`);
            const usesExplicitState = switcher.classList.contains('next-ui-chat-presentation-switcher');

            let hoverCloseTimer = null;
            const cancelHoverClose = () => {
                if (hoverCloseTimer === null) return;
                windowRef?.clearTimeout?.(hoverCloseTimer);
                hoverCloseTimer = null;
            };
            const setOpen = (open) => {
                if (open) cancelHoverClose();
                switcher.classList.toggle('is-open', open);
                trigger?.setAttribute('aria-expanded', String(open));
            };
            const scheduleHoverClose = () => {
                cancelHoverClose();
                hoverCloseTimer = windowRef?.setTimeout?.(() => {
                    hoverCloseTimer = null;
                    if (!switcher.matches(':hover') && !trigger.matches(':hover')
                        && !switcher.contains(document.activeElement)) {
                        setOpen(false);
                    }
                }, 180) ?? null;
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
                const hoverRegion = trigger.closest('.next-ui-presentation-switcher') || trigger.parentElement;
                listenerOwner.add(hoverRegion, 'pointerenter', () => setOpen(true));
                listenerOwner.add(hoverRegion, 'pointerleave', scheduleHoverClose);
                listenerOwner.add(switcher, 'pointerenter', () => setOpen(true));
                listenerOwner.add(switcher, 'pointerleave', scheduleHoverClose);
                listenerOwner.add(trigger, 'focus', () => setOpen(true));
                listenerOwner.add(hoverRegion, 'focusout', (event) => {
                    if (!hoverRegion.contains(event.relatedTarget)) setOpen(false);
                });
                listenerOwner.add(trigger, 'click', (event) => {
                    event.stopPropagation();
                    setOpen(false);
                    windowRef?.VCPAppearanceStudio?.open?.({ trigger });
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

    const STREAM_ANIMATION_PRESETS = new Set(['slide-left', 'fade', 'rise', 'scale', 'none', 'custom']);
    const STREAM_ANIMATION_CUSTOM_PROPERTIES = Object.freeze([
        'opacity',
        'transform',
        'filter',
        'transform-origin',
        'clip-path'
    ]);
    const STREAM_ANIMATION_CUSTOM_DEFAULT = `opacity: 0;
transform: translateY(12px) scale(0.98);
filter: blur(3px);
transform-origin: center bottom;`;

    function normalizeStreamAnimationPreset(value) {
        return STREAM_ANIMATION_PRESETS.has(value) ? value : 'slide-left';
    }

    function normalizeStreamAnimationDuration(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed)
            ? Math.min(2000, Math.max(100, Math.round(parsed / 50) * 50))
            : 500;
    }

    function parseStreamAnimationCustomDeclarations(value) {
        const source = typeof value === 'string' ? value.slice(0, 4000) : '';
        const parser = document.createElement('span');
        parser.style.cssText = source;
        const declarations = {};
        STREAM_ANIMATION_CUSTOM_PROPERTIES.forEach(property => {
            const propertyValue = parser.style.getPropertyValue(property).trim();
            if (propertyValue) declarations[property] = propertyValue;
        });
        return declarations;
    }

    function applyStreamAnimationSettings(settings = globalSettings) {
        const root = document.documentElement;
        const preset = normalizeStreamAnimationPreset(settings?.streamAnimationPreset);
        const duration = normalizeStreamAnimationDuration(settings?.streamAnimationDurationMs);
        const custom = parseStreamAnimationCustomDeclarations(settings?.streamAnimationCustomCss);

        root.dataset.vcpStreamAnimation = preset;
        root.style.setProperty('--vcp-stream-animation-duration', `${duration}ms`);
        root.style.setProperty('--vcp-stream-custom-opacity', custom.opacity || '0');
        root.style.setProperty('--vcp-stream-custom-transform', custom.transform || 'translateY(12px) scale(0.98)');
        root.style.setProperty('--vcp-stream-custom-filter', custom.filter || 'none');
        root.style.setProperty('--vcp-stream-custom-transform-origin', custom['transform-origin'] || 'center');
        root.style.setProperty('--vcp-stream-custom-clip-path', custom['clip-path'] || 'none');
    }

    function getStreamAnimationFormSettings() {
        return {
            streamAnimationPreset: normalizeStreamAnimationPreset(
                document.getElementById('streamAnimationPreset')?.value
            ),
            streamAnimationDurationMs: normalizeStreamAnimationDuration(
                document.getElementById('streamAnimationDurationMs')?.value
            ),
            streamAnimationCustomCss: document.getElementById('streamAnimationCustomCss')?.value || ''
        };
    }

    function syncStreamAnimationControls() {
        const preset = normalizeStreamAnimationPreset(document.getElementById('streamAnimationPreset')?.value);
        const duration = normalizeStreamAnimationDuration(document.getElementById('streamAnimationDurationMs')?.value);
        // The flattening renamed the custom-CSS container from upstream's
        // `streamAnimationCustomPanel` to `streamAnimationCustomRow`; accept
        // both so this owner stays correct if either markup generation ships.
        const customPanel = document.getElementById('streamAnimationCustomPanel')
            || document.getElementById('streamAnimationCustomRow');
        const durationOutput = document.getElementById('streamAnimationDurationValue');
        if (customPanel) customPanel.hidden = preset !== 'custom';
        if (durationOutput) durationOutput.value = `${duration}ms`;
    }

    function replayStreamAnimationPreview() {
        syncStreamAnimationControls();
        const preview = document.getElementById('streamAnimationPreviewElement');
        if (!preview) return;

        const settings = getStreamAnimationFormSettings();
        const declarations = parseStreamAnimationCustomDeclarations(settings.streamAnimationCustomCss);
        const presetFrames = {
            'slide-left': { opacity: 0, transform: 'translateX(20px)', filter: 'none' },
            fade: { opacity: 0, transform: 'none', filter: 'none' },
            rise: { opacity: 0, transform: 'translateY(14px)', filter: 'none' },
            scale: { opacity: 0, transform: 'scale(0.94)', filter: 'none' },
            custom: {
                opacity: declarations.opacity || 0,
                transform: declarations.transform || 'translateY(12px) scale(0.98)',
                filter: declarations.filter || 'none',
                transformOrigin: declarations['transform-origin'] || 'center',
                clipPath: declarations['clip-path'] || 'none'
            }
        };
        preview.getAnimations?.().forEach(animation => animation.cancel());
        if (settings.streamAnimationPreset === 'none' || typeof preview.animate !== 'function') return;

        const initial = presetFrames[settings.streamAnimationPreset] || presetFrames['slide-left'];
        preview.animate([
            initial,
            {
                opacity: 1,
                transform: 'none',
                filter: 'none',
                clipPath: 'none'
            }
        ], {
            duration: settings.streamAnimationDurationMs,
            easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            fill: 'both'
        });
    }

    function bindStreamAnimationControls() {
        const preset = document.getElementById('streamAnimationPreset');
        const duration = document.getElementById('streamAnimationDurationMs');
        const customCss = document.getElementById('streamAnimationCustomCss');
        const replay = document.getElementById('replayStreamAnimationPreview');
        const fillExample = document.getElementById('fillStreamAnimationCssExample');

        const bind = (element, type, handler, marker) => {
            if (!element || element.dataset[marker]) return;
            listenerOwner.add(element, type, handler);
            element.dataset[marker] = 'true';
        };
        bind(preset, 'change', () => {
            syncStreamAnimationControls();
            replayStreamAnimationPreview();
        }, 'streamAnimationPresetBound');
        bind(duration, 'input', () => {
            syncStreamAnimationControls();
            replayStreamAnimationPreview();
        }, 'streamAnimationDurationBound');
        bind(customCss, 'input', () => {
            if (preset?.value === 'custom') replayStreamAnimationPreview();
        }, 'streamAnimationCustomBound');
        bind(replay, 'click', replayStreamAnimationPreview, 'streamAnimationReplayBound');
        bind(fillExample, 'click', () => {
            if (!customCss) return;
            customCss.value = STREAM_ANIMATION_CUSTOM_DEFAULT;
            if (preset) preset.value = 'custom';
            syncStreamAnimationControls();
            replayStreamAnimationPreview();
        }, 'streamAnimationExampleBound');

        syncStreamAnimationControls();
    }

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
        const form = document.getElementById('globalSettingsForm');
        if (form) syncDependentRows(form);
    }

    function syncUserChatBubbleControls() {
        const form = document.getElementById('globalSettingsForm');
        if (form) syncDependentRows(form);
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
        applyStreamAnimationSettings(resolvedSettings);

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
        const avatarPreview = document.getElementById('userAvatarPreview');
        if (avatarPreview) {
            const avatarUrl = String(globalSettings.userAvatarUrl || '');
            avatarPreview.src = avatarUrl || 'assets/default_user_avatar.png';
            avatarPreview.style.display = 'block';
            avatarPreview.closest('.agent-avatar-wrapper')?.classList.toggle('no-avatar', !avatarUrl);
        }
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
        // Stream-animation preview + custom-CSS example controls. Upstream
        // called this from its settings-hydration block; the three-way merge
        // kept the definition but dropped the call, leaving the preview inert.
        bindStreamAnimationControls();


        // Forum adminUsername/adminPassword are projected by the typed
        // ForumConfigUiService consumer in settings-bridge; this owner no
        // longer mirrors them through loadForumConfig.


        // Assistant Select
        const assistantAgentSelect = document.getElementById('assistantAgent');
        if (assistantAgentSelect) {
            const settingsManager = getSettingsManager?.();
            if (typeof settingsManager?.populateAssistantAgentSelect === 'function') {
                await settingsManager.populateAssistantAgentSelect();
            }
            if (!isCurrent(token)) return false;
        }


        const typedRustAssistantService = windowRef?.VCPUISettingsBridge?.getRustAssistantService?.() || null;
        if (!typedRustAssistantService && chatAPI?.getRustAssistantConfig) {
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
