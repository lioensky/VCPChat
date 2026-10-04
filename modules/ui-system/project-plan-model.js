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

export function mapTodoItems(todos) {
    return (todos || []).map((todo, index) => ({
        id: String(todo.id ?? todo.seq ?? index),
        content: String(todo.title || todo.content || ''),
        status: TODO_STATUS[todo.status] || 'pending',
        blocked: todo.status === 'blocked'
    }));
}
