// modules/chatManager.js
import {
    buildDefaultMessageContent,
    createSingleChatRequestOrchestrator,
    updateFirstTextPart,
} from './chat/singleChatRequestOrchestrator.js';

export const chatManager = (() => {
    // --- Private Variables ---
    let electronAPI;
    let uiHelper;
    let messageRenderer;
    let chatDomRenderer;
    let itemListManager;
    let topicListManager;
    let groupRenderer;
    let streamProjection;
    let interruptCapability;

    // References to state in renderer.js
    let currentSelectedItemRef;
    let currentTopicIdRef;
    let currentChatHistoryRef;
    let attachedFilesRef;
    let globalSettingsRef;
    let chatContext;
    let chatRepository;
    let historyMutationAuthority;
    let streamConsumerRegistry;
    let singleChatRequestOrchestrator;

    function requireHistoryRepository() {
        if (!chatRepository) throw new Error('ChatRepository is required for chat history operations');
        return chatRepository;
    }

    function getHistory(itemId, itemType, topicId) {
        const repository = requireHistoryRepository();
        return repository.getHistory(itemId, itemType, topicId);
    }

    function saveHistory(itemId, itemType, topicId, history) {
        if (historyMutationAuthority) {
            return historyMutationAuthority.replace({
                itemId,
                itemType,
                topicId,
                category: 'chat-manager',
            }, history).then(commit => commit.result || { success: true });
        }
        const repository = requireHistoryRepository();
        return repository.saveHistory(itemId, itemType, topicId, history);
    }

    // DOM Elements from renderer.js
    let elements = {};
    
    // Functions from main renderer
    let mainRendererFunctions = {};
    // Narrow capability supplied by the owning Surface. ChatManager must not
    // discover the main-window send button through the ambient window object.
    let notifySendStateChanged = () => {};
    let isCanvasWindowOpen = false; // State to track if the canvas window is open
    let lastAssistantSuspendAt = 0;
    let activeHistoryLoadToken = 0;
    let historySyncGeneration = 0;
    let itemSelectionGeneration = 0;
    let topicSelectionGeneration = 0;
    let topicCreationGeneration = 0;
    let pendingItemSelectionToken = null;
    let emptyStateObserver = null;
    let canvasContentDisposer = null;
    let canvasClosedDisposer = null;
    const forwardTimers = new Set();
    const outgoingPersistenceQueues = new Map();
    const pendingSendContexts = new Set();
    let lastOpenSaveQueue = Promise.resolve();
    let initialized = false;
    let disposed = false;

    function insertAfterMessage(history, ownerMessageId, message) {
        const next = Array.isArray(history) ? [...history] : [];
        if (next.some(entry => entry?.id === message.id)) return next;
        const ownerIndex = ownerMessageId
            ? next.findIndex(entry => entry?.id === ownerMessageId)
            : -1;
        next.splice(ownerIndex >= 0 ? ownerIndex + 1 : next.length, 0, message);
        return next;
    }

    function persistOutgoingUserMessage(sendContext, userMessage) {
        const signature = `${sendContext.agentId}:${sendContext.topicId}`;
        const previous = outgoingPersistenceQueues.get(signature) || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const persisted = await getHistory(sendContext.agentId, sendContext.itemType || 'agent', sendContext.topicId);
            if (!Array.isArray(persisted)) {
                throw new Error(persisted?.error || '读取聊天记录失败');
            }
            const nextHistory = persisted.some(message => message?.id === userMessage.id)
                ? persisted
                : [...persisted, userMessage];
            const saveResult = await saveHistory(
                sendContext.agentId,
                sendContext.itemType || 'agent',
                sendContext.topicId,
                nextHistory
            );
            if (saveResult?.success === false) {
                throw new Error(saveResult.error || '保存聊天记录失败');
            }
            return nextHistory;
        });
        outgoingPersistenceQueues.set(signature, operation);
        operation.finally(() => {
            if (outgoingPersistenceQueues.get(signature) === operation) {
                outgoingPersistenceQueues.delete(signature);
            }
        }).catch(() => {});
        return operation;
    }

    function setCurrentItemActionButtonText(button, text) {
        if (!button) return;
        const label = button.querySelector('.button-label');
        if (label) {
            label.textContent = text;
            return;
        }
        button.textContent = text;
    }

    async function beginHistoryWatcherOperation() {
        try {
            const result = electronAPI.watcherBegin
                ? await electronAPI.watcherBegin()
                : electronAPI.watcherStop
                    ? await electronAPI.watcherStop()
                    : { success: true, token: null };
            if (result?.stale) return result;
            if (result?.success === false) {
                console.warn('[ChatManager] History watcher unavailable; continuing without file watching:', result.error || result);
                return { success: true, degraded: true, token: null, error: result.error };
            }
            return result || { success: true, token: null };
        } catch (error) {
            console.warn('[ChatManager] History watcher unavailable; continuing without file watching:', error);
            return { success: true, degraded: true, token: null, error: error?.message };
        }
    }

    async function startOwnedHistoryWatcher(leaseToken, filePath, itemId, topicId) {
        if (!electronAPI.watcherStart) return { success: true };
        try {
            const result = await electronAPI.watcherStart(filePath, itemId, topicId, leaseToken);
            if (result?.stale) return result;
            if (result?.success === false) {
                console.warn('[ChatManager] Failed to start history watcher; continuing with loaded history:', result.error || result);
                return { success: true, degraded: true, error: result.error };
            }
            return result || { success: true };
        } catch (error) {
            console.warn('[ChatManager] Failed to start history watcher; continuing with loaded history:', error);
            return { success: true, degraded: true, error: error?.message };
        }
    }



    function buildTurnDepthMap(history = []) {
        const turns = [];
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'assistant') {
                const turn = { assistant: history[i], user: null };
                if (i > 0 && history[i - 1].role === 'user') {
                    turn.user = history[i - 1];
                    i--;
                }
                turns.push(turn);
            } else if (history[i].role === 'user') {
                turns.push({ assistant: null, user: history[i] });
            }
        }
        turns.reverse();

        const depthMap = new Map();
        turns.forEach((turn, turnIndex) => {
            const depth = turns.length - 1 - turnIndex;
            if (turn.assistant?.id) {
                depthMap.set(turn.assistant.id, depth);
            }
            if (turn.user?.id) {
                depthMap.set(turn.user.id, depth);
            }
        });
        return depthMap;
    }

    function getCompiledRegex(rule) {
        if (!rule?.findPattern) {
            return null;
        }

        if (window.uiHelperFunctions?.getCompiledRegex) {
            const compiled = window.uiHelperFunctions.getCompiledRegex(rule.findPattern);
            return compiled?.regex || null;
        }

        if (window.uiHelperFunctions?.regexFromString) {
            return window.uiHelperFunctions.regexFromString(rule.findPattern);
        }

        const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
        if (regexMatch) {
            return new RegExp(regexMatch[1], regexMatch[2]);
        }
        return new RegExp(rule.findPattern, 'g');
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
            const regex = getCompiledRegex(rule);
            
            if (!regex) {
                console.error('无法解析正则表达式', rule.findPattern);
                return text;
            }

            regex.lastIndex = 0;
            
            // 应用替换（如果没有替换内容，则默认替换为空字符串）
            return text.replace(regex, rule.replaceWith || '');
        } catch (error) {
            console.error('应用正则规则时出错', rule.findPattern, error);
            return text;
        }
    }

    function getActiveRegexRules(rules, scope, role, depth = 0) {
        if (!rules || !Array.isArray(rules)) {
            return [];
        }

        return rules.filter(rule => {
            if (!rule || rule.enabled === false || !rule.findPattern) return false;

            const shouldApplyToScope =
                (scope === 'context' && rule.applyToContext) ||
                (scope === 'frontend' && rule.applyToFrontend);
            if (!shouldApplyToScope) return false;

            const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
            if (!shouldApplyToRole) return false;

            const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
            const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;
            return minDepthOk && maxDepthOk;
        });
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

        const activeRules = getActiveRegexRules(rules, scope, role, depth);
        if (activeRules.length === 0) {
            return text;
        }

        let processedText = text;
        
        activeRules.forEach(rule => {
            processedText = applyRegexRule(processedText, rule);
        });
        
        return processedText;
    }

    /**
     * Initializes the ChatManager module.
     * @param {object} config - The configuration object.
     */
    function init(config) {
        if (disposed) throw new Error('ChatManager has been disposed');
        initialized = false;
        chatContext = config.chatContext || null;
        chatRepository = config.chatRepository || null;
        historyMutationAuthority = config.historyMutationAuthority || null;
        streamConsumerRegistry = config.streamConsumerRegistry || null;
        if (!chatRepository) throw new Error('ChatManager requires ChatRepository');
        chatDomRenderer = config.chatDomRenderer || null;
        electronAPI = config.electronAPI;
        singleChatRequestOrchestrator = config.singleChatRequestOrchestrator
            || createSingleChatRequestOrchestrator({
                electronAPI,
                tavernEngine: window.TavernRulesEngine,
            });
        uiHelper = config.uiHelper;
        
        // Modules
        messageRenderer = config.modules.messageRenderer;
        itemListManager = config.modules.itemListManager;
        topicListManager = config.modules.topicListManager;
        groupRenderer = config.modules.groupRenderer;
        streamProjection = config.modules.streamManager || null;
        interruptCapability = config.modules.interruptHandler || null;

        // State References
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        currentTopicIdRef = config.refs.currentTopicIdRef;
        currentChatHistoryRef = config.refs.currentChatHistoryRef;
        attachedFilesRef = config.refs.attachedFilesRef;
        globalSettingsRef = config.refs.globalSettingsRef;

        // DOM Elements
        elements = config.elements;

        // The empty-state visual is a projection of the chat DOM.  History
        // loads and file-watcher updates can complete out of order, so keep a
        // final DOM-level guard against showing it over a real message.
        if (emptyStateObserver) {
            emptyStateObserver.disconnect();
            emptyStateObserver = null;
        }
        if (elements.chatMessagesDiv && typeof MutationObserver !== 'undefined') {
            emptyStateObserver = new MutationObserver(() => {
                syncNextUiEmptyStateWithMessages();
            });
            emptyStateObserver.observe(elements.chatMessagesDiv, { childList: true, subtree: true });
        }
        
        // Main Renderer Functions
        mainRendererFunctions = config.mainRendererFunctions;
        notifySendStateChanged = typeof config.notifySendStateChanged === 'function'
            ? config.notifySendStateChanged
            : (typeof mainRendererFunctions?.updateSendButtonState === 'function'
                ? mainRendererFunctions.updateSendButtonState
                : () => {});

        // Listen for Canvas events
        if (electronAPI) {
            canvasContentDisposer?.();
            canvasClosedDisposer?.();
            canvasContentDisposer = null;
            canvasClosedDisposer = null;
            try {
                canvasContentDisposer = electronAPI.onCanvasContentUpdate?.(handleCanvasContentUpdate) || null;
                canvasClosedDisposer = electronAPI.onCanvasWindowClosed?.(handleCanvasWindowClosed) || null;
            } catch (error) {
                canvasContentDisposer?.();
                canvasClosedDisposer?.();
                canvasContentDisposer = null;
                canvasClosedDisposer = null;
                emptyStateObserver?.disconnect();
                emptyStateObserver = null;
                throw error;
            }
        }
        initialized = true;
        console.log('[ChatManager] Initialized successfully.');
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
            const operation = lastOpenSaveQueue
                .catch(() => {})
                .then(() => electronAPI.saveSettings({ __vcpSettingsOps: [
                    { op: 'set', path: ['lastOpenItemId'], value: currentSelectedItem.id },
                    { op: 'set', path: ['lastOpenItemType'], value: currentSelectedItem.type },
                    { op: 'set', path: ['lastOpenTopicId'], value: currentTopicId },
                ] }));
            lastOpenSaveQueue = operation;
            return operation.catch(err => {
                console.error('[ChatManager] Failed to save last open state:', err);
                return { success: false, error: err?.message || String(err) };
            });
        }
        return Promise.resolve({ success: false, skipped: true });
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

    function setNextUiEmptyStateActive(isActive, reason = null) {
        if (isActive && hasRenderableChatMessages()) {
            isActive = false;
            reason = null;
        }

        const mainContent = document.querySelector('.main-content');
        const emptyState = document.getElementById('nextUiEmptyState');

        mainContent?.classList.toggle('next-ui-empty-state-active', isActive);
        if (mainContent) {
            mainContent.dataset.chatEmpty = String(isActive);
            if (isActive && reason) {
                mainContent.dataset.chatEmptyReason = reason;
            } else {
                delete mainContent.dataset.chatEmptyReason;
            }
        }
        emptyState?.setAttribute('aria-hidden', String(!isActive));
    }

    function hasRenderableChatMessages() {
        const chatMessagesDiv = elements.chatMessagesDiv;
        if (!chatMessagesDiv) return false;
        return Boolean(chatMessagesDiv.querySelector(
            '.message-item:not(.welcome-bubble):not(.topic-timestamp-bubble)'
        ));
    }

    function syncNextUiEmptyStateWithMessages() {
        if (hasRenderableChatMessages()) {
            setNextUiEmptyStateActive(false);
        }
    }

    function displayNoItemSelected() {
        const selectedItem = currentSelectedItemRef?.get?.();
        if (pendingItemSelectionToken !== null || selectedItem?.id) {
            setNextUiEmptyStateActive(false);
            return false;
        }

        ++itemSelectionGeneration;
        ++topicSelectionGeneration;
        ++activeHistoryLoadToken;
        void beginHistoryWatcherOperation().catch(error => {
            console.warn('[ChatManager] Failed to stop history watcher for empty selection:', error);
        });

        const { currentChatNameH3, chatMessagesDiv, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        const voiceChatBtn = document.getElementById('voiceChatBtn');
        currentChatNameH3.textContent = '选择一个 Agent 或群组开始聊天';
        chatMessagesDiv.innerHTML = `<div class="message-item system welcome-bubble"><p>欢迎，请从左侧选择 AI 助手或群组，或创建新的对话。</p></div>`;
        currentItemActionBtn.style.display = 'none';
        if (voiceChatBtn) voiceChatBtn.style.display = 'none';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;
        attachFileBtn.disabled = true;
        setNextUiEmptyStateActive(true, 'no-selection');
        if (mainRendererFunctions.displaySettingsForItem) {
            mainRendererFunctions.displaySettingsForItem(); 
        }
        if (topicListManager) topicListManager.loadTopicList();
        return true;
    }

    async function selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig, options = {}) {
        const selectionToken = ++itemSelectionGeneration;
        ++topicSelectionGeneration;
        ++activeHistoryLoadToken;
        pendingItemSelectionToken = selectionToken;
        const isSelectionCurrent = () => selectionToken === itemSelectionGeneration;
        const finishSelection = () => {
            if (pendingItemSelectionToken === selectionToken) {
                pendingItemSelectionToken = null;
            }
        };
        let watcherLeaseToken = null;
        const loadOwnedHistory = (topicId) => loadChatHistory(
            itemId,
            itemType,
            topicId,
            isSelectionCurrent,
            watcherLeaseToken
        );
        setNextUiEmptyStateActive(false);

        const activeBeforeSelection = currentSelectedItemRef.get();
        if (
            activeBeforeSelection?.id === itemId
            && activeBeforeSelection?.type === itemType
            && currentTopicIdRef.get()
        ) {
            finishSelection();
            await _saveLastOpenState();
            return;
        }

        // Flowlock 只绑定目标 Agent 的 Topic，不再阻止用户切换到其他 Agent。
        // 当重新进入已锁 Agent 时，下面会优先恢复它的锁定 Topic。
        try {
            const lease = await beginHistoryWatcherOperation();
            if (lease?.stale || lease?.success === false) return;
            watcherLeaseToken = lease.token || null;
        } catch (error) {
            console.warn('[ChatManager] Failed to claim history watcher ownership:', error);
        }

        if (!isSelectionCurrent()) return;

        const { currentChatNameH3, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        let currentSelectedItem = currentSelectedItemRef.get();

        currentSelectedItem = { id: itemId, type: itemType, name: itemName, avatarUrl: itemAvatarUrl, config: itemFullConfig };
        currentSelectedItemRef.set(currentSelectedItem);
        chatContext?.setSelectedItem(currentSelectedItem);
        // From this point displayNoItemSelected can rely on the selected item
        // itself. Keep generation ownership for the async transaction, but do
        // not retain a separate pending marker that an unrelated renderer
        // exception could strand forever.
        finishSelection();
        currentTopicIdRef.set(null); // Reset topic
        currentChatHistoryRef.set([]);
        chatContext?.setHistory([]);
        notifySendStateChanged();

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
            if (!isSelectionCurrent()) return;
        } else if (itemType === 'agent') {
            if (groupRenderer && typeof groupRenderer.clearInviteAgentButtons === 'function') {
                groupRenderer.clearInviteAgentButtons();
            }
        }
     
        const voiceChatBtn = document.getElementById('voiceChatBtn');

        const itemTypeLabel = itemType === 'group' ? ' (群组)' : '';
        currentChatNameH3.textContent = `与 ${itemName}${itemTypeLabel} 聊天中`;
        window.flowlockManager?.syncCurrentHeaderIndicator?.();
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
            if (!isSelectionCurrent()) return;

            if (topics && !topics.error && topics.length > 0) {
                let topicToLoadId = topics[0].id;
                const lockedTopicId = itemType === 'agent'
                    ? window.flowlockManager?.getLockedTopicId?.(itemId)
                    : null;
                const preferredTopicId = typeof options.preferredTopicId === 'string'
                    ? options.preferredTopicId
                    : null;
                const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${itemId}_${itemType}`);

                if (lockedTopicId && topics.some(t => t.id === lockedTopicId)) {
                    topicToLoadId = lockedTopicId;
                } else if (preferredTopicId && topics.some(t => t.id === preferredTopicId)) {
                    topicToLoadId = preferredTopicId;
                } else if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                    topicToLoadId = rememberedTopicId;
                }
                if (!isSelectionCurrent()) return;
                currentTopicIdRef.set(topicToLoadId);
                if (messageRenderer) messageRenderer.setCurrentTopicId(topicToLoadId);
                await loadOwnedHistory(topicToLoadId);
            } else if (topics && topics.error) {
                if (!isSelectionCurrent()) return;
                console.error(`加载 ${itemType} ${itemId} 的话题列表失败`, topics.error);
                if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题列表失败: ${topics.error}`, timestamp: Date.now() });
                await loadOwnedHistory(null);
            } else {
                if (itemType === 'agent') {
                    const agentConfig = await electronAPI.getAgentConfig(itemId);
                    if (!isSelectionCurrent()) return;
                    // ⚠️ 检查是否返回错误对象
                    if (agentConfig && agentConfig.error) {
                        console.error(`[ChatManager] Failed to get agent config for ${itemId}:`, agentConfig.error);
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载助手配置失败: ${agentConfig.error}`, timestamp: Date.now() });
                        await loadOwnedHistory(null);
                    } else if (agentConfig && (!agentConfig.topics || agentConfig.topics.length === 0)) {
                        const defaultTopicResult = await electronAPI.createNewTopicForAgent(itemId, "主要对话");
                        if (!isSelectionCurrent()) return;
                        if (defaultTopicResult.success) {
                            currentTopicIdRef.set(defaultTopicResult.topicId);
                            if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                            await loadOwnedHistory(defaultTopicResult.topicId);
                        } else {
                            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `创建默认话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                            await loadOwnedHistory(null);
                        }
                    } else {
                         await loadOwnedHistory(null);
                    }
                } else if (itemType === 'group') {
                    const defaultTopicResult = await electronAPI.createNewTopicForGroup(itemId, "主要群聊");
                    if (!isSelectionCurrent()) return;
                    if (defaultTopicResult.success) {
                        currentTopicIdRef.set(defaultTopicResult.topicId);
                        if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                        await loadOwnedHistory(defaultTopicResult.topicId);
                    } else {
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `创建默认群聊话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                        await loadOwnedHistory(null);
                    }
                }
            }
        } catch (e) {
            if (!isSelectionCurrent()) return;
            console.error(`选择 ${itemType} ${itemId} 时发生错误: `, e);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `选择${itemType === 'group' ? '群组' : '助手'}时出错: ${e.message}`, timestamp: Date.now() });
        }

        if (!isSelectionCurrent()) return;
        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        attachFileBtn.disabled = false;
        // messageInput.focus();
        if (topicListManager) await Promise.resolve(topicListManager.loadTopicList());
        if (!isSelectionCurrent()) return;
        await _saveLastOpenState(); // Commit before startup/reload can observe the selection.
        finishSelection();
    }

    /**
     * Restores the last durable chat selection through the same transaction as
     * an explicit user selection. A concurrent click increments the shared
     * selection generation and therefore always supersedes this restoration.
     */
    async function restoreLastOpenState(settings = {}) {
        const itemId = typeof settings.lastOpenItemId === 'string'
            ? settings.lastOpenItemId
            : null;
        const itemType = settings.lastOpenItemType === 'agent' || settings.lastOpenItemType === 'group'
            ? settings.lastOpenItemType
            : null;
        if (!itemId || !itemType || !itemListManager?.findItemById) return false;

        const item = itemListManager.findItemById(itemId, itemType);
        if (!item) return false;

        await selectItem(
            item.id,
            item.type,
            item.name,
            item.avatarUrl,
            item.config || item,
            { preferredTopicId: settings.lastOpenTopicId }
        );

        const selectedItem = currentSelectedItemRef.get();
        return selectedItem?.id === item.id && selectedItem?.type === item.type;
    }
 
    async function selectTopic(topicId) {
        setNextUiEmptyStateActive(false);
        const selectedItemForLock = currentSelectedItemRef.get();
        const lockedTopicId = selectedItemForLock?.type === 'agent'
            ? window.flowlockManager?.getLockedTopicId?.(selectedItemForLock.id)
            : null;

        if (lockedTopicId && topicId !== lockedTopicId) {
            if (uiHelper?.showToastNotification) {
                uiHelper.showToastNotification('该 Agent 正在锁定话题中运行，请先停止心流锁再切换话题。', 'warning');
            }
            console.log(`[ChatManager] Blocked topic switch for locked Agent ${selectedItemForLock.id}: ${lockedTopicId} -> ${topicId}`);
            return;
        }

        let currentTopicId = currentTopicIdRef.get();
        if (currentTopicId === topicId) {
            await _saveLastOpenState();
            return;
        }

        const currentSelectedItem = currentSelectedItemRef.get();
        if (!currentSelectedItem || !currentSelectedItem.id || !currentSelectedItem.type) {
            console.warn('[ChatManager] Ignored selectTopic: no active item selected yet.');
            return;
        }

        const topicToken = ++topicSelectionGeneration;
        ++activeHistoryLoadToken;
        const selectedItemId = currentSelectedItem.id;
        const selectedItemType = currentSelectedItem.type;
        const isTopicOperationCurrent = () => {
            const activeItem = currentSelectedItemRef.get();
            return topicToken === topicSelectionGeneration
                && activeItem?.id === selectedItemId
                && activeItem?.type === selectedItemType;
        };
        const isTopicSelectionCurrent = () => {
            return isTopicOperationCurrent()
                && currentTopicIdRef.get() === topicId;
        };
        let watcherLeaseToken = null;

        try {
            currentTopicIdRef.set(topicId);
            if (messageRenderer) messageRenderer.setCurrentTopicId(topicId);
            // Persist the selection intent before watcher/history work. A
            // renderer reload or crash during that work must restore the
            // topic the user actually selected, not the previous durable one.
            await _saveLastOpenState();
            const lease = await beginHistoryWatcherOperation();
            if (!isTopicSelectionCurrent() || lease?.stale || lease?.success === false) return;
            watcherLeaseToken = lease.token || null;
            // Persist the user's selection intent at the same point as the
            // visible state commit. History/watcher work is cancellable; if
            // the user immediately switches away, waiting until that work
            // finishes would silently forget the topic they just selected.
            localStorage.setItem(`lastActiveTopic_${currentSelectedItem.id}_${currentSelectedItem.type}`, topicId);

            document.querySelectorAll('#topicList .topic-item').forEach(item => {
                const isClickedItem = item.dataset.topicId === topicId && item.dataset.itemId === currentSelectedItem.id;
                item.classList.toggle('active', isClickedItem);
                item.classList.toggle('active-topic-glowing', isClickedItem);
            });

            await loadChatHistory(
                currentSelectedItem.id,
                currentSelectedItem.type,
                topicId,
                isTopicSelectionCurrent,
                watcherLeaseToken
            );
            if (!isTopicSelectionCurrent()) return;
            await _saveLastOpenState();
        } catch (error) {
            if (!isTopicSelectionCurrent()) return;
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

    async function handleTopicDeletion(remainingTopics, deletionContext = null) {
        let currentSelectedItem = currentSelectedItemRef.get();
        if (
            deletionContext
            && (
                currentSelectedItem?.id !== deletionContext.id
                || currentSelectedItem?.type !== deletionContext.type
            )
        ) {
            console.debug('[ChatManager] Ignoring stale topic deletion completion', deletionContext);
            return false;
        }
        const deletedTopicIds = new Set([
            ...(Array.isArray(deletionContext?.deletedTopicIds) ? deletionContext.deletedTopicIds : []),
            ...(deletionContext?.topicId ? [deletionContext.topicId] : []),
        ].filter(Boolean).map(String));
        const sanitizedRemainingTopics = (Array.isArray(remainingTopics) ? remainingTopics : [])
            .filter(topic => !deletedTopicIds.has(String(topic?.id)));
        const currentConfig = currentSelectedItem.config || currentSelectedItem;
        const nextConfig = { ...currentConfig, topics: sanitizedRemainingTopics };
        currentSelectedItem = currentSelectedItem.config
            ? { ...currentSelectedItem, config: nextConfig }
            : { ...currentSelectedItem, ...nextConfig };
        currentSelectedItemRef.set(currentSelectedItem);

        if (sanitizedRemainingTopics.length > 0) {
            const fallbackTopic = deletionContext?.fallbackTopicId
                ? sanitizedRemainingTopics.find(topic => String(topic?.id) === String(deletionContext.fallbackTopicId))
                : null;
            const newSelectedTopic = fallbackTopic || [...sanitizedRemainingTopics]
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
            await selectTopic(newSelectedTopic.id);
        } else {
            ++topicSelectionGeneration;
            ++activeHistoryLoadToken;
            currentTopicIdRef.set(null);
            if (messageRenderer) {
                messageRenderer.setCurrentTopicId(null);
                messageRenderer.clearChat();
                messageRenderer.renderMessage({ role: 'system', content: '所有话题均已删除。请创建一个新话题。', timestamp: Date.now() });
            }
            await displayTopicTimestampBubble(currentSelectedItem.id, currentSelectedItem.type, null);
        }
        return true;
    }

    async function loadChatHistory(itemId, itemType, topicId, ownershipGuard = null, watcherLeaseToken = null) {
        const loadToken = ++activeHistoryLoadToken;
        setNextUiEmptyStateActive(false);

        const isLoadStillActive = () => loadToken === activeHistoryLoadToken
            && (!ownershipGuard || ownershipGuard());
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
        notifySendStateChanged();
    
    
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

        if (watcherLeaseToken === null && electronAPI.watcherBegin) {
            const lease = await beginHistoryWatcherOperation();
            if (abortIfStale() || lease?.stale || lease?.success === false) return;
            watcherLeaseToken = lease.token || null;
        }
    
        // 核心修改：使用 await 确保加载消息被渲染
        if (messageRenderer) {
            await messageRenderer.renderMessage({ role: 'system', name: '系统', content: '加载聊天记录中...', timestamp: Date.now(), isThinking: true, id: 'loading_history' });
        }
        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        const historyResult = await getHistory(itemId, itemType, topicId);

        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        const currentSelectedItem = currentSelectedItemRef.get();
        const agentConfigForHistory = currentSelectedItem.config || currentSelectedItem;
        if (electronAPI.watcherStart && agentConfigForHistory?.agentDataPath) {
            const historyFilePath = `${agentConfigForHistory.agentDataPath}\\topics\\${topicId}\\history.json`;
            const watcherResult = await startOwnedHistoryWatcher(watcherLeaseToken, historyFilePath, itemId, topicId);
            if (watcherResult?.stale || watcherResult?.success === false) return;
        }

        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        if (messageRenderer) messageRenderer.removeMessageById('loading_history');
    
        await displayTopicTimestampBubble(itemId, itemType, topicId);
        if (abortIfStale()) return;

        // 渐进历史渲染从“最新批次”开始，再把旧批次插到顶部。活动流如果等到
        // 全部旧批次结束后才 reconcile，长历史加载期间会暂时没有呼吸框；若由
        // 其他流式帧抢先补建 DOM，还可能与批次插入交错，视觉上像被排到旧楼层中。
        // 在批处理开始前把 renderer-local 活动流快照合并到投影历史尾部，使它从
        // 第一批起就拥有确定的最后楼层。这里只修改内存/DOM 投影，不写 durable history。
        const activeStreamSnapshots = streamProjection?.snapshotConversation?.({
            itemType,
            itemId,
            topicId,
        }) || [];
        const historyForProjection = Array.isArray(historyResult)
            ? [...historyResult]
            : historyResult;
        if (Array.isArray(historyForProjection)) {
            for (const snapshot of activeStreamSnapshots) {
                if (!snapshot?.messageId || historyForProjection.some(message => message?.id === snapshot.messageId)) {
                    continue;
                }
                const accumulatedText = typeof snapshot.accumulatedText === 'string'
                    ? snapshot.accumulatedText
                    : '';
                historyForProjection.push({
                    ...(snapshot.message || {}),
                    ...(snapshot.context || {}),
                    id: snapshot.messageId,
                    role: snapshot.message?.role || 'assistant',
                    content: accumulatedText || snapshot.message?.content || '',
                    isThinking: accumulatedText.trim() === '',
                    isPendingStream: true,
                    timestamp: snapshot.message?.timestamp || Date.now(),
                    streamOperationId: snapshot.streamOperationId || null,
                });
            }
        }
    
        if (historyResult && historyResult.error) {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录失败: ${historyResult.error}`, timestamp: Date.now() });
        } else if (Array.isArray(historyForProjection) && historyForProjection.length > 0) {
            currentChatHistoryRef.set(historyForProjection);
            notifySendStateChanged();
            if (messageRenderer) {
                // 使用优化的分批渲染策略
                const renderOptions = {
                    initialBatch: 5,    // 首先显示最新的5条消息
                    batchSize: 10,      // 后续每批10条消息
                    batchDelay: 80      // 批次间延迟 80ms，平衡性能和用户体验
                };
                
                console.log(`[ChatManager] 开始加载话题历史，共 ${historyForProjection.length} 条消息`);
                await (chatDomRenderer || messageRenderer).renderHistory(historyForProjection, renderOptions);
                if (abortIfStale()) return;
                console.log(`[ChatManager] 话题历史加载完成`);
            }
    
        } else if (historyResult) { // History is empty
            currentChatHistoryRef.set([]);
            notifySendStateChanged();
            const activeItem = currentSelectedItemRef.get();
            if (
                activeItem?.id === itemId
                && activeItem?.type === itemType
                && currentTopicIdRef.get() === topicId
            ) {
                setNextUiEmptyStateActive(true, 'empty-topic');
            }
        } else {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: `加载话题 "${topicId}" 的聊天记录时返回了无效数据。`, timestamp: Date.now() });
        }

        if (abortIfStale()) return;

        // Re-project renderer-local active streams after history/DOM replacement.
        // This never persists partial output; terminal persistence remains coordinator-owned.
        await streamProjection?.reconcileConversation?.({ itemType, itemId, topicId });
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
                await saveHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId, updatedHistory);
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

            await saveHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId, updatedHistory);
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
            const refreshedSelectedItem = currentSelectedItem.config
                ? { ...currentSelectedItem, name: agentConfigForSummary.name || currentSelectedItem.name, config: agentConfigForSummary }
                : { ...currentSelectedItem, ...agentConfigForSummary };
            currentSelectedItemRef.set(refreshedSelectedItem);

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

    async function handleSendMessage(request = null) {
        const { messageInput } = elements;
        const renderTarget = request?.domRenderer || messageRenderer;
        const input = request?.input || messageInput;
        let content = typeof request?.content === 'string' ? request.content : input.value; // Use let as it might be modified
        const attachedFiles = Array.isArray(request?.attachments) ? request.attachments : attachedFilesRef.get();
        const sendSelectedItemRef = request?.conversation?.selectedItemRef || currentSelectedItemRef;
        const sendTopicIdRef = request?.conversation?.topicIdRef || currentTopicIdRef;
        const sendHistoryRef = request?.conversation?.historyRef || currentChatHistoryRef;
        const currentSelectedItem = sendSelectedItemRef.get();
        const currentTopicId = sendTopicIdRef.get();
        const globalSettings = globalSettingsRef.get();
        const notifySendState = request?.conversation ? () => {} : notifySendStateChanged;
        const sendContext = {
            agentId: currentSelectedItem.id,
            itemType: currentSelectedItem.type || 'agent',
            agentName: currentSelectedItem.name || currentSelectedItem.id,
            topicId: currentTopicId,
            isGroupMessage: currentSelectedItem.type === 'group',
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };
        const isSendContextCurrent = () => {
            if (request?.conversation && request.conversation.isActive?.() === false) return false;
            const activeItem = sendSelectedItemRef.get();
            return activeItem?.id === sendContext.agentId
                && activeItem?.type === sendContext.itemType
                && sendTopicIdRef.get() === sendContext.topicId;
        };

        if (!content && attachedFiles.length === 0) return;
        if (!currentSelectedItem.id || !currentTopicId) {
            const error = new Error('请先选择一个项目和话题。');
            if (!request?.conversation) uiHelper.showToastNotification(error.message, 'error');
            if (request?.propagateError) throw error;
            return;
        }
        if (!globalSettings.vcpServerUrl) {
            const error = new Error('请先在全局设置中配置 VCP 服务器 URL。');
            if (!request?.conversation) {
                uiHelper.showToastNotification(error.message, 'error');
                uiHelper.openModal('globalSettingsModal');
            }
            if (request?.propagateError) throw error;
            return;
        }

        if (!request?.conversation) setNextUiEmptyStateActive(false);

        if (currentSelectedItem.type === 'group') {
            if (request?.conversation) {
                const error = new Error('独立群聊尚未接入 Surface-owned 群组 operation');
                if (request.propagateError) throw error;
                return;
            }
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
            if (!request) {
                messageInput.value = '';
                attachedFilesRef.set([]);
                if(mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
                uiHelper.autoResizeTextarea(messageInput);
            }
            // messageInput.focus();
            return;
        }

        // --- Standard Agent Message Sending ---
        const sendSignature = `${sendContext.agentId}:${sendContext.topicId}`;
        if (pendingSendContexts.has(sendSignature)) {
            uiHelper.showToastNotification('该话题已有消息正在启动，请稍候。', 'warning');
            return;
        }
        pendingSendContexts.add(sendSignature);
        try {
        const uiAttachments = [];
        if (attachedFiles.length > 0) {
            for (const af of attachedFiles) {
                const fileManagerData = af._fileManagerData || {};
                uiAttachments.push({
                    type: fileManagerData.type || af.file.type,
                    src: af.localPath,
                    name: af.originalName,
                    size: af.file.size,
                    _fileManagerData: fileManagerData
                });
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
        
        const optimisticHistory = [...sendHistoryRef.get(), userMessage];
        if (isSendContextCurrent()) {
            sendHistoryRef.set(optimisticHistory);
        }
        let userMessageItem = null;
        if (renderTarget) {
            userMessageItem = await renderTarget.renderMessage(userMessage);
        }
        if (!isSendContextCurrent()) {
            // renderMessage targets the shared chat container. If selection
            // changed while it awaited, retract the stale DOM projection;
            // the message still belongs to and is saved in its source topic.
            userMessageItem?.remove?.();
        }

        // Save history with the user message before adding the thinking message or making API calls
        let sendHistory;
        try {
            sendHistory = await persistOutgoingUserMessage(sendContext, userMessage);
        } catch (error) {
            // The draft is consumed only after the durable write succeeds. If
            // persistence fails, retract the optimistic projection and leave
            // the initiating input/attachments available for retry.
            if (isSendContextCurrent()) {
                sendHistoryRef.set(
                    sendHistoryRef.get().filter(message => message?.id !== userMessage.id)
                );
                userMessageItem?.remove?.();
                notifySendState();
                if (!request?.conversation) uiHelper.showToastNotification(`发送失败，草稿已保留: ${error.message}`, 'error');
            }
            console.error('[ChatManager] Failed to persist outgoing message:', error);
            if (request?.propagateError) throw error;
            return;
        }

        // Consume only the exact draft transaction that was durably saved.
        // Both the text and attachment-array identity must still match, so an
        // attachment added while the save was pending cannot be discarded.
        if (
            isSendContextCurrent()
            && input.value === content
            && (request || attachedFilesRef.get() === attachedFiles)
        ) {
            if (!request) {
                messageInput.value = '';
                attachedFilesRef.set([]);
                if (mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
                if (isCanvasWindowOpen) messageInput.value = CANVAS_PLACEHOLDER;
                uiHelper.autoResizeTextarea(messageInput);
            }
        }

        // 用户已参与该话题：同步清除 TopicSponsor/手动设置的持久化未读标记。
        // 之前这里只刷新徽章，并未真正修改 topic.unread，导致无数字“未读”长期残留。
        try {
            const readResult = await electronAPI.setTopicUnread(
                currentSelectedItem.id,
                currentTopicId,
                false
            );
            if (!readResult?.success) {
                console.warn('[ChatManager] Failed to mark topic as read:', readResult?.error);
            }
        } catch (error) {
            console.warn('[ChatManager] Failed to clear persistent topic unread state:', error);
        }

        // After saving history and clearing the persistent marker, refresh the unread counts.
        if (itemListManager && typeof itemListManager.refreshUnreadCounts === 'function') {
            itemListManager.refreshUnreadCounts();
        } else if (itemListManager) {
            itemListManager.loadItems();
        }

        const thinkingMessageId = `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
        const thinkingMessage = {
            role: 'assistant',
            name: currentSelectedItem.name || currentSelectedItem.id || 'AI', // 修复：使用 ID 作为更可靠的回退
            content: '思考中',
            timestamp: Date.now(),
            id: thinkingMessageId,
            isThinking: true,
            replyToMessageId: userMessage.id,
            agentId: sendContext.agentId,
            topicId: sendContext.topicId,
            context: sendContext,
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };

        let thinkingMessageItem = null;
        let releaseStreamConsumerRoute = null;
        let settleOwnedStreamOperation = null;
        const ownedStreamTerminal = request?.awaitTerminal
            ? new Promise(resolve => { settleOwnedStreamOperation = resolve; })
            : null;
        if (renderTarget && isSendContextCurrent()) {
            thinkingMessageItem = await renderTarget.renderMessage(thinkingMessage);
            if (!isSendContextCurrent()) {
                thinkingMessageItem?.remove?.();
                thinkingMessageItem = null;
            } else if (thinkingMessageItem && !request?.conversation) {
                // 不再走通用 scrollToBottom 状态机：agent 气泡自身已经在同一轮
                // renderMessage 中排过一次滚动，紧接着再调用会被 frameId 合并，
                // 无法保证按这个新气泡完成布局后的 scrollHeight 再提交。
                // 从气泡反查实际滚动容器，下一布局帧直接滚到它的真实底部。
                const scrollContainer = thinkingMessageItem.closest('.chat-messages-container');
                const ownerWindow = thinkingMessageItem.ownerDocument?.defaultView;
                ownerWindow?.requestAnimationFrame?.(() => {
                    if (
                        thinkingMessageItem.isConnected
                        && scrollContainer?.isConnected
                        && isSendContextCurrent()
                    ) {
                        scrollContainer.scrollTop = Math.max(
                            0,
                            scrollContainer.scrollHeight - scrollContainer.clientHeight
                        );
                    }
                });
            }
        }
        if (isSendContextCurrent()) {
            sendHistoryRef.set(insertAfterMessage(
                sendHistoryRef.get(),
                userMessage.id,
                thinkingMessage
            ));
            notifySendState();
        }
        const removeThinkingFromSource = async () => {
            releaseStreamConsumerRoute?.();
            releaseStreamConsumerRoute = null;
            renderTarget?.discardStreaming?.(thinkingMessage.id);
            try {
                const sourceHistory = await getHistory(sendContext.agentId, sendContext.itemType || 'agent', sendContext.topicId);
                if (!Array.isArray(sourceHistory)) return null;
                const cleanedHistory = sourceHistory.filter(message => message.id !== thinkingMessage.id);
                if (cleanedHistory.length !== sourceHistory.length) {
                    const saveResult = await saveHistory(sendContext.agentId, sendContext.itemType || 'agent', sendContext.topicId, cleanedHistory);
                    if (saveResult?.success === false) {
                        throw new Error(saveResult.error || '清理临时消息失败');
                    }
                }
                if (isSendContextCurrent()) {
                    sendHistoryRef.set(
                        sendHistoryRef.get().filter(message => message?.id !== thinkingMessage.id)
                    );
                    if (typeof renderTarget?.removeMessage === 'function') await renderTarget.removeMessage(thinkingMessage.id);
                    else await renderTarget?.removeMessageById?.(thinkingMessage.id);
                    notifySendState();
                }
                return cleanedHistory;
            } catch (cleanupError) {
                console.error('[ChatManager] Failed to clean owned thinking message:', cleanupError);
                if (isSendContextCurrent()) {
                    sendHistoryRef.set(
                        sendHistoryRef.get().filter(message => message?.id !== thinkingMessage.id)
                    );
                    if (typeof renderTarget?.removeMessage === 'function') await renderTarget.removeMessage(thinkingMessage.id);
                    else await renderTarget?.removeMessageById?.(thinkingMessage.id);
                    notifySendState();
                }
                return null;
            }
        };

        try {
            const agentConfig = currentSelectedItem.config || currentSelectedItem;
            const historySnapshotForVCP = sendHistory.filter(msg => !msg.isThinking);
            const contextRegexRules = Array.isArray(agentConfig?.stripRegexes)
                ? agentConfig.stripRegexes
                : [];
            const hasContextRegexRules = contextRegexRules.some(
                rule => rule?.enabled !== false && rule.applyToContext
            );
            const contextDepthMap = hasContextRegexRules
                ? buildTurnDepthMap(historySnapshotForVCP)
                : null;
            const systemPromptPrefix = [];

            if (agentConfig.systemPrompt) {
                if (agentConfig.agentDataPath && currentTopicId) {
                    systemPromptPrefix.push(
                        `当前聊天记录文件路径: ${agentConfig.agentDataPath}\\topics\\${currentTopicId}\\history.json`
                    );
                }
                const currentTopic = agentConfig.topics?.find(topic => topic.id === currentTopicId);
                if (currentTopic?.createdAt) {
                    const date = new Date(currentTopic.createdAt);
                    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    systemPromptPrefix.push(`当前话题创建于 ${formattedDate}`);
                }
            }

            const orchestrated = await singleChatRequestOrchestrator.buildRequest({
                settings: globalSettings,
                agentConfig,
                history: historySnapshotForVCP,
                messageId: thinkingMessage.id,
                context: sendContext,
                currentUserMessageId: userMessage.id,
                systemPromptPrefix: systemPromptPrefix.join('\n'),
                transformMessageText: ({ text, message }) => {
                    // Preserve the established behavior: context regexes apply
                    // to prior context, while the just-submitted user text is
                    // sent verbatim before Tavern user_suffix injection.
                    if (
                        message.id === userMessage.id
                        || !hasContextRegexRules
                        || !contextDepthMap
                    ) {
                        return text;
                    }
                    const depth = contextDepthMap.get(message.id);
                    return depth === undefined
                        ? text
                        : applyRegexRules(text, contextRegexRules, 'context', message.role, depth);
                },
                buildMessageContent: buildDefaultMessageContent,
                postProcessMessageContent: async ({ content: parts, message }) => {
                    if (
                        message.id !== userMessage.id
                        || !parts.some(part => part?.type === 'text' && part.text.includes(CANVAS_PLACEHOLDER))
                    ) {
                        return parts;
                    }
                    try {
                        const canvasData = await electronAPI.getLatestCanvasContent();
                        const replacement = canvasData && !canvasData.error
                            ? `\n[Canvas Content]\n${canvasData.content || ''}\n[Canvas Path]\n${canvasData.path || 'No file path'}\n[Canvas Errors]\n${canvasData.errors || 'No errors'}\n`
                            : '\n[Canvas content could not be loaded]\n';
                        return updateFirstTextPart(
                            parts,
                            text => text.replace(new RegExp(CANVAS_PLACEHOLDER, 'g'), replacement)
                        );
                    } catch (error) {
                        console.error('Error fetching canvas content:', error);
                        return updateFirstTextPart(
                            parts,
                            text => text.replace(
                                new RegExp(CANVAS_PLACEHOLDER, 'g'),
                                '\n[Error loading canvas content]\n'
                            )
                        );
                    }
                },
            });
            const useStreaming = orchestrated.modelConfig.stream === true;

            if (useStreaming) {
                if (messageRenderer) {
                    const startOwnedStreamProjection = message => (
                        renderTarget.startStreaming || messageRenderer.startStreamingMessage
                    ).call(renderTarget, message, thinkingMessageItem);
                    releaseStreamConsumerRoute = streamConsumerRegistry?.register?.(thinkingMessage.id, {
                        kind: request?.domRenderer ? 'independent-surface' : 'main-chat',
                        start: startOwnedStreamProjection,
                        ...(request?.domRenderer ? {
                            append: (messageId, chunk, streamContext) => request.domRenderer.appendStreaming(messageId, chunk, streamContext),
                            projectTerminal: (messageId, finishReason, streamContext, payload) => request.domRenderer.projectStreamTerminal(messageId, finishReason, streamContext, payload),
                        } : {}),
                        settle: result => settleOwnedStreamOperation?.(result),
                        release: () => {
                            releaseStreamConsumerRoute?.();
                            releaseStreamConsumerRoute = null;
                        },
                    });
                    if (request?.domRenderer?.own && releaseStreamConsumerRoute?.retract) {
                        request.domRenderer.own(() => releaseStreamConsumerRoute?.retract?.());
                    }
                    request?.onOperation?.(Object.freeze({
                        messageId: thinkingMessage.id,
                        done: ownedStreamTerminal,
                        async cancel(reason) {
                            try { await interruptCapability?.interrupt?.(thinkingMessage.id); }
                            catch (error) { console.warn('[ChatManager] Surface interrupt request failed; cancelling locally:', error); }
                            return releaseStreamConsumerRoute?.cancel?.(reason || 'surface-operation-cancelled');
                        },
                    }));

                    // 在请求交给上游之前发布本地流所有权。过去这里一直等首个
                    // agent_thinking/start IPC 才初始化 StreamProjection；在这段空窗内切换
                    // 话题时，渐进历史渲染只能读到已落盘的 user 消息，尚未持久化的 assistant
                    // 占位既不在活动流快照中，也无法由 reconcileConversation 恢复。
                    // 提前初始化后，呼吸框、返回会话恢复和发送/中止按钮共享同一运行态真源。
                    await startOwnedStreamProjection({
                        ...thinkingMessage,
                        ...orchestrated.context,
                        context: orchestrated.context,
                        content: '',
                        isThinking: true,
                    });
                    notifySendState();
                }
            }

            const context = orchestrated.context;
            const vcpResponse = await singleChatRequestOrchestrator.sendPrepared(
                orchestrated,
                globalSettings
            );

            if (!useStreaming) {
                const response = vcpResponse?.response ?? vcpResponse;
                const responseContext = vcpResponse?.context ?? context;
                const activeSelectedItem = sendSelectedItemRef.get();
                const activeTopicId = sendTopicIdRef.get();

                // Determine if the response is for the currently active chat
                const isForActiveChat = responseContext && responseContext.agentId === activeSelectedItem.id && responseContext.topicId === activeTopicId;

                 if (isForActiveChat) {
                     // Remove the placeholder through the initiating Surface;
                     // an internal Surface must never mutate the main root.
                     if (typeof renderTarget?.removeMessage === 'function') await renderTarget.removeMessage(thinkingMessage.id);
                     else renderTarget?.removeMessageById?.(thinkingMessage.id);
                 }

                if (!response) {
                    throw new Error('VCP returned an empty response.');
                }

                if (response.error) {
                    await removeThinkingFromSource();
                    if (isForActiveChat && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', content: `VCP错误: ${response.error}`, timestamp: Date.now() });
                    }
                    console.error(`[ChatManager] VCP Error for background message:`, response.error);
                    if (request?.propagateError) throw new Error(String(response.error));
                } else if (response.choices && response.choices.length > 0) {
                    const assistantMessageContent = response.choices[0].message.content;
                    const assistantMessage = {
                        role: 'assistant',
                        name: responseContext?.agentName || responseContext?.agentId || 'AI', // 修复：使用 context 中的 agentName 或 agentId 作为回退
                        avatarUrl: responseContext?.avatarUrl || sendContext.avatarUrl,
                        avatarColor: responseContext?.avatarColor || sendContext.avatarColor,
                        content: assistantMessageContent,
                        timestamp: Date.now(),
                        id: `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`
                    };

                    // Fetch the correct history from the file, update it, and save it back.
                    const historyForSave = await getHistory(responseContext.agentId, responseContext.itemType || 'agent', responseContext.topicId);
                    if (historyForSave && !historyForSave.error) {
                        // Remove any lingering 'thinking' message and add the new one
                        const finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessage.id);
                        finalHistory.push(assistantMessage);
                        
                        // Save the final, complete history to the correct file
                        await saveHistory(responseContext.agentId, responseContext.itemType || 'agent', responseContext.topicId, finalHistory);

                        if (isForActiveChat) {
                            // If it's the active chat, also update the UI and in-memory state
                            sendHistoryRef.set(finalHistory);
                            notifySendState();
                            if (renderTarget) renderTarget.renderMessage(assistantMessage);
                            if (!request?.conversation) await attemptTopicSummarizationIfNeeded();
                        } else {
                            console.log(`[ChatManager] Saved non-streaming response for background chat: Agent ${responseContext.agentId}, Topic ${responseContext.topicId}`);
                        }
                    } else {
                         console.error(`[ChatManager] Failed to get history for background save:`, historyForSave.error);
                    }
                } else {
                    await removeThinkingFromSource();
                    if (isForActiveChat && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', content: 'VCP 返回了未知格式的响应。', timestamp: Date.now() });
                    }
                }
            } else {
                if (vcpResponse && vcpResponse.streamError) {
                    console.error("Streaming setup failed in main process:", vcpResponse.errorDetail || vcpResponse.error);
                    await removeThinkingFromSource();
                    if (isSendContextCurrent() && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', content: `请求流式回复失败: ${vcpResponse.error || '未知错误'}`, timestamp: Date.now() });
                    }
                    if (request?.propagateError) throw new Error(String(vcpResponse.error || '流式回复失败'));
                } else if (vcpResponse && !vcpResponse.streamingStarted && !vcpResponse.streamError) {
                    console.warn("Expected streaming to start, but main process returned non-streaming or error:", vcpResponse);
                    await removeThinkingFromSource();
                    if (isSendContextCurrent() && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', content: '请求流式回复失败，收到非流式响应或错误。', timestamp: Date.now() });
                    }
                    if (request?.propagateError) throw new Error('请求流式回复失败，收到非流式响应或错误');
                }
                if (request?.awaitTerminal && ownedStreamTerminal) {
                    const terminal = await ownedStreamTerminal;
                    return Object.freeze({ messageId: thinkingMessage.id, terminal });
                }
            }
        } catch (error) {
            console.error('发送消息或处理VCP响应时出错', error);
            await removeThinkingFromSource();
            if (isSendContextCurrent() && renderTarget) {
                renderTarget.renderMessage({ role: 'system', content: `错误: ${error.message}`, timestamp: Date.now() });
            }
            if (request?.propagateError) throw error;
        }
        } finally {
            pendingSendContexts.delete(sendSignature);
        }
    }

    async function createNewTopicForItem(itemId, itemType) {
        if (!itemId) {
            uiHelper.showToastNotification("请先选择一个项目。", 'error');
            return;
        }

        if (itemType === 'agent' && window.flowlockManager?.isAgentLocked?.(itemId)) {
            uiHelper.showToastNotification('该 Agent 正在心流锁中，无法新建或切换话题。', 'warning');
            return;
        }
        
        const currentSelectedItem = currentSelectedItemRef.get();
        const creationToken = ++topicCreationGeneration;
        const creationItemGeneration = itemSelectionGeneration;
        const creationTopicGeneration = topicSelectionGeneration;
        const isCreationCurrent = () => {
            const activeItem = currentSelectedItemRef.get();
            return creationToken === topicCreationGeneration
                && creationItemGeneration === itemSelectionGeneration
                && creationTopicGeneration === topicSelectionGeneration
                && activeItem?.id === itemId
                && activeItem?.type === itemType;
        };
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
                // Topic creation is durable for its source item even if the
                // user navigates away, but a late completion must not seize
                // the newly selected conversation's UI or watcher.
                if (!isCreationCurrent()) return;
                const watcherLease = await beginHistoryWatcherOperation();
                if (!isCreationCurrent() || watcherLease?.stale || watcherLease?.success === false) return;
                currentTopicIdRef.set(result.topicId);
                currentChatHistoryRef.set([]);
                notifySendStateChanged();

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
                    const watcherResult = await startOwnedHistoryWatcher(
                        watcherLease.token || null,
                        historyFilePath,
                        itemId,
                        result.topicId
                    );
                    if (watcherResult?.stale || watcherResult?.success === false) return;
                    if (!isCreationCurrent() || currentTopicIdRef.get() !== result.topicId) return;
                    console.log(`[ChatManager] Started file watcher for new topic: ${result.topicId}`);
                }
                
                // Keep the list projection authoritative even when the topics
                // tab is currently hidden. Otherwise currentTopicId changes
                // while the old row remains highlighted until a later visit.
                if (topicListManager) await topicListManager.loadTopicList();
                
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

        if (currentSelectedItem?.type === 'agent' && window.flowlockManager?.isAgentLocked?.(currentSelectedItem.id)) {
            uiHelper.showToastNotification('该 Agent 正在心流锁中，无法创建并切换到分支话题。', 'warning');
            return;
        }
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

            saveResult = await saveHistory(itemId, itemType, newTopicId, historyForNewBranch);

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
        const timer = setTimeout(async () => {
            forwardTimers.delete(timer);
            if (disposed) return;
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
        forwardTimers.add(timer);
    }

    // --- Canvas Integration ---
    const CANVAS_PLACEHOLDER = '{{VCPChatCanvas}}';

    function handleCanvasContentUpdate(data) {
        if (disposed) return;
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
        if (disposed) return;
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
        const syncGeneration = ++historySyncGeneration;
        const itemGeneration = itemSelectionGeneration;
        const topicGeneration = topicSelectionGeneration;
        const isSyncCurrent = () => {
            const selectedItem = currentSelectedItemRef.get();
            return !disposed
                && Boolean(messageRenderer)
                && syncGeneration === historySyncGeneration
                && itemGeneration === itemSelectionGeneration
                && topicGeneration === topicSelectionGeneration
                && selectedItem?.id === itemId
                && selectedItem?.type === itemType
                && currentTopicIdRef.get() === topicId;
        };
        if (!isSyncCurrent()) return;

        // 🔧 检查是否有正在进行的编辑操作
        const isEditing = document.querySelector('.message-item-editing');
        if (isEditing) {
            console.log('[Sync] Aborting sync because a message is currently being edited.');
            return;
        }

        // Capture active stream ownership before the async read. A stream may
        // reach terminal while the read is in flight; that terminal must not
        // be mistaken for a file-side deletion when the active id disappears.
        const activeStreamingIdAtRead = streamProjection?.getActiveStreamingMessageId?.() || null;

        // 1. Fetch the latest history from the file
        let newHistory;
        if (itemType === 'agent') {
            newHistory = await getHistory(itemId, itemType, topicId);
        } else if (itemType === 'group') {
            newHistory = await getHistory(itemId, itemType, topicId);
        }

        // A file notification may resolve after navigation, a newer sync, or
        // teardown. Only the still-selected conversation may update its view.
        if (!isSyncCurrent()) return;

        if (!newHistory || newHistory.error) {
            console.error("Sync failed: Could not fetch new history.", newHistory?.error);
            return;
        }

        const oldHistory = currentChatHistoryRef.get();
        let historyInMem = [...oldHistory]; // Create a mutable copy to work with

        const oldHistoryMap = new Map(oldHistory.map(msg => [msg.id, msg]));
        const newHistoryMap = new Map(newHistory.map(msg => [msg.id, msg]));
        const activeStreamingId = streamProjection?.getActiveStreamingMessageId?.() || null;
        const protectedStreamingIds = new Set(
            [activeStreamingIdAtRead, activeStreamingId].filter(Boolean),
        );

        // --- Perform UI and Memory updates ---

        // 2. Handle DELETED and MODIFIED messages
        for (const oldMsg of oldHistory) {
            if (protectedStreamingIds.has(oldMsg.id)) {
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
            if (protectedStreamingIds.has(a.id)) return 1;
            if (protectedStreamingIds.has(b.id)) return -1;
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



    async function dispose() {
        if (disposed) return;
        disposed = true;
        initialized = false;
        itemSelectionGeneration += 1;
        topicSelectionGeneration += 1;
        topicCreationGeneration += 1;
        activeHistoryLoadToken += 1;
        historySyncGeneration += 1;
        pendingItemSelectionToken = null;
        emptyStateObserver?.disconnect();
        emptyStateObserver = null;
        canvasContentDisposer?.();
        canvasClosedDisposer?.();
        canvasContentDisposer = null;
        canvasClosedDisposer = null;
        for (const timer of forwardTimers) clearTimeout(timer);
        forwardTimers.clear();
        await Promise.allSettled([
            lastOpenSaveQueue,
            ...outgoingPersistenceQueues.values(),
        ]);
        outgoingPersistenceQueues.clear();
        pendingSendContexts.clear();
    }

    // --- Public API ---
    return {
        init,
        dispose,
        isReady: () => initialized,
        selectItem,
        restoreLastOpenState,
        selectTopic,
        handleTopicDeletion,
        loadChatHistory,
        handleSendMessage,
        sendMessage: handleSendMessage,
        createNewTopicForItem,
        displayNoItemSelected,
        syncNextUiEmptyStateWithMessages,
        attemptTopicSummarizationIfNeeded,
        handleCreateBranch,
        handleForwardMessage,
        removeAttachmentFromMessage,
        addAttachmentsToMessage,
        processFilesData,
        syncHistoryFromFile, // Expose the new function
    };
})();
