// schema/workspace-management — "工作区管理" 分区。
// 工作区列表的持久化权威是主进程 workspaces:* IPC（settings.workspaces），
// 不经过表单 collect/自动保存：save-settings 会剔除 workspaces 键，防止旧快照覆盖。
// 面板在编译期只产出结构；挂载到真实窗口（存在 electronAPI）后异步水合列表。
// 后续 VCPCode 相关能力（工作区级工具权限等）也在本分区扩展。
import { section, card, custom } from './kernel.js';

const REFRESH_WHILE_SCANNING_MS = 1500;

function getApi(doc) {
    const win = doc?.defaultView;
    const api = win?.chatAPI || win?.electronAPI;
    return api && typeof api.listWorkspaces === 'function' ? api : null;
}

function makeButton(doc, label, { className = 'sidebar-button small-button', ariaLabel } = {}) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    return button;
}

function describeStatus(ws) {
    if (!ws.enabled) return '已停用';
    switch (ws.status) {
        case 'scanning': return '索引中…';
        case 'ready': return `${ws.fileCount} 个文件${ws.truncated ? '（已达上限，部分未索引）' : ''}${ws.watching ? '' : ' · 定时刷新'}`;
        case 'error': return `错误：${ws.error || '未知'}`;
        default: return '等待索引';
    }
}

function buildWorkspacePanel(doc) {
    const row = doc.createElement('div');
    row.className = 'vcp-settings-row vcp-settings-row-stacked vcp-workspace-panel';

    const intro = doc.createElement('small');
    intro.className = 'vcp-workspace-intro';
    intro.textContent = '登记本地项目目录后，可在输入框用 @文件名 或 @别名/路径 引用其中的文件；拖拽或选择工作区内的文本文件也会以真实路径实时引用，AI 可直接读取和修改。已自动忽略 .git、node_modules、__pycache__、虚拟环境等目录，并遵循各级 .gitignore。';

    const list = doc.createElement('ul');
    list.id = 'workspaceManagerList';
    list.className = 'vcp-workspace-list';
    list.setAttribute('aria-label', '已登记的工作区');

    const status = doc.createElement('div');
    status.id = 'workspaceManagerStatus';
    status.className = 'vcp-workspace-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const actions = doc.createElement('div');
    actions.className = 'vcp-workspace-actions';
    const addButton = makeButton(doc, '添加工作区', { className: 'sidebar-button small-button vcp-settings-card-add-row' });
    addButton.id = 'addWorkspaceBtn';
    const rebuildAllButton = makeButton(doc, '重建全部索引');
    rebuildAllButton.id = 'rebuildWorkspacesBtn';
    actions.append(addButton, rebuildAllButton);

    row.append(intro, list, actions, status);

    // 面板内的编辑不属于全局设置表单，阻止事件冒泡触发表单脏标记 / 自动保存。
    for (const type of ['input', 'change']) {
        row.addEventListener(type, event => event.stopPropagation());
    }

    queueMicrotask(() => hydrateWorkspacePanel(doc, { list, status, addButton, rebuildAllButton }));
    return row;
}

function hydrateWorkspacePanel(doc, refs) {
    const api = getApi(doc);
    if (!api) return; // 测试 / 非聊天窗口：只保留结构
    const { list, status, addButton, rebuildAllButton } = refs;
    let refreshTimer = null;

    const setStatus = (message, isError = false) => {
        status.textContent = message || '';
        status.classList.toggle('is-error', Boolean(isError));
    };

    const handleResult = (result, successMessage = '') => {
        if (!result?.success) {
            setStatus(result?.error || '操作失败', true);
            if (Array.isArray(result?.workspaces)) render(result.workspaces);
            return false;
        }
        setStatus(successMessage);
        if (Array.isArray(result.workspaces)) render(result.workspaces);
        return true;
    };

    const scheduleRefreshIfScanning = workspaces => {
        clearTimeout(refreshTimer);
        if (!list.isConnected && list.ownerDocument?.contains?.(list) === false) return;
        if (workspaces.some(ws => ws.enabled && (ws.status === 'scanning' || ws.status === 'idle'))) {
            refreshTimer = setTimeout(refresh, REFRESH_WHILE_SCANNING_MS);
        }
    };

    function render(workspaces) {
        list.replaceChildren();
        if (workspaces.length === 0) {
            const empty = doc.createElement('li');
            empty.className = 'vcp-workspace-empty';
            empty.textContent = '尚未添加工作区。';
            list.append(empty);
        }
        for (const ws of workspaces) {
            const item = doc.createElement('li');
            item.className = 'vcp-workspace-item';
            item.dataset.workspaceId = ws.id;
            item.classList.toggle('is-disabled', !ws.enabled);

            const head = doc.createElement('div');
            head.className = 'vcp-workspace-item-head';
            const aliasLabel = doc.createElement('label');
            aliasLabel.className = 'vcp-workspace-alias-label';
            aliasLabel.textContent = '@';
            const aliasInput = doc.createElement('input');
            aliasInput.type = 'text';
            aliasInput.className = 'vcp-workspace-alias';
            aliasInput.value = ws.alias;
            aliasInput.setAttribute('aria-label', `工作区别名（${ws.path}）`);
            aliasInput.spellcheck = false;
            aliasLabel.append(aliasInput);

            const enableLabel = doc.createElement('label');
            enableLabel.className = 'vcp-workspace-enable';
            const enableInput = doc.createElement('input');
            enableInput.type = 'checkbox';
            enableInput.checked = ws.enabled;
            enableInput.setAttribute('aria-label', `启用工作区 ${ws.alias}`);
            const enableText = doc.createElement('span');
            enableText.textContent = '启用';
            enableLabel.append(enableInput, enableText);
            head.append(aliasLabel, enableLabel);

            const pathNode = doc.createElement('div');
            pathNode.className = 'vcp-workspace-path';
            pathNode.textContent = ws.path;
            pathNode.title = ws.path;

            const meta = doc.createElement('div');
            meta.className = 'vcp-workspace-meta';
            meta.textContent = describeStatus(ws);

            const itemActions = doc.createElement('div');
            itemActions.className = 'vcp-workspace-item-actions';
            const rebuildButton = makeButton(doc, '重建索引', { ariaLabel: `重建工作区 ${ws.alias} 的索引` });
            const removeButton = makeButton(doc, '删除', { className: 'sidebar-button small-button danger-button', ariaLabel: `删除工作区 ${ws.alias}` });
            itemActions.append(rebuildButton, removeButton);

            const commitAlias = async () => {
                const next = aliasInput.value.trim();
                if (!next || next === ws.alias) {
                    aliasInput.value = ws.alias;
                    return;
                }
                handleResult(await api.updateWorkspace(ws.id, { alias: next }), '别名已更新。');
            };
            aliasInput.addEventListener('change', commitAlias);
            aliasInput.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    aliasInput.blur();
                } else if (event.key === 'Escape') {
                    aliasInput.value = ws.alias;
                    aliasInput.blur();
                }
            });
            enableInput.addEventListener('change', async () => {
                const ok = handleResult(await api.updateWorkspace(ws.id, { enabled: enableInput.checked }));
                if (ok) void refresh();
            });
            rebuildButton.addEventListener('click', async () => {
                rebuildButton.disabled = true;
                setStatus(`正在重建 ${ws.alias} 的索引…`);
                handleResult(await api.rebuildWorkspaceIndex(ws.id), `${ws.alias} 索引已重建。`);
                rebuildButton.disabled = false;
            });
            removeButton.addEventListener('click', async () => {
                const confirmFn = doc.defaultView?.confirm;
                if (typeof confirmFn === 'function' && !confirmFn(`删除工作区 "${ws.alias}"？\n只会取消登记，不会删除磁盘上的任何文件。`)) return;
                handleResult(await api.removeWorkspace(ws.id), `已删除 ${ws.alias}。`);
            });

            item.append(head, pathNode, meta, itemActions);
            list.append(item);
        }
        scheduleRefreshIfScanning(workspaces);
    }

    async function refresh() {
        try {
            const result = await api.listWorkspaces();
            if (result?.success) render(result.workspaces || []);
        } catch (error) {
            setStatus(`读取工作区失败：${error.message}`, true);
        }
    }

    addButton.addEventListener('click', async () => {
        const picked = await api.selectWorkspaceDirectory();
        if (!picked?.success || !picked.path) return;
        setStatus('正在添加并建立索引…');
        handleResult(await api.addWorkspace(picked.path), '已添加工作区，索引在后台建立。');
    });
    rebuildAllButton.addEventListener('click', async () => {
        rebuildAllButton.disabled = true;
        setStatus('正在重建全部索引…');
        handleResult(await api.rebuildWorkspaceIndex(null), '全部索引已重建。');
        rebuildAllButton.disabled = false;
    });

    void refresh();
}

export const workspaceManagementSection = section('workspace-management', '工作区管理', [
    card('workspaceManager', {
        cardKey: 'workspace-manager',
        title: '本地工作区',
        description: '登记项目目录，供 @ 引用、拖拽和附件以真实路径实时映射。',
        fields: [
            custom('workspaceManagerPanel', buildWorkspacePanel),
        ],
    }),
]);