// sudoEngine/GroupInitHandler.js
// 分组初始化处理器— ChatTagFolder 2.0
// Author: infinite-vector (design by 竹林夕弦)
//
// 解析 group:init 指令，随机分组，创建 .lock 文件
//
// 语法: group:init a:[b]:[c]
//a = 总人数（用于校验）
//   [b] = 每组人数列表，如 [2,2,2,2]
//   [c] = 不参与分组的 Agent 名单（可选），如 [旁白,主持人]
//
// 示例:
//   group:init 8:[2,2,2,2]
//   group:init 9:[2,2,2,1]:[ATRI,Hananawi]

const LockManager = require('./LockManager');

const lockManager = new LockManager();

//匹配 group:init 指令的正则
const INIT_PATTERN = /group:init\s+(\d+):\[([^\]]+)\](?::\[([^\]]*)\])?/;

/**
 * 解析 group:init 指令
 * @param {string} text - 用户消息文本
 * @returns {object|null} 解析结果 {totalCount, groupSizes, excludeList} 或 null
 */
function parseInitCommand(text) {
    const match = text.match(INIT_PATTERN);
    if (!match) return null;

    const totalCount = parseInt(match[1], 10);
    const groupSizes = match[2].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const excludeList = match[3]
        ? match[3].split(',').map(s => s.trim()).filter(s => s.length > 0)
        : [];

    // 校验: 每组人数之和应该等于 totalCount（减去排除人数后的参与人数）
    const totalInGroups = groupSizes.reduce((a, b) => a + b, 0);

    return {
        totalCount,
        groupSizes,
        excludeList,
        totalInGroups
    };
}

/**
 * Fisher-Yates 洗牌算法
 * @param {Array} array - 要打乱的数组
 * @returns {Array} 打乱后的新数组
 */
function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * 执行分组初始化
 * @param {string} messageText - 用户消息文本（可能包含 group:init 指令）
 * @param {string} groupId - 群组ID
 * @param {string} topicId - 话题ID
 * @param {string[]} allMemberNames - 群组所有成员的名字列表
 * @returns {Promise<object|null>} 分组结果或 null（非init 指令）
 *成功: { success: true, groups: [{groupNumber, members},...], excluded, powerUsers }
 *   失败: { success: false, error: string }
 */
async function handleGroupInit(messageText, groupId, topicId, allMemberNames) {
    const parsed = parseInitCommand(messageText);
    if (!parsed) return null; // 不是 init 指令

    const { totalCount, groupSizes, excludeList, totalInGroups } = parsed;

    console.log(`[SudoEngine/GroupInit] Parsed: total=${totalCount}, sizes=[${groupSizes}], exclude=[${excludeList}]`);

    // 过滤出参与分组的成员
    const participants = allMemberNames.filter(name => !excludeList.includes(name));

    // 校验人数
    if (participants.length< totalInGroups) {
        return {
            success: false,
            error: `参与分组的成员(${participants.length}人)少于分组所需(${totalInGroups}人)。成员: [${participants.join(', ')}]，排除: [${excludeList.join(', ')}]`
        };
    }

    if (participants.length > totalInGroups) {
        console.warn(`[SudoEngine/GroupInit] Warning: ${participants.length} participants but only ${totalInGroups} slots. Extra members will not be assigned.`);
    }

    // 随机打散
    const shuffled = shuffle(participants);

    // 按groupSizes 分组
    const groups = [];
    let offset = 0;
    for (let i = 0; i < groupSizes.length; i++) {
        const size = groupSizes[i];
        const members = shuffled.slice(offset, offset + size);
        offset += size;
        groups.push({
            groupNumber: i + 1,
            members
        });
    }

    // 清除旧锁（如果有）
    await lockManager.clearLocks(groupId, topicId);

    // 创建新锁
    for (const group of groups) {
        await lockManager.createGroupLock(groupId, topicId, group.groupNumber, group.members);
    }

    // 被排除的成员自动成为 powerUsers（可以看到所有内容）
    const powerUsers = excludeList.filter(name => allMemberNames.includes(name));

    console.log(`[SudoEngine/GroupInit] Initialization complete:`);
    groups.forEach(g => console.log(`  Group ${g.groupNumber}: [${g.members.join(', ')}]`));
    console.log(`  PowerUsers (excluded): [${powerUsers.join(', ')}]`);

    return {
        success: true,
        groups,
        excluded: excludeList,
        powerUsers,
        totalGroups: groupSizes.length
    };
}

module.exports = {
    parseInitCommand,
    handleGroupInit,
    lockManager
};