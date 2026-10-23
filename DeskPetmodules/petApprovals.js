// 工具审批卡片：回复里要调的工具得有人点头时，主窗口除了自己的通知卡，也把它转给这个助手的桌宠。
// 这里点了允许/拒绝交回主窗口去应答；任何一边答完、过期，主进程都会叫这里收起。
// 排队和去重在 approvals.js 里（纯函数）。
import { createApprovalQueue } from 'vcp-deskpet://pet/app/approvals.js';

export function createPetApprovals(ctx) {
    const { api, $ } = ctx;

    function bindApprovals() {
        const director = ctx.director;
        const queue = createApprovalQueue();
        const card = $('approvalCard');
        let expiryTimer = 0;
        let answering = '';
        const render = () => {
            const item = queue.current;
            const wasHidden = card.hidden;
            card.hidden = !item;
            clearTimeout(expiryTimer);
            if (item) {
                $('approvalTitle').textContent = `要用「${item.toolName}」吗？`;
                $('approvalTitle').title = item.toolName;
                $('approvalCommand').textContent = item.command;
                $('approvalCommand').title = item.command;
                const more = queue.size - 1;
                $('approvalMore').textContent = more > 0 ? `还有 ${more} 个` : '';
                for (const id of ['approvalAllow', 'approvalReject']) $(id).disabled = answering === item.requestId;
                if (item.expiresAt) expiryTimer = setTimeout(render, Math.max(0, item.expiresAt - Date.now()) + 50);
            }
            if (wasHidden && item) {
                // 有事要问：露出担心的样子，从睡着/待机里醒过来
                ctx.lastActivity = Date.now();
                director.nudge({ emotion: 'concerned', intensity: 0.7, source: 'approval' });
            }
            if (wasHidden !== card.hidden) ctx.reaimBubble();
        };
        const answer = (approved) => {
            const item = queue.current;
            if (!item || answering === item.requestId) return;
            answering = item.requestId;
            api.answerApproval(item.requestId, approved);
            render();
        };
        $('approvalAllow').addEventListener('click', (e) => { e.stopPropagation(); answer(true); });
        $('approvalReject').addEventListener('click', (e) => { e.stopPropagation(); answer(false); });
        $('approvalDetail').addEventListener('click', (e) => { e.stopPropagation(); api.openMainWindow(); });
        api.onApproval?.((payload) => {
            if (queue.add(payload)) render();
        });
        api.onApprovalClear?.((requestId) => {
            if (!queue.remove(String(requestId))) return;
            if (answering === String(requestId)) answering = '';
            render();
        });
    }

    return { bindApprovals };
}
