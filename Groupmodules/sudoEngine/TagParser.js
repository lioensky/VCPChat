// sudoEngine/TagParser.js
// 权限标签解析器— ChatTagFolder 2.0
// Author: infinite-vector (based on ATRI's original design)

/**
 * 权限标签正则模式
 *
 * 语法: [标签名:发送者:权限修饰符]内容[/标签名]
 * 示例: [内心:CodeCC:secret]秘密内容[/内心]
 *[@狼人讨论:AgentA:group-werewolf]密语[/@狼人讨论]
 *
 * 标签名的@ 前缀是可选的（兼容 1.0 的无前缀格式和 2.0 的有前缀格式）
 *
 * 捕获组:
 *   $1 = 标签名 (如 内心, @内心, nvim-code)
 *   $2 = 发送者 (如 CodeCC)
 *   $3 = 权限修饰符 (如 secret, group-werewolf)
 *   $4 = 内容
 *
 * 语法约束:
 *   - 同名标签不可交叉使用
 *   - 标签内容不可包含自身闭合语法
 *   - 当前版本不支持嵌套标签
 */
const TAG_PATTERN = /\[(@?[^:\]]+):([^:\]]+):([^\]]+)\]([\s\S]*?)\[\/\1\]/g;

/**
 * 匹配到的标签内容的安全上限（字符数）
 */
const MAX_INNER_LENGTH = 2000;

/**
 * 解析单个标签匹配结果
 */
function parseTagMatch(match, tagName, sender, permission, inner) {
    if (inner.length > MAX_INNER_LENGTH) {
        console.warn(`[SudoEngine/TagParser] Tag inner exceeds ${MAX_INNER_LENGTH} chars (got ${inner.length}), skipping filter for safety.`);
        return null;
    }
    return { tagName, sender, permission, inner, fullMatch: match };
}

/**
 * 判断指定 viewer 是否有权查看该标签内容
 */
function isVisible(tagInfo, viewerName, sudoConfig) {
    const { sender, permission } = tagInfo;

    // 全视者：看到一切
    if (sudoConfig.powerUsers && sudoConfig.powerUsers.includes(viewerName)) {
        return true;
    }

    // :secret — 仅发送者本人可见（修正：secre → secret）
    if (permission === 'secret') {
        return viewerName === sender;
    }

    // :group-X — 仅组内成员可见
    if (permission.startsWith('group-')) {
        const groupName = permission.replace('group-', '');
        const members = (sudoConfig.groups && sudoConfig.groups[groupName]) || [];
        return members.includes(viewerName);
    }

    // 无已知修饰符 — 默认可见（向后兼容）
    return true;
}

/**
 * 尝试从 Speaker 标记中提取发言者名称（sender回退匹配）
 */
function extractSpeakerName(text) {
    const speakerMatch = text.match(/^\[(.+?)的发言\]:/);
    return speakerMatch ? speakerMatch[1] : null;
}

module.exports = {
    TAG_PATTERN,
    MAX_INNER_LENGTH,
    parseTagMatch,
    isVisible,
    extractSpeakerName
};