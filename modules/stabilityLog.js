'use strict';

// 稳定性日志：主进程把"主窗口无响应 / 恢复 / 渲染进程退出 / 子进程退出"按统一结构记成 JSON 行，
// 落在 userData/diagnostics/stability.log（超过上限轮转一次到 stability.1.log），并在内存里保留
// 最近 N 条，供 lifecycle:get-main-snapshot 与诊断导出带出。用户反馈"卡住 / 闪退"时，日志里有
// 时间点、持续时长和退出原因可以对照。
// 只记录类型、原因、时长、退出码和来源：不含聊天内容、窗口标题、URL 或文件路径。
//
// 无响应分级：Chromium 的挂起监视器大约 5 s 没有响应才发 unresponsive，所以收到事件即视为 hang；
// 停滞持续到 30 s 再补一条 freeze；恢复时按总停滞时长写 severity（brief / hang / freeze）。

const DEFAULT_FILE_NAME = 'stability.log';
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_RECENT = 20;
const HANG_MS = 5_000;
const FREEZE_MS = 30_000;

// Electron render-process-gone / child-process-gone 的 reason 归为几类，便于统计。
const PROCESS_GONE_CLASSES = Object.freeze({
    'clean-exit': 'clean-exit',
    'abnormal-exit': 'crash',
    crashed: 'crash',
    killed: 'killed',
    oom: 'oom',
    'launch-failed': 'launch-failed',
    'integrity-failure': 'integrity-failure',
});

function classifyProcessGone(reason) {
    return PROCESS_GONE_CLASSES[reason] || 'unknown';
}

function classifyStall(stalledMs, { hangMs = HANG_MS, freezeMs = FREEZE_MS } = {}) {
    if (typeof stalledMs !== 'number' || !Number.isFinite(stalledMs)) return null;
    if (stalledMs >= freezeMs) return 'freeze';
    if (stalledMs >= hangMs) return 'hang';
    return 'brief';
}

function createStabilityLog({
    fs = require('fs'),
    path = require('path'),
    resolveDirectory = null,
    now = () => Date.now(),
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
    console: logger = console,
    fileName = DEFAULT_FILE_NAME,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    hangMs = HANG_MS,
    freezeMs = FREEZE_MS,
} = {}) {
    const entries = [];
    const counters = {};
    const unresponsive = { active: false, since: null, source: null, count: 0, timer: null };
    let directory = null;
    let directoryFailed = false;
    let writeQueue = Promise.resolve();
    let writeErrors = 0;
    let written = 0;

    function getDirectory() {
        if (directory || directoryFailed) return directory;
        try {
            const resolved = typeof resolveDirectory === 'function' ? resolveDirectory() : null;
            if (typeof resolved === 'string' && resolved.length > 0) directory = resolved;
            else directoryFailed = true;
        } catch (error) {
            directoryFailed = true;
            writeErrors += 1;
            logger.warn('[StabilityLog] log directory unavailable: ' + (error?.message || error));
        }
        return directory;
    }

    async function rotateIfNeeded(filePath, incomingBytes) {
        let size = 0;
        try {
            size = (await fs.promises.stat(filePath)).size;
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        if (size + incomingBytes <= maxFileBytes) return;
        const rotated = filePath.replace(/\.log$/, '') + '.1.log';
        await fs.promises.rm(rotated, { force: true });
        await fs.promises.rename(filePath, rotated);
    }

    function persist(entry) {
        const line = JSON.stringify(entry) + '\n';
        writeQueue = writeQueue
            .then(async () => {
                const dir = getDirectory();
                if (!dir) return;
                await fs.promises.mkdir(dir, { recursive: true });
                const filePath = path.join(dir, fileName);
                await rotateIfNeeded(filePath, Buffer.byteLength(line));
                await fs.promises.appendFile(filePath, line, 'utf8');
                written += 1;
            })
            .catch(error => {
                writeErrors += 1;
                if (writeErrors === 1) logger.warn('[StabilityLog] cannot write ' + fileName + ': ' + (error?.message || error));
            });
        return writeQueue;
    }

    /** 记一条任意类型的条目；fields 里只放数字、状态和 id。 */
    function note(kind, fields = {}) {
        const entry = { at: new Date(now()).toISOString(), kind: String(kind), ...fields };
        entries.push(entry);
        if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
        counters[entry.kind] = (counters[entry.kind] || 0) + 1;
        persist(entry);
        return entry;
    }

    function clearFreezeTimer() {
        if (unresponsive.timer !== null) {
            cancel(unresponsive.timer);
            unresponsive.timer = null;
        }
    }

    /** 主窗口被判无响应。重复通知（window 与 webContents 各发一次）只记第一次。 */
    function recordUnresponsive(source) {
        if (unresponsive.active) return null;
        unresponsive.active = true;
        unresponsive.since = now();
        unresponsive.source = source ?? null;
        unresponsive.count += 1;
        const entry = note('unresponsive', { source: unresponsive.source, severity: 'hang' });
        const timer = schedule(() => {
            unresponsive.timer = null;
            if (!unresponsive.active) return;
            note('freeze', { source: unresponsive.source, elapsedMs: now() - unresponsive.since });
        }, freezeMs);
        timer?.unref?.();
        unresponsive.timer = timer;
        return entry;
    }

    /** 主窗口恢复响应；按总停滞时长写 severity。 */
    function recordResponsive(source) {
        if (!unresponsive.active) return null;
        const stalledMs = now() - unresponsive.since;
        clearFreezeTimer();
        unresponsive.active = false;
        unresponsive.since = null;
        return note('responsive', {
            source: source ?? null,
            stalledMs,
            severity: classifyStall(stalledMs, { hangMs, freezeMs }),
        });
    }

    /** 某个 WebContents 的渲染进程退出；scope 说明是哪一类（main-window / assistant …）。 */
    function recordRenderProcessGone(scope, details = {}) {
        return note('render-process-gone', {
            scope: scope ?? null,
            reason: details?.reason ?? null,
            exitCode: typeof details?.exitCode === 'number' ? details.exitCode : null,
            class: classifyProcessGone(details?.reason),
        });
    }

    /** app 的 child-process-gone：GPU / Utility / Zygote 等子进程退出。 */
    function recordChildProcessGone(details = {}) {
        return note('child-process-gone', {
            processType: details?.type ?? null,
            serviceName: details?.serviceName ?? null,
            reason: details?.reason ?? null,
            exitCode: typeof details?.exitCode === 'number' ? details.exitCode : null,
            class: classifyProcessGone(details?.reason),
        });
    }

    function recent(limit = DEFAULT_RECENT) {
        return entries.slice(-Math.max(0, limit)).map(entry => ({ ...entry }));
    }

    function snapshot() {
        return {
            fileName,
            directoryResolved: Boolean(directory),
            written,
            writeErrors,
            thresholds: { hangMs, freezeMs },
            counters: { ...counters },
            unresponsive: {
                active: unresponsive.active,
                since: unresponsive.since ? new Date(unresponsive.since).toISOString() : null,
                source: unresponsive.source,
                count: unresponsive.count,
                currentStallMs: unresponsive.active ? now() - unresponsive.since : null,
            },
            recent: recent(),
        };
    }

    /** 等待排队的写入落盘（退出前 / 测试用）。 */
    function flush() {
        return writeQueue;
    }

    function dispose() {
        clearFreezeTimer();
        unresponsive.active = false;
    }

    return Object.freeze({
        note,
        recordUnresponsive,
        recordResponsive,
        recordRenderProcessGone,
        recordChildProcessGone,
        recent,
        snapshot,
        flush,
        dispose,
    });
}

module.exports = { createStabilityLog, classifyProcessGone, classifyStall, HANG_MS, FREEZE_MS, DEFAULT_FILE_NAME };
