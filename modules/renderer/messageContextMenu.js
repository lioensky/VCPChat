// modules/renderer/messageContextMenu.js

let mainRefs = {};
let contextMenuDependencies = {};

/**
 * Initializes the context menu module with necessary references and dependencies.
 * @param {object} refs - Core references (electronAPI, uiHelper, etc.).
 * @param {object} dependencies - Functions from other modules (e.g., from messageRenderer).
 */
function initializeContextMenu(refs, dependencies) {
    mainRefs = refs;
    contextMenuDependencies = dependencies;
    document.addEventListener('click', closeContextMenuOnClickOutside, true);
}

function closeContextMenu() {
    const existingMenu = document.getElementById('chatContextMenu');
    if (existingMenu) {
        existingMenu.remove();
    }
}

// Separate closer for topic context menu to avoid interference
function closeTopicContextMenu() {
    const existingMenu = document.getElementById('topicContextMenu');
    if (existingMenu) existingMenu.remove();
}

function closeContextMenuOnClickOutside(event) {
    const menu = document.getElementById('chatContextMenu');
    if (menu && !menu.contains(event.target)) {
        closeContextMenu();
    }
    const topicMenu = document.getElementById('topicContextMenu');
    if (topicMenu && !topicMenu.contains(event.target)) {
        closeTopicContextMenu();
    }
}

function showContextMenu(event, messageItem, message) {
    closeContextMenu();
    closeTopicContextMenu();

    const { electronAPI, uiHelper } = mainRefs;
    const currentChatHistoryArray = mainRefs.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRefs.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRefs.currentTopicIdRef.get();

    const menu = document.createElement('div');
    menu.id = 'chatContextMenu';
    menu.classList.add('context-menu');

    const isThinkingOrStreaming = message.isThinking || messageItem.classList.contains('streaming');
    const isError = message.finishReason === 'error';

    if (isThinkingOrStreaming) {
        const interruptOption = document.createElement('div');
        interruptOption.classList.add('context-menu-item', 'danger-item');
        interruptOption.innerHTML = `<i class="fas fa-stop-circle"></i> 中止回复`;
        interruptOption.onclick = async () => {
            closeContextMenu();
            const { electronAPI, uiHelper } = mainRefs;
            const activeMessageId = message.id;

            if (!activeMessageId) return;

            if (message.isGroupMessage) {
                // --- 群聊中止逻辑 ---
                console.log(`[ContextMenu] Attempting to interrupt GROUP message: ${activeMessageId}`);
                if (electronAPI && typeof electronAPI.interruptGroupRequest === 'function') {
                    const result = await electronAPI.interruptGroupRequest(activeMessageId);
                    if (result.success) {
                        uiHelper.showToastNotification("已发送群聊中止信号。", "success");
                    } else {
                        uiHelper.showToastNotification(`群聊中止失败: ${result.error}`, "error");
                        // 作为后备，在前端直接停止渲染
                        if (contextMenuDependencies.finalizeStreamedMessage) {
                            contextMenuDependencies.finalizeStreamedMessage(activeMessageId, 'cancelled_by_user');
                        }
                    }
                } else {
                    console.error("[ContextMenu] electronAPI.interruptGroupRequest is not available.");
                    uiHelper.showToastNotification("无法发送群聊中止信号 (API不存在)。", "error");
                }
            } else {
                // --- 普通单聊中止逻辑 ---
                console.log(`[ContextMenu] Attempting to interrupt AGENT message: ${activeMessageId}`);
                if (contextMenuDependencies.interruptHandler && typeof contextMenuDependencies.interruptHandler.interrupt === 'function') {
                    const result = await contextMenuDependencies.interruptHandler.interrupt(activeMessageId);
                    if (result.success) {
                        uiHelper.showToastNotification("已发送中止信号。", "success");
                    } else {
                        console.warn(`[ContextMenu] Interrupt failed: ${result.error}`);
                        uiHelper.showToastNotification(`中止失败: ${result.error}`, "error");
                        
                        // 中止失败时手动finalize消息
                        if (contextMenuDependencies.finalizeStreamedMessage) {
                            contextMenuDependencies.finalizeStreamedMessage(activeMessageId, 'cancelled_by_user');
                        }
                        
                        // --- Flowlock: 中止失败后恢复心流锁自动续写 ---
                        if (window.flowlockManager) {
                            const flowlockState = window.flowlockManager.getState();
                            console.log('[Flowlock] Interrupt failed, checking if flowlock should recover. State:', flowlockState);
                            
                            // 重置processing状态
                            if (window.flowlockManager.isProcessing) {
                                console.log('[Flowlock] Resetting isProcessing state after interrupt failure');
                                window.flowlockManager.isProcessing = false;
                            }
                            
                            // 如果心流锁激活，触发下一次续写
                            if (flowlockState.isActive) {
                                console.log('[Flowlock] Flowlock active after interrupt failure, will trigger next continue writing');
                                
                                setTimeout(() => {
                                    if (window.flowlockManager && window.flowlockManager.getState().isActive) {
                                        console.log('[Flowlock] Triggering continue writing after interrupt failure recovery...');
                                        
                                        // 触发心跳动画
                                        const chatNameElement = document.getElementById('currentChatAgentName');
                                        if (chatNameElement) {
                                            chatNameElement.classList.add('flowlock-heartbeat');
                                            setTimeout(() => {
                                                chatNameElement.classList.remove('flowlock-heartbeat');
                                            }, 800);
                                        }
                                        
                                        // 获取输入框内容作为提示词
                                        const messageInput = document.getElementById('messageInput');
                                        const customPrompt = messageInput ? messageInput.value.trim() : '';
                                        console.log('[Flowlock] Using custom prompt from input:', customPrompt || '(empty, will use default)');
                                        
                                        // 触发续写
                                        if (window.handleContinueWriting) {
                                            window.flowlockManager.isProcessing = true;
                                            window.handleContinueWriting(customPrompt).then(() => {
                                                console.log('[Flowlock] Continue writing completed after interrupt failure recovery');
                                                window.flowlockManager.isProcessing = false;
                                                window.flowlockManager.retryCount = 0;
                                            }).catch((error) => {
                                                console.error('[Flowlock] Continue writing failed after interrupt failure recovery:', error);
                                                window.flowlockManager.isProcessing = false;
                                                window.flowlockManager.retryCount++;
                                                
                                                if (window.flowlockManager.retryCount >= window.flowlockManager.maxRetries) {
                                                    console.error('[Flowlock] Max retries reached, stopping flowlock');
                                                    if (window.uiHelperFunctions && window.uiHelperFunctions.showToastNotification) {
                                                        window.uiHelperFunctions.showToastNotification('心流锁续写失败次数过多，已自动停止', 'error');
                                                    }
                                                    window.flowlockManager.stop();
                                                }
                                            });
                                        }
                                    }
                                }, 5000);
                            }
                        }
                    }
                } else {
                    console.error("[ContextMenu] Interrupt handler not available. Manually cancelling.");
                    uiHelper.showToastNotification("无法发送中止信号，已在本地取消。", "warning");
                    if (contextMenuDependencies.finalizeStreamedMessage) {
                        contextMenuDependencies.finalizeStreamedMessage(activeMessageId, 'cancelled_by_user');
                    }
                }
            }
        };
        menu.appendChild(interruptOption);
    }
    
    // For non-thinking/non-streaming messages (including errors and completed messages)
    if (!isThinkingOrStreaming) {
        const isEditing = messageItem.classList.contains('message-item-editing');
        const textarea = isEditing ? messageItem.querySelector('.message-edit-textarea') : null;

        if (!isEditing) {
            const editOption = document.createElement('div');
            editOption.classList.add('context-menu-item');
            editOption.innerHTML = `<i class="fas fa-edit"></i> 编辑消息`;
            editOption.onclick = () => {
                toggleEditMode(messageItem, message);
                closeContextMenu();
            };
            menu.appendChild(editOption);
        }

        const copyOption = document.createElement('div');
        copyOption.classList.add('context-menu-item');
        copyOption.innerHTML = `<i class="fas fa-copy"></i> 复制文本`;
        copyOption.onclick = () => {
            const { uiHelper } = mainRefs;
            const contentDiv = messageItem.querySelector('.md-content');
            let textToCopy = '';

            if (contentDiv) {
                // 克隆节点以避免修改实时显示的DOM
                const contentClone = contentDiv.cloneNode(true);
                // 移除工具使用气泡、样式表和脚本，以获得更干净的复制内容
                contentClone.querySelectorAll('.vcp-tool-use-bubble, .vcp-tool-result-bubble, style, script').forEach(el => el.remove());
                // 修复：清理多余的空行，确保最多只有一个空行
                textToCopy = contentClone.innerText.replace(/\n{3,}/g, '\n\n').trim();
            } else {
                // 如果找不到 .md-content，则回退到旧方法
                let contentToProcess = message.content;
                if (typeof message.content === 'object' && message.content !== null && typeof message.content.text === 'string') {
                    contentToProcess = message.content.text;
                } else if (typeof message.content !== 'string') {
                    contentToProcess = '';
                }
                textToCopy = contentToProcess.replace(/<img[^>]*>/g, '').trim();
            }
            
            navigator.clipboard.writeText(textToCopy);
            uiHelper.showToastNotification("已复制渲染后的文本。", "success");
            closeContextMenu();
        };
        menu.appendChild(copyOption);

        if (isEditing && textarea) {
            const cutOption = document.createElement('div');
            cutOption.classList.add('context-menu-item');
            cutOption.innerHTML = `<i class="fas fa-cut"></i> 剪切文本`;
            cutOption.onclick = () => {
                textarea.focus(); document.execCommand('cut'); closeContextMenu();
            };
            menu.appendChild(cutOption);

            const pasteOption = document.createElement('div');
            pasteOption.classList.add('context-menu-item');
            pasteOption.innerHTML = `<i class="fas fa-paste"></i> 粘贴文本`;
            pasteOption.onclick = async () => {
                textarea.focus();
                try {
                    const text = await electronAPI.readTextFromClipboard();
                    if (text) {
                        const start = textarea.selectionStart; const end = textarea.selectionEnd;
                        textarea.value = textarea.value.substring(0, start) + text + textarea.value.substring(end);
                        textarea.selectionStart = textarea.selectionEnd = start + text.length;
                        textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                    }
                } catch (err) { console.error('Failed to paste text:', err); }
                closeContextMenu();
            };
            menu.appendChild(pasteOption);
        }

        if (currentSelectedItemVal.type === 'agent' || currentSelectedItemVal.type === 'group') {
            const createBranchOption = document.createElement('div');
            createBranchOption.classList.add('context-menu-item');
            createBranchOption.innerHTML = `<i class="fas fa-code-branch"></i> 创建分支`;
            createBranchOption.onclick = () => {
                if (typeof mainRefs.handleCreateBranch === 'function') {
                     mainRefs.handleCreateBranch(message);
                }
                closeContextMenu();
            };
            menu.appendChild(createBranchOption);
        }

        const forwardOption = document.createElement('div');
        forwardOption.classList.add('context-menu-item');
        forwardOption.innerHTML = `<i class="fas fa-share"></i> 转发消息`;
        forwardOption.onclick = () => {
            if (contextMenuDependencies.showForwardModal && typeof contextMenuDependencies.showForwardModal === 'function') {
                contextMenuDependencies.showForwardModal(message);
            }
            closeContextMenu();
        };
        menu.appendChild(forwardOption);

        // Add "Read Aloud" option for assistant messages
        if (message.role === 'assistant') {
            const readAloudOption = document.createElement('div');
            readAloudOption.classList.add('context-menu-item', 'context-menu-item-speak');
            readAloudOption.innerHTML = `<i class="fas fa-volume-up"></i> 朗读气泡`;
            readAloudOption.onclick = async () => {
                // **关键修复：在发送请求前，确保音频上下文已激活**
                if (typeof window.ensureAudioContext === 'function') {
                    window.ensureAudioContext();
                }

                const agentId = message.agentId || currentSelectedItemVal.id;
                if (!agentId) {
                    uiHelper.showToastNotification("无法确定Agent身份，无法朗读。", "error");
                    closeContextMenu();
                    return;
                }

                try {
                    const agentConfig = await electronAPI.getAgentConfig(agentId);
                    
                    // 检查是否获取配置失败
                    if (agentConfig && agentConfig.error) {
                        console.error('[MessageContextMenu] Failed to get agent config for TTS:', agentConfig.error);
                        uiHelper.showToastNotification('获取Agent配置失败，无法朗读。', 'error');
                        closeContextMenu();
                        return;
                    }
                    
                    if (agentConfig && agentConfig.ttsVoicePrimary) {
                        const contentDiv = messageItem.querySelector('.md-content');
                        let textToRead = '';
                        if (contentDiv) {
                            // Clone the content element to avoid modifying the actual displayed content
                            const contentClone = contentDiv.cloneNode(true);
                            // Remove all tool-use bubbles, tool-result bubbles, style tags, and script tags from the clone
                            contentClone.querySelectorAll('.vcp-tool-use-bubble, .vcp-tool-result-bubble, style, script').forEach(el => el.remove());
                            // Now, get the innerText from the cleaned-up clone
                            // 修复：清理多余的空行，确保最多只有一个空行
                            textToRead = (contentClone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
                        }
                        
                        if (textToRead.trim()) {
                            // Pass bilingual TTS settings
                            electronAPI.sovitsSpeak({
                                text: textToRead,
                                voice: agentConfig.ttsVoicePrimary, // Legacy 'voice' is now primary
                                speed: agentConfig.ttsSpeed || 1.0,
                                msgId: message.id,
                                ttsRegex: agentConfig.ttsRegexPrimary, // Legacy 'ttsRegex' is now primary
                                // New bilingual fields
                                voiceSecondary: agentConfig.ttsVoiceSecondary,
                                ttsRegexSecondary: agentConfig.ttsRegexSecondary
                            });
                        } else {
                            uiHelper.showToastNotification("此消息没有可朗读的文本内容。", "info");
                        }
                    } else {
                        uiHelper.showToastNotification("此Agent未配置语音模型。", "warning");
                    }
                } catch (error) {
                    console.error("获取Agent配置以进行朗读时出错:", error);
                    uiHelper.showToastNotification("获取Agent配置失败。", "error");
                }
                closeContextMenu();
            };
            menu.appendChild(readAloudOption);
        }

        const readModeOption = document.createElement('div');
        readModeOption.classList.add('context-menu-item', 'info-item');
        readModeOption.innerHTML = `<i class="fas fa-book-reader"></i> 阅读模式`;
        readModeOption.onclick = async () => { // Make it async
            const { electronAPI, uiHelper } = mainRefs;
            const currentSelectedItemVal = mainRefs.currentSelectedItemRef.get();
            const currentTopicIdVal = mainRefs.currentTopicIdRef.get();

            if (!currentSelectedItemVal.id || !currentTopicIdVal || !message.id) {
                console.error("无法打开阅读模式: 缺少项目、话题或消息ID。");
                uiHelper.showToastNotification("无法打开阅读模式: 上下文信息不完整。", "error");
                closeContextMenu();
                return;
            }

            try {
                // A new IPC call to get the raw, original content from the history file
                const result = await electronAPI.getOriginalMessageContent(
                    currentSelectedItemVal.id,
                    currentSelectedItemVal.type,
                    currentTopicIdVal,
                    message.id
                );

                if (result.success && result.content !== undefined) {
                    // The content from history can be a string or an object like { text: "..." }
                    const rawContent = result.content;
                    const contentString = (typeof rawContent === 'string') ? rawContent : (rawContent?.text || '');
                    
                    const windowTitle = `阅读: ${message.id.substring(0, 10)}...`;
                    const currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
                    
                    if (electronAPI && typeof electronAPI.openTextInNewWindow === 'function') {
                        electronAPI.openTextInNewWindow(contentString, windowTitle, currentTheme);
                    }
                } else {
                    console.error("获取原始消息内容失败:", result.error);
                    uiHelper.showToastNotification(`无法加载原始消息: ${result.error || '未知错误'}`, "error");
                }
            } catch (error) {
                console.error("调用 getOriginalMessageContent 时出错:", error);
                uiHelper.showToastNotification("加载阅读模式时发生IPC错误。", "error");
            }

            closeContextMenu();
        };
        menu.appendChild(readModeOption);

        const deleteOption = document.createElement('div');
        deleteOption.classList.add('context-menu-item', 'danger-item');
        deleteOption.innerHTML = `<i class="fas fa-trash-alt"></i> 删除消息`;
        deleteOption.onclick = async () => {
            let textForConfirm = "";
            if (typeof message.content === 'string') {
                textForConfirm = message.content;
            } else if (message.content && typeof message.content.text === 'string') {
                textForConfirm = message.content.text;
            } else {
                textForConfirm = '[消息内容无法预览]';
            }
            
            if (await uiHelper.showConfirmDialog(`确定要删除此消息吗？\n"${textForConfirm.substring(0, 50)}${textForConfirm.length > 50 ? '...' : ''}"`, '删除确认', '删除', '取消', true)) {
                contextMenuDependencies.removeMessageById(message.id, true); // Pass true to save history
            }
            closeContextMenu();
        };
        
        // Regenerate option should be here to maintain order
        if (message.role === 'assistant' && !message.isGroupMessage && currentSelectedItemVal.type === 'agent') {
            const regenerateOption = document.createElement('div');
            regenerateOption.classList.add('context-menu-item', 'regenerate-text');
            regenerateOption.innerHTML = `<i class="fas fa-sync-alt"></i> 重新回复`;
            regenerateOption.onclick = () => {
                handleRegenerateResponse(message);
                closeContextMenu();
            };
            menu.appendChild(regenerateOption);
        }
        
        // 新增：群聊中的“重新回复”功能
        if (message.role === 'assistant' && message.isGroupMessage) {
            const redoGroupOption = document.createElement('div');
            redoGroupOption.classList.add('context-menu-item', 'regenerate-text');
            redoGroupOption.innerHTML = `<i class="fas fa-sync-alt"></i> 重新回复`;
            redoGroupOption.onclick = () => {
                const { electronAPI, uiHelper } = mainRefs;
                const currentSelectedItem = mainRefs.currentSelectedItemRef.get();
                const currentTopicId = mainRefs.currentTopicIdRef.get();

                if (currentSelectedItem.type === 'group' && currentTopicId && message.id && message.agentId) {
                    // 调用新的IPC接口
                    electronAPI.redoGroupChatMessage(currentSelectedItem.id, currentTopicId, message.id, message.agentId);
                } else {
                    uiHelper.showToastNotification("无法重新回复：缺少群聊上下文信息。", "error");
                }
                closeContextMenu();
            };
            menu.appendChild(redoGroupOption);
        }

        menu.appendChild(deleteOption);
    }

    menu.style.visibility = 'hidden';
    menu.style.position = 'absolute';
    document.body.appendChild(menu);

    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let top = event.clientY;
    let left = event.clientX;

    if (top + menuHeight > windowHeight) {
        top = event.clientY - menuHeight;
        if (top < 0) top = 5;
    }

    if (left + menuWidth > windowWidth) {
        left = event.clientX - menuWidth;
        if (left < 0) left = 5;
    }

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.visibility = 'visible';
}

function toggleEditMode(messageItem, message) {
    const { electronAPI, markedInstance, uiHelper } = mainRefs;
    const currentChatHistoryArray = mainRefs.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRefs.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRefs.currentTopicIdRef.get();

    const contentDiv = messageItem.querySelector('.md-content');
    if (!contentDiv) return;

    const existingTextarea = messageItem.querySelector('.message-edit-textarea');
    const existingControls = messageItem.querySelector('.message-edit-controls');

    if (existingTextarea) { // Revert to display mode
        let textToDisplay = "";
        if (typeof message.content === 'string') {
            textToDisplay = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            textToDisplay = message.content.text;
        } else {
            textToDisplay = '[内容错误]';
        }
        
        // 🟢 修复：使用 updateMessageContent 确保正则规则被应用
        if (contextMenuDependencies.updateMessageContent) {
            contextMenuDependencies.updateMessageContent(message.id, textToDisplay);
        } else {
            // Fallback for safety, though updateMessageContent should be available now
            const rawHtml = markedInstance.parse(contextMenuDependencies.preprocessFullContent(textToDisplay));
            contextMenuDependencies.setContentAndProcessImages(contentDiv, rawHtml, message.id);
            contextMenuDependencies.processRenderedContent(contentDiv);
            setTimeout(() => {
                if (contentDiv && contentDiv.isConnected) {
                    contextMenuDependencies.runTextHighlights(contentDiv);
                }
            }, 0);
        }

        messageItem.classList.remove('message-item-editing');
        existingTextarea.remove();
        if (existingControls) existingControls.remove();
        contentDiv.style.display = '';
        const avatarEl = messageItem.querySelector('.chat-avatar');
        const nameTimeEl = messageItem.querySelector('.name-time-block');
        if(avatarEl) avatarEl.style.display = '';
        if(nameTimeEl) nameTimeEl.style.display = '';
    } else { // Switch to edit mode
        const originalContentHeight = contentDiv.offsetHeight;
        contentDiv.style.display = 'none';
        const avatarEl = messageItem.querySelector('.chat-avatar');
        const nameTimeEl = messageItem.querySelector('.name-time-block');
        if(avatarEl) avatarEl.style.display = 'none';
        if(nameTimeEl) nameTimeEl.style.display = 'none';

        messageItem.classList.add('message-item-editing');

        const textarea = document.createElement('textarea');
        textarea.classList.add('message-edit-textarea');
        
        let textForEditing = "";
        if (typeof message.content === 'string') {
            textForEditing = message.content;
        } else if (message.content && typeof message.content.text === 'string') {
            textForEditing = message.content.text;
        } else {
            textForEditing = '[内容加载错误]';
        }
        textarea.value = textForEditing;
        textarea.style.minHeight = `${Math.max(originalContentHeight, 50)}px`;
        textarea.style.width = '100%';

        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('message-edit-controls');

        const saveButton = document.createElement('button');
        saveButton.innerHTML = `<i class="fas fa-save"></i> 保存`;
        saveButton.onclick = async () => {
            // 🔧 关键修复：添加防御性编程和错误处理
            const newContent = textarea.value;
            
            // Get original content for comparison
            let originalTextContent = "";
            if (typeof message.content === 'string') {
                originalTextContent = message.content;
            } else if (message.content && typeof message.content.text === 'string') {
                originalTextContent = message.content.text;
            }

            // If content hasn't changed, just exit edit mode without saving.
            if (newContent === originalTextContent) {
                toggleEditMode(messageItem, message);
                return;
            }

            const messageIndex = currentChatHistoryArray.findIndex(msg => msg.id === message.id);
            
            if (messageIndex === -1) {
                uiHelper.showToastNotification("无法找到要编辑的消息，编辑失败。", "error");
                return;
            }

            // 🔧 保存原始状态以便回滚
            const originalContent = currentChatHistoryArray[messageIndex].content;
            const originalMessageContent = message.content;
            
            try {
                // 🔧 先临时禁用文件监控，避免竞态条件
                if (electronAPI.watcherStop) {
                    console.log('[EditMode] Temporarily stopping file watcher to prevent race condition');
                    await electronAPI.watcherStop();
                }

                // 🔧 更新内存状态
                currentChatHistoryArray[messageIndex].content = newContent;
                message.content = newContent;
                
                // 🔧 尝试保存到文件
                if (currentSelectedItemVal.id && currentTopicIdVal) {
                    let saveResult;
                    if (currentSelectedItemVal.type === 'agent') {
                        saveResult = await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                    } else if (currentSelectedItemVal.type === 'group' && electronAPI.saveGroupChatHistory) {
                        saveResult = await electronAPI.saveGroupChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
                    }
                    
                    // 🔧 检查保存结果
                    if (saveResult && !saveResult.success) {
                        throw new Error(saveResult.error || '保存失败');
                    }
                }
                
                // 🔧 保存成功后更新UI
                mainRefs.currentChatHistoryRef.set([...currentChatHistoryArray]);
                
                // 🟢 修复：使用 updateMessageContent 确保正则规则被应用
                if (contextMenuDependencies.updateMessageContent) {
                    contextMenuDependencies.updateMessageContent(message.id, newContent);
                } else {
                    // Fallback for safety
                    const rawHtml = markedInstance.parse(contextMenuDependencies.preprocessFullContent(newContent));
                    contextMenuDependencies.setContentAndProcessImages(contentDiv, rawHtml, message.id);
                    contextMenuDependencies.processRenderedContent(contentDiv);
                    contextMenuDependencies.renderAttachments(message, contentDiv);
                }
                
                // 🔧 重新启动文件监控
                if (electronAPI.watcherStart && currentSelectedItemVal.config?.agentDataPath) {
                    const historyFilePath = `${currentSelectedItemVal.config.agentDataPath}\\topics\\${currentTopicIdVal}\\history.json`;
                    await electronAPI.watcherStart(historyFilePath, currentSelectedItemVal.id, currentTopicIdVal);
                }
                
                if (uiHelper && typeof uiHelper.showToastNotification === 'function') {
                    uiHelper.showToastNotification("消息编辑已保存。", "success");
                }
                
            } catch (error) {
                // 🔧 保存失败时回滚状态
                console.error('[EditMode] Save failed, rolling back:', error);
                currentChatHistoryArray[messageIndex].content = originalContent;
                message.content = originalMessageContent;
                mainRefs.currentChatHistoryRef.set([...currentChatHistoryArray]);
                
                // 🔧 重新启动文件监控（即使保存失败）
                if (electronAPI.watcherStart && currentSelectedItemVal.config?.agentDataPath) {
                    try {
                        const historyFilePath = `${currentSelectedItemVal.config.agentDataPath}\\topics\\${currentTopicIdVal}\\history.json`;
                        await electronAPI.watcherStart(historyFilePath, currentSelectedItemVal.id, currentTopicIdVal);
                    } catch (watcherError) {
                        console.error('[EditMode] Failed to restart watcher after save failure:', watcherError);
                    }
                }
                
                if (uiHelper && typeof uiHelper.showToastNotification === 'function') {
                    uiHelper.showToastNotification(`编辑保存失败: ${error.message}`, "error");
                }
                return; // 不退出编辑模式，让用户重试
            }
            
            // 🔧 只有在保存成功后才退出编辑模式
            toggleEditMode(messageItem, message);
        };

        const cancelButton = document.createElement('button');
        cancelButton.innerHTML = `<i class="fas fa-times"></i> 取消`;
        cancelButton.onclick = () => {
             toggleEditMode(messageItem, message);
        };

        controlsDiv.appendChild(saveButton);
        controlsDiv.appendChild(cancelButton);

        messageItem.appendChild(textarea);
        messageItem.appendChild(controlsDiv);
         
        if (uiHelper.autoResizeTextarea) uiHelper.autoResizeTextarea(textarea);
        textarea.focus();
        textarea.addEventListener('input', () => uiHelper.autoResizeTextarea(textarea));
        textarea.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                cancelButton.click();
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey) {
                event.preventDefault();
                saveButton.click();
            } else if (event.ctrlKey && event.key === 'Enter') {
                saveButton.click();
            }
        });
    }
}

async function handleRegenerateResponse(originalAssistantMessage) {
    const { electronAPI, uiHelper } = mainRefs;
    const currentChatHistoryArray = mainRefs.currentChatHistoryRef.get();
    const currentSelectedItemVal = mainRefs.currentSelectedItemRef.get();
    const currentTopicIdVal = mainRefs.currentTopicIdRef.get();
    const globalSettingsVal = mainRefs.globalSettingsRef.get();

    if (!currentSelectedItemVal.id || currentSelectedItemVal.type !== 'agent' || !currentTopicIdVal || !originalAssistantMessage || originalAssistantMessage.role !== 'assistant') {
        uiHelper.showToastNotification("只能为 Agent 的回复进行重新生成。", "warning");
        return;
    }

    const originalMessageIndex = currentChatHistoryArray.findIndex(msg => msg.id === originalAssistantMessage.id);
    if (originalMessageIndex === -1) return;

    const historyForRegeneration = currentChatHistoryArray.slice(0, originalMessageIndex);
    
    // Remove original and subsequent messages from DOM and history
    const messagesToRemove = currentChatHistoryArray.splice(originalMessageIndex);
    mainRefs.currentChatHistoryRef.set([...currentChatHistoryArray]);
    messagesToRemove.forEach(msg => contextMenuDependencies.removeMessageById(msg.id, false)); // false = don't save history again

    if (currentSelectedItemVal.id && currentTopicIdVal) {
        try {
            await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
        } catch (saveError) {
            console.error("ContextMenu: Failed to save chat history after splice in regenerate:", saveError);
        }
    }

    const regenerationThinkingMessage = {
        role: 'assistant',
        name: currentSelectedItemVal.name || 'AI',
        content: '',
        timestamp: Date.now(),
        id: `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`,
        isThinking: true,
        avatarUrl: currentSelectedItemVal.avatarUrl,
        avatarColor: currentSelectedItemVal.config?.avatarCalculatedColor,
    };

    contextMenuDependencies.renderMessage(regenerationThinkingMessage, false);
    currentChatHistoryArray.push(regenerationThinkingMessage);
    mainRefs.currentChatHistoryRef.set([...currentChatHistoryArray]);
    window.updateSendButtonState?.();

    try {
        const agentConfig = await electronAPI.getAgentConfig(currentSelectedItemVal.id);
        
        // 检查是否获取配置失败
        if (agentConfig && agentConfig.error) {
            console.error('[MessageContextMenu] Failed to get agent config for regeneration:', agentConfig.error);
            uiHelper.showToastNotification('获取Agent配置失败，无法重新生成消息。', 'error');
            // 移除思考中消息
            const messages = contextMenuDependencies.chatContainer.querySelectorAll('.message-item');
            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                if (lastMessage.classList.contains('thinking')) {
                    lastMessage.remove();
                }
            }
            return;
        }
        
        const messagesForVCP = await Promise.all(historyForRegeneration.map(async (msg, index) => {
            let vcpImageAttachmentsPayload = [];
            let vcpAudioAttachmentsPayload = [];
            let vcpVideoAttachmentsPayload = [];
            let currentMessageTextContent;
 
            let originalText = (typeof msg.content === 'string') ? msg.content : (msg.content?.text || '');

            // Check if this is the last user message in the history for regeneration
            const isLastUserMessage = msg.role === 'user' && !historyForRegeneration.slice(index + 1).some(futureMsg => futureMsg.role === 'user');

            if (isLastUserMessage && originalText.includes('{{VCPChatCanvas}}')) {
                 try {
                    const canvasData = await electronAPI.getLatestCanvasContent();
                    if (canvasData && !canvasData.error) {
                        const formattedCanvasContent = `\n[Canvas Content]\n${canvasData.content || ''}\n[Canvas Path]\n${canvasData.path || 'No file path'}\n[Canvas Errors]\n${canvasData.errors || 'No errors'}\n`;
                        originalText = originalText.replace(/\{\{VCPChatCanvas\}\}/g, formattedCanvasContent);
                    } else {
                        originalText = originalText.replace(/\{\{VCPChatCanvas\}\}/g, '\n[Canvas content could not be loaded]\n');
                    }
                } catch (error) {
                    originalText = originalText.replace(/\{\{VCPChatCanvas\}\}/g, '\n[Error loading canvas content]\n');
                }
            }
 
            if (msg.attachments && msg.attachments.length > 0) {
                let historicalAppendedText = "";
                for (const att of msg.attachments) {
                    const fileManagerData = att._fileManagerData || {};
                    // 🟢 同步：重新生成时的多级路径探测。优先使用 internalPath (物理路径)
                    const filePathForContext = (fileManagerData && fileManagerData.internalPath) || 
                                               att.localPath || 
                                               att.src || 
                                               (att.name || '未知文件');

                    if (fileManagerData.imageFrames && fileManagerData.imageFrames.length > 0) {
                         historicalAppendedText += `\n\n[附加文件: ${filePathForContext} (扫描版PDF，已转换为图片)]`;
                    } else if (fileManagerData.extractedText) {
                        historicalAppendedText += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${att.name || '未知文件'}]`;
                    } else {
                        historicalAppendedText += `\n\n[附加文件: ${filePathForContext}]`;
                    }
                }
                currentMessageTextContent = originalText + historicalAppendedText;
            } else {
                currentMessageTextContent = originalText;
            }

            if (msg.attachments && msg.attachments.length > 0) {
                // --- IMAGE PROCESSING ---
                const imageAttachmentsPromises = msg.attachments.map(async att => {
                    const fileManagerData = att._fileManagerData || {};
                    // Case 1: Scanned PDF converted to image frames
                    if (fileManagerData.imageFrames && fileManagerData.imageFrames.length > 0) {
                        return fileManagerData.imageFrames.map(frameData => ({
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${frameData}` }
                        }));
                    }
                    // Case 2: Regular image file (including GIFs that get framed)
                    if (att.type.startsWith('image/')) {
                        try {
                            const result = await electronAPI.getFileAsBase64(att.src);
                            if (result && result.success) {
                                return result.base64Frames.map(frameData => ({
                                    type: 'image_url',
                                    image_url: { url: `data:image/jpeg;base64,${frameData}` }
                                }));
                            } else {
                                const errorMsg = result ? result.error : '未知错误';
                                console.error(`Failed to get Base64 for ${att.name}: ${errorMsg}`);
                                uiHelper.showToastNotification(`处理图片 ${att.name} 失败: ${errorMsg}`, 'error');
                                return null;
                            }
                        } catch (processingError) {
                            console.error(`Exception during getBase64 for ${att.name}:`, processingError);
                            uiHelper.showToastNotification(`处理图片 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                            return null;
                        }
                    }
                    return null; // Not an image or a convertible PDF
                });

                const nestedImageAttachments = await Promise.all(imageAttachmentsPromises);
                const flatImageAttachments = nestedImageAttachments.flat().filter(Boolean);
                vcpImageAttachmentsPayload.push(...flatImageAttachments);

                // --- AUDIO PROCESSING ---
                const supportedAudioTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac'];
                const audioAttachmentsPromises = msg.attachments
                    .filter(att => supportedAudioTypes.includes(att.type))
                    .map(async att => {
                        try {
                            const result = await electronAPI.getFileAsBase64(att.src);
                            if (result && result.success && result.base64Frames.length > 0) {
                                return result.base64Frames.map(frameData => ({
                                    type: 'image_url',
                                    image_url: { url: `data:${att.type};base64,${frameData}` }
                                }));
                            } else {
                                const errorMsg = result ? result.error : '未能获取Base64数据';
                                console.error(`Failed to get Base64 for audio ${att.name}: ${errorMsg}`);
                                uiHelper.showToastNotification(`处理音频 ${att.name} 失败: ${errorMsg}`, 'error');
                                return null;
                            }
                        } catch (processingError) {
                            console.error(`Exception during getBase64 for audio ${att.name}:`, processingError);
                            uiHelper.showToastNotification(`处理音频 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                            return null;
                        }
                    });
                const nestedAudioAttachments = await Promise.all(audioAttachmentsPromises);
                vcpAudioAttachmentsPayload.push(...nestedAudioAttachments.flat().filter(Boolean));

                // --- VIDEO PROCESSING ---
                const videoAttachmentsPromises = msg.attachments
                    .filter(att => att.type.startsWith('video/'))
                    .map(async att => {
                        try {
                            const result = await electronAPI.getFileAsBase64(att.src);
                            if (result && result.success && result.base64Frames.length > 0) {
                                return result.base64Frames.map(frameData => ({
                                    type: 'image_url',
                                    image_url: { url: `data:${att.type};base64,${frameData}` }
                                }));
                            } else {
                                const errorMsg = result ? result.error : '未能获取Base64数据';
                                console.error(`Failed to get Base64 for video ${att.name}: ${errorMsg}`);
                                uiHelper.showToastNotification(`处理视频 ${att.name} 失败: ${errorMsg}`, 'error');
                                return null;
                            }
                        } catch (processingError) {
                            console.error(`Exception during getBase64 for video ${att.name}:`, processingError);
                            uiHelper.showToastNotification(`处理视频 ${att.name} 时发生异常: ${processingError.message}`, 'error');
                            return null;
                        }
                    });
                const nestedVideoAttachments = await Promise.all(videoAttachmentsPromises);
                vcpVideoAttachmentsPayload.push(...nestedVideoAttachments.flat().filter(Boolean));
            }

            let finalContentPartsForVCP = [];
            if (currentMessageTextContent && currentMessageTextContent.trim() !== '') {
                finalContentPartsForVCP.push({ type: 'text', text: currentMessageTextContent });
            }
            finalContentPartsForVCP.push(...vcpImageAttachmentsPayload);
            finalContentPartsForVCP.push(...vcpAudioAttachmentsPayload);
            finalContentPartsForVCP.push(...vcpVideoAttachmentsPayload);

            if (finalContentPartsForVCP.length === 0 && msg.role === 'user') {
                 finalContentPartsForVCP.push({ type: 'text', text: '(用户发送了附件，但无文本或图片内容)' });
            }
            
            return { role: msg.role, content: finalContentPartsForVCP.length > 0 ? finalContentPartsForVCP : msg.content };
        }));

        if (agentConfig.systemPrompt) {
            let systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name);
            const prependedContent = [];

            // 注入聊天记录文件路径
            if (agentConfig.agentDataPath && currentTopicIdVal) {
                const historyPath = `${agentConfig.agentDataPath}\\topics\\${currentTopicIdVal}\\history.json`;
                prependedContent.push(`当前聊天记录文件路径: ${historyPath}`);
            }

            // 注入话题创建时间
            if (agentConfig.topics && currentTopicIdVal) {
                const currentTopicObj = agentConfig.topics.find(t => t.id === currentTopicIdVal);
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

        const modelConfigForVCP = {
            model: agentConfig.model,
            temperature: parseFloat(agentConfig.temperature),
            max_tokens: agentConfig.maxOutputTokens ? parseInt(agentConfig.maxOutputTokens) : undefined,
            contextTokenLimit: agentConfig.contextTokenLimit ? parseInt(agentConfig.contextTokenLimit) : undefined,
            top_p: agentConfig.top_p ? parseFloat(agentConfig.top_p) : undefined,
            top_k: agentConfig.top_k ? parseInt(agentConfig.top_k) : undefined,
            stream: agentConfig.streamOutput === true || String(agentConfig.streamOutput) === 'true'
        };
        
        // 【关键修复】如果使用流式输出，先调用 startStreamingMessage
        if (modelConfigForVCP.stream) {
            contextMenuDependencies.startStreamingMessage({ ...regenerationThinkingMessage, content: "" });
        }

        const context = {
            agentId: currentSelectedItemVal.id,
            topicId: currentTopicIdVal,
            isGroupMessage: false
        };
        
        const vcpResult = await electronAPI.sendToVCP(
            globalSettingsVal.vcpServerUrl,
            globalSettingsVal.vcpApiKey,
            messagesForVCP,
            modelConfigForVCP,
            regenerationThinkingMessage.id,
            false, // isGroupCall - legacy
            context // Pass the correct context
        );

        if (modelConfigForVCP.stream) {
            // 如果流启动失败，vcpResult 会包含错误信息
            if (vcpResult.streamError || !vcpResult.streamingStarted) {
                let detailedError = vcpResult.error || '未能启动流';
                contextMenuDependencies.finalizeStreamedMessage(regenerationThinkingMessage.id, 'error', `VCP 流错误 (重新生成): ${detailedError}`);
            }
        } else {
            // 非流式处理逻辑 - 参考 chatManager.js 的健壮实现
            const { response, context } = vcpResult; // 【修复1】正确解构返回结果
            const isForActiveChat = context && context.agentId === currentSelectedItemVal.id && context.topicId === currentTopicIdVal;

            if (isForActiveChat) {
                contextMenuDependencies.removeMessageById(regenerationThinkingMessage.id, false); // 从UI和内存中移除"思考中"
            }

            if (response.error) {
                if (isForActiveChat) {
                    contextMenuDependencies.renderMessage({ role: 'system', content: `VCP错误 (重新生成): ${response.error}`, timestamp: Date.now() });
                }
            } else if (response.choices && response.choices.length > 0) {
                const assistantMessageContent = response.choices[0].message.content;
                const assistantMessage = {
                    role: 'assistant',
                    name: agentConfig.name,
                    avatarUrl: agentConfig.avatarUrl,
                    avatarColor: agentConfig.avatarCalculatedColor,
                    content: assistantMessageContent,
                    timestamp: Date.now(),
                    id: response.id || `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`
                };

                // 【修复2】采用更健壮的“读-改-写”模式
                const historyForSave = await electronAPI.getChatHistory(context.agentId, context.topicId);
                if (historyForSave && !historyForSave.error) {
                    // 确保历史记录中没有残余的 "thinking" 消息
                    const finalHistory = historyForSave.filter(msg => msg.id !== regenerationThinkingMessage.id && !msg.isThinking);
                    finalHistory.push(assistantMessage);
                    
                    await electronAPI.saveChatHistory(context.agentId, context.topicId, finalHistory);

                    if (isForActiveChat) {
                        mainRefs.currentChatHistoryRef.set(finalHistory);
                        contextMenuDependencies.renderMessage(assistantMessage);
                    }
                } else {
                    console.error(`[ContextMenu] Regenerate failed to get history for saving:`, historyForSave.error);
                     if (isForActiveChat) {
                        contextMenuDependencies.renderMessage({ role: 'system', content: `重新生成失败：无法读取历史记录以保存。`, timestamp: Date.now() });
                    }
                }
            }
            if (isForActiveChat) {
                uiHelper.scrollToBottom();
            }
        }

    } catch (error) {
        contextMenuDependencies.finalizeStreamedMessage(regenerationThinkingMessage.id, 'error', `客户端错误 (重新生成): ${error.message}`);
        if (currentSelectedItemVal.id && currentTopicIdVal) await electronAPI.saveChatHistory(currentSelectedItemVal.id, currentTopicIdVal, currentChatHistoryArray);
        uiHelper.scrollToBottom();
    }
}

function setContextMenuDependencies(newDependencies) {
    contextMenuDependencies = { ...contextMenuDependencies, ...newDependencies };
}

export {
    initializeContextMenu,
    showContextMenu,
    closeContextMenu,
    toggleEditMode,
    handleRegenerateResponse,
    setContextMenuDependencies
};
