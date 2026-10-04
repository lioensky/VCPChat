/**
 * modules/ui-system/conversation-status-panel/commit-dialog.js
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



export function createStatusPanelCommitDialog({
    store,
    api,
    branchTrigger,
    buildCommitMessage,
    button,
    canPush,
    describeIssue,
    formatShortcutLabel,
    h,
    icon,
    isMac,
    openModal,
    openPushDialog,
    pushCurrent,
    refreshAfterMutation,
    spinner,
    stageAll,
    toast,
    uniquePaths
}) {

    async function openCommitDialog() {
        const targetWorkspace = store.workspace;
        if (!store.workspace || !store.summary) return;
        const modal = openModal({ className: 'zc-commit-dialog' });
        modal.dialog.appendChild(h('div', 'zc-commit-loading', spinner()));

        let status = null;
        try {
            const res = await api.gitStatus(targetWorkspace.id);
            status = res?.success ? res.data : null;
        } catch (_e) { /* fallthrough */ }
        if (modal.closed || store.disposed || store.workspace?.id !== targetWorkspace.id) return;
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
            counts.append(h('span', 'zc-added', `+${numberOf(store.summary.added || 0)}`), h('span', 'zc-removed', `-${numberOf(store.summary.removed || 0)}`));
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
                if (modal.closed || store.workspace?.id !== targetWorkspace.id) return;
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

    return Object.freeze({ openCommitDialog, dispose() {  } });
}
