/*
 * git.changes.<工作区>：某个工作区的仓库变了（文件改动、暂存、提交、切分支……）。
 * 状态面板读变更摘要，侧栏 Git 标签和 V工程 Git 页读完整状态，数据形状各不相同，
 * 但「什么时候该重读」只需要一份：有持有者时向主进程订阅 git.status/<工作区>，
 * 主进程按需监听这个仓库，变化或任何窗口改了仓库时推一次；不再各自定时轮询。
 * 快照的 data 是 { seq, reason }：seq 每收到一次推送加一。
 * 主进程看不全这个仓库（Linux 只看 .git、监听挂不上或中途出错）时会说一声（推送或订阅回执里的 degraded），
 * 之后窗口每次获得焦点也算一次变化，所有消费者一起退回到「回到窗口时补读」，不用各自再挂 focus。
 */
import { createSharedSource } from '../shared-source.js';

export const GIT_STATUS_TOPIC = 'git.status';

const sourcesByApi = new WeakMap(); // api → Map<workspaceId, source>

/**
 * 每个 api 对象、每个工作区一份。没有推送接口或没给工作区时返回 null。
 * @param {object} api
 * @param {string} workspaceId
 * @param {{ graceMs?: number, win?: Window }} [options] 只在第一次创建时生效
 */
export function getGitChangesSource(api, workspaceId, { graceMs = 30_000, win = globalThis.window } = {}) {
    if (!api || typeof api.onGitChanged !== 'function' || typeof workspaceId !== 'string' || !workspaceId) return null;
    let sources = sourcesByApi.get(api);
    if (!sources) {
        sources = new Map();
        sourcesByApi.set(api, sources);
    }
    let source = sources.get(workspaceId);
    if (source) return source;
    source = createSharedSource('git.changes', {
        key: workspaceId,
        initial: Object.freeze({ seq: 0, reason: null }),
        graceMs,
        start({ update }) {
            let stopped = false;
            let offFocus = null;
            const bump = reason => update(prev => Object.freeze({ seq: (prev?.seq || 0) + 1, reason }));
            const degrade = () => {
                if (stopped || offFocus || typeof win?.addEventListener !== 'function') return;
                const onFocus = () => bump('focus');
                win.addEventListener('focus', onFocus);
                offFocus = () => win.removeEventListener('focus', onFocus);
            };
            const off = api.onGitChanged(payload => {
                if (payload?.workspaceId !== workspaceId) return;
                if (payload.degraded) degrade();
                bump(payload.reason || 'changed');
            });
            Promise.resolve(api.subscribeMainState?.(GIT_STATUS_TOPIC, workspaceId))
                .then(result => { if (result?.state?.degraded) degrade(); })
                .catch(() => {});
            return () => {
                stopped = true;
                offFocus?.();
                try { off?.(); } catch (_e) { /* 已取消 */ }
                Promise.resolve(api.unsubscribeMainState?.(GIT_STATUS_TOPIC, workspaceId)).catch(() => {});
            };
        }
    });
    sources.set(workspaceId, source);
    return source;
}

/**
 * 只关心之后的变化：订阅时不回放上一次推送。
 * @param {object} api
 * @param {string} workspaceId
 * @param {(change: { seq: number, reason: string }) => void} onChange
 * @param {{ scope?: object, visible?: object, label?: string }} [options]
 * @returns {() => void} 取消订阅；没有推送接口时返回空函数
 */
export function watchGitChanges(api, workspaceId, onChange, { scope = null, visible = null, label = 'git-changes' } = {}) {
    const source = getGitChangesSource(api, workspaceId);
    if (!source) return () => {};
    return source.subscribe(({ data }) => onChange(data), { scope, visible, label, immediate: false });
}

/**
 * 跟着「当前工作区」换订阅：follow(id) 换到新工作区（同一个就不动），release() 全部放掉。
 * 给工作区会变的消费者（状态面板、Git 标签）用。
 */
export function createGitChangesFollower(api, onChange, { label = 'git-changes' } = {}) {
    let workspaceId = null;
    let release = null;
    return Object.freeze({
        follow(nextId) {
            const id = typeof nextId === 'string' && nextId ? nextId : null;
            if (id === workspaceId) return;
            release?.();
            release = null;
            workspaceId = id;
            if (id) release = watchGitChanges(api, id, change => onChange(id, change), { label });
        },
        release() {
            release?.();
            release = null;
            workspaceId = null;
        },
        get workspaceId() { return workspaceId; }
    });
}
