/* 工具调用等人点头：服务器发来审批请求、主窗口的自动允许规则没放行时，桌宠头上也摆一张卡，
 * 用户不用切回主窗口就能允许或拒绝。真正的应答还是主窗口发出去，两边谁先点都算，点完两边一起收起。
 * 这里只管排队：同时来好几个时一张一张给用户看。纯函数，页面和测试共用。 */

const MAX_PENDING = 20;
const COMMAND_MAX = 160;

/** 主进程转来的请求整理成卡片要显示的样子；不合法的返回 null */
export function normalizeApproval(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') return null;
    const requestId = typeof raw.requestId === 'string' || typeof raw.requestId === 'number' ? String(raw.requestId) : '';
    if (!requestId) return null;
    const command = String(raw.command ?? '').replace(/\s+/g, ' ').trim();
    const expiresAt = Number(raw.expiresAt);
    if (raw.expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= now) return null;
    return {
        requestId,
        toolName: String(raw.toolName || '').trim().slice(0, 60) || '工具',
        command: command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX - 1)}…` : command,
        expiresAt: raw.expiresAt != null && Number.isFinite(expiresAt) ? expiresAt : null,
    };
}

export function createApprovalQueue({ now = () => Date.now() } = {}) {
    const items = [];
    const drop = (requestId) => {
        const i = items.findIndex((item) => item.requestId === requestId);
        if (i < 0) return false;
        items.splice(i, 1);
        return true;
    };
    const prune = () => {
        const t = now();
        for (let i = items.length - 1; i >= 0; i--) if (items[i].expiresAt && items[i].expiresAt <= t) items.splice(i, 1);
    };
    return {
        /** 加一个；同一个请求重复来（断线重放）只留一份。返回是否加上了 */
        add(raw) {
            const item = normalizeApproval(raw, now());
            if (!item || items.some((x) => x.requestId === item.requestId)) return false;
            items.push(item);
            if (items.length > MAX_PENDING) items.shift();
            return true;
        },
        remove: drop,
        /** 现在该给用户看的那张（最早来的），过期的先扔掉 */
        get current() {
            prune();
            return items[0] || null;
        },
        get size() {
            prune();
            return items.length;
        },
    };
}
