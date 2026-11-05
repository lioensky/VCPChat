'use strict';
const { GameSessionOrchestrator } = require('../../Groupmodules/gameSessionOrchestrator');
const { formatInvite, formatPublicEvent } = require('../../Groupmodules/modes/gamePrompts');
const { randomUUID } = require('node:crypto');

const GAME_TURN_MAX_OUTPUT_TOKENS = 16384;

function clampGameAgentConfig(cfg, modelOverride) {
    if (!cfg || cfg.error) return cfg;
    const rawMax = Number.parseInt(cfg.maxOutputTokens, 10);
    const maxOutputTokens = Number.isFinite(rawMax) && rawMax > 0
        ? Math.min(rawMax, GAME_TURN_MAX_OUTPUT_TOKENS)
        : GAME_TURN_MAX_OUTPUT_TOKENS;
    return {
        ...cfg,
        ...(modelOverride ? { model: modelOverride } : {}),
        maxOutputTokens,
    };
}

class GameRuntime {
    constructor({ gameService, groupChat, loadAgent, toolInstructions, runAgent } = {}) {
        if (!gameService || !groupChat || typeof loadAgent !== 'function'
            || typeof runAgent !== 'function' || typeof toolInstructions !== 'function') {
            throw new TypeError('GameRuntime requires service, group backend, agent loader and request adapters.');
        }
        Object.assign(this, { gameService, groupChat, loadAgent });
        this.maintenance = false;
        this.resourceOperations = 0;
        for (const name of ['openTable', 'nextTable', 'updateSeatModels', 'updateAutoPass', 'submitHuman']) {
            const operation = this[name].bind(this);
            this[name] = async (...args) => {
                this.assertAvailable();
                this.resourceOperations++;
                try { return await operation(...args); }
                finally { this.resourceOperations--; }
            };
        }
        this.resources = new (require('./gameResourceManager').GameResourceManager)(this);
        this.orchestrator = new GameSessionOrchestrator({
            gameService,
            appendEvent: async payload => {
                const { groupId, topicId, messageId, event, seats } = payload;
                const group = await groupChat.getAgentGroupConfig(groupId);
                if (group?.mode !== 'game' || !group.topics?.some(topic => topic.id === topicId)) {
                    throw Object.assign(new Error('游戏后台会话已删除或模式改变。'), { code: 'SESSION_UNAVAILABLE' });
                }
                await groupChat.appendGroupHistoryMessage(groupId, topicId, {
                    id: messageId, role: 'user', name: '游戏事件',
                    content: formatPublicEvent({ event, seats }),
                    timestamp: Date.now(), gameEvent: event,
                });
            },
            runAgent: async decision => runAgent({
                ...decision,
                invitePrompt: formatInvite({
                    ...decision, toolInstructions: await toolInstructions(decision),
                }),
            }),
        });
    }
    async openTable({ mode, agentIds, agentModels, userName = '用户', contextMessageWindowSize = 100, autoPass = true } = {}) {
        if (typeof autoPass !== 'boolean') throw new TypeError('autoPass must be boolean.');
        this.assertAvailable();
        const spectate = mode === 'spectate' || (mode === undefined && Array.isArray(agentIds) && agentIds.length === 3);
        const expectedCount = spectate ? 3 : 2;
        if (!Array.isArray(agentIds) || agentIds.length !== expectedCount
            || agentIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
            || new Set(agentIds).size !== expectedCount) {
            throw new Error(spectate ? '请选择三个不同的有效Agent。' : '请选择两个不同的有效Agent。');
        }
        const requestedModels = Array.isArray(agentModels) ? agentModels : [];
        const modelOverrides = agentIds.map((_, index) => {
            const raw = requestedModels[index];
            if (raw === undefined || raw === null || raw === '') return '';
            if (typeof raw !== 'string') throw new Error('所选模型名称无效。');
            const trimmed = raw.trim();
            if (!trimmed) return '';
            if (trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) {
                throw new Error('所选模型名称无效。');
            }
            return trimmed;
        });
        const agents = await Promise.all(agentIds.map(id => this.loadAgent(id)));
        if (agents.some((agent, index) => !agent || agent.error || !(modelOverrides[index] || agent.model))) {
            throw new Error('所选Agent不存在或尚未配置模型。');
        }
        const created = await this.groupChat.createAgentGroup(`斗地主_${randomUUID()}`, {
            mode: 'game', members: agentIds,
            modeSettings: { game: { gameTypeId: 'doudizhu' } },
            enableContextMessageWindow: true, contextMessageWindowSize,
        });
        if (!created.success) throw new Error(created.error || '创建后台游戏会话失败。');
        const group = created.agentGroup;
        const agentSeats = agents.map((agent, index) => {
            const override = modelOverrides[index];
            const defaultModel = typeof agent.model === 'string' ? agent.model.trim() : '';
            return {
                kind: 'agent',
                agentId: agentIds[index],
                name: agent.name || agentIds[index],
                ...(override ? { model: override } : {}),
                effectiveModel: override || defaultModel,
            };
        });
        const seats = spectate
            ? agentSeats
            : [{ kind: 'human', name: String(userName).slice(0, 100) }, ...agentSeats];
        const match = await this.gameService.createMatch({
            groupId: group.id, topicId: group.topics[0].id,
            seats, autoPass,
        });
        return { ...match, groupId: group.id, topicId: group.topics[0].id };
    }
    async resolveUpdatedSeats(existingSeats, { agentIds, agentModels } = {}) {
        if (!Array.isArray(agentModels)) return null;
        const agentSeatIndices = existingSeats
            .map((seat, index) => (seat?.kind === 'agent' ? index : -1))
            .filter(index => index >= 0);
        if (Array.isArray(agentIds)) {
            if (agentIds.length !== agentSeatIndices.length
                || agentSeatIndices.some((seatIdx, slotIdx) => existingSeats[seatIdx].agentId !== agentIds[slotIdx])) {
                throw Object.assign(
                    new Error('更换出战角色或切换模式请点击「开新桌」；同阵容换模型可直接生效。'),
                    { code: 'SEAT_ROSTER_CHANGED' },
                );
            }
        }
        if (agentModels.length !== agentSeatIndices.length) {
            throw new Error('所选模型数量与AI座位数不匹配。');
        }
        const overrides = agentModels.map(raw => {
            if (raw === undefined || raw === null || raw === '') return '';
            if (typeof raw !== 'string') throw new Error('所选模型名称无效。');
            const trimmed = raw.trim();
            if (!trimmed) return '';
            if (trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) {
                throw new Error('所选模型名称无效。');
            }
            return trimmed;
        });
        const nextSeats = structuredClone(existingSeats);
        await Promise.all(agentSeatIndices.map(async (seatIdx, slotIdx) => {
            const current = existingSeats[seatIdx];
            const override = overrides[slotIdx];
            const agent = await this.loadAgent(current.agentId);
            const defaultModel = typeof agent?.model === 'string' ? agent.model.trim() : '';
            if (!agent || agent.error || !(override || defaultModel)) {
                throw new Error('所选Agent不存在或尚未配置模型。');
            }
            nextSeats[seatIdx] = {
                kind: 'agent',
                agentId: current.agentId,
                name: current.name || agent.name || current.agentId,
                ...(override ? { model: override } : {}),
                effectiveModel: override || defaultModel,
            };
        }));
        return nextSeats;
    }
    async updateAutoPass(matchId, autoPass) {
        return this.gameService.updateAutoPass(matchId, autoPass);
    }
    async updateSeatModels(matchId, options = {}) {
        this.assertAvailable();
        const record = await this.gameService.read(matchId);
        const seats = await this.resolveUpdatedSeats(record.seats, options);
        if (!seats) return record.seats;
        return this.gameService.updateSeats(matchId, seats);
    }
    async nextTable(matchId, options = {}) {
        this.assertAvailable();
        if (this.getState(matchId).running) {
            throw Object.assign(new Error('当前回复尚未结束，请稍后再来一局。'), { code: 'REQUEST_ACTIVE' });
        }
        const previous = await this.gameService.read(matchId);
        if (previous.state.phase !== 'finished') {
            throw Object.assign(new Error('当前对局尚未结束。'), { code: 'MATCH_NOT_FINISHED' });
        }
        const group = await this.groupChat.getAgentGroupConfig(previous.groupId);
        if (group?.mode !== 'game' || !group.topics?.some(topic => topic.id === previous.topicId)) {
            throw Object.assign(new Error('原游戏后台会话不可用。'), { code: 'SESSION_UNAVAILABLE' });
        }
        const seats = await this.resolveUpdatedSeats(previous.seats, options);
        await this.orchestrator.syncEvents(matchId);
        const table = await this.gameService.nextMatch(matchId, seats ? { seats } : {});
        await this.orchestrator.syncEvents(table.matchId);
        return table;
    }
    async submitHuman(matchId, request) {
        const record = await this.gameService.read(matchId);
        if (record.seats[0]?.kind !== 'human') {
            throw Object.assign(new Error('当前为三AI观战模式，无需人工出牌。'), { code: 'SPECTATOR_MODE' });
        }
        const result = await this.gameService.submit(matchId, 0, request);
        // Only synchronize here. Caller starts scheduling without awaiting a whole model turn.
        try {
            await this.orchestrator.syncEvents(matchId);
            return result;
        } catch (error) {
            return { ...result, synchronizationPending: true,
                synchronizationError: error?.message || String(error) };
        }
    }
    assertAvailable() {
        if (this.maintenance) throw new Error('游戏资源正在清理，请稍后再操作。');
    }
    continue(matchId) { this.assertAvailable(); return this.orchestrator.start(matchId); }
    stop(matchId) { this.orchestrator.stop(matchId); }
    getState(matchId) { return this.orchestrator.getState(matchId); }
}
module.exports = { GameRuntime, clampGameAgentConfig, GAME_TURN_MAX_OUTPUT_TOKENS };