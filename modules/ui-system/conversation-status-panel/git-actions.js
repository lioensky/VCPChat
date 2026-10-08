/**
 * modules/ui-system/conversation-status-panel/git-actions.js
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



export function createStatusPanelGitActions({
    store,
    api,
    describeIssue,
    openSwitchBlockedDialog,
    parseSwitchBlockedFiles,
    refreshAfterMutation,
    render,
    toast,
    uniquePaths,
    warnAfterMutation
}) {

    // 只防分支列表请求之间互相覆盖；借用面板刷新的序号的话，agent 改文件触发一次刷新，点分支按钮就没反应
    let branchSeq = 0;
    async function loadBranches() {
        const targetWorkspace = store.workspace;
        const seq = ++branchSeq;
        if (!targetWorkspace || !api?.gitListBranches) return false;
        try {
            const res = await api.gitListBranches(targetWorkspace.id);
            if (store.disposed || seq !== branchSeq || store.workspace?.id !== targetWorkspace.id) return false;
            store.branchList = res?.success ? res.data : null;
            return true;
        } catch (_e) {
            if (!store.disposed && seq === branchSeq) store.branchList = null;
            return false;
        }
    }

    async function runBusy(fn) {
        if (store.busy) return false;
        store.busy = true;
        render(true);
        try {
            return await fn();
        } finally {
            store.busy = false;
            await refreshAfterMutation();
        }
    }

    function adoptBranch(data, targetWorkspace) {
        if (targetWorkspace && store.workspace?.id !== targetWorkspace.id) return;
        if (!data?.status?.branch || !store.summary) return;
        store.summary = { ...store.summary, branch: data.status.branch };
        render(true);
    }

    async function switchBranch(name) {
        const targetWorkspace = store.workspace;
        let blocked = null;
        const ok = await runBusy(async () => {
            const res = await api.gitSwitchBranch(targetWorkspace.id, name);
            const data = res?.data;
            if (res?.success && data?.ok !== false) {
                adoptBranch(data, targetWorkspace);
                toast(`已切换到分支 ${name}`, 'success');
                warnAfterMutation(data);
                return true;
            }
            const message = data?.issues?.[0]?.message || res?.error || '';
            blocked = parseSwitchBlockedFiles(message);
            if (!blocked) toast(`分支操作失败：${message || '切换分支失败，请稍后重试。'}`, 'error');
            return false;
        });
        if (blocked && store.workspace?.id === targetWorkspace.id) openSwitchBlockedDialog(name, blocked);
        return ok;
    }

    async function createBranch(name) {
        const targetWorkspace = store.workspace;
        const created = await runBusy(async () => {
            const res = await api.gitCreateBranch(targetWorkspace.id, name, '');
            const data = res?.data;
            if (!res?.success || data?.ok === false) {
                const message = data?.issues?.[0]?.message || res?.error || '创建分支失败';
                throw new Error(message);
            }
            adoptBranch(data, targetWorkspace);
            toast(`已创建并切换到分支 ${name}`, 'success');
            warnAfterMutation(data);
            return true;
        });
        // runBusy 在另一个 Git 操作进行中时直接返回 false；不抛错的话对话框会当成功关掉
        if (created !== true) throw new Error('另一个 Git 操作正在进行，请稍后再试');
        return true;
    }

    async function pushCurrent(targetWorkspace = store.workspace) {
        if (!targetWorkspace || store.workspace?.id !== targetWorkspace.id) throw new Error('工作区已切换，请重新打开操作。');
        const hasUpstream = Boolean(store.summary?.branch?.upstream);
        let res = await api.gitPush(targetWorkspace.id, hasUpstream ? {} : { setUpstream: true });
        if (!res?.success && res?.code === 'NO_UPSTREAM') res = await api.gitPush(targetWorkspace.id, { setUpstream: true });
        if (!res?.success) throw new Error(describeIssue(res));
        warnAfterMutation(res.data);
    }

    function canPush() {
        const branch = store.summary?.branch;
        if (!branch || branch.detached) return false;
        return (Number(branch.ahead) || 0) > 0 || !branch.upstream;
    }

    async function stageAll(status, targetWorkspace = store.workspace) {
        const paths = uniquePaths(status?.changes);
        if (!paths.length) return;
        const staged = await api.gitStage(targetWorkspace.id, paths);
        if (!staged?.success) throw new Error(describeIssue(staged));
        warnAfterMutation(staged.data);
    }

    return Object.freeze({ loadBranches, runBusy, adoptBranch, switchBranch, createBranch, pushCurrent, canPush, stageAll, dispose() {  } });
}
