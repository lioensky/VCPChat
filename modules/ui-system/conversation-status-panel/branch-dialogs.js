/**
 * modules/ui-system/conversation-status-panel/branch-dialogs.js
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



export function createStatusPanelBranchDialogs({
    store,
    adoptBranch,
    api,
    branchLabel,
    buildCommitMessage,
    button,
    closeAllPopovers,
    closePopover,
    createBranch,
    describeIssue,
    dialogButtons,
    filterBranches,
    h,
    icon,
    loadBranches,
    openGitGraphDialog,
    openModal,
    openPopover,
    popovers,
    refresh,
    refreshAfterMutation,
    spinner,
    stageAll,
    switchBranch,
    toast,
    uniquePaths
}) {

    function branchTrigger({ className = '', popoverClass = '', side = 'bottom', footer = false, onAfterSwitch = null } = {}) {
        const label = h('span', 'zc-branch-label', branchLabel());
        const btn = button(`zc-btn zc-btn-ghost zc-branch-trigger ${className}`.trim(),
            { label: '切换 Git 分支', disabled: store.busy },
            icon('git-branch', 'zc-subtle'), label, store.busy ? spinner() : icon('chevron-down', 'zc-subtle zc-chevron'));
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.addEventListener('click', async () => {
            if (popovers.some(p => p.anchor === btn)) { closeAllPopovers(); return; }
            if (!await loadBranches()) return;
            openBranchPopover(btn, { side, popoverClass, footer, onAfterSwitch });
        });
        return btn;
    }

    async function openBranchSwitcher(anchor, { onAfterSwitch = null, side = 'bottom' } = {}) {
        if (!anchor) return;
        if (popovers.some(p => p.anchor === anchor)) { closeAllPopovers(); return; }
        await refresh();
        if (!store.workspace || !store.summary?.branch) { toast('当前工作区不是 Git 仓库', 'info'); return; }
        if (!await loadBranches()) return;
        openBranchPopover(anchor, { side, popoverClass: 'zc-popover-w72', footer: true, onAfterSwitch });
    }

    function openBranchPopover(anchor, { side, popoverClass, footer, onAfterSwitch }) {
        const branches = store.branchList?.branches || [];
        let query = '';
        let selected = -1;
        let entry = null;

        const input = h('input', 'zc-command-input');
        input.type = 'text';
        input.placeholder = '搜索分支';
        input.setAttribute('aria-label', '搜索分支');
        const inputWrap = h('div', 'zc-command-input-wrap', h('div', 'zc-input-group', icon('search', 'zc-subtlest'), input));
        const list = h('div', 'zc-command-list zc-branch-list');
        const pop = h('div', `zc-branch-popover ${popoverClass}`.trim());
        pop.append(inputWrap, list);

        const pick = branch => {
            closePopover(entry);
            switchBranch(branch.name).then(ok => { if (ok) onAfterSwitch?.(); });
        };

        const renderList = () => {
            list.textContent = '';
            const shown = filterBranches(branches, query);
            if (!shown.length) {
                list.appendChild(h('div', 'zc-command-empty', branches.length ? '未找到匹配分支' : '正在读取分支…'));
                return;
            }
            const group = h('div', 'zc-command-group', h('div', 'zc-command-heading', '分支'));
            shown.forEach((branch, index) => {
                const isCurrent = branch.current;
                const item = h('div', 'zc-command-item zc-branch-item');
                item.dataset.branch = branch.name;
                if (isCurrent) item.dataset.checked = 'true';
                if (index === selected) item.dataset.selected = 'true';
                const text = h('div', 'zc-branch-item-text', h('div', 'zc-branch-name', branch.name));
                if (isCurrent && (store.summary?.files || 0) > 0) {
                    text.appendChild(h('p', 'zc-branch-dirty', `未提交的更改：${store.summary.files} 个文件`));
                }
                item.append(icon('git-branch', 'zc-subtle zc-branch-item-icon'), text);
                if (isCurrent) item.appendChild(icon('check', 'zc-check'));
                item.addEventListener('mousemove', () => {
                    if (selected === index) return;
                    selected = index;
                    syncSelection();
                });
                item.addEventListener('click', () => pick(branch));
                group.appendChild(item);
            });
            list.appendChild(group);
        };
        const syncSelection = () => {
            [...list.querySelectorAll('.zc-command-item')].forEach((node, index) => {
                if (index === selected) node.dataset.selected = 'true';
                else delete node.dataset.selected;
            });
            list.querySelector('.zc-command-item[data-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
        };
        input.addEventListener('input', () => { query = input.value; selected = -1; renderList(); });
        pop.addEventListener('keydown', event => {
            const shown = filterBranches(branches, query);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!shown.length) return;
                selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
                syncSelection();
            } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const target = shown[selected >= 0 ? selected : 0];
                if (target) pick(target);
            } else if (event.key === 'Escape') {
                event.stopPropagation();
                closePopover(entry);
                anchor.focus?.();
            }
        });
        renderList();

        if (footer) {
            pop.appendChild(h('div', 'zc-popover-footer',
                button('zc-btn zc-btn-ghost zc-btn-lg zc-footer-action', { disabled: store.busy, onClick: () => { closePopover(entry); openCreateBranchDialog(); } },
                    icon('plus', 'zc-subtle'), '创建并检出新分支...'),
                button('zc-btn zc-btn-ghost zc-btn-lg zc-footer-action', { onClick: () => { closePopover(entry); openGitGraphDialog(); } },
                    icon('git-graph', 'zc-subtle'), 'Git 图谱')));
        }
        entry = openPopover(pop, anchor, { side, className: 'zc-popover-menu' });
        input.focus();
    }

    function openCreateBranchDialog() {
        let name = '';
        let pending = false;
        const modal = openModal({ className: 'zc-dialog-lg' });
        const input = h('input', 'zc-input');
        input.type = 'text';
        input.id = 'zc-create-branch-input';
        input.placeholder = '例如 feature/git-branch-switcher';
        const error = h('p', 'zc-field-error');
        error.hidden = true;
        const cancel = button('zc-btn zc-btn-secondary zc-btn-xl', { onClick: modal.close }, '取消');
        const submit = button('zc-btn zc-btn-primary zc-btn-xl', { type: 'submit', disabled: true }, '创建并切换');
        const form = h('form', 'zc-dialog-form',
            h('div', 'zc-field',
                (() => { const l = h('label', 'zc-field-label', '分支名'); l.htmlFor = 'zc-create-branch-input'; return l; })(),
                input,
                h('p', 'zc-field-help', '首版只支持基于当前 HEAD 创建并切换。'),
                error),
            dialogButtons(cancel, submit));
        input.addEventListener('input', () => {
            name = input.value;
            submit.disabled = pending || !name.trim();
        });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            pending = true;
            submit.disabled = true;
            cancel.disabled = true;
            submit.prepend(spinner());
            error.hidden = true;
            try {
                await createBranch(name.trim());
                modal.close();
            } catch (e) {
                pending = false;
                cancel.disabled = false;
                submit.disabled = !name.trim();
                submit.querySelector('.zc-spin')?.remove();
                error.textContent = e?.message || '分支操作失败';
                error.hidden = false;
            }
        });
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '创建并检出新分支'),
                h('p', 'zc-dialog-description', '基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。')),
            form);
        input.focus();
    }

    function openSwitchBlockedDialog(target, { files, untracked }) {
        const modal = openModal({ className: 'zc-dialog-lg' });
        const list = h('ul', 'zc-file-list', ...files.slice(0, 8).map(file => h('li', 'zc-file-list-item', file)));
        if (files.length > 8) list.appendChild(h('li', 'zc-file-list-more', `等另外 ${files.length - 8} 个文件`));
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '提交更改以切换分支'),
                h('p', 'zc-dialog-description', untracked ? '以下未跟踪文件会被检出操作覆盖：' : '你对以下文件的更改将被检出操作覆盖：')),
            h('div', 'zc-dialog-form',
                h('div', 'zc-field', h('div', 'zc-field-label', '受影响文件'), list,
                    h('p', 'zc-field-help', '请先提交当前更改，再继续切换分支。')),
                dialogButtons(
                    button('zc-btn zc-btn-secondary zc-btn-xl', { onClick: modal.close }, '取消'),
                    button('zc-btn zc-btn-primary zc-btn-xl', { onClick: () => { modal.close(); openSwitchCommitDialog(target); } }, '提交并切换分支...'))));
    }

    async function openSwitchCommitDialog(target) {
        const targetWorkspace = store.workspace;
        const statusRes = await api.gitStatus(targetWorkspace.id).catch(() => null);
        if (store.disposed || store.workspace?.id !== targetWorkspace.id) return;
        const status = statusRes?.success ? statusRes.data : null;
        const paths = uniquePaths([...(status?.staged || []), ...(status?.changes || [])]);
        let message = '';
        let pending = false;
        const modal = openModal({ className: 'zc-dialog-lg' });
        const textarea = h('textarea', 'zc-textarea');
        textarea.rows = 4;
        textarea.placeholder = '留空以自动生成提交消息';
        const error = h('p', 'zc-field-error');
        error.hidden = true;
        const cancel = button('zc-btn zc-btn-secondary zc-btn-xl', { onClick: modal.close }, '取消');
        const submit = button('zc-btn zc-btn-primary zc-btn-xl', { type: 'submit', disabled: !paths.length }, '提交并切换分支');
        const summaryRow = (label, value) => h('div', 'zc-info-row', h('div', 'zc-info-label', label), h('div', 'zc-info-value', value));
        const form = h('form', 'zc-dialog-form',
            h('div', 'zc-info-card',
                summaryRow('当前分支', branchLabel()),
                summaryRow('目标分支', target),
                summaryRow('更改', `${paths.length} 个文件`)),
            h('div', 'zc-field', h('label', 'zc-field-label', '提交消息'), textarea, error),
            dialogButtons(cancel, submit));
        textarea.addEventListener('input', () => { message = textarea.value; });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (pending) return;
            pending = true;
            submit.disabled = true;
            cancel.disabled = true;
            submit.prepend(spinner());
            error.hidden = true;
            try {
                await stageAll(status, targetWorkspace);
                if (modal.closed || store.workspace?.id !== targetWorkspace.id) return;
                const commitRes = await api.gitCommit(targetWorkspace.id, { message: message.trim() || buildCommitMessage(paths) });
                if (!commitRes?.success) throw new Error(describeIssue(commitRes));
                if (modal.closed || store.workspace?.id !== targetWorkspace.id) return;
                const res = await api.gitSwitchBranch(targetWorkspace.id, target);
                if (!res?.success || res?.data?.ok === false) throw new Error(res?.data?.issues?.[0]?.message || res?.error || '切换分支失败');
                adoptBranch(res.data, targetWorkspace);
                toast(`已切换到分支 ${target}`, 'success');
                modal.close();
                refreshAfterMutation();
            } catch (e) {
                pending = false;
                cancel.disabled = false;
                submit.disabled = false;
                submit.querySelector('.zc-spin')?.remove();
                error.textContent = `提交失败：${e?.message || e}`;
                error.hidden = false;
            }
        });
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '提交更改'),
                h('p', 'zc-dialog-description', `提交完成后会自动继续切换到 ${target}。`)),
            form);
        textarea.focus();
    }

    return Object.freeze({ branchTrigger, openBranchSwitcher, openBranchPopover, openCreateBranchDialog, openSwitchBlockedDialog, openSwitchCommitDialog, dispose() {  } });
}
