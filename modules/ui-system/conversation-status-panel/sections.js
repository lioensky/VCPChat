/**
 * modules/ui-system/conversation-status-panel/sections.js
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

import { formatRelativeTime } from '../side-pane/side-pane-tab-utils.js';

const RECENT_RUN_WINDOW_MS = 30 * 60 * 1000;
const MAX_RUN_ROWS = 4;

export function createStatusPanelSections({
    store,
    branchTrigger,
    button,
    canPush,
    closePopover,
    diffCounts,
    getTodoFocusWindow,
    h,
    icon,
    normalizeCommand,
    onOpenGitTab,
    onOpenPlanDetail,
    onOpenToolOutput,
    openCommitDialog,
    openPopover,
    openPushDialog,
    pickMiniMetric,
    render,
    onToggleSection,
    scoped,
    setVariant,
    win
}) {

    function sectionHeader(key, title, trailing, extra) {
        const open = store.sectionOpen[key];
        const trigger = button('zc-section-trigger', {},
            h('span', 'zc-section-title', title),
            icon(open ? 'chevron-down' : 'chevron-right', 'zc-chevron'));
        trigger.setAttribute('aria-expanded', String(open));
        trigger.dataset.statusSectionTrigger = key;
        trigger.addEventListener('click', () => { onToggleSection(key); });
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
        const git = store.summary;
        const hasChanges = (git.added || 0) + (git.removed || 0) > 0;
        const primaryPush = !git.files && canPush();
        const primaryDisabled = store.busy || (!git.files && !canPush());

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
                iconName: store.busy ? 'loader-circle' : (primaryPush ? 'arrow-up-from-line' : 'git-commit-horizontal'),
                label: '提交或推送',
                disabled: primaryDisabled,
                className: 'zc-row-commit',
                onClick: () => (primaryPush ? openPushDialog() : openCommitDialog())
            }));
        const section = h('section', 'zc-section');
        section.dataset.statusSection = 'environment';
        section.appendChild(sectionHeader('git', 'Git 变更', open => (open ? null : h('span', 'zc-diff-inline',
            h('span', `zc-added${hasChanges ? '' : ' is-dim'}`, `+${git.added || 0}`), ' ',
            h('span', `zc-removed${hasChanges ? '' : ' is-dim'}`, `-${git.removed || 0}`)))));
        if (store.sectionOpen.git) section.appendChild(body);
        return section;
    }

    function recentCommandRuns() {
        const cutoff = Date.now() - RECENT_RUN_WINDOW_MS;
        return store.commandRuns
            .filter(run => !scoped || store.scope.commands.has(normalizeCommand(run.command)))
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
        // 名字与侧栏「命令输出」标签一致；关联方式写进提示里
        const header = sectionHeader('runs', '命令输出',
            () => h('span', 'zc-tabular zc-subtle', running ? `${running} 运行中` : `${runs.length}`));
        header.firstChild.title = '按命令文本关联，可能包含其他话题发起的同名命令';
        section.appendChild(header);
        if (store.sectionOpen.runs) section.appendChild(body);
        return section;
    }

    function planStatusIcon(item) {
        if (item.status === 'completed') return icon('circle-check-big', 'zc-plan-icon zc-success');
        if (item.status === 'inProgress') return icon('arrow-right', 'zc-plan-icon zc-fg');
        return icon(item.blocked ? 'circle-alert' : 'circle', 'zc-plan-icon zc-subtlest');
    }

    // 点计划条目在侧栏计划里定位到这一条
    function planItemRows(items) {
        return items.map(item => {
            const row = h('li', 'zc-plan-item',
                planStatusIcon(item),
                h('span', `zc-plan-text${item.status === 'completed' ? ' is-done' : ''}`, item.content));
            row.dataset.planStatus = item.status;
            row.title = item.blocked ? `${item.content}（受阻）` : item.content;
            if (onOpenPlanDetail) {
                const open = () => onOpenPlanDetail(store.plan?.project, { todoId: item.id });
                row.classList.add('is-link');
                row.tabIndex = 0;
                row.setAttribute('role', 'button');
                row.title = `${row.title} · 在侧栏计划中查看`;
                row.addEventListener('click', open);
                row.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    open();
                });
            }
            return row;
        });
    }

    // 计划下的一行：这个话题施工了几批，点开侧栏时间线
    function planActivityRow(activity) {
        if (!activity) return null;
        // 和侧栏计划同样的相对时间
        const time = activity.lastAt ? formatRelativeTime(Date.parse(activity.lastAt)) : '';
        const content = [
            icon('history', 'zc-plan-icon zc-subtlest'),
            h('span', 'zc-plan-activity-text', `本话题 ${activity.count} 批`),
            h('span', 'zc-added zc-tabular', `+${activity.added}`),
            h('span', 'zc-removed zc-tabular', `−${activity.removed}`),
            time ? h('span', 'zc-subtle zc-tabular', time) : null
        ];
        if (!onOpenPlanDetail) return h('div', 'zc-plan-activity', ...content);
        const row = button('zc-plan-activity', { label: '在侧栏查看本话题的改动时间线', onClick: () => onOpenPlanDetail(store.plan?.project, { section: 'timeline' }) }, ...content);
        row.title = '在侧栏查看本话题的改动时间线';
        return row;
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
        const items = store.plan.items;
        const completed = items.filter(item => item.status === 'completed').length;
        const isCompleted = items.length > 0 && completed >= items.length;
        const focus = getTodoFocusWindow(items);
        const list = h('ul', 'zc-plan-list');
        if (focus.compact && focus.precedingItems.length) list.appendChild(hiddenGroup('preceding', focus.precedingItems));
        planItemRows(focus.focusItems).forEach(row => list.appendChild(row));
        if (focus.compact && focus.followingItems.length) list.appendChild(hiddenGroup('following', focus.followingItems));

        const openDetail = onOpenPlanDetail
            ? button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-section-action', { label: '打开计划详情', onClick: () => onOpenPlanDetail(store.plan.project) }, icon('checklist'))
            : null;
        if (openDetail) openDetail.title = `${store.plan.project?.name || 'V工程'} · 打开计划详情`;

        const section = h('section', 'zc-section');
        section.dataset.statusSection = 'plan';
        section.appendChild(sectionHeader('plan', '计划',
            () => h('span', `zc-tabular${isCompleted ? ' zc-success' : ' zc-subtle'}`, `${completed}/${items.length}`), openDetail));
        if (store.sectionOpen.plan) section.appendChild(h('div', 'zc-section-body zc-scroll-plan', planActivityRow(store.plan.activity), list));
        return section;
    }

    function renderMini() {
        const metric = pickMiniMetric({ items: store.plan?.items || [], git: store.summary });
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

    return Object.freeze({ sectionHeader, rowButton, renderGitSection, recentCommandRuns, renderRunsSection, planStatusIcon, planItemRows, hiddenGroup, renderPlanSection, renderMini, dispose() {  } });
}
