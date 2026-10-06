/*
 * terminal.command-runs：自带终端里 AI 发起的命令运行记录（新的在前）。
 * 状态面板的「命令输出」章节和侧栏「命令输出」标签读同一份；
 * 有持有者时才让主进程开始推送，最后一个持有者离开、宽限期过后取消推送。
 */
import { createSharedSource } from '../shared-source.js';

const sources = new WeakMap();

/** 推送来的是单条摘要：已有的就合并，新的放最前面。只替换变了的那一条，其余对象保持原样。 */
export function mergeCommandRun(runs, summary) {
    const list = Array.isArray(runs) ? runs : [];
    if (!summary?.id) return list;
    const index = list.findIndex(run => run.id === summary.id);
    if (index < 0) return [summary, ...list];
    const next = list.slice();
    next[index] = { ...list[index], ...summary };
    return next;
}

/**
 * 每个 api 对象一份（窗口里就是 electronAPI 一份）。
 * @param {object} api
 * @param {{ graceMs?: number }} [options] 只在第一次创建时生效
 */
export function getCommandRunsSource(api, { graceMs = 30_000 } = {}) {
    if (!api || typeof api.terminalListCommandRuns !== 'function') return null;
    let source = sources.get(api);
    if (source) return source;
    source = createSharedSource('terminal.command-runs', {
        initial: [],
        graceMs,
        start({ update }) {
            const off = api.onTerminalCommandRunChanged?.(summary => update(runs => mergeCommandRun(runs, summary)));
            Promise.resolve(api.terminalWatchCommandRuns?.()).catch(() => {});
            return () => {
                try { off?.(); } catch (_e) { /* 已取消 */ }
                Promise.resolve(api.terminalUnwatchCommandRuns?.()).catch(() => {});
            };
        },
        async fetch() {
            const res = await api.terminalListCommandRuns();
            if (!res?.success) throw new Error(res?.error || '读取命令记录失败');
            return Array.isArray(res.data) ? res.data : [];
        }
    });
    sources.set(api, source);
    return source;
}
