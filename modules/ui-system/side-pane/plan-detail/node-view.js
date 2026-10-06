/**
 * modules/ui-system/side-pane/plan-detail/node-view.js
 * 侧栏计划里的「节点详情」：一个文件一次改动的前后对比，以及署名回退。
 *
 * 和 V工程 页的节点弹窗是同一套数据和规则（project-forge:get-node / revert-file）：
 * 回退先预检，有冲突要确认后强制覆盖；署名与 V工程 页共用同一个本地键。
 * 差异按行对比后只显示改动附近的上下文，样式沿用 Git 标签的差异表。
 */

'use strict';

import { computeLineDiff } from '../../line-diff.js';
import { buildHunkRows } from '../git/diff-model.js';
import { formatRelativeTime } from '../side-pane-tab-utils.js';
import { OP_LABEL } from './topic-activity.js';

export const SIGNATURE_KEY = 'vcp-projectforge-signature';
const DIFF_MAX_ROWS = 600;

async function call(promise) {
    const result = await promise;
    if (!result?.success) throw new Error(result?.error || '未知错误');
    return result.data;
}

export function createPlanNodeView({ doc, api, storage, h, icon, toast, projectId, nodeId, writable = true, onBack, onReverted }) {
    const root = h('div', 'side-plan-node');
    let disposed = false;
    let detail = null;
    let pending = null; // 预检结果，等用户确认

    const back = h('button', 'side-plan-back');
    back.type = 'button';
    back.append(icon('arrow_back'), h('span', '', '返回'));
    back.addEventListener('click', () => onBack?.());
    const content = h('div', 'side-plan-node-body');
    root.append(back, content);

    function renderDiff() {
        const { before, after } = detail;
        if (before.binary || after.binary) {
            return h('div', 'side-plan-node-message', `二进制文件，无法显示差异（改动前 ${before.size || 0} B → 改动后 ${after.size || 0} B）`);
        }
        const diff = computeLineDiff(before.text || '', after.text || '');
        const rows = buildHunkRows(diff.rows);
        const wrap = h('div', 'side-plan-diff');
        if (!rows.length) {
            wrap.appendChild(h('div', 'side-plan-node-message', '这次改动没有文本层面的差异'));
            return wrap;
        }
        const table = h('table', 'side-git-diff-table');
        rows.slice(0, DIFF_MAX_ROWS).forEach(row => {
            const tr = h('tr');
            if (row.type === 'hunk') {
                tr.className = 'diff-line hunk';
                const cell = h('td', 'diff-content', row.text);
                cell.colSpan = 3;
                tr.appendChild(cell);
            } else {
                tr.className = `diff-line ${row.type}`;
                tr.append(
                    h('td', 'diff-num', row.oldLine !== null && row.oldLine !== undefined ? String(row.oldLine) : ''),
                    h('td', 'diff-num', row.newLine !== null && row.newLine !== undefined ? String(row.newLine) : ''),
                    h('td', 'diff-content', `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}${row.text}`)
                );
            }
            table.appendChild(tr);
        });
        wrap.appendChild(table);
        const notes = [];
        if (rows.length > DIFF_MAX_ROWS) notes.push(`只显示前 ${DIFF_MAX_ROWS} 行`);
        if (diff.approximate) notes.push('文件较大，差异为近似结果');
        if (before.truncated || after.truncated) notes.push('内容过长已截断');
        if (notes.length) wrap.appendChild(h('div', 'side-plan-node-message', `${notes.join('；')}，完整对比请到 V工程 页查看`));
        return wrap;
    }

    function renderRevert() {
        const box = h('div', 'side-plan-revert');
        box.appendChild(h('div', 'side-plan-revert-title', '回退这个文件'));
        if (!writable) {
            box.appendChild(h('div', 'side-plan-node-message', '这个工程当前不可写（已删除或根目录不可用），不能回退'));
            return box;
        }
        const fields = h('div', 'side-plan-revert-fields');
        const signature = h('input', 'side-plan-input side-plan-signature');
        signature.type = 'text';
        signature.placeholder = '署名（必填）';
        signature.setAttribute('aria-label', '回退署名');
        signature.value = (() => { try { return storage?.getItem(SIGNATURE_KEY) || ''; } catch (_e) { return ''; } })();
        const reason = h('input', 'side-plan-input side-plan-revert-reason');
        reason.type = 'text';
        reason.placeholder = '回退原因（可选）';
        reason.setAttribute('aria-label', '回退原因');
        fields.append(signature, reason);
        const actions = h('div', 'side-plan-revert-actions');
        const undo = h('button', 'zc-btn zc-btn-ghost side-plan-revert-before', '撤销此变动');
        undo.type = 'button';
        undo.title = '文件恢复到这次改动之前';
        const redo = h('button', 'zc-btn zc-btn-ghost side-plan-revert-after', '恢复到此版本');
        redo.type = 'button';
        redo.title = '文件恢复到这次改动完成时';
        actions.append(undo, redo);
        const confirmBox = h('div', 'side-plan-revert-confirm');
        confirmBox.hidden = true;
        box.append(fields, actions, confirmBox);

        const setBusy = (busy) => { undo.disabled = busy; redo.disabled = busy; };

        async function precheck(mode) {
            const sig = signature.value.trim();
            if (!sig) {
                toast('回退需要署名，先填上署名', 'error');
                signature.focus();
                return;
            }
            try { storage?.setItem(SIGNATURE_KEY, sig); } catch (_e) { /* ignore */ }
            const base = { projectId, nodeId: detail.node.id, mode, signature: sig, reason: reason.value.trim() };
            setBusy(true);
            let plan;
            try {
                plan = await call(api.projectForgeRevertFile({ ...base, dryRun: true }));
            } catch (error) {
                setBusy(false);
                toast(`回退预检失败：${error.message}`, 'error');
                return;
            }
            setBusy(false);
            if (disposed) return;
            if (plan.status === 'noop') {
                toast('磁盘内容已是目标状态，无需回退');
                return;
            }
            pending = { base, plan };
            showConfirm();
        }

        function showConfirm() {
            const { base, plan } = pending;
            confirmBox.innerHTML = '';
            confirmBox.hidden = false;
            confirmBox.append(
                h('div', 'side-plan-revert-label', plan.label || ''),
                h('div', '', `动作：${plan.action}`),
                h('div', '', `署名：@${base.signature}`)
            );
            if (plan.conflicts?.length) {
                const list = h('ul', 'side-plan-revert-conflicts');
                plan.conflicts.forEach(text => list.appendChild(h('li', '', text)));
                confirmBox.append(h('div', 'side-plan-warning', '存在冲突，继续将强制覆盖（当前磁盘内容会先存快照，仍可再回退）'), list);
            }
            const row = h('div', 'side-plan-revert-actions');
            const ok = h('button', 'zc-btn zc-btn-primary side-plan-revert-ok', plan.conflicts?.length ? '强制回退' : '确认回退');
            ok.type = 'button';
            const cancel = h('button', 'zc-btn zc-btn-ghost side-plan-revert-cancel', '取消');
            cancel.type = 'button';
            ok.addEventListener('click', () => commit());
            cancel.addEventListener('click', () => { pending = null; confirmBox.hidden = true; confirmBox.innerHTML = ''; });
            row.append(ok, cancel);
            confirmBox.appendChild(row);
        }

        async function commit() {
            if (!pending) return;
            const { base, plan } = pending;
            pending = null;
            confirmBox.hidden = true;
            setBusy(true);
            try {
                const result = await call(api.projectForgeRevertFile({ ...base, expectedHash: plan.expectedHash, force: (plan.conflicts?.length || 0) > 0 }));
                if (result.status === 'conflict') {
                    toast('文件在确认期间发生变化，请重新操作', 'error');
                } else if (result.status === 'noop') {
                    toast('无需回退');
                } else {
                    toast(`已回退：批次 b${result.batchId}（@${result.maid || base.signature}）`, 'success');
                    onReverted?.(result);
                    return;
                }
            } catch (error) {
                toast(`回退失败：${error.message}`, 'error');
            }
            setBusy(false);
        }

        undo.addEventListener('click', () => precheck('before'));
        redo.addEventListener('click', () => precheck('after'));
        return box;
    }

    function render() {
        content.innerHTML = '';
        const { node, batch, todo, laterChanges } = detail;
        const title = h('div', 'side-plan-node-title');
        title.append(h('span', `side-plan-op op-${node.op}`, OP_LABEL[node.op] || node.op), h('span', 'side-plan-node-path', node.file_path));
        title.lastChild.title = node.file_path;
        const meta = h('div', 'side-plan-meta');
        meta.append(
            h('span', '', `n${node.id}`),
            h('span', '', `批次 b${node.batch_id ?? '-'}`),
            h('span', '', batch?.maid ? `@${batch.maid}` : (batch?.kind === 'external' ? '外部修改' : '')),
            h('span', '', node.created_at ? formatRelativeTime(Date.parse(node.created_at)) : ''),
            h('span', 'side-plan-added', `+${node.added || 0}`),
            h('span', 'side-plan-removed', `-${node.removed || 0}`)
        );
        content.append(title, meta);
        content.appendChild(h('div', 'side-plan-node-reason', node.reason || batch?.reason || node.summary || '（未记录原因）'));
        if (todo) content.appendChild(h('div', 'side-plan-node-todo', `关联计划 #${todo.seq} ${todo.title}`));
        if (laterChanges) content.appendChild(h('div', 'side-plan-warning', `此后这个文件还有 ${laterChanges} 次改动`));
        content.append(renderDiff(), renderRevert());
    }

    async function load() {
        content.innerHTML = '';
        content.appendChild(h('div', 'side-plan-node-message', '正在读取改动…'));
        try {
            const data = await call(api.projectForgeGetNode(projectId, nodeId));
            if (disposed) return;
            detail = data;
            render();
        } catch (error) {
            if (disposed) return;
            content.innerHTML = '';
            content.appendChild(h('div', 'side-plan-node-message side-plan-error', `读取改动失败：${error.message}`));
        }
    }

    return {
        element: root,
        load,
        dispose() { disposed = true; }
    };
}
