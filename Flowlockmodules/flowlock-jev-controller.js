(function initializeFlowlockJevController(root) {
    'use strict';
    const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    function createSession(settings = {}) {
        if (settings.jevEnabled !== true || settings.flowlockJevEnabled === false) return null;
        return {
            phase: 'planning', pending: false, selected: null, lastDecision: null, history: [], goal: '',
            proposalFailures: 0, maxRounds: Math.floor(bounded(settings.flowlockJevMaxRounds, 30, 1, 200)),
            minConfidence: bounded(settings.flowlockJevMinConfidence, 0.6, 0, 1),
            minEvidence: bounded(settings.flowlockJevMinEvidence, 0.85, 0, 1)
        };
    }
    const isCurrent = (manager, session, generation) => manager.sessions.get(session.agentId) === session && session.status === 'active' && session.generation === generation;
    async function finish(manager, session, reason, message, level = 'info') {
        if (manager.sessions.get(session.agentId) !== session || session.status !== 'active') return;
        session.completionReason = reason;
        await manager.stop(session.agentId);
        manager.uiHelper?.showToastNotification?.(`Agent "${session.agentName || session.agentId}"：${message}`, level);
    }
    async function replan(manager, session, reason) {
        const state = session.jev;
        state.selected = null;
        state.phase = 'planning';
        state.proposalFailures++;
        state.replanReason = reason;
        if (state.proposalFailures >= 3) {
            await finish(manager, session, 'jev_invalid_candidates', '连续三次未得到有效可执行候选，已停止心流，请检查候选或补充任务要求。', 'warning');
            return;
        }
        manager.scheduleNextRound(session.agentId, session.defaultDelaySeconds * 1000);
    }
    async function afterReply(manager, session, content, protocol) {
        const state = session.jev;
        if (!state || state.pending) return;
        const generation = session.generation;
        const current = () => isCurrent(manager, session, generation) && session.jev === state;
        if (session.pendingTimer) clearTimeout(session.pendingTimer);
        session.pendingTimer = null;
        session.nextHeartbeatAt = null;
        state.pending = true;
        state.phase = 'judging';
        state.selected = null;
        let timeout;
        try {
            const engine = root.flowlockJev;
            if (!engine || typeof manager.electronAPI?.decideWithJev !== 'function' || typeof manager.electronAPI?.getChatHistory !== 'function') throw new Error('JEV 服务或历史读取接口不可用');
            let plan;
            try { plan = engine.parseCandidates(content, root.flowlockProtocol); }
            catch (error) { if (current()) await replan(manager, session, error.message); return; }
            if (!plan && !protocol?.terminalType) {
                if (current()) await replan(manager, session, '上一轮没有候选块，请按约定格式重新提案。');
                return;
            }
            plan = plan || { summary: protocol?.failReason || '', candidates: [] };
            // Bound both IPC reads and the decision call; an unavailable service never
            // silently grants the Agent autonomous fallback execution.
            const response = await Promise.race([
                (async () => {
                    const history = await manager.electronAPI.getChatHistory(session.agentId, session.topicId);
                    if (!current()) return null;
                    if (!Array.isArray(history)) throw new Error('无法读取裁决所需的目标话题历史');
                    const request = engine.buildRequest({ session: { ...session, goal: state.goal, decisionHistory: state.history }, plan, history, content, terminalProposal: protocol?.terminalType || null });
                    if (!state.goal) state.goal = request.state.goal;
                    state.userContextKey = engine.userContextKey(history);
                    const envelope = await manager.electronAPI.decideWithJev(request.state, request.questions);
                    if (!current()) return null;
                    if (!envelope?.success) throw new Error(envelope?.error || 'JEV 请求失败');
                    const currentHistory = await manager.electronAPI.getChatHistory(session.agentId, session.topicId);
                    if (!current()) return null;
                    if (!Array.isArray(currentHistory) || engine.userContextKey(currentHistory) !== state.userContextKey) throw new Error('用户输入已改变，旧裁决已丢弃；请按新要求重新启动心流。');
                    return engine.parseDecision(envelope.result, request, state.minConfidence, state.minEvidence);
                })(),
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('JEV 裁决超时')), 120000); })
            ]);
            if (!current() || !response) return;
            state.lastDecision = response;
            state.history.push({ round: session.round, type: response.type, reason: response.reason || null, action: response.candidate?.action || null });
            state.history = state.history.slice(-6);
            if (response.type === 'replan') { await replan(manager, session, response.reason); return; }
            if (response.type !== 'execute') {
                const reasons = {
                    jev_complete: 'JEV 判断任务已完成，已结束心流。',
                    jev_needs_user: 'JEV 判断需要用户输入或授权，已结束心流等待处理。',
                    jev_failed: 'JEV 判断任务无法继续，已结束心流。',
                    jev_stopped: 'JEV 判断应停止或继续无有效增量，已结束心流。',
                    completion_unverified: '完成证据不足，已安全停止；不标记任务完成。',
                    action_not_authorized_or_ready: '候选授权或前提不足，已停止并等待人工确认。',
                    low_confidence: 'JEV 生命周期判断不够确定，已停止并等待人工确认。',
                    uncertain_action: 'JEV 动作选择不够确定，已停止并等待人工确认。'
                };
                await finish(manager, session, response.reason, reasons[response.reason] || 'JEV 已结束本次心流。', response.type === 'complete' ? 'success' : 'warning');
                return;
            }
            if (session.round >= state.maxRounds) { await finish(manager, session, 'jev_max_rounds', '已达到自治轮数上限，停止心流等待检查。', 'warning'); return; }
            state.proposalFailures = 0;
            state.phase = 'ready';
            state.selected = response.candidate;
            manager.uiHelper?.showToastNotification?.(`JEV 选择 ${response.candidate.id}：${response.candidate.action.slice(0, 140)}`, 'info');
            manager.scheduleNextRound(session.agentId, (response.candidate.delaySeconds ?? session.defaultDelaySeconds) * 1000);
        } catch (error) {
            if (!current()) return;
            session.lastError = error.message;
            await finish(manager, session, 'jev_error', `JEV 裁决失败，已安全停止：${error.message}`, 'error');
        } finally {
            if (timeout) clearTimeout(timeout);
            state.pending = false;
        }
    }
    function heartbeatPrompt(session, taskPrompt) {
        const state = session.jev;
        if (state.selected) {
            const selected = state.selected;
            state.selected = null;
            state.phase = 'executing';
            return root.flowlockJev.executionPrompt(selected);
        }
        state.phase = 'planning';
        return root.flowlockJev.planningPrompt([taskPrompt || '', state.replanReason ? `重新提案原因：${state.replanReason}` : ''].filter(Boolean).join('\n'));
    }
    root.flowlockJevController = Object.freeze({ createSession, afterReply, finish, heartbeatPrompt });
})(window);
