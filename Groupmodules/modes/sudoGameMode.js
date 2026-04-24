// Groupmodules/modes/sudoGameMode.js
// SudoGameMode — ChatTagFolder 2.0 发言控制模式
// Author: infinite-vector
//
// 三层架构中的 Layer A: 发言控制层
// 根据 groupConfig.sudoEngine.phase 和 phaseRules.canSpeak 决定谁能发言
// 仅在 mode === 'sudo_game' 时激活
// 不参与内容过滤 — 职责单一

const BaseChatMode = require('./baseChatMode');

class SudoGameMode extends BaseChatMode {
    constructor() {
        super('sudo_game');
    }

    /**
     * 根据游戏阶段决定哪些 Agent 可以发言
     * 
     * @param {Array} activeMembersConfigs - 活跃成员配置数组
     * @param {Array} history - 聊天历史
     * @param {object} groupConfig - 群组配置
     * @param {object} userMessageEntry - 用户消息
     * @returns {Array} 需要发言的 Agent 配置数组
     */
    determineSpeakers(activeMembersConfigs, history, groupConfig, userMessageEntry) {
        const sudoConfig = groupConfig.sudoEngine;

        // 无 sudoEngine 配置或无phaseRules: 回退为全员发言
        if (!sudoConfig || !sudoConfig.phaseRules) {
            console.log(`[SudoGameMode] No sudoEngine config, falling back to all members.`);
            return activeMembersConfigs;
        }

        const phase = sudoConfig.phase;
        const rules = sudoConfig.phaseRules[phase];

        // 当前阶段无规则或无 canSpeak: 回退为全员发言
        if (!rules || !rules.canSpeak || !Array.isArray(rules.canSpeak)) {
            console.log(`[SudoGameMode] No rules for phase "${phase}", falling back to all members.`);
            return activeMembersConfigs;
        }

        // 收集当前阶段允许发言的组的所有成员名
        const allowedNames = new Set();
        for (const groupName of rules.canSpeak) {
            const members = (sudoConfig.groups && sudoConfig.groups[groupName]) || [];
            members.forEach(name => allowedNames.add(name));
        }

        // 过滤出允许发言的 Agent
        const speakers = activeMembersConfigs.filter(agent => allowedNames.has(agent.name));

        console.log(`[SudoGameMode] Phase: ${phase}. Allowed groups: [${rules.canSpeak.join(', ')}]. Speakers: [${speakers.map(s => s.name).join(', ')}]`);

        // 保底: 如果过滤结果为空，回退为全员
        if (speakers.length === 0) {
            console.warn(`[SudoGameMode] No speakers matched for phase "${phase}". Falling back to all members.`);
            return activeMembersConfigs;
        }

        return speakers;
    }
}

module.exports = new SudoGameMode();