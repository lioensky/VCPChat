// modules/chatManager.js

window.chatManager = (() => {
    // --- Private Variables ---
    let electronAPI;
    let uiHelper;
    let messageRenderer;
    let itemListManager;
    let topicListManager;
    let groupRenderer;

    // References to state in renderer.js
    let currentSelectedItemRef;
    let currentTopicIdRef;
    let currentChatHistoryRef;
    let attachedFilesRef;
    let globalSettingsRef;

    // DOM Elements from renderer.js
    let elements = {};
    
    // Functions from main renderer
    let mainRendererFunctions = {};
    let isCanvasWindowOpen = false; // State to track if the canvas window is open
    let lastAssistantSuspendAt = 0;
    let activeHistoryLoadToken = 0;

    function setCurrentItemActionButtonText(button, text) {
        if (!button) return;
        const label = button.querySelector('.button-label');
        if (label) {
            label.textContent = text;
            return;
        }
        button.textContent = text;
    }



    /**
     * 应用单个正则规则到文本
     * @param {string} text - 输入文本
     * @param {Object} rule - 正则规则对象
     * @returns {string} 处理后的文本
     */
    function applyRegexRule(text, rule) {
        if (!rule || !rule.findPattern || typeof text !== 'string') {
            return text;
        }

        try {
            // 使用 uiHelperFunctions.regexFromString 来解析正则表达式
            let regex = null;
            if (window.uiHelperFunctions && window.uiHelperFunctions.regexFromString) {
                regex = window.uiHelperFunctions.regexFromString(rule.findPattern);
            } else {
                // 后备方案：手动解析
                const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
                if (regexMatch) {
                    regex = new RegExp(regexMatch[1], regexMatch[2]);
                } else {
                    regex = new RegExp(rule.findPattern, 'g');
                }
            }
            
            if (!regex) {
                console.error('无法解析正则表达式', rule.findPattern);
                return text;
            }
            
            // 应用替换（如果没有替换内容，则默认替换为空字符串）
            return text.replace(regex, rule.replaceWith || '');
        } catch (error) {
            console.error('应用正则规则时出错', rule.findPattern, error);
            return text;
        }
    }

    /**
     * 应用所有匹配的正则规则到文本
     * @param {string} text - 输入文本
     * @param {Array} rules - 正则规则数组
     * @param {string} scope - 作用域 ('frontend' 或 'context')
     * @param {string} role - 消息角色 ('user' 或 'assistant')
     * @param {number} depth - 消息深度（0 = 最新消息）
     * @returns {string} 处理后的文本
     */
    function applyRegexRules(text, rules, scope, role, depth = 0) {
        if (!rules || !Array.isArray(rules) || typeof text !== 'string') {
            return text;
        }

        let processedText = text;
        
        rules.forEach(rule => {
            // 检查是否应该应用此规则
            
            // 1. 检查作用域
            const shouldApplyToScope =
                (scope === 'context' && rule.applyToContext) ||
                (scope === 'frontend' && rule.applyToFrontend);
            
            if (!shouldApplyToScope) return;
            
            // 2. 检查角色
            const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
            if (!shouldApplyToRole) return;
            
            // 3. 检查深度（-1 表示无限制）
            const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
            const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;
            
            if (!minDepthOk || !maxDepthOk) return;
            
            // 应用规则
            processedText = applyRegexRule(processedText, rule);
        });
        
        return processedText;
    }

    /**
     * Initializes the ChatManager module.
     * @param {object} config - The configuration object.
     */
    function init(config) {
        electronAPI = config.electronAPI;
        uiHelper = config.uiHelper;
        
        // Modules
        messageRenderer = config.modules.messageRenderer;
        itemListManager = config.modules.itemListManager;
        topicListManager = config.modules.topicListManager;
        groupRenderer = config.modules.groupRenderer;

        // State References
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        currentTopicIdRef = config.refs.currentTopicIdRef;
        currentChatHistoryRef = config.refs.currentChatHistoryRef;
        attachedFilesRef = config.refs.attachedFilesRef;
        globalSettingsRef = config.refs.globalSettingsRef;

        // DOM Elements
        elements = config.elements;
        
        // Main Renderer Functions
        mainRendererFunctions = config.mainRendererFunctions;

        console.log('[ChatManager] Initialized successfully.');

        // Listen for Canvas events
        if (electronAPI) {
            electronAPI.onCanvasContentUpdate(handleCanvasContentUpdate);
            electronAPI.onCanvasWindowClosed(handleCanvasWindowClosed);
        }
    }

    /**
     * Saves the last opened item and topic IDs to the settings file.
     * This is a private helper function.
     */
    function _saveLastOpenState() {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const globalSettings = globalSettingsRef.get();

        if (currentSelectedItem && currentSelectedItem.id) {
            const settingsToSave = {
                ...globalSettings, // Preserve existing settings
                lastOpenItemId: currentSelectedItem.id,
                lastOpenItemType: currentSelectedItem.type,
                lastOpenTopicId: currentTopicId,
            };
            // No need to await, let it save in the background
            electronAPI.saveSettings(settingsToSave).catch(err => {
                console.error('[ChatManager] Failed to save last open state:', err);
            });
        }
    }

    function suspendAssistantListenerForTopicLoad(topicId) {
        if (!topicId || !electronAPI || typeof electronAPI.suspendAssistantListener !== 'function') {
            return;
        }

        const now = Date.now();
        if (now - lastAssistantSuspendAt < 200) {
            return;
        }

        const globalSettings = globalSettingsRef && typeof globalSettingsRef.get === 'function'
            ? globalSettingsRef.get()
            : null;

        if (!globalSettings || globalSettings.assistantEnabled !== true) {
            return;
        }

        lastAssistantSuspendAt = now;
        const durationMs = 800 + Math.floor(Math.random() * 701);
        Promise.resolve(electronAPI.suspendAssistantListener(durationMs)).catch((error) => {
            console.warn('[ChatManager] Failed to suspend assistant listener before topic load:', error);
        });
    }

    function normalizeTopicTitle(topicTitle) {
        if (typeof topicTitle !== 'string') return topicTitle;

        const trimmedTitle = topicTitle.trim();
        if (!trimmedTitle) return trimmedTitle;
        if (trimmedTitle.includes('新话题')) return trimmedTitle;

        const timeMatch = trimmedTitle.match(/(\d{1,2}:\d{2}:\d{2})/);
        if (trimmedTitle.includes('新话') && timeMatch) {
            return `新话题 ${timeMatch[1]}`;
        }

        return trimmedTitle;
    }
 
    // --- Functions moved from renderer.js ---
 
    function displayNoItemSelected() {
        const { currentChatNameH3, chatMessagesDiv, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        const voiceChatBtn = document.getElementById('voiceChatBtn');
        currentChatNameH3.textContent = '选择一个 Agent 或群组开始聊天';
        chatMessagesDiv.innerHTML = `<div class="message-item system welcome-bubble"><p>欢迎，请从左侧选择 AI 助手或群组，或创建新的对话。</p></div>`;
        currentItemActionBtn.style.display = 'none';
        if (voiceChatBtn) voiceChatBtn.style.display = 'none';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;
        attachFileBtn.disabled = true;
        if (mainRendererFunctions.displaySettingsForItem) {
            mainRendererFunctions.displaySettingsForItem(); 
        }
        if (topicListManager) topicListManager.loadTopicList();
    }

    async function selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig) {
        // 心流锁激活时，不允许切换Agent
        if (window.flowlockManager && window.flowlockManager.getState && window.flowlockManager.getState().isActive) {
            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification('心流锁运行中，无法切换 Agent。请先停止心流锁。', 'warning');
            }
            console.log('[ChatManager] Blocked agent switch due to active Flowlock');
            return;
        }
        
        // Stop any previous watcher when switching items
        if (electronAPI.watcherStop) {
            await electronAPI.watcherStop();
        }

        const { currentChatNameH3, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        let currentSelectedItem = currentSelectedItemRef.get();
        let currentTopicId = currentTopicIdRef.get();

        if (currentSelectedItem.id === itemId && currentSelectedItem.type === itemType && currentTopicId) {
            console.log(`Item ${itemType} ${itemId} already selected with topic ${currentTopicId}. No change.`);
            return;
        }

        currentSelectedItem = { id: itemId, type: itemType, name: itemName, avatarUrl: itemAvatarUrl, config: itemFullConfig };
        currentSelectedItemRef.set(currentSelectedItem);
        currentTopicIdRef.set(null); // Reset topic
        currentChatHistoryRef.set([]);
        window.updateSendButtonState?.();

        document.querySelectorAll('.topic-list .topic-item.active-topic-glowing').forEach(item => {
            item.classList.remove('active-topic-glowing');
        });

        if (messageRenderer) {
            messageRenderer.setCurrentSelectedItem(currentSelectedItem);
            messageRenderer.setCurrentTopicId(null);
            messageRenderer.setCurrentItemAvatar(itemAvatarUrl);
            messageRenderer.setCurrentItemAvatarColor(itemFullConfig?.avatarCalculatedColor || null);
        }

        if (itemType === 'group' && groupRenderer && typeof groupRenderer.handleSelectGroup === 'function') {
            await groupRenderer.handleSelectGroup(itemId, itemName, itemAvatarUrl, itemFullConfig);
        } else if (itemType === 'agent') {
            if (groupRenderer && typeof groupRenderer.clearInviteAgentButtons === 'function') {
                groupRenderer.clearInviteAgentButtons();
            }
        }
     
        const voiceChatBtn = document.getElementById('voiceChatBtn');

        const itemTypeLabel = itemType === 'group' ? ' (群组)' : '';
        currentChatNameH3.textContent = `与 ${itemName}${itemTypeLabel} 聊天中`;
        setCurrentItemActionButtonText(currentItemActionBtn, itemType === 'group' ? '新建群聊话题' : '新建聊天话题');
        currentItemActionBtn.title = `为 ${itemName} 新建${itemType === 'group' ? '群聊话题' : '聊天话题'}`;
        currentItemActionBtn.style.display = 'inline-flex';
        
        if (voiceChatBtn) {
            voiceChatBtn.style.display = itemType === 'agent' ? 'inline-block' : 'none';
        }

        itemListManager.highlightActiveItem(itemId, itemType);
        if(mainRendererFunctions.displaySettingsForItem) mainRendererFunctions.displaySettingsForItem();

        try {
            let topics;
            if (itemType === 'agent') {
                topics = await electronAPI.getAgentTopics(itemId);
            } else if (itemType === 'group') {
                topics = await electronAPI.getGroupTopics(itemId);
            }

            if (topics && !topics.error && topics.length > 0) {
                let topicToLoadId = topics[0].id;
                const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${itemId}_${itemType}`);
                if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                    topicToLoadId = rememberedTopicId;
                }
                currentTopicIdRef.set(topicToLoadId);
                if (messageRenderer) messageRenderer.setCurrentTopicId(topicToLoadId);
                await loadChatHistory(itemId, itemType, topicToLoadId);
            } else if (topics && topics.error) {
                console.error(`加载 ${itemType} ${itemId} 的话题列表失败`, topics.error);
                if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题列表失败: ${topics.error}`, timestamp: Date.now() });
                await loadChatHistory(itemId, itemType, null);
            } else {
                if (itemType === 'agent') {
                    const agentConfig = await electronAPI.getAgentConfig(itemId);
                    // ⚠️ 检查是否返回错误对象
                    if (agentConfig && agentConfig.error) {
                        console.error(`[ChatManager] Failed to get agent config for ${itemId}:`, agentConfig.error);
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载助手配置失败: ${agentConfig.error}`, timestamp: Date.now() });
                        await loadChatHistory(itemId, itemType, null);
                    } else if (agentConfig && (!agentConfig.topics || agentConfig.topics.length === 0)) {
                        const defaultTopicResult = await electronAPI.createNewTopicForAgent(itemId, "主要对话");
                        if (defaultTopicResult.success) {
                            currentTopicIdRef.set(defaultTopicResult.topicId);
                            if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                            await loadChatHistory(itemId, itemType, defaultTopicResult.topicId);
                        } else {
                            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `创建默认话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                            await loadChatHistory(itemId, itemType, null);
                        }
                    } else {
                         await loadChatHistory(itemId, itemType, null);
                    }
                } else if (itemType === 'group') {
                    const defaultTopicResult = await electronAPI.createNewTopicForGroup(itemId, "主要群聊");
                    if (defaultTopicResult.success) {
                        currentTopicIdRef.set(defaultTopicResult.topicId);
                        if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                        await loadChatHistory(itemId, itemType, defaultTopicResult.topicId);
                    } else {
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `创建默认群聊话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                        await loadChatHistory(itemId, itemType, null);
                    }
                }
            }
        } catch (e) {
            console.error(`选择 ${itemType} ${itemId} 时发生错误: `, e);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `选择${itemType === 'group' ? '群组' : '助手'}时出错: ${e.message}`, timestamp: Date.now() });
        }

        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        attachFileBtn.disabled = false;
        // messageInput.focus();
        if (topicListManager) topicListManager.loadTopicList();
        _saveLastOpenState(); // Save state after selecting an item and its default topic
    }
 
    async function selectTopic(topicId) {
        // 心流锁激活时，不允许切换话题
        if (window.flowlockManager && window.flowlockManager.getState && window.flowlockManager.getState().isActive) {
            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification('心流锁运行中，无法切换话题。请先停止心流锁。', 'warning');
            }
            console.log('[ChatManager] Blocked topic switch due to active Flowlock');
            return;
        }
        
        let currentTopicId = currentTopicIdRef.get();
        if (currentTopicId === topicId) {
            return;
        }

        const currentSelectedItem = currentSelectedItemRef.get();
        if (!currentSelectedItem || !currentSelectedItem.id || !currentSelectedItem.type) {
            console.warn('[ChatManager] Ignored selectTopic: no active item selected yet.');
            return;
        }

        try {
            currentTopicIdRef.set(topicId);
            if (messageRenderer) messageRenderer.setCurrentTopicId(topicId);

            const agentConfigForWatcher = currentSelectedItem.config || currentSelectedItem;
            if (electronAPI.watcherStart && agentConfigForWatcher?.agentDataPath) {
                const historyFilePath = `${agentConfigForWatcher.agentDataPath}\\topics\\${topicId}\\history.json`;
                await electronAPI.watcherStart(historyFilePath, currentSelectedItem.id, topicId);
            }

            document.querySelectorAll('#topicList .topic-item').forEach(item => {
                const isClickedItem = item.dataset.topicId === topicId && item.dataset.itemId === currentSelectedItem.id;
                item.classList.toggle('active', isClickedItem);
                item.classList.toggle('active-topic-glowing', isClickedItem);
            });

            await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, topicId);
            localStorage.setItem(`lastActiveTopic_${currentSelectedItem.id}_${currentSelectedItem.type}`, topicId);
            _saveLastOpenState();
        } catch (error) {
            console.error('[ChatManager] Failed to select topic:', error);
            if (messageRenderer) {
                messageRenderer.renderMessage({
                    role: 'system',
                    content: `打开话题失败: ${error.message}`,
                    timestamp: Date.now()
                });
            }
        }
    }

    async function handleTopicDeletion(remainingTopics) {
        let currentSelectedItem = currentSelectedItemRef.get();
        const config = currentSelectedItem.config || currentSelectedItem;
        config.topics = remainingTopics;
        currentSelectedItemRef.set(currentSelectedItem);

        if (remainingTopics && remainingTopics.length > 0) {
            const newSelectedTopic = remainingTopics.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
            await selectItem(currentSelectedItem.id, currentSelectedItem.type, currentSelectedItem.name, currentSelectedItem.avatarUrl, (currentSelectedItem.config || currentSelectedItem));
            await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, newSelectedTopic.id);
            currentTopicIdRef.set(newSelectedTopic.id);
            if (messageRenderer) messageRenderer.setCurrentTopicId(newSelectedTopic.id);
        } else {
            currentTopicIdRef.set(null);
            if (messageRenderer) {
                messageRenderer.setCurrentTopicId(null);
                messageRenderer.clearChat();
                messageRenderer.renderMessage({ role: 'system', content: '所有话题均已删除。请创建一个新话题。', timestamp: Date.now() });
            }
            await displayTopicTimestampBubble(currentSelectedItem.id, currentSelectedItem.type, null);
        }
    }

    async function loadChatHistory(itemId, itemType, topicId) {
        const loadToken = ++activeHistoryLoadToken;

        const isLoadStillActive = () => loadToken === activeHistoryLoadToken;
        const abortIfStale = () => {
            if (!isLoadStillActive()) {
                console.debug(`[ChatManager] Ignoring stale history load for ${itemType}:${itemId}:${topicId}`);
                return true;
            }
            return false;
        };

        suspendAssistantListenerForTopicLoad(topicId);

        if (messageRenderer) messageRenderer.clearChat();
        currentChatHistoryRef.set([]);
        window.updateSendButtonState?.();
    
    
        document.querySelectorAll('.topic-list .topic-item').forEach(item => {
            const isCurrent = item.dataset.topicId === topicId && item.dataset.itemId === itemId && item.dataset.itemType === itemType;
            item.classList.toggle('active', isCurrent);
            item.classList.toggle('active-topic-glowing', isCurrent);
        });
    
        if (messageRenderer) messageRenderer.setCurrentTopicId(topicId);
        if (abortIfStale()) return;
    
        if (!itemId) {
            const errorMsg = `错误：无法加载聊天记录，${itemType === 'group' ? '群组' : '助手'}ID (${itemId}) 缺失。`;
            console.error(errorMsg);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: errorMsg, timestamp: Date.now() });
            await displayTopicTimestampBubble(null, null, null);
            return;
        }
    
        if (!topicId) {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: '请选择或创建一个话题以开始聊天。', timestamp: Date.now() });
            await displayTopicTimestampBubble(itemId, itemType, null);
            return;
        }
    
        // 核心修改：使用 await 确保加载消息被渲染
        if (messageRenderer) {
            await messageRenderer.renderMessage({ role: 'system', name: '系统', content: '加载聊天记录中...', timestamp: Date.now(), isThinking: true, id: 'loading_history' });
        }
        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        let historyResult;
        if (itemType === 'agent') {
            historyResult = await electronAPI.getChatHistory(itemId, topicId);
        } else if (itemType === 'group') {
            historyResult = await electronAPI.getGroupChatHistory(itemId, topicId);
        }

        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        const currentSelectedItem = currentSelectedItemRef.get();
        const agentConfigForHistory = currentSelectedItem.config || currentSelectedItem;
        if (electronAPI.watcherStart && agentConfigForHistory?.agentDataPath) {
            const historyFilePath = `${agentConfigForHistory.agentDataPath}\\topics\\${topicId}\\history.json`;
            await electronAPI.watcherStart(historyFilePath, itemId, topicId);
        }

        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        if (messageRenderer) messageRenderer.removeMessageById('loading_history');
    
        await displayTopicTimestampBubble(itemId, itemType, topicId);
        if (abortIfStale()) return;
    
        if (historyResult && historyResult.error) {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录失败: ${historyResult.error}`, timestamp: Date.now() });
        } else if (historyResult && historyResult.length > 0) {
            currentChatHistoryRef.set(historyResult);
            window.updateSendButtonState?.();
            if (messageRenderer) {
                // 使用优化的分批渲染策略
                const renderOptions = {
                    initialBatch: 5,    // 首先显示最新的5条消息
                    batchSize: 10,      // 后续每批10条消息
                    batchDelay: 80      // 批次间延迟 80ms，平衡性能和用户体验
                };
                
                console.log(`[ChatManager] 开始加载话题历史，共 ${historyResult.length} 条消息`);
                await messageRenderer.renderHistory(historyResult, renderOptions);
                if (abortIfStale()) return;
                console.log(`[ChatManager] 话题历史加载完成`);
            }
    
        } else if (historyResult) { // History is empty
            currentChatHistoryRef.set([]);
            window.updateSendButtonState?.();
        } else {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录时返回了无效数据。`, timestamp: Date.now() });
        }

        if (abortIfStale()) return;
    
        if (itemId && topicId && !(historyResult && historyResult.error)) {
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, topicId);
        }
    }

    async function removeAttachmentFromMessage(messageId, attachmentIndex) {
        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const currentSelectedItem = currentSelectedItemRef.get();

        if (!currentChatHistory || !currentTopicId || !currentSelectedItem) {
            console.error('[ChatManager] Cannot remove attachment: missing state.');
            return;
        }

        const messageIndex = currentChatHistory.findIndex(m => m.id === messageId);
        if (messageIndex === -1) {
            console.error('[ChatManager] Message not found in history:', messageId);
            return;
        }

        const message = currentChatHistory[messageIndex];
        if (message.attachments && message.attachments[attachmentIndex]) {
            const attachmentToRemove = message.attachments[attachmentIndex];
            const fileName = attachmentToRemove.name;
            const updatedHistory = JSON.parse(JSON.stringify(currentChatHistory));
            const updatedMessage = updatedHistory[messageIndex];

            updatedMessage.attachments.splice(attachmentIndex, 1);

            if (updatedMessage.content && fileName) {
                const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const genericRegex = new RegExp(`\\n*\\s*\\[附加文件: [^\\]]*${escapedFileName}[^\\]]*\\]`, 'g');
                const imageRegex = new RegExp(`\\n*\\s*\\[附加图片: [^\\]]*${escapedFileName}[^\\]]*\\]`, 'g');
                const fullBlockRegex = new RegExp(`\\n*\\s*\\[附加文件: [^\\]]*${escapedFileName}[^\\]]*\\][\\s\\S]*?\\[/附加文件结束: [^\\]]*${escapedFileName}[^\\]]*\\]`, 'g');

                updatedMessage.content = updatedMessage.content
                    .replace(fullBlockRegex, '')
                    .replace(genericRegex, '')
                    .replace(imageRegex, '')
                    .trim();
            }

            try {
                await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, updatedHistory);
                currentChatHistoryRef.set(updatedHistory);

                if (messageRenderer && typeof messageRenderer.updateMessageUI === 'function') {
                    await messageRenderer.updateMessageUI(messageId, updatedMessage);
                } else {
                    await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId);
                }

                if (uiHelper && uiHelper.showToastNotification) {
                    uiHelper.showToastNotification('附件已移除', 'success');
                }
            } catch (error) {
                console.error('[ChatManager] Failed to remove attachment:', error);
            }
        }
    }

    async function processFilesData(files) {
        if (!files || files.length === 0) return [];

        console.log(`[ChatManager] Processing ${files.length} files...`);
        const filesToProcess = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            filesToProcess.push(new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const arrayBuffer = e.target.result;
                    if (!arrayBuffer) {
                        console.warn(`[ChatManager] FileReader received null ArrayBuffer for ${file.name}`);
                        resolve({ name: file.name, error: '无法读取文件内容' });
                        return;
                    }

                    const fileBuffer = new Uint8Array(arrayBuffer);
                    resolve({
                        name: file.name,
                        type: file.type || 'application/octet-stream',
                        data: fileBuffer,
                        size: file.size,
                        path: file.path,
                    });
                };
                reader.onerror = (err) => {
                    console.error(`[ChatManager] FileReader error for ${file.name}:`, err);
                    resolve({ name: file.name, error: `无法读取文件: ${err.message}` });
                };
                reader.readAsArrayBuffer(file);
            }));
        }

        return await Promise.all(filesToProcess);
    }

    async function addAttachmentsToMessage(messageId, droppedFilesData) {
        console.log(`[ChatManager] addAttachmentsToMessage triggered for messageId: ${messageId}`, droppedFilesData);

        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const currentSelectedItem = currentSelectedItemRef.get();

        if (!currentChatHistory || !currentTopicId || !currentSelectedItem) {
            console.error('[ChatManager] Context missing:', {
                hasHistory: !!currentChatHistory,
                currentTopicId,
                selectedItem: currentSelectedItem?.id,
            });
            return;
        }

        const messageIndex = currentChatHistory.findIndex(m => m.id === messageId);
        if (messageIndex === -1) {
            console.error(`[ChatManager] Message with ID ${messageId} not found in current history.`);
            return;
        }

        try {
            const results = await electronAPI.handleFileDrop(currentSelectedItem.id, currentTopicId, droppedFilesData);

            const successfulAttachments = results
                .filter(r => r.success && r.attachment)
                .map(r => ({
                    ...r.attachment,
                    name: r.name,
                    src: r.attachment.internalPath,
                }));

            if (successfulAttachments.length === 0) {
                if (uiHelper && uiHelper.showToastNotification) {
                    uiHelper.showToastNotification('附件添加失败：无法处理文件', 'error');
                }
                return;
            }

            const updatedHistory = JSON.parse(JSON.stringify(currentChatHistory));
            const message = updatedHistory[messageIndex];
            if (!message.attachments) message.attachments = [];
            message.attachments.push(...successfulAttachments);

            await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, updatedHistory);
            currentChatHistoryRef.set(updatedHistory);

            if (messageRenderer && typeof messageRenderer.updateMessageUI === 'function') {
                await messageRenderer.updateMessageUI(messageId, message);
            } else {
                await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId);
            }

            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification(`成功添加 ${successfulAttachments.length} 个附件`, 'success');
            }
        } catch (error) {
            console.error('[ChatManager] Failed to add attachments:', error);
            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification(`附件添加出错: ${error.message}`, 'error');
            }
        }
    }

    async function displayTopicTimestampBubble(itemId, itemType, topicId) {
        const { chatMessagesDiv } = elements;
        const chatMessagesContainer = document.querySelector('.chat-messages-container');

        if (!chatMessagesDiv || !chatMessagesContainer) {
            console.warn('[displayTopicTimestampBubble] Missing chatMessagesDiv or chatMessagesContainer.');
            const existingBubble = document.getElementById('topicTimestampBubble');
            if (existingBubble) existingBubble.style.display = 'none';
            return;
        }

        let timestampBubble = document.getElementById('topicTimestampBubble');
        if (!timestampBubble) {
            timestampBubble = document.createElement('div');
            timestampBubble.id = 'topicTimestampBubble';
            timestampBubble.className = 'topic-timestamp-bubble';
            if (chatMessagesDiv.firstChild) {
                chatMessagesDiv.insertBefore(timestampBubble, chatMessagesDiv.firstChild);
            } else {
                chatMessagesDiv.appendChild(timestampBubble);
            }
        } else {
            if (chatMessagesDiv.firstChild !== timestampBubble) {
                chatMessagesDiv.insertBefore(timestampBubble, chatMessagesDiv.firstChild);
            }
        }

        if (!itemId || !topicId) {
            timestampBubble.style.display = 'none';
            return;
        }

        try {
            let itemConfigFull;
            if (itemType === 'agent') {
                itemConfigFull = await electronAPI.getAgentConfig(itemId);
            } else if (itemType === 'group') {
                itemConfigFull = await electronAPI.getAgentGroupConfig(itemId);
            }

            if (itemConfigFull && !itemConfigFull.error && itemConfigFull.topics) {
                const currentTopicObj = itemConfigFull.topics.find(t => t.id === topicId);
                if (currentTopicObj && currentTopicObj.createdAt) {
                    const date = new Date(currentTopicObj.createdAt);
                    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    timestampBubble.textContent = `话题创建于 ${formattedDate}`;
                    timestampBubble.style.display = 'block';
                } else {
                    console.warn(`[displayTopicTimestampBubble] Topic ${topicId} not found or has no createdAt for ${itemType} ${itemId}.`);
                    timestampBubble.style.display = 'none';
                }
            } else {
                console.error('[displayTopicTimestampBubble] Could not load config or topics for', itemType, itemId, 'Error:', itemConfigFull?.error);
                timestampBubble.style.display = 'none';
            }
        } catch (error) {
            console.error('[displayTopicTimestampBubble] Error fetching topic creation time for', itemType, itemId, 'topic', topicId, ':', error);
            timestampBubble.style.display = 'none';
        }
    }

    async function attemptTopicSummarizationIfNeeded() {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();

        if (currentSelectedItem.type !== 'agent' || currentChatHistory.length < 4 || !currentTopicId) return;

        try {
            // 强制从文件系统重新加载最新的配置，确保标题检查的准确性
            const agentConfigForSummary = await electronAPI.getAgentConfig(currentSelectedItem.id);
            if (!agentConfigForSummary || agentConfigForSummary.error) {
                console.error('[TopicSummary] Failed to get fresh agent config for summarization:', agentConfigForSummary?.error);
                return;
            }
            // 使用最新的配置更新内存中的状态，以保持同步
            if (currentSelectedItem.config) {
                currentSelectedItem.config = agentConfigForSummary;
            } else {
                Object.assign(currentSelectedItem, agentConfigForSummary);
            }
            currentSelectedItemRef.set(currentSelectedItem);

            const topics = agentConfigForSummary.topics || [];
            const currentTopicObject = topics.find(t => t.id === currentTopicId);
            const existingTopicTitle = currentTopicObject ? currentTopicObject.name : "主要对话";
            const currentAgentName = agentConfigForSummary.name || 'AI';

            if (existingTopicTitle === "主要对话" || existingTopicTitle.startsWith("新话题")) {
                if (messageRenderer && typeof messageRenderer.summarizeTopicFromMessages === 'function') {
                    const summarizedTitle = await messageRenderer.summarizeTopicFromMessages(currentChatHistory.filter(m => !m.isThinking), currentAgentName);
                    if (summarizedTitle) {
                        const saveResult = await electronAPI.saveAgentTopicTitle(currentSelectedItem.id, currentTopicId, summarizedTitle);
                        if (saveResult.success) {
                            // 标题已保存到文件，现在更新内存中的对象以立即反映更改
                            if (currentTopicObject) {
                                currentTopicObject.name = summarizedTitle;
                            }
                            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                                if (topicListManager) topicListManager.loadTopicList();
                            }
                        } else {
                            console.error(`[TopicSummary] Failed to save new topic title "${summarizedTitle}":`, saveResult.error);
                        }
                    }
                } else {
                    console.error('[TopicSummary] summarizeTopicFromMessages function is not defined or not accessible via messageRenderer.');
                }
            }
        } catch (error) {
            console.error('[TopicSummary] Error during attemptTopicSummarizationIfNeeded:', error);
        }
    }

    async function handleSendMessage() {
        const { messageInput } = elements;
        let content = messageInput.value; // Use let as it might be modified
        const attachedFiles = attachedFilesRef.get();
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const globalSettings = globalSettingsRef.get();

        if (!content && attachedFiles.length === 0) return;
        if (!currentSelectedItem.id || !currentTopicId) {
            uiHelper.showToastNotification('请先选择一个项目和话题。', 'error');
            return;
        }
        if (!globalSettings.vcpServerUrl) {
            uiHelper.showToastNotification('请先在全局设置中配置 VCP 服务器 URL。', 'error');
            uiHelper.openModal('globalSettingsModal');
            return;
        }

        if (currentSelectedItem.type === 'group') {
            if (groupRenderer && typeof groupRenderer.handleSendGroupMessage === 'function') {
                groupRenderer.handleSendGroupMessage(
                    currentSelectedItem.id,
                    currentTopicId,
                    { text: content, attachments: attachedFiles.map(af => ({ type: af.file.type, src: af.localPath, name: af.originalName, size: af.file.size })) },
                    globalSettings.userName || '用户'
                );
            } else {
                uiHelper.showToastNotification("群聊功能模块未加载，无法发送消息。", 'error');
            }
            messageInput.value = '';
            attachedFilesRef.set([]);
            if(mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
            uiHelper.autoResizeTextarea(messageInput);
            // messageInput.focus();
            return;
        }

        // --- Standard Agent Message Sending ---
        // The 'content' variable still holds the user's raw input, including the placeholder.
        // We will resolve the placeholder later, only for the final message sent to VCP.
        let combinedTextContent = content; // 用于发送给VCP的组合文本内容
 
        const uiAttachments = [];
        if (attachedFiles.length > 0) {
            for (const af of attachedFiles) {
                const fileManagerData = af._fileManagerData || {};
                uiAttachments.push({
                    type: fileManagerData.type,
                    src: af.localPath,
                    name: af.originalName,
                    size: af.file.size,
                    _fileManagerData: fileManagerData
                });

                // 修正：将文件路径和提取的文本正确地附加到 combinedTextContent
                const filePathForContext = af.localPath || af.originalName;

                if (af.file.type.startsWith('image/')) {
                    // 对于图片，我们只附加路径，因为内容将作为多模态部分发送
                    combinedTextContent += `\n\n[附加图片: ${filePathForContext}]`;
                } else if (fileManagerData.extractedText) {
                    // 对于有提取文本的文件，同时附加路径和文本
                    combinedTextContent += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${af.originalName}]`;
                } else {
                    // 对于其他文件（如音频、视频、无文本的PDF等），只附加路径
                    combinedTextContent += `\n\n[附加文件: ${filePathForContext}]`;
                }
            }
        }

        const userMessage = {
            role: 'user',
            name: globalSettings.userName || '用户',
            content: content, // Use raw content for UI
            timestamp: Date.now(),
            id: `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
            attachments: uiAttachments
        };
        
        if (messageRenderer) {
            await messageRenderer.renderMessage(userMessage);
        }
        // Manually update history after rendering
        const currentChatHistory = currentChatHistoryRef.get();
        currentChatHistory.push(userMessage);
        currentChatHistoryRef.set(currentChatHistory);

        // Save history with the user message before adding the thinking message or making API calls
        await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistory);

        // After saving history (which marks the topic as read), refresh the unread counts.
        if (itemListManager && typeof itemListManager.refreshUnreadCounts === 'function') {
            itemListManager.refreshUnreadCounts();
        } else if (itemListManager) {
            itemListManager.loadItems();
        }

        messageInput.value = '';
        attachedFilesRef.set([]);
        if(mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
        
        // After sending, if the canvas window is still open, restore the placeholder
        if (isCanvasWindowOpen) {
            messageInput.value = CANVAS_PLACEHOLDER;
        }
        uiHelper.autoResizeTextarea(messageInput);
        // messageInput.focus(); // 核心修正：注释掉此行。这是导致AI流式输出时，即使向上滚动也会被强制拉回底部的根源。

        const thinkingMessageId = `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
        const thinkingMessage = {
            role: 'assistant',
            name: currentSelectedItem.name || currentSelectedItem.id || 'AI', // 修复：使用 ID 作为更可靠的回退
            content: '思考中',
            timestamp: Date.now(),
            id: thinkingMessageId,
            isThinking: true,
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };

        let thinkingMessageItem = null;
        if (messageRenderer) {
            thinkingMessageItem = await messageRenderer.renderMessage(thinkingMessage);
        }
        // Manually update history with the thinking message
        const currentChatHistoryWithThinking = currentChatHistoryRef.get();
        currentChatHistoryWithThinking.push(thinkingMessage);
        currentChatHistoryRef.set(currentChatHistoryWithThinking);
        window.updateSendButtonState?.();

        try {
            const agentConfig = currentSelectedItem.config || currentSelectedItem;
            const currentChatHistory = currentChatHistoryRef.get();
            const historySnapshotForVCP = currentChatHistory.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);

            const messagesForVCP = await Promise.all(historySnapshotForVCP.map(async msg => {
                let vcpImageAttachmentsPayload = [];
                let vcpAudioAttachmentsPayload = [];
                let vcpVideoAttachmentsPayload = [];
                let currentMessageTextContent = msg.content;

                // --- 应用正则规则（后端上下文）---
                if (agentConfig?.stripRegexes && Array.isArray(agentConfig.stripRegexes) && agentConfig.stripRegexes.length > 0) {
                    // --- 按“对话轮次”计算深度 ---
                    const turns = [];
                    for (let i = historySnapshotForVCP.length - 1; i >= 0; i--) {
                        if (historySnapshotForVCP[i].role === 'assistant') {
                            const turn = { assistant: historySnapshotForVCP[i], user: null };
                            if (i > 0 && historySnapshotForVCP[i - 1].role === 'user') {
                                turn.user = historySnapshotForVCP[i - 1];
                                i--; // 跳过用户消息，因为已经配对
                            }
                            turns.unshift(turn);
                        } else if (historySnapshotForVCP[i].role === 'user') {
                            // 处理末尾的单个用户消息
                            turns.unshift({ assistant: null, user: historySnapshotForVCP[i] });
                        }
                    }
                    
                    // 找到当前消息所在的轮次
                    const turnIndex = turns.findIndex(t => (t.assistant && t.assistant.id === msg.id) || (t.user && t.user.id === msg.id));
                    const depth = turnIndex !== -1 ? (turns.length - 1 - turnIndex) : -1;

                    if (depth !== -1) {
                        // 应用规则到消息内容
                        currentMessageTextContent = applyRegexRules(
                            currentMessageTextContent,
                            agentConfig.stripRegexes,
                            'context',  // 这里处理的是发送给AI的上下文
                            msg.role,
                            depth
                        );
                    }
                    // --- 深度计算和应用结果 ---
                }
                // --- 正则规则应用结束 ---

                if (msg.role === 'user' && msg.id === userMessage.id) {
                    // 关键修复：使用已经包含附件内容的 combinedTextContent
                    currentMessageTextContent = combinedTextContent;
                    
                    // IMPORTANT: We need to handle Canvas placeholder WITHOUT overwriting the combined content
                    // First, check if we need to replace Canvas placeholder
                    if (currentMessageTextContent.includes(CANVAS_PLACEHOLDER)) {
                        try {
                            const canvasData = await electronAPI.getLatestCanvasContent();
                            if (canvasData && !canvasData.error) {
                                const formattedCanvasContent = `\n[Canvas Content]\n${canvasData.content || ''}\n[Canvas Path]\n${canvasData.path || 'No file path'}\n[Canvas Errors]\n${canvasData.errors || 'No errors'}\n`;
                                // Replace Canvas placeholder in the combined content
                                currentMessageTextContent = currentMessageTextContent.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), formattedCanvasContent);
                            } else {
                                console.error("Failed to get latest canvas content:", canvasData?.error);
                                currentMessageTextContent = currentMessageTextContent.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), '\n[Canvas content could not be loaded]\n');
                            }
                        } catch (error) {
                            console.error("Error fetching canvas content:", error);
                            currentMessageTextContent = currentMessageTextContent.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), '\n[Error loading canvas content]\n');
                        }
                    }
                } else if (msg.attachments && msg.attachments.length > 0) {
                    let historicalAppendedText = "";
                    for (const att of msg.attachments) {
                        const fileManagerData = att._fileManagerData || {};
                        // 优先使用 att.src，因为它代表前端的本地可访问路径
                        // 后备为 internalPath（来自 fileManager），最后才是文件名
                        const filePathForContext = att.src || (fileManagerData.internalPath ? fileManagerData.internalPath.replace('file://', '') : (att.name || '未知文件'));

                        if (fileManagerData.imageFrames && fileManagerData.imageFrames.length > 0) {
                             historicalAppendedText += `\n\n[附加文件: ${filePathForContext} (扫描版PDF，已转换为图片)]`;
                        } else if (fileManagerData.extractedText) {
                            historicalAppendedText += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${att.name || '未知文件'}]`;
                        } else {
                            // 对于没有提取文本的文件（如音视频），只附加路径
                            historicalAppendedText += `\n\n[附加文件: ${filePathForContext}]`;
                        }
                    }
                    currentMessageTextContent += historicalAppendedText;
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
                                if (result && result.success) {
                                    return result.base64Frames.map(frameData => ({
                                        type: 'image_url',
                                        image_url: { url: `data:${att.type};base64,${frameData}` }
                                    }));
                                } else {
                                    const errorMsg = result ? result.error : '未知错误';
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
                                if (result && result.success) {
                                    return result.base64Frames.map(frameData => ({
                                        type: 'image_url',
                                        image_url: { url: `data:${att.type};base64,${frameData}` }
                                    }));
                                } else {
                                    const errorMsg = result ? result.error : '未知错误';
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

            if (agentConfig && agentConfig.systemPrompt) {
                let systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || currentSelectedItem.id);
                const prependedContent = [];

                // 任务2: 注入聊天记录文件路径
                // 假设 agentConfig 对象中包含一个 agentDataPath 属性，该属性由主进程在加载代理配置时提供。
                if (agentConfig.agentDataPath && currentTopicId) {
                    // 修正：currentTopicId 本身就包含 "topic_" 前缀，无需重复添加
                    const historyPath = `${agentConfig.agentDataPath}\\topics\\${currentTopicId}\\history.json`;
                    prependedContent.push(`当前聊天记录文件路径: ${historyPath}`);
                }

                // 任务1: 注入话题创建时间
                if (agentConfig.topics && currentTopicId) {
                    const currentTopicObj = agentConfig.topics.find(t => t.id === currentTopicId);
                    if (currentTopicObj && currentTopicObj.createdAt) {
                        const date = new Date(currentTopicObj.createdAt);
                        const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                        prependedContent.push(`当前话题创建于 ${formattedDate}`);
                    }
                }

                if (prependedContent.length > 0) {
                    systemPromptContent = prependedContent.join('\n') + '\n\n' + systemPromptContent;
                }

                messagesForVCP.unshift({ role: 'system', content: systemPromptContent });
            }

            const useStreaming = (agentConfig && agentConfig.streamOutput !== undefined) ? (agentConfig.streamOutput === true || agentConfig.streamOutput === 'true') : true;
            const modelConfigForVCP = {
                model: (agentConfig && agentConfig.model) ? agentConfig.model : 'gemini-pro',
                temperature: (agentConfig && agentConfig.temperature !== undefined) ? parseFloat(agentConfig.temperature) : 0.7,
                ...(agentConfig && agentConfig.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
                ...(agentConfig && agentConfig.contextTokenLimit !== undefined && agentConfig.contextTokenLimit !== null && { contextTokenLimit: parseInt(agentConfig.contextTokenLimit) }),
                ...(agentConfig && agentConfig.top_p !== undefined && agentConfig.top_p !== null && { top_p: parseFloat(agentConfig.top_p) }),
                ...(agentConfig && agentConfig.top_k !== undefined && agentConfig.top_k !== null && { top_k: parseInt(agentConfig.top_k) }),
                stream: useStreaming
            };

            if (useStreaming) {
                if (messageRenderer) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    // Pass the created DOM element directly to avoid race conditions with querySelector
                    await messageRenderer.startStreamingMessage({ ...thinkingMessage, content: "" }, thinkingMessageItem);
                }
            }

            const context = {
                agentId: currentSelectedItem.id,
                agentName: currentSelectedItem.name || currentSelectedItem.id, // 修复：为单聊上下文添加 agentName，并使用 ID 作为回退
                topicId: currentTopicId,
                isGroupMessage: false
            };

            const vcpResponse = await electronAPI.sendToVCP(
                globalSettings.vcpServerUrl,
                globalSettings.vcpApiKey,
                messagesForVCP,
                modelConfigForVCP,
                thinkingMessage.id,
                false, // isGroupCall - legacy, will be ignored by new handler but kept for safety
                context // The new context object
            );

            if (!useStreaming) {
                const response = vcpResponse?.response ?? vcpResponse;
                const responseContext = vcpResponse?.context ?? context;
                const currentSelectedItem = currentSelectedItemRef.get();
                const currentTopicId = currentTopicIdRef.get();

                // Determine if the response is for the currently active chat
                const isForActiveChat = responseContext && responseContext.agentId === currentSelectedItem.id && responseContext.topicId === currentTopicId;

                if (isForActiveChat) {
                    // If it's for the active chat, update the UI as usual
                    if (messageRenderer) messageRenderer.removeMessageById(thinkingMessage.id);
                }

                if (!response) {
                    throw new Error('VCP returned an empty response.');
                }

                if (response.error) {
                    if (isForActiveChat && messageRenderer) {
                        messageRenderer.renderMessage({ role: 'system', content: `VCP错误: ${response.error}`, timestamp: Date.now() });
                    }
                    console.error(`[ChatManager] VCP Error for background message:`, response.error);
                } else if (response.choices && response.choices.length > 0) {
                    const assistantMessageContent = response.choices[0].message.content;
                    const assistantMessage = {
                        role: 'assistant',
                        name: responseContext?.agentName || responseContext?.agentId || 'AI', // 修复：使用 context 中的 agentName 或 agentId 作为回退
                        avatarUrl: currentSelectedItem.avatarUrl, // This might be incorrect if user switched, but it's a minor UI detail for background saves.
                        avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor,
                        content: assistantMessageContent,
                        timestamp: Date.now(),
                        id: `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`
                    };

                    // Fetch the correct history from the file, update it, and save it back.
                    const historyForSave = await electronAPI.getChatHistory(responseContext.agentId, responseContext.topicId);
                    if (historyForSave && !historyForSave.error) {
                        // Remove any lingering 'thinking' message and add the new one
                        const finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessage.id && !msg.isThinking);
                        finalHistory.push(assistantMessage);
                        
                        // Save the final, complete history to the correct file
                        await electronAPI.saveChatHistory(responseContext.agentId, responseContext.topicId, finalHistory);

                        if (isForActiveChat) {
                            // If it's the active chat, also update the UI and in-memory state
                            currentChatHistoryRef.set(finalHistory);
                            window.updateSendButtonState?.();
                            if (messageRenderer) messageRenderer.renderMessage(assistantMessage);
                            await attemptTopicSummarizationIfNeeded();
                        } else {
                            console.log(`[ChatManager] Saved non-streaming response for background chat: Agent ${responseContext.agentId}, Topic ${responseContext.topicId}`);
                        }
                    } else {
                         console.error(`[ChatManager] Failed to get history for background save:`, historyForSave.error);
                    }
                } else {
                    if (isForActiveChat && messageRenderer) {
                        messageRenderer.renderMessage({ role: 'system', content: 'VCP 返回了未知格式的响应。', timestamp: Date.now() });
                    }
                }
            } else {
                if (vcpResponse && vcpResponse.streamError) {
                    console.error("Streaming setup failed in main process:", vcpResponse.errorDetail || vcpResponse.error);
                } else if (vcpResponse && !vcpResponse.streamingStarted && !vcpResponse.streamError) {
                    console.warn("Expected streaming to start, but main process returned non-streaming or error:", vcpResponse);
                    if (messageRenderer) messageRenderer.removeMessageById(thinkingMessage.id); // This will also remove from history
                    if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: '请求流式回复失败，收到非流式响应或错误。', timestamp: Date.now() });
                    // No need to save again here as removeMessageById handles it if configured
                }
            }
        } catch (error) {
            console.error('发送消息或处理VCP响应时出错', error);
            if (messageRenderer) messageRenderer.removeMessageById(thinkingMessage.id);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
            if(currentSelectedItem.id && currentTopicId) {
                await electronAPI.saveChatHistory(currentSelectedItem.id, currentTopicId, currentChatHistoryRef.get().filter(msg => !msg.isThinking));
            }
        }
    }

    async function createNewTopicForItem(itemId, itemType) {
        if (!itemId) {
            uiHelper.showToastNotification("请先选择一个项目。", 'error');
            return;
        }
        
        const currentSelectedItem = currentSelectedItemRef.get();
        const itemName = currentSelectedItem.name || (itemType === 'group' ? "当前群组" : "当前助手");
        const newTopicName = `新话题 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        
        try {
            let result;
            if (itemType === 'agent') {
                result = await electronAPI.createNewTopicForAgent(itemId, newTopicName);
            } else if (itemType === 'group') {
                result = await electronAPI.createNewTopicForGroup(itemId, newTopicName);
            }

            if (result && result.success && result.topicId) {
                currentTopicIdRef.set(result.topicId);
                currentChatHistoryRef.set([]);
                window.updateSendButtonState?.();

                if (messageRenderer) {
                    messageRenderer.setCurrentTopicId(result.topicId);
                    messageRenderer.clearChat();
                    // messageRenderer.renderMessage({ role: 'system', content: `新话题 "${result.topicName}" 已开始。`, timestamp: Date.now() });
                }
                localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, result.topicId);
                
                // 🔧 关键修复：为新建的话题启动文件监听器
                const agentConfigForWatcher = currentSelectedItem.config || currentSelectedItem;
                if (electronAPI.watcherStart && agentConfigForWatcher?.agentDataPath) {
                    const historyFilePath = `${agentConfigForWatcher.agentDataPath}\\topics\\${result.topicId}\\history.json`;
                    await electronAPI.watcherStart(historyFilePath, itemId, result.topicId);
                    console.log(`[ChatManager] Started file watcher for new topic: ${result.topicId}`);
                }
                
                if (document.getElementById('tabContentTopics').classList.contains('active')) {
                    if (topicListManager) await topicListManager.loadTopicList();
                }
                
                await displayTopicTimestampBubble(itemId, itemType, result.topicId);
                // elements.messageInput.focus();
            } else {
                uiHelper.showToastNotification(`创建新话题失败: ${result ? result.error : '未知错误'}`, 'error');
            }
        } catch (error) {
            console.error(`创建新话题时出错:`, error);
            uiHelper.showToastNotification(`创建新话题时出错: ${error.message}`, 'error');
        }
    }


    async function handleCreateBranch(selectedMessage) {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const currentChatHistory = currentChatHistoryRef.get();
        const itemType = currentSelectedItem.type;

        if ((itemType !== 'agent' && itemType !== 'group') || !currentSelectedItem.id || !currentTopicId || !selectedMessage) {
            uiHelper.showToastNotification("无法创建分支：当前非 Agent/群组聊天或缺少必要信息。", 'error');
            return;
        }

        const messageId = selectedMessage.id;
        const messageIndex = currentChatHistory.findIndex(msg => msg.id === messageId);

        if (messageIndex === -1) {
            uiHelper.showToastNotification("无法创建分支：在当前聊天记录中未找到选定消息。", 'error');
            return;
        }

        const historyForNewBranch = currentChatHistory.slice(0, messageIndex + 1);
        if (historyForNewBranch.length === 0) {
            uiHelper.showToastNotification("无法创建分支：没有可用于创建分支的消息。", 'error');
            return;
        }

        try {
            let itemConfig, originalTopic, createResult, saveResult;
            const itemId = currentSelectedItem.id;

            if (itemType === 'agent') {
                itemConfig = await electronAPI.getAgentConfig(itemId);
            } else { // group
                itemConfig = await electronAPI.getAgentGroupConfig(itemId);
            }

            if (!itemConfig || itemConfig.error) {
                uiHelper.showToastNotification(`创建分支失败：无法获取${itemType === 'agent' ? '助手' : '群组'}配置。${itemConfig?.error || ''}`, 'error');
                return;
            }

            originalTopic = itemConfig.topics.find(t => t.id === currentTopicId);
            const originalTopicName = normalizeTopicTitle(originalTopic ? originalTopic.name : "未命名话题");
            const newBranchTopicName = `${originalTopicName} (分支)`;

            if (itemType === 'agent') {
                createResult = await electronAPI.createNewTopicForAgent(itemId, newBranchTopicName, true);
            } else { // group
                createResult = await electronAPI.createNewTopicForGroup(itemId, newBranchTopicName, true);
            }

            if (!createResult || !createResult.success || !createResult.topicId) {
                uiHelper.showToastNotification(`创建分支话题失败: ${createResult ? createResult.error : '未知错误'}`, 'error');
                return;
            }

            const newTopicId = createResult.topicId;

            if (itemType === 'agent') {
                saveResult = await electronAPI.saveChatHistory(itemId, newTopicId, historyForNewBranch);
            } else { // group
                saveResult = await electronAPI.saveGroupChatHistory(itemId, newTopicId, historyForNewBranch);
            }

            if (!saveResult || !saveResult.success) {
                uiHelper.showToastNotification(`无法将历史记录保存到新的分支话题: ${saveResult ? saveResult.error : '未知错误'}`, 'error');
                // Clean up empty branch topic
                if (itemType === 'agent') {
                    await electronAPI.deleteTopic(itemId, newTopicId);
                } else { // group
                    await electronAPI.deleteGroupTopic(itemId, newTopicId);
                }
                return;
            }

            currentTopicIdRef.set(newTopicId);
            if (messageRenderer) messageRenderer.setCurrentTopicId(newTopicId);
            
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                if (topicListManager) await topicListManager.loadTopicList();
            }
            await loadChatHistory(itemId, itemType, newTopicId);
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, newTopicId);

            uiHelper.showToastNotification(`已成功创建分支话题 "${newBranchTopicName}" 并切换。`);

        } catch (error) {
            console.error("创建分支时发生错误:", error);
            uiHelper.showToastNotification(`创建分支时发生内部错误: ${error.message}`, 'error');
        }
    }

    async function handleForwardMessage(target, content, attachments) {
        const { messageInput } = elements;
        
        // 1. Find the target item's full config to select it
        let targetItemFullConfig;
        if (target.type === 'agent') {
            targetItemFullConfig = await electronAPI.getAgentConfig(target.id);
        } else {
            targetItemFullConfig = await electronAPI.getAgentGroupConfig(target.id);
        }

        if (!targetItemFullConfig || targetItemFullConfig.error) {
            uiHelper.showToastNotification(`转发失败: 无法获取目标配置。`, 'error');
            return;
        }

        // 2. Select the item. This will automatically handle finding the last active topic or creating a new one.
        await selectItem(target.id, target.type, target.name, targetItemFullConfig.avatarUrl, targetItemFullConfig);

        // 3. After a brief delay to allow the UI to update from selectItem, populate and send.
        setTimeout(async () => {
            // 4. Populate the message input and attachments ref
            messageInput.value = content;
            
            const uiAttachments = attachments.map(att => ({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.src,
                originalName: att.name,
                _fileManagerData: att._fileManagerData || {}
            }));
            attachedFilesRef.set(uiAttachments);
            
            // Manually trigger attachment preview update
            if (mainRendererFunctions.updateAttachmentPreview) {
                mainRendererFunctions.updateAttachmentPreview();
            }
            
            // Manually trigger textarea resize
            uiHelper.autoResizeTextarea(messageInput);

            // 5. Call the standard send message handler to trigger the full AI response flow
            await handleSendMessage();

        }, 200); // 200ms delay seems reasonable for UI transition
    }

    // --- Canvas Integration ---
    const CANVAS_PLACEHOLDER = '{{VCPChatCanvas}}';

    function handleCanvasContentUpdate(data) {
        isCanvasWindowOpen = true;
        const { messageInput } = elements;
        // If the canvas is open and there's content, ensure the placeholder is in the input
        if (!messageInput.value.includes(CANVAS_PLACEHOLDER)) {
            // Add a space for better formatting if the input is not empty
            const prefix = messageInput.value.length > 0 ? ' ' : '';
            messageInput.value += prefix + CANVAS_PLACEHOLDER;
            uiHelper.autoResizeTextarea(messageInput);
        }
    }

    function handleCanvasWindowClosed() {
        isCanvasWindowOpen = false;
        const { messageInput } = elements;
        // Remove the placeholder when the window is closed
        if (messageInput.value.includes(CANVAS_PLACEHOLDER)) {
            // Also remove any surrounding whitespace for cleanliness
            messageInput.value = messageInput.value.replace(new RegExp(`\\s*${CANVAS_PLACEHOLDER}\\s*`, 'g'), '').trim();
            uiHelper.autoResizeTextarea(messageInput);
        }
    }


    async function syncHistoryFromFile(itemId, itemType, topicId) {
        if (!messageRenderer) return;

        // 🔧 检查是否有正在进行的编辑操作
        const isEditing = document.querySelector('.message-item-editing');
        if (isEditing) {
            console.log('[Sync] Aborting sync because a message is currently being edited.');
            return;
        }

        // 1. Fetch the latest history from the file
        let newHistory;
        if (itemType === 'agent') {
            newHistory = await electronAPI.getChatHistory(itemId, topicId);
        } else if (itemType === 'group') {
            newHistory = await electronAPI.getGroupChatHistory(itemId, topicId);
        }

        if (!newHistory || newHistory.error) {
            console.error("Sync failed: Could not fetch new history.", newHistory?.error);
            return;
        }

        const oldHistory = currentChatHistoryRef.get();
        let historyInMem = [...oldHistory]; // Create a mutable copy to work with

        const oldHistoryMap = new Map(oldHistory.map(msg => [msg.id, msg]));
        const newHistoryMap = new Map(newHistory.map(msg => [msg.id, msg]));
        const activeStreamingId = window.streamManager ? window.streamManager.getActiveStreamingMessageId() : null;

        // --- Perform UI and Memory updates ---

        // 2. Handle DELETED and MODIFIED messages
        for (const oldMsg of oldHistory) {
            if (oldMsg.id === activeStreamingId) {
                continue; // Protect the currently streaming message
            }
            
            const newMsgData = newHistoryMap.get(oldMsg.id);

            if (!newMsgData) {
                // Message was DELETED from the file
                messageRenderer.removeMessageById(oldMsg.id, false); // Update UI
                const indexToRemove = historyInMem.findIndex(m => m.id === oldMsg.id);
                if (indexToRemove > -1) {
                    historyInMem.splice(indexToRemove, 1); // Update Memory
                }
            } else {
                // Message exists, check for MODIFICATION
                if (JSON.stringify(oldMsg.content) !== JSON.stringify(newMsgData.content)) {
                    if (typeof messageRenderer.updateMessageContent === 'function') {
                        messageRenderer.updateMessageContent(oldMsg.id, newMsgData.content); // Update UI
                    }
                    const indexToUpdate = historyInMem.findIndex(m => m.id === oldMsg.id);
                    if (indexToUpdate > -1) {
                        historyInMem[indexToUpdate] = newMsgData; // Update Memory
                    }
                }
            }
        }

        // 3. Handle ADDED messages
        let messagesWereAdded = false;
        for (const newMsg of newHistory) {
            if (!oldHistoryMap.has(newMsg.id)) {
                // Message was ADDED
                messageRenderer.renderMessage(newMsg, true); // Update UI (true = don't modify history ref inside)
                historyInMem.push(newMsg); // Update Memory
                messagesWereAdded = true;
            }
        }

        // 4. If messages were added or removed, the order might be wrong. Re-sort.
        // Also ensures the streaming message (if any) is at the very end.
        historyInMem.sort((a, b) => {
            if (a.id === activeStreamingId) return 1;
            if (b.id === activeStreamingId) return -1;
            return a.timestamp - b.timestamp;
        });

        // 5. Commit the fully merged and sorted history back to the ref. This is the new source of truth.
        currentChatHistoryRef.set(historyInMem);

        // If messages were added, the DOM order might be incorrect. A full re-render is safest
        // but can cause flicker. For now, we accept this as the individual DOM operations
        // are faster. A subsequent topic load will fix any visual misordering.
        if (messagesWereAdded) {
             console.log('[Sync] New messages were added. DOM might require a refresh to be perfectly ordered.');
        }
    }



    // --- Public API ---
    return {
        init,
        selectItem,
        selectTopic,
        handleTopicDeletion,
        loadChatHistory,
        handleSendMessage,
        createNewTopicForItem,
        displayNoItemSelected,
        attemptTopicSummarizationIfNeeded,
        handleCreateBranch,
        handleForwardMessage,
        removeAttachmentFromMessage,
        addAttachmentsToMessage,
        processFilesData,
        syncHistoryFromFile, // Expose the new function
    };
})();

