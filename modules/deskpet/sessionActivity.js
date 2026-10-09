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
        return { ...session, runningCount: running.length };
    }
    function start(messageId, context) {
        const agentId = context?.agentId;
        if (!agentId || context.isGroupMessage) return;
        let rows = agents.get(agentId);
        if (!rows) agents.set(agentId, rows = new Map());
        const session = { messageId: String(messageId), topicId: String(context.topicId || ''), title: '', status: 'thinking', order: ++order };
        rows.set(session.messageId, session);
        // 只保留一条已结束的记录，运行中的请求始终保留。
        for (const [id, row] of rows) if (!active(row)) rows.delete(id);
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
            for (const old of completed.slice(1)) rows.delete(old.messageId);
        }
    }
    return { start, update, get };
}
module.exports = { createSessionActivity };
