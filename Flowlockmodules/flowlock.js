// Flowlockmodules/flowlock.js
// 心流锁模块 - 多 Agent 并发自动续写状态机
// 每个 Agent 最多持有一个活动 Session，绑定到一个 Topic。
// 多个 Agent 可并行运行，互不阻塞主界面导航。

console.log('[Flowlock] Module loaded (multi-session architecture).');

class FlowlockManager {
    constructor() {
        /** @type {Map<string, FlowlockSession>} agentId -> Session */
        this.sessions = new Map();
        this.electronAPI = null;
        this.uiHelper = null;
        this.globalSettingsRef = null;
        this.continueWritingForContext = null;
    }

    /**
     * 初始化心流锁管理器
     * @param {Object} refs - 依赖引用
     */
    initialize(refs) {
        if (!refs.electronAPI || !refs.uiHelper) {
            console.error('[Flowlock] Initialization failed: Missing required references.');
            return;
        }

        this.electronAPI = refs.electronAPI;
        this.uiHelper = refs.uiHelper;
        this.globalSettingsRef = refs.globalSettingsRef || null;
        this.continueWritingForContext = refs.continueWritingForContext || null;

        console.log('[Flowlock] Initialized successfully (multi-session).');
    }

    /**
     * 启动心流锁
     * @param {string} agentId - Agent ID
     * @param {string} topicId - Topic ID
     * @param {Object} options - { startImmediately, prompt, delaySeconds }
     */
    async start(agentId, topicId, options = {}) {
        // 兼容旧接口 start(agentId, topicId, startImmediately)。
        if (typeof options === 'boolean') {
            options = { startImmediately: options };
        }

        if (!agentId || !topicId) {
            console.error('[Flowlock] start() requires agentId and topicId.');
            return { success: false, message: '缺少 agentId 或 topicId' };
        }

        // 如果该 Agent 已有活动 Session，先停止旧的
        if (this.sessions.has(agentId)) {
            console.log(`[Flowlock] Agent ${agentId} already has an active session, stopping old one.`);
            await this.stop(agentId);
        }

        const {
            startImmediately = false,
            prompt = null,
            delaySeconds = null
        } = options;

        const globalSettings = this.globalSettingsRef?.get?.() || {};
        const defaultDelay = delaySeconds ?? globalSettings.flowlockContinueDelay ?? 5;

        const session = {
            agentId,
            topicId,
            status: 'active',
            generation: 0,
            activeMessageId: null,
            pendingTimer: null,
            round: 0,
            retryCount: 0,
            maxRetries: 3,
            defaultDelaySeconds: defaultDelay,
            nextDelaySeconds: null,
            defaultPrompt: prompt,
            nextPrompt: null,
            startedAt: Date.now(),
            lastTriggeredAt: null,
            lastCompletedAt: null,
            nextHeartbeatAt: null,
            lastControlMessageId: null,
            lastError: null,
            completionReason: null
        };

        this.sessions.set(agentId, session);

        console.log(`[Flowlock] Started for agent: ${agentId}, topic: ${topicId}`);

        // 更新侧栏状态动画
        this.updateSidebarIndicator(agentId, true);

        // 显示通知
        if (this.uiHelper?.showToastNotification) {
            this.uiHelper.showToastNotification(`Agent "${agentId}" 心流锁已启动`, 'success');
        }

        // 如果需要立即开始续写
        if (startImmediately) {
            this.scheduleNextRound(agentId, 500);
        }

        return { success: true, message: '心流锁已启动' };
    }

    /**
     * 停止指定 Agent 的心流锁
     */
    async stop(agentId) {
        // 兼容旧插件 stop()：优先停止当前可见 Agent，不再错误地停止其他并发 Session。
        const resolvedAgentId = agentId || window.currentSelectedItem?.id;
        const session = this.sessions.get(resolvedAgentId);
        agentId = resolvedAgentId;
        if (!session) {
            console.log(`[Flowlock] No active session for agent: ${agentId}`);
            return { success: false, message: '心流锁未运行' };
        }

        // 取消待执行的定时器
        if (session.pendingTimer) {
            clearTimeout(session.pendingTimer);
            session.pendingTimer = null;
        }

        // 增加 generation 防止旧 timer 复活
        session.generation++;
        session.status = 'stopped';
        session.completionReason = session.completionReason || 'manual_stop';

        console.log(`[Flowlock] Stopped for agent: ${agentId}`);

        // 更新侧栏状态动画
        this.updateSidebarIndicator(agentId, false);

        // 显示通知
        if (this.uiHelper?.showToastNotification) {
            this.uiHelper.showToastNotification(`Agent "${agentId}" 心流锁已停止`, 'info');
        }

        this.sessions.delete(agentId);
        return { success: true, message: '心流锁已停止' };
    }

    /**
     * 停止所有心流锁
     */
    async stopAll() {
        const agentIds = Array.from(this.sessions.keys());
        for (const agentId of agentIds) {
            await this.stop(agentId);
        }
    }

    /**
     * 处理消息完成事件 - 核心入口
     * 由 renderer.js 的流结束事件调用
     * @param {Object} event - { type, messageId, context, content, finishReason, error }
     */
    async handleFinalizedMessage(event) {
        const { type, messageId, context, content, finishReason, error } = event;

        if (!context || !context.agentId || !context.topicId || context.isGroupMessage) {
            return;
        }

        const protocol = type !== 'error' && typeof content === 'string'
            ? window.flowlockProtocol?.parse(content)
            : null;

        let session = this.sessions.get(context.agentId);

        // AI 可在普通回复末尾自主进入心流锁；消息 context 是唯一可信身份来源。
        if ((!session || session.status !== 'active') && protocol?.shouldStart) {
            await this.start(context.agentId, context.topicId, { startImmediately: false });
            session = this.sessions.get(context.agentId);
        }

        if (!session || session.status !== 'active') {
            return;
        }

        // 只处理属于当前 Session 绑定 Topic 的消息
        if (context.topicId !== session.topicId) {
            return;
        }

        // 只处理由本 Session 触发的活动消息
        // （避免普通用户消息或其他来源的消息误触发下一轮）
        if (session.activeMessageId && messageId !== session.activeMessageId) {
            return;
        }

        session.lastCompletedAt = Date.now();
        session.activeMessageId = null;

        // 如果是错误完成
        if (type === 'error' || finishReason === 'error') {
            session.lastError = error || 'Unknown error';
            session.retryCount++;

            if (session.retryCount >= session.maxRetries) {
                console.error(`[Flowlock] Agent ${context.agentId} max retries reached (${session.retryCount}/${session.maxRetries}), stopping.`);
                if (this.uiHelper?.showToastNotification) {
                    this.uiHelper.showToastNotification(
                        `Agent "${context.agentId}" 心流锁续写失败次数过多，已自动停止`,
                        'error'
                    );
                }
                session.completionReason = 'max_retries_exceeded';
                await this.stop(context.agentId);
                return;
            }

            console.log(`[Flowlock] Agent ${context.agentId} error, retry ${session.retryCount}/${session.maxRetries}`);
            if (this.uiHelper?.showToastNotification) {
                this.uiHelper.showToastNotification(
                    `Agent "${context.agentId}" 续写失败，正在重试 (${session.retryCount}/${session.maxRetries})`,
                    'warning'
                );
            }

            // 错误重试使用默认延迟
            this.scheduleNextRound(context.agentId, session.defaultDelaySeconds * 1000);
            return;
        }

        // 正常完成 - 解析 AI 输出中的控制协议
        session.retryCount = 0; // 重置重试计数

        if (protocol && protocol.hasCommands) {
                // 处理终端命令（优先级：Fail > Complete > Stop）
                if (protocol.terminalType === 'fail') {
                    console.log(`[Flowlock] Agent ${context.agentId} reported failure: ${protocol.failReason || '(no reason)'}`);
                    session.completionReason = 'agent_fail';
                    session.lastError = protocol.failReason || null;
                    await this.stop(context.agentId);
                    return;
                }

                if (protocol.terminalType === 'complete') {
                    console.log(`[Flowlock] Agent ${context.agentId} reported task complete.`);
                    session.completionReason = 'agent_complete';
                    await this.stop(context.agentId);
                    return;
                }

                if (protocol.terminalType === 'stop') {
                    console.log(`[Flowlock] Agent ${context.agentId} requested stop.`);
                    session.completionReason = 'agent_stop';
                    await this.stop(context.agentId);
                    return;
                }

                // 处理 NextHeartbeat
                if (protocol.nextHeartbeatSeconds !== null) {
                    session.nextDelaySeconds = protocol.nextHeartbeatSeconds;
                    console.log(`[Flowlock] Agent ${context.agentId} next heartbeat in ${protocol.nextHeartbeatSeconds}s`);
                }

                // 处理 NextPrompt
                if (protocol.nextPrompt !== null) {
                    session.nextPrompt = protocol.nextPrompt;
                    console.log(`[Flowlock] Agent ${context.agentId} next prompt set (${protocol.nextPrompt.length} chars)`);
                }

                // 如果有 Start 命令但没有终端命令，维持运行
                if (protocol.shouldStart) {
                    // AI 明确要求启动心流锁，确保 Session 保持活动
                    console.log(`[Flowlock] Agent ${context.agentId} requested start, maintaining session.`);
                }
            }

        // 安排下一轮
        const delayMs = (session.nextDelaySeconds ?? session.defaultDelaySeconds) * 1000;
        this.scheduleNextRound(context.agentId, delayMs);
    }

    /**
     * 安排下一轮续写
     * @param {string} agentId
     * @param {number} delayMs - 延迟毫秒
     */
    scheduleNextRound(agentId, delayMs) {
        const session = this.sessions.get(agentId);
        if (!session || session.status !== 'active') return;

        // 取消已有的定时器
        if (session.pendingTimer) {
            clearTimeout(session.pendingTimer);
        }

        const currentGeneration = session.generation;
        session.nextHeartbeatAt = Date.now() + delayMs;

        session.pendingTimer = setTimeout(async () => {
            // 检查 generation 防止旧 timer 复活
            if (session.generation !== currentGeneration) {
                console.log(`[Flowlock] Agent ${agentId} timer expired but generation changed, skipping.`);
                return;
            }

            await this.triggerRound(agentId);
        }, delayMs);

        console.log(`[Flowlock] Agent ${agentId} next round scheduled in ${delayMs}ms`);
    }

    /**
     * 触发一轮续写
     * @param {string} agentId
     */
    async triggerRound(agentId) {
        const session = this.sessions.get(agentId);
        if (!session || session.status !== 'active') return;

        // 检查续写函数是否可用
        if (!this.continueWritingForContext) {
            console.error('[Flowlock] continueWritingForContext function not available.');
            session.completionReason = 'no_continue_function';
            await this.stop(agentId);
            return;
        }

        session.round++;
        session.lastTriggeredAt = Date.now();

        // 确定提示词：优先使用 nextPrompt，其次 defaultPrompt
        let prompt = session.nextPrompt;
        if (prompt === null || prompt === undefined) {
            prompt = session.defaultPrompt;
        }

        // 生成消息 ID
        const messageId = `flowlock_${agentId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        session.activeMessageId = messageId;
        session.lastControlMessageId = messageId;

        // 消费一次性的 nextPrompt 和 nextDelaySeconds
        session.nextPrompt = null;
        session.nextDelaySeconds = null;

        console.log(`[Flowlock] Agent ${agentId} triggering round ${session.round}, messageId: ${messageId}`);

        // 更新侧栏心跳动画
        this.triggerSidebarHeartbeat(agentId);

        try {
            await this.continueWritingForContext({
                agentId: session.agentId,
                topicId: session.topicId,
                prompt: prompt || '',
                messageId: messageId
            });
        } catch (error) {
            console.error(`[Flowlock] Agent ${agentId} continue writing failed:`, error);
            session.lastError = error.message;
            session.activeMessageId = null;

            // 走错误重试逻辑
            session.retryCount++;
            if (session.retryCount >= session.maxRetries) {
                session.completionReason = 'max_retries_exceeded';
                await this.stop(agentId);
                return;
            }

            // 重试
            this.scheduleNextRound(agentId, session.defaultDelaySeconds * 1000);
        }
    }

    /**
     * 设置自定义提示词
     * @param {string} agentId
     * @param {string} prompt
     */
    setCustomPrompt(agentId, prompt) {
        const session = this.sessions.get(agentId);
        if (!session) {
            console.warn(`[Flowlock] Cannot set prompt: no active session for ${agentId}`);
            return;
        }
        session.nextPrompt = prompt;
        console.log(`[Flowlock] Agent ${agentId} next prompt set: ${prompt?.substring(0, 50)}...`);
    }

    /**
     * 设置下一轮心跳延迟
     * @param {string} agentId
     * @param {number} seconds
     */
    setNextHeartbeat(agentId, seconds) {
        const session = this.sessions.get(agentId);
        if (!session) return;
        session.nextDelaySeconds = Math.max(1, Math.min(86400, parseInt(seconds, 10) || session.defaultDelaySeconds));
        console.log(`[Flowlock] Agent ${agentId} next heartbeat set to ${session.nextDelaySeconds}s`);
    }

    /**
     * 检查 Agent 是否处于锁状态
     */
    isAgentLocked(agentId) {
        const session = this.sessions.get(agentId);
        return !!(session && session.status === 'active');
    }

    /**
     * 检查指定 Topic 是否是某个 Agent 的锁定 Topic
     */
    isTopicLocked(agentId, topicId) {
        const session = this.sessions.get(agentId);
        return !!(session && session.status === 'active' && session.topicId === topicId);
    }

    /**
     * 获取 Agent 的锁定 Topic ID
     */
    getLockedTopicId(agentId) {
        const session = this.sessions.get(agentId);
        return (session && session.status === 'active') ? session.topicId : null;
    }

    /**
     * 获取所有活动 Agent 的列表
     */
    getActiveAgents() {
        const result = [];
        for (const [agentId, session] of this.sessions) {
            if (session.status === 'active') {
                result.push({
                    agentId,
                    topicId: session.topicId,
                    round: session.round,
                    startedAt: session.startedAt,
                    nextHeartbeatAt: session.nextHeartbeatAt
                });
            }
        }
        return result;
    }

    /**
     * 获取指定 Agent 的 Session 状态
     */
    getSession(agentId) {
        const session = this.sessions.get(agentId);
        if (!session) return null;
        return {
            agentId: session.agentId,
            topicId: session.topicId,
            status: session.status,
            round: session.round,
            retryCount: session.retryCount,
            maxRetries: session.maxRetries,
            activeMessageId: session.activeMessageId,
            startedAt: session.startedAt,
            lastTriggeredAt: session.lastTriggeredAt,
            lastCompletedAt: session.lastCompletedAt,
            nextHeartbeatAt: session.nextHeartbeatAt,
            lastError: session.lastError,
            completionReason: session.completionReason,
            hasCustomPrompt: session.nextPrompt !== null,
            nextDelaySeconds: session.nextDelaySeconds
        };
    }

    /**
     * 兼容旧接口：返回全局状态
     * 如果有任何活动 Session，返回第一个；否则返回非活动状态。
     */
    getState() {
        for (const [, session] of this.sessions) {
            if (session.status === 'active') {
                return {
                    isActive: true,
                    isProcessing: !!session.activeMessageId,
                    currentAgentId: session.agentId,
                    currentTopicId: session.topicId,
                    retryCount: session.retryCount,
                    maxRetries: session.maxRetries,
                    round: session.round
                };
            }
        }
        return {
            isActive: false,
            isProcessing: false,
            currentAgentId: null,
            currentTopicId: null,
            retryCount: 0,
            maxRetries: 3,
            round: 0
        };
    }

    /**
     * 更新侧栏 Agent 状态指示器
     * @param {string} agentId
     * @param {boolean} active
     */
    updateSidebarIndicator(agentId, active) {
        const escapedAgentId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(agentId)
            : String(agentId).replace(/["\\]/g, '\\$&');
        const itemElement = document.querySelector(`#agentList li[data-item-id="${escapedAgentId}"][data-item-type="agent"]`);
        if (!itemElement) return;

        const avatarWrapper = itemElement.querySelector('.avatar-wrapper');
        if (!avatarWrapper) return;

        if (active) {
            avatarWrapper.classList.add('flowlock-active-ring');
        } else {
            avatarWrapper.classList.remove('flowlock-active-ring');
            avatarWrapper.classList.remove('flowlock-heartbeat-ring');
        }
    }

    /**
     * 触发侧栏心跳动画
     * @param {string} agentId
     */
    triggerSidebarHeartbeat(agentId) {
        const escapedAgentId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(agentId)
            : String(agentId).replace(/["\\]/g, '\\$&');
        const itemElement = document.querySelector(`#agentList li[data-item-id="${escapedAgentId}"][data-item-type="agent"]`);
        if (!itemElement) return;

        const avatarWrapper = itemElement.querySelector('.avatar-wrapper');
        if (!avatarWrapper) return;

        avatarWrapper.classList.add('flowlock-heartbeat-ring');
        setTimeout(() => {
            avatarWrapper.classList.remove('flowlock-heartbeat-ring');
        }, 800);
    }

    /**
     * 清理所有状态（页面卸载时调用）
     */
    cleanup() {
        for (const [, session] of this.sessions) {
            if (session.pendingTimer) {
                clearTimeout(session.pendingTimer);
            }
        }
        this.sessions.clear();
    }
}

// 创建全局单例
const flowlockManager = new FlowlockManager();

// 导出到window对象供其他模块使用
window.flowlockManager = flowlockManager;

console.log('[Flowlock] Manager instance created and exposed globally (multi-session).');