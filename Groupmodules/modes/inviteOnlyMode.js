// Groupmodules/modes/inviteOnlyMode.js
// 邀请发言模式 - 用户发言后 AI 不主动响应，需要手动邀请

const BaseChatMode = require('./baseChatMode');

class InviteOnlyMode extends BaseChatMode {
    constructor() {
        super('invite_only');
    }

    /**
     * 邀请模式：用户发言后 AI 不主动响应
     * Agent 的发言由 handleInviteAgentToSpeak 单独触发，不经过此方法
     * 
     * @param {Array<object>} activeMembersConfigs - 活跃成员配置数组
     * @param {Array<object>} history - 聊天历史
     * @param {object} groupConfig - 群组配置
     * @param {object} userMessageEntry - 用户消息
     * @returns {Array<object>} 空数组 - 邀请模式下不自动发言
     */
    determineSpeakers(activeMembersConfigs, history, groupConfig, userMessageEntry) {
        console.log(`[InviteOnlyMode] No agents will respond automatically to user message.`);
        return [];
    }
}

module.exports = new InviteOnlyMode();