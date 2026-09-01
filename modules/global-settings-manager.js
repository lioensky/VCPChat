/**
 * This module handles the logic for saving global settings.
 */
export function handleSaveGlobalSettings(e, deps) {
    e.preventDefault();
    const settingsForm = e.currentTarget || document.getElementById('globalSettingsForm');
    if (settingsForm?.dataset.globalSettingsSaving === 'true') {
        // The legacy autosave state machine unlocks only on a
        // `vcp-settings-save-result` event. Returning silently here wedged that
        // machine on 保存中… forever and made the close-time flush drop the
        // edit. Publish an explicit outcome instead of dropping it.
        //
        // This is *not* a terminal failure: the in-flight save still owns the
        // outcome and will publish its own result. `inflight: true` marks the
        // event as a merge notice so consumers keep waiting rather than
        // flipping the status bar to 失败 and immediately re-submitting.
        settingsForm?.dispatchEvent(new CustomEvent('vcp-settings-save-result', {
            detail: {
                success: false,
                error: '已有保存任务进行中，请稍后重试',
                owner: 'global-settings-concurrent-guard',
                inflight: true,
            }
        }));
        return;
    }
    if (settingsForm) settingsForm.dataset.globalSettingsSaving = 'true';

    return saveGlobalSettings(deps, settingsForm).catch(error => {
        // Exceptions (notably the bounded IPC timeout) are terminal outcomes
        // for the autosave consumer too. Publish the same failure contract as
        // an explicit `{ success: false }` result before releasing the lock.
        settingsForm?.dispatchEvent(new CustomEvent('vcp-settings-save-result', {
            detail: { success: false, error: error?.message || String(error) }
        }));
        throw error;
    }).finally(() => {
        if (settingsForm) delete settingsForm.dataset.globalSettingsSaving;
    });
}

function awaitWithTimeout(value, timeoutMs) {
    const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
    let timer;
    return Promise.race([
        Promise.resolve(value),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`保存设置超时（${duration}ms）`)), duration);
        }),
    ]).finally(() => clearTimeout(timer));
}

async function saveGlobalSettings(deps, settingsForm) {
    const chatAPI = window.chatAPI || window.electronAPI;
    const reportSaveResult = (success, error = '') => {
        settingsForm?.dispatchEvent(new CustomEvent('vcp-settings-save-result', {
            detail: { success, error: error || undefined }
        }));
    };

    const {
        refs,
        messageRenderer,
        getCroppedFile,
        setCroppedFile,
        uiHelperFunctions,
        settingsManager,
        normalizeChatPresentationMode,
        applyChatPresentationMode,
        applyChatBubbleLayoutSettings,
        getAppearance = () => window.VCPAppearance
    } = deps;
    if (typeof normalizeChatPresentationMode !== 'function' || typeof applyChatPresentationMode !== 'function'
        || typeof applyChatBubbleLayoutSettings !== 'function') {
        throw new TypeError('Global settings save requires presentation and layout capabilities.');
    }
    const currentSettings = refs.globalSettings.get();

    const clampBubbleWidthPercent = (rawValue, fallback) => {
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(98, Math.max(50, parsed));
    };

    const networkNotesPathsContainer = document.getElementById('networkNotesPathsContainer');
    const pathInputs = networkNotesPathsContainer.querySelectorAll('input[name="networkNotesPath"]');
    const networkNotesPaths = Array.from(pathInputs).map(input => input.value.trim()).filter(path => path);
    const parseMultilineKeywords = (id) => {
        const value = document.getElementById(id)?.value || '';
        return value
            .split(/\r?\n|,|，|;|；/)
            .map(item => item.trim())
            .filter(Boolean);
    };

    const voiceMode = document.getElementById('voiceModeNetwork')?.checked ? 'network' : 'local';
    const allowedVoiceInputModes = new Set(['windows_voice_typing', 'right_alt_hold']);
    const selectedVoiceInputMode = document.getElementById('voiceInputMode')?.value;
    const voiceInputMode = allowedVoiceInputModes.has(selectedVoiceInputMode)
        ? selectedVoiceInputMode
        : 'windows_voice_typing';
    const voiceInputShortcut = (
        document.getElementById('voiceInputShortcut')?.value.trim()
        || 'F7'
    ).toUpperCase();
    const allowedStreamAnimationPresets = new Set(['slide-left', 'fade', 'rise', 'scale', 'none', 'custom']);
    const selectedStreamAnimationPreset = document.getElementById('streamAnimationPreset')?.value;
    const streamAnimationPreset = allowedStreamAnimationPresets.has(selectedStreamAnimationPreset)
        ? selectedStreamAnimationPreset
        : 'slide-left';
    const rawStreamAnimationDurationMs = Number(document.getElementById('streamAnimationDurationMs')?.value);
    const streamAnimationDurationMs = Number.isFinite(rawStreamAnimationDurationMs)
        ? Math.min(2000, Math.max(100, Math.round(rawStreamAnimationDurationMs / 50) * 50))
        : 500;
    const streamAnimationCustomCss = (document.getElementById('streamAnimationCustomCss')?.value || '').slice(0, 4000);

    const newSettings = {
        userName: document.getElementById('userName').value.trim() || '用户',
        userAvatarBorderColor: document.getElementById('userAvatarBorderColor')?.value || '#3d5a80',
        userNameTextColor: document.getElementById('userNameTextColor')?.value || '#ffffff',
        userUseThemeColorsInChat: document.getElementById('userUseThemeColorsInChat')?.checked || false,
        continueWritingPrompt: document.getElementById('continueWritingPrompt').value.trim() || '请继续',
        flowlockContinueDelay: parseInt(document.getElementById('flowlockContinueDelay').value, 10) || 5,
        enableMiddleClickQuickAction: document.getElementById('enableMiddleClickQuickAction').checked,
        middleClickQuickAction: document.getElementById('middleClickQuickAction').value,
        enableMiddleClickAdvanced: document.getElementById('enableMiddleClickAdvanced').checked,
        middleClickAdvancedDelay: Math.max(1000, parseInt(document.getElementById('middleClickAdvancedDelay').value, 10) || 1000),
        enableRegenerateConfirmation: document.getElementById('enableRegenerateConfirmation').checked,
        vcpServerUrl: settingsManager.completeVcpUrl(document.getElementById('vcpServerUrl').value.trim()),
        vcpApiKey: document.getElementById('vcpApiKey').value,
        fileKey: document.getElementById('fileKey')?.value || '',
        vcpLogUrl: document.getElementById('vcpLogUrl').value.trim(),
        vcpLogKey: document.getElementById('vcpLogKey').value.trim(),
        topicSummaryModel: document.getElementById('topicSummaryModel').value.trim(),
        networkNotesPaths: networkNotesPaths,
        sidebarWidth: refs.globalSettings.get().sidebarWidth,
        notificationsSidebarWidth: refs.globalSettings.get().notificationsSidebarWidth,
        enableSmoothStreaming: document.getElementById('enableSmoothStreaming').checked,
        streamAnimationPreset,
        streamAnimationDurationMs,
        streamAnimationCustomCss,
        showHomeVisualBrand: document.getElementById('showHomeVisualBrand')?.checked !== false,
        showHomeVisualTagline: document.getElementById('showHomeVisualTagline')?.checked !== false,
        homeVisualTagline: document.getElementById('homeVisualTagline')?.value.trim().slice(0, 120)
            || '语义级打穿 AI、UI/UX、APP 与人类想象力的边界',
        appearanceProfile: getAppearance()?.normalize({
            density: document.getElementById('appearanceDensity')?.value,
            radius: document.getElementById('appearanceRadius')?.value,
            typography: document.getElementById('appearanceTypography')?.value,
            fontScale: document.getElementById('appearanceFontScale')?.value,
            contentWidth: document.getElementById('appearanceContentWidth')?.value,
            sidebarRowHeight: Number(document.getElementById('appearanceSidebarRowHeight')?.value)
                || currentSettings.appearanceProfile?.sidebarRowHeight
                || 46,
            sidebarAvatarSize: Number(document.getElementById('appearanceSidebarAvatarSize')?.value)
                || currentSettings.appearanceProfile?.sidebarAvatarSize
                || 32,
            customRadius: Number(document.getElementById('appearanceCustomRadius')?.value ?? 10),
            surface: document.getElementById('appearanceSurface')?.value,
            surfaceEffect: currentSettings.appearanceProfile?.surfaceEffect,
            surfaceOpacity: currentSettings.appearanceProfile?.surfaceOpacity,
            surfaceBlur: currentSettings.appearanceProfile?.surfaceBlur,
            surfaceSaturation: currentSettings.appearanceProfile?.surfaceSaturation,
            surfaceBrightness: currentSettings.appearanceProfile?.surfaceBrightness,
            surfaceBorder: currentSettings.appearanceProfile?.surfaceBorder,
            surfaceShadow: currentSettings.appearanceProfile?.surfaceShadow,
            surfaceSheen: currentSettings.appearanceProfile?.surfaceSheen,
            shellRadius: currentSettings.appearanceProfile?.shellRadius,
            composerRadius: currentSettings.appearanceProfile?.composerRadius,
            sidebarRadius: document.getElementById('appearanceSidebarRadius')?.value
                || currentSettings.appearanceProfile?.sidebarRadius,
            cardRadius: currentSettings.appearanceProfile?.cardRadius
        }, 'next') || currentSettings.appearanceProfile,
        chatFontPreset: document.getElementById('chatFontPreset')?.value || currentSettings.chatFontPreset || 'system',
        chatFontCustom: document.getElementById('chatFontCustom')?.value.trim() || '',
        chatCodeFontPreset: document.getElementById('chatCodeFontPreset')?.value || currentSettings.chatCodeFontPreset || 'consolas',
        chatCodeFontCustom: document.getElementById('chatCodeFontCustom')?.value.trim() || '',
        chatDiaryFontPreset: document.getElementById('chatDiaryFontPreset')?.value || currentSettings.chatDiaryFontPreset || 'serif',
        chatDiaryFontCustom: document.getElementById('chatDiaryFontCustom')?.value.trim() || '',
        chatToolFontPreset: document.getElementById('chatToolFontPreset')?.value || currentSettings.chatToolFontPreset || 'system',
        chatToolFontCustom: document.getElementById('chatToolFontCustom')?.value.trim() || '',
        enableWideChatLayout: document.getElementById('chatLayoutModeWide')?.checked || false,
        chatPresentationMode: normalizeChatPresentationMode(
            document.querySelector('input[name="chatPresentationMode"]:checked')?.value
                || currentSettings.chatPresentationMode
        ),
        enableUserChatBubbleUi: document.getElementById('enableUserChatBubbleUi')?.checked !== false,
        showUserMetaInChatBubbleUi: document.getElementById('showUserMetaInChatBubbleUi')?.checked !== false,
        chatBubbleMaxWidthDefault: clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthDefault, 82),
        chatBubbleMaxWidthNotifications: clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthNotifications, 90),
        chatBubbleMaxWidthNarrow: clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthNarrow, 85),
        chatBubbleMaxWidthWideDefault: clampBubbleWidthPercent(document.getElementById('chatBubbleMaxWidthWideDefault')?.value, 92),
        chatBubbleMaxWidthWideNotifications: clampBubbleWidthPercent(document.getElementById('chatBubbleMaxWidthWideNotifications')?.value, 96),
        chatBubbleMaxWidthWideNarrow: clampBubbleWidthPercent(
            document.getElementById('chatBubbleMaxWidthWideNarrow')?.value,
            clampBubbleWidthPercent(currentSettings.chatBubbleMaxWidthWideNarrow, 92)
        ),
        minChunkBufferSize: parseInt(document.getElementById('minChunkBufferSize').value, 10) || 16,
        smoothStreamIntervalMs: parseInt(document.getElementById('smoothStreamIntervalMs').value, 10) || 100,
        assistantAgent: document.getElementById('assistantAgent').value,
        voiceMode,
        voiceInputMode,
        voiceInputShortcut,
        voiceLocalSettings: {
            sovitsUrl: document.getElementById('voiceLocalSovitsUrl')?.value.trim() || '',
            sovitsKey: document.getElementById('voiceLocalSovitsKey')?.value || ''
        },
        voiceNetworkSettings: {
            providerUrl: document.getElementById('voiceNetworkProviderUrl')?.value.trim() || '',
            providerKey: document.getElementById('voiceNetworkProviderKey')?.value || ''
        },
        enableDistributedServer: document.getElementById('enableDistributedServer').checked,
        agentMusicControl: document.getElementById('agentMusicControl').checked,
        enableVcpToolInjection: document.getElementById('enableVcpToolInjection').checked,
        enableThoughtChainInjection: document.getElementById('enableThoughtChainInjection').checked,
        enableContextSanitizer: document.getElementById('enableContextSanitizer').checked,
        contextSanitizerDepth: parseInt(document.getElementById('contextSanitizerDepth').value, 10) || 0,
        enableAiMessageButtons: document.getElementById('enableAiMessageButtons').checked,
    };

    // 处理规则模式选择
    const ruleMode = document.getElementById('rustRuleMode')?.value || 'none';
    const whitelist = ruleMode === 'whitelist' ? parseMultilineKeywords('rustWhitelistKeywords') : [];
    const blacklist = ruleMode === 'blacklist' ? parseMultilineKeywords('rustBlacklistKeywords') : [];
    const screenshotApps = parseMultilineKeywords('rustScreenshotApps');

    // 处理自定义阈值
    const enableCustomThresholds = document.getElementById('rustEnableCustomThresholds')?.checked || false;
    let runtimeThresholds = {
        minEventIntervalMs: 80,
        minDistance: 0,
        screenshotSuspendMs: 3000,
        clipboardConflictSuspendMs: 1000,
        clipboardCheckIntervalMs: 500
    };

    if (enableCustomThresholds) {
        runtimeThresholds = {
            minEventIntervalMs: Math.max(0, parseInt(document.getElementById('rustMinEventIntervalMs')?.value || 80, 10)),
            minDistance: Math.max(0, parseInt(document.getElementById('rustMinDistance')?.value || 0, 10)),
            screenshotSuspendMs: Math.max(0, parseInt(document.getElementById('rustScreenshotSuspendMs')?.value || 3000, 10)),
            clipboardConflictSuspendMs: Math.max(0, parseInt(document.getElementById('rustClipboardConflictSuspendMs')?.value || 1000, 10)),
            clipboardCheckIntervalMs: Math.max(50, parseInt(document.getElementById('rustClipboardCheckIntervalMs')?.value || 500, 10))
        };
    }

    const rustConfigPatch = {
        useRustAssistant: true,
        debugMode: document.getElementById('rustDebugMode')?.checked || false,
        whitelist: whitelist,
        blacklist: blacklist,
        screenshotApps: screenshotApps,
        runtimeThresholds: runtimeThresholds,
    };
 
     const userAvatarCropped = getCroppedFile('user');
    if (userAvatarCropped) {
        try {
            const arrayBuffer = await userAvatarCropped.arrayBuffer();
            const avatarSaveResult = await chatAPI.saveUserAvatar({
                name: userAvatarCropped.name,
                type: userAvatarCropped.type,
                buffer: arrayBuffer
            });
            if (avatarSaveResult.success) {
                newSettings.userAvatarUrl = avatarSaveResult.avatarUrl;
                const userAvatarPreview = document.getElementById('userAvatarPreview');
                userAvatarPreview.src = avatarSaveResult.avatarUrl;
                userAvatarPreview.style.display = 'block';
                
                // 移除 no-avatar 类，因为现在有头像了
                const userAvatarWrapper = userAvatarPreview?.closest('.agent-avatar-wrapper');
                if (userAvatarWrapper) {
                    userAvatarWrapper.classList.remove('no-avatar');
                }
                
                messageRenderer?.setUserAvatar(avatarSaveResult.avatarUrl);
                if (avatarSaveResult.needsColorExtraction && chatAPI?.saveAvatarColor) {
                    if (window.getDominantAvatarColor) {
                        window.getDominantAvatarColor(avatarSaveResult.avatarUrl).then(avgColor => {
                            if (avgColor) {
                                chatAPI.saveAvatarColor({ type: 'user', id: 'user_global', color: avgColor })
                                    .then((saveColorResult) => {
                                        if (saveColorResult && saveColorResult.success) {
                                            const current = refs.globalSettings.get();
                                            refs.globalSettings.set?.({ ...current, userAvatarCalculatedColor: avgColor });
                                            messageRenderer?.setUserAvatarColor(avgColor);
                                        } else {
                                            console.warn("Failed to save user avatar color:", saveColorResult?.error);
                                        }
                                    }).catch(err => console.error("Error saving user avatar color:", err));
                            }
                        });
                    }
                }
                setCroppedFile('user', null);
                document.getElementById('userAvatarInput').value = '';
            } else {
                const error = avatarSaveResult.error || '未知错误';
                reportSaveResult(false, `保存用户头像失败: ${error}`);
                uiHelperFunctions.showToastNotification(`保存用户头像失败: ${error}`, 'error');
                return;
            }
        } catch (readError) {
            const error = readError?.message || String(readError);
            reportSaveResult(false, `读取用户头像文件失败: ${error}`);
            uiHelperFunctions.showToastNotification(`读取用户头像文件失败: ${error}`, 'error');
            return;
        }
    }

    // 保存论坛配置 (forum.config.json)
    const adminUsername = document.getElementById('adminUsername')?.value?.trim() || '';
    const adminPassword = document.getElementById('adminPassword')?.value || '';
    const forumFieldOwnerMounted = settingsForm?.dataset.vcpTypedForumFieldOwnerMounted === 'true';
    if ((adminUsername || adminPassword) && !forumFieldOwnerMounted) {
        try {
            const forumConfig = {
                username: adminUsername,
                password: adminPassword,
                replyUsername: newSettings.userName || '用户',
                rememberCredentials: true
            };
            const forumService = window.VCPUISettingsBridge?.getForumConfigService?.();
            const forumResult = forumService?.save?.execute
                ? await forumService.save.execute(forumConfig)
                : await chatAPI.saveForumConfig(forumConfig);
            if (!forumResult?.success) {
                const error = forumResult?.error || '未知错误';
                reportSaveResult(false, `论坛配置保存失败: ${error}`);
                uiHelperFunctions.showToastNotification(`论坛配置保存失败: ${error}`, 'error');
                return;
            }
        } catch (forumErr) {
            const error = forumErr?.message || String(forumErr);
            reportSaveResult(false, `论坛配置保存失败: ${error}`);
            uiHelperFunctions.showToastNotification(`论坛配置保存失败: ${error}`, 'error');
            return;
        }
    }

    // A renderer must regain control when the main-process save never
    // settles. The underlying IPC call may still finish later, but its late
    // result cannot continue this operation because the bounded await has
    // already rejected and the form lock is released by the outer finally.
    const typedSettingsService = window.VCPUISettingsBridge?.getTypedService?.();
    const saveOperation = typedSettingsService?.save?.execute
        ? typedSettingsService.save.execute(newSettings)
        : chatAPI.saveSettings(newSettings);
    let result;
    try {
        result = await awaitWithTimeout(saveOperation, deps.saveTimeoutMs);
    } catch (error) {
        // A bounded UI timeout is a terminal owner transition. Invalidate the
        // typed command generation so a late IPC result cannot republish the
        // timed-out patch into SettingsRoot.
        typedSettingsService?.cancelPendingSaves?.();
        throw error;
    }
    if (result?.success) {
        if (chatAPI?.saveRustAssistantConfig) {
            const rustService = window.VCPUISettingsBridge?.getRustAssistantService?.();
            const rustSaveResult = rustService?.save?.execute
                ? await rustService.save.execute(rustConfigPatch)
                : await chatAPI.saveRustAssistantConfig(rustConfigPatch);
            if (!rustSaveResult?.success) {
                const error = rustSaveResult?.error || '未知错误';
                reportSaveResult(false, `Rust助手配置保存失败: ${error}`);
                uiHelperFunctions.showToastNotification(`Rust助手配置保存失败: ${error}`, 'error');
                // Global settings are already durable, but the Rust capability
                // is a separate command boundary. Keep SettingsRoot open so
                // autosave can expose retry instead of closing on a partial
                // success.
                return;
            } else if (rustSaveResult.reconcile?.modeChanged) {
                const modeLabel = rustSaveResult.reconcile.mode === 'rust' ? 'Rust' : 'Disabled';
                const restartText = rustSaveResult.reconcile.restarted ? '并已热重启监听器' : '将在下次启用监听器时生效';
                uiHelperFunctions.showToastNotification(`划词监听已切换到 ${modeLabel} 实现，${restartText}`, 'success');
            }
        }

        try {
            newSettings.appearanceProfile = getAppearance()?.commit(
                newSettings.appearanceProfile,
                { uiMode: 'next', source: 'settings-save' }
            ) || newSettings.appearanceProfile;
            const committedSettings = { ...currentSettings, ...newSettings };
            refs.globalSettings.set?.(committedSettings);
            window.dispatchEvent(new CustomEvent('global-settings-updated', {
                detail: { settings: committedSettings, source: 'settings-save' }
            }));
            if (typeof applyChatBubbleLayoutSettings === 'function') {
                applyChatBubbleLayoutSettings(committedSettings);
            }
            if (typeof applyChatPresentationMode === 'function') {
                // Typed settings controls may save a partial patch (for
                // example, the content-width choice only sends
                // enableWideChatLayout). Re-applying an undefined
                // presentation mode here would normalize to bubble and can
                // race the just-committed layout projection. Always use the
                // merged authoritative snapshot for this second pass.
                await applyChatPresentationMode(committedSettings.chatPresentationMode, {
                    persist: false,
                    preserveScroll: true,
                    source: 'global-settings'
                });
            }
        } catch (presentationError) {
            // Settings have already been written. Keep the dialog state
            // truthful and surface this as a post-save presentation warning,
            // rather than incorrectly reporting an unsaved form.
            console.error('[GlobalSettings] Saved, but applying presentation settings failed:', presentationError);
            uiHelperFunctions.showToastNotification(`设置已保存，但界面应用失败：${presentationError?.message || presentationError}`, 'warning');
        }
        reportSaveResult(true);
        uiHelperFunctions.showToastNotification('全局设置已保存！部分设置（如通知URL/Key）可能需要重新连接生效。');
        // Keep-open contract: avatar saves and autosave-initiated submissions
        // stay in the dialog — an autosave that slams the modal shut (and
        // tears the unified surface down mid-edit) is what white-screened the
        // settings page on every numeric commit.
        const keepOpenAfterSave = settingsForm?.dataset.vcpKeepOpenAfterAvatarSave === 'true'
            || settingsForm?.dataset.vcpKeepOpenAfterSave === 'true';
        if (keepOpenAfterSave) {
            delete settingsForm.dataset.vcpKeepOpenAfterAvatarSave;
            delete settingsForm.dataset.vcpKeepOpenAfterSave;
        } else {
            uiHelperFunctions.closeModal('globalSettingsModal');
        }
        if (refs.globalSettings.get().vcpLogUrl && refs.globalSettings.get().vcpLogKey) {
             chatAPI.connectVCPLog(refs.globalSettings.get().vcpLogUrl, refs.globalSettings.get().vcpLogKey);
        } else {
             chatAPI.disconnectVCPLog();
             if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, document.getElementById('vcpLogConnectionStatus'));
        }
   } else {
       const error = result?.error || '保存接口未返回成功结果';
       reportSaveResult(false, error);
       uiHelperFunctions.showToastNotification(`保存全局设置失败: ${error}`, 'error');
    }
}
