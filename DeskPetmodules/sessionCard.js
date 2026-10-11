import { createToolActivityTracker, describeActivity } from './toolActivity.js';

const active = s => s.status === 'thinking' || s.status === 'responding';
const labels = { thinking: '正在思考…', responding: '正在回复…', complete: '回复已完成', error: '回复出错了', stopped: '已停止回复' };

export function createSessionCard({ card, panel = card, title, status, api, toggle, badge, navigation, position, previous, next, stop, onToggle = () => {} }) {
    let rows = [];
    let selected = '';
    let name = '';
    let received = false;
    let expanded = false;
    let pendingTopic = '';
    const trackers = new Map();
    const unread = new Set();
    const keyOf = s => s.topicId || s.messageId;
    function grouped() {
        const groups = new Map();
        for (const row of rows) {
            const key = keyOf(row);
            const old = groups.get(key);
            if (!old || (!active(old) && active(row))) groups.set(key, row);
        }
        return [...groups.values()];
    }
    function current() {
        const list = grouped();
        return list.find(s => keyOf(s) === selected) || list.find(active) || list[0] || null;
    }
    function render() {
        const list = grouped();
        const session = current();
        if (session) selected = keyOf(session);
        const heading = session?.title || (session?.topicId ? '当前会话' : name);
        let detail = labels[session?.status] || '暂无会话动态';
        const latest = trackers.get(session?.messageId)?.latest;
        if (session?.status === 'responding' && latest) detail = describeActivity(latest).text;
        if (title.textContent !== heading) title.textContent = heading;
        if (status.textContent !== detail) status.textContent = detail;
        card.title = `${heading}\n${detail}\n点击打开会话`;
        card.disabled = !session;
        if (stop) stop.hidden = !session || !active(session);
        panel.hidden = !name || !expanded;
        if (panel.dataset) panel.dataset.stacked = String(list.length > 1);
        const notifications = list.filter(s => active(s) || rows.some(row => keyOf(row) === keyOf(s) && unread.has(row.messageId))).length;
        if (badge) {
            badge.textContent = notifications > 99 ? '99+' : String(notifications);
            badge.hidden = expanded || !notifications;
        }
        if (toggle) {
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.setAttribute('aria-label', expanded ? '收起会话动态' : `查看会话动态${notifications ? `，${notifications} 个会话` : ''}`);
            toggle.title = expanded ? '收起会话动态' : '查看会话动态';
        }
        if (navigation) navigation.hidden = !expanded || list.length < 2;
        if (position) position.textContent = `${Math.max(0, list.indexOf(session)) + 1} / ${list.length}`;
    }
    function acknowledge() {
        const session = current();
        if (session) for (const row of rows) if (keyOf(row) === keyOf(session)) unread.delete(row.messageId);
    }
    function setExpanded(value) {
        expanded = value;
        if (expanded) acknowledge();
        render();
        onToggle(expanded);
    }
    function cycle(delta) {
        const list = grouped();
        if (list.length < 2) return;
        const index = list.findIndex(s => keyOf(s) === selected);
        selected = keyOf(list[(index + delta + list.length) % list.length]);
        acknowledge(); render(); onToggle(expanded);
    }
    api.onStream(event => {
        if (!event) return;
        if (event.type === 'start') {
            trackers.set(event.messageId, createToolActivityTracker());
            unread.add(event.messageId);
        }
        if (event.type === 'end' || event.type === 'error') unread.add(event.messageId);
        if (event.type === 'data') {
            if (!trackers.has(event.messageId)) trackers.set(event.messageId, createToolActivityTracker());
            trackers.get(event.messageId).push(event.text);
        }
        if (event.session) {
            received = true;
            rows = event.session.sessions || [event.session];
            // 收起时跟随最新活动；展开后用户选中的会话不会被新 token 抢走。
            if (!expanded) selected = keyOf(event.session);
        }
        const kept = new Set(rows.map(s => s.messageId));
        for (const id of unread) if (!kept.has(id)) unread.delete(id);
        while (trackers.size > 24) {
            const id = [...trackers.keys()].find(key => key !== current()?.messageId);
            trackers.delete(id);
        }
        if (expanded) acknowledge();
        render();
    });
    toggle?.addEventListener('click', () => setExpanded(!expanded));
    previous?.addEventListener('click', () => cycle(-1));
    next?.addEventListener('click', () => cycle(1));
    stop?.addEventListener('click', () => {
        const session = current();
        if (session && active(session)) api.interrupt?.(session.messageId);
    });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { setExpanded(false); toggle?.focus(); }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycle(event.key === 'ArrowLeft' ? -1 : 1); }
    });
    card.addEventListener('click', () => {
        const session = current();
        if (!session) return;
        acknowledge(); render();
        pendingTopic = keyOf(session);
        if (session.topicId) api.openTopic(session.topicId);
        else api.openMainWindow();
    });
    api.onTopicMissing?.(() => {
        if (!pendingTopic) return;
        rows = rows.filter(row => keyOf(row) !== pendingTopic);
        pendingTopic = '';
        selected = ''; render();
    });
    return {
        initialize(assets) {
            name = assets.name || '桌宠';
            if (!received) rows = assets.session?.sessions || (assets.session ? [assets.session] : []);
            for (const row of rows) if (active(row)) unread.add(row.messageId);
            render();
        },
        setExpanded,
    };
}
