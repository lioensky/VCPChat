/*
 * projectforge.changes：V工程 的工程变更推送（新记了一批施工、回退、删除工程……）。
 * 状态面板、侧栏 Git 页、计划详情各自关心不同的数据，但变更通知只需要一份：
 * 有持有者时才向主进程订阅 project-forge 主题，主进程只把推送发给订阅了的窗口；
 * 最后一个持有者离开、宽限期过后取消订阅。
 * 快照的 data 是 { seq, payload }：seq 每收到一次推送加一，payload 是主进程推来的原样内容。
 */
import { createSharedSource } from '../shared-source.js';

export const PROJECT_FORGE_TOPIC = 'project-forge';

const sources = new WeakMap();

/**
 * 每个 api 对象一份（窗口里就是 electronAPI 一份）。
 * @param {object} api
 * @param {{ graceMs?: number }} [options] 只在第一次创建时生效
 */
export function getProjectForgeChangesSource(api, { graceMs = 30_000 } = {}) {
    if (!api || typeof api.onProjectForgeChanged !== 'function') return null;
    let source = sources.get(api);
    if (source) return source;
    source = createSharedSource('projectforge.changes', {
        initial: Object.freeze({ seq: 0, payload: null }),
        graceMs,
        start({ update }) {
            const off = api.onProjectForgeChanged(payload => update(prev => Object.freeze({
                seq: (prev?.seq || 0) + 1,
                payload: payload ?? null
            })));
            Promise.resolve(api.subscribeMainState?.(PROJECT_FORGE_TOPIC)).catch(() => {});
            return () => {
                try { off?.(); } catch (_e) { /* 已取消 */ }
                Promise.resolve(api.unsubscribeMainState?.(PROJECT_FORGE_TOPIC)).catch(() => {});
            };
        }
    });
    sources.set(api, source);
    return source;
}

/**
 * 只关心「之后的」变更：订阅时不回放上一次推送。
 * @param {object} api
 * @param {(payload: any) => void} onChange
 * @param {{ scope?: object, visible?: object, label?: string, source?: object }} [options]
 * @returns {() => void} 取消订阅；没有 V工程 接口时返回空函数
 */
export function watchProjectForgeChanges(api, onChange, { scope = null, visible = null, label = 'projectforge-changes', source = getProjectForgeChangesSource(api) } = {}) {
    if (!source) return () => {};
    return source.subscribe(({ data }) => onChange(data?.payload ?? null), { scope, visible, label, immediate: false });
}
