// modules/renderer/middleClickHandler.js

let mainRendererReferences = {};
let callbacks = {};

// --- State Variables ---
let middleClickGrid = null;
let currentGridSelection = '';
let isAdvancedModeActive = false;
let isDeletingMessage = false; // Flag to suppress grid cancellation messages during delete
let freezeGridCancellation = false; // Flag to completely freeze grid cancellation logic
let activeMiddleClickTimers = new Map();

/**
 * 检查气泡是否处于完成状态，可以进行中键操作
 * @param {Object} message - 消息对象
 * @param {HTMLElement} messageItem - 消息DOM元素
 * @returns {boolean} - 是否可以进行中键操作
 */
function canPerformMiddleClickAction(message, messageItem) {
    if (!message || !messageItem) {
        return false;
    }

    const messageId = message.id;

    // 多重状态检查，确保消息真正完成
    const isThinking = message.isThinking;
    const isStreaming = messageItem.classList.contains('streaming');
    const hasStreamingIndicator = messageItem.querySelector('.streaming-indicator, .thinking-indicator');

    // 检查消息是否在streamManager中被标记为已完成
    let isStreamManagerFinalized = false;
    if (window.streamManager && typeof window.streamManager.isMessageInitialized === 'function') {
        // 如果消息不在streamManager中跟踪，说明已经完成
        isStreamManagerFinalized = !window.streamManager.isMessageInitialized(messageId);
    }

    // 检查消息是否有完成理由（表示已完成）
    const hasFinishReason = message.finishReason && message.finishReason !== 'null';

    // 检查消息内容是否完整（非流式消息的标志）
    const hasCompleteContent = message.content &&
        (typeof message.content === 'string' ? message.content.length > 0 : true);

    // 增强的状态判断逻辑 - 只要满足以下任一条件即可认为完成：
    // 1. 传统检查：非思考且非流式
    // 2. 有完成理由（表示已完成）
    // 3. StreamManager确认已完成
    // 4. 有完整内容且无流式指示器
    const isCompleted = (!isThinking && !isStreaming) ||
                       hasFinishReason ||
                       isStreamManagerFinalized ||
                       (hasCompleteContent && !hasStreamingIndicator && !isStreaming);

    console.log(`[MiddleClick] Checking message ${messageId}: thinking=${isThinking}, streaming=${isStreaming}, hasIndicator=${!!hasStreamingIndicator}, streamFinalized=${isStreamManagerFinalized}, finishReason=${message.finishReason}, completed=${isCompleted}`);

    return isCompleted;
}

/**
 * Starts the advanced middle click timer mechanism with grid selection
 * @param {MouseEvent} event - The mouse event
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 * @param {Object} globalSettings - The global settings object
 */
function startAdvancedMiddleClickTimer(event, messageItem, message, globalSettings) {
    // 首先检查气泡是否处于完成状态
    if (!canPerformMiddleClickAction(message, messageItem)) {
        console.log(`[AdvancedMiddleClick] Ignoring advanced middle click on incomplete message: ${message?.id}`);
        return;
    }

    const timerId = `advanced_middle_click_${message.id}_${Date.now()}`;

    // Add visual feedback - change cursor and add a subtle highlight
    messageItem.style.cursor = 'grabbing';
    messageItem.style.backgroundColor = 'rgba(128, 128, 128, 0.1)';

    const startTime = Date.now();
    const delay = globalSettings.middleClickAdvancedDelay || 1000;

    // Create cleanup function
    const cleanup = () => {
        messageItem.style.cursor = '';
        messageItem.style.backgroundColor = '';
        if (middleClickGrid) {
            middleClickGrid.remove();
            middleClickGrid = null;
        }
        currentGridSelection = '';
        isAdvancedModeActive = false;
        isDeletingMessage = false;
        freezeGridCancellation = false;
        // 恢复原始的 showToastNotification 函数
        if (mainRendererReferences.uiHelper.showToastNotification &&
            mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
            mainRendererReferences.uiHelper.showToastNotification =
                mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
        }
        activeMiddleClickTimers.delete(timerId);
    };

    // Set up event listeners for mouseup and mouseleave
    const handleMouseUp = (e) => {
        if (e.button === 1) { // Middle mouse button
            e.preventDefault();
            e.stopPropagation();

            const holdTime = Date.now() - startTime;

            if (holdTime <= delay) {
                // Within delay time - let basic mode handle this (don't interfere)
                console.log(`[AdvancedMiddleClick] Within delay (${holdTime}ms < ${delay}ms) - letting basic mode handle`);
            } else {
                // After delay time - check if a valid selection was made
                if (currentGridSelection && currentGridSelection !== '' && currentGridSelection !== 'none') {
                    console.log(`[AdvancedMiddleClick] Setting quick action to: ${currentGridSelection}`);
                    // Update the global setting only if a valid function was selected
                    updateMiddleClickQuickAction(currentGridSelection);
                } else if (currentGridSelection === 'none') {
                    console.log('[AdvancedMiddleClick] Setting quick action to none (empty)');
                    // Update the global setting to empty only if "none" was explicitly selected
                    updateMiddleClickQuickAction('');
                } else {
                    console.log('[AdvancedMiddleClick] No valid selection made - keeping current setting');
                    // Don't change the setting if no valid selection was made
                    // Show a brief message to indicate cancellation (unless we're deleting a message or cancellation is frozen)
                    if (!isDeletingMessage && !freezeGridCancellation) {
                        const globalSettings = mainRendererReferences.globalSettingsRef.get();
                        if (globalSettings.middleClickQuickAction && globalSettings.middleClickQuickAction.trim() !== '') {
                            const actionNames = {
                                'edit': '编辑消息',
                                'copy': '复制文本',
                                'createBranch': '创建分支',
                                'readAloud': '朗读气泡',
                                'readMode': '阅读模式',
                                'regenerate': '重新回复',
                                'forward': '转发消息',
                                'delete': '删除消息'
                            };
                            mainRendererReferences.uiHelper.showToastNotification(`九宫格操作已取消，当前中键功能保持为: ${actionNames[globalSettings.middleClickQuickAction] || globalSettings.middleClickQuickAction}`, 'info');
                        } else {
                            mainRendererReferences.uiHelper.showToastNotification('九宫格操作已取消，中键快速功能未设置', 'info');
                        }
                    }
                }
            }

            cleanup();
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
            document.removeEventListener('mousemove', handleMouseMove);
        }
    };

    const handleMouseLeave = () => {
        console.log('[AdvancedMiddleClick] Mouse left element - cancelling');
        cleanup();
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('mouseleave', handleMouseLeave);
        document.removeEventListener('mousemove', handleMouseMove);
    };

    const handleMouseMove = (e) => {
        if (middleClickGrid) {
            updateGridSelection(e.clientX, e.clientY);
        }
    };

    // Set timeout to show grid after delay
    const timeoutId = setTimeout(() => {
        // Only show grid if advanced mode is still active and no cleanup happened
        if (activeMiddleClickTimers.has(timerId) && !isAdvancedModeActive) {
            console.log(`[AdvancedMiddleClick] Showing grid after ${delay}ms delay`);
            isAdvancedModeActive = true;
            showMiddleClickGrid(event.clientX, event.clientY, messageItem, message);
            document.addEventListener('mousemove', handleMouseMove);

            // Set initial selection to center (none)
            currentGridSelection = 'none';

            // Ensure grid background persists by adding a CSS class
            if (middleClickGrid) {
                middleClickGrid.classList.add('persistent-background');
            }
        }
    }, delay);

    // Add immediate mouseup listener for quick release
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeave);

    // Store the timer for potential cleanup
    activeMiddleClickTimers.set(timerId, {
        cleanup,
        handleMouseUp,
        handleMouseLeave,
        handleMouseMove,
        timeoutId
    });
}

/**
 * Starts the middle click timer mechanism
 * @param {MouseEvent} event - The mouse event
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 * @param {string} quickAction - The quick action to perform
 */
function startMiddleClickTimer(event, messageItem, message, quickAction) {
    // 首先检查气泡是否处于完成状态
    if (!canPerformMiddleClickAction(message, messageItem)) {
        console.log(`[MiddleClick] Ignoring middle click on incomplete message: ${message?.id}`);
        return;
    }

    const timerId = `middle_click_${message.id}_${Date.now()}`;

    // Add visual feedback - change cursor and add a subtle highlight
    messageItem.style.cursor = 'grabbing';
    messageItem.style.backgroundColor = 'rgba(128, 128, 128, 0.1)';

    const startTime = Date.now();

    // Create cleanup function
    const cleanup = () => {
        messageItem.style.cursor = '';
        messageItem.style.backgroundColor = '';
        isDeletingMessage = false;
        freezeGridCancellation = false;
        // 恢复原始的 showToastNotification 函数
        if (mainRendererReferences.uiHelper.showToastNotification &&
            mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
            mainRendererReferences.uiHelper.showToastNotification =
                mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
        }
        activeMiddleClickTimers.delete(timerId);
    };

    // Set up event listeners for mouseup and mouseleave
    const handleMouseUp = (e) => {
        if (e.button === 1) { // Middle mouse button
            e.preventDefault();
            e.stopPropagation();

            const holdTime = Date.now() - startTime;

            if (holdTime <= 1000) { // Within 1 second
                console.log(`[MiddleClick] Executing quick action after ${holdTime}ms: ${quickAction}`);
                handleMiddleClickQuickAction(event, messageItem, message, quickAction);
            } else {
                console.log(`[MiddleClick] Cancelled - held for ${holdTime}ms (> 1s)`);
            }

            cleanup();
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
        }
    };

    const handleMouseLeave = () => {
        console.log('[MiddleClick] Cancelled - mouse left element');
        cleanup();
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('mouseleave', handleMouseLeave);
    };

    // Add event listeners to document to catch mouseup even if mouse moves away
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeave);

    // Store the timer for potential cleanup
    activeMiddleClickTimers.set(timerId, {
        cleanup,
        handleMouseUp,
        handleMouseLeave,
        timeoutId: setTimeout(() => {
            console.log('[MiddleClick] Cancelled - 1 second timeout reached');
            cleanup();
            document.removeEventListener('mouseup', handleMouseUp);
            document.removeEventListener('mouseleave', handleMouseLeave);
        }, 1000)
    });
}

/**
 * Handles middle click quick action based on user settings
 * @param {MouseEvent} event - The mouse event
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 * @param {string} quickAction - The quick action to perform
 */
async function handleMiddleClickQuickAction(event, messageItem, message, quickAction) {
    const { electronAPI, uiHelper } = mainRendererReferences;
    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRendererReferences.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRendererReferences.currentTopicIdRef.get();

    // 在执行操作前再次检查气泡状态（使用与初始检查相同的逻辑）
    if (!canPerformMiddleClickAction(message, messageItem)) {
        console.log(`[MiddleClick] Cancelling action on message ${message?.id} - no longer in completed state`);
        uiHelper.showToastNotification("操作已取消：气泡未完成", "warning");
        return;
    }

    console.log(`[MiddleClick] Executing quick action: ${quickAction} for message: ${message.id}`);

    switch (quickAction) {
        case 'edit':
            // 编辑消息（带智能保存功能）
            // Check if message is currently in edit mode
            const isEditing = messageItem.classList.contains('message-item-editing');
            const textarea = messageItem.querySelector('.message-edit-textarea');

            if (isEditing && textarea) {
                // Currently in edit mode - perform save operation
                console.log(`[MiddleClick] Message ${message.id} is in edit mode, performing save`);

                // Find the save button and click it
                const saveButton = messageItem.querySelector('.message-edit-controls button:first-child');
                if (saveButton) {
                    saveButton.click();
                    uiHelper.showToastNotification("中键保存完成", "success");
                } else {
                    uiHelper.showToastNotification("保存按钮未找到", "warning");
                }
            } else {
                // Not in edit mode - enter edit mode with enhanced content validation and retry mechanism
                console.log(`[MiddleClick] Entering edit mode for message ${message.id}`);

                // Enhanced content validation with retry mechanism
                const editWithRetry = async (retryCount = 0) => {
                    const maxRetries = 3;
                    const retryDelay = 200; // ms

                    try {
                        // First, try to get the most up-to-date content from multiple sources
                        let currentContent = null;

                        // Source 1: Current message object
                        if (typeof message.content === 'string' && message.content.trim() !== '') {
                            currentContent = message.content;
                        } else if (message.content && typeof message.content.text === 'string' && message.content.text.trim() !== '') {
                            currentContent = message.content.text;
                        }

                        // Source 2: If content is empty, try to get it from current chat history
                        if (!currentContent || currentContent.trim() === '') {
                            console.log(`[MiddleClick] Content appears empty, checking current chat history for message ${message.id}`);
                            const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
                            const messageInHistory = currentChatHistoryArray.find(m => m.id === message.id);

                            if (messageInHistory) {
                                if (typeof messageInHistory.content === 'string' && messageInHistory.content.trim() !== '') {
                                    currentContent = messageInHistory.content;
                                    message.content = messageInHistory.content; // Update message object
                                } else if (messageInHistory.content && typeof messageInHistory.content.text === 'string' && messageInHistory.content.text.trim() !== '') {
                                    currentContent = messageInHistory.content.text;
                                    message.content = messageInHistory.content; // Update message object
                                }
                            }
                        }

                        // Source 3: If still empty, try to get it from history file (with retry)
                        if (!currentContent || currentContent.trim() === '') {
                            console.log(`[MiddleClick] Content still empty, trying to fetch from history file for message ${message.id} (attempt ${retryCount + 1}/${maxRetries})`);

                            try {
                                const result = await electronAPI.getOriginalMessageContent(
                                    currentSelectedItemVal.id,
                                    currentSelectedItemVal.type,
                                    currentTopicIdVal,
                                    message.id
                                );

                                if (result.success && result.content) {
                                    if (typeof result.content === 'string' && result.content.trim() !== '') {
                                        currentContent = result.content;
                                        message.content = result.content;
                                    } else if (result.content.text && typeof result.content.text === 'string' && result.content.text.trim() !== '') {
                                        currentContent = result.content.text;
                                        message.content = result.content;
                                    }
                                }
                            } catch (error) {
                                console.error(`[MiddleClick] Failed to fetch content from history (attempt ${retryCount + 1}):`, error);
                            }
                        }

                        // Final validation - if still no content, retry or show error
                        if (!currentContent || currentContent.trim() === '') {
                            if (retryCount < maxRetries) {
                                console.log(`[MiddleClick] Content still empty, retrying in ${retryDelay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                                setTimeout(() => editWithRetry(retryCount + 1), retryDelay);
                                return;
                            } else {
                                uiHelper.showToastNotification("无法获取消息内容进行编辑，请稍后重试", "error");
                                return;
                            }
                        }

                        // Ensure content is properly formatted for editing
                        if (currentContent !== message.content) {
                            message.content = currentContent;
                        }

                        console.log(`[MiddleClick] Successfully obtained content for editing (${currentContent.length} characters)`);

                        // Now proceed with edit mode
                        try {
                            if (typeof window.toggleEditMode === 'function') {
                                window.toggleEditMode(messageItem, message);
                            } else if (window.messageContextMenu && typeof window.messageContextMenu.toggleEditMode === 'function') {
                                window.messageContextMenu.toggleEditMode(messageItem, message);
                            } else {
                                uiHelper.showToastNotification("编辑功能暂时不可用", "warning");
                            }
                        } catch (error) {
                            console.error('Failed to call toggleEditMode:', error);
                            uiHelper.showToastNotification("编辑功能暂时不可用", "warning");
                        }

                    } catch (error) {
                        console.error(`[MiddleClick] Error in editWithRetry (attempt ${retryCount + 1}):`, error);
                        if (retryCount < maxRetries) {
                            setTimeout(() => editWithRetry(retryCount + 1), retryDelay);
                        } else {
                            uiHelper.showToastNotification("编辑功能出现错误，请稍后重试", "error");
                        }
                    }
                };

                // Execute the enhanced edit function with retry mechanism
                editWithRetry();
            }
            break;

        case 'copy':
            // 复制文本
            const contentDiv = messageItem.querySelector('.md-content');
            let textToCopy = '';

            if (contentDiv) {
                const contentClone = contentDiv.cloneNode(true);
                contentClone.querySelectorAll('.vcp-tool-use-bubble, .vcp-tool-result-bubble').forEach(el => el.remove());
                textToCopy = contentClone.innerText.trim();
            } else {
                let contentToProcess = message.content;
                if (typeof message.content === 'object' && message.content !== null && typeof message.content.text === 'string') {
                    contentToProcess = message.content.text;
                } else if (typeof message.content !== 'string') {
                    contentToProcess = '';
                }
                textToCopy = contentToProcess.replace(/<img[^>]*>/g, '').trim();
            }

            navigator.clipboard.writeText(textToCopy).then(() => {
                uiHelper.showToastNotification("已复制渲染后的文本。", "success");
            }).catch(err => {
                console.error('Failed to copy text:', err);
                uiHelper.showToastNotification("复制失败", "error");
            });
            break;

        case 'createBranch':
            // 创建分支
            if (typeof mainRendererReferences.handleCreateBranch === 'function') {
                mainRendererReferences.handleCreateBranch(message);
                uiHelper.showToastNotification("已开始创建分支", "success");
            } else {
                uiHelper.showToastNotification("创建分支功能暂时不可用", "warning");
            }
            break;

        case 'forward':
            // 转发消息 - 执行与右键菜单完全相同的功能
            if (typeof window.showForwardModal === 'function') {
                window.showForwardModal(message);
                uiHelper.showToastNotification("已打开转发对话框", "success");
            } else {
                uiHelper.showToastNotification("转发功能暂时不可用", "warning");
            }
            break;

        case 'readAloud':
            // 朗读气泡
            if (message.role === 'assistant') {
                // Ensure audio context is activated
                if (typeof window.ensureAudioContext === 'function') {
                    window.ensureAudioContext();
                }

                const agentId = message.agentId || currentSelectedItemVal.id;
                if (!agentId) {
                    uiHelper.showToastNotification("无法确定Agent身份，无法朗读。", "error");
                    return;
                }

                electronAPI.getAgentConfig(agentId).then(agentConfig => {
                    if (agentConfig && agentConfig.ttsVoicePrimary) {
                        const contentDiv = messageItem.querySelector('.md-content');
                        let textToRead = '';
                        if (contentDiv) {
                            const contentClone = contentDiv.cloneNode(true);
                            contentClone.querySelectorAll('.vcp-tool-use-bubble').forEach(el => el.remove());
                            contentClone.querySelectorAll('.vcp-tool-result-bubble').forEach(el => el.remove());
                            textToRead = contentClone.innerText || '';
                        }

                        if (textToRead.trim()) {
                            electronAPI.sovitsSpeak({
                                text: textToRead,
                                voice: agentConfig.ttsVoicePrimary,
                                speed: agentConfig.ttsSpeed || 1.0,
                                msgId: message.id,
                                ttsRegex: agentConfig.ttsRegexPrimary,
                                voiceSecondary: agentConfig.ttsVoiceSecondary,
                                ttsRegexSecondary: agentConfig.ttsRegexSecondary
                            });
                        } else {
                            uiHelper.showToastNotification("此消息没有可朗读的文本内容。", "info");
                        }
                    } else {
                        uiHelper.showToastNotification("此Agent未配置语音模型。", "warning");
                    }
                }).catch(error => {
                    console.error("获取Agent配置以进行朗读时出错:", error);
                    uiHelper.showToastNotification("获取Agent配置失败。", "error");
                });
            } else {
                uiHelper.showToastNotification("朗读功能仅适用于助手消息。", "warning");
            }
            break;

        case 'readMode':
            // 阅读模式
            if (!currentSelectedItemVal.id || !currentTopicIdVal || !message.id) {
                uiHelper.showToastNotification("无法打开阅读模式: 上下文信息不完整。", "error");
                return;
            }

            electronAPI.getOriginalMessageContent(
                currentSelectedItemVal.id,
                currentSelectedItemVal.type,
                currentTopicIdVal,
                message.id
            ).then(result => {
                if (result.success && result.content !== undefined) {
                    const rawContent = result.content;
                    const contentString = (typeof rawContent === 'string') ? rawContent : (rawContent?.text || '');

                    const windowTitle = `阅读: ${message.id.substring(0, 10)}...`;
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';

                    if (electronAPI && typeof electronAPI.openTextInNewWindow === 'function') {
                        electronAPI.openTextInNewWindow(contentString, windowTitle, currentTheme);
                    }
                } else {
                    uiHelper.showToastNotification(`无法加载原始消息: ${result.error || '未知错误'}`, "error");
                }
            }).catch(error => {
                console.error("调用 getOriginalMessageContent 时出错:", error);
                uiHelper.showToastNotification("加载阅读模式时发生错误。", "error");
            });
            break;

        case 'regenerate':
            // 重新回复
            if (message.role === 'assistant') {
                // 获取全局设置来检查保险机制是否开启
                const globalSettings = mainRendererReferences.globalSettingsRef.get();
                const enableConfirmation = globalSettings.enableRegenerateConfirmation !== false;

                if (enableConfirmation) {
                    // 检查当前消息是否是最后一条消息
                    const currentChatHistoryArray = mainRendererReferences.currentChatHistoryRef.get();
                    const lastAssistantMessage = [...currentChatHistoryArray]
                        .reverse()
                        .find(msg => msg.role === 'assistant');

                    const isLastMessage = lastAssistantMessage && lastAssistantMessage.id === message.id;

                    // 如果不是最后一条消息，显示警告对话框
                    if (!isLastMessage) {
                        const confirmRegenerate = await uiHelper.showConfirmDialog(
                            `当前消息不是最后一条消息，确定要重新生成此消息的回复吗？`,
                            '重新生成确认',
                            '确定',
                            '取消',
                            false
                        );

                        if (!confirmRegenerate) {
                            uiHelper.showToastNotification("重新回复操作已取消", "info");
                            return;
                        }
                    }
                }

                if (message.isGroupMessage) {
                    // 群聊重新回复逻辑
                    const currentSelectedItem = mainRendererReferences.currentSelectedItemRef.get();
                    const currentTopicId = mainRendererReferences.currentTopicIdRef.get();

                    if (currentSelectedItem.type === 'group' && currentTopicId && message.id && message.agentId) {
                        // 调用群聊重新回复的IPC接口
                        if (mainRendererReferences.electronAPI && mainRendererReferences.electronAPI.redoGroupChatMessage) {
                            mainRendererReferences.electronAPI.redoGroupChatMessage(
                                currentSelectedItem.id,
                                currentTopicId,
                                message.id,
                                message.agentId
                            );
                            uiHelper.showToastNotification("已开始重新生成回复", "success");
                        } else {
                            uiHelper.showToastNotification("群聊重新回复功能暂时不可用", "warning");
                        }
                    } else {
                        uiHelper.showToastNotification("无法重新回复：缺少群聊上下文信息。", "error");
                    }
                } else {
                    // 非群聊重新回复逻辑（原有逻辑）
                    if (window.messageContextMenu && typeof window.messageContextMenu.handleRegenerateResponse === 'function') {
                        window.messageContextMenu.handleRegenerateResponse(message);
                        uiHelper.showToastNotification("已开始重新生成回复", "success");
                    } else {
                        uiHelper.showToastNotification("重新回复功能暂时不可用", "warning");
                    }
                }
            } else {
                uiHelper.showToastNotification("重新回复功能仅适用于助手消息。", "warning");
            }
            break;

        case 'delete':
            // 删除消息 - 完全阻止九宫格取消提示
            let textForConfirm = "";
            if (typeof message.content === 'string') {
                textForConfirm = message.content;
            } else if (message.content && typeof message.content.text === 'string') {
                textForConfirm = message.content.text;
            } else {
                textForConfirm = '[消息内容无法预览]';
            }

            if (await uiHelper.showConfirmDialog(`确定要删除此消息吗？\n"${textForConfirm.substring(0, 50)}${textForConfirm.length > 50 ? '...' : ''}"`, '删除确认', '删除', '取消', true)) {
                // 设置标志位阻止九宫格取消提示
                isDeletingMessage = true;
                freezeGridCancellation = true;

                // 立即清理所有中键相关状态和定时器
                cleanupAllMiddleClickTimers();

                // 立即重置九宫格显示状态
                if (middleClickGrid) {
                    middleClickGrid.remove();
                    middleClickGrid = null;
                }
                currentGridSelection = '';
                isAdvancedModeActive = false;

                // 创建临时的提示函数，过滤掉九宫格相关提示
                const originalShowToast = uiHelper.showToastNotification;
                let tempShowToast = function(message, type) {
                    // 拦截所有九宫格相关的提示
                    if (message.includes('九宫格操作已取消') ||
                        message.includes('中键快速功能保持为') ||
                        message.includes('中键快速功能未设置')) {
                        console.log('[Delete] Blocked grid cancellation message:', message);
                        return;
                    }
                    // 其他提示正常显示
                    return originalShowToast.call(this, message, type);
                };

                // 保存原始函数引用并临时替换
                tempShowToast.originalShowToast = originalShowToast;
                uiHelper.showToastNotification = tempShowToast;

                // 执行删除操作
                if (typeof callbacks.removeMessageById === 'function') {
                    callbacks.removeMessageById(message.id, true);
                    // 显示删除成功提示
                    setTimeout(() => {
                        uiHelper.showToastNotification("消息已删除", "success");
                    }, 10);
                } else {
                    setTimeout(() => {
                        uiHelper.showToastNotification("删除功能暂时不可用", "warning");
                    }, 10);
                }

                // 延迟恢复原始函数
                setTimeout(() => {
                    uiHelper.showToastNotification = originalShowToast;
                }, 200);

                // 延迟清理标志位，确保删除操作完全完成
                setTimeout(() => {
                    isDeletingMessage = false;
                    freezeGridCancellation = false;
                }, 300);
            }
            break;

        default:
            // 如果是空值或其他未知值，不执行任何操作，也不显示任何消息
            if (quickAction && quickAction.trim() !== '') {
                uiHelper.showToastNotification(`未知的快速操作: ${quickAction}`, "warning");
            }
            // 如果是空值，静默忽略，不做任何操作
    }
}

/**
 * Shows the middle click function selection grid
 * @param {number} x - Mouse X position
 * @param {number} y - Mouse Y position
 * @param {HTMLElement} messageItem - The message DOM element
 * @param {Object} message - The message object
 */
function showMiddleClickGrid(x, y, messageItem, message) {
    // Remove existing grid if any
    if (middleClickGrid) {
        middleClickGrid.remove();
    }

    // Create grid container
    middleClickGrid = document.createElement('div');
    middleClickGrid.id = 'middleClickGrid';
    middleClickGrid.className = 'middle-click-grid persistent-background';
    middleClickGrid.style.position = 'fixed';
    middleClickGrid.style.left = `${x - 100}px`;
    middleClickGrid.style.top = `${y - 100}px`;
    middleClickGrid.style.width = '200px';
    middleClickGrid.style.height = '200px';
    middleClickGrid.style.zIndex = '10000';
    middleClickGrid.style.backgroundColor = 'var(--modal-bg)';
    middleClickGrid.style.border = '2px solid var(--accent-color)';
    middleClickGrid.style.borderRadius = '10px';
    middleClickGrid.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.3)';
    middleClickGrid.style.display = 'grid';
    middleClickGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    middleClickGrid.style.gridTemplateRows = 'repeat(3, 1fr)';
    middleClickGrid.style.gap = '2px';
    middleClickGrid.style.padding = '5px';

    // Grid layout: 8 functions + center "none"
    const gridFunctions = [
        'edit', 'copy', 'createBranch',
        'readAloud', 'none', 'readMode',
        'regenerate', 'forward', 'delete'
    ];

    const functionLabels = {
        'edit': '编辑',
        'copy': '复制',
        'createBranch': '分支',
        'readAloud': '朗读',
        'none': '无',
        'readMode': '阅读',
        'regenerate': '重回',
        'forward': '转发',
        'delete': '删除'
    };

    gridFunctions.forEach((func, index) => {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.function = func;
        cell.textContent = functionLabels[func];
        cell.style.display = 'flex';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        cell.style.backgroundColor = 'var(--button-bg)';
        cell.style.borderRadius = '5px';
        cell.style.cursor = 'pointer';
        cell.style.fontSize = '12px';
        cell.style.fontWeight = 'bold';
        cell.style.transition = 'all 0.1s ease';

        cell.addEventListener('mouseenter', () => {
            cell.style.backgroundColor = 'var(--accent-color)';
            cell.style.color = 'white';
            currentGridSelection = func;
        });

        cell.addEventListener('mouseleave', () => {
            cell.style.backgroundColor = 'var(--button-bg)';
            cell.style.color = 'var(--primary-text)';
        });

        middleClickGrid.appendChild(cell);
    });

    // Add to body
    document.body.appendChild(middleClickGrid);

    // Ensure grid is within viewport
    const rect = middleClickGrid.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (rect.right > viewportWidth) {
        middleClickGrid.style.left = `${viewportWidth - rect.width - 10}px`;
    }
    if (rect.bottom > viewportHeight) {
        middleClickGrid.style.top = `${viewportHeight - rect.height - 10}px`;
    }
    if (rect.left < 0) {
        middleClickGrid.style.left = '10px';
    }
    if (rect.top < 0) {
        middleClickGrid.style.top = '10px';
    }

    // Initialize current selection to center (none)
    currentGridSelection = 'none';
}

/**
 * Updates the grid selection based on mouse position
 * @param {number} mouseX - Mouse X position
 * @param {number} mouseY - Mouse Y position
 */
function updateGridSelection(mouseX, mouseY) {
    if (!middleClickGrid) return;

    const rect = middleClickGrid.getBoundingClientRect();
    const relativeX = mouseX - rect.left;
    const relativeY = mouseY - rect.top;

    // Calculate which cell the mouse is over (3x3 grid)
    const cellWidth = rect.width / 3;
    const cellHeight = rect.height / 3;

    const col = Math.floor(relativeX / cellWidth);
    const row = Math.floor(relativeY / cellHeight);

    // Ensure within bounds
    if (col >= 0 && col < 3 && row >= 0 && row < 3) {
        const cellIndex = row * 3 + col;
        const cells = middleClickGrid.querySelectorAll('.grid-cell');
        const targetCell = cells[cellIndex];

        if (targetCell) {
            // Reset all cells to default state
            cells.forEach(cell => {
                const func = cell.dataset.function;
                if (func === 'none') {
                    cell.style.backgroundColor = 'var(--button-bg)';
                    cell.style.color = 'var(--primary-text)';
                } else {
                    cell.style.backgroundColor = 'var(--bg-color)';
                    cell.style.color = 'var(--primary-text)';
                }
            });

            // Highlight target cell
            targetCell.style.backgroundColor = 'var(--accent-color)';
            targetCell.style.color = 'white';

            currentGridSelection = targetCell.dataset.function;
        }
    } else {
        // Mouse is outside grid - reset selection
        currentGridSelection = '';
    }
}

/**
 * Updates the global middle click quick action setting
 * @param {string} newAction - The new action to set
 */
function updateMiddleClickQuickAction(newAction) {
    const globalSettings = mainRendererReferences.globalSettingsRef.get();

    // Update the setting
    mainRendererReferences.globalSettingsRef.set({
        ...globalSettings,
        middleClickQuickAction: newAction
    });

    // Update the UI select element
    const selectElement = document.getElementById('middleClickQuickAction');
    if (selectElement) {
        selectElement.value = newAction;
    }

    // Save settings
    if (mainRendererReferences.electronAPI && mainRendererReferences.electronAPI.saveSettings) {
        mainRendererReferences.electronAPI.saveSettings({
            ...globalSettings,
            middleClickQuickAction: newAction
        }).then(result => {
            if (result.success) {
                const actionNames = {
                    'edit': '编辑消息',
                    'copy': '复制文本',
                    'createBranch': '创建分支',
                    'readAloud': '朗读气泡',
                    'none': '无',
                    'readMode': '阅读模式',
                    'regenerate': '重新回复',
                    'forward': '转发消息',
                    'delete': '删除消息'
                };

                const actionName = actionNames[newAction] || newAction;
                if (newAction && newAction.trim() !== '') {
                    mainRendererReferences.uiHelper.showToastNotification(`中键快速功能已设置为: ${actionName}`, 'success');
                } else {
                    mainRendererReferences.uiHelper.showToastNotification('中键快速功能已清空', 'info');
                }
            } else {
                mainRendererReferences.uiHelper.showToastNotification('设置保存失败', 'error');
            }
        });
    }
}

/**
 * Test function to show the middle click grid (for testing purposes)
 */
function showTestMiddleClickGrid() {
    showMiddleClickGrid(400, 300, null, null);

    // Auto-remove after 5 seconds for testing
    setTimeout(() => {
        if (middleClickGrid) {
            middleClickGrid.remove();
            middleClickGrid = null;
        }
    }, 5000);
}

/**
 * Cleans up all active middle click timers
 */
function cleanupAllMiddleClickTimers() {
    console.log(`[MiddleClick] Cleaning up ${activeMiddleClickTimers.size} active timers`);
    for (const [timerId, timerData] of activeMiddleClickTimers.entries()) {
        if (timerData.timeoutId) {
            clearTimeout(timerData.timeoutId);
        }
        if (timerData.cleanup) {
            timerData.cleanup();
        }
    }
    activeMiddleClickTimers.clear();

    // Reset global state
    if (middleClickGrid) {
        middleClickGrid.remove();
        middleClickGrid = null;
    }
    currentGridSelection = '';
    isAdvancedModeActive = false;
    isDeletingMessage = false;
    freezeGridCancellation = false;

    // 恢复原始的 showToastNotification 函数
    if (mainRendererReferences.uiHelper.showToastNotification &&
        mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
        mainRendererReferences.uiHelper.showToastNotification =
            mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
    }
}

function getMiddleClickState() {
    return {
        activeTimers: activeMiddleClickTimers.size,
        gridVisible: !!middleClickGrid,
        currentSelection: currentGridSelection,
        advancedModeActive: isAdvancedModeActive,
        isDeletingMessage: isDeletingMessage,
        freezeGridCancellation: freezeGridCancellation,
        toastFunctionModified: !!(mainRendererReferences.uiHelper.showToastNotification &&
                                 mainRendererReferences.uiHelper.showToastNotification.tempShowToast)
    };
}

function initialize(refs, cb) {
    mainRendererReferences = refs;
    callbacks = cb;
    // Add cleanup on page unload
    window.addEventListener('beforeunload', () => {
        cleanupAllMiddleClickTimers();
        isDeletingMessage = false;
        freezeGridCancellation = false;

        // 恢复原始的 showToastNotification 函数
        if (mainRendererReferences.uiHelper.showToastNotification &&
            mainRendererReferences.uiHelper.showToastNotification.tempShowToast) {
            mainRendererReferences.uiHelper.showToastNotification =
                mainRendererReferences.uiHelper.showToastNotification.originalShowToast;
        }
    });
}

export {
    initialize,
    startMiddleClickTimer,
    startAdvancedMiddleClickTimer,
    cleanupAllMiddleClickTimers,
    showTestMiddleClickGrid,
    getMiddleClickState
};