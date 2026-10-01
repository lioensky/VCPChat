/**
 * modules/ui-system/side-pane/planDetailSideProvider.js
 * VCPChat Universal Sub-screen - V工程 计划详情 Provider
 *
 * 对应 ZCode 的 PlanDetailSidePane（在侧栏里整页阅读一份计划），数据来自 VCPChat 自己的 V工程（ProjectForge）：
 * 进程（todo）、变更文件、施工时间线、参与者。工程变更时经 onProjectForgeChanged 实时刷新。
 * 面板样式沿用 status-panel 的 zc-* 变量，保持与状态面板一致。
 */

'use strict';

import { mapTodoItems, pickProjectsForWorkspace } from '../project-plan-model.js';
import { formatRelativeTime } from './side-pane-tab-utils.js';

const STORAGE_KEY_WS = 'vcp-projectforge-git-workspace';
const TAB_PREFIX = 'plan-detail:';
const REFRESH_DEBOUNCE_MS = 200;

const STATUS_LABEL = Object.freeze({ completed: '已完成', inProgress: '进行中', pending: '待处理' });
const STATUS_ICON = Object.freeze({ completed: 'check_circle', inProgress: 'progress_activity', pending: 'radio_button_unchecked' });
const KIND_LABEL = Object.freeze({ create: '创建', edit: '修改', delete: '删除', revert: '回退', rename: '重命名' });
const KIND_ICON = Object.freeze({ create: 'add_circle', edit: 'edit', delete: 'delete', revert: 'undo', rename: 'drive_file_rename_outline' });

export function planTabId(projectId) {
    return `${TAB_PREFIX}${projectId}`;
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

export function createPlanDetailSideProvider({
    document: doc = document,
    api = (typeof window !== 'undefined' ? window.electronAPI : null),
    sidePaneController = null,
    uiHelper = null,
    onOpenProjectForge = null
} = {}) {
    const kind = 'plan-detail';
    const win = doc.defaultView || window;
    const storage = (() => { try { return win.localStorage; } catch (_e) { return null; } })();
    const toast = (message, type = 'info') => uiHelper?.showToastNotification?.(message, type);

    return {
        kind,

        /**
         * 打开（或聚焦）某个 V工程 的计划详情；不传 projectId 时选默认工程。
         * 没有任何工程时给出提示而不是开一个空标签。
         */
        async openPlanDetailTab({ projectId = null, projectName = '' } = {}) {
            if (!sidePaneController) return null;
            let id = projectId;
            let name = projectName;
            if (!id) {
                const project = await resolveDefaultProject(api, storage);
                if (!project) {
                    toast('还没有 V工程 工程：让管家用 ProjectForge 创建工程后，这里会显示它的计划', 'info');
                    return null;
                }
                id = project.id;
                name = project.name;
            }
            const handle = await sidePaneController.openTab({
                id: planTabId(id),
                kind,
                title: name ? `计划 · ${name}` : '计划详情',
                icon: 'checklist',
                closable: true,
                scopeMode: 'global',
                searchHint: name || '',
                payload: { projectId: id, projectName: name }
            });
            sidePaneController.setVisible?.(true);
            handle?.focus?.();
            return handle;
        },

        async mountTab(tab, viewElement) {
            if (!viewElement) return null;
            const projectId = tab?.payload?.projectId || String(tab?.id || '').slice(TAB_PREFIX.length);
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

            const scope = h('div', 'zc-scope vcp-ui-scope side-plan-scope');
            const body = h('div', 'side-plan-body');
            scope.appendChild(body);
            viewElement.appendChild(scope);

            let isDisposed = false;
            let model = null;
            let errorText = '';
            let staleError = ''; // 刷新失败但还留着上一次的内容（ZCode：lastMarkdown 保留，不因一次失败清空）
            let loading = true;
            let refreshSeq = 0;
            let timer = null;
            let shownName = tab?.payload?.projectName || '';
            const collapsed = { files: false, timeline: false };

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

            function renderHeader() {
                const { project, counts } = model;
                const head = h('header', 'side-plan-header');
                const titleRow = h('div', 'side-plan-title-row');
                titleRow.appendChild(h('h2', 'side-plan-title', project.name || '未命名工程'));
                const statusText = project.status === 'active' ? '进行中' : project.status === 'closed' ? '已收尾' : (project.status || '');
                if (statusText) titleRow.appendChild(h('span', `side-plan-chip status-${project.status || 'unknown'}`, statusText));
                const actions = h('div', 'side-plan-actions');
                const refreshBtn = h('button', 'side-plan-icon-btn');
                refreshBtn.type = 'button';
                refreshBtn.title = '刷新';
                refreshBtn.setAttribute('aria-label', '刷新');
                refreshBtn.appendChild(icon('refresh'));
                refreshBtn.addEventListener('click', () => load());
                actions.appendChild(refreshBtn);
                if (onOpenProjectForge) {
                    const forgeBtn = h('button', 'side-plan-icon-btn');
                    forgeBtn.type = 'button';
                    forgeBtn.title = '在 V工程 中查看与回退';
                    forgeBtn.setAttribute('aria-label', '在 V工程 中查看与回退');
                    forgeBtn.appendChild(icon('folder_open'));
                    forgeBtn.addEventListener('click', () => onOpenProjectForge());
                    actions.appendChild(forgeBtn);
                }
                titleRow.appendChild(actions);
                head.appendChild(titleRow);

                const meta = h('div', 'side-plan-meta');
                if (project.created_by) meta.appendChild(h('span', '', `创建：${project.created_by}`));
                if (project.updated_at) meta.appendChild(h('span', '', `更新 ${formatRelativeTime(Date.parse(project.updated_at))}`));
                if (project.workspace_alias) meta.appendChild(h('span', '', `工作区 ${project.workspace_alias}`));
                head.appendChild(meta);
                if (project.root) {
                    const root = h('div', 'side-plan-root', project.root);
                    root.title = project.root;
                    head.appendChild(root);
                }
                if (project.rootInfo && project.rootInfo.writable === false && project.rootInfo.blockedReason) {
                    head.appendChild(h('div', 'side-plan-warning', project.rootInfo.blockedReason));
                }

                if (counts.total > 0) {
                    const pct = Math.round((counts.completed / counts.total) * 100);
                    const progress = h('progress', 'side-plan-progress');
                    progress.max = counts.total;
                    progress.value = counts.completed;
                    progress.setAttribute('aria-label', `计划进度 ${pct}%`);
                    const summary = h('div', 'side-plan-progress-text');
                    summary.append(
                        h('span', counts.completed >= counts.total ? 'side-plan-done' : '', `${counts.completed}/${counts.total} 已完成`),
                        h('span', '', counts.inProgress ? `${counts.inProgress} 进行中` : ''),
                        h('span', 'side-plan-pct', `${pct}%`)
                    );
                    head.append(progress, summary);
                }
                return head;
            }

            function renderTodos() {
                if (!model.items.length) {
                    return section('计划', '', null, h('div', 'side-plan-empty', '这个工程还没有进程条目'));
                }
                const list = h('ol', 'side-plan-todos');
                model.items.forEach((item, index) => {
                    const row = h('li', `side-plan-todo status-${item.status}${item.blocked ? ' blocked' : ''}`);
                    row.dataset.todoStatus = item.status;
                    const mark = h('span', 'side-plan-todo-mark');
                    mark.appendChild(icon(item.blocked ? 'cancel' : STATUS_ICON[item.status], item.status === 'inProgress' && !item.blocked ? 'spin' : ''));
                    const text = h('div', 'side-plan-todo-text');
                    const title = h('div', 'side-plan-todo-title');
                    title.append(h('span', 'side-plan-todo-seq', String(index + 1)), h('span', '', item.content));
                    text.appendChild(title);
                    const sub = [item.blocked ? '已阻塞' : STATUS_LABEL[item.status], item.updatedBy, item.updatedAt ? formatRelativeTime(Date.parse(item.updatedAt)) : '']
                        .filter(Boolean).join(' · ');
                    text.appendChild(h('div', 'side-plan-todo-sub', sub));
                    if (item.note) text.appendChild(h('div', 'side-plan-todo-note', item.note));
                    row.append(mark, text);
                    list.appendChild(row);
                });
                return section('计划', `${model.counts.completed}/${model.counts.total}`, null, list);
            }

            function renderFiles() {
                if (!model.files.length) return null;
                const list = h('ul', 'side-plan-files');
                model.files.forEach(file => {
                    const row = h('li', 'side-plan-file');
                    const name = h('span', 'side-plan-file-name', file.file_path);
                    name.title = file.file_path;
                    row.append(icon('description'), name, h('span', 'side-plan-file-edits', `${file.edits} 次`), diffStat(file.added, file.removed));
                    list.appendChild(row);
                });
                const meta = `${model.files.length} 个 · +${model.added} -${model.removed}`;
                return section('变更文件', meta, 'files', list);
            }

            function renderTimeline() {
                if (!model.timeline.length) return null;
                const list = h('ol', 'side-plan-timeline');
                model.timeline.forEach(batch => {
                    const row = h('li', `side-plan-batch kind-${batch.kind}`);
                    const mark = h('span', 'side-plan-batch-mark');
                    mark.appendChild(icon(KIND_ICON[batch.kind] || 'commit'));
                    const text = h('div', 'side-plan-batch-text');
                    text.appendChild(h('div', 'side-plan-batch-reason', batch.reason || `${KIND_LABEL[batch.kind] || batch.kind} #${batch.id}`));
                    const sub = h('div', 'side-plan-batch-sub');
                    sub.append(
                        h('span', '', `#${batch.id}`),
                        h('span', '', KIND_LABEL[batch.kind] || batch.kind),
                        h('span', '', batch.maid || ''),
                        h('span', '', batch.created_at ? formatRelativeTime(Date.parse(batch.created_at)) : ''),
                        diffStat(batch.added, batch.removed)
                    );
                    text.appendChild(sub);
                    if (Array.isArray(batch.files) && batch.files.length) {
                        const files = h('div', 'side-plan-batch-files', batch.files.join('、'));
                        files.title = batch.files.join('\n');
                        text.appendChild(files);
                    }
                    row.append(mark, text);
                    list.appendChild(row);
                });
                return section('施工时间线', `${model.timeline.length} 批`, 'timeline', list);
            }

            function renderContributors() {
                if (!model.contributors.length) return null;
                const list = h('ul', 'side-plan-contributors');
                model.contributors.forEach(c => {
                    const row = h('li', 'side-plan-contributor');
                    row.append(icon('person'), h('span', 'side-plan-contributor-name', c.maid), h('span', 'side-plan-contributor-batches', `${c.batches} 批`), diffStat(c.added, c.removed));
                    list.appendChild(row);
                });
                return section('参与者', '', null, list);
            }

            function render() {
                if (isDisposed) return;
                const scrollTop = body.scrollTop;
                body.innerHTML = '';
                if (loading && !model) {
                    body.appendChild(h('div', 'side-plan-empty', '正在读取 V工程 计划…'));
                    return;
                }
                if (!model) {
                    const box = h('div', 'side-plan-empty side-plan-error');
                    box.appendChild(h('div', '', errorText || '没有找到这个工程，可能已被删除'));
                    const retry = h('button', 'zc-btn zc-btn-ghost', '重试');
                    retry.type = 'button';
                    retry.addEventListener('click', () => load());
                    box.appendChild(retry);
                    body.appendChild(box);
                    return;
                }
                if (staleError) {
                    const banner = h('div', 'side-plan-warning side-plan-stale');
                    banner.setAttribute('role', 'alert');
                    const retry = h('button', 'zc-btn zc-btn-ghost', '重试');
                    retry.type = 'button';
                    retry.addEventListener('click', () => load());
                    banner.append(h('span', '', `刷新失败，显示的是上一次的内容：${staleError}`), retry);
                    body.appendChild(banner);
                }
                body.appendChild(renderHeader());
                body.appendChild(renderTodos());
                [renderFiles(), renderTimeline(), renderContributors()].forEach(node => { if (node) body.appendChild(node); });
                body.scrollTop = scrollTop;
            }

            async function load() {
                const seq = ++refreshSeq;
                loading = true;
                try {
                    const res = await api?.projectForgeGetProject?.(projectId);
                    if (isDisposed || seq !== refreshSeq) return;
                    if (res?.success && res.data?.project) {
                        model = buildPlanModel(res.data);
                        errorText = '';
                        staleError = '';
                        // 工程改名后标签标题跟着变
                        const name = model.project.name || '';
                        if (name && name !== shownName) {
                            shownName = name;
                            sidePaneController?.updateTab?.(tab.id, { title: `计划 · ${name}`, payload: { ...(tab.payload || {}), projectId, projectName: name } });
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
                render();
            }

            const scheduleLoad = () => {
                win.clearTimeout(timer);
                timer = win.setTimeout(() => { if (!isDisposed) load(); }, REFRESH_DEBOUNCE_MS);
            };
            const off = api?.onProjectForgeChanged?.((payload) => {
                if (!payload?.projectId || payload.projectId === projectId) scheduleLoad();
            });

            render();
            await load();

            return {
                focus() { scheduleLoad(); },
                dispose() {
                    isDisposed = true;
                    win.clearTimeout(timer);
                    if (typeof off === 'function') off();
                    viewElement.innerHTML = '';
                    viewElement.classList.remove('side-plan-view');
                }
            };
        }
    };
}
