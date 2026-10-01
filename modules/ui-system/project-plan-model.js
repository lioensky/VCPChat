// Shared ProjectForge projections used by Git, plan detail and conversation status.
export function pickProjectsForWorkspace(projects, workspace) {
    if (!workspace) return [];
    return (projects || [])
        .filter(p => !p.deleted_at && (p.workspace_id === workspace.id || (workspace.alias && p.workspace_alias === workspace.alias)))
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
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
