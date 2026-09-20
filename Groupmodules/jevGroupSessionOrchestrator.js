'use strict';

const { JevDecisionMode, normalizeJevModeSettings } = require('./modes/jevDecisionMode');

function sessionKey(groupId, topicId) {
    return `${String(groupId)}\u0000${String(topicId)}`;
}

function createAbortError(message = 'JEV 群聊会话已中止。') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'GROUP_QUEUE_ABORTED';
    return error;
}

class JevGroupSessionOrchestrator {
    constructor({
        jevService,
        loadGroupConfig,
        loadActiveMembers,
        readHistory,
        runAgent,
        emitEvent = () => {},
        logger = console,
        random = Math.random
    } = {}) {
        if (!jevService) throw new TypeError('JevGroupSessionOrchestrator requires jevService.');
        if (typeof loadGroupConfig !== 'function') throw new TypeError('loadGroupConfig is required.');
        if (typeof loadActiveMembers !== 'function') throw new TypeError('loadActiveMembers is required.');
        if (typeof readHistory !== 'function') throw new TypeError('readHistory is required.');
        if (typeof runAgent !== 'function') throw new TypeError('runAgent is required.');
        this.decisionMode = new JevDecisionMode({ jevService, logger });
        this.loadGroupConfig = loadGroupConfig;
        this.loadActiveMembers = loadActiveMembers;
        this.readHistory = readHistory;
        this.runAgent = runAgent;
        this.emitEvent = emitEvent;
        this.logger = logger;
        this.random = random;
        this.sessions = new Map();
    }

    _createSession(groupId, topicId) {
        return {
            groupId,
            topicId,
            status: 'idle',
            trigger: null,
            queue: [],
            manualQueue: [],
            currentAgentId: null,
            historyRevision: 0,
            arbitrationRevision: 0,
            dirty: false,
            autonomousRound: 0,
            speechCounts: {},
            latestUserMessageId: null,
            forceContinue: false,
            abortController: null,
            runPromise: null,
            lastContinueAt: 0,
            stopReason: null,
            stopRequested: false
        };
    }

    _getOrCreate(groupId, topicId) {
        const key = sessionKey(groupId, topicId);
        if (!this.sessions.has(key)) {
            this.sessions.set(key, this._createSession(groupId, topicId));
        }
        return this.sessions.get(key);
    }

    _snapshot(session) {
        return {
            groupId: session.groupId,
            topicId: session.topicId,
            status: session.status,
            running: Boolean(session.runPromise),
            currentAgentId: session.currentAgentId,
            queue: [...session.queue],
            manualQueue: [...session.manualQueue],
            autonomousRound: session.autonomousRound,
            historyRevision: session.historyRevision,
            dirty: session.dirty,
            stopReason: session.stopReason,
            stopRequested: session.stopRequested
        };
    }

    _emit(session, type, extra = {}) {
        const payload = {
            type,
            messageId: `jev_session_${session.groupId}_${session.topicId}`,
            context: {
                groupId: session.groupId,
                topicId: session.topicId,
                isGroupMessage: true,
                isJevGroupSession: true
            },
            session: this._snapshot(session),
            ...extra
        };
        try {
            this.emitEvent(payload);
        } catch (error) {
            this.logger.warn('[JevGroupSession] Failed to emit event:', error);
        }
    }

    getState(groupId, topicId) {
        return this._snapshot(this._getOrCreate(groupId, topicId));
    }

    notifyHumanMessage(groupId, topicId, message, mentionedAgentIds = []) {
        const session = this._getOrCreate(groupId, topicId);
        session.historyRevision += 1;
        session.latestUserMessageId = message?.id || session.latestUserMessageId;
        session.dirty = true;

        const promoted = [];
        for (const agentId of mentionedAgentIds) {
            if (!agentId || agentId === session.currentAgentId || promoted.includes(agentId)) continue;
            promoted.push(agentId);
        }
        if (promoted.length > 0) {
            const promotedSet = new Set(promoted);
            session.queue = [
                ...promoted,
                ...session.queue.filter(agentId => !promotedSet.has(agentId))
            ];
            session.manualQueue = session.manualQueue.filter(agentId => !promotedSet.has(agentId));
        }

        this._emit(session, 'group_queue_updated', {
            reason: 'human_message',
            promotedAgentIds: promoted
        });
        return this._snapshot(session);
    }

    enqueueAgent(groupId, topicId, agentId) {
        const session = this._getOrCreate(groupId, topicId);
        if (!agentId || agentId === session.currentAgentId) return this._snapshot(session);

        session.queue = session.queue.filter(id => id !== agentId);
        session.manualQueue = session.manualQueue.filter(id => id !== agentId);
        if (session.runPromise) {
            session.manualQueue.unshift(agentId);
        } else {
            session.queue.unshift(agentId);
        }
        this._emit(session, 'group_queue_updated', {
            reason: 'manual_agent',
            enqueuedAgentId: agentId
        });

        if (!session.runPromise) {
            this._startRun(session, { trigger: 'manual_agent' });
        }
        return this._snapshot(session);
    }

    start(groupId, topicId, options = {}) {
        const session = this._getOrCreate(groupId, topicId);
        if (session.runPromise) {
            return { started: false, reason: 'already_running', state: this._snapshot(session) };
        }
        if (options.initialAgentId) {
            session.queue.push(options.initialAgentId);
        }
        this._startRun(session, {
            trigger: options.trigger || 'user_message',
            randomOpening: options.randomOpening === true,
            forceContinue: options.forceContinue === true
        });
        return { started: true, state: this._snapshot(session), promise: session.runPromise };
    }

    async continue(groupId, topicId) {
        const session = this._getOrCreate(groupId, topicId);
        if (session.runPromise) {
            return { success: false, error: '群聊正在进行中。', state: this._snapshot(session) };
        }

        const groupConfig = await this.loadGroupConfig(groupId);
        const memberIds = Array.isArray(groupConfig?.members) ? groupConfig.members : [];
        const settings = normalizeJevModeSettings(groupConfig?.modeSettings?.jev, memberIds);
        const now = Date.now();
        if (now - session.lastContinueAt < settings.continueDebounceMs) {
            return { success: false, error: '操作过于频繁，请稍后再试。', state: this._snapshot(session) };
        }
        session.lastContinueAt = now;
        const result = this.start(groupId, topicId, {
            trigger: 'continue',
            forceContinue: true
        });
        return { success: result.started, ...result };
    }

    startRandomOpening(groupId, topicId) {
        return this.start(groupId, topicId, {
            trigger: 'random_opening',
            randomOpening: true
        });
    }

    _startRun(session, options) {
        session.trigger = options.trigger;
        session.forceContinue = options.forceContinue === true;
        session.stopReason = null;
        session.stopRequested = false;
        session.abortController = new AbortController();
        session.runPromise = this._runLoop(session, options)
            .catch(error => {
                if (error?.name !== 'AbortError') {
                    this.logger.error('[JevGroupSession] Session failed:', error);
                    session.stopReason = error?.code || 'session_error';
                    this._emit(session, 'group_queue_stopped', {
                        reason: session.stopReason,
                        error: error?.message || String(error)
                    });
                }
            })
            .finally(() => {
                session.status = 'idle';
                session.currentAgentId = null;
                session.queue = [];
                session.manualQueue = [];
                session.dirty = false;
                session.forceContinue = false;
                session.stopRequested = false;
                session.abortController = null;
                session.runPromise = null;
                this._emit(session, 'group_queue_state', { reason: 'idle' });
            });
    }

    _assertActive(session) {
        if (session.abortController?.signal.aborted) throw createAbortError();
    }

    async _runLoop(session, options) {
        const groupConfig = await this.loadGroupConfig(session.groupId);
        const activeMembers = await this.loadActiveMembers(groupConfig);
        const memberMap = new Map(activeMembers.map(member => [member.id, member]));
        const settings = normalizeJevModeSettings(
            groupConfig?.modeSettings?.jev,
            activeMembers.map(member => member.id)
        );
        if (activeMembers.length === 0) {
            session.stopReason = 'no_active_members';
            this._emit(session, 'group_queue_stopped', { reason: session.stopReason });
            return;
        }

        if (options.randomOpening === true && session.queue.length === 0) {
            const index = Math.min(
                activeMembers.length - 1,
                Math.floor(this.random() * activeMembers.length)
            );
            session.queue.push(activeMembers[index].id);
        }

        this._emit(session, 'group_queue_state', { reason: 'started' });

        while (true) {
            this._assertActive(session);

            while (session.queue.length > 0 || session.manualQueue.length > 0) {
                this._assertActive(session);
                if (session.manualQueue.length > 0) {
                    const promoted = session.manualQueue.shift();
                    session.queue = session.queue.filter(id => id !== promoted);
                    session.queue.unshift(promoted);
                }

                const agentId = session.queue.shift();
                const agent = memberMap.get(agentId);
                if (!agent) continue;
                session.status = 'speaking';
                session.currentAgentId = agentId;
                this._emit(session, 'group_queue_state', { reason: 'agent_started', agentId });

                await this.runAgent({
                    groupId: session.groupId,
                    topicId: session.topicId,
                    agent,
                    groupConfig,
                    signal: session.abortController.signal
                });
                this._assertActive(session);
                session.speechCounts[agentId] = (session.speechCounts[agentId] || 0) + 1;
                session.historyRevision += 1;
                session.currentAgentId = null;
                this._emit(session, 'group_queue_updated', {
                    reason: 'agent_completed',
                    completedAgentId: agentId
                });
                if (session.stopRequested) {
                    session.stopReason = 'user_queue_stop';
                    this._emit(session, 'group_queue_stopped', {
                        reason: session.stopReason,
                        currentReplyCompleted: true
                    });
                    return;
                }
            }

            if (session.autonomousRound >= settings.maxAutonomousRounds) {
                session.stopReason = 'safety_limit';
                this._emit(session, 'group_queue_stopped', { reason: session.stopReason });
                return;
            }

            session.status = 'arbitrating';
            session.autonomousRound += 1;
            const arbitrationRevision = session.historyRevision;
            session.arbitrationRevision = arbitrationRevision;
            session.dirty = false;
            const history = await this.readHistory(session.groupId, session.topicId);
            this._assertActive(session);
            this._emit(session, 'jev_arbitration_started', {
                autonomousRound: session.autonomousRound
            });

            const decision = await this.decisionMode.decide(
                activeMembers,
                history,
                groupConfig,
                {
                    trigger: session.trigger,
                    autonomousRound: session.autonomousRound,
                    forceContinue: session.forceContinue,
                    latestUserMessageId: session.latestUserMessageId,
                    speechCounts: session.speechCounts,
                    manuallyQueuedAgentIds: session.manualQueue
                },
                { signal: session.abortController.signal }
            );
            this._assertActive(session);
            session.forceContinue = false;

            if (session.historyRevision !== arbitrationRevision) {
                session.dirty = true;
                this._emit(session, 'group_queue_updated', {
                    reason: 'stale_arbitration_discarded'
                });
                continue;
            }

            this._emit(session, 'jev_arbitration_result', { decision });
            if (decision.shouldStop) {
                session.stopReason = decision.stopReason;
                this._emit(session, 'group_queue_stopped', {
                    reason: session.stopReason,
                    decision
                });
                return;
            }

            const manualSet = new Set(session.manualQueue);
            session.queue = decision.selectedAgentIds.filter(agentId => !manualSet.has(agentId));
            if (session.manualQueue.length > 0) {
                session.queue.unshift(...session.manualQueue.splice(0));
            }
        }
    }

    async interrupt(groupId, topicId) {
        const session = this._getOrCreate(groupId, topicId);
        const wasRunning = Boolean(session.runPromise);
        const currentReplyContinues = session.status === 'speaking' && Boolean(session.currentAgentId);
        session.stopReason = currentReplyContinues
            ? 'user_queue_stop_pending_current'
            : 'user_queue_stop';
        session.stopRequested = true;
        session.queue = [];
        session.manualQueue = [];

        // 裁决尚未产生可见消息，可以立即取消；已开始的 Agent 回复必须自然完成。
        if (!currentReplyContinues) {
            session.abortController?.abort();
        }
        this._emit(session, 'group_queue_stopped', {
            reason: session.stopReason,
            currentReplyContinues
        });
        return {
            success: true,
            wasRunning,
            currentReplyContinues,
            state: this._snapshot(session)
        };
    }
}

module.exports = {
    JevGroupSessionOrchestrator,
    sessionKey,
    createAbortError
};