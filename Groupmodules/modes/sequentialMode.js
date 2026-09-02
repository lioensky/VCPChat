// Groupmodules/modes/sequentialMode.js
// 顺序发言模式 - 所有成员按列表顺序依次发言

const BaseChatMode = require('./baseChatMode');

class SequentialMode extends BaseChatMode {
    constructor() {
        super('sequential');
    }

    /**
     * 顺序模式：所有活跃成员按列表顺序依次发言
     * 
     * @param {Array<object>} activeMembersConfigs - 活跃成员配置数组
     * @param {Array<object>} history - 聊天历史
     * @param {object} groupConfig - 群组配置
     * @param {object} userMessageEntry - 用户消息
     * @returns {Array<object>} 需要发言的 Agent 配置数组
     */
    determineSpeakers(activeMembersConfigs, history, groupConfig, userMessageEntry) {
        const configuredOrder = groupConfig?.modeSettings?.sequential?.speakerOrder
            || groupConfig?.sequentialSpeakerOrder
            || [];
        const orderIndex = new Map(configuredOrder.map((agentId, index) => [agentId, index]));
        const originalIndex = new Map(activeMembersConfigs.map((agent, index) => [agent.id, index]));

        // 已配置成员按自定义次序排列；缺失或新加入成员稳定追加到原成员列表末尾。
        const orderedMembers = [...activeMembersConfigs].sort((left, right) => {
            const leftOrder = orderIndex.has(left.id) ? orderIndex.get(left.id) : Number.MAX_SAFE_INTEGER;
            const rightOrder = orderIndex.has(right.id) ? orderIndex.get(right.id) : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder
                || originalIndex.get(left.id) - originalIndex.get(right.id);
        });

        console.log(`[SequentialMode] Agents to respond: ${orderedMembers.map(agent => agent.name).join(', ')}`);
        return orderedMembers;
    }
}

module.exports = new SequentialMode();