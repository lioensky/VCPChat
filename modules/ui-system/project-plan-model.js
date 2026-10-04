// Shared ProjectForge projections used by Git, plan detail and conversation status.
export function pickProjectsForWorkspace(projects, workspace) {
    if (!workspace) return [];
    return (projects || [])
        .filter(p => !p.deleted_at && (p.workspace_id === workspace.id || (workspace.alias && p.workspace_alias === workspace.alias)))
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

/**
 * 话题用过多个 V工程 时，状态面板和侧栏计划显示同一个：最近用过、有计划条目的那个，都没有计划就取最近用过的。
 * @param {object[]} projects 工程摘要（project-forge:list-projects，带 progress），最近的在前
 */
export function pickTopicProject(projects) {
    const list = (projects || []).filter(Boolean);
    return list.find(p => Number(p.progress?.total) > 0) || list[0] || null;
}

const TODO_STATUS = Object.freeze({ done: 'completed', doing: 'inProgress', pending: 'pending', blocked: 'pending' });

/**
 * 状态面板计划下的一行概要：这个话题在该工程里施工了几批、改了多少行、最近一次是什么时候。
 * 只看工程时间线（最近 200 批）里属于这个话题的批次，没有节点的批次（施工失败）不算。
 * @param {object[]} timeline project-forge:get-project 的 timeline
 * @param {Iterable<number>} batchIds 话题的批次号（conversation-scope.js 的 batchIds 加上回退批次）
 * @returns {{ count: number, added: number, removed: number, lastAt: string } | null}
 */
export function summarizeTopicBatches(timeline, batchIds) {
    const ids = new Set([...(batchIds || [])].map(Number));
    if (!ids.size) return null;
    const rows = (Array.isArray(timeline) ? timeline : [])
        .filter(row => ids.has(Number(row.id)) && Number(row.node_count) > 0);
    if (!rows.length) return null;
    return {
        count: rows.length,
        added: rows.reduce((total, row) => total + (Number(row.added) || 0), 0),
        removed: rows.reduce((total, row) => total + (Number(row.removed) || 0), 0),
        lastAt: rows.reduce((last, row) => (String(row.created_at || '') > last ? String(row.created_at) : last), '')
    };
}

export function mapTodoItems(todos) {
    return (todos || []).map((todo, index) => ({
        id: String(todo.id ?? todo.seq ?? index),
        content: String(todo.title || todo.content || ''),
        status: TODO_STATUS[todo.status] || 'pending',
        blocked: todo.status === 'blocked'
    }));
}
