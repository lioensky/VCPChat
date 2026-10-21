'use strict';

// 启动标记：主进程从进程启动到渲染器就绪，各阶段发生的毫秒时刻。阶段名沿用启动器协议的 stage
// （process-started / electron-ready / storage-ready / window-created / … / renderer-ready），再补主窗口
// did-finish-load。每个名字只记第一次；重复到达只计次数，不改时间。只有名字和毫秒数，没有别的内容。

function createLaunchMarks({ now = () => Date.now(), processStartedAt = null } = {}) {
    const origin = typeof processStartedAt === 'number' && Number.isFinite(processStartedAt) ? processStartedAt : now();
    const marks = [];
    const byName = new Map();

    /** 记录一个阶段；返回新条目，重复名字返回 null。 */
    function mark(name) {
        const key = String(name ?? '').trim();
        if (!key) return null;
        const existing = byName.get(key);
        if (existing) {
            existing.repeats += 1;
            return null;
        }
        const entry = { name: key, atMs: Math.max(0, Math.round(now() - origin)), repeats: 0 };
        byName.set(key, entry);
        marks.push(entry);
        return { name: entry.name, atMs: entry.atMs };
    }

    function has(name) {
        return byName.has(String(name ?? '').trim());
    }

    function atMs(name) {
        return byName.get(String(name ?? '').trim())?.atMs ?? null;
    }

    /** 生命周期快照用：按发生顺序的标记列表 + 渲染器就绪耗时。 */
    function snapshot() {
        return {
            processStartedAt: new Date(origin).toISOString(),
            marks: marks.map(entry => ({ name: entry.name, atMs: entry.atMs, repeats: entry.repeats })),
            rendererReadyMs: atMs('renderer-ready'),
            elapsedMs: Math.max(0, Math.round(now() - origin)),
        };
    }

    /** 写进稳定性日志的一行：{ 阶段名: 毫秒 }。 */
    function summary() {
        const timeline = {};
        for (const entry of marks) timeline[entry.name] = entry.atMs;
        return { rendererReadyMs: atMs('renderer-ready'), timeline };
    }

    return Object.freeze({ mark, has, atMs, snapshot, summary });
}

module.exports = { createLaunchMarks };
