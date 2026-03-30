// Groupmodules/modes/baseChatMode.js
// 群聊模式基础接口 - 所有群聊模式都应实现此接口

/**
 * 群聊模式基类
 * 所有群聊模式（sequential, naturerandom, invite_only 等）都应继承此类并实现 determineSpeakers 方法。
 * 
 * 扩展新模式步骤：
 * 1. 在 Groupmodules/modes/ 下创建新文件，继承 BaseChatMode
 * 2. 实现 determineSpeakers() 方法
 * 3. 在 groupchat.js 的 CHAT_MODES 注册表中注册新模式
 */
class BaseChatMode {
    /**
     * @param {string} modeName - 模式名称标识符
     */
    constructor(modeName) {
        if (new.target === BaseChatMode) {
            throw new Error('BaseChatMode 是抽象基类，不能直接实例化。');
        }
        this.modeName = modeName;
    }

    /**
     * 决定哪些 Agent 应该在本轮发言
     * 
     * @param {Array<object>} activeMembersConfigs - 当前群聊中活跃的成员 Agent 的完整配置对象数组
     * @param {Array<object>} history - 当前聊天历史记录
     * @param {object} groupConfig - 当前群组的配置（包含 memberTags, tagMatchMode 等）
     * @param {object} userMessageEntry - 用户最新发送的消息条目 { content: string, name: string, ... }
     * @returns {Array<object>} - 需要发言的 Agent 配置对象数组，按发言顺序排列
     */
    determineSpeakers(activeMembersConfigs, history, groupConfig, userMessageEntry) {
        throw new Error(`模式 "${this.modeName}" 必须实现 determineSpeakers 方法。`);
    }
}

module.exports = BaseChatMode;