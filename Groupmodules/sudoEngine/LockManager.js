// sudoEngine/LockManager.js
// .lock 文件管理器— ChatTagFolder 2.0
// Author: infinite-vector (design by竹林夕弦)
//
// 管理 per-topic 的组锁文件
// 路径结构: Plugin/ChatTagFolder/[groupId]/[topicId]/group-N.lock
// .lock 文件对Agent 只写不读——SudoEngine 后台使用
// Agent 不知道自己的组号，不知道队友

const fs = require('fs-extra');
const path = require('path');

// 插件目录下的 ChatTagFolder 存储根目录
// 与 VCPToolBox 的 Plugin 目录平行，放在 VCPChat 侧
const LOCK_BASE_DIR = path.join(__dirname, '..', '..', 'AppData', 'SudoEngineLocks');

class LockManager {
    constructor() {
        // 确保根目录存在
        fs.ensureDirSync(LOCK_BASE_DIR);
    }

    /**
     * 获取指定话题的锁文件目录
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @returns {string} 目录路径
     */
    _getTopicLockDir(groupId, topicId) {
        return path.join(LOCK_BASE_DIR, groupId, topicId);
    }

    /**
     * 创建组锁文件
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @param {number} groupNumber - 组号 (1, 2, 3...)
     * @param {string[]} members - 组成员名列表
     * @returns {Promise<string>} 创建的锁文件路径
     */
    async createGroupLock(groupId, topicId, groupNumber, members) {
        const lockDir = this._getTopicLockDir(groupId, topicId);
        await fs.ensureDir(lockDir);

        const lockPath = path.join(lockDir, `group-${groupNumber}.lock`);
        const lockData = {
            groupNumber,
            members,
            created: new Date().toISOString()
        };

        await fs.writeJson(lockPath, lockData, { spaces: 2 });
        console.log(`[SudoEngine/LockManager] Created lock: ${lockPath} with members: [${members.join(', ')}]`);
        return lockPath;
    }

    /**
     * 扫描指定话题下的所有组锁文件
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @returns {Promise<Array>} 所有组的信息 [{groupNumber, members, lockPath}, ...]
     */
    async scanLocks(groupId, topicId) {
        const lockDir = this._getTopicLockDir(groupId, topicId);

        if (!await fs.pathExists(lockDir)) {
            return [];
        }

        const files = await fs.readdir(lockDir);
        const lockFiles = files.filter(f => f.startsWith('group-') && f.endsWith('.lock'));

        const groups = [];
        for (const file of lockFiles) {
            try {
                const lockPath = path.join(lockDir, file);
                const data = await fs.readJson(lockPath);
                groups.push({
                    groupNumber: data.groupNumber,
                    members: data.members || [],
                    lockPath
                });
            } catch (e) {
                console.warn(`[SudoEngine/LockManager] Failed to read lock file ${file}:`, e.message);
            }
        }

        return groups;
    }

    /**
     * 查找指定 Agent 所属的组
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @param {string} agentName - Agent 名
     * @returns {Promise<object|null>} {groupNumber, members} 或 null（未分组）
     */
    async findAgentGroup(groupId, topicId, agentName) {
        const groups = await this.scanLocks(groupId, topicId);

        for (const group of groups) {
            if (group.members.includes(agentName)) {
                return {
                    groupNumber: group.groupNumber,
                    members: group.members
                };
            }
        }

        return null; // Agent 未被分配到任何组
    }

    /**
     * 检查两个 Agent 是否在同一组
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @param {string} agentA - Agent A 的名字
     * @param {string} agentB - Agent B 的名字
     * @returns {Promise<boolean>} 是否同组
     */
    async isSameGroup(groupId, topicId, agentA, agentB) {
        const groupA = await this.findAgentGroup(groupId, topicId, agentA);
        const groupB = await this.findAgentGroup(groupId, topicId, agentB);

        if (!groupA || !groupB) return false;
        return groupA.groupNumber === groupB.groupNumber;
    }

    /**
     * 检查指定话题是否已经初始化了分组
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     * @returns {Promise<boolean>}
     */
    async hasLocks(groupId, topicId) {
        const groups = await this.scanLocks(groupId, topicId);
        return groups.length > 0;
    }

    /**
     * 清除指定话题的所有锁文件（重新分组时用）
     * @param {string} groupId - 群组ID
     * @param {string} topicId - 话题ID
     */
    async clearLocks(groupId, topicId) {
        const lockDir = this._getTopicLockDir(groupId, topicId);
        if (await fs.pathExists(lockDir)) {
            await fs.remove(lockDir);
            console.log(`[SudoEngine/LockManager] Cleared all locks for ${groupId}/${topicId}`);
        }
    }
}

module.exports = LockManager;