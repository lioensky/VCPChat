'use strict';
const { GameSessionOrchestrator } = require('../../Groupmodules/gameSessionOrchestrator');
const { formatInvite, formatPublicEvent } = require('../../Groupmodules/modes/gamePrompts');
const { randomUUID } = require('node:crypto');

class GameRuntime {
    constructor({ gameService, groupChat, loadAgent, toolInstructions, runAgent } = {}) {
        if (!gameService || !groupChat || typeof loadAgent !== 'function'
            || typeof runAgent !== 'function' || typeof toolInstructions !== 'function') {
            throw new TypeError('GameRuntime requires service, group backend, agent loader and request adapters.');
        }
        Object.assign(this, { gameService, groupChat, loadAgent });
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
    async openTable({ agentIds, userName = '用户', contextMessageWindowSize = 100 } = {}) {
        if (!Array.isArray(agentIds) || agentIds.length !== 2
            || agentIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
            || agentIds[0] === agentIds[1]) {
            throw new Error('请选择两个不同的有效Agent。');
        }
        const agents = await Promise.all(agentIds.map(id => this.loadAgent(id)));
        if (agents.some(agent => !agent || agent.error || !agent.model)) {
            throw new Error('所选Agent不存在或尚未配置模型。');
        }
        const created = await this.groupChat.createAgentGroup(`斗地主_${randomUUID()}`, {
            mode: 'game', members: agentIds,
            modeSettings: { game: { gameTypeId: 'doudizhu' } },
            enableContextMessageWindow: true, contextMessageWindowSize,
        });
        if (!created.success) throw new Error(created.error || '创建后台游戏会话失败。');
        const group = created.agentGroup;
        const match = await this.gameService.createMatch({
            groupId: group.id, topicId: group.topics[0].id,
            seats: [
                { kind: 'human', name: String(userName).slice(0, 100) },
                ...agents.map((agent, index) => ({
                    kind: 'agent', agentId: agentIds[index], name: agent.name || agentIds[index],
                })),
            ],
        });
        return { ...match, groupId: group.id, topicId: group.topics[0].id };
    }
    async nextTable(matchId) {
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
        await this.orchestrator.syncEvents(matchId);
        const table = await this.gameService.nextMatch(matchId);
        await this.orchestrator.syncEvents(table.matchId);
        return table;
    }
    async submitHuman(matchId, request) {
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
    continue(matchId) { return this.orchestrator.start(matchId); }
    stop(matchId) { this.orchestrator.stop(matchId); }
    getState(matchId) { return this.orchestrator.getState(matchId); }
}
module.exports = { GameRuntime };