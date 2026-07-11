// Flowlockmodules/flowlock-integration.js
// Flowlock模块集成脚本 - 负责初始化和事件监听
// 多 Agent 并发架构：续写不再依赖当前 UI 状态，而是按指定 Agent/Topic 后台执行。

console.log('[Flowlock Integration] Loading integration script (multi-session)...');

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
            get: () => window.globalSettings || {}
        },
        continueWritingForContext: continueWritingForContext
    });

    console.log('[Flowlock Integration] Flowlock module initialized successfully (multi-session).');
}

/**
 * 按指定 Agent/Topic 执行后台续写
 * 不依赖当前 UI 状态，直接从文件系统读取历史记录
 * @param {Object} params - { agentId, topicId, prompt, messageId }
 */
async function continueWritingForContext(params) {
    const { agentId, topicId, prompt, messageId } = params;
    const chatAPI = window.chatAPI || window.electronAPI;
    const globalSettings = window.globalSettings || {};

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

    // 确定提示词
    let temporaryPrompt = prompt;
    if (!temporaryPrompt || !temporaryPrompt.trim()) {
        // 检查是否有上一条 AI 消息
        const lastAiMessage = [...historyForVCP].reverse().find(msg => msg.role === 'assistant');
        if (lastAiMessage) {
            temporaryPrompt = globalSettings.continueWritingPrompt || '请继续';
        } else {
            temporaryPrompt = '';
        }
    }

    // 构建 VCP 消息
    const messagesForVCP = await Promise.all(historyForVCP.map(async msg => {
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

    // 添加临时用户消息（如果有提示词）
    if (temporaryPrompt && temporaryPrompt.trim()) {
        messagesForVCP.push({ role: 'user', content: temporaryPrompt });
    }

    // 注入系统提示词
    if (agentConfig && agentConfig.systemPrompt) {
        let systemPromptContent = agentConfig.systemPrompt.replace(/\{\{AgentName\}\}/g, agentConfig.name || agentId);
        const prependedContent = [];

        if (agentConfig.agentDataPath && topicId) {
            const historyPath = `${agentConfig.agentDataPath}\\topics\\${topicId}\\history.json`;
            prependedContent.push(`当前聊天记录文件路径: ${historyPath}`);
        }

        if (agentConfig.topics && topicId) {
            const currentTopicObj = agentConfig.topics.find(t => t.id === topicId);
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

    const currentSelectedItem = window.currentSelectedItem;
    const currentTopicId = window.currentTopicId;
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

    // 流式消息必须在发送请求前初始化，无论它当前是否可见。
    // streamManager 自己负责“当前视图渲染 / 后台只写历史”的分流。
    if (useStreaming) {
        const streamStarter = window.streamManager?.startStreamingMessage
            || window.messageRenderer?.startStreamingMessage;
        if (typeof streamStarter !== 'function') {
            throw new Error('流式消息管理器未就绪');
        }

        await streamStarter({
            ...thinkingMessage,
            content: '',
            agentId,
            topicId,
            context
        });
    } else {
        let historyWithThinking = await chatAPI.getChatHistory(agentId, topicId);
        if (!historyWithThinking || historyWithThinking.error) {
            historyWithThinking = [];
        }
        historyWithThinking.push(thinkingMessage);
        await chatAPI.saveChatHistory(agentId, topicId, historyWithThinking);
    }

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
                await chatAPI.saveChatHistory(agentId, topicId, finalHistory);

                if (isForCurrentView && window.chatManager?.loadChatHistory) {
                    await window.chatManager.loadChatHistory(agentId, 'agent', topicId);
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

        const currentItem = window.currentSelectedItem;
        const currentTopic = window.currentTopicId;

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

        const currentItem = window.currentSelectedItem;
        const currentTopic = window.currentTopicId;

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

            const currentItem = window.currentSelectedItem;
            const currentTopic = window.currentTopicId;

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
function initializeFlowlockIntegration() {
    try {
        initializeFlowlock();
        setupFlowlockInteractions();
        setupFlowlockShortcuts();

        // 页面卸载时清理
        window.addEventListener('beforeunload', () => {
            if (window.flowlockManager) {
                window.flowlockManager.cleanup();
            }
        });

        console.log('[Flowlock Integration] Full integration complete (multi-session).');
    } catch (error) {
        console.error('[Flowlock Integration] Initialization failed:', error);
    }
}

// 导出到全局作用域
window.initializeFlowlockIntegration = initializeFlowlockIntegration;

console.log('[Flowlock Integration] Integration script loaded (multi-session).');