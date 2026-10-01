/**
 * modules/ui-system/conversation-status-panel.js
 * 会话右上角浮动的「状态」面板：Git 工具（更改 / 分支 / 提交或推送）与 V工程 进程（todo），
 * 也可以收起成一颗迷你胶囊。
 *
 * 结构、交互和样式对照 ZCode 的 ConversationStatusPanel / GitBranchSwitcher / GitActionMenu
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4 与 packages/ui/src），
 * 由 React + Tailwind 改写为原生 DOM + styles/ui-system/status-panel.css。
 * 数据来自现有后端：Git 走 git:* IPC，V工程走 project-forge:* IPC，
 * 工作区选择与侧栏 Git 标签、V工程 Git 页共用同一个 localStorage 键。
 */

'use strict';

import { layoutGitGraph, parseGraphRefs } from './git-graph-layout.js';
import { pickProjectsForWorkspace, mapTodoItems } from './project-plan-model.js';
import { collectConversationScope, normalizeCommand, scopeSignature } from './conversation-scope.js';

const STORAGE_KEY_WS = 'vcp-projectforge-git-workspace';
const STORAGE_KEY_VARIANT = 'vcp-status-panel-variant';
const POLL_INTERVAL_MS = 15000;
const RESCOPE_DEBOUNCE_MS = 700;
const RECENT_RUN_WINDOW_MS = 30 * 60 * 1000;
const MAX_RUN_ROWS = 4;
const COMPACT_TODO_THRESHOLD = 6;
const TODO_FOCUS_WINDOW_SIZE = 3;
const AUTO_PANEL_MIN_WIDTH = 640;
const GRAPH_PAGE_SIZE = 50;
const NODE_RADIUS = 4;
const SELECTED_NODE_RADIUS = 4.25;
const SELECTED_RING_RADIUS = 5.5;
const LANE_COLORS = ['descendant', 'renamed', 'added', 'modified'];

const SVG_NS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------ pure helpers

/** 选出与当前工作区对应的 V工程（同一工作区取最近更新的未删除工程）。 */


/** 分支搜索：名称包含输入即可，不区分大小写。 */
export function filterBranches(branches, query) {
    const q = String(query || '').trim().toLowerCase();
    return (branches || []).filter(branch => !q || String(branch.name).toLowerCase().includes(q));
}



/** V工程 todo → 面板里的进程项（对应 ZCode PlanState.items 的 completed / inProgress / pending）。 */


/** 超过 6 项时只展示「当前 + 后两条」的三条窗口，其余折叠成两行摘要。 */
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

/** 收起状态下胶囊里放什么：当前进程 > 更改 > 最近完成的进程 > 进程计数。 */
export function pickMiniMetric({ items = [], git = null } = {}) {
    const current = items.find(item => item.status === 'inProgress') || items.find(item => item.status === 'pending') || null;
    const completed = [...items].reverse().find(item => item.status === 'completed') || null;
    const hasChanges = Boolean(git && (git.added + git.removed > 0));
    if (current) return { kind: 'current', icon: 'arrow-right', text: current.content };
    if (hasChanges) return { kind: 'changes', icon: 'file-diff', text: '更改', added: git.added, removed: git.removed };
    if (completed) return { kind: 'completed', icon: 'circle-check-big', text: completed.content, success: true };
    if (items.length) {
        const done = items.filter(item => item.status === 'completed').length;
        return { kind: 'todo', icon: 'list-checks', text: '进程', count: `${done}/${items.length}` };
    }
    // 干净的仓库、没有进程：胶囊仍然显示当前分支，点开就是 Git 工具（ZCode 此时会整块隐藏，这里保留入口）
    if (git?.branch) return { kind: 'branch', icon: 'git-branch', text: git.branch.head || (git.branch.detached ? '游离 HEAD' : 'Git 工具') };
    return null;
}

/** 没有 Git 工作区 / 进程 / 命令记录时，胶囊仍然保留为入口：点一下去侧栏 Git 标签（里面可以添加工作区）。 */
export function pickEntryMetric({ workspaceCount = 0, hasWorkspace = false } = {}) {
    if (!workspaceCount || !hasWorkspace) return { icon: 'git-branch', text: '添加工作区', hint: '还没有工作区，点击去添加并查看 Git 改动' };
    return { icon: 'git-branch', text: 'Git 工具', hint: '当前工作区不是 Git 仓库，点击查看' };
}

export function resolveVariant({ override = null, width = 0 } = {}) {
    if (override === 'panel' || override === 'mini') return override;
    return width >= AUTO_PANEL_MIN_WIDTH ? 'panel' : 'mini';
}

/** 没有手写提交信息时，根据改动的文件生成一条。 */
export function buildCommitMessage(paths) {
    const names = [...new Set((paths || []).map(p => String(p).split(/[\\/]/).pop()).filter(Boolean))];
    if (!names.length) return '';
    if (names.length <= 3) return `更新 ${names.join('、')}`;
    return `更新 ${names.slice(0, 2).join('、')} 等 ${names.length} 个文件`;
}

/** 切换分支被本地改动挡住时，git 会列出会被覆盖的文件（每行一个，Tab 缩进）。 */
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

function uniquePaths(entries) {
    return [...new Set((entries || []).map(item => item.path).filter(Boolean))];
}

function formatCommitTime(seconds) {
    if (!seconds) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .format(new Date(seconds * 1000));
}

// ------------------------------------------------------------------ component

export function createConversationStatusPanel({
    document: doc = document,
    api = null,
    uiHelper = null,
    host = null,
    onOpenGitTab = null,
    onOpenPlanDetail = null,
    onOpenToolOutput = null,
    onOpenProjectForge = null,
    // 给了 getHistory，面板就跟着当前会话走（和 ZCode 的面板跟着 session 一样）：
    // 只显示这个话题的聊天记录里碰过的 V工程（进程 + 它所在工作区的 Git）和它发起过的命令。
    // 不给就保持旧行为：整个应用共用一份。
    getHistory = null,
    messagesRoot = null,
    onConversationChange = null,
    changeEvent = 'vcp:git-changed'
} = {}) {
    const win = doc.defaultView || window;
    const storage = (() => { try { return win.localStorage; } catch (_e) { return null; } })();
    const isMac = /Mac|iPhone|iPad/.test(win.navigator?.platform || '') || /Mac/.test(win.navigator?.userAgent || '');
    const toast = (message, type = 'info') => uiHelper?.showToastNotification?.(message, type);

    let workspaces = [];
    let workspace = null;
    let summary = null;
    let branchList = null;
    let plan = null; // { items, project }
    let commandRuns = []; // AI 命令运行记录（新的在前），来自自带终端
    const scoped = typeof getHistory === 'function';
    let scope = { projectIds: [], commands: new Set() };
    let scopeKey = scopeSignature(scope);
    let variantOverride = (() => {
        const stored = storage?.getItem(STORAGE_KEY_VARIANT);
        return stored === 'panel' || stored === 'mini' ? stored : null;
    })();
    let hostWidth = 0;
    const sectionOpen = { git: true, plan: true, runs: true };
    let busy = false;
    let disposed = false;
    let refreshSeq = 0;
    let renderKey = '';
    let pollTimer = null;
    let resizeObserver = null;
    let mounted = false;
    const cleanups = [];
    const popovers = []; // 由上到下的浮层栈
    const modals = [];

    // ------------------------------------------------------------------ dom helpers

    function h(tag, className, ...children) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        for (const child of children) {
            if (child === null || child === undefined || child === false) continue;
            node.appendChild(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
        }
        return node;
    }

    function icon(name, className = '') {
        const span = doc.createElement('span');
        span.className = `vcp-ui-icon zc-i ${className}`.trim();
        span.textContent = name;
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    function button(className, { label = '', type = 'button', disabled = false, onClick = null } = {}, ...children) {
        const btn = h('button', className, ...children);
        btn.type = type;
        btn.disabled = disabled;
        if (label) btn.setAttribute('aria-label', label);
        if (onClick) btn.addEventListener('click', onClick);
        return btn;
    }

    function diffCounts(added, removed, className = '') {
        return h('span', `zc-diff ${className}`.trim(),
            h('span', 'zc-added', `+${added}`), ' ', h('span', 'zc-removed', `-${removed}`));
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    // 浮层（popover、dialog）挂在 body 下，独立于会话区域的滚动与裁剪
    const portal = h('div', 'zc-scope vcp-ui-scope zc-portal');
    const layer = h('div', 'zc-scope vcp-ui-scope zc-status-layer');
    layer.hidden = true;
    const aside = h('aside', 'zc-status');
    aside.setAttribute('aria-label', '状态');
    layer.appendChild(aside);

    // ------------------------------------------------------------------ data

    // Git 侧栏标签与这个面板读的是同一个仓库：任何一边改了仓库，都发一个事件让另一边马上刷新
    function refreshAfterMutation() {
        try { win.dispatchEvent(new win.CustomEvent(changeEvent, { detail: { source: 'status-panel' } })); } catch (_e) { /* ignore */ }
        return refresh();
    }

    function readScope() {
        if (!scoped) return;
        try { scope = collectConversationScope(getHistory()); } catch (_e) { scope = { projectIds: [], commands: new Set() }; }
        scopeKey = scopeSignature(scope);
    }

    // 会话里碰过的 V工程：先看它挂在哪个工作区，Git 区就读那个工作区
    let scopedProjects = []; // 最近提到的在前

    async function loadScopedProjects(nextScope) {
        if (!nextScope.projectIds.length || !api?.projectForgeListProjects) return [];
        try {
            const res = await api.projectForgeListProjects({});
            const byId = new Map((res?.success ? res.data || [] : []).filter(p => !p.deleted_at).map(p => [p.id, p]));
            return nextScope.projectIds.map(id => byId.get(id)).filter(Boolean);
        } catch { return []; }
    }

    function workspaceOfProject(project, list) {
        if (!project) return null;
        return list.find(w => w.id === project.workspace_id || (w.alias && w.alias === project.workspace_alias)) || null;
    }

    async function pickWorkspace(projects) {
        if (!api?.gitListWorkspaces) return { workspace: null, workspaces: [] };
        const res = await api.gitListWorkspaces();
        const list = res?.success ? res.data?.workspaces || [] : [];
        const stored = storage?.getItem(STORAGE_KEY_WS);
        const selected = scoped
            ? projects.map(project => workspaceOfProject(project, list)).find(Boolean)
            : list.find(w => w.id === stored) || list.find(w => w.id === res.data?.activeWorkspaceId) || list[0];
        return { workspace: selected || null, workspaces: list };
    }

    async function loadPlan(nextWorkspace, projects) {
        try {
            let candidates = projects;
            if (!scoped) {
                if (!nextWorkspace || !api?.projectForgeListProjects) return null;
                const res = await api.projectForgeListProjects({});
                candidates = res?.success ? pickProjectsForWorkspace(res.data, nextWorkspace) : [];
            }
            for (const project of candidates) {
                const detail = await api.projectForgeGetProject?.(project.id);
                const items = mapTodoItems(detail?.success ? detail.data?.todos : []);
                if (items.length) return { items, project };
            }
        } catch { /* 进程信息缺失不影响 Git 部分 */ }
        return null;
    }

    async function refresh() {
        if (disposed) return;
        const seq = ++refreshSeq;
        readScope();
        const nextScope = { projectIds: [...scope.projectIds], commands: new Set(scope.commands) };
        let projects = [], nextWorkspace = null, nextWorkspaces = [], nextSummary = null, nextPlan = null;
        try {
            projects = await loadScopedProjects(nextScope);
            if (disposed || seq !== refreshSeq) return;
            const selected = await pickWorkspace(projects);
            nextWorkspace = selected.workspace;
            nextWorkspaces = selected.workspaces;
            if (disposed || seq !== refreshSeq) return;
            if (nextWorkspace && api?.gitChangeSummary) {
                const res = await api.gitChangeSummary(nextWorkspace.id);
                nextSummary = res?.success ? res.data : null;
            }
            if (disposed || seq !== refreshSeq) return;
            nextPlan = await loadPlan(nextWorkspace, projects);
        } catch { /* 所有失败结果也只能由当前 generation 提交 */ }
        if (disposed || seq !== refreshSeq) return;
        // 对照 ZCode workspaceKey 的归属规则：异步 helper 只返回局部结果，当前会话一次提交。
        scopedProjects = projects;
        if (workspace?.id !== nextWorkspace?.id) { closeAllPopovers(); for (const modal of [...modals]) modal.close(); }
        workspace = nextWorkspace;
        workspaces = nextWorkspaces;
        summary = nextSummary;
        plan = nextPlan;
        render();
    }

    async function loadBranches() {
        const targetWorkspace = workspace;
        const seq = refreshSeq;
        if (!targetWorkspace || !api?.gitListBranches) return false;
        try {
            const res = await api.gitListBranches(targetWorkspace.id);
            if (disposed || seq !== refreshSeq || workspace?.id !== targetWorkspace.id) return false;
            branchList = res?.success ? res.data : null;
            return true;
        } catch (_e) {
            if (!disposed && seq === refreshSeq) branchList = null;
            return false;
        }
    }

    // ------------------------------------------------------------------ floating layers

    function placeFloating(node, anchor, { side = 'bottom', offset = 4 } = {}) {
        const a = anchor.getBoundingClientRect();
        const vw = win.innerWidth;
        const vh = win.innerHeight;
        const w = node.offsetWidth;
        const hgt = node.offsetHeight;
        let left;
        let top;
        if (side === 'left' && a.left - w - offset >= 8) {
            left = a.left - w - offset;
            top = a.top;
        } else {
            left = a.left;
            top = a.bottom + offset;
            if (top + hgt > vh - 8 && a.top - hgt - offset >= 8) top = a.top - hgt - offset;
        }
        left = Math.max(8, Math.min(left, vw - w - 8));
        top = Math.max(8, Math.min(top, vh - hgt - 8));
        node.style.left = `${Math.round(left)}px`;
        node.style.top = `${Math.round(top)}px`;
    }

    function closePopover(entry) {
        const index = popovers.indexOf(entry);
        if (index < 0) return;
        popovers.splice(index, 1);
        entry.node.remove();
        entry.cleanup?.();
        entry.onClose?.();
    }

    function closeAllPopovers() {
        [...popovers].reverse().forEach(closePopover);
    }

    /** 打开一个浮层；点击浮层和锚点之外的位置、按 Esc 时关闭。 */
    function openPopover(node, anchor, { side = 'bottom', className = '', onClose = null, hover = false } = {}) {
        node.classList.add('zc-popover', ...className.split(' ').filter(Boolean));
        portal.appendChild(node);
        placeFloating(node, anchor, { side });
        const entry = { node, anchor, onClose, cleanup: null };
        popovers.push(entry);
        if (!hover) {
            const onDown = event => {
                if (!node.contains(event.target) && !anchor.contains(event.target)) closePopover(entry);
            };
            doc.addEventListener('mousedown', onDown, true);
            entry.cleanup = () => doc.removeEventListener('mousedown', onDown, true);
        }
        return entry;
    }

    function openModal({ className = '', onClose = null, showClose = false } = {}) {
        const overlay = h('div', 'zc-overlay');
        const dialog = h('div', `zc-dialog ${className}`.trim());
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.tabIndex = -1;
        overlay.appendChild(dialog);
        const entry = { overlay, dialog, closed: false };
        entry.close = () => {
            if (entry.closed) return;
            entry.closed = true;
            const index = modals.indexOf(entry);
            if (index >= 0) modals.splice(index, 1);
            overlay.remove();
            onClose?.();
        };
        if (showClose) {
            dialog.appendChild(button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-dialog-close', { label: '关闭', onClick: entry.close }, icon('x')));
        }
        overlay.addEventListener('mousedown', event => { if (event.target === overlay) entry.close(); });
        portal.appendChild(overlay);
        modals.push(entry);
        dialog.focus({ preventScroll: true });
        return entry;
    }

    function spinner() {
        return icon('loader-circle', 'zc-spin');
    }

    // ------------------------------------------------------------------ branch switcher

    function branchLabel() {
        const branch = summary?.branch;
        return branch?.detached ? '游离 HEAD' : (branch?.head || 'HEAD');
    }

    function describeIssue(res) {
        return res?.error || res?.data?.issues?.[0]?.message || res?.issues?.[0]?.message || '操作失败';
    }

    function branchTrigger({ className = '', popoverClass = '', side = 'bottom', footer = false, onAfterSwitch = null } = {}) {
        const label = h('span', 'zc-branch-label', branchLabel());
        const btn = button(`zc-btn zc-btn-ghost zc-branch-trigger ${className}`.trim(),
            { label: '切换 Git 分支', disabled: busy },
            icon('git-branch', 'zc-subtle'), label, busy ? spinner() : icon('chevron-down', 'zc-subtle zc-chevron'));
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.addEventListener('click', async () => {
            if (popovers.some(p => p.anchor === btn)) { closeAllPopovers(); return; }
            if (!await loadBranches()) return;
            openBranchPopover(btn, { side, popoverClass, footer, onAfterSwitch });
        });
        return btn;
    }

    /** 供 Git 侧栏标签复用：先对齐工作区与分支列表，再在 anchor 下弹出同一个分支切换浮层。 */
    async function openBranchSwitcher(anchor, { onAfterSwitch = null, side = 'bottom' } = {}) {
        if (!anchor) return;
        if (popovers.some(p => p.anchor === anchor)) { closeAllPopovers(); return; }
        await refresh();
        if (!workspace || !summary?.branch) { toast('当前工作区不是 Git 仓库', 'info'); return; }
        if (!await loadBranches()) return;
        openBranchPopover(anchor, { side, popoverClass: 'zc-popover-w72', footer: true, onAfterSwitch });
    }

    function openBranchPopover(anchor, { side, popoverClass, footer, onAfterSwitch }) {
        const branches = branchList?.branches || [];
        let query = '';
        let selected = -1;
        let entry = null;

        const input = h('input', 'zc-command-input');
        input.type = 'text';
        input.placeholder = '搜索分支';
        input.setAttribute('aria-label', '搜索分支');
        const inputWrap = h('div', 'zc-command-input-wrap', h('div', 'zc-input-group', icon('search', 'zc-subtlest'), input));
        const list = h('div', 'zc-command-list zc-branch-list');
        const pop = h('div', `zc-branch-popover ${popoverClass}`.trim());
        pop.append(inputWrap, list);

        const pick = branch => {
            closePopover(entry);
            switchBranch(branch.name).then(ok => { if (ok) onAfterSwitch?.(); });
        };

        const renderList = () => {
            list.textContent = '';
            const shown = filterBranches(branches, query);
            if (!shown.length) {
                list.appendChild(h('div', 'zc-command-empty', branches.length ? '未找到匹配分支' : '正在读取分支…'));
                return;
            }
            const group = h('div', 'zc-command-group', h('div', 'zc-command-heading', '分支'));
            shown.forEach((branch, index) => {
                const isCurrent = branch.current;
                const item = h('div', 'zc-command-item zc-branch-item');
                item.dataset.branch = branch.name;
                if (isCurrent) item.dataset.checked = 'true';
                if (index === selected) item.dataset.selected = 'true';
                const text = h('div', 'zc-branch-item-text', h('div', 'zc-branch-name', branch.name));
                if (isCurrent && (summary?.files || 0) > 0) {
                    text.appendChild(h('p', 'zc-branch-dirty', `未提交的更改：${summary.files} 个文件`));
                }
                item.append(icon('git-branch', 'zc-subtle zc-branch-item-icon'), text);
                if (isCurrent) item.appendChild(icon('check', 'zc-check'));
                item.addEventListener('mousemove', () => {
                    if (selected === index) return;
                    selected = index;
                    syncSelection();
                });
                item.addEventListener('click', () => pick(branch));
                group.appendChild(item);
            });
            list.appendChild(group);
        };
        const syncSelection = () => {
            [...list.querySelectorAll('.zc-command-item')].forEach((node, index) => {
                if (index === selected) node.dataset.selected = 'true';
                else delete node.dataset.selected;
            });
            list.querySelector('.zc-command-item[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
        };
        input.addEventListener('input', () => { query = input.value; selected = -1; renderList(); });
        pop.addEventListener('keydown', event => {
            const shown = filterBranches(branches, query);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!shown.length) return;
                selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
                syncSelection();
            } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const target = shown[selected >= 0 ? selected : 0];
                if (target) pick(target);
            } else if (event.key === 'Escape') {
                event.stopPropagation();
                closePopover(entry);
                anchor.focus?.();
            }
        });
        renderList();

        if (footer) {
            pop.appendChild(h('div', 'zc-popover-footer',
                button('zc-btn zc-btn-ghost zc-btn-lg zc-footer-action', { disabled: busy, onClick: () => { closePopover(entry); openCreateBranchDialog(); } },
                    icon('plus', 'zc-subtle'), '创建并检出新分支...'),
                button('zc-btn zc-btn-ghost zc-btn-lg zc-footer-action', { onClick: () => { closePopover(entry); openGitGraphDialog(); } },
                    icon('git-graph', 'zc-subtle'), 'Git 图谱')));
        }
        entry = openPopover(pop, anchor, { side, className: 'zc-popover-menu' });
        input.focus();
    }

    // ------------------------------------------------------------------ mutations

    async function runBusy(fn) {
        if (busy) return false;
        busy = true;
        render(true);
        try {
            return await fn();
        } finally {
            busy = false;
            await refreshAfterMutation();
        }
    }

    /** 分支操作返回了最新状态，先把分支名更新掉，不必等完整刷新。 */
    function adoptBranch(data, targetWorkspace) {
        if (targetWorkspace && workspace?.id !== targetWorkspace.id) return;
        if (!data?.status?.branch || !summary) return;
        summary = { ...summary, branch: data.status.branch };
        render(true);
    }

    async function switchBranch(name) {
        const targetWorkspace = workspace;
        let blocked = null;
        const ok = await runBusy(async () => {
            const res = await api.gitSwitchBranch(targetWorkspace.id, name);
            const data = res?.data;
            if (res?.success && data?.ok !== false) {
                adoptBranch(data, targetWorkspace);
                toast(`已切换到分支 ${name}`, 'success');
                return true;
            }
            const message = data?.issues?.[0]?.message || res?.error || '';
            blocked = parseSwitchBlockedFiles(message);
            if (!blocked) toast(`分支操作失败：${message || '切换分支失败，请稍后重试。'}`, 'error');
            return false;
        });
        if (blocked && workspace?.id === targetWorkspace.id) openSwitchBlockedDialog(name, blocked);
        return ok;
    }

    async function createBranch(name) {
        const targetWorkspace = workspace;
        return runBusy(async () => {
            const res = await api.gitCreateBranch(targetWorkspace.id, name, '');
            const data = res?.data;
            if (!res?.success || data?.ok === false) {
                const message = data?.issues?.[0]?.message || res?.error || '创建分支失败';
                throw new Error(message);
            }
            adoptBranch(data, targetWorkspace);
            toast(`已创建并切换到分支 ${name}`, 'success');
            return true;
        });
    }

    async function pushCurrent(targetWorkspace = workspace) {
        if (!targetWorkspace || workspace?.id !== targetWorkspace.id) throw new Error('工作区已切换，请重新打开操作。');
        const hasUpstream = Boolean(summary?.branch?.upstream);
        let res = await api.gitPush(targetWorkspace.id, hasUpstream ? {} : { setUpstream: true });
        if (!res?.success && res?.code === 'NO_UPSTREAM') res = await api.gitPush(targetWorkspace.id, { setUpstream: true });
        if (!res?.success) throw new Error(describeIssue(res));
    }

    function canPush() {
        const branch = summary?.branch;
        if (!branch || branch.detached) return false;
        return (Number(branch.ahead) || 0) > 0 || !branch.upstream;
    }

    async function stageAll(status, targetWorkspace = workspace) {
        const paths = uniquePaths(status?.changes);
        if (!paths.length) return;
        const staged = await api.gitStage(targetWorkspace.id, paths);
        if (!staged?.success) throw new Error(describeIssue(staged));
    }

    // ------------------------------------------------------------------ dialogs

    function dialogButtons(...buttons) {
        return h('div', 'zc-dialog-footer', ...buttons);
    }

    function openCreateBranchDialog() {
        let name = '';
        let pending = false;
        const modal = openModal({ className: 'zc-dialog-lg' });
        const input = h('input', 'zc-input');
        input.type = 'text';
        input.id = 'zc-create-branch-input';
        input.placeholder = '例如 feature/git-branch-switcher';
        const error = h('p', 'zc-field-error');
        error.hidden = true;
        const cancel = button('zc-btn zc-btn-secondary zc-btn-xl', { onClick: modal.close }, '取消');
        const submit = button('zc-btn zc-btn-primary zc-btn-xl', { type: 'submit', disabled: true }, '创建并切换');
        const form = h('form', 'zc-dialog-form',
            h('div', 'zc-field',
                (() => { const l = h('label', 'zc-field-label', '分支名'); l.htmlFor = 'zc-create-branch-input'; return l; })(),
                input,
                h('p', 'zc-field-help', '首版只支持基于当前 HEAD 创建并切换。'),
                error),
            dialogButtons(cancel, submit));
        input.addEventListener('input', () => {
            name = input.value;
            submit.disabled = pending || !name.trim();
        });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            pending = true;
            submit.disabled = true;
            cancel.disabled = true;
            submit.prepend(spinner());
            error.hidden = true;
            try {
                await createBranch(name.trim());
                modal.close();
            } catch (e) {
                pending = false;
                cancel.disabled = false;
                submit.disabled = !name.trim();
                submit.querySelector('.zc-spin')?.remove();
                error.textContent = e?.message || '分支操作失败';
                error.hidden = false;
            }
        });
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '创建并检出新分支'),
                h('p', 'zc-dialog-description', '基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。')),
            form);
        input.focus();
    }

    function openSwitchBlockedDialog(target, { files, untracked }) {
        const modal = openModal({ className: 'zc-dialog-lg' });
        const list = h('ul', 'zc-file-list', ...files.slice(0, 8).map(file => h('li', 'zc-file-list-item', file)));
        if (files.length > 8) list.appendChild(h('li', 'zc-file-list-more', `等另外 ${files.length - 8} 个文件`));
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '提交更改以切换分支'),
                h('p', 'zc-dialog-description', untracked ? '以下未跟踪文件会被检出操作覆盖：' : '你对以下文件的更改将被检出操作覆盖：')),
            h('div', 'zc-dialog-form',
                h('div', 'zc-field', h('div', 'zc-field-label', '受影响文件'), list,
                    h('p', 'zc-field-help', '请先提交当前更改，再继续切换分支。')),
                dialogButtons(
                    button('zc-btn zc-btn-secondary zc-btn-xl', { onClick: modal.close }, '取消'),
                    button('zc-btn zc-btn-primary zc-btn-xl', { onClick: () => { modal.close(); openSwitchCommitDialog(target); } }, '提交并切换分支...'))));
    }

    async function openSwitchCommitDialog(target) {
        const targetWorkspace = workspace;
        const statusRes = await api.gitStatus(targetWorkspace.id).catch(() => null);
        if (disposed || workspace?.id !== targetWorkspace.id) return;
        const status = statusRes?.success ? statusRes.data : null;
        const paths = uniquePaths([...(status?.staged || []), ...(status?.changes || [])]);
        let message = '';
        let pending = false;
        const modal = openModal({ className: 'zc-dialog-lg' });
        const textarea = h('textarea', 'zc-textarea');
        textarea.rows = 4;
        textarea.placeholder = '留空以自动生成提交消息';
        const error = h('p', 'zc-field-error');
        error.hidden = true;
        const cancel = button('zc-btn zc-btn-secondary zc-btn-xl', { onClick: modal.close }, '取消');
        const submit = button('zc-btn zc-btn-primary zc-btn-xl', { type: 'submit', disabled: !paths.length }, '提交并切换分支');
        const summaryRow = (label, value) => h('div', 'zc-info-row', h('div', 'zc-info-label', label), h('div', 'zc-info-value', value));
        const form = h('form', 'zc-dialog-form',
            h('div', 'zc-info-card',
                summaryRow('当前分支', branchLabel()),
                summaryRow('目标分支', target),
                summaryRow('更改', `${paths.length} 个文件`)),
            h('div', 'zc-field', h('label', 'zc-field-label', '提交消息'), textarea, error),
            dialogButtons(cancel, submit));
        textarea.addEventListener('input', () => { message = textarea.value; });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (pending) return;
            pending = true;
            submit.disabled = true;
            cancel.disabled = true;
            submit.prepend(spinner());
            error.hidden = true;
            try {
                await stageAll(status, targetWorkspace);
                if (modal.closed || workspace?.id !== targetWorkspace.id) return;
                const commitRes = await api.gitCommit(targetWorkspace.id, { message: message.trim() || buildCommitMessage(paths) });
                if (!commitRes?.success) throw new Error(describeIssue(commitRes));
                if (modal.closed || workspace?.id !== targetWorkspace.id) return;
                const res = await api.gitSwitchBranch(targetWorkspace.id, target);
                if (!res?.success || res?.data?.ok === false) throw new Error(res?.data?.issues?.[0]?.message || res?.error || '切换分支失败');
                adoptBranch(res.data, targetWorkspace);
                toast(`已切换到分支 ${target}`, 'success');
                modal.close();
                refreshAfterMutation();
            } catch (e) {
                pending = false;
                cancel.disabled = false;
                submit.disabled = false;
                submit.querySelector('.zc-spin')?.remove();
                error.textContent = `提交失败：${e?.message || e}`;
                error.hidden = false;
            }
        });
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '提交更改'),
                h('p', 'zc-dialog-description', `提交完成后会自动继续切换到 ${target}。`)),
            form);
        textarea.focus();
    }

    async function openCommitDialog() {
        const targetWorkspace = workspace;
        if (!workspace || !summary) return;
        const modal = openModal({ className: 'zc-commit-dialog' });
        modal.dialog.appendChild(h('div', 'zc-commit-loading', spinner()));

        let status = null;
        try {
            const res = await api.gitStatus(targetWorkspace.id);
            status = res?.success ? res.data : null;
        } catch (_e) { /* fallthrough */ }
        if (modal.closed || disposed || workspace?.id !== targetWorkspace.id) return;
        if (!status) {
            modal.close();
            toast('读取 Git 状态失败', 'error');
            return;
        }

        const state = {
            message: '',
            includeUnstaged: uniquePaths(status.changes).length > 0,
            selected: 'commit',
            pending: false,
            error: ''
        };
        const shortcut = formatShortcutLabel(isMac);
        const numberOf = value => new Intl.NumberFormat('zh-CN').format(value);
        const selectedPaths = () => uniquePaths([...(status.staged || []), ...(state.includeUnstaged ? status.changes || [] : [])]);
        const hasUnstaged = () => uniquePaths(status.changes).length > 0;

        // --- 静态骨架：状态变化只更新局部，避免输入框失焦
        const headerRow = h('div', 'zc-commit-head');
        const counts = h('div', 'zc-commit-counts');
        const textarea = h('textarea', 'zc-commit-textarea');
        textarea.id = 'zc-commit-message';
        textarea.placeholder = '提交信息（留空将自动生成）';
        textarea.setAttribute('aria-label', '提交消息');
        const generate = button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-commit-generate', { label: '生成提交消息' }, icon('sparkles'));
        const checkbox = h('button', 'zc-checkbox-row');
        checkbox.type = 'button';
        checkbox.setAttribute('role', 'checkbox');
        const checkBox = h('span', 'zc-checkbox-box', icon('check'));
        const checkCount = h('span', 'zc-checkbox-count');
        checkbox.append(h('span', 'zc-checkbox-slot', checkBox), h('span', 'zc-checkbox-label', '包含未暂存的更改'), checkCount);
        const errorLine = h('p', 'zc-commit-error');
        const actionsBox = h('div', 'zc-command-list zc-commit-actions');
        actionsBox.tabIndex = 0;
        actionsBox.setAttribute('aria-label', '提交或推送');

        const actionDefs = () => {
            const noChanges = !selectedPaths().length;
            return [
                { id: 'commit', icon: 'git-commit-horizontal', label: '提交', disabled: state.pending || noChanges, run: () => submitCommit(false) },
                { id: 'commitAndPush', icon: 'cloud-upload', label: '提交并推送', disabled: state.pending || noChanges, run: () => submitCommit(true) },
                { id: 'push', icon: 'cloud-upload', label: '推送', disabled: state.pending || !canPush(), run: () => { modal.close(); openPushDialog(); } }
            ];
        };

        const sync = () => {
            const paths = selectedPaths();
            counts.textContent = '';
            counts.append(h('span', 'zc-added', `+${numberOf(summary.added || 0)}`), h('span', 'zc-removed', `-${numberOf(summary.removed || 0)}`));
            textarea.disabled = state.pending;
            generate.disabled = state.pending || !paths.length;
            checkbox.setAttribute('aria-checked', String(state.includeUnstaged));
            checkbox.disabled = state.pending || !hasUnstaged();
            checkBox.classList.toggle('is-checked', state.includeUnstaged);
            checkCount.textContent = `${numberOf(paths.length)} 个文件`;
            errorLine.textContent = state.error;
            errorLine.hidden = !state.error;

            const defs = actionDefs();
            const current = defs.find(def => def.id === state.selected);
            if (!current || current.disabled) {
                const first = defs.find(def => !def.disabled);
                if (first) state.selected = first.id;
            }
            actionsBox.textContent = '';
            for (const def of defs) {
                const item = h('div', 'zc-command-item zc-commit-action',
                    h('span', 'zc-action-icon', state.pending && def.id !== 'push' ? spinner() : icon(def.icon)),
                    h('span', 'zc-action-label', def.label),
                    state.selected === def.id ? h('span', 'zc-command-shortcut', shortcut) : null);
                item.dataset.action = def.id;
                if (def.disabled) item.dataset.disabled = 'true';
                if (state.selected === def.id) item.dataset.selected = 'true';
                item.addEventListener('mousemove', () => {
                    if (!def.disabled && state.selected !== def.id) { state.selected = def.id; sync(); }
                });
                item.addEventListener('click', () => { if (!def.disabled) def.run(); });
                actionsBox.appendChild(item);
            }
        };

        const selectAdjacent = direction => {
            const enabled = actionDefs().filter(def => !def.disabled);
            if (!enabled.length) return;
            const index = enabled.findIndex(def => def.id === state.selected);
            state.selected = enabled[(index === -1 ? 0 : (index + direction + enabled.length) % enabled.length)].id;
            sync();
        };

        async function submitCommit(andPush) {
            if (state.pending) return;
            const paths = selectedPaths();
            if (!paths.length) { state.error = '当前没有可提交的更改。'; sync(); return; }
            state.pending = true;
            state.error = '';
            sync();
            let committed = false;
            try {
                if (state.includeUnstaged) await stageAll(status, targetWorkspace);
                if (modal.closed || workspace?.id !== targetWorkspace.id) return;
                const message = state.message.trim() || buildCommitMessage(paths);
                const res = await api.gitCommit(targetWorkspace.id, { message });
                if (!res?.success) throw new Error(describeIssue(res));
                committed = true;
                if (andPush) await pushCurrent(targetWorkspace);
                toast(andPush ? '已提交并推送当前更改' : '已提交当前更改', 'success');
                modal.close();
                refreshAfterMutation();
            } catch (e) {
                state.pending = false;
                state.error = committed ? `已提交，但推送失败：${e?.message || e}` : `提交失败：${e?.message || e}`;
                sync();
                if (committed) refreshAfterMutation();
            }
        }

        textarea.addEventListener('input', () => { state.message = textarea.value; });
        generate.addEventListener('click', () => {
            state.message = buildCommitMessage(selectedPaths());
            textarea.value = state.message;
            textarea.focus();
        });
        checkbox.addEventListener('click', () => { state.includeUnstaged = !state.includeUnstaged; sync(); });
        actionsBox.addEventListener('keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            selectAdjacent(event.key === 'ArrowDown' ? 1 : -1);
        });

        const form = h('form', 'zc-commit-form');
        form.addEventListener('submit', event => event.preventDefault());
        form.addEventListener('keydown', event => {
            if (event.target === textarea && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                event.stopPropagation();
                selectAdjacent(event.key === 'ArrowDown' ? 1 : -1);
                return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.stopPropagation();
                const def = actionDefs().find(item => item.id === state.selected);
                if (def && !def.disabled) def.run();
            }
        });

        headerRow.append(branchTrigger({
            className: 'zc-branch-trigger-sm',
            popoverClass: 'zc-popover-w80',
            side: 'bottom',
            footer: false,
            onAfterSwitch: () => { modal.close(); }
        }), counts);
        form.append(
            headerRow,
            h('div', 'zc-commit-message', h('div', 'zc-commit-message-wrap', textarea, generate)),
            h('div', 'zc-commit-include', checkbox),
            h('div', 'zc-commit-actions-wrap', errorLine, actionsBox));

        modal.dialog.textContent = '';
        modal.dialog.appendChild(form);
        sync();
        textarea.focus();
    }

    function openPushDialog() {
        const targetWorkspace = workspace;
        if (!workspace || !summary) return;
        const branch = summary.branch || {};
        const ahead = Number(branch.ahead) || 0;
        const behind = Number(branch.behind) || 0;
        const tracked = Boolean(branch.upstream);
        const pushEnabled = canPush();
        const modal = openModal({ className: 'zc-dialog-lg' });
        let pending = false;
        let errorText = '';

        const body = h('div', 'zc-dialog-form');
        const footer = dialogButtons();

        const infoRow = (label, value, extra = '') => h('div', `zc-info-row ${extra}`.trim(), h('div', 'zc-info-label', label), h('div', 'zc-info-value', value));

        const paint = () => {
            body.textContent = '';
            footer.textContent = '';
            if (!errorText) {
                body.appendChild(h('div', 'zc-info-card',
                    h('div', 'zc-info-row zc-info-row-top', h('div', 'zc-info-label', '分支'),
                        h('div', 'zc-info-value zc-info-branch', icon('git-branch', 'zc-subtle'), h('span', '', branchLabel()))),
                    h('div', 'zc-info-section',
                        infoRow('远程分支', tracked ? branch.upstream : '首次推送会自动为当前分支建立上游分支。'),
                        infoRow('同步状态', `领先 ${ahead} / 落后 ${behind}`),
                        h('div', 'zc-info-row zc-info-row-divider', h('div', 'zc-info-label', '后续步骤'),
                            h('div', 'zc-info-value zc-info-next', icon('arrow-up-from-line'), h('span', '', '推送'))))));
            }
            if (!pushEnabled && !errorText) {
                body.appendChild(h('div', 'zc-warning-banner', icon('circle-alert'), h('span', '', '当前分支没有需要推送的提交。')));
            }
            if (errorText) {
                const area = h('textarea', 'zc-textarea zc-error-details');
                area.readOnly = true;
                area.value = errorText;
                const copy = button('zc-btn zc-btn-ghost zc-btn-sm zc-copy-error', {}, '复制错误信息');
                copy.addEventListener('click', async () => {
                    try {
                        await win.navigator.clipboard.writeText(errorText);
                        copy.textContent = '已复制';
                        win.setTimeout(() => { copy.textContent = '复制错误信息'; }, 1500);
                    } catch (e) {
                        toast(`复制错误信息失败：${e?.message || e}`, 'error');
                    }
                });
                body.append(
                    h('div', 'zc-warning-banner', icon('circle-alert'), h('span', '', '推送失败，请检查错误详情。')),
                    h('div', 'zc-field', h('div', 'zc-error-head', h('div', 'zc-field-label', '错误详情'), copy), area));
                footer.appendChild(button('zc-btn zc-btn-primary zc-btn-xl', { onClick: modal.close }, '关闭'));
            } else {
                const submit = button('zc-btn zc-btn-primary zc-btn-xl', { disabled: pending || !pushEnabled }, pending ? spinner() : null, '推送');
                submit.addEventListener('click', async () => {
                    pending = true;
                    paint();
                    try {
                        if (!modal.dialog.isConnected || workspace?.id !== targetWorkspace.id) return;
                        await pushCurrent(targetWorkspace);
                        toast(`已推送到 ${tracked ? branch.upstream : (summary.remotes?.[0] || 'origin')}`, 'success');
                        modal.close();
                        refreshAfterMutation();
                    } catch (e) {
                        pending = false;
                        errorText = e?.message || String(e);
                        paint();
                    }
                });
                footer.append(button('zc-btn zc-btn-secondary zc-btn-xl', { disabled: pending, onClick: modal.close }, '取消'), submit);
            }
        };
        paint();
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '推送更改'),
                h('p', 'zc-dialog-description', tracked ? '将当前分支最新提交推送到远程分支。' : '首次推送会把当前分支发布到远程并设置 upstream。')),
            h('div', 'zc-dialog-body', body, footer));
    }

    function svg(tag, attrs = {}) {
        const node = doc.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        return node;
    }

    async function openGitGraphDialog() {
        const targetWorkspace = workspace;
        if (!workspace) return;
        const modal = openModal({ className: 'zc-graph-dialog' });
        modal.dialog.appendChild(h('div', 'zc-graph-loading', spinner()));
        let commits = [];
        let hasMore = false;
        let selectedHash = null;
        let expandedHash = null;
        let loadingMore = false;
        let refreshing = false;
        const closeBtn = button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-graph-close', { label: '关闭', onClick: modal.close }, icon('x'));

        const fetchPage = async skip => {
            const res = await api.gitCommitGraph(targetWorkspace.id, { maxCount: GRAPH_PAGE_SIZE, skip });
            if (!res?.success) throw new Error(describeIssue(res));
            return res.data;
        };

        const paint = () => {
            modal.dialog.textContent = '';
            const layout = layoutGitGraph(commits);
            const graphWidth = Math.max(56, layout.width + 12);
            const head = h('div', 'zc-graph-head',
                h('div', 'zc-graph-title-row', icon('git-graph', 'zc-graph-title-icon'), h('h2', 'zc-graph-title', 'Git 图谱')),
                h('p', 'zc-graph-subtitle', `${hasMore ? '最近 ' : ''}${commits.length} 个提交，${layout.laneCount} 条泳道`));
            const refreshBtn = button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-graph-refresh', { label: '刷新 Git 图谱', disabled: refreshing }, icon('refresh-cw', refreshing ? 'zc-spin' : ''));
            refreshBtn.addEventListener('click', async () => {
                if (refreshing) return;
                refreshing = true;
                paint();
                try {
                    const page = await fetchPage(0);
                    commits = page.commits;
                    hasMore = page.hasMore;
                    selectedHash = commits[0]?.hash ?? null;
                } catch (e) {
                    toast(`刷新 Git 图谱失败：${e?.message || e}`, 'error');
                }
                refreshing = false;
                paint();
            });
            head.appendChild(refreshBtn);
            modal.dialog.append(closeBtn, head);

            if (!commits.length) {
                modal.dialog.appendChild(h('div', 'zc-graph-empty',
                    icon('git-graph', 'zc-graph-empty-icon'),
                    h('p', 'zc-graph-empty-title', '暂无提交'),
                    h('p', 'zc-graph-empty-desc', '当前仓库还没有提交历史。')));
                return;
            }

            const columns = 'minmax(0, 1fr) 96px 120px 72px';
            const svgHeight = layout.height + layout.rowHeight;
            const graphSvg = svg('svg', { class: 'zc-graph-svg', width: graphWidth, height: svgHeight, viewBox: `0 0 ${graphWidth} ${svgHeight}`, role: 'img', 'aria-label': 'Git 提交图' });
            for (const path of layout.paths) {
                graphSvg.appendChild(svg('path', { d: path.path, class: `zc-graph-path zc-lane-${LANE_COLORS[path.laneIndex % LANE_COLORS.length]}` }));
            }
            for (const row of layout.rows) {
                const selected = row.commit.hash === selectedHash;
                const lane = LANE_COLORS[row.laneIndex % LANE_COLORS.length];
                graphSvg.appendChild(svg('circle', { cx: row.x, cy: row.y, r: selected ? SELECTED_NODE_RADIUS : NODE_RADIUS, class: `zc-graph-node zc-lane-fill-${lane}` }));
                if (selected) graphSvg.appendChild(svg('circle', { cx: row.x, cy: row.y, r: SELECTED_RING_RADIUS, class: `zc-graph-ring zc-lane-${lane}` }));
            }

            const rows = h('div', 'zc-graph-rows');
            for (const row of layout.rows) {
                const commit = row.commit;
                const selected = commit.hash === selectedHash;
                const refs = parseGraphRefs(commit.refs);
                const line = button(`zc-graph-row${selected ? ' is-selected' : ''}`, {},
                    h('span', 'zc-graph-cell zc-graph-desc',
                        refs.length ? h('span', 'zc-graph-refs', ...refs.slice(0, 4).map(ref =>
                            h('span', `zc-ref zc-ref-${ref.kind}`, icon(ref.kind === 'tag' ? 'tag' : 'git-branch', 'zc-ref-icon'), h('span', 'zc-ref-name', ref.name)))) : null,
                        h('span', 'zc-graph-subject', commit.subject || commit.hash.slice(0, 7)),
                        commit.parents.length > 1 ? icon('git-merge', 'zc-graph-merge') : null),
                    h('span', 'zc-graph-cell zc-graph-date', formatCommitTime(commit.time)),
                    h('span', 'zc-graph-cell zc-graph-author', commit.author),
                    h('span', 'zc-graph-cell zc-graph-hash', commit.hash.slice(0, 7)));
                line.style.gridTemplateColumns = columns;
                line.style.height = `${layout.rowHeight}px`;
                line.addEventListener('click', () => {
                    selectedHash = commit.hash;
                    expandedHash = expandedHash === commit.hash ? null : commit.hash;
                    paint();
                });
                rows.appendChild(line);
            }
            if (hasMore) {
                const more = button('zc-graph-load-more', { disabled: loadingMore }, loadingMore ? '正在加载...' : '加载更多提交');
                more.addEventListener('click', async () => {
                    if (loadingMore) return;
                    loadingMore = true;
                    paint();
                    try {
                        const page = await fetchPage(commits.length);
                        commits = [...commits, ...page.commits];
                        hasMore = page.hasMore;
                    } catch (e) {
                        toast(`Git 图谱加载失败：${e?.message || e}`, 'error');
                    }
                    loadingMore = false;
                    paint();
                });
                rows.appendChild(h('div', 'zc-graph-more', more));
            }

            const table = h('div', 'zc-graph-table');
            table.style.gridTemplateColumns = `minmax(56px, ${graphWidth}px) minmax(0, 1fr)`;
            const headCells = h('div', 'zc-graph-columns');
            headCells.style.gridTemplateColumns = columns;
            headCells.append(h('div', 'zc-graph-col', '描述'), h('div', 'zc-graph-col', '日期'), h('div', 'zc-graph-col', '作者'), h('div', 'zc-graph-col', '提交'));
            const graphCol = h('div', 'zc-graph-lane-col', graphSvg);
            graphCol.style.height = `${svgHeight}px`;
            table.append(h('div', 'zc-graph-col zc-graph-col-first', '图'), headCells, graphCol, rows);
            modal.dialog.appendChild(h('div', 'zc-graph-scroll', table));

            const expanded = commits.find(commit => commit.hash === expandedHash);
            if (expanded) {
                const refs = parseGraphRefs(expanded.refs);
                const cell = (label, value, mono) => h('div', 'zc-detail-cell', h('div', 'zc-detail-label', label), h('div', `zc-detail-value${mono ? ' zc-mono' : ''}`, value || '-'));
                modal.dialog.appendChild(h('div', 'zc-graph-detail',
                    h('div', 'zc-detail-subject', expanded.subject || expanded.hash.slice(0, 7)),
                    refs.length ? h('div', 'zc-detail-refs', ...refs.map(ref => h('span', `zc-ref zc-ref-${ref.kind}`, icon(ref.kind === 'tag' ? 'tag' : 'git-branch', 'zc-ref-icon'), h('span', 'zc-ref-name', ref.name)))) : null,
                    h('div', 'zc-detail-grid',
                        cell('提交', expanded.hash, true),
                        cell('作者', expanded.author),
                        cell('日期', formatCommitTime(expanded.time)),
                        cell('父提交', expanded.parents.map(p => p.slice(0, 7)).join(', '), true))));
            }
        };

        try {
            const page = await fetchPage(0);
            commits = page.commits;
            hasMore = page.hasMore;
            selectedHash = commits[0]?.hash ?? null;
            if (modal.closed || disposed || workspace?.id !== targetWorkspace.id) return;
            paint();
        } catch (e) {
            if (modal.closed) return;
            modal.dialog.textContent = '';
            modal.dialog.append(closeBtn, h('div', 'zc-graph-error',
                h('div', 'zc-graph-error-card', icon('circle-alert', 'zc-warning'), h('p', '', `Git 图谱加载失败：${e?.message || e}`))));
        }
    }

    // ------------------------------------------------------------------ panel rendering

    function sectionHeader(key, title, trailing, extra) {
        const open = sectionOpen[key];
        const trigger = button('zc-section-trigger', {},
            h('span', 'zc-section-title', title),
            icon(open ? 'chevron-down' : 'chevron-right', 'zc-chevron'));
        trigger.setAttribute('aria-expanded', String(open));
        trigger.dataset.statusSectionTrigger = key;
        trigger.addEventListener('click', () => { sectionOpen[key] = !sectionOpen[key]; render(true); });
        const row = h('div', 'zc-section-header', trigger);
        const trail = trailing?.(open);
        if (trail) row.appendChild(h('div', 'zc-section-trailing', trail));
        if (extra) row.appendChild(extra);
        return row;
    }

    function rowButton({ iconName, label, trailing = null, disabled = false, onClick = null, className = '' }) {
        const btn = button(`zc-row ${className}`.trim(), { disabled, onClick },
            icon(iconName, 'zc-row-icon'), h('span', 'zc-row-label', label), trailing);
        return btn;
    }

    function renderGitSection() {
        const git = summary;
        const hasChanges = (git.added || 0) + (git.removed || 0) > 0;
        const primaryPush = !git.files && canPush();
        const primaryDisabled = busy || (!git.files && !canPush());

        const body = h('div', 'zc-section-body zc-git-rows');
        body.append(
            rowButton({
                iconName: 'file-diff',
                label: '更改',
                trailing: diffCounts(git.added || 0, git.removed || 0),
                disabled: !onOpenGitTab,
                onClick: () => onOpenGitTab?.()
            }),
            branchTrigger({ className: 'zc-row zc-row-branch', popoverClass: 'zc-popover-w72', side: 'left', footer: true }),
            rowButton({
                iconName: busy ? 'loader-circle' : (primaryPush ? 'arrow-up-from-line' : 'git-commit-horizontal'),
                label: '提交或推送',
                disabled: primaryDisabled,
                className: 'zc-row-commit',
                onClick: () => (primaryPush ? openPushDialog() : openCommitDialog())
            }));
        const section = h('section', 'zc-section');
        section.dataset.statusSection = 'environment';
        section.appendChild(sectionHeader('git', 'Git 工具', open => (open ? null : h('span', 'zc-diff-inline',
            h('span', `zc-added${hasChanges ? '' : ' is-dim'}`, `+${git.added || 0}`), ' ',
            h('span', `zc-removed${hasChanges ? '' : ' is-dim'}`, `-${git.removed || 0}`)))));
        if (sectionOpen.git) section.appendChild(body);
        return section;
    }

    function recentCommandRuns() {
        const cutoff = Date.now() - RECENT_RUN_WINDOW_MS;
        return commandRuns
            .filter(run => !scoped || scope.commands.has(normalizeCommand(run.command)))
            .filter(run => run.status === 'running' || (run.endedAt || run.startedAt) >= cutoff)
            .slice(0, MAX_RUN_ROWS);
    }

    function renderRunsSection() {
        const runs = recentCommandRuns();
        const running = runs.filter(run => run.status === 'running').length;
        const body = h('div', 'zc-section-body zc-git-rows');
        for (const run of runs) {
            const failed = run.status === 'cancelled' || run.status === 'timed_out' || run.status === 'spawn_error';
            const iconName = run.status === 'running' ? 'loader-circle' : (failed ? 'circle-x' : 'circle');
            const row = rowButton({
                iconName,
                label: String(run.command || '').replace(/\s+/g, ' ').trim(),
                disabled: !onOpenToolOutput,
                onClick: () => onOpenToolOutput?.(run)
            });
            row.title = `${run.command}\n按命令文本关联，可能来自其他话题。${run.status === 'completed' ? '已结束，退出码未知。' : ''}`;
            row.dataset.runId = run.id;
            row.dataset.runStatus = run.status;
            body.appendChild(row);
        }
        const section = h('section', 'zc-section');
        section.dataset.statusSection = 'runs';
        section.appendChild(sectionHeader('runs', '命令（文本关联）',
            () => h('span', 'zc-tabular zc-subtle', running ? `${running} 运行中` : `${runs.length}`)));
        if (sectionOpen.runs) section.appendChild(body);
        return section;
    }

    function planStatusIcon(item) {
        if (item.status === 'completed') return icon('circle-check-big', 'zc-plan-icon zc-success');
        if (item.status === 'inProgress') return icon('arrow-right', 'zc-plan-icon zc-fg');
        return icon(item.blocked ? 'circle-alert' : 'circle', 'zc-plan-icon zc-subtlest');
    }

    function planItemRows(items) {
        return items.map(item => {
            const row = h('li', 'zc-plan-item',
                planStatusIcon(item),
                h('span', `zc-plan-text${item.status === 'completed' ? ' is-done' : ''}`, item.content));
            row.dataset.planStatus = item.status;
            row.title = item.blocked ? `${item.content}（受阻）` : item.content;
            return row;
        });
    }

    function hiddenGroup(group, items) {
        const allDone = items.every(item => item.status === 'completed');
        const allPending = items.every(item => item.status === 'pending');
        const label = group === 'preceding'
            ? (allDone ? `已完成 ${items.length} 项` : `前面 ${items.length} 项`)
            : (allPending ? `待处理 ${items.length} 项` : `后面 ${items.length} 项`);
        const trigger = button('zc-todo-fold', {}, icon('chevron-left', 'zc-fold-icon'), h('span', 'zc-fold-label', label));
        trigger.dataset.statusTodoPreviewTrigger = group;
        let entry = null;
        let openTimer = null;
        let closeTimer = null;
        const show = () => {
            win.clearTimeout(closeTimer);
            if (entry) return;
            openTimer = win.setTimeout(() => {
                const card = h('div', 'zc-hover-card',
                    h('p', 'zc-hover-card-title', label),
                    h('ul', 'zc-plan-list', ...planItemRows(items)));
                card.dataset.statusTodoPreviewContent = group;
                card.addEventListener('mouseenter', () => win.clearTimeout(closeTimer));
                card.addEventListener('mouseleave', hide);
                entry = openPopover(card, trigger, { side: 'left', className: 'zc-popover-card', hover: true, onClose: () => { entry = null; } });
            }, 120);
        };
        const hide = () => {
            win.clearTimeout(openTimer);
            closeTimer = win.setTimeout(() => { if (entry) closePopover(entry); }, 80);
        };
        trigger.addEventListener('mouseenter', show);
        trigger.addEventListener('mouseleave', hide);
        trigger.addEventListener('focus', show);
        trigger.addEventListener('blur', hide);
        return h('li', '', trigger);
    }

    function renderPlanSection() {
        const items = plan.items;
        const completed = items.filter(item => item.status === 'completed').length;
        const isCompleted = items.length > 0 && completed >= items.length;
        const focus = getTodoFocusWindow(items);
        const list = h('ul', 'zc-plan-list');
        if (focus.compact && focus.precedingItems.length) list.appendChild(hiddenGroup('preceding', focus.precedingItems));
        planItemRows(focus.focusItems).forEach(row => list.appendChild(row));
        if (focus.compact && focus.followingItems.length) list.appendChild(hiddenGroup('following', focus.followingItems));

        const openForge = onOpenProjectForge
            ? button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-section-action', { label: '在 V工程 中查看与回退', onClick: () => onOpenProjectForge() }, icon('folder-open'))
            : null;
        if (openForge) openForge.title = `${plan.project?.name || 'V工程'} · 在 V工程 中查看与回退`;
        const openDetail = onOpenPlanDetail
            ? button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-section-action', { label: '在侧栏中查看计划详情', onClick: () => onOpenPlanDetail(plan.project) }, icon('checklist'))
            : null;
        if (openDetail) openDetail.title = `${plan.project?.name || 'V工程'} · 在侧栏中查看计划详情`;
        let sectionExtra = openForge;
        if (openDetail && openForge) {
            sectionExtra = h('div', 'zc-section-actions', openDetail, openForge);
        } else if (openDetail) {
            sectionExtra = openDetail;
        }

        const section = h('section', 'zc-section');
        section.dataset.statusSection = 'plan';
        section.appendChild(sectionHeader('plan', '进程',
            () => h('span', `zc-tabular${isCompleted ? ' zc-success' : ' zc-subtle'}`, `${completed}/${items.length}`), sectionExtra));
        if (sectionOpen.plan) section.appendChild(h('div', 'zc-section-body zc-scroll-plan', list));
        return section;
    }

    function renderMini() {
        const metric = pickMiniMetric({ items: plan?.items || [], git: summary });
        if (!metric) return null;
        const iconWrap = h('span', 'zc-mini-icon',
            h('span', 'zc-mini-icon-base', icon(metric.icon, metric.success ? 'zc-success' : (metric.kind === 'todo' ? 'zc-subtle' : 'zc-fg'))),
            icon('maximize-2', 'zc-mini-icon-expand'));
        const btn = button('zc-mini', { label: '展开状态', onClick: () => setVariant('panel') },
            h('span', 'zc-mini-metric', iconWrap, h('span', 'zc-mini-text', metric.text),
                metric.count ? h('span', 'zc-subtle', metric.count) : null,
                metric.added !== undefined ? h('span', 'zc-added', `+${metric.added}`) : null,
                metric.removed !== undefined ? h('span', 'zc-removed', `-${metric.removed}`) : null));
        btn.title = '展开状态';
        return btn;
    }

    function setVariant(next) {
        variantOverride = next;
        try { storage?.setItem(STORAGE_KEY_VARIANT, next); } catch (_e) { /* ignore */ }
        render(true);
    }

    function currentVariant() {
        return resolveVariant({ override: variantOverride, width: hostWidth });
    }

    function render(force = false) {
        if (disposed) return;
        const hasGit = Boolean(summary?.branch);
        const hasPlan = Boolean(plan?.items?.length);
        const shownRuns = recentCommandRuns();
        const hasRuns = shownRuns.length > 0;
        const variant = currentVariant();
        const key = JSON.stringify({
            scope: scopeKey, ws: workspaces.length, hasWs: Boolean(workspace), hasGit, hasPlan, hasRuns, variant, busy, sectionOpen,
            runs: shownRuns.map(run => [run.id, run.status, run.command]),
            summary: summary && { f: summary.files, a: summary.added, r: summary.removed, b: summary.branch },
            plan: plan && { p: plan.project?.id, i: plan.items }
        });
        if (!force && key === renderKey) return;
        renderKey = key;

        if (!hasGit && !hasPlan && !hasRuns) {
            closeAllPopovers();
            aside.textContent = '';
            // 跟随会话时，这个会话没有 V工程 / 命令就没有可显示的状态：整块隐藏，不拿别的会话的内容占位
            if (!onOpenGitTab || scoped) { layer.hidden = true; return; }
            const entry = pickEntryMetric({ workspaceCount: workspaces.length, hasWorkspace: Boolean(workspace) });
            layer.hidden = false;
            aside.dataset.displayMode = 'mini';
            aside.dataset.state = 'entry';
            const btn = button('zc-mini zc-mini-entry', { label: entry.hint, onClick: () => onOpenGitTab() },
                h('span', 'zc-mini-metric', h('span', 'zc-mini-icon', icon(entry.icon, 'zc-subtle')), h('span', 'zc-mini-text', entry.text)));
            btn.title = entry.hint;
            aside.appendChild(btn);
            return;
        }
        closeAllPopovers();
        layer.hidden = false;
        aside.textContent = '';
        aside.dataset.displayMode = variant;
        aside.dataset.state = variant === 'mini' ? 'collapsed' : 'expanded';

        if (variant === 'mini') {
            const mini = renderMini();
            if (!mini) { layer.hidden = true; return; }
            aside.appendChild(mini);
            return;
        }
        aside.appendChild(button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-status-collapse',
            { label: '收起为胶囊', onClick: () => setVariant('mini') }, icon('minimize-2')));
        aside.lastChild.title = '收起为胶囊';
        const body = h('div', 'zc-status-body');
        const sections = [];
        if (hasGit) sections.push(renderGitSection());
        if (hasPlan) sections.push(renderPlanSection());
        if (hasRuns) sections.push(renderRunsSection());
        sections.forEach((section, index) => {
            if (index > 0) section.classList.add('is-separated');
            body.appendChild(section);
        });
        aside.appendChild(body);
    }

    // ------------------------------------------------------------------ mount / dispose

    function measureHost() {
        if (!host) return;
        const header = host.querySelector(':scope > header');
        layer.style.top = `${header ? header.offsetHeight : 0}px`;
        const width = host.clientWidth;
        if (width !== hostWidth) {
            hostWidth = width;
            render();
        }
    }

    function mount() {
        const target = host || doc.querySelector('main.main-content') || doc.querySelector('#nextUiMainPanel');
        if (!target) return null;
        host = target;
        if (win.getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(layer);
        doc.body.appendChild(portal);
        mounted = true;

        on(doc, 'keydown', event => {
            if (event.key !== 'Escape') return;
            if (popovers.length) { closePopover(popovers[popovers.length - 1]); return; }
            if (modals.length) modals[modals.length - 1].close();
        });
        on(win, 'resize', () => { measureHost(); closeAllPopovers(); });
        on(win, 'focus', () => refresh());
        on(win, changeEvent, event => { if (event.detail?.source !== 'status-panel') refresh(); });
        if (typeof win.ResizeObserver === 'function') {
            resizeObserver = new win.ResizeObserver(() => measureHost());
            resizeObserver.observe(host);
            const header = host.querySelector(':scope > header');
            if (header) resizeObserver.observe(header);
        }
        const offForge = api?.onProjectForgeChanged?.(() => { refresh(); });
        if (typeof offForge === 'function') cleanups.push(offForge);
        watchCommandRuns();
        if (scoped) watchConversation();
        pollTimer = win.setInterval(() => { if (!doc.hidden && !busy) refresh(); }, POLL_INTERVAL_MS);

        measureHost();
        refresh();
        return layer;
    }

    // 切换助手 / 话题：先清空上一个会话的内容，再按新会话的聊天记录重新取；
    // 历史是异步载入的，之后聊天区的消息变化（载入、新工具调用）会重新圈定范围。
    function watchConversation() {
        const onSwitched = () => {
            if (disposed) return;
            scope = { projectIds: [], commands: new Set() };
            scopeKey = scopeSignature(scope);
            summary = null;
            plan = null;
            workspace = null;
            closeAllPopovers();
            render();
            refresh();
        };
        const off = onConversationChange?.(onSwitched);
        if (typeof off === 'function') cleanups.push(off);

        let timer = null;
        const rescope = () => {
            timer = null;
            if (disposed) return;
            let next;
            try { next = scopeSignature(collectConversationScope(getHistory())); } catch (_e) { return; }
            if (next !== scopeKey) refresh();
        };
        const root = messagesRoot || doc.getElementById('chatMessages');
        if (root && typeof win.MutationObserver === 'function') {
            const observer = new win.MutationObserver(() => {
                if (timer === null) timer = win.setTimeout(rescope, RESCOPE_DEBOUNCE_MS);
            });
            observer.observe(root, { childList: true, subtree: true });
            cleanups.push(() => { observer.disconnect(); if (timer !== null) win.clearTimeout(timer); });
        }
    }

    async function loadCommandRuns() {
        const res = await api?.terminalListCommandRuns?.();
        if (disposed || !res?.success) return;
        commandRuns = res.data || [];
        render();
    }

    function watchCommandRuns() {
        if (typeof api?.terminalListCommandRuns !== 'function') return;
        const onRunChanged = summary => {
            if (disposed || !summary?.id) return;
            const index = commandRuns.findIndex(run => run.id === summary.id);
            if (index >= 0) commandRuns[index] = { ...commandRuns[index], ...summary };
            else commandRuns = [summary, ...commandRuns];
            render();
        };
        Promise.resolve(api.terminalWatchCommandRuns?.()).catch(() => {});
        const off = api.onTerminalCommandRunChanged?.(onRunChanged);
        if (typeof off === 'function') cleanups.push(off);
        void loadCommandRuns();
    }

    function dispose() {
        disposed = true;
        ++refreshSeq;
        if (pollTimer) win.clearInterval(pollTimer);
        resizeObserver?.disconnect();
        cleanups.splice(0).forEach(fn => { try { fn(); } catch (_e) { /* ignore */ } });
        closeAllPopovers();
        [...modals].forEach(modal => modal.close());
        layer.remove();
        portal.remove();
    }

    return Object.freeze({
        mount,
        dispose,
        refresh,
        openCommitDialog,
        openPushDialog,
        openCreateBranchDialog,
        openGitGraphDialog,
        openBranchSwitcher,
        setVariant,
        layer,
        aside,
        portal,
        get mounted() { return mounted; }
    });
}

export { pickProjectsForWorkspace, mapTodoItems } from './project-plan-model.js';
