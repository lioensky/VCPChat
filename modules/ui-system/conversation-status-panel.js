/**
 * modules/ui-system/conversation-status-panel.js
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

import { createStatusPanelDom } from './conversation-status-panel/dom.js';
import { createStatusPanelFloating } from './conversation-status-panel/floating.js';
import { createStatusPanelGitActions } from './conversation-status-panel/git-actions.js';
import { createStatusPanelBranchDialogs } from './conversation-status-panel/branch-dialogs.js';
import { createStatusPanelCommitDialog } from './conversation-status-panel/commit-dialog.js';
import { createStatusPanelPushDialog } from './conversation-status-panel/push-dialog.js';
import { createStatusPanelGitGraph } from './conversation-status-panel/git-graph.js';
import { createStatusPanelSections } from './conversation-status-panel/sections.js';
import { filterBranches, getTodoFocusWindow, pickMiniMetric, pickEntryMetric, resolveVariant, buildCommitMessage, parseSwitchBlockedFiles, formatShortcutLabel, uniquePaths, formatCommitTime } from './conversation-status-panel/helpers.js';
export { filterBranches, getTodoFocusWindow, pickMiniMetric, pickEntryMetric, resolveVariant, buildCommitMessage, parseSwitchBlockedFiles, formatShortcutLabel } from './conversation-status-panel/helpers.js';
import { layoutGitGraph, parseGraphRefs } from './git-graph-layout.js';
import { pickProjectsForWorkspace, pickTopicProject, mapTodoItems, summarizeTopicBatches } from './project-plan-model.js';
import { collectConversationScope, normalizeCommand, readRevertBatches, scopeSignature } from './conversation-scope.js';

const STORAGE_KEY_WS = 'vcp-projectforge-git-workspace';
const STORAGE_KEY_VARIANT = 'vcp-status-panel-variant';
const POLL_INTERVAL_MS = 15000;
const RESCOPE_DEBOUNCE_MS = 700;

// ------------------------------------------------------------------ component

export function createConversationStatusPanel({
    document: doc = document,
    api = null,
    uiHelper = null,
    host = null,
    onOpenGitTab = null,
    onOpenPlanDetail = null,
    onOpenToolOutput = null,
    // 当前话题在侧栏里的键（getParentKey），用来读侧栏记下的回退批次，让计划概要和侧栏时间线一致
    getTopicKey = null,
    // 话题的工作区换了（切话题，或话题新用上某个 V工程）时通知外面，Git 标签据此跟过去
    onScopeWorkspace = null,
    // 给了 getHistory，面板就跟着当前会话走：
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
    let plan = null; // { items, project, activity }
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



    // ------------------------------------------------------------------ dom helpers

    const store = Object.freeze({
        get workspace() { return workspace; },
        set workspace(value) { workspace = value; },
        get summary() { return summary; },
        set summary(value) { summary = value; },
        get branchList() { return branchList; },
        set branchList(value) { branchList = value; },
        get plan() { return plan; },
        set plan(value) { plan = value; },
        get commandRuns() { return commandRuns; },
        set commandRuns(value) { commandRuns = value; },
        get busy() { return busy; },
        set busy(value) { busy = value; },
        get disposed() { return disposed; },
        set disposed(value) { disposed = value; },
        get refreshSeq() { return refreshSeq; },
        set refreshSeq(value) { refreshSeq = value; },
        get sectionOpen() { return sectionOpen; },
        get workspaces() { return workspaces; },
        set workspaces(value) { workspaces = value; },
        get scope() { return scope; },
        set scope(value) { scope = value; }
    });

    const domOwner = createStatusPanelDom({
        doc
    });
    const { h, icon, button, diffCounts, on, cleanups } = domOwner;

    // 浮层（popover、dialog）挂在 body 下，独立于会话区域的滚动与裁剪
    const portal = h('div', 'zc-scope vcp-ui-scope zc-portal');
    const layer = h('div', 'zc-scope vcp-ui-scope zc-status-layer');
    layer.hidden = true;
    const aside = h('aside', 'zc-status');
    aside.setAttribute('aria-label', '状态');
    layer.appendChild(aside);

    // ------------------------------------------------------------------ data

    // Git 侧栏标签与这个面板读的是同一个仓库：任何一边改了仓库，都发一个事件让另一边马上刷新
    const floatingOwner = createStatusPanelFloating({
        button, doc, h,
        icon, portal, win
    });
    const { placeFloating, closePopover, closeAllPopovers, openPopover, openModal, popovers, modals } = floatingOwner;

    const gitActionsOwner = createStatusPanelGitActions({
        store, api, describeIssue,
        openSwitchBlockedDialog: (...args) => openSwitchBlockedDialog(...args), parseSwitchBlockedFiles, refreshAfterMutation,
        render, toast, uniquePaths
    });
    const { loadBranches, runBusy, adoptBranch, switchBranch, createBranch, pushCurrent, canPush, stageAll } = gitActionsOwner;

    const branchDialogsOwner = createStatusPanelBranchDialogs({
        store, adoptBranch, api,
        branchLabel, buildCommitMessage, button,
        closeAllPopovers, closePopover, createBranch,
        describeIssue, dialogButtons, filterBranches,
        h, icon, loadBranches,
        openGitGraphDialog: (...args) => openGitGraphDialog(...args), openModal, openPopover,
        popovers, refresh, refreshAfterMutation,
        spinner, stageAll, switchBranch,
        toast, uniquePaths
    });
    const { branchTrigger, openBranchSwitcher, openBranchPopover, openCreateBranchDialog, openSwitchBlockedDialog, openSwitchCommitDialog } = branchDialogsOwner;

    const commitDialogOwner = createStatusPanelCommitDialog({
        store, api, branchTrigger,
        buildCommitMessage, button, canPush,
        describeIssue, formatShortcutLabel, h,
        icon, isMac, openModal,
        openPushDialog: (...args) => openPushDialog(...args), pushCurrent, refreshAfterMutation,
        spinner, stageAll, toast,
        uniquePaths
    });
    const { openCommitDialog } = commitDialogOwner;

    const pushDialogOwner = createStatusPanelPushDialog({
        store, branchLabel, button,
        canPush, dialogButtons, h,
        icon, openModal, pushCurrent,
        refreshAfterMutation, spinner, toast,
        win
    });
    const { openPushDialog } = pushDialogOwner;

    const gitGraphOwner = createStatusPanelGitGraph({
        store, api, button,
        describeIssue, doc, formatCommitTime,
        h, icon, layoutGitGraph,
        openModal, parseGraphRefs, spinner,
        toast
    });
    const { svg, openGitGraphDialog } = gitGraphOwner;

    const sectionsOwner = createStatusPanelSections({
        store, branchTrigger, button,
        canPush, closePopover, diffCounts,
        getTodoFocusWindow, h, icon,
        normalizeCommand, onOpenGitTab, onOpenPlanDetail,
        onOpenToolOutput, openCommitDialog,
        openPopover, openPushDialog: (...args) => openPushDialog(...args), pickMiniMetric,
        render, onToggleSection: key => { sectionOpen[key] = !sectionOpen[key]; render(true); }, scoped,
        setVariant, win
    });
    const { sectionHeader, rowButton, renderGitSection, recentCommandRuns, renderRunsSection, planStatusIcon, planItemRows, hiddenGroup, renderPlanSection, renderMini } = sectionsOwner;

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

    async function loadPlan(nextWorkspace, projects, batchIds) {
        try {
            let candidates = projects;
            if (!scoped) {
                if (!nextWorkspace || !api?.projectForgeListProjects) return null;
                const res = await api.projectForgeListProjects({});
                candidates = res?.success ? pickProjectsForWorkspace(res.data, nextWorkspace) : [];
            }
            // 和侧栏计划同一条规则选工程，两边永远显示同一个
            const project = pickTopicProject(candidates);
            if (!project) return null;
            const detail = await api.projectForgeGetProject?.(project.id);
            const items = mapTodoItems(detail?.success ? detail.data?.todos : []);
            if (!items.length) return null;
            let activity = null;
            if (scoped) {
                let topicKey = '';
                try { topicKey = getTopicKey?.() || ''; } catch (_e) { /* 没有侧栏就只看聊天记录 */ }
                activity = summarizeTopicBatches(detail.data?.timeline, [...(batchIds || []), ...readRevertBatches(storage, topicKey)]);
            }
            return { items, project, activity };
        } catch { /* 进程信息缺失不影响 Git 部分 */ }
        return null;
    }

    async function refresh() {
        if (disposed) return;
        const seq = ++refreshSeq;
        readScope();
        const nextScope = { projectIds: [...scope.projectIds], commands: new Set(scope.commands), batchIds: new Set(scope.batchIds || []) };
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
            nextPlan = await loadPlan(nextWorkspace, projects, nextScope.batchIds);
        } catch { /* 所有失败结果也只能由当前 generation 提交 */ }
        if (disposed || seq !== refreshSeq) return;
        // 工作区归属规则：异步 helper 只返回局部结果，当前会话一次提交。
        scopedProjects = projects;
        const workspaceChanged = workspace?.id !== nextWorkspace?.id;
        if (workspaceChanged) { closeAllPopovers(); for (const modal of [...modals]) modal.close(); }
        workspace = nextWorkspace;
        if (workspaceChanged && scoped && nextWorkspace) {
            try { onScopeWorkspace?.(nextWorkspace); } catch (_e) { /* 外部跟随失败不影响面板 */ }
        }
        workspaces = nextWorkspaces;
        summary = nextSummary;
        plan = nextPlan;
        render();
    }

    /** 打开一个浮层；点击浮层和锚点之外的位置、按 Esc 时关闭。 */

    function spinner() {
        return icon('loader-circle', 'zc-spin');
    }

    function branchLabel() {
        const branch = summary?.branch;
        return branch?.detached ? '游离 HEAD' : (branch?.head || 'HEAD');
    }

    function describeIssue(res) {
        return res?.error || res?.data?.issues?.[0]?.message || res?.issues?.[0]?.message || '操作失败';
    }

    /** 供 Git 侧栏标签复用：先对齐工作区与分支列表，再在 anchor 下弹出同一个分支切换浮层。 */

    /** 分支操作返回了最新状态，先把分支名更新掉，不必等完整刷新。 */

    function dialogButtons(...buttons) {
        return h('div', 'zc-dialog-footer', ...buttons);
    }

    // ------------------------------------------------------------------ panel rendering

    function setVariant(next) {
        variantOverride = next;
        try { storage?.setItem(STORAGE_KEY_VARIANT, next); } catch (_e) { /* ignore */ }
        render(true);
    }

    function currentVariant() {
        return resolveVariant({ override: variantOverride, width: hostWidth });
    }

    function render(force = false) {
        renderPanel(force);
    }

    function renderPanel(force) {
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
        domOwner.dispose();
        floatingOwner.dispose();
        gitActionsOwner.dispose();
        branchDialogsOwner.dispose();
        commitDialogOwner.dispose();
        pushDialogOwner.dispose();
        gitGraphOwner.dispose();
        sectionsOwner.dispose();
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
