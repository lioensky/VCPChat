import { createToolActivityTracker, describeActivity } from './toolActivity.js';

export function createSessionCard({ card, title, status, api }) {
    let session = null;
    let name = '';
    let received = false;
    const trackers = new Map();
    const labels = { thinking: '正在思考…', responding: '正在回复…', complete: '回复已完成', error: '回复出错了', stopped: '已停止回复' };
    function render() {
        const heading = session?.title || (session?.topicId ? '当前会话' : name);
        let detail = labels[session?.status] || '等待新会话';
        const latest = trackers.get(session?.messageId)?.latest;
        if (session?.status === 'responding' && latest) detail = describeActivity(latest).text;
        if (session?.runningCount > 1) detail += ` · 共 ${session.runningCount} 个请求运行中`;
        if (title.textContent !== heading) title.textContent = heading;
        if (status.textContent !== detail) status.textContent = detail;
        card.title = `${heading}\n${detail}\n点击打开会话`;
        card.hidden = !name;
    }
    api.onStream(event => {
        if (!event) return;
        if (event.type === 'start') trackers.set(event.messageId, createToolActivityTracker());
        if (event.type === 'data') {
            if (!trackers.has(event.messageId)) trackers.set(event.messageId, createToolActivityTracker());
            trackers.get(event.messageId).push(event.text);
        }
        if (event.session) {
            received = true;
            session = event.session;
        }
        // 活动解析器的缓存有上限；当前显示的那条始终保留。
        while (trackers.size > 24) {
            const id = [...trackers.keys()].find(key => key !== session?.messageId);
            trackers.delete(id);
        }
        render();
    });
    card.addEventListener('click', () => session?.topicId ? api.openTopic(session.topicId) : api.openMainWindow());
    api.onTopicMissing?.(() => { session = null; render(); });
    return {
        initialize(assets) {
            name = assets.name || '桌宠';
            // 模型载入期间收到的新请求优先，不能被旧的 get-assets 快照覆盖。
            if (!received) session = assets.session || null;
            render();
        },
    };
}
