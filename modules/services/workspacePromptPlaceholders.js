// modules/services/workspacePromptPlaceholders.js
// 系统提示词占位符 {{VCPChatWorkSpace}} / {{VCPChatWorkSpace:文件夹名}} 的展开。
//
// - 只在用户把占位符显式写进系统提示词（Agent 系统提示或群聊设定）时展开，客户端不做默认注入；
// - 展开内容为目录树（真实根路径 + 相对路径），不含文件正文。AI 需要内容时用工具读取，
//   或由用户 @ 附加实时引用；
// - 行为由 settings.workspacePromptSettings 控制：enabled / maxChars / maxDepth。
//   停用时占位符原样保留，交由下游（如 VCP 服务器）处理。
'use strict';

const PLACEHOLDER_PATTERN = /\{\{VCPChatWorkSpace(?::([^{}]*))?\}\}/g;

const DEFAULT_PROMPT_SETTINGS = Object.freeze({
    enabled: true,
    maxChars: 20000,
    maxDepth: 6,
});

const LIMITS = Object.freeze({
    maxChars: { min: 1000, max: 200000 },
    maxDepth: { min: 1, max: 20 },
});

function clampInt(value, { min, max }, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** 规范化 settings.workspacePromptSettings，任何非法输入都回落到默认值。 */
function normalizePromptSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_PROMPT_SETTINGS.enabled,
        maxChars: clampInt(source.maxChars, LIMITS.maxChars, DEFAULT_PROMPT_SETTINGS.maxChars),
        maxDepth: clampInt(source.maxDepth, LIMITS.maxDepth, DEFAULT_PROMPT_SETTINGS.maxDepth),
    };
}

function hasWorkspacePlaceholder(text) {
    if (typeof text !== 'string' || !text.includes('{{VCPChatWorkSpace')) return false;
    PLACEHOLDER_PATTERN.lastIndex = 0;
    const found = PLACEHOLDER_PATTERN.test(text);
    PLACEHOLDER_PATTERN.lastIndex = 0;
    return found;
}

function formatTreeBlock(tree) {
    const header = [
        `[VCPChat 工作区: ${tree.alias}]`,
        `根目录: ${tree.path}`,
        `已索引文件数: ${tree.fileCount}${tree.truncated ? '（已达索引上限，部分文件未收录）' : ''}`,
    ];
    const notes = ['以下为相对根目录的路径，已应用 .gitignore 与默认忽略规则（.git、node_modules、虚拟环境等）。'];
    if (tree.depth < tree.requestedDepth) {
        notes.push(`因字符预算限制，目录只展开到第 ${tree.depth} 层（设置为 ${tree.requestedDepth} 层）。`);
    }
    if (tree.collapsedDirs > 0) notes.push(`标注"未展开"的目录共 ${tree.collapsedDirs} 个。`);
    if (tree.omittedLines > 0) notes.push(`另有 ${tree.omittedLines} 个顶层条目因字符预算被省略。`);
    notes.push('需要文件内容时，请按"根目录 + 相对路径"读取真实文件。');
    return [
        ...header,
        ...notes,
        '',
        tree.text || '（工作区内没有可索引的文件）',
        `[/VCPChat 工作区: ${tree.alias}]`,
    ].join('\n');
}

async function renderOne(name, { index, activeWorkspaceId, settings }) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    let state = null;
    if (trimmed) {
        state = index.findByName(trimmed);
        if (!state) return `[VCPChat 工作区 "${trimmed}" 未登记或已停用]`;
    } else {
        state = activeWorkspaceId
            ? index.getEnabled().find(item => item.config.id === activeWorkspaceId) || null
            : null;
        if (!state) {
            return '[VCPChat 当前未选择工作区：请在输入框的工作区按钮中选择，或改用 {{VCPChatWorkSpace:文件夹名}}]';
        }
    }

    const tree = await index.renderTree(state.config.id, {
        maxChars: settings.maxChars,
        maxDepth: settings.maxDepth,
    });
    if (!tree) return `[VCPChat 工作区 "${trimmed || state.config.alias}" 未登记或已停用]`;
    if (tree.status !== 'ready') {
        return `[VCPChat 工作区 ${tree.alias} 索引不可用: ${tree.error || tree.status}]`;
    }
    return formatTreeBlock(tree);
}

/**
 * 展开文本中的所有工作区占位符。同一文件夹名在一次调用内只渲染一次。
 * @param {string} text
 * @param {{ index: import('./workspaceIndex').WorkspaceIndex | null, activeWorkspaceId?: string|null, settings?: object }} options
 */
async function expandWorkspacePlaceholders(text, { index, activeWorkspaceId = null, settings = null } = {}) {
    if (!hasWorkspacePlaceholder(text)) return text;
    const normalized = normalizePromptSettings(settings);
    if (!normalized.enabled) return text;

    const names = new Set();
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) names.add((match[1] || '').trim());

    const rendered = new Map();
    for (const name of names) {
        try {
            rendered.set(name, index
                ? await renderOne(name, { index, activeWorkspaceId, settings: normalized })
                : '[VCPChat 工作区服务未就绪]');
        } catch (error) {
            rendered.set(name, `[VCPChat 工作区展开失败: ${error?.message || error}]`);
        }
    }
    return text.replace(PLACEHOLDER_PATTERN, (_whole, name) => rendered.get((name || '').trim()) ?? '');
}

module.exports = {
    DEFAULT_PROMPT_SETTINGS,
    LIMITS,
    normalizePromptSettings,
    hasWorkspacePlaceholder,
    expandWorkspacePlaceholders,
};