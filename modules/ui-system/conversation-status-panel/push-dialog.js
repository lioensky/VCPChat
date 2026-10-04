/**
 * modules/ui-system/conversation-status-panel/push-dialog.js
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



export function createStatusPanelPushDialog({
    store,
    branchLabel,
    button,
    canPush,
    dialogButtons,
    h,
    icon,
    openModal,
    pushCurrent,
    refreshAfterMutation,
    spinner,
    toast,
    win
}) {

    function openPushDialog() {
        const targetWorkspace = store.workspace;
        if (!store.workspace || !store.summary) return;
        const branch = store.summary.branch || {};
        const ahead = Number(branch.ahead) || 0;
        const behind = Number(branch.behind) || 0;
        const tracked = Boolean(branch.upstream);
        const pushEnabled = canPush();
        const modal = openModal({ className: 'zc-dialog-lg' });
        let pending = false;
        let errorText = '';

        const body = h('div', 'zc-dialog-form');
        const footer = dialogButtons();

        const infoRow = (label, value, extra = '') => h('div', `zc-info-row ${extra}`.trim(), h('div', 'zc-info-label', label), h('div', 'zc-info-value', value));

        const paint = () => {
            body.textContent = '';
            footer.textContent = '';
            if (!errorText) {
                body.appendChild(h('div', 'zc-info-card',
                    h('div', 'zc-info-row zc-info-row-top', h('div', 'zc-info-label', '分支'),
                        h('div', 'zc-info-value zc-info-branch', icon('git-branch', 'zc-subtle'), h('span', '', branchLabel()))),
                    h('div', 'zc-info-section',
                        infoRow('远程分支', tracked ? branch.upstream : '首次推送会自动为当前分支建立上游分支。'),
                        infoRow('同步状态', `领先 ${ahead} / 落后 ${behind}`),
                        h('div', 'zc-info-row zc-info-row-divider', h('div', 'zc-info-label', '后续步骤'),
                            h('div', 'zc-info-value zc-info-next', icon('arrow-up-from-line'), h('span', '', '推送'))))));
            }
            if (!pushEnabled && !errorText) {
                body.appendChild(h('div', 'zc-warning-banner', icon('circle-alert'), h('span', '', '当前分支没有需要推送的提交。')));
            }
            if (errorText) {
                const area = h('textarea', 'zc-textarea zc-error-details');
                area.readOnly = true;
                area.value = errorText;
                const copy = button('zc-btn zc-btn-ghost zc-btn-sm zc-copy-error', {}, '复制错误信息');
                copy.addEventListener('click', async () => {
                    try {
                        await win.navigator.clipboard.writeText(errorText);
                        copy.textContent = '已复制';
                        win.setTimeout(() => { copy.textContent = '复制错误信息'; }, 1500);
                    } catch (e) {
                        toast(`复制错误信息失败：${e?.message || e}`, 'error');
                    }
                });
                body.append(
                    h('div', 'zc-warning-banner', icon('circle-alert'), h('span', '', '推送失败，请检查错误详情。')),
                    h('div', 'zc-field', h('div', 'zc-error-head', h('div', 'zc-field-label', '错误详情'), copy), area));
                footer.appendChild(button('zc-btn zc-btn-primary zc-btn-xl', { onClick: modal.close }, '关闭'));
            } else {
                const submit = button('zc-btn zc-btn-primary zc-btn-xl', { disabled: pending || !pushEnabled }, pending ? spinner() : null, '推送');
                submit.addEventListener('click', async () => {
                    pending = true;
                    paint();
                    try {
                        if (!modal.dialog.isConnected || store.workspace?.id !== targetWorkspace.id) return;
                        await pushCurrent(targetWorkspace);
                        toast(`已推送到 ${tracked ? branch.upstream : (store.summary.remotes?.[0] || 'origin')}`, 'success');
                        modal.close();
                        refreshAfterMutation();
                    } catch (e) {
                        pending = false;
                        errorText = e?.message || String(e);
                        paint();
                    }
                });
                footer.append(button('zc-btn zc-btn-secondary zc-btn-xl', { disabled: pending, onClick: modal.close }, '取消'), submit);
            }
        };
        paint();
        modal.dialog.append(
            h('div', 'zc-dialog-header',
                h('h2', 'zc-dialog-title', '推送更改'),
                h('p', 'zc-dialog-description', tracked ? '将当前分支最新提交推送到远程分支。' : '首次推送会把当前分支发布到远程并设置 upstream。')),
            h('div', 'zc-dialog-body', body, footer));
    }

    return Object.freeze({ openPushDialog, dispose() {  } });
}
