/**
 * This module handles the logic for saving global settings.
 */
export async function handleSaveGlobalSettings(e, deps) {
    e.preventDefault();

    const {
        refs,
        getCroppedFile,
        setCroppedFile,
        uiHelperFunctions,
        settingsManager
    } = deps;

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
        vcpLogUrl: document.getElementById('vcpLogUrl').value.trim(),
        vcpLogKey: document.getElementById('vcpLogKey').value.trim(),
        topicSummaryModel: document.getElementById('topicSummaryModel').value.trim(),
        networkNotesPaths: networkNotesPaths,
        sidebarWidth: refs.globalSettings.get().sidebarWidth,
        notificationsSidebarWidth: refs.globalSettings.get().notificationsSidebarWidth,
        enableAgentBubbleTheme: document.getElementById('enableAgentBubbleTheme').checked,
        enableSmoothStreaming: document.getElementById('enableSmoothStreaming').checked,
        minChunkBufferSize: parseInt(document.getElementById('minChunkBufferSize').value, 10) || 16,
        smoothStreamIntervalMs: parseInt(document.getElementById('smoothStreamIntervalMs').value, 10) || 100,
        assistantAgent: document.getElementById('assistantAgent').value,
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
            const avatarSaveResult = await window.electronAPI.saveUserAvatar({
                name: userAvatarCropped.name,
                type: userAvatarCropped.type,
                buffer: arrayBuffer
            });
            if (avatarSaveResult.success) {
                refs.globalSettings.get().userAvatarUrl = avatarSaveResult.avatarUrl;
                const userAvatarPreview = document.getElementById('userAvatarPreview');
                userAvatarPreview.src = avatarSaveResult.avatarUrl;
                userAvatarPreview.style.display = 'block';
                
                // 移除 no-avatar 类，因为现在有头像了
                const userAvatarWrapper = userAvatarPreview?.closest('.agent-avatar-wrapper');
                if (userAvatarWrapper) {
                    userAvatarWrapper.classList.remove('no-avatar');
                }
                
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
                                            refs.globalSettings.get().userAvatarCalculatedColor = avgColor;
                                            if (window.messageRenderer) window.messageRenderer.setUserAvatarColor(avgColor);
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
                uiHelperFunctions.showToastNotification(`保存用户头像失败: ${avatarSaveResult.error}`, 'error');
            }
        } catch (readError) {
            uiHelperFunctions.showToastNotification(`读取用户头像文件失败: ${readError.message}`, 'error');
        }
    }

    const result = await window.electronAPI.saveSettings(newSettings);
    if (result.success) {
        if (window.electronAPI?.saveRustAssistantConfig) {
            const rustSaveResult = await window.electronAPI.saveRustAssistantConfig(rustConfigPatch);
            if (!rustSaveResult?.success) {
                uiHelperFunctions.showToastNotification(`Rust助手配置保存失败: ${rustSaveResult?.error || '未知错误'}`, 'warning');
            } else if (rustSaveResult.reconcile?.modeChanged) {
                const modeLabel = rustSaveResult.reconcile.mode === 'rust' ? 'Rust' : 'Disabled';
                const restartText = rustSaveResult.reconcile.restarted ? '并已热重启监听器' : '将在下次启用监听器时生效';
                uiHelperFunctions.showToastNotification(`划词监听已切换到 ${modeLabel} 实现，${restartText}`, 'success');
            }
        }

        Object.assign(refs.globalSettings.get(), newSettings);
        uiHelperFunctions.showToastNotification('全局设置已保存！部分设置（如通知URL/Key）可能需要重新连接生效。');
        uiHelperFunctions.closeModal('globalSettingsModal');
        if (refs.globalSettings.get().vcpLogUrl && refs.globalSettings.get().vcpLogKey) {
             window.electronAPI.connectVCPLog(refs.globalSettings.get().vcpLogUrl, refs.globalSettings.get().vcpLogKey);
        } else {
             window.electronAPI.disconnectVCPLog();
             if (window.notificationRenderer) window.notificationRenderer.updateVCPLogStatus({ status: 'error', message: 'VCPLog未配置' }, document.getElementById('vcpLogConnectionStatus'));
        }
   } else {
       uiHelperFunctions.showToastNotification(`保存全局设置失败: ${result.error}`, 'error');
    }
}
