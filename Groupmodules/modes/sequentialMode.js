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
        // 顺序模式下，所有成员都按列表顺序发言
        console.log(`[SequentialMode] Agents to respond: ${activeMembersConfigs.map(a => a.name).join(', ')}`);
        return activeMembersConfigs;
    }
}

module.exports = new SequentialMode();