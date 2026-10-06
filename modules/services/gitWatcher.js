// modules/services/gitWatcher.js
// 按工作区监听 Git 仓库的变化，去抖后回调一次，取代渲染端各自的定时轮询。
//   - 元数据目录（git dir / common dir，由 Git 自己解析，兼容 worktree）：HEAD、index、refs 一动就刷新；
//     objects / logs / hooks 和 *.lock 的写入不算，提交、暂存这些操作总会同时改到 index 或 refs；
//   - 工作区文件：Windows / macOS 上递归监听整个工作区（系统原生递归监听，开销小）；
//     Linux 上递归监听要给每个子目录单独挂 watcher，大仓库代价太高，只监听元数据，
//     文件内容的改动靠窗口获得焦点、操作后刷新和 V工程 推送补上；
//   - 一批连续写入只触发一次：每来一个事件往后推一次，但从第一个事件起最多等 maxWaitMs；
//   - 监听失败（目录被删、权限不足）不影响其它功能，只是退回到手动刷新和操作后刷新。
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DELAYS = Object.freeze({ metadataMs: 300, contentMs: 1500, maxWaitMs: 5000 });
const IGNORED_METADATA = /^(objects|logs|hooks|lfs)([\\/]|$)|\.lock$/;
const IGNORED_CONTENT_SEGMENTS = new Set(['.git', 'node_modules']);

function isRelevant(kind, filename) {
    if (!filename) return true; // 有的平台不给文件名，宁可多刷一次
    const name = String(filename);
    if (kind === 'metadata') return !IGNORED_METADATA.test(name);
    return !name.split(/[\\/]/).some(segment => IGNORED_CONTENT_SEGMENTS.has(segment));
}

/** 递归监听时，被另一个目录包含的目录不用再单独监听 */
function outermostDirs(dirs) {
    const normalize = dir => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
    const list = [...new Set(dirs.filter(Boolean))];
    return list.filter(dir => !list.some(other => other !== dir && normalize(dir).startsWith(normalize(other) + path.sep)));
}

/**
 * @param {object} options
 * @param {(id: string) => Promise<{ root: string, gitDirs: string[] } | null>} options.getTargets 不是仓库时返回 null
 * @param {(id: string) => void} options.onChange
 * @param {Function} [options.watch] 默认 fs.watch，测试注入
 * @param {string} [options.platform]
 */
function createGitWatcher({
    getTargets,
    onChange,
    watch = fs.watch,
    platform = process.platform,
    delays = DEFAULT_DELAYS,
    logger = console,
} = {}) {
    const { metadataMs, contentMs, maxWaitMs } = { ...DEFAULT_DELAYS, ...delays };
    const entries = new Map(); // id → entry

    function open(entry, dir, kind) {
        try {
            const watcher = watch(dir, { recursive: true, persistent: false }, (_type, filename) => onEvent(entry, kind, filename));
            watcher.on?.('error', error => {
                // 目录被删或失去权限：关掉这一路，其余照常
                try { watcher.close(); } catch (_e) { /* 已关闭 */ }
                entry.watchers = entry.watchers.filter(item => item.watcher !== watcher);
                entry.error = error?.message || String(error);
                logger?.warn?.(`[GitWatcher] watch error (${kind}):`, entry.error);
            });
            entry.watchers.push({ watcher, kind });
        } catch (error) {
            entry.error = error?.message || String(error);
            logger?.warn?.(`[GitWatcher] cannot watch ${kind} directory:`, entry.error);
        }
    }

    function onEvent(entry, kind, filename) {
        if (entry.closed || !isRelevant(kind, filename)) return;
        const now = Date.now();
        if (!entry.firstEventAt) entry.firstEventAt = now;
        const due = Math.min(now + (kind === 'metadata' ? metadataMs : contentMs), entry.firstEventAt + maxWaitMs);
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => fire(entry), Math.max(0, due - now));
        entry.timer.unref?.();
    }

    function fire(entry) {
        entry.timer = null;
        entry.firstEventAt = 0;
        if (entry.closed) return;
        entry.changes += 1;
        try {
            onChange(entry.id);
        } catch (error) {
            logger?.error?.('[GitWatcher] onChange failed:', error);
        }
    }

    /** 开始监听；已经在监听就直接返回。返回的 promise 在监听挂好（或确定挂不上）后完成 */
    function start(id) {
        const existing = entries.get(id);
        if (existing) return existing.ready;
        const entry = { id, closed: false, watchers: [], timer: null, firstEventAt: 0, changes: 0, mode: 'pending', error: null, ready: null };
        entries.set(id, entry);
        entry.ready = (async () => {
            let targets = null;
            try {
                targets = await getTargets(id);
            } catch (error) {
                entry.error = error?.message || String(error);
            }
            if (entry.closed) return;
            if (!targets) {
                entry.mode = entry.error ? 'failed' : 'not-repo';
                return;
            }
            for (const dir of outermostDirs(targets.gitDirs || [])) open(entry, dir, 'metadata');
            const watchContent = platform !== 'linux' && targets.root;
            if (watchContent) open(entry, targets.root, 'content');
            const kinds = new Set(entry.watchers.map(item => item.kind));
            entry.mode = kinds.has('content') ? 'files' : kinds.has('metadata') ? 'metadata' : 'failed';
        })();
        return entry.ready;
    }

    function stop(id) {
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        entry.closed = true;
        clearTimeout(entry.timer);
        entry.timer = null;
        for (const { watcher } of entry.watchers.splice(0)) {
            try { watcher.close(); } catch (_e) { /* 已关闭 */ }
        }
    }

    /** 诊断用：只有工作区 id、监听方式、watcher 数和触发次数，不含路径 */
    function snapshot() {
        return [...entries.values()].map(entry => Object.freeze({
            workspaceId: entry.id,
            mode: entry.mode,
            watchers: entry.watchers.length,
            changes: entry.changes,
            error: entry.error,
        }));
    }

    function dispose() {
        for (const id of [...entries.keys()]) stop(id);
    }

    return Object.freeze({ start, stop, snapshot, dispose, isWatching: id => entries.has(id) });
}

module.exports = { createGitWatcher, isRelevant, outermostDirs };
