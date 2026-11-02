// Flowlockmodules/flowlock-integration.js
// Flowlock模块集成脚本 - 负责初始化和事件监听
// 多 Agent 并发架构：续写不再依赖当前 UI 状态，而是按指定 Agent/Topic 后台执行。

console.log('[Flowlock Integration] Loading integration script (multi-session)...');
let chatManagerProvider = null;
let historyMutationAuthorityProvider = null;
let settingsProvider = null;
const mainChatSnapshot = () => window.VCPMainChatState?.snapshot?.() || { selectedItem: null, topicId: null };

/**
 * 初始化Flowlock模块
 * 应在DOMContentLoaded后调用
 */
function initializeFlowlock() {
    console.log('[Flowlock Integration] Initializing Flowlock module...');

    if (!window.flowlockManager) {
        console.error('[Flowlock Integration] flowlockManager not found on window object!');
        return;
    }

    const electronAPI = window.electronAPI || (window.chatAPI);

    // 初始化flowlockManager
    window.flowlockManager.initialize({
        electronAPI: electronAPI,
        uiHelper: window.uiHelperFunctions,
        globalSettingsRef: {
            get: () => settingsProvider?.get?.() || {}
        },
        continueWritingForContext: continueWritingForContext
    });

    // 页面重载后只恢复明确且唯一的 pending 请求；冲突请求保持 pending 供人工处理。
    Promise.resolve(window.flowlockManager.recoverPendingRequests?.()).catch((error) => {
        console.error('[Flowlock Integration] Failed to recover pending requests:', error);
    });

    console.log('[Flowlock Integration] Flowlock module initialized successfully (multi-session).');
}

const FLOWLOCK_SYSTEM_PROMPT_PREFIX = '[系统提示:]';

/**
 * 规范化心跳提示词。若内容已经以 [系统提示:] 开头则保持不变，
 * 否则补充前缀，避免后端将 Flowlock 心跳识别为普通 user 发言。
 */
function normalizeFlowlockHeartbeatPrompt(prompt) {
    const normalized = typeof prompt === 'string' ? prompt.trim() : '';
    if (/^\[系统提示:\]/.test(normalized)) {
        return normalized;
    }
    return `${FLOWLOCK_SYSTEM_PROMPT_PREFIX}${normalized ? ` ${normalized}` : ''}`;
}


/**
 * 按指定 Agent/Topic 执行后台续写
 * 不依赖当前 UI 状态，直接从文件系统读取历史记录
 * @param {Object} params - { agentId, topicId, prompt, messageId }
 */
async function continueWritingForContext(params) {
    const { agentId, topicId, prompt, messageId } = params;
    const chatAPI = window.chatAPI || window.electronAPI;
    const globalSettings = settingsProvider?.get?.() || {};

    if (!agentId || !topicId) {
        console.error('[Flowlock] continueWritingForContext: missing agentId or topicId');
        throw new Error('缺少 agentId 或 topicId');
    }

    if (!globalSettings.vcpServerUrl) {
        throw new Error('VCP 服务器 URL 未配置');
    }

    console.log(`[Flowlock] continueWritingForContext: agent=${agentId}, topic=${topicId}, prompt="${(prompt || '').substring(0, 50)}..."`);

    // 从文件系统读取历史记录
    let historyForVCP = await chatAPI.getChatHistory(agentId, topicId);
    if (!historyForVCP || historyForVCP.error) {
        throw new Error(`无法读取历史记录: ${historyForVCP?.error || 'unknown'}`);
    }

    // 过滤掉思考中消息
    historyForVCP = historyForVCP.filter(msg => !msg.isThinking);

    // 获取 Agent 配置
    const agentConfig = await chatAPI.getAgentConfig(agentId);
    if (agentConfig && agentConfig.error) {
        throw new Error(`无法获取 Agent 配置: ${agentConfig.error}`);
    }

    if (typeof chatManagerProvider?.prepareFlowlockContext === 'function') {
        historyForVCP = await chatManagerProvider.prepareFlowlockContext({
            agentId, topicId, history: historyForVCP, agentConfig, prompt: prompt || '',
        });
    }

    // 确定提示词
    let temporaryPrompt = prompt;
    if (!temporaryPrompt || !temporaryPrompt.trim()) {
        // 检查是否有上一条 AI 消息
        const lastAiMessage = [...historyForVCP].reverse().find(msg => msg.role === 'assistant');
        if (lastAiMessage) {
            temporaryPrompt = globalSettings.continueWritingPrompt || '[系统提示:] 请继续。若当前已无值得继续推进的任务或话题，请输出 [[Flowlock::Stop]] 关闭心流锁心跳。';
        } else {
            temporaryPrompt = '';
        }
    }

    // 所有 Flowlock 心跳消息必须使用系统提示标记；已有前缀时不重复添加。
    temporaryPrompt = normalizeFlowlockHeartbeatPrompt(temporaryPrompt);
    const { assembleRequestMessages } = await import('../modules/chat/chatContextPipeline.js');
    const { messagesForVCP } = await assembleRequestMessages({
        electronAPI: chatAPI, agentConfig: agentConfig || {}, history: historyForVCP,
        context: { agentId, topicId }, temporaryPrompt,
    });

    const useStreaming = (agentConfig?.streamOutput !== false);
    const modelConfigForVCP = {
        model: agentConfig?.model || 'gemini-pro',
        temperature: agentConfig?.temperature !== undefined ? parseFloat(agentConfig.temperature) : 0.7,
        ...(agentConfig?.maxOutputTokens && { max_tokens: parseInt(agentConfig.maxOutputTokens) }),
        ...(agentConfig?.contextTokenLimit && { contextTokenLimit: parseInt(agentConfig.contextTokenLimit) }),
        stream: useStreaming
    };

    if (params.isCurrent && !params.isCurrent()) throw new Error('心流会话已停止、切换或挂起');
    if (chatManagerProvider?.isContextCompacting?.({ itemId: agentId, itemType: 'agent', topicId })) {
        throw new Error('上下文压缩期间不能发送心流心跳');
    }

    // 创建续写消息占位
    const thinkingMessageId = messageId || `flowlock_${agentId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const thinkingMessage = {
        role: 'assistant',
        name: agentConfig?.name || agentId,
        content: '',
        timestamp: Date.now(),
        id: thinkingMessageId,
        isThinking: true,
        avatarUrl: agentConfig?.avatarUrl,
        avatarColor: agentConfig?.avatarCalculatedColor
    };

    const { selectedItem: currentSelectedItem, topicId: currentTopicId } = mainChatSnapshot();
    const isForCurrentView = currentSelectedItem?.id === agentId && currentTopicId === topicId;

    // 构建上下文。后台流也必须带完整身份，streamManager 才能写入正确历史。
    const context = {
        agentId: agentId,
        agentName: agentConfig?.name || agentId,
        topicId: topicId,
        isGroupMessage: false,
        avatarUrl: agentConfig?.avatarUrl,
        avatarColor: agentConfig?.avatarCalculatedColor
    };

    // Streaming lifecycle is now started by the VCP stream bridge when the
    // producer publishes its first owned event. This prevents Flowlock from
    // creating a second terminal state machine for the same message.
    if (!useStreaming) {
        let historyWithThinking = await chatAPI.getChatHistory(agentId, topicId);
        if (!historyWithThinking || historyWithThinking.error) {
            historyWithThinking = [];
        }
        historyWithThinking.push(thinkingMessage);
        await historyMutationAuthorityProvider.replace({
            itemId: agentId,
            itemType: 'agent',
            topicId,
            category: 'flowlock-start'
        }, historyWithThinking);
    }

    if (params.isCurrent && !params.isCurrent()) throw new Error('心流会话已停止、切换或挂起');

    // 发送到 VCP
    const vcpResponse = await chatAPI.sendToVCP(
        globalSettings.vcpServerUrl,
        globalSettings.vcpApiKey,
        messagesForVCP,
        modelConfigForVCP,
        thinkingMessageId,
        false,
        context
    );

    // 非流式处理
    if (!useStreaming) {
        const response = vcpResponse?.response ?? vcpResponse;
        const responseContext = vcpResponse?.context ?? context;

        if (response?.error) {
            throw new Error(`VCP错误: ${response.error}`);
        } else if (response?.choices?.length > 0) {
            const assistantMessageContent = response.choices[0].message.content;
            const assistantMessage = {
                role: 'assistant',
                name: agentConfig?.name || agentId,
                avatarUrl: agentConfig?.avatarUrl,
                avatarColor: agentConfig?.avatarCalculatedColor,
                content: assistantMessageContent,
                timestamp: Date.now(),
                id: response.id || `flowlock_nonstream_${Date.now()}`
            };

            const historyForSave = await chatAPI.getChatHistory(agentId, topicId);
            if (historyForSave && !historyForSave.error) {
                const finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessageId && !msg.isThinking);
                finalHistory.push(assistantMessage);
                await historyMutationAuthorityProvider.replace({
                    itemId: agentId,
                    itemType: 'agent',
                    topicId,
                    category: 'flowlock-terminal'
                }, finalHistory);

                if (isForCurrentView && chatManagerProvider?.loadChatHistory) {
                    await chatManagerProvider.loadChatHistory(agentId, 'agent', topicId);
                }
            }

            // 非流式回复不会产生 stream end 事件，直接进入统一完成入口。
            await window.flowlockManager?.handleFinalizedMessage({
                type: 'end',
                messageId: thinkingMessageId,
                context: responseContext,
                content: assistantMessageContent,
                finishReason: 'completed'
            });
        }
    } else {
        if (vcpResponse?.streamError) {
            throw new Error(`流式启动失败: ${vcpResponse.errorDetail || vcpResponse.error}`);
        }
    }
}

/**
 * 设置右键和中键事件监听
 */
function setupFlowlockInteractions() {
    const chatNameElement = document.getElementById('currentChatAgentName');
    if (!chatNameElement) {
        console.warn('[Flowlock Integration] Chat name element not found.');
        return;
    }

    // 右键菜单 - 启动/停止心流锁
    chatNameElement.addEventListener('contextmenu', async (e) => {
        if (!window.flowlockManager) return;

        e.preventDefault();

        const { selectedItem: currentItem, topicId: currentTopic } = mainChatSnapshot();

        if (!currentItem || !currentItem.id || !currentTopic) {
            if (window.uiHelperFunctions?.showToastNotification) {
                window.uiHelperFunctions.showToastNotification('请先选择一个Agent和话题', 'warning');
            }
            return;
        }

        // 如果该 Agent 已经激活，则停止
        if (window.flowlockManager.isAgentLocked(currentItem.id)) {
            await window.flowlockManager.stop(currentItem.id);
        } else {
            // 启动心流锁（不立即续写）
            await window.flowlockManager.start(currentItem.id, currentTopic, { startImmediately: false });
        }
    });

    // 中键点击 - 启动并立即续写 / 停止
    chatNameElement.addEventListener('mousedown', async (e) => {
        if (e.button !== 1) return; // 只处理中键

        e.preventDefault();
        e.stopPropagation();

        if (!window.flowlockManager) return;

        const { selectedItem: currentItem, topicId: currentTopic } = mainChatSnapshot();

        if (window.flowlockManager.isAgentLocked(currentItem.id)) {
            // 如果已激活，则停止
            await window.flowlockManager.stop(currentItem.id);
        } else {
            if (!currentItem || !currentItem.id || !currentTopic) {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification('请先选择一个Agent和话题', 'warning');
                }
                return;
            }

            // 启动心流锁并立即续写
            await window.flowlockManager.start(currentItem.id, currentTopic, { startImmediately: true });
        }
    });

    console.log('[Flowlock Integration] Event listeners setup complete.');
}

/**
 * 设置快捷键监听
 */
function setupFlowlockShortcuts() {
    document.addEventListener('keydown', async (e) => {
        // Command/Ctrl + G - 启动心流锁并立即续写 / 停止心流锁
        if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
            e.preventDefault();

            if (!window.flowlockManager) return;

            const { selectedItem: currentItem, topicId: currentTopic } = mainChatSnapshot();

            if (!currentItem || !currentItem.id || !currentTopic) {
                if (window.uiHelperFunctions?.showToastNotification) {
                    window.uiHelperFunctions.showToastNotification('请先选择一个Agent和话题', 'warning');
                }
                return;
            }

            if (window.flowlockManager.isAgentLocked(currentItem.id)) {
                // 如果已激活，则停止
                await window.flowlockManager.stop(currentItem.id);
            } else {
                // 启动心流锁并立即续写
                await window.flowlockManager.start(currentItem.id, currentTopic, { startImmediately: true });
            }
        }
    });

    console.log('[Flowlock Integration] Shortcuts setup complete.');
}

/**
 * 主初始化函数
 */
function initializeFlowlockIntegration(dependencies = {}) {
    try {
        const provider = dependencies.chatManager;
        if (!provider || typeof provider.loadChatHistory !== 'function' || provider.isReady?.() === false) {
            throw new TypeError('Flowlock integration requires a ready ChatManager provider.');
        }
        const mutationAuthority = dependencies.historyMutationAuthority;
        if (!mutationAuthority || typeof mutationAuthority.replace !== 'function') {
            throw new TypeError('Flowlock integration requires a history mutation authority.');
        }
        if (chatManagerProvider && chatManagerProvider !== provider) {
            throw new Error('Flowlock ChatManager provider is already registered.');
        }
        if (historyMutationAuthorityProvider && historyMutationAuthorityProvider !== mutationAuthority) {
            throw new Error('Flowlock history mutation authority is already registered.');
        }
        if (!dependencies.settings || typeof dependencies.settings.get !== 'function') {
            throw new TypeError('Flowlock integration requires a settings provider.');
        }
        chatManagerProvider = provider;
        historyMutationAuthorityProvider = mutationAuthority;
        settingsProvider = dependencies.settings;
        initializeFlowlock();
        setupFlowlockInteractions();
        setupFlowlockShortcuts();

        // 页面卸载时清理
        const cleanup = () => {
            if (window.flowlockManager) {
                window.flowlockManager.cleanup();
            }
        };
        if (dependencies.listenerOwner?.add) dependencies.listenerOwner.add(window, 'beforeunload', cleanup, { once: true });
        else window.addEventListener('beforeunload', cleanup, { once: true });

        console.log('[Flowlock Integration] Full integration complete (multi-session).');
    } catch (error) {
        console.error('[Flowlock Integration] Initialization failed:', error);
    }
}

// 导出到全局作用域
window.initializeFlowlockIntegration = initializeFlowlockIntegration;

console.log('[Flowlock Integration] Integration script loaded (multi-session).');
