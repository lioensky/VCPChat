/**
 * This module encapsulates all event listener setup logic for the main renderer process.
 */

import { handleSaveGlobalSettings } from './global-settings-manager.js';
import { syncDependentRows } from './ui-system/settings/dependent-rows.js';

let eventListenersBound = false;

// This function will be called from renderer.js to attach all event listeners.
// It receives a 'deps' object containing all necessary references to elements, state, and functions.
export function setupEventListeners(deps) {
    if (eventListenersBound) {
        console.warn('[EventListeners] setupEventListeners already initialized, skipping duplicate binding.');
        return;
    }
    eventListenersBound = true;
    const chatAPI = window.chatAPI || window.electronAPI;
    const {
        // DOM Elements from a future dom-elements.js or passed directly
        chatMessagesDiv, sendMessageBtn, messageInput, attachFileBtn, globalSettingsBtn,
        globalSettingsForm, userAvatarInput,
        currentItemActionBtn, toggleNotificationsBtn,
        notificationsSidebar, agentSearchInput, addNetworkPathBtn,
        openTranslatorBtn, openNotesBtn, openMusicBtn, openCanvasBtn, toggleAssistantBtn, toggleSidebarModeBtn,
        leftSidebar, toggleSidebarBtn,

        // State variables (passed via refs)
        refs,

        // Modules and helper functions
        uiHelperFunctions, chatManager, messageRenderer, historyMutationAuthority, itemListManager, settingsManager, uiManager, topicListManager,
        getCroppedFile, setCroppedFile, updateAttachmentPreview, filterAgentList,
        addNetworkPathInput, sendButtonAction, listenerOwner, syncSettingsToUI
    } = deps;
    const addListener = (target, type, handler, options) => listenerOwner?.add(target, type, handler, options) || target?.addEventListener?.(type, handler, options);
    const setOwnedTimeout = (callback, delay) => listenerOwner?.timeout?.(callback, delay) ?? setTimeout(callback, delay);
    const releaseCapturedListeners = listenerOwner?.capture?.() || (() => {});

    let setupCompleted = false;
    try {
    const setupAutoHideScrollbar = (container, hideDelayMs = 700) => {
        if (!container) return;
        if (container.dataset.autoHideScrollbarBound === 'true') return;

        let hideTimer = null;
        const showScrollingState = () => {
            container.classList.add('is-scrolling');
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setOwnedTimeout(() => {
                container.classList.remove('is-scrolling');
                hideTimer = null;
            }, hideDelayMs);
        };

        container.addEventListener('scroll', showScrollingState, { passive: true });
        container.dataset.autoHideScrollbarBound = 'true';
    };

    setupAutoHideScrollbar(document.querySelector('#tabContentAgents .sidebar-list-scroll'));
    setupAutoHideScrollbar(document.querySelector('#tabContentTopics .sidebar-list-scroll'));
    setupAutoHideScrollbar(chatMessagesDiv?.closest('.chat-messages-container'), 1500);

    // --- Keyboard Shortcut Handlers ---

    /**
     * Handles the quick save settings shortcut.
     */
    function handleQuickSaveSettings() {
        console.log('[快捷键] 执行快速保存设置');

        const currentItem = refs.currentSelectedItem.get();
        if (!currentItem.id) {
            uiHelperFunctions.showToastNotification('请先选择一个Agent或群组', 'warning');
            return;
        }

        const agentSettingsForm = document.getElementById('agentSettingsForm');
        if (agentSettingsForm && currentItem.type === 'agent') {
            const fakeEvent = new Event('submit', { bubbles: true, cancelable: true });
            agentSettingsForm.dispatchEvent(fakeEvent);
        } else if (currentItem.type === 'group') {
            const groupSettingsForm = document.getElementById('groupSettingsForm');
            if (groupSettingsForm) {
                const fakeEvent = new Event('submit', { bubbles: true, cancelable: true });
                groupSettingsForm.dispatchEvent(fakeEvent);
            } else {
                uiHelperFunctions.showToastNotification('群组设置表单不可用', 'error');
            }
        } else {
            uiHelperFunctions.showToastNotification('当前没有可保存的设置', 'info');
        }
    }

    /**
     * Handles the quick export topic shortcut.
     */
    async function handleQuickExportTopic() {
        console.log('[快捷键] 执行快速导出话题');

        const currentTopicId = refs.currentTopicId.get();
        const currentSelectedItem = refs.currentSelectedItem.get();
        if (!currentTopicId || !currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification('请先选择并打开一个话题', 'warning');
            return;
        }

        try {
            let topicName = '未命名话题';
            if (currentSelectedItem.config && currentSelectedItem.config.topics) {
                const currentTopic = currentSelectedItem.config.topics.find(t => t.id === currentTopicId);
                if (currentTopic) {
                    topicName = currentTopic.name;
                }
            }

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
                    // 克隆节点，移除思维链气泡后再取文本（<think> 已渲染为 DOM 节点）
                    const contentClone = contentElement.cloneNode(true);
                    contentClone.querySelectorAll('.vcp-thought-chain-bubble').forEach(el => el.remove());
                    let content = contentClone.innerText || contentClone.textContent || "";
                    // 兜底：仅清理起止标签分别独占一行的明文思维链。
                    content = content.replace(/^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*\r?\n[\s\S]*?^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm, '');
                    content = content.replace(/^[ \t]*<think(?:ing)?>[ \t]*\r?\n[\s\S]*?^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim, '');
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

            const result = await chatAPI.exportTopicAsMarkdown({
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

    /**
     * Handles the continue writing functionality.
     * @param {string} additionalPrompt - Additional prompt text from the input box.
     */
    async function handleContinueWriting(additionalPrompt = '') {
        console.log('[ContinueWriting] 开始执行续写功能，附加提示词:', additionalPrompt);

        const currentSelectedItem = refs.currentSelectedItem.get();
        const currentTopicId = refs.currentTopicId.get();
        const globalSettings = refs.globalSettings.get();
        const currentChatHistory = refs.currentChatHistory.get();

        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
            return;
        }

        if (!globalSettings.vcpServerUrl) {
            uiHelperFunctions.showToastNotification('请先在全局设置中配置VCP服务器URL！', 'error');
            uiHelperFunctions.openModal('globalSettingsModal');
            return;
        }

        if (currentSelectedItem.type === 'group') {
            uiHelperFunctions.showToastNotification('群组聊天暂不支持续写功能', 'warning');
            return;
        }

        const lastAiMessage = [...currentChatHistory].reverse().find(msg => msg.role === 'assistant' && !msg.isThinking);

        // 改进：即使没有AI消息，也允许续写（让当前Agent开始发言）
        // 区分两种情况：
        // 1. 有AI消息：使用续写提示词（附加提示词或默认续写提示词）
        // 2. 无AI消息：如果有附加提示词则使用，否则直接让AI开始对话（不添加额外提示）
        let temporaryPrompt;
        if (!lastAiMessage) {
            console.log('[ContinueWriting] 没有找到AI消息，让当前Agent开始发言');
            // 如果有附加提示词，使用附加提示词；否则不添加提示词（让AI基于现有上下文自然开始）
            temporaryPrompt = additionalPrompt || '';
        } else {
            // 有AI消息时，使用续写逻辑：优先使用附加提示词，否则使用默认续写提示词
            temporaryPrompt = additionalPrompt || globalSettings.continueWritingPrompt || '请继续';
        }

        const thinkingMessageId = `regen_${Date.now()}`;
        const thinkingMessage = {
            role: 'assistant',
            name: currentSelectedItem.name || currentSelectedItem.id || 'AI',
            content: '续写中...',
            timestamp: Date.now(),
            id: thinkingMessageId,
            isThinking: true,
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };

        currentChatHistory.push(thinkingMessage);

        try {
            const agentConfig = currentSelectedItem.config || currentSelectedItem;
            let historySnapshotForVCP = currentChatHistory.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);

            // 只有当有提示词时才添加临时用户消息
            // 如果 temporaryPrompt 为空，说明是无AI消息且无输入的情况，让AI基于现有上下文自然开始
            if (temporaryPrompt && temporaryPrompt.trim()) {
                const temporaryUserMessage = { role: 'user', content: temporaryPrompt };
                historySnapshotForVCP = [...historySnapshotForVCP, temporaryUserMessage];
            }

            const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
                let currentMessageTextContent = '';
                if (typeof msg.content === 'string') {
                    currentMessageTextContent = msg.content;
                } else if (msg.content && typeof msg.content === 'object') {
                    if (typeof msg.content.text === 'string') {
                        currentMessageTextContent = msg.content.text;
                    } else if (Array.isArray(msg.content)) {
                        currentMessageTextContent = msg.content
                            .filter(item => item.type === 'text' && item.text)
                            .map(item => item.text)
                            .join('\n');
                    }
                }
                return { role: msg.role, content: currentMessageTextContent };
            }));

            if (agentConfig && agentConfig.systemPrompt) {
                let systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentSelectedItem.id);
                const prependedContent = [];

                if (agentConfig.agentDataPath && currentTopicId) {
                    const historyPath = `${agentConfig.agentDataPath}\\topics\\${currentTopicId}\\history.json`;
                    prependedContent.push(`当前聊天记录文件路径: ${historyPath}`);
                }

                if (agentConfig.topics && currentTopicId) {
                    const currentTopicObj = agentConfig.topics.find(t => t.id === currentTopicId);
                    if (currentTopicObj && currentTopicObj.createdAt) {
                        const date = new Date(currentTopicObj.createdAt);
                        const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        prependedContent.push(`当前话题创建于: ${formattedDate}`);
                    }
                }

                if (prependedContent.length > 0) {
                    systemPromptContent = prependedContent.join('\n') + '\n\n' + systemPromptContent;
                }

                messagesForVCP.unshift({ role: 'system', content: systemPromptContent });
            }

            const useStreaming = (agentConfig?.streamOutput !== false);
            const modelConfigForVCP = {
                model: agentConfig?.model || 'gemini-pro',
                temperature: agentConfig?.temperature !== undefined ? parseFloat(agentConfig.temperature) : 0.7,
                ...(agentConfig?.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
                ...(agentConfig?.contextTokenLimit && { contextTokenLimit: parseInt(agentConfig.contextTokenLimit) }),
                stream: useStreaming
            };

            const context = {
                agentId: currentSelectedItem.id,
                agentName: currentSelectedItem.name || currentSelectedItem.id,
                topicId: currentTopicId,
                isGroupMessage: false,
                avatarUrl: currentSelectedItem.avatarUrl,
                avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
            };

            const vcpResponse = await chatAPI.sendToVCP(
                globalSettings.vcpServerUrl,
                globalSettings.vcpApiKey,
                messagesForVCP,
                modelConfigForVCP,
                thinkingMessage.id,
                false,
                context
            );

            if (!useStreaming) {
                const { response, context } = vcpResponse;
                const isForActiveChat = context && context.agentId === currentSelectedItem.id && context.topicId === currentTopicId;

                if (isForActiveChat) {
                    messageRenderer?.removeMessageById(thinkingMessage.id);
                }

                if (response.error) {
                    if (isForActiveChat && messageRenderer) {
                        messageRenderer.renderMessage({ role: 'system', content: `VCP错误: ${response.error}`, timestamp: Date.now() });
                    }
                    console.error(`[ContinueWriting] VCP Error:`, response.error);
                } else if (response.choices && response.choices.length > 0) {
                    const assistantMessageContent = response.choices[0].message.content;
                    const assistantMessage = {
                        role: 'assistant',
                        name: context.agentName || context.agentId || 'AI',
                        avatarUrl: currentSelectedItem.avatarUrl,
                        avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor,
                        content: assistantMessageContent,
                        timestamp: Date.now(),
                        id: response.id || `regen_nonstream_${Date.now()}`
                    };

                    const historyForSave = await chatAPI.getChatHistory(context.agentId, context.topicId);
                    if (historyForSave && !historyForSave.error) {
                        const finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);
                        finalHistory.push(assistantMessage);
                        await historyMutationAuthority.replace({
                            itemId: context.agentId, itemType: 'agent', topicId: context.topicId,
                            category: 'flowlock-non-stream-terminal',
                        }, finalHistory);

                        if (isForActiveChat) {
                            currentChatHistory.length = 0;
                            currentChatHistory.push(...finalHistory);
                            messageRenderer?.renderMessage(assistantMessage);
                            await chatManager.attemptTopicSummarizationIfNeeded();
                        }
                    }
                }
            } else {
                if (vcpResponse && vcpResponse.streamError) {
                    console.error("[ContinueWriting] Streaming setup failed:", vcpResponse.errorDetail || vcpResponse.error);
                }
            }

        } catch (error) {
            console.error('[ContinueWriting] 续写时出错:', error);
            messageRenderer?.removeMessageById(thinkingMessage.id);
            messageRenderer?.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
            if (currentSelectedItem.id && currentTopicId) {
                await historyMutationAuthority.replace({
                    itemId: currentSelectedItem.id, itemType: currentSelectedItem.type, topicId: currentTopicId,
                    category: 'flowlock-failure-cleanup',
                }, currentChatHistory.filter(msg => !msg.isThinking));
            }
        }
    }

    // 导出到window对象供Flowlock使用
    window.handleContinueWriting = handleContinueWriting;

    if (chatMessagesDiv) {
        addListener(chatMessagesDiv, 'click', (event) => {
            // Stop TTS playback when clicking a speaking avatar
            const avatar = event.target.closest('.chat-avatar');
            if (avatar && avatar.classList.contains('speaking')) {
                console.log('[UI] Speaking avatar clicked. Requesting TTS stop via sovitsStop.');
                event.preventDefault();
                event.stopPropagation();
                if (chatAPI?.sovitsStop) {
                    // This sends the stop request to the main process
                    chatAPI.sovitsStop();
                }
                return;
            }

            // Handle external links
            const target = event.target.closest('a');
            if (target && target.href) {
                const href = target.href;
                event.preventDefault(); // Prevent default navigation for all links within chat

                if (href.startsWith('#')) { // Internal page anchors
                    console.log('Internal anchor link clicked:', href);
                    return;
                }
                if (href.toLowerCase().startsWith('javascript:')) {
                    console.warn('JavaScript link clicked, ignoring.');
                    return;
                }
                if (href.startsWith('http:') || href.startsWith('https:') || href.startsWith('file:') || href.startsWith('magnet:')) {
                    if (chatAPI?.sendOpenExternalLink) {
                        chatAPI.sendOpenExternalLink(href);
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

    addListener(sendMessageBtn, 'click', async () => {
        if (typeof sendButtonAction === 'function') {
            await sendButtonAction();
            return;
        }
        chatManager.handleSendMessage();
    });

    // 发送按钮右键 - 打开「高级回复」(VCPChatTarven) 浮窗
    addListener(sendMessageBtn, 'contextmenu', (e) => {
        e.preventDefault();
        if (window.TavernManager && typeof window.TavernManager.togglePopover === 'function') {
            window.TavernManager.togglePopover(sendMessageBtn);
        } else {
            console.warn('[EventListeners] TavernManager not available.');
        }
    });
    addListener(messageInput, 'keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatManager.handleSendMessage();
        }
    });
    addListener(messageInput, 'input', () => uiHelperFunctions.autoResizeTextarea(messageInput));

    addListener(messageInput, 'mousedown', async (e) => {
        if (e.button === 1) { // 中键
            e.preventDefault();
            e.stopPropagation();

            const currentSelectedItem = refs.currentSelectedItem.get();

            // 只限制当前 Agent；其他 Agent 的后台心流不影响本界面手动续写。
            if (window.flowlockManager?.isAgentLocked?.(currentSelectedItem?.id)) {
                uiHelperFunctions.showToastNotification('当前 Agent 已启用心流锁，无法手动续写', 'warning');
                return;
            }
            const currentTopicId = refs.currentTopicId.get();
            if (!currentSelectedItem.id || !currentTopicId) {
                uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
                return;
            }

            const currentInputText = messageInput.value.trim();
            await handleContinueWriting(currentInputText);
        }
    });

    addListener(attachFileBtn, 'click', async () => {
        const currentSelectedItem = refs.currentSelectedItem.get();
        const currentTopicId = refs.currentTopicId.get();
        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelperFunctions.showToastNotification("请先选择一个项目和话题以上传附件。", 'error');
            return;
        }
        const result = await chatAPI.selectFilesToSend(currentSelectedItem.id, currentTopicId);

        if (result && result.success && result.attachments && result.attachments.length > 0) {
            result.attachments.forEach(att => {
                if (att.error) {
                    console.error(`Error processing selected file ${att.name || 'unknown'}: ${att.error}`);
                    uiHelperFunctions.showToastNotification(`处理文件 ${att.name || '未知文件'} 失败: ${att.error}`, 'error');
                } else {
                    refs.attachedFiles.append({
                        file: { name: att.name, type: att.type, size: att.size },
                        localPath: att.internalPath,
                        originalName: att.name,
                        _fileManagerData: att
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

    // The modal is template-backed.  Do not rely solely on its one-time
    // `modal-ready` event: an early open can otherwise leave the existing
    // form without a submit listener, making the Save button appear inert.
    function bindGlobalSettingsModal() {
        const modal = document.getElementById('globalSettingsModal');
        if (!modal) return;
        const closeButton = modal.querySelector('.close-button');
        if (closeButton && !closeButton.dataset.closeBound) {
            closeButton.addEventListener('click', () => uiHelperFunctions.closeModal('globalSettingsModal'));
            closeButton.dataset.closeBound = 'true';
        }

        const form = modal.querySelector('#globalSettingsForm');
        if (form && !form.dataset.globalSettingsSaveBound) {
            form.addEventListener('submit', (ev) => {
                Promise.resolve(handleSaveGlobalSettings(ev, deps)).catch((error) => {
                    console.error('[GlobalSettings] Unexpected save failure:', error);
                    // `handleSaveGlobalSettings` owns the terminal failure
                    // event contract. This catch only reports the error to
                    // the user; dispatching here would duplicate retry state.
                    uiHelperFunctions.showToastNotification(`保存全局设置失败: ${error?.message || error}`, 'error');
                });
            });
            form.dataset.globalSettingsSaveBound = 'true';
        }

        const addPathBtn = modal.querySelector('#addNetworkPathBtn');
        if (addPathBtn && !addPathBtn.dataset.globalSettingsBound) {
            addListener(addPathBtn, 'click', () => {
                if (window.VCPUISettingsBridge?.addNetworkPathInput?.()) return;
                addNetworkPathInput();
            });
            addPathBtn.dataset.globalSettingsBound = 'true';
        }

        const avatarInput = modal.querySelector('#userAvatarInput');
        if (avatarInput && !avatarInput.dataset.globalSettingsBound) {
            setupUserAvatarListener(avatarInput);
            avatarInput.dataset.globalSettingsBound = 'true';
        }

        const resetBtn = modal.querySelector('#resetUserAvatarColorsBtn');
        if (resetBtn && !resetBtn.dataset.globalSettingsBound) {
            setupResetUserColorsListener(resetBtn);
            resetBtn.dataset.globalSettingsBound = 'true';
        }

        if (!modal.dataset.globalSettingsControlsBound) {
            // Generated ColorPair owns the production mirror listeners. Keep
            // the legacy binder only for bootstrap environments without the
            // UIUX artifact, avoiding duplicate writes in the real surface.
            if (!window.VCPUIUX?.mountColorPair) setupColorSyncListeners();
            setupRustAssistantConfigListeners();
            modal.dataset.globalSettingsControlsBound = 'true';
        }
        // The modal is cloned after startup; explicitly reapply the loaded
        // settings snapshot so the persisted avatar is restored on every open.
        Promise.resolve(typeof syncSettingsToUI === 'function' ? syncSettingsToUI() : undefined).catch(error => {
            console.warn('[GlobalSettings] Failed to sync modal snapshot:', error);
        });
    }

    const openGlobalSettings = () => {
        uiHelperFunctions.openModal('globalSettingsModal');
        bindGlobalSettingsModal();
    };
    // Classic settings and the Next UI account dock are two visual entry
    // points for one shared settings surface. Keep their lifecycle identical
    // instead of letting the redesigned shell expose an inert gear button.
    [globalSettingsBtn, document.getElementById('nextUiAccountSettingsBtn')]
        .filter(Boolean)
        .forEach((trigger) => {
            if (trigger.dataset.globalSettingsOpenBound) return;
            trigger.addEventListener('click', openGlobalSettings);
            trigger.dataset.globalSettingsOpenBound = 'true';
        });

    document.addEventListener('modal-ready', (e) => {
        if (e.detail?.modalId === 'globalSettingsModal') bindGlobalSettingsModal();
    });
    window.addEventListener('global-settings-updated', (event) => {
        const preview = document.getElementById('userAvatarPreview');
        if (!preview) return;
        const avatarUrl = String(event.detail?.settings?.userAvatarUrl || '');
        preview.src = avatarUrl || 'assets/default_user_avatar.png';
        preview.style.display = 'block';
        preview.closest('.agent-avatar-wrapper')?.classList.toggle('no-avatar', !avatarUrl);
    });

    function setupUserAvatarListener(input) {
        input.addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (file) {
                uiHelperFunctions.openAvatarCropper(file, (croppedFile) => {
                    setCroppedFile('user', croppedFile);
                    const userAvatarPreview = document.getElementById('userAvatarPreview');
                    if (userAvatarPreview) {
                        const previewUrl = URL.createObjectURL(croppedFile);
                        userAvatarPreview.src = previewUrl;
                        userAvatarPreview.style.display = 'block';

                        if (window.getDominantAvatarColor) {
                            window.getDominantAvatarColor(previewUrl).then((avgColor) => {
                                const userAvatarBorderColorInput = document.getElementById('userAvatarBorderColor');
                                const userAvatarBorderColorTextInput = document.getElementById('userAvatarBorderColorText');
                                const userNameTextColorInput = document.getElementById('userNameTextColor');
                                const userNameTextColorTextInput = document.getElementById('userNameTextColorText');

                                if (avgColor && userAvatarBorderColorInput && userNameTextColorInput) {
                                    const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                                    if (rgbMatch) {
                                        const r = parseInt(rgbMatch[1]);
                                        const g = parseInt(rgbMatch[2]);
                                        const b = parseInt(rgbMatch[3]);
                                        const hexColor = '#' + [r, g, b].map(x => {
                                            const hex = x.toString(16);
                                            return hex.length === 1 ? '0' + hex : hex;
                                        }).join('');

                                        userAvatarBorderColorInput.value = hexColor;
                                        userAvatarBorderColorTextInput.value = hexColor;
                                        userNameTextColorInput.value = hexColor;
                                        userNameTextColorTextInput.value = hexColor;
                                        userAvatarPreview.style.borderColor = hexColor;
                                    }
                                }
                            }).catch(err => console.error('[EventListeners] Error extracting user avatar color:', err));
                        }
                    }
                }, 'user');
            } else {
                const userAvatarPreview = document.getElementById('userAvatarPreview');
                if (userAvatarPreview) userAvatarPreview.style.display = 'none';
                setCroppedFile('user', null);
            }
        });
    }

    function setupResetUserColorsListener(btn) {
        btn.addEventListener('click', () => {
            const userAvatarPreview = document.getElementById('userAvatarPreview');
            if (!userAvatarPreview || !userAvatarPreview.src || userAvatarPreview.src.includes('default_user_avatar.png')) {
                uiHelperFunctions.showToastNotification('请先上传头像后再重置颜色', 'warning');
                return;
            }
            if (window.getDominantAvatarColor) {
                window.getDominantAvatarColor(userAvatarPreview.src).then((avgColor) => {
                    const borderColorInput = document.getElementById('userAvatarBorderColor');
                    const nameColorInput = document.getElementById('userNameTextColor');
                    if (avgColor && borderColorInput && nameColorInput) {
                        const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                        if (rgbMatch) {
                            const r = parseInt(rgbMatch[1]), g = parseInt(rgbMatch[2]), b = parseInt(rgbMatch[3]);
                            const hexColor = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
                            borderColorInput.value = hexColor;
                            document.getElementById('userAvatarBorderColorText').value = hexColor;
                            nameColorInput.value = hexColor;
                            document.getElementById('userNameTextColorText').value = hexColor;
                            userAvatarPreview.style.borderColor = hexColor;
                            uiHelperFunctions.showToastNotification('已重置为头像默认颜色', 'success');
                        }
                    }
                });
            }
        });
    }

    function setupColorSyncListeners() {
        const sync = (pickerId, textId, previewId) => {
            const picker = document.getElementById(pickerId);
            const text = document.getElementById(textId);
            const preview = previewId ? document.getElementById(previewId) : null;
            if (picker && text) {
                picker.addEventListener('input', (e) => {
                    text.value = e.target.value;
                    if (preview) preview.style.borderColor = e.target.value;
                });
                text.addEventListener('input', (e) => {
                    if (/^#[0-9A-F]{6}$/i.test(e.target.value)) {
                        picker.value = e.target.value;
                        if (preview) preview.style.borderColor = e.target.value;
                    }
                });
            }
        };
        sync('userAvatarBorderColor', 'userAvatarBorderColorText', 'userAvatarPreview');
        sync('userNameTextColor', 'userNameTextColorText');
    }

    // Rust助手配置UI交互处理
    async function setupRustAssistantConfigListeners() {
        // 首先加载当前的Rust配置并填充表单
        await loadAndPopulateRustConfig();

        // When the typed Settings consumer is active it owns the Rust section
        // projection and its lifecycle-bound visibility listeners. Keep this
        // legacy binder exclusively for Classic/early-bootstrap fallback.
        if (window.VCPUISettingsBridge?.getRustAssistantService?.()) return;

        // The flattened Rust rows own their visibility via data-visible-when
        // (rustUseAssistant / rustEnableCustomThresholds / rustRuleMode /
        // rustDebugMode clauses).  This fallback binder re-evaluates them with
        // the shared evaluator; the typed owner runs the same projection when
        // it is active (this binder exits above in that case).
        const rustForm = document.getElementById('globalSettingsForm');
        if (rustForm) {
            const syncRustRows = () => syncDependentRows(rustForm);
            for (const rustSourceId of ['rustUseAssistant', 'rustEnableCustomThresholds', 'rustRuleMode', 'rustDebugMode']) {
                document.getElementById(rustSourceId)?.addEventListener('change', syncRustRows);
            }
            // 初始化时设置一次
            syncRustRows();
        }
    }

    async function loadAndPopulateRustConfig() {
        try {
            if (!chatAPI) {
                console.warn('[EventListeners] electronAPI not available, skipping rust config load');
                return;
            }

            // Rust Assistant UI projection is owned by the scoped typed
            // adapter when the SettingsRoot is mounted. Keep this loader as
            // the compatibility fallback for Classic/early bootstrap paths,
            // but never let it overwrite the production typed consumer.
            if (window.VCPUISettingsBridge?.getRustAssistantService?.()) return;

            const result = await chatAPI.getRustAssistantConfig?.() || {};
            if (result.error) {
                console.warn('[EventListeners] Failed to load rust config:', result.error);
                return;
            }

            // 填充基本开关
            const rustUseAssistantCheckbox = document.getElementById('rustUseAssistant');
            const rustDebugModeCheckbox = document.getElementById('rustDebugMode');

            if (rustUseAssistantCheckbox) rustUseAssistantCheckbox.checked = result.useRustAssistant === true;
            if (rustDebugModeCheckbox) rustDebugModeCheckbox.checked = result.debugMode === true;

            // 填充自定义阈值
            const hasCustomThresholds = result.runtimeThresholds &&
                (result.runtimeThresholds.minEventIntervalMs !== 80 ||
                    result.runtimeThresholds.minDistance !== 0 ||
                    result.runtimeThresholds.screenshotSuspendMs !== 3000 ||
                    result.runtimeThresholds.clipboardConflictSuspendMs !== 1000 ||
                    result.runtimeThresholds.clipboardCheckIntervalMs !== 500);

            const rustEnableCustomThresholdsCheckbox = document.getElementById('rustEnableCustomThresholds');
            const rustCustomThresholdsPanel = document.getElementById('rustCustomThresholdsPanel');
            
            if (rustEnableCustomThresholdsCheckbox) {
                rustEnableCustomThresholdsCheckbox.checked = hasCustomThresholds;
            }
            
            // 根据开关状态更新面板显示
            if (rustCustomThresholdsPanel) {
                rustCustomThresholdsPanel.style.display = hasCustomThresholds ? 'block' : 'none';
            }

            if (result.runtimeThresholds) {
                const minEventIntervalMs = document.getElementById('rustMinEventIntervalMs');
                const minDistance = document.getElementById('rustMinDistance');
                const screenshotSuspendMs = document.getElementById('rustScreenshotSuspendMs');
                const clipboardConflictSuspendMs = document.getElementById('rustClipboardConflictSuspendMs');
                const clipboardCheckIntervalMs = document.getElementById('rustClipboardCheckIntervalMs');

                if (minEventIntervalMs) minEventIntervalMs.value = result.runtimeThresholds.minEventIntervalMs || 80;
                if (minDistance) minDistance.value = result.runtimeThresholds.minDistance || 0;
                if (screenshotSuspendMs) screenshotSuspendMs.value = result.runtimeThresholds.screenshotSuspendMs || 3000;
                if (clipboardConflictSuspendMs) clipboardConflictSuspendMs.value = result.runtimeThresholds.clipboardConflictSuspendMs || 1000;
                if (clipboardCheckIntervalMs) clipboardCheckIntervalMs.value = result.runtimeThresholds.clipboardCheckIntervalMs || 500;
            }

            // 填充规则选择
            const rustRuleModeSelect = document.getElementById('rustRuleMode');
            const rustWhitelistPanel = document.getElementById('rustWhitelistPanel');
            const rustBlacklistPanel = document.getElementById('rustBlacklistPanel');
            
            let ruleMode = 'none';
            if (result.whitelist && result.whitelist.length > 0) {
                ruleMode = 'whitelist';
            } else if (result.blacklist && result.blacklist.length > 0) {
                ruleMode = 'blacklist';
            }

            if (rustRuleModeSelect) {
                rustRuleModeSelect.value = ruleMode;
            }

            // 根据规则模式更新面板显示
            if (rustWhitelistPanel && rustBlacklistPanel) {
                rustWhitelistPanel.style.display = ruleMode === 'whitelist' ? 'block' : 'none';
                rustBlacklistPanel.style.display = ruleMode === 'blacklist' ? 'block' : 'none';
            }

            // 填充白名单和黑名单
            const rustWhitelistKeywords = document.getElementById('rustWhitelistKeywords');
            const rustBlacklistKeywords = document.getElementById('rustBlacklistKeywords');
            const rustScreenshotApps = document.getElementById('rustScreenshotApps');

            if (rustWhitelistKeywords && result.whitelist && Array.isArray(result.whitelist)) {
                rustWhitelistKeywords.value = result.whitelist.join('\n');
            }
            if (rustBlacklistKeywords && result.blacklist && Array.isArray(result.blacklist)) {
                rustBlacklistKeywords.value = result.blacklist.join('\n');
            }
            if (rustScreenshotApps && result.screenshotApps && Array.isArray(result.screenshotApps)) {
                rustScreenshotApps.value = result.screenshotApps.join('\n');
            }

            console.log('[EventListeners] Rust config loaded and form populated successfully');
        } catch (error) {
            console.error('[EventListeners] Error loading rust config:', error);
        }
    }

    // 用户重置颜色按钮
    const resetUserAvatarColorsBtn = document.getElementById('resetUserAvatarColorsBtn');
    if (resetUserAvatarColorsBtn) {
        resetUserAvatarColorsBtn.addEventListener('click', () => {
            const userAvatarPreview = document.getElementById('userAvatarPreview');

            if (!userAvatarPreview || !userAvatarPreview.src || userAvatarPreview.src === '#' || userAvatarPreview.src.includes('default_user_avatar.png')) {
                uiHelperFunctions.showToastNotification('请先上传头像后再重置颜色', 'warning');
                return;
            }

            if (window.getDominantAvatarColor) {
                window.getDominantAvatarColor(userAvatarPreview.src).then((avgColor) => {
                    if (avgColor && userAvatarBorderColorInput && userNameTextColorInput) {
                        const rgbMatch = avgColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                        if (rgbMatch) {
                            const r = parseInt(rgbMatch[1]);
                            const g = parseInt(rgbMatch[2]);
                            const b = parseInt(rgbMatch[3]);
                            const hexColor = '#' + [r, g, b].map(x => {
                                const hex = x.toString(16);
                                return hex.length === 1 ? '0' + hex : hex;
                            }).join('');

                            userAvatarBorderColorInput.value = hexColor;
                            userAvatarBorderColorTextInput.value = hexColor;
                            userNameTextColorInput.value = hexColor;
                            userNameTextColorTextInput.value = hexColor;
                            userAvatarPreview.style.borderColor = hexColor;

                            uiHelperFunctions.showToastNotification('已重置为头像默认颜色', 'success');
                            console.log('[EventListeners] User colors reset to avatar default:', hexColor);
                        }
                    } else {
                        uiHelperFunctions.showToastNotification('无法从头像提取颜色', 'error');
                    }
                }).catch(err => {
                    console.error('[EventListeners] Error extracting user avatar color:', err);
                    uiHelperFunctions.showToastNotification('提取颜色时出错', 'error');
                });
            } else {
                uiHelperFunctions.showToastNotification('颜色提取功能不可用', 'error');
            }
        });
    }

    currentItemActionBtn.addEventListener('click', async () => {
        const currentSelectedItem = refs.currentSelectedItem.get();
        if (!currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification("请先选择一个项目。", 'error');
            return;
        }
        await chatManager.createNewTopicForItem(currentSelectedItem.id, currentSelectedItem.type);
    });

    // 【新建话题】按钮右键菜单 - 创建未锁定话题
    currentItemActionBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();

        const currentSelectedItem = refs.currentSelectedItem.get();
        if (!currentSelectedItem.id || currentSelectedItem.type !== 'agent') {
            return; // 仅对 Agent 显示右键菜单
        }

        showNewTopicButtonMenu(e, currentSelectedItem);
    });

    /**
     * 显示【新建话题】按钮的右键菜单
     */
    function showNewTopicButtonMenu(event, currentSelectedItem) {
        // 移除已存在的菜单
        const existingMenu = document.getElementById('newTopicContextMenu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.id = 'newTopicContextMenu';
        menu.classList.add('context-menu');
        menu.style.top = `${event.clientY}px`;
        menu.style.left = `${event.clientX}px`;

        // 点击外部关闭菜单
        const closeMenu = (e) => {
            if (!e || !menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu, true);
            }
        };

        // 新建无锁话题选项
        const createUnlockedOption = document.createElement('div');
        createUnlockedOption.classList.add('context-menu-item');
        createUnlockedOption.innerHTML = `<i class="fas fa-unlock"></i> 新建无锁话题`;
        createUnlockedOption.onclick = async () => {
            closeMenu();
            await createNewTopicWithLockStatus(currentSelectedItem, false);
        };
        menu.appendChild(createUnlockedOption);

        document.body.appendChild(menu);

        setOwnedTimeout(() => {
            addListener(document, 'click', closeMenu, true);
        }, 0);
    }

    /**
     * 创建指定锁定状态的话题
     * 通过扩展后端 API 来创建带指定锁定状态的话题，然后使用 chatManager 的标准流程切换到该话题
     */
    async function createNewTopicWithLockStatus(currentSelectedItem, locked = true) {
        if (!currentSelectedItem.id) {
            uiHelperFunctions.showToastNotification("请先选择一个Agent。", 'error');
            return;
        }

        const newTopicName = `新话题 ${new Date().toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        })}`;

        try {
            // 调用后端 API 创建话题，传入 locked 参数
            const result = await chatAPI.createNewTopicForAgent(
                currentSelectedItem.id,
                newTopicName,
                false, // isBranch
                locked // 指定锁定状态
            );

            if (result && result.success && result.topicId) {
                // 使用 chatManager 的 selectTopic 方法来切换到新创建的话题
                // 这会触发所有必要的状态更新、UI刷新和文件监听器启动
                if (chatManager && chatManager.selectTopic) {
                    await chatManager.selectTopic(result.topicId);
                }

                // 关键修复：在切换话题后，强制刷新话题列表UI
                if (topicListManager && topicListManager.loadTopicList) {
                    await topicListManager.loadTopicList();
                }

                uiHelperFunctions.showToastNotification(
                    locked ? '已创建新话题（已锁定）' : '已创建新话题（未锁定，AI可查看）',
                    'success'
                );
            } else {
                uiHelperFunctions.showToastNotification(`创建新话题失败: ${result ? result.error : '未知错误'}`, 'error');
            }
        } catch (error) {
            console.error('创建话题时出错:', error);
            uiHelperFunctions.showToastNotification(`创建话题时出错: ${error.message}`, 'error');
        }
    }

    /* Notification quick actions are owned by NextShell's
     * NotificationMenuController. Keeping a second document-level binding
     * here causes every command and Escape action to run twice. */
    const nextUiNotificationMenuBtn = null;
    /*
    const nextUiNotificationMenu = document.getElementById('nextUiNotificationMenu');
    const nextUiNotificationForum = document.getElementById('nextUiNotificationForum');
    const nextUiNotificationMemo = document.getElementById('nextUiNotificationMemo');
    const nextUiNotificationFilterToggle = document.getElementById('nextUiNotificationFilterToggle');
    const nextUiNotificationFilterState = document.getElementById('nextUiNotificationFilterState');
    const nextUiNotificationClear = document.getElementById('nextUiNotificationClear');
    if (
        nextUiNotificationMenuBtn
        && nextUiNotificationMenu
        && nextUiNotificationForum
        && nextUiNotificationMemo
        && nextUiNotificationFilterToggle
        && nextUiNotificationFilterState
        && nextUiNotificationClear
    ) {
        const syncNotificationFilterState = (state = null) => {
            const isActive = typeof state?.enabled === 'boolean' ? state.enabled : window.filterManager?.isFilterEnabled?.() === true;
            nextUiNotificationFilterToggle.setAttribute('aria-checked', String(isActive));
            nextUiNotificationFilterState.textContent = isActive ? '开启' : '关闭';
        };

        const closeNotificationMenu = ({ restoreFocus = false } = {}) => {
            if (nextUiNotificationMenu.hidden) return;
            nextUiNotificationMenu.hidden = true;
            nextUiNotificationMenuBtn.setAttribute('aria-expanded', 'false');
            if (restoreFocus) nextUiNotificationMenuBtn.focus();
        };

        const openNotificationMenu = () => {
            syncNotificationFilterState();
            nextUiNotificationMenu.hidden = false;
            nextUiNotificationMenuBtn.setAttribute('aria-expanded', 'true');
            nextUiNotificationForum.focus();
        };

        nextUiNotificationMenuBtn.addEventListener('click', () => {
            if (nextUiNotificationMenu.hidden) {
                openNotificationMenu();
            } else {
                closeNotificationMenu();
            }
        });

        const runMenuAction = async (action, { restoreFocus = true } = {}) => {
            try {
                return await action?.();
            } catch (error) {
                console.warn('[Notifications] Menu action failed:', error);
                uiHelperFunctions.showToastNotification(`通知操作失败：${error.message}`, 'error');
                return { success: false, error: error.message };
            } finally {
                syncNotificationFilterState();
                closeNotificationMenu({ restoreFocus });
            }
        };

        nextUiNotificationForum.addEventListener('click', () => {
            void runMenuAction(() => window.MainChatCommands?.openForum?.());
        });
        nextUiNotificationMemo.addEventListener('click', () => {
            void runMenuAction(() => window.MainChatCommands?.openMemo?.());
        });

        nextUiNotificationFilterToggle.addEventListener('click', () => {
            void runMenuAction(() => window.MainChatCommands?.toggleNotificationFilter?.());
        });
        nextUiNotificationFilterToggle.addEventListener('contextmenu', event => {
            event.preventDefault();
            void runMenuAction(() => window.MainChatCommands?.openNotificationFilterSettings?.(), {
                restoreFocus: false
            });
        });

        nextUiNotificationClear.addEventListener('click', () => {
            void runMenuAction(() => window.MainChatCommands?.clearNotifications?.());
        });

        document.addEventListener('pointerdown', (event) => {
            if (
                !nextUiNotificationMenu.hidden
                && !nextUiNotificationMenu.contains(event.target)
                && !nextUiNotificationMenuBtn.contains(event.target)
            ) {
                closeNotificationMenu();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !nextUiNotificationMenu.hidden) {
                event.preventDefault();
                closeNotificationMenu({ restoreFocus: true });
            }
        });

        document.addEventListener('next-ui-overlay-changed', (event) => {
            if (event.detail?.active === true) closeNotificationMenu();
        });

        nextUiNotificationMenu.addEventListener('keydown', (event) => {
            if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                && document.activeElement === nextUiNotificationFilterToggle) {
                event.preventDefault();
                document.activeElement.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    button: 2
                }));
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

            const menuItems = [...nextUiNotificationMenu.querySelectorAll('[role^="menuitem"]')];
            const currentIndex = menuItems.indexOf(document.activeElement);
            let nextIndex = currentIndex;

            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = menuItems.length - 1;
            if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % menuItems.length;
            if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;

            event.preventDefault();
            menuItems[nextIndex]?.focus();
        });

        if (window.filterManager?.subscribe) {
        // State-channel subscriptions are lifecycle resources too. Keep the
        // disposer with the main renderer owner so a remount/reload cannot
        // retain a callback closed over stale settings refs.
        listenerOwner?.own(window.filterManager.subscribe(syncNotificationFilterState));
        } else {
            window.addEventListener('notification-filter-changed', event => syncNotificationFilterState(event.detail));
            syncNotificationFilterState();
        }
    }
    */

    if (openTranslatorBtn) {
        openTranslatorBtn.addEventListener('click', async () => {
            if (chatAPI?.openTranslatorWindow) {
                await chatAPI.openTranslatorWindow();
            } else {
                console.warn('[Renderer] electronAPI.openTranslatorWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开翻译助手：功能不可用。', 'error');
            }
        });
    }

    if (openNotesBtn) {
        openNotesBtn.addEventListener('click', async () => {
            if (chatAPI?.openNotesWindow) {
                await chatAPI.openNotesWindow();
            } else {
                console.warn('[Renderer] electronAPI.openNotesWindow is not available.');
                uiHelperFunctions.showToastNotification('无法打开笔记：功能不可用。', 'error');
            }
        });
    }

    if (openMusicBtn) {
        openMusicBtn.addEventListener('click', () => {
            if (chatAPI?.openMusicWindow) {
                chatAPI.openMusicWindow();
            } else {
                console.error('Music Player: electronAPI.openMusicWindow not found.');
            }
        });
    }

    if (openCanvasBtn) {
        openCanvasBtn.addEventListener('click', () => {
            if (chatAPI?.openCanvasWindow) {
                chatAPI.openCanvasWindow();
            } else {
                console.error('Canvas: electronAPI.openCanvasWindow not found.');
            }
        });
    }

    if (toggleNotificationsBtn && notificationsSidebar) {
        const syncNotificationTogglePlacement = (isActive = notificationsSidebar.classList.contains('active')) => {
            const chatHost = document.getElementById('nextUiChatNotificationHost');
            const panelHost = document.getElementById('nextUiPanelNotificationHost');
            const targetHost = isActive ? panelHost : chatHost;
            if (targetHost && toggleNotificationsBtn.parentElement !== targetHost) {
                targetHost.append(toggleNotificationsBtn);
            }

            toggleNotificationsBtn.classList.toggle('notification-panel-active', isActive);
            toggleNotificationsBtn.setAttribute('aria-expanded', String(isActive));
            toggleNotificationsBtn.setAttribute('aria-label', isActive ? '关闭通知面板' : '打开通知面板');
            toggleNotificationsBtn.title = `${isActive ? '左键关闭通知面板' : '左键打开通知面板'}/右键监控面板`;
        };

        toggleNotificationsBtn.addEventListener('click', () => {
            chatAPI.sendToggleNotificationsSidebar();
        });

        toggleNotificationsBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (chatAPI?.openRAGObserverWindow) {
                chatAPI.openRAGObserverWindow();
            } else {
                console.error('electronAPI.openRAGObserverWindow is not defined!');
                uiHelperFunctions.showToastNotification('功能缺失: preload.js需要更新。', 'error');
            }
        });

        listenerOwner?.own(chatAPI.onDoToggleNotificationsSidebar(() => {
            const isActive = notificationsSidebar.classList.toggle('active');
            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.classList.toggle('notifications-sidebar-active', isActive);
            }
            if (isActive && refs.globalSettings.get().notificationsSidebarWidth) {
                notificationsSidebar.style.width = `${refs.globalSettings.get().notificationsSidebarWidth}px`;
            }
            syncNotificationTogglePlacement(isActive);
        }));

        syncNotificationTogglePlacement();
    }

    if (toggleAssistantBtn) {
        let longPressTimer;
        let wasLongPress = false;
        let sidebarLongPressTimer = null;
        let wasSidebarLongPress = false;

        const saveSidebarState = settings => {
            if (!chatAPI?.saveSettings) return;

            chatAPI.saveSettings(settings || refs.globalSettings.get()).then(result => {
                if (!result.success) {
                    console.error('保存侧边栏状态失败:', result.error);
                }
            }).catch(error => {
                console.error('保存侧边栏状态时出错:', error);
            });
        };

        const syncSidebarVisibility = (isActive) => {
            const mainContent = document.querySelector('.main-content');
            mainContent?.classList.toggle('sidebar-active', isActive);
            toggleSidebarBtn?.classList.toggle('active', isActive);
        };

        const setAvatarOnlyMode = (enabled) => {
            const target = leftSidebar;
            if (!target) return false;

            const agentsTabIsActive = document.getElementById('tabContentAgents')?.classList.contains('active');
            if (enabled && !agentsTabIsActive) return false;

            target.classList.toggle('avatar-only', enabled);
            toggleSidebarModeBtn?.classList.toggle('active', enabled);
            toggleSidebarModeBtn?.setAttribute('aria-pressed', String(enabled));
            if (enabled) {
                target.classList.add('active');
                syncSidebarVisibility(true);
            }

            const globalSettings = refs.globalSettings.get();
            const nextSettings = {
                ...globalSettings,
                sidebarAvatarOnly: enabled,
                sidebarActive: enabled ? true : globalSettings.sidebarActive,
            };
            refs.globalSettings.set(nextSettings);
            saveSidebarState(nextSettings);
            return true;
        };

        const toggleSidebarVisibility = () => {
            const target = leftSidebar;
            if (!target) return;
            target.classList.remove('avatar-only', 'compact-topics-open');
            document.getElementById('tabContentTopics')?.classList.remove('compact-drawer-open');
            toggleSidebarModeBtn?.classList.remove('active');
            toggleSidebarModeBtn?.setAttribute('aria-pressed', 'false');

            const isActive = target.classList.toggle('active');
            syncSidebarVisibility(isActive);

            const nextSettings = {
                ...refs.globalSettings.get(),
                sidebarActive: isActive,
                sidebarAvatarOnly: false,
            };
            refs.globalSettings.set(nextSettings);
            saveSidebarState(nextSettings);
            uiHelperFunctions.showToastNotification(`侧栏已${isActive ? '显示' : '隐藏'}`, 'info');
        };

        toggleAssistantBtn.title = '点击：开关划词助手｜长按：直接呼出';
        toggleAssistantBtn.setAttribute('aria-label', '划词助手开关与呼出');

        toggleAssistantBtn.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                wasLongPress = false;
                longPressTimer = setOwnedTimeout(() => {
                    console.log('[Assistant] Long press detected on toggle button');
                    chatAPI.assistantAction('open');
                    wasLongPress = true;
                    longPressTimer = null;
                }, 600);
            }
        });

        const clearLongPress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        };

        const clearSidebarLongPress = () => {
            if (sidebarLongPressTimer) {
                clearTimeout(sidebarLongPressTimer);
                sidebarLongPressTimer = null;
            }
        };

        toggleAssistantBtn.addEventListener('mouseup', (e) => {
            if (e.button === 0) clearLongPress();
        });
        toggleAssistantBtn.addEventListener('mouseleave', clearLongPress);

        toggleAssistantBtn.addEventListener('click', async () => {
            if (wasLongPress) {
                wasLongPress = false;
                return;
            }
            clearLongPress();

            const globalSettings = refs.globalSettings.get();
            const isActive = toggleAssistantBtn.classList.toggle('active');
            const nextSettings = { ...globalSettings, assistantEnabled: isActive };
            refs.globalSettings.set(nextSettings);
            chatAPI.toggleSelectionListener(isActive);
            const result = await chatAPI.saveSettings({
                ...nextSettings
            });
            if (result.success) {
                uiHelperFunctions.showToastNotification(`划词助手已${isActive ? '开启' : '关闭'}`, 'info');
            } else {
                uiHelperFunctions.showToastNotification(`设置划词助手状态失败: ${result.error}`, 'error');
                toggleAssistantBtn.classList.toggle('active', !isActive);
                refs.globalSettings.set({ ...globalSettings, assistantEnabled: !isActive });
            }
        });

        if (toggleSidebarModeBtn) {
            toggleSidebarModeBtn.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                wasSidebarLongPress = false;
                sidebarLongPressTimer = setOwnedTimeout(() => {
                    sidebarLongPressTimer = null;
                    if (!leftSidebar) return;

                    wasSidebarLongPress = true;
                    toggleSidebarVisibility();
                }, 600);
            });
            toggleSidebarModeBtn.addEventListener('mouseup', e => {
                if (e.button === 0) clearSidebarLongPress();
            });
            toggleSidebarModeBtn.addEventListener('mouseleave', clearSidebarLongPress);
            toggleSidebarModeBtn.addEventListener('click', () => {
                if (wasSidebarLongPress) {
                    wasSidebarLongPress = false;
                    return;
                }
                clearSidebarLongPress();

                const agentsTabIsActive = document.getElementById('tabContentAgents')?.classList.contains('active');
                if (!leftSidebar || !agentsTabIsActive) {
                    uiHelperFunctions.showToastNotification('请先切换到助手列表。', 'info');
                    return;
                }

                const enableAvatarOnly = !leftSidebar.classList.contains('avatar-only');
                if (setAvatarOnlyMode(enableAvatarOnly)) {
                    uiHelperFunctions.showToastNotification(
                        enableAvatarOnly ? '侧栏已切换为仅头像模式' : '侧栏已恢复完整模式',
                        'info'
                    );
                }
            });
            toggleSidebarModeBtn.addEventListener('contextmenu', e => e.preventDefault());
        }
    }

    // 语音聊天按钮事件处理
    const voiceChatBtn = document.getElementById('voiceChatBtn');
    if (voiceChatBtn) {
        voiceChatBtn.addEventListener('click', async () => {
            const currentSelectedItem = refs.currentSelectedItem.get();
            if (!currentSelectedItem.id) {
                uiHelperFunctions.showToastNotification('请先选择一个Agent', 'warning');
                return;
            }

            if (currentSelectedItem.type !== 'agent') {
                uiHelperFunctions.showToastNotification('语音聊天功能仅适用于Agent，不适用于群组', 'warning');
                return;
            }

            try {
                console.log(`[VoiceChat] Opening voice chat for agent: ${currentSelectedItem.id}`);
                await chatAPI.openVoiceChatWindow({
                    agentId: currentSelectedItem.id
                });
            } catch (error) {
                console.error('[VoiceChat] Failed to open voice chat window:', error);
                uiHelperFunctions.showToastNotification(`打开语音聊天失败: ${error.message}`, 'error');
            }
        });
    }
    if (agentSearchInput) {
        agentSearchInput.addEventListener('input', (e) => {
            filterAgentList(e.target.value);
        });
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's' && !e.shiftKey) {
            e.preventDefault();
            const tabContentSettings = document.getElementById('tabContentSettings');
            if (tabContentSettings && tabContentSettings.classList.contains('active')) {
                handleQuickSaveSettings();
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
            e.preventDefault();
            if (refs.currentTopicId.get() && refs.currentSelectedItem.get().id) {
                handleQuickExportTopic();
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();

            // 只限制当前 Agent；其他 Agent 的后台心流不影响本界面手动续写。
            if (window.flowlockManager?.isAgentLocked?.(refs.currentSelectedItem.get()?.id)) {
                uiHelperFunctions.showToastNotification('当前 Agent 已启用心流锁，无法手动续写', 'warning');
                return;
            }

            if (!refs.currentSelectedItem.get().id || !refs.currentTopicId.get()) {
                uiHelperFunctions.showToastNotification('请先选择一个项目和话题', 'warning');
                return;
            }
            const currentInputText = messageInput ? messageInput.value.trim() : '';
            handleContinueWriting(currentInputText);
        }

        if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
            e.preventDefault();

            const currentSelectedItem = refs.currentSelectedItem.get();
            if (!currentSelectedItem.id) {
                uiHelperFunctions.showToastNotification('请先选择一个Agent', 'warning');
                return;
            }

            if (currentSelectedItem.type !== 'agent') {
                uiHelperFunctions.showToastNotification('此快捷键仅适用于Agent，不适用于群组', 'warning');
                return;
            }

            // 检查是否按下 Shift 键
            if (e.shiftKey) {
                // Ctrl/Command + Shift + N: 创建未上锁的话题
                console.log('[快捷键] 执行快速新建未上锁话题');
                createNewTopicWithLockStatus(currentSelectedItem, false);
            } else {
                // Ctrl/Command + N: 创建普通话题（已上锁）
                console.log('[快捷键] 执行快速新建话题');
                if (chatManager && chatManager.createNewTopicForItem) {
                    chatManager.createNewTopicForItem(currentSelectedItem.id, currentSelectedItem.type);
                } else {
                    uiHelperFunctions.showToastNotification('无法创建新话题：功能不可用', 'error');
                }
            }
        }
    });

    // 监听来自主进程的全局快捷键触发的创建未锁定话题事件
    if (chatAPI?.onCreateUnlockedTopic) {
        listenerOwner?.own(chatAPI.onCreateUnlockedTopic(() => {
            console.log('[快捷键] 收到来自主进程的创建未锁定话题请求');
            const currentSelectedItem = refs.currentSelectedItem.get();
            if (!currentSelectedItem.id) {
                uiHelperFunctions.showToastNotification('请先选择一个Agent', 'warning');
                return;
            }
            if (currentSelectedItem.type !== 'agent') {
                uiHelperFunctions.showToastNotification('此快捷键仅适用于Agent，不适用于群组', 'warning');
                return;
            }
            createNewTopicWithLockStatus(currentSelectedItem, false);
        }));
    }

        setupCompleted = true;
    } finally {
        releaseCapturedListeners();
        if (!setupCompleted) eventListenersBound = false;
    }
}
