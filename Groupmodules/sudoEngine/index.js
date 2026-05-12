// sudoEngine/index.js
// SudoEngine — ChatTagFolder2.0 核心过滤引擎 v2
// Author: infinite-vector (design by竹林夕弦)
//
// v2 改动：
// - 状态来源从 groupConfig.sudoEngine.groups → LockManager (.lock 文件)
// - filterByPermission 改为 async（LockManager 文件操作是异步的）
// - 支持 group-x 占位符（Agent 不知道组号，SudoEngine 查.lock 判断同组）
// - groupPrompt 注入隐藏组名和队友
// - 保留对 groupConfig.sudoEngine 的兼容（无.lock 时回退到 config）

const fs = require('fs');
const path = require('path');
const { TAG_PATTERN, MAX_INNER_LENGTH, parseTagMatch, isVisible } = require('./TagParser');
const LockManager = require('./LockManager');
const { handleGroupInit, lockManager } = require('./GroupInitHandler');

// 调试日志
const DEBUG_LOG_PATH = path.join(__dirname, 'sudo_debug.log');
function debugLog(msg) {
    const timestamp = new Date().toISOString();
    try { fs.appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] ${msg}\n`); } catch (e) { /* silent */ }
}

class SudoEngine {
    constructor() {
        this.lockManager = lockManager;
    }

    /**
     * 核心过滤方法（async — 因为 LockManager 是异步的）
     *
     * @param {Array} messagesForAI - 待发送给 AI 的消息数组
     * @param {string} viewerName - 当前 Agent 名
     * @param {object} groupConfig - 群组配置
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @returns {Promise<Array>} 过滤后的消息数组
     */
    async filterByPermission(messagesForAI, viewerName, groupConfig, groupId, topicId) {
        const sudoConfig = (groupConfig && groupConfig.sudoEngine) || null;

        // 检查是否有 .lock 文件
        const hasLocks = groupId && topicId && await this.lockManager.hasLocks(groupId, topicId);

        // 快速路径：无 sudoEngine 配置且无 .lock 文件
        if (!sudoConfig && !hasLocks) {
            return messagesForAI;
        }

        debugLog(`=== filterByPermission called for viewer: ${viewerName} ===`);
        debugLog(`Phase: ${sudoConfig ? sudoConfig.phase : 'N/A'}, HasLocks: ${hasLocks}`);

        // 判断是否为 powerUser
        let isPowerUser = false;
        if (sudoConfig && sudoConfig.powerUsers && sudoConfig.powerUsers.includes(viewerName)) {
            isPowerUser = true;
        }
        // 也检查 .lock 初始化时的 excluded（通过 GroupInitHandler 存储的powerUsers）
        // 这部分信息目前存在 sudoConfig 中，未来可以独立存储

        debugLog(`  isPowerUser: ${isPowerUser}`);

        // 遍历消息，对每条执行权限过滤
        const filtered = [];
        for (const msg of messagesForAI) {
            if (msg.role === 'system') {
                filtered.push(msg);
                continue;
            }

            if (typeof msg.content === 'string') {
                const newContent = await this._filterTextAsync(
                    msg.content, viewerName, sudoConfig, groupId, topicId, isPowerUser
                );
                filtered.push({ ...msg, content: newContent });
            } else if (Array.isArray(msg.content)) {
                const newContent = [];
                for (const part of msg.content) {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        const newText = await this._filterTextAsync(
                            part.text, viewerName, sudoConfig, groupId, topicId, isPowerUser
                        );
                        newContent.push({ ...part, text: newText });
                    } else {
                        newContent.push(part);
                    }
                }
                filtered.push({ ...msg, content: newContent });
            } else {
                filtered.push(msg);
            }
        }

        const cleaned = this._removeEmptyMessages(filtered);
        debugLog(`  Result: ${messagesForAI.length} msgs in → ${cleaned.length} msgs out`);
        debugLog(`=== filterByPermission END for ${viewerName} ===\n`);

        return cleaned;
    }

    /**
     * 异步文本过滤（支持 group-x 占位符 + .lock 查询）
     */
    async _filterTextAsync(text, viewerName, sudoConfig, groupId, topicId, isPowerUser) {
        // 先收集所有匹配（因为 replace 不支持 async callback）
        TAG_PATTERN.lastIndex = 0;
        const matches = [];
        let m;
        while ((m = TAG_PATTERN.exec(text)) !== null) {
            matches.push({
                fullMatch: m[0],
                tagName: m[1],
                sender: m[2],
                permission: m[3],
                inner: m[4],
                index: m.index
            });
        }

        if (matches.length === 0) return text;

        // 从后往前替换（避免索引偏移）
        let result = text;
        for (let i = matches.length - 1; i >= 0; i--) {
            const match = matches[i];

            // 安全上限检查
            if (match.inner.length > MAX_INNER_LENGTH) {
                debugLog(`SKIP: tag inner too long (${match.inner.length} chars)`);
                continue;
            }

            let visible = false;

            // powerUser 看到一切
            if (isPowerUser) {
                visible = true;
            }
            // :secret —仅发送者可见
            else if (match.permission === 'secret') {
                visible = (viewerName === match.sender);
            }
            // :group-x — 占位符模式：查.lock 判断同组
            else if (match.permission === 'group-x' && groupId && topicId) {
                const senderGroup = await this.lockManager.findAgentGroup(groupId, topicId, match.sender);
                const viewerGroup = await this.lockManager.findAgentGroup(groupId, topicId, viewerName);
                visible = senderGroup && viewerGroup &&senderGroup.groupNumber === viewerGroup.groupNumber;
            }
            // :group-具体名— 传统模式（向后兼容 config中的 groups）
            else if (match.permission.startsWith('group-') && sudoConfig && sudoConfig.groups) {
                const groupName = match.permission.replace('group-', '');
                const members = sudoConfig.groups[groupName] || [];
                visible = members.includes(viewerName);
            }
            // 无已知修饰符 — 默认可见
            else {
                visible = true;
            }

            debugLog(`  TAG: [${match.tagName}:${match.sender}:${match.permission}] visible=${visible} for ${viewerName}`);

            if (!visible) {
                result = result.substring(0, match.index) + result.substring(match.index + match.fullMatch.length);
            }
        }

        return result;
    }

    /**
     * 移除过滤后变为空白的消息
     */
    _removeEmptyMessages(messages) {
        return messages.filter(msg => {
            if (msg.role === 'system') return true;
            if (typeof msg.content === 'string') return msg.content.trim().length > 0;
            if (Array.isArray(msg.content)) {
                const hasNonEmptyText = msg.content.some(
                    p => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0
                );
                const hasNonTextPart = msg.content.some(p => p.type !== 'text');
                return hasNonEmptyText || hasNonTextPart;
            }
            return true;
        });
    }

    /**
     * 构建groupPrompt 注入（v2：隐藏组名和队友）
     */
    async buildGroupPromptInjection(agentName, sudoConfig, groupId, topicId) {
        const phase = (sudoConfig && sudoConfig.phase) || 'unknown';
        const round = (sudoConfig && sudoConfig.round) || 0;
        const gameType = (sudoConfig && sudoConfig.gameType) || 'unknown';

        const isPowerUser = sudoConfig && sudoConfig.powerUsers &&sudoConfig.powerUsers.includes(agentName);

        // 查.lock 文件确定 Agent 是否有组
        const agentGroup = groupId && topicId? await this.lockManager.findAgentGroup(groupId, topicId, agentName)
            : null;

        let injection = `\n\n[权限通信系统 · SudoEngine]`;
        injection += `\n当前游戏: ${gameType} |阶段: ${phase} | 轮次: ${round}`;
        injection += `\n你的名字: ${agentName}（在权限标签中使用此名字作为发送者）`;

        if (isPowerUser) {
            injection += `\n你的角色: 全视者（可以看到所有人的私密内容和组内通信）`;
        }

        injection += `\n\n可用的权限标签语法:`;
        injection += `\n•私密内心独白（仅你自己可见）: [内心:${agentName}:secret]你的想法[/内心]`;

        if (agentGroup) {
            // 有组——但不告诉组号和队友
            injection += `\n• 组内密语（仅你的队友可见，你不知道队友是谁——这是游戏的一部分）: [密语:${agentName}:group-x]密语内容[/密语]`;
        } else if (!isPowerUser) {
            injection += `\n你未被分配到任何组。`;
        }

        injection += `\n• 不使用标签的内容默认为公开发言，所有人可见。`;
        injection += `\n[/权限通信系统]`;

        debugLog(`buildGroupPromptInjection for ${agentName}: hasGroup=${!!agentGroup}, isPower=${isPowerUser}`);

        return injection;
    }

    /**
     * 处理 group:init 指令（代理到 GroupInitHandler）
     */
    async handleInit(messageText, groupId, topicId, allMemberNames) {
        return await handleGroupInit(messageText, groupId, topicId, allMemberNames);
    }
}

module.exports = SudoEngine;