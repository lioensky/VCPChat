'use strict';

// 内存中的请求归属；不写聊天数据。并发时显示最新仍在运行的请求。
function createSessionActivity({ titleOf = async () => '', publish = () => {} } = {}) {
    const agents = new Map();
    let order = 0;
    const active = s => s.status === 'thinking' || s.status === 'responding';
    function get(agentId) {
        const rows = [...(agents.get(agentId)?.values() || [])];
        const running = rows.filter(active);
        const selected = (running.length ? running : rows).sort((a, b) => b.order - a.order)[0];
        if (!selected) return null;
        const { order: _order, ...session } = selected;
        return { ...session, runningCount: running.length, sessions: rows.sort((a, b) => b.order - a.order).map(({ order: _n, ...row }) => row) };
    }
    function start(messageId, context) {
        const agentId = context?.agentId;
        if (!agentId || context.isGroupMessage) return;
        let rows = agents.get(agentId);
        if (!rows) agents.set(agentId, rows = new Map());
        const session = { messageId: String(messageId), topicId: String(context.topicId || ''), title: '', status: 'thinking', order: ++order };
        rows.set(session.messageId, session);
        // 保留最近会话动态供铃铛查看，不删除仍在运行的请求。
        const completed = [...rows.values()].filter(s => !active(s)).sort((a, b) => b.order - a.order);
        for (const old of completed.slice(12)) rows.delete(old.messageId);
        Promise.resolve().then(() => titleOf(agentId, session.topicId)).then(title => {
            if (rows.get(session.messageId) !== session) return;
            session.title = typeof title === 'string' ? title.slice(0, 300) : '';
            publish(agentId, get(agentId));
        }).catch(() => {});
    }
    function update(agentId, event) {
        const rows = agents.get(agentId);
        const session = rows?.get(String(event.messageId));
        if (!session || !active(session)) return;
        if (event.type === 'data') session.status = 'responding';
        if (event.type === 'end' || event.type === 'error') {
            session.status = event.type === 'error' ? 'error' : event.aborted ? 'stopped' : 'complete';
            const completed = [...rows.values()].filter(s => !active(s)).sort((a, b) => b.order - a.order);
            for (const old of completed.slice(12)) rows.delete(old.messageId);
        }
    }
    return { start, update, get };
}
module.exports = { createSessionActivity };
