/**
 * modules/ui-system/conversation-status-panel/helpers.js
 * 会话右上角浮动的「状态」面板：Git 变更（更改 / 分支 / 提交或推送）与 V工程 计划（todo），
 * 也可以收起成一颗迷你胶囊。
 *
 * 结构、交互和样式对照 ZCode 的 ConversationStatusPanel / GitBranchSwitcher / GitActionMenu
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4 与 packages/ui/src），
 * 由 React + Tailwind 改写为原生 DOM + styles/ui-system/status-panel.css。
 * 数据来自现有后端：Git 走 git:* IPC，V工程走 project-forge:* IPC，
 * 工作区选择与侧栏 Git 标签、V工程 Git 页共用同一个 localStorage 键。
 */

'use strict';

const COMPACT_TODO_THRESHOLD = 6;

const TODO_FOCUS_WINDOW_SIZE = 3;

// 聊天区够 1280 才自动展开，窄了（包括侧栏打开挤窄时）自动收成胶囊
const AUTO_PANEL_MIN_WIDTH = 1280;

export function filterBranches(branches, query) {
    const q = String(query || '').trim().toLowerCase();
    return (branches || []).filter(branch => !q || String(branch.name).toLowerCase().includes(q));
}

export function getTodoFocusWindow(items) {
    if (items.length <= COMPACT_TODO_THRESHOLD) {
        return { compact: false, precedingItems: [], focusItems: items, followingItems: [] };
    }
    const runningIndex = items.findIndex(item => item.status === 'inProgress');
    const firstUnfinished = items.findIndex(item => item.status !== 'completed');
    const focusIndex = runningIndex >= 0
        ? runningIndex
        : firstUnfinished >= 0 ? firstUnfinished : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
    const start = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE));
    const end = Math.min(items.length, start + TODO_FOCUS_WINDOW_SIZE);
    return {
        compact: true,
        precedingItems: items.slice(0, start),
        focusItems: items.slice(start, end),
        followingItems: items.slice(end)
    };
}

export function pickMiniMetric({ items = [], git = null } = {}) {
    const current = items.find(item => item.status === 'inProgress') || items.find(item => item.status === 'pending') || null;
    const completed = [...items].reverse().find(item => item.status === 'completed') || null;
    const hasChanges = Boolean(git && (git.added + git.removed > 0));
    if (current) return { kind: 'current', icon: 'arrow-right', text: current.content };
    if (hasChanges) return { kind: 'changes', icon: 'file-diff', text: '更改', added: git.added, removed: git.removed };
    if (completed) return { kind: 'completed', icon: 'circle-check-big', text: completed.content, success: true };
    if (items.length) {
        const done = items.filter(item => item.status === 'completed').length;
        return { kind: 'todo', icon: 'list-checks', text: '计划', count: `${done}/${items.length}` };
    }
    // 干净的仓库、没有计划：胶囊仍然显示当前分支，点开就是 Git 变更（保留入口，不整块隐藏）
    if (git?.branch) return { kind: 'branch', icon: 'git-branch', text: git.branch.head || (git.branch.detached ? '游离 HEAD' : 'Git 变更') };
    return null;
}

export function pickEntryMetric({ workspaceCount = 0, hasWorkspace = false } = {}) {
    if (!workspaceCount || !hasWorkspace) return { icon: 'git-branch', text: '添加工作区', hint: '还没有工作区，点击去添加并查看 Git 改动' };
    return { icon: 'git-branch', text: 'Git 变更', hint: '当前工作区不是 Git 仓库，点击查看' };
}

export function resolveVariant({ override = null, width = 0 } = {}) {
    if (override === 'panel' || override === 'mini') return override;
    return width >= AUTO_PANEL_MIN_WIDTH ? 'panel' : 'mini';
}

export function buildCommitMessage(paths) {
    const names = [...new Set((paths || []).map(p => String(p).split(/[\\/]/).pop()).filter(Boolean))];
    if (!names.length) return '';
    if (names.length <= 3) return `更新 ${names.join('、')}`;
    return `更新 ${names.slice(0, 2).join('、')} 等 ${names.length} 个文件`;
}

export function parseSwitchBlockedFiles(message) {
    const text = String(message || '');
    if (!/would be overwritten|overwritten by checkout|untracked working tree files/i.test(text)) return null;
    const untracked = /untracked working tree files/i.test(text);
    const files = text.split(/\r?\n/).filter(line => /^\s+\S/.test(line)).map(line => line.trim());
    return files.length ? { files, untracked } : null;
}

export function formatShortcutLabel(isMac) {
    return isMac ? '⌘ ⏎' : 'CTRL+⏎';
}

export function uniquePaths(entries) {
    return [...new Set((entries || []).map(item => item.path).filter(Boolean))];
}

export function formatCommitTime(seconds) {
    if (!seconds) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .format(new Date(seconds * 1000));
}
