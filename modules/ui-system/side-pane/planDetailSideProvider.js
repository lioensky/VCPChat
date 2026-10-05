/**
 * modules/ui-system/side-pane/planDetailSideProvider.js
 * VCPChat Universal Sub-screen - V工程 计划详情 Provider
 *
 * 对应 ZCode 的 PlanDetailSidePane（在侧栏里整页阅读一份计划），数据来自 VCPChat 自己的 V工程（ProjectForge）。
 * 在话题里打开时，一个话题一个计划标签：
 * - 跟着工程走：名称、状态、根目录、计划（todo）与进度、验收报告；
 * - 跟着话题走：施工时间线、变更文件、参与者、统计和历史筛选，只算这个话题自己施工产生的批次；
 * - 节点可以展开看前后差异并署名回退，和 V工程 页同一套规则。
 * 「Git」页是当前工作区的未提交改动（原先单独的 Git 变更标签），没有工程时也能用。
 * 删除工程、源码页留在 V工程 页。工程变更时经 onProjectForgeChanged 实时刷新，
 * 聊天记录变化（新的施工结果）时重新圈定话题批次。面板样式沿用 status-panel 的 zc-* 变量。
 */

'use strict';

import { mapTodoItems, pickProjectsForWorkspace, pickTopicProject } from '../project-plan-model.js';
import { readRevertBatches, recordRevertBatch } from '../conversation-scope.js';
import { getParentKey } from './side-pane-state.js';
import { formatRelativeTime } from './side-pane-tab-utils.js';
import {
    KIND_LABEL, KIND_ICON, OP_LABEL, EMPTY_FILTERS, TIMELINE_LIMIT,
    locateTopicBatches, buildTopicActivity, hasFilters, searchParams, narrowSearchRows
} from './plan-detail/topic-activity.js';
import { createPlanNodeView } from './plan-detail/node-view.js';
import { createPlanPageNavigation } from './plan-detail/page-navigation.js';
import { createProjectPicker } from './plan-detail/project-picker.js';
import { mountGitView } from './git/git-view.js';

const STORAGE_KEY_WS = 'vcp-projectforge-git-workspace';
const TAB_PREFIX = 'plan-detail:';
const TOPIC_TAB = 'topic';
const NO_PROJECT_TAB = 'none';
const FOLLOW_SKIPPED = Symbol('follow-skipped');
const REFRESH_DEBOUNCE_MS = 200;
const FILTER_DEBOUNCE_MS = 300;

const STATUS_LABEL = Object.freeze({ completed: '已完成', inProgress: '进行中', pending: '待处理' });
const STATUS_ICON = Object.freeze({ completed: 'check_circle', inProgress: 'arrow_forward', pending: 'radio_button_unchecked' });

/** 话题里一个话题一个计划标签（工程在标签里切换）；不在话题里时一个工程一个标签。 */
export function planTabId(projectId, parentRef = null) {
    if (parentRef) return `${TAB_PREFIX}${TOPIC_TAB}@${getParentKey(parentRef)}`;
    return `${TAB_PREFIX}${projectId || NO_PROJECT_TAB}`;
}

/**
 * 把 project-forge:get-project 的返回整理成视图模型。
 * @param {{project?:object,todos?:object[],contributors?:object[],files?:object[],timeline?:object[]}} data
 */
export function buildPlanModel(data) {
    const project = data?.project || null;
    const items = mapTodoItems(data?.todos || []).map((item, index) => {
        const raw = (data?.todos || [])[index] || {};
        return { ...item, note: raw.note ? String(raw.note) : '', updatedBy: raw.updated_by || '', updatedAt: raw.updated_at || '' };
    });
    const completed = items.filter(item => item.status === 'completed').length;
    const inProgress = items.filter(item => item.status === 'inProgress').length;
    const stats = project?.stats || {};
    return {
        project,
        items,
        counts: { total: items.length, completed, inProgress, pending: items.length - completed - inProgress },
        files: Array.isArray(data?.files) ? data.files : [],
        timeline: Array.isArray(data?.timeline) ? data.timeline : [],
        contributors: Array.isArray(data?.contributors) ? data.contributors : [],
        added: Number(stats.added) || 0,
        removed: Number(stats.removed) || 0
    };
}

/**
 * 没有指定工程时选哪一个：与 Git 面板同一工作区里有进程的最近工程 > 最近更新的工程。
 * @returns {Promise<object|null>} 工程摘要
 */
export async function resolveDefaultProject(api, storage = null) {
    if (!api?.projectForgeListProjects) return null;
    const listed = await api.projectForgeListProjects({});
    const projects = (listed?.success ? listed.data : []) || [];
    const alive = projects.filter(project => !project.deleted_at);
    if (!alive.length) return null;

    try {
        const wsRes = await api.gitListWorkspaces?.();
        if (wsRes?.success) {
            const workspaces = wsRes.data?.workspaces || [];
            const stored = storage?.getItem?.(STORAGE_KEY_WS);
            const workspace = workspaces.find(w => w.id === stored)
                || workspaces.find(w => w.id === wsRes.data?.activeWorkspaceId)
                || workspaces[0];
            const inWorkspace = pickProjectsForWorkspace(alive, workspace);
            if (inWorkspace.length) return inWorkspace[0];
        }
    } catch (_e) { /* 工作区信息缺失时回落到最近更新的工程 */ }
    return [...alive].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
}

async function call(promise) {
    const result = await promise;
    if (!result?.success) throw new Error(result?.error || '未知错误');
    return result.data;
}

export function createPlanDetailSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    // 当前话题用过的 V工程（最近的在前）；不传时退回旧的默认工程选择
    getConversationProjects = null,
    // 当前话题的作用域（conversation-scope.js：projectIds、batchIds）
    getTopicScope = null,
    // 聊天记录变化时回调（新的施工结果进来），返回取消订阅
    watchTopic = null,
    uiHelper = null,
    onOpenProjectForge = null
} = {}) {
    const kind = 'plan-detail';
    const win = doc.defaultView || window;
    const storage = (() => { try { return win.localStorage; } catch (_e) { return null; } })();
    const toast = (message, type = 'info') => uiHelper?.showToastNotification?.(message, type);
    // 打开时要切到的页 / 要定位的文件：标签还没挂载就留给 mountTab 取，不写进标签 payload（不该随布局恢复）
    const pendingReveal = new Map();

    return {
        kind,

        /**
         * 打开（或聚焦）计划详情。话题里不传 projectId 时显示话题的工程（与状态面板同一条规则）；
         * focus 可以定位到某条计划（todoId）或某个区块（section）。没有任何工程时给出提示而不是开一个空标签。
         * page 切到某一页；page 为 'git' 时没有工程也照样打开，focusPath 展开那个文件的 diff。
         */
        async openPlanDetailTab({ projectId = null, projectName = '', focus = null, page = null, focusPath = null } = {}) {
            if (!sidePaneController) return null;
            let id = projectId;
            let name = projectName;
            // 计划跟着话题走：标签记在打开它的话题下，切到别的话题就收起
            const snapshot = sidePaneController.getSnapshot?.() || null;
            const parent = snapshot?.parent || null;
            if (!id && parent && typeof getConversationProjects === 'function') {
                const used = (await getConversationProjects()) || [];
                if (!used.length && page !== 'git') {
                    toast('这个话题还没用过 V工程：让助手用 ProjectForge 建好工程后，这里会显示它的计划', 'info');
                    return null;
                }
                // 和状态面板同一条规则：最近用过、有计划的工程
                const picked = pickTopicProject(used);
                id = picked?.id || null;
                name = picked?.name || '';
            }
            if (!id && !parent) {
                const project = await resolveDefaultProject(api, storage);
                if (!project && page !== 'git') {
                    toast('还没有 V工程 工程：让管家用 ProjectForge 创建工程后，这里会显示它的计划', 'info');
                    return null;
                }
                id = project?.id || null;
                name = project?.name || '';
            }
            const parentKey = parent ? getParentKey(parent) : '';
            // 这个话题已经有计划标签（包括旧版按工程开的）就用它
            const existing = parent
                ? (snapshot?.tabs || []).find(t => t.kind === kind && t.parent && getParentKey(t.parent) === parentKey)
                : null;
            const tabId = existing?.id || planTabId(id, parent);
            const pinned = Boolean(projectId);
            const payload = { ...(existing?.payload || {}), projectId: existing && !pinned ? (existing.payload?.projectId || id) : id, projectName: name, pinned: pinned || Boolean(existing?.payload?.pinned), focus };
            const wasMounted = Boolean(sidePaneController.getTabHandle?.(tabId));
            if (page || focusPath) pendingReveal.set(tabId, { page, focusPath });
            const handle = await sidePaneController.openTab({
                id: tabId,
                kind,
                title: name ? `计划 · ${name}` : (existing?.title || '计划详情'),
                icon: 'checklist',
                closable: true,
                scopeMode: parent ? 'topic' : 'global',
                parent,
                searchHint: name || '',
                payload
            });
            sidePaneController.setVisible?.(true);
            const mounted = sidePaneController.getTabHandle?.(tabId) || handle;
            if (existing || wasMounted) {
                pendingReveal.delete(tabId);
                mounted?.reveal?.({ projectId: pinned ? id : null, focus, page, focusPath });
            }
            mounted?.focus?.();
            return mounted;
        },

        async mountTab(tab, viewElement) {
            if (!viewElement) return null;
            const legacyId = String(tab?.id || '').slice(TAB_PREFIX.length).split('@')[0];
            let projectId = tab?.payload?.projectId || (legacyId && legacyId !== TOPIC_TAB && legacyId !== NO_PROJECT_TAB ? legacyId : null);
            let pinned = Boolean(tab?.payload?.pinned);
            let pendingFocus = tab?.payload?.focus || null;
            const topicMode = Boolean(tab?.parent);
            const topicKey = topicMode ? getParentKey(tab.parent) : '';
            viewElement.innerHTML = '';
            viewElement.classList.add('side-plan-view');

            const h = (tag, className, text) => {
                const node = doc.createElement(tag);
                if (className) node.className = className;
                if (text !== undefined && text !== null) node.textContent = text;
                return node;
            };
            const icon = (name, className = '') => {
                const node = h('span', `vcp-ui-icon ${className}`.trim(), name);
                node.setAttribute('aria-hidden', 'true');
                return node;
            };
            const button = (className, label, title) => {
                const node = h('button', className, label);
                node.type = 'button';
                if (title) { node.title = title; node.setAttribute('aria-label', title); }
                return node;
            };

            const scope = h('div', 'zc-scope vcp-ui-scope side-plan-scope');
            const chrome = h('div', 'side-plan-chrome');
            const body = h('div', 'side-plan-body');
            scope.append(chrome, body);
            viewElement.appendChild(scope);

            let isDisposed = false;
            let model = null;
            let activity = null; // 话题模式下本话题的施工；全局标签为 null
            let topicProjects = [];
            let topicBatchIds = new Set();
            let other = { count: 0, more: false };
            let scopeKey = '';
            let errorText = '';
            let staleError = ''; // 刷新失败但还留着上一次的内容（ZCode：lastMarkdown 保留，不因一次失败清空）
            let loading = true;
            let refreshSeq = 0;
            let timer = null;
            let shownName = tab?.payload?.projectName || '';
            const collapsed = { files: false, timeline: false, contributors: false, report: true };
            const expanded = new Set();
            const batchCache = new Map(); // `${projectId}:${batchId}` → { batch, nodes } | null（不在这个工程）
            let filters = { ...EMPTY_FILTERS };
            let filterRows = null;
            let filterError = '';
            let filterSeq = 0;
            let filterTimer = null;
            let nodeView = null;
            const navigation = createPlanPageNavigation({ h, button, id: tab.id, onChange: selectPage });
            const picker = createProjectPicker({ h, icon, doc, win, host: scope, api, onPick: switchProject });
            // Git 页：元素常驻，每次重绘挂回去；第一次切到这一页才读 Git
            const gitHost = h('div', 'side-plan-git');
            let gitView = null;
            let gitProjectId = null;
            const workspaceOfProject = (project) => (project && (project.workspace_id || project.workspace_alias)
                ? { id: project.workspace_id || null, alias: project.workspace_alias || null } : null);
            function ensureGit() {
                if (!gitView) {
                    gitProjectId = model?.project?.id || null;
                    gitView = mountGitView(gitHost, { api, uiHelper, preferWorkspace: workspaceOfProject(model?.project) });
                }
                return gitView;
            }
            /** 换了工程，Git 页跟到它的工作区 */
            function followProjectWorkspace() {
                const project = model?.project;
                if (!gitView || !project || project.id === gitProjectId) return;
                const skipped = gitProjectId === FOLLOW_SKIPPED;
                gitProjectId = project.id;
                if (skipped) return;
                gitView.useWorkspace(workspaceOfProject(project));
            }

            function selectPage(key) {
                if (navigation.selected === key) return;
                navigation.select(key, body.scrollTop);
                if (key === 'git') ensureGit();
                render();
                body.scrollTop = navigation.scrollTop;
                chrome.querySelector(`[data-plan-page="${key}"]`)?.focus();
            }

            const isCurrentTopic = () => {
                if (!topicMode) return true;
                const current = sidePaneController?.getSnapshot?.()?.parent;
                return Boolean(current) && getParentKey(current) === topicKey;
            };

            function readScope() {
                let raw = { projectIds: [], batchIds: new Set() };
                try { raw = getTopicScope?.() || raw; } catch (_e) { /* 聊天记录读不到就当没有 */ }
                const batchIds = new Set([...(raw.batchIds || []), ...readRevertBatches(storage, topicKey)]);
                const projectIds = [...(raw.projectIds || [])];
                return { projectIds, batchIds, key: JSON.stringify([projectIds, [...batchIds].sort((a, b) => a - b)]) };
            }

            async function listTopicProjects(ids) {
                if (!ids.length || !api?.projectForgeListProjects) return [];
                const res = await api.projectForgeListProjects({});
                const byId = new Map((res?.success ? res.data || [] : []).filter(p => !p.deleted_at).map(p => [p.id, p]));
                return ids.map(id => byId.get(id)).filter(Boolean);
            }

            async function fetchBatch(pid, batchId) {
                const key = `${pid}:${batchId}`;
                if (batchCache.has(key)) return batchCache.get(key);
                try {
                    const data = await call(api.projectForgeGetBatch(pid, batchId));
                    batchCache.set(key, data); // 批次落库后不再变
                    return data;
                } catch (error) {
                    if (/不存在/.test(error?.message || '')) batchCache.set(key, null);
                    return null;
                }
            }

            // ---------------------------------------------------------------- 渲染

            const sectionTitle = (key, label, meta) => {
                const btn = h('button', 'side-plan-section-title');
                btn.type = 'button';
                btn.setAttribute('aria-expanded', String(!collapsed[key]));
                btn.append(icon(collapsed[key] ? 'chevron_right' : 'expand_more'), h('span', 'side-plan-section-label', label));
                if (meta) btn.appendChild(h('span', 'side-plan-section-meta', meta));
                btn.addEventListener('click', () => { collapsed[key] = !collapsed[key]; render(); });
                return btn;
            };
            const section = (label, meta, key, content) => {
                const el = h('section', 'side-plan-section');
                el.dataset.planSection = key || label;
                if (key) {
                    el.appendChild(sectionTitle(key, label, meta));
                    if (!collapsed[key]) el.appendChild(content);
                } else {
                    const head = h('div', 'side-plan-section-title static');
                    head.append(h('span', 'side-plan-section-label', label));
                    if (meta) head.appendChild(h('span', 'side-plan-section-meta', meta));
                    el.append(head, content);
                }
                return el;
            };
            const diffStat = (added, removed) => {
                const wrap = h('span', 'side-plan-diffstat');
                if (added) wrap.appendChild(h('span', 'side-plan-added', `+${added}`));
                if (removed) wrap.appendChild(h('span', 'side-plan-removed', `-${removed}`));
                return wrap;
            };
            const when = (iso) => (iso ? formatRelativeTime(Date.parse(iso)) : '');
            const who = (maid, batchKind) => (maid ? `@${maid}` : (batchKind === 'external' ? '外部修改' : '未署名'));

            function renderHeader() {
                const project = model?.project || null;
                const head = h('header', 'side-plan-header');
                const titleRow = h('div', 'side-plan-title-row');
                // 一行胶囊：面包屑（范围 › 工作区 › 工程名）、状态和更新时间、刷新/打开。
                // 面包屑本身就是工程切换按钮，任何工程都能从这里换过去
                const crumbs = button('side-plan-crumbs', null, '切换工程');
                crumbs.setAttribute('aria-haspopup', 'listbox');
                crumbs.setAttribute('aria-expanded', String(picker.isOpen()));
                crumbs.addEventListener('click', () => {
                    if (picker.isOpen()) picker.close();
                    else picker.open({ currentId: project?.id || null, topicIds: topicMode ? topicProjects.map(p => p.id) : [] });
                });
                const addCrumb = (node) => {
                    if (crumbs.childElementCount) crumbs.appendChild(icon('chevron_right', 'side-plan-crumb-sep'));
                    crumbs.appendChild(node);
                };
                if (!project) {
                    addCrumb(h('span', 'side-plan-title', '选择工程'));
                    crumbs.appendChild(icon('expand_more', 'side-plan-crumb-caret'));
                    titleRow.appendChild(crumbs);
                    head.appendChild(titleRow);
                    return head;
                }
                addCrumb(h('span', 'side-plan-crumb side-plan-context', activity ? '本话题' : '工程全览'));
                if (project.workspace_alias) addCrumb(h('span', 'side-plan-crumb', project.workspace_alias));
                addCrumb(h('span', 'side-plan-title', project.name || '未命名工程'));
                crumbs.appendChild(icon('expand_more', 'side-plan-crumb-caret'));
                titleRow.appendChild(crumbs);
                // 软删除的工程 GetProject 仍然成功、status 也不变，只多了 deleted_at
                const status = project.deleted_at ? 'deleted' : project.status;
                const statusText = status === 'deleted' ? '已删除' : status === 'active' ? '进行中' : status === 'closed' ? '已收尾' : status === 'review' ? '待验收' : (status || '');
                const updated = when(project.updated_at);
                if (statusText || updated) {
                    const statusPill = h('div', `side-plan-status status-${status || 'unknown'}`);
                    if (statusText) statusPill.appendChild(h('span', `side-plan-chip status-${status || 'unknown'}`, statusText));
                    if (updated) {
                        statusPill.appendChild(h('span', 'side-plan-updated', updated));
                        // 窄侧栏里时间段会藏起来，悬停状态胶囊仍能看到
                        statusPill.title = `更新于 ${updated}`;
                    }
                    titleRow.appendChild(statusPill);
                }
                const actions = h('div', 'side-plan-actions');
                const refreshBtn = button('side-plan-icon-btn', null, '刷新');
                refreshBtn.appendChild(icon('refresh'));
                refreshBtn.addEventListener('click', () => load());
                actions.appendChild(refreshBtn);
                if (onOpenProjectForge) {
                    // 和浏览器工具栏的前进后退胶囊一样：两颗按钮之间一根细竖线
                    const divider = h('span', 'side-plan-actions-divider');
                    divider.setAttribute('aria-hidden', 'true');
                    actions.appendChild(divider);
                    const forgeBtn = button('side-plan-icon-btn side-plan-forge', null, '完整记录与回退（V工程 页）');
                    forgeBtn.appendChild(icon('open_in_new'));
                    forgeBtn.addEventListener('click', () => onOpenProjectForge(project.id));
                    actions.appendChild(forgeBtn);
                }
                titleRow.appendChild(actions);
                head.appendChild(titleRow);
                if (project.deleted_at) {
                    const by = project.deleted_by ? ` ${project.deleted_by} ` : '';
                    head.appendChild(h('div', 'side-plan-warning side-plan-deleted', `这个工程已被${by}删除（${when(project.deleted_at)}），下面是删除前的计划；需要时让助手用 RestoreProjects 恢复`));
                }
                if (project.rootInfo && project.rootInfo.writable === false && project.rootInfo.blockedReason) {
                    head.appendChild(h('div', 'side-plan-warning', project.rootInfo.blockedReason));
                }

                return head;
            }

            function renderProjectDetails() {
                const { project } = model;
                const details = h('dl', 'side-plan-project-details');
                [['创建者', project.created_by], ['工作区', project.workspace_alias],
                    ['更新', when(project.updated_at)], ['根目录', project.root]].forEach(([label, value]) => {
                    if (!value) return;
                    details.append(h('dt', '', label), h('dd', '', value));
                });
                return section('工程信息', '', null, details);
            }

            function renderProgress() {
                const { counts } = model;
                const summary = h('div', 'side-plan-progress-text');
                if (counts.total > 0) {
                    const pct = Math.round((counts.completed / counts.total) * 100);
                    const progress = h('progress', 'side-plan-progress');
                    progress.max = counts.total;
                    progress.value = counts.completed;
                    progress.setAttribute('aria-label', `计划进度 ${pct}%`);
                    summary.append(
                        h('span', counts.completed >= counts.total ? 'side-plan-done' : '', `${counts.completed}/${counts.total} 已完成`),
                        progress
                    );
                    if (counts.inProgress) summary.appendChild(h('span', '', `${counts.inProgress} 进行中`));
                }
                return summary;
            }

            function renderStats() {
                const { project } = model;
                const stats = h('div', 'side-plan-stats');
                if (activity) {
                    const s = activity.stats;
                    stats.append(
                        h('span', 'side-plan-stats-scope', '本话题'),
                        h('span', '', `${s.batchCount} 批`),
                        h('span', '', `${s.nodeCount} 次改动`),
                        h('span', '', `${s.fileCount} 个文件`),
                        diffStat(s.added, s.removed)
                    );
                    if (s.lastAt) stats.appendChild(h('span', '', `最近 ${when(s.lastAt)}`));
                } else {
                    const s = project.stats || {};
                    stats.append(
                        h('span', '', `${s.nodeCount || 0} 次改动`),
                        h('span', '', `${s.fileCount || 0} 个文件`),
                        diffStat(s.added, s.removed)
                    );
                    if (s.lastAt) stats.appendChild(h('span', '', `最近 ${when(s.lastAt)}`));
                }
                return stats;
            }

            function renderTodos() {
                if (!model.items.length) {
                    return section('计划', '', null, h('div', 'side-plan-empty', '这个工程还没有计划条目'));
                }
                const list = h('ol', 'side-plan-todos');
                model.items.forEach(item => {
                    const row = h('li', `side-plan-todo status-${item.status}${item.blocked ? ' blocked' : ''}`);
                    row.dataset.todoStatus = item.status;
                    row.dataset.todoId = item.id;
                    const mark = h('span', 'side-plan-todo-mark');
                    mark.appendChild(icon(item.blocked ? 'cancel' : STATUS_ICON[item.status]));
                    const text = h('div', 'side-plan-todo-text');
                    // Preserve the task text and ordered-list semantics without adding a second visible number.
                    text.appendChild(h('div', 'side-plan-todo-title', item.content));
                    const sub = [item.blocked ? '已阻塞' : STATUS_LABEL[item.status], item.updatedBy, when(item.updatedAt)]
                        .filter(Boolean).join(' · ');
                    text.appendChild(h('div', 'side-plan-todo-sub', sub));
                    if (item.note) text.appendChild(h('div', 'side-plan-todo-note', item.note));
                    row.append(mark, text);
                    list.appendChild(row);
                });
                const content = h('div', 'side-plan-task-list');
                content.append(renderProgress(), list);
                return section('计划', '', null, content);
            }

            function nodeRow(node, { batchKind = null, maid = undefined, showBatch = false } = {}) {
                const row = button('side-plan-node-row', null, `查看 ${node.file_path} 的这次改动`);
                row.dataset.nodeId = String(node.id);
                const path = h('span', 'side-plan-node-path', node.file_path);
                row.append(h('span', `side-plan-op op-${node.op}`, OP_LABEL[node.op] || node.op), path, diffStat(node.added, node.removed));
                if (showBatch) {
                    const sub = h('span', 'side-plan-node-sub', [`b${node.batch_id}`, who(maid ?? node.maid, batchKind ?? node.batch_kind), when(node.created_at)].filter(Boolean).join(' · '));
                    row.appendChild(sub);
                    const reason = node.effective_reason || node.reason || node.summary;
                    if (reason) row.appendChild(h('span', 'side-plan-node-reason', reason));
                }
                row.addEventListener('click', () => openNode(node.id));
                return row;
            }

            function renderFilterBar() {
                const bar = h('div', 'side-plan-filters');
                const input = (key, placeholder) => {
                    const el = h('input', 'side-plan-input');
                    el.type = 'search';
                    el.placeholder = placeholder;
                    el.setAttribute('aria-label', placeholder);
                    el.dataset.filter = key;
                    el.value = key === 'file' ? (filters.exactFile || filters.file) : filters[key];
                    el.addEventListener('input', () => {
                        if (key === 'file') { filters.file = el.value.trim(); filters.exactFile = ''; } else filters[key] = el.value.trim();
                        // Invalidate on intent, before the debounce allows an old read to settle.
                        ++filterSeq;
                        filterRows = null;
                        filterError = '';
                        win.clearTimeout(filterTimer);
                        filterTimer = win.setTimeout(() => runSearch(), FILTER_DEBOUNCE_MS);
                        render();
                    });
                    return el;
                };
                const select = (key, label, options) => {
                    const el = h('select', 'side-plan-select');
                    el.setAttribute('aria-label', label);
                    el.dataset.filter = key;
                    const all = h('option', '', label);
                    all.value = '';
                    el.appendChild(all);
                    options.forEach(([value, text]) => {
                        const option = h('option', '', text);
                        option.value = value;
                        el.appendChild(option);
                    });
                    el.value = filters[key];
                    el.addEventListener('change', () => { filters[key] = el.value; runSearch(); });
                    return el;
                };
                const people = (activity ? activity.contributors : model.contributors).filter(c => c.maid).map(c => [c.maid, `@${c.maid}`]);
                if (filters.maid && !people.some(([value]) => value === filters.maid)) people.unshift([filters.maid, `@${filters.maid}`]);
                bar.append(
                    input('keyword', '关键词（原因、摘要、路径）'),
                    input('file', '文件'),
                    input('content', '改动后内容包含'),
                    select('maid', '全部人员', people),
                    select('op', '全部操作', Object.entries(OP_LABEL))
                );
                if (hasFilters(filters)) {
                    const clear = button('zc-btn zc-btn-ghost zc-btn-sm side-plan-filter-clear', '清除筛选');
                    clear.addEventListener('click', () => { filters = { ...EMPTY_FILTERS }; runSearch(); });
                    bar.appendChild(clear);
                }
                return bar;
            }

            function renderFilterResults() {
                const box = h('div', 'side-plan-filter-results');
                if (filterError) {
                    box.appendChild(h('div', 'side-plan-warning', `筛选失败：${filterError}`));
                    return box;
                }
                if (!filterRows) {
                    box.appendChild(h('div', 'side-plan-node-message', '正在筛选…'));
                    return box;
                }
                box.appendChild(h('div', 'side-plan-section-meta', filterRows.length ? `${filterRows.length} 次改动匹配` : (activity ? '这个话题的施工里没有匹配的改动' : '没有匹配的改动')));
                const list = h('div', 'side-plan-node-list');
                filterRows.forEach(row => list.appendChild(nodeRow(row, { showBatch: true })));
                box.appendChild(list);
                return box;
            }

            function timelineRows() {
                return activity ? activity.batches : model.timeline;
            }

            function renderTimeline() {
                const rows = timelineRows();
                const content = h('div', 'side-plan-history');
                if (rows.length || hasFilters(filters)) content.appendChild(renderFilterBar());
                if (hasFilters(filters)) {
                    content.appendChild(renderFilterResults());
                } else if (!rows.length) {
                    content.appendChild(h('div', 'side-plan-node-message', activity ? '这个话题还没有在这个工程里施工' : '这个工程还没有施工记录'));
                } else {
                    const list = h('ol', 'side-plan-timeline');
                    rows.forEach(batch => {
                        const open = expanded.has(batch.id);
                        const row = h('li', `side-plan-batch kind-${batch.kind}${open ? ' is-open' : ''}`);
                        row.dataset.batchId = String(batch.id);
                        const headBtn = button('side-plan-batch-head');
                        headBtn.setAttribute('aria-expanded', String(open));
                        const mark = h('span', 'side-plan-batch-mark');
                        mark.appendChild(icon(KIND_ICON[batch.kind] || 'commit'));
                        const text = h('div', 'side-plan-batch-text');
                        text.appendChild(h('div', 'side-plan-batch-reason', batch.reason || `${KIND_LABEL[batch.kind] || batch.kind} b${batch.id}`));
                        const sub = h('div', 'side-plan-batch-sub');
                        sub.append(
                            h('span', '', `b${batch.id}`),
                            h('span', '', KIND_LABEL[batch.kind] || batch.kind),
                            h('span', '', who(batch.maid, batch.kind)),
                            h('span', '', when(batch.created_at)),
                            diffStat(batch.added, batch.removed)
                        );
                        text.appendChild(sub);
                        if (!open && Array.isArray(batch.files) && batch.files.length) {
                            const files = h('div', 'side-plan-batch-files', batch.files.join('、'));
                            files.title = batch.files.join('\n');
                            text.appendChild(files);
                        }
                        headBtn.append(mark, text, icon(open ? 'expand_less' : 'expand_more', 'side-plan-batch-chevron'));
                        headBtn.addEventListener('click', () => toggleBatch(batch.id));
                        row.appendChild(headBtn);
                        if (open) {
                            const nodes = batch.nodes || batchCache.get(`${model.project.id}:${batch.id}`)?.nodes;
                            const list2 = h('div', 'side-plan-node-list');
                            if (nodes) nodes.forEach(node => list2.appendChild(nodeRow(node)));
                            else list2.appendChild(h('div', 'side-plan-node-message', '正在读取…'));
                            row.appendChild(list2);
                        }
                        list.appendChild(row);
                    });
                    content.appendChild(list);
                }
                const meta = activity ? `本话题 ${rows.length} 批` : `${rows.length} 批`;
                return section('施工时间线', meta, 'timeline', content);
            }

            function renderFiles() {
                const files = activity ? activity.files : model.files;
                if (!files.length) return section('变更文件', '', 'files', h('div', 'side-plan-empty', activity ? '这个话题还没有变更文件' : '这个工程还没有变更文件'));
                const list = h('ul', 'side-plan-files');
                files.forEach(file => {
                    const row = h('li', 'side-plan-file');
                    const pick = button(`side-plan-file-btn${filters.exactFile === file.file_path ? ' is-active' : ''}`, null, `只看 ${file.file_path} 的改动`);
                    const name = h('span', 'side-plan-file-name', file.file_path);
                    name.title = file.file_path;
                    pick.append(icon('description'), name, h('span', 'side-plan-file-edits', `${file.edits} 次`), diffStat(file.added, file.removed));
                    pick.addEventListener('click', () => applyFilter({ exactFile: file.file_path, file: '' }));
                    row.appendChild(pick);
                    list.appendChild(row);
                });
                const added = activity ? activity.stats.added : model.added;
                const removed = activity ? activity.stats.removed : model.removed;
                return section('变更文件', `${files.length} 个 · +${added} -${removed}`, 'files', list);
            }

            function renderContributors() {
                const people = activity ? activity.contributors : model.contributors;
                if (!people.length) return null;
                const list = h('ul', 'side-plan-contributors');
                people.forEach(c => {
                    const row = h('li', 'side-plan-contributor');
                    const label = c.maid || '外部修改';
                    const pick = button(`side-plan-contributor-btn${c.maid && filters.maid === c.maid ? ' is-active' : ''}`, null, c.maid ? `只看 @${c.maid} 的改动` : '外部修改');
                    pick.append(icon('person'), h('span', 'side-plan-contributor-name', label), h('span', 'side-plan-contributor-batches', `${c.batches} 批`), diffStat(c.added, c.removed));
                    if (c.maid) pick.addEventListener('click', () => applyFilter({ maid: c.maid }));
                    else pick.disabled = true;
                    row.appendChild(pick);
                    list.appendChild(row);
                });
                return section('参与者', '', 'contributors', list);
            }

            function renderReport() {
                const report = model.project.report;
                if (!report) return null;
                return section('验收报告', '', 'report', h('div', 'side-plan-report', String(report)));
            }

            function renderOtherHint() {
                if (!activity || !other.count) return null;
                const hint = h('div', 'side-plan-other-hint');
                hint.appendChild(h('span', '', `这个工程还有 ${other.count}${other.more ? '+' : ''} 批来自其他话题的施工`));
                if (onOpenProjectForge) {
                    const link = button('side-plan-link', '在 V工程 页查看');
                    link.addEventListener('click', () => onOpenProjectForge(model.project.id));
                    hint.appendChild(link);
                }
                return hint;
            }

            function render() {
                if (isDisposed || nodeView) return;
                // 输入框随整页重绘，记下焦点和光标位置
                const active = doc.activeElement;
                const focusKey = active && body.contains(active) ? active.dataset?.filter : null;
                const pageFocus = active && chrome.contains(active) ? active.dataset?.planPage : null;
                const caret = focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
                const scrollTop = body.scrollTop;
                body.innerHTML = '';
                chrome.innerHTML = '';
                chrome.hidden = false;
                if (loading && !model && navigation.selected !== 'git') {
                    body.appendChild(h('div', 'side-plan-empty', '正在读取 V工程 计划…'));
                    return;
                }
                const gitPage = { key: 'git', label: 'Git', content: [gitHost] };
                if (!model) {
                    // 没有工程：计划页给出原因，Git 页照常可用
                    const box = h('div', 'side-plan-empty side-plan-error');
                    box.appendChild(h('div', '', loading ? '正在读取 V工程 计划…' : (errorText || '没有找到这个工程，可能已被删除')));
                    if (!loading) {
                        const retry = button('zc-btn zc-btn-ghost', '重试');
                        retry.addEventListener('click', () => load());
                        box.appendChild(retry);
                    }
                    const pages = navigation.render([{ key: 'plan', label: '计划', content: [box] }, gitPage]);
                    chrome.append(renderHeader(), pages.tabs);
                    body.appendChild(pages.panels);
                    body.scrollTop = scrollTop;
                    if (pageFocus) chrome.querySelector(`[data-plan-page="${navigation.selected}"]`)?.focus();
                    return;
                }
                if (staleError) {
                    const banner = h('div', 'side-plan-warning side-plan-stale');
                    banner.setAttribute('role', 'alert');
                    const retry = button('zc-btn zc-btn-ghost', '重试');
                    retry.addEventListener('click', () => load());
                    banner.append(h('span', '', `刷新失败，显示的是上一次的内容：${staleError}`), retry);
                    body.appendChild(banner);
                }
                if (pendingFocus) navigation.select(navigation.pageForFocus(pendingFocus), scrollTop);
                const pages = navigation.render([
                    { key: 'plan', label: '计划', count: model.counts.total, content: [renderTodos()] },
                    { key: 'timeline', label: '施工线', count: timelineRows().length, content: [renderStats(), renderTimeline(), renderOtherHint()] },
                    { key: 'files', label: '文件', count: (activity ? activity.files : model.files).length, content: [renderFiles()] },
                    { key: 'details', label: '详情', content: [renderProjectDetails(), renderContributors(), renderReport()] },
                    gitPage
                ]);
                chrome.append(renderHeader(), pages.tabs);
                body.appendChild(pages.panels);
                body.scrollTop = scrollTop;
                if (focusKey) {
                    const again = body.querySelector(`[data-filter="${focusKey}"]`);
                    again?.focus?.();
                    if (caret && again?.setSelectionRange) { try { again.setSelectionRange(caret[0], caret[1]); } catch (_e) { /* select 没有光标 */ } }
                }
                if (pageFocus) chrome.querySelector(`[data-plan-page="${navigation.selected}"]`)?.focus();
                applyFocus();
            }

            /** 从状态面板点进来时定位到某条计划或某个区块。 */
            function applyFocus() {
                if (!pendingFocus || !model) return;
                const { todoId, section: sectionKey } = pendingFocus;
                pendingFocus = null;
                const todoSelector = todoId !== undefined && todoId !== null ? `.side-plan-todo[data-todo-id="${String(todoId).replace(/"/g, '')}"]` : '';
                if (!(todoSelector && body.querySelector(todoSelector)) && sectionKey && collapsed[sectionKey]) {
                    collapsed[sectionKey] = false;
                    render();
                }
                const find = () => (todoSelector && body.querySelector(todoSelector))
                    || (sectionKey ? body.querySelector(`[data-plan-section="${sectionKey}"]`) : null);
                if (!find()) return;
                // 新开的标签先渲染后显示，看不见时滚动不起作用，等它排好版再定位（最多等约 1.5 秒）；
                // 期间可能重新渲染过，每次都重新找目标
                let tries = 0;
                const reveal = () => {
                    if (isDisposed) return;
                    const target = find();
                    if (!target) return;
                    if (!target.getClientRects?.().length && tries++ < 30) {
                        win.setTimeout(reveal, 50);
                        return;
                    }
                    // 区块（时间线等）往往比视口高，对齐顶部才能看到标题；单条计划放在中间
                    target.scrollIntoView?.({ block: target.matches('[data-plan-section]') ? 'start' : 'center' });
                    target.classList.add('is-flash');
                    win.setTimeout(() => target.classList.remove('is-flash'), 1600);
                };
                reveal();
            }

            // ---------------------------------------------------------------- 交互

            function toggleBatch(batchId) {
                if (expanded.has(batchId)) expanded.delete(batchId);
                else expanded.add(batchId);
                render();
                const row = timelineRows().find(b => b.id === batchId);
                if (expanded.has(batchId) && row && !row.nodes) {
                    const pid = model.project.id;
                    fetchBatch(pid, batchId).then(() => { if (!isDisposed && model?.project.id === pid) render(); });
                }
            }

            function applyFilter(patch) {
                filters = { ...filters, ...patch };
                navigation.select('timeline', body.scrollTop);
                collapsed.timeline = false;
                runSearch();
                body.scrollTop = 0;
                body.querySelector('[data-plan-section="timeline"]')?.scrollIntoView?.({ block: 'start' });
            }

            async function runSearch() {
                win.clearTimeout(filterTimer);
                const seq = ++filterSeq;
                if (!hasFilters(filters) || !model) {
                    filterRows = null;
                    filterError = '';
                    render();
                    return;
                }
                filterRows = null;
                filterError = '';
                render();
                const pid = model.project.id;
                try {
                    const rows = await call(api.projectForgeSearchHistory(searchParams(pid, filters)));
                    if (isDisposed || seq !== filterSeq) return;
                    filterRows = narrowSearchRows(rows, { topicBatchIds: activity ? topicBatchIds : null, exactFile: filters.exactFile });
                } catch (error) {
                    if (isDisposed || seq !== filterSeq) return;
                    filterError = error?.message || '读取失败';
                }
                render();
            }

            function openNode(nodeId) {
                const project = model.project;
                nodeView?.dispose();
                picker.close();
                nodeView = createPlanNodeView({
                    doc, api, storage, h, icon, toast,
                    projectId: project.id,
                    nodeId,
                    writable: project.rootInfo?.writable !== false && !project.deleted_at,
                    onBack: closeNode,
                    onReverted: (result) => {
                        // 侧栏里的回退不进聊天记录，记在这个话题下
                        if (topicMode) recordRevertBatch(storage, topicKey, result?.batchId);
                        closeNode();
                        load();
                    }
                });
                const scrollTop = body.scrollTop;
                nodeView.returnScroll = scrollTop;
                body.innerHTML = '';
                chrome.hidden = true;
                body.appendChild(nodeView.element);
                body.scrollTop = 0;
                nodeView.load();
            }

            function closeNode() {
                const scrollTop = nodeView?.returnScroll || 0;
                nodeView?.dispose();
                nodeView = null;
                render();
                body.scrollTop = scrollTop;
            }

            function switchProject(nextId, nextName = '') {
                if (!nextId || nextId === model?.project?.id) return;
                projectId = nextId;
                pinned = true;
                expanded.clear();
                filters = { ...EMPTY_FILTERS };
                filterRows = null;
                const name = nextName || topicProjects.find(p => p.id === nextId)?.name || '';
                sidePaneController?.updateTab?.(tab.id, { payload: { ...(tab.payload || {}), projectId: nextId, projectName: name, pinned: true, focus: null } });
                load();
            }

            // ---------------------------------------------------------------- 数据

            let lastScope = { projectIds: [], batchIds: new Set(), key: '' };

            async function load() {
                const seq = ++refreshSeq;
                loading = true;
                try {
                    if (topicMode && isCurrentTopic()) lastScope = readScope();
                    const scoped = lastScope;
                    const projects = topicMode ? await listTopicProjects(scoped.projectIds) : [];
                    if (isDisposed || seq !== refreshSeq) return;
                    // 没手动选过工程就和状态面板走同一条规则
                    const chosen = (pinned && projectId) || pickTopicProject(projects)?.id || projectId;
                    if (!chosen) {
                        model = null;
                        errorText = topicMode ? '这个话题还没用过 V工程，可以从上面选一个工程' : '还没有 V工程 工程';
                        loading = false;
                        render();
                        return;
                    }
                    const res = await api?.projectForgeGetProject?.(chosen);
                    if (isDisposed || seq !== refreshSeq) return;
                    if (res?.success && res.data?.project) {
                        const nextModel = buildPlanModel(res.data);
                        let nextActivity = null;
                        let nextOther = { count: 0, more: false };
                        if (topicMode) {
                            const { inTimeline, older } = locateTopicBatches(nextModel.timeline, scoped.batchIds);
                            const entries = await Promise.all([...inTimeline, ...older].map(id => fetchBatch(chosen, id)));
                            if (isDisposed || seq !== refreshSeq) return;
                            nextActivity = buildTopicActivity(entries);
                            const mine = new Set(nextActivity.batches.map(b => b.id));
                            nextOther = { count: nextModel.timeline.filter(r => !mine.has(Number(r.id))).length, more: nextModel.timeline.length >= TIMELINE_LIMIT };
                        }
                        if (model?.project?.id !== chosen) expanded.clear();
                        projectId = chosen;
                        model = nextModel;
                        activity = nextActivity;
                        other = nextOther;
                        topicProjects = projects;
                        topicBatchIds = scoped.batchIds;
                        scopeKey = scoped.key;
                        errorText = '';
                        staleError = '';
                        // 工程改名或切换后标签标题跟着变
                        const name = model.project.name || '';
                        if (name && name !== shownName) {
                            shownName = name;
                            sidePaneController?.updateTab?.(tab.id, { title: `计划 · ${name}`, payload: { ...(tab.payload || {}), projectId, projectName: name, pinned, focus: null } });
                        }
                    } else if (!res?.success && model) {
                        staleError = res?.error || '读取失败';
                    } else {
                        model = null;
                        staleError = '';
                        errorText = res?.error || '';
                    }
                } catch (error) {
                    if (isDisposed || seq !== refreshSeq) return;
                    if (model) {
                        staleError = error?.message || '读取失败';
                    } else {
                        errorText = error?.message || '读取失败';
                    }
                }
                loading = false;
                followProjectWorkspace();
                if (hasFilters(filters) && model) runSearch();
                else render();
            }

            const scheduleLoad = () => {
                win.clearTimeout(timer);
                timer = win.setTimeout(() => { if (!isDisposed) load(); }, REFRESH_DEBOUNCE_MS);
            };
            const off = api?.onProjectForgeChanged?.((payload) => {
                if (!payload?.projectId || payload.projectId === projectId) scheduleLoad();
            });
            // 新的施工结果进了聊天记录（可能晚于工程变更事件）：话题范围变了才重读
            const offTopic = topicMode ? watchTopic?.(() => {
                if (isDisposed || !isCurrentTopic()) return;
                if (readScope().key !== scopeKey) scheduleLoad();
            }) : null;

            const handle = {
                focus() { scheduleLoad(); },
                /** 已打开的标签再次被打开：可以换工程、切页、定位到某条计划 / 某个区块，或展开 Git 页里的某个文件。 */
                reveal({ projectId: nextId = null, focus = null, page = null, focusPath = null } = {}) {
                    if (focus) pendingFocus = focus;
                    if (nodeView && (focus || nextId || page || focusPath)) closeNode();
                    if (page || focusPath) showGitOrPage(page || 'git', focusPath);
                    if (nextId && nextId !== projectId) { switchProject(nextId); return; }
                    if (focus) render();
                },
                dispose() {
                    isDisposed = true;
                    win.clearTimeout(timer);
                    win.clearTimeout(filterTimer);
                    picker.dispose();
                    gitView?.dispose();
                    nodeView?.dispose();
                    if (typeof off === 'function') off();
                    if (typeof offTopic === 'function') offTopic();
                    viewElement.innerHTML = '';
                    viewElement.classList.remove('side-plan-view');
                }
            };

            function showGitOrPage(page, focusPath) {
                if (page !== navigation.selected) {
                    navigation.select(page, body.scrollTop);
                    render();
                    body.scrollTop = navigation.scrollTop;
                }
                if (page === 'git' || focusPath) ensureGit();
                if (focusPath) {
                    // 定位的文件决定工作区，刚读到的工程不要再把它拉回工程的工作区
                    if (!gitProjectId) gitProjectId = FOLLOW_SKIPPED;
                    gitView.focusPath(focusPath);
                }
            }

            const opening = pendingReveal.get(tab.id);
            pendingReveal.delete(tab.id);
            if (opening) showGitOrPage(opening.page || 'git', opening.focusPath);
            render();
            // 已经订阅了工程变化；首次加载出错时先退订再往外抛
            try {
                await load();
            } catch (error) {
                handle.dispose();
                throw error;
            }
            return handle;
        }
    };
}
