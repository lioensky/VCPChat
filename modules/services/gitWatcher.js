// modules/services/gitWatcher.js
// 按工作区监听 Git 仓库的变化，去抖后回调一次，取代渲染端各自的定时轮询。
//   - 元数据目录（git dir / common dir，由 Git 自己解析，兼容 worktree）：HEAD、index、refs 一动就刷新；
//     objects / logs / hooks 和 *.lock 的写入不算，提交、暂存这些操作总会同时改到 index 或 refs；
//   - 工作区文件：Windows / macOS 上递归监听整个工作区（系统原生递归监听，开销小）；
//     Linux 上递归监听要给每个子目录单独挂 watcher，大仓库代价太高，只监听元数据，
//     文件内容的改动靠窗口获得焦点、操作后刷新和 V工程 推送补上；
//   - Linux 上元数据目录也不整棵递归：Node 在 Linux 上的递归监听是 JS 实现，会同步遍历整棵 .git、给每个文件挂一个
//     inotify（objects 多的仓库一次挂上万个，主线程卡几百毫秒，还可能把系统的 inotify 名额用光）。只监听元数据目录本身
//     （HEAD、index、packed-refs……）加递归的 refs/（对照 DSH fs-local 的 depth:0）；
//   - 一批连续写入只触发一次：每来一个事件往后推一次。元数据从这批第一个元数据事件起最多等 maxWaitMs，
//     文件内容最多等 contentMaxWaitMs（编辑器、构建一直在写时不用每几秒读一遍状态）；两者谁先到就报一次；
//   - 应用自己改了仓库（暂存、提交……）会马上通知，absorb(id) 让监听不再为同一件事重复报：
//     丢掉还没报的这一批（通知之后各界面会整份重读，之前的事件都已包含），并在 absorbMs 内忽略元数据事件
//     （git 写 index / refs 的事件可能晚一点才到）；文件内容事件照常，不吞掉用户紧接着的编辑；
//   - 监听失败（目录被删、权限不足）不影响其它功能；看不全（只看元数据、.git 或工作区挂不上）时调 onDegraded，
//     渲染端据此退回到窗口获得焦点时补读。
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DELAYS = Object.freeze({ metadataMs: 300, contentMs: 1500, maxWaitMs: 5000, contentMaxWaitMs: 20_000, absorbMs: 1000 });
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
 * @param {(id: string, info: { mode: string, error: string|null }) => void} [options.onDegraded]
 *        看不全这个仓库了（Linux 只看元数据、某一路挂不上或中途出错）；同一个工作区每次监听只报一次
 * @param {Function} [options.watch] 默认 fs.watch，测试注入
 * @param {string} [options.platform]
 */
function createGitWatcher({
    getTargets,
    onChange,
    onDegraded = null,
    watch = fs.watch,
    exists = fs.existsSync,
    platform = process.platform,
    delays = DEFAULT_DELAYS,
    logger = console,
} = {}) {
    const { metadataMs, contentMs, maxWaitMs, contentMaxWaitMs, absorbMs } = { ...DEFAULT_DELAYS, ...delays };
    const entries = new Map(); // id → entry

    function open(entry, dir, kind, { recursive = true, prefix = '' } = {}) {
        try {
            const watcher = watch(dir, { recursive, persistent: false },
                (_type, filename) => onEvent(entry, kind, filename && prefix ? `${prefix}${filename}` : filename));
            watcher.on?.('error', error => {
                // 目录被删或失去权限：关掉这一路，其余照常
                try { watcher.close(); } catch (_e) { /* 已关闭 */ }
                entry.watchers = entry.watchers.filter(item => item.watcher !== watcher);
                entry.error = error?.message || String(error);
                logger?.warn?.(`[GitWatcher] watch error (${kind}):`, entry.error);
                // 少了任何一路都可能漏掉变化（只剩文件内容时看不到命令行里的提交），一律按降级报
                const kinds = new Set(entry.watchers.map(item => item.kind));
                entry.mode = !kinds.size ? 'failed' : kinds.has('content') ? 'partial' : 'metadata';
                reportDegraded(entry);
            });
            entry.watchers.push({ watcher, kind });
        } catch (error) {
            entry.error = error?.message || String(error);
            logger?.warn?.(`[GitWatcher] cannot watch ${kind} directory:`, entry.error);
        }
    }

    function reportDegraded(entry) {
        if (entry.closed || entry.degradedReported) return;
        entry.degradedReported = true;
        if (typeof onDegraded !== 'function') return;
        try {
            onDegraded(entry.id, { mode: entry.mode, error: entry.error });
        } catch (error) {
            logger?.error?.('[GitWatcher] onDegraded failed:', error);
        }
    }

    function clearBatch(entry) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.batch = { metadata: null, content: null };
    }

    function onEvent(entry, kind, filename) {
        if (entry.closed || !isRelevant(kind, filename)) return;
        const now = Date.now();
        if (kind === 'metadata' && now < entry.absorbUntil) return;
        const [debounceMs, capMs] = kind === 'metadata' ? [metadataMs, maxWaitMs] : [contentMs, contentMaxWaitMs];
        const lane = entry.batch[kind] || (entry.batch[kind] = { firstAt: now, due: 0 });
        lane.due = Math.min(now + debounceMs, lane.firstAt + capMs);
        const due = Math.min(...Object.values(entry.batch).filter(Boolean).map(item => item.due));
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => fire(entry), Math.max(0, due - now));
        entry.timer.unref?.();
    }

    function fire(entry) {
        clearBatch(entry);
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
        const entry = {
            id, closed: false, watchers: [], timer: null, batch: { metadata: null, content: null }, absorbUntil: 0,
            changes: 0, absorbed: 0, mode: 'pending', error: null, degradedReported: false, ready: null,
        };
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
                if (entry.error) reportDegraded(entry);
                return;
            }
            if (platform === 'linux') {
                // 只浅监听，所以每个 gitDir 都要单独挂：linked worktree 的 index/HEAD 在 .git/worktrees/<名字>/ 下，
                // 只挂外层的 .git 看不到 git add、切换已有分支
                for (const dir of new Set((targets.gitDirs || []).map(item => path.resolve(item)))) {
                    open(entry, dir, 'metadata', { recursive: false });
                    const refs = path.join(dir, 'refs');
                    if (exists(refs)) open(entry, refs, 'metadata', { prefix: 'refs/' });
                }
            } else {
                for (const dir of outermostDirs(targets.gitDirs || [])) open(entry, dir, 'metadata');
            }
            const watchContent = platform !== 'linux' && targets.root;
            if (watchContent) open(entry, targets.root, 'content');
            const kinds = new Set(entry.watchers.map(item => item.kind));
            entry.mode = !kinds.size ? 'failed' : !kinds.has('metadata') ? 'partial' : kinds.has('content') ? 'files' : 'metadata';
            if (entry.mode !== 'files') reportDegraded(entry); // 只看元数据（Linux）、.git 挂不上或一路都没挂上
        })();
        return entry.ready;
    }

    function stop(id) {
        const entry = entries.get(id);
        if (!entry) return;
        entries.delete(id);
        entry.closed = true;
        clearBatch(entry);
        for (const { watcher } of entry.watchers.splice(0)) {
            try { watcher.close(); } catch (_e) { /* 已关闭 */ }
        }
    }

    /** 应用自己刚改了仓库并已经通知：这件事不用监听再报一次 */
    function absorb(id) {
        const entry = entries.get(id);
        if (!entry || entry.closed) return;
        if (entry.timer) entry.absorbed += 1;
        clearBatch(entry);
        entry.absorbUntil = Date.now() + absorbMs;
    }

    /** 诊断用：只有工作区 id、监听方式、watcher 数和触发次数，不含路径 */
    function snapshot() {
        return [...entries.values()].map(entry => Object.freeze({
            workspaceId: entry.id,
            mode: entry.mode,
            watchers: entry.watchers.length,
            changes: entry.changes,
            absorbed: entry.absorbed,
            error: entry.error,
        }));
    }

    function dispose() {
        for (const id of [...entries.keys()]) stop(id);
    }

    return Object.freeze({
        start, stop, absorb, snapshot, dispose,
        isWatching: id => entries.has(id),
        /** 已经报过降级（文件内容看不全） */
        isDegraded: id => Boolean(entries.get(id)?.degradedReported),
    });
}

module.exports = { createGitWatcher, isRelevant, outermostDirs };
