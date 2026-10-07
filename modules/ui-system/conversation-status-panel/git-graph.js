/**
 * modules/ui-system/conversation-status-panel/git-graph.js
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

const GRAPH_PAGE_SIZE = 50;
const NODE_RADIUS = 4;
const SELECTED_NODE_RADIUS = 4.25;
const SELECTED_RING_RADIUS = 5.5;
const LANE_COLORS = ['descendant', 'renamed', 'added', 'modified'];
const SVG_NS = 'http://www.w3.org/2000/svg';

export function createStatusPanelGitGraph({
    store,
    api,
    button,
    describeIssue,
    doc,
    formatCommitTime,
    h,
    icon,
    layoutGitGraph,
    openModal,
    parseGraphRefs,
    spinner,
    toast
}) {

    function svg(tag, attrs = {}) {
        const node = doc.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        return node;
    }

    async function openGitGraphDialog() {
        const targetWorkspace = store.workspace;
        if (!store.workspace) return;
        const modal = openModal({ className: 'zc-graph-dialog' });
        modal.dialog.appendChild(h('div', 'zc-graph-loading', spinner()));
        let commits = [];
        let hasMore = false;
        let selectedHash = null;
        let expandedHash = null;
        let loadingMore = false;
        let refreshing = false;
        // 刷新换掉整份列表；在那之前发出的「加载更多」回来时作废
        let generation = 0;
        const closeBtn = button('zc-btn zc-btn-ghost zc-btn-icon-sm zc-graph-close', { label: '关闭', onClick: modal.close }, icon('x'));

        const fetchPage = async skip => {
            const res = await api.gitCommitGraph(targetWorkspace.id, { maxCount: GRAPH_PAGE_SIZE, skip });
            if (!res?.success) throw new Error(describeIssue(res));
            return res.data;
        };

        // 重画时保住滚动位置和焦点所在的行：点一行看详情、加载更多都不该把人送回顶部
        const paint = ({ keepScroll = true } = {}) => {
            const previousScroll = keepScroll ? (modal.dialog.querySelector('.zc-graph-scroll')?.scrollTop || 0) : 0;
            const focusedHash = modal.dialog.contains(doc.activeElement) ? doc.activeElement?.dataset?.hash || null : null;
            const focusLoadMore = modal.dialog.contains(doc.activeElement) && doc.activeElement?.classList?.contains('zc-graph-load-more');
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
                const current = ++generation;
                loadingMore = false;
                paint();
                let refreshed = false;
                try {
                    const page = await fetchPage(0);
                    if (current !== generation || modal.closed) return;
                    commits = page.commits;
                    hasMore = page.hasMore;
                    selectedHash = commits[0]?.hash ?? null;
                    expandedHash = null;
                    refreshed = true;
                } catch (e) {
                    if (current !== generation || modal.closed) return;
                    toast(`刷新 Git 图谱失败：${e?.message || e}`, 'error');
                }
                refreshing = false;
                paint({ keepScroll: !refreshed });
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
                line.dataset.hash = commit.hash;
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
                const more = button('zc-graph-load-more', { disabled: loadingMore || refreshing }, loadingMore ? '正在加载...' : '加载更多提交');
                more.addEventListener('click', async () => {
                    if (loadingMore || refreshing) return;
                    loadingMore = true;
                    const current = generation;
                    paint();
                    try {
                        const page = await fetchPage(commits.length);
                        if (current !== generation || modal.closed) return;
                        // 两页之间有新提交时分页会错开，已有的提交不再追加一遍
                        const known = new Set(commits.map(commit => commit.hash));
                        commits = [...commits, ...page.commits.filter(commit => !known.has(commit.hash))];
                        hasMore = page.hasMore;
                    } catch (e) {
                        if (current !== generation || modal.closed) return;
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
            const scroll = h('div', 'zc-graph-scroll', table);
            modal.dialog.appendChild(scroll);
            scroll.scrollTop = previousScroll;
            const refocus = focusedHash ? rows.querySelector(`[data-hash="${focusedHash}"]`) : focusLoadMore ? rows.querySelector('.zc-graph-load-more') : null;
            refocus?.focus({ preventScroll: true });

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
            if (modal.closed || store.disposed || store.workspace?.id !== targetWorkspace.id) return;
            paint();
        } catch (e) {
            if (modal.closed) return;
            modal.dialog.textContent = '';
            modal.dialog.append(closeBtn, h('div', 'zc-graph-error',
                h('div', 'zc-graph-error-card', icon('circle-alert', 'zc-warning'), h('p', '', `Git 图谱加载失败：${e?.message || e}`))));
        }
    }

    return Object.freeze({ svg, openGitGraphDialog, dispose() {  } });
}
