// modules/musicLibraryWatch.js
// 曲库文件夹自动同步：记住加过的音乐文件夹；音乐窗口打开后在后台把这些文件夹和已有曲目所在的文件夹
// 对一遍磁盘（没动过的文件只看大小和修改时间，不重新读），有新增、删除、改了标签才把结果发给窗口；
// 窗口开着时监听这些文件夹，文件有变化 5 秒后再对一遍。
// 后台这几遍不发 scan-start / progress，窗口里不会冒出「正在扫描」。
// 只有加过的文件夹做完整同步（新歌加进来、磁盘上没了的移除）；从曲目推出来的文件夹（以前加的、
// 拖进来的单曲所在的）只更新改过标签的已有曲目，不加也不删：不会把「下载」里别的音频一股脑加进曲库，
// 也不会因为曲库文件还没存盘就误删刚拖进来的歌。
// 拔掉的移动硬盘、读不了的文件夹：跳过，不当成歌被删了。

const path = require('path');
const fs = require('fs');

const AUDIO_EXT = /\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff|wv)$/i;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:\/\//i;
const MAX_WATCHED = 32;
const DEBOUNCE_MS = 5000;
const START_DELAY_MS = 4000;

const TRAIL_SEP_RE = /[\\/]+$/;
const norm = (p) => path.resolve(String(p)).replace(TRAIL_SEP_RE, '').toLowerCase();
const SEP_LOWER = path.sep.toLowerCase();
const isUnderNorm = (c, p) => c === p || c.startsWith(p + SEP_LOWER) || c.startsWith(p + '/') || c.startsWith(p + '\\');
const isUnder = (child, parent) => isUnderNorm(norm(child), norm(parent));

// 一组文件夹去掉被别的文件夹包含的，保持原顺序
function collapseRoots(dirs) {
    const out = [];
    const norms = [];
    for (let k = 0; k < dirs.length; k += 1) {
        const d = dirs[k];
        if (!d) continue;
        const dn = norm(d);
        let covered = false;
        for (let i = 0; i < norms.length; i += 1) {
            if (isUnderNorm(dn, norms[i])) { covered = true; break; }
        }
        if (covered) continue;
        for (let i = norms.length - 1; i >= 0; i -= 1) {
            if (isUnderNorm(norms[i], dn)) { out.splice(i, 1); norms.splice(i, 1); }
        }
        out.push(d);
        norms.push(dn);
    }
    return out;
}

// 已有曲目所在的文件夹（本机文件），按曲目数从多到少
function inferredDirs(tracks) {
    const count = new Map();
    const dirNormCache = new Map();
    const list = tracks || [];
    for (let i = 0; i < list.length; i += 1) {
        const t = list[i];
        const p = t && t.path;
        if (typeof p !== 'string' || t.isRemote || URL_SCHEME_RE.test(p)) continue;
        const d = path.dirname(p);
        let k = dirNormCache.get(d);
        if (k === undefined) {
            k = norm(d);
            dirNormCache.set(d, k);
        }
        const had = count.get(k);
        if (had) had.n++; else count.set(k, { dir: d, n: 1 });
    }
    const entries = [...count.values()].sort((a, b) => b.n - a.n);
    const out = new Array(entries.length);
    for (let i = 0; i < entries.length; i += 1) out[i] = entries[i].dir;
    return out;
}

// 这次扫到的和上次存的比，有没有变化（新增、删除、文件改过）
function changedSince(known, scanned, root) {
    const p = norm(root);
    const pSep = p + SEP_LOWER;
    const pSlash = p + '/';
    const pBack = p + '\\';
    const before = new Map();
    const dirUnderCache = new Map();
    const knownList = known || [];
    for (let i = 0; i < knownList.length; i += 1) {
        const t = knownList[i];
        const tp = t && t.path;
        if (typeof tp !== 'string' || t.isRemote || URL_SCHEME_RE.test(tp)) continue;
        let under;
        if (!tp.includes('..')) {
            const d = path.dirname(tp);
            under = dirUnderCache.get(d);
            if (under === undefined) {
                const dn = norm(d);
                under = dn === p || dn.startsWith(pSep) || dn.startsWith(pSlash) || dn.startsWith(pBack);
                dirUnderCache.set(d, under);
            }
        } else {
            const c = norm(tp);
            under = c === p || c.startsWith(pSep) || c.startsWith(pSlash) || c.startsWith(pBack);
        }
        if (under) before.set(tp, t);
    }
    const after = scanned || [];
    if (after.length !== before.size) return true;
    for (let i = 0; i < after.length; i += 1) {
        const t = after[i];
        const k = before.get(t.path);
        if (!k) return true;
        if (Number(k.size) !== Number(t.size) || Math.abs((Number(k.mtimeMs) || 0) - (Number(t.mtimeMs) || 0)) > 1) return true;
        if (!k.albumArt && t.albumArt) return true; // 新找到了封面（同目录的 cover.jpg）
    }
    return false;
}

function createLibraryWatch({
    scan,                 // (folderPath, signal) => Promise<{ tracks, stats }>
    readKnown,            // () => Promise<track[]>
    readFolders,          // () => Promise<string[]>
    writeFolders,         // (folders) => Promise<void>
    readExcluded = async () => [],   // 用户亲手移出曲库、文件还在的路径：完整同步时不再加回来
    writeExcluded = async () => {},
    fileExists = (p) => fs.promises.stat(p).then((st) => st.isFile(), () => false),
    send,                 // (channel, payload) => void
    exists = (dir) => fs.promises.stat(dir).then((s) => s.isDirectory(), () => false),
    watch = (dir, cb) => fs.watch(dir, { recursive: true }, cb),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = console
} = {}) {
    let watchers = [];
    let queue = [];
    let running = false;
    let generation = 0;
    let abort = null;
    const timers = new Map();

    const rememberFolder = async (dir) => {
        if (!dir) return;
        try {
            const list = (await readFolders()) || [];
            const target = norm(dir);
            if (list.some((d) => norm(d) === target)) return;
            await writeFolders(collapseRoots([...list, dir]));
        } catch (e) { log.warn?.('[MusicWatch] remember folder failed:', e?.message || e); }
    };

    // 加过的文件夹在前；推出来的文件夹去掉被加过的文件夹包含的，也去掉包含加过的文件夹的（太宽）
    const roots = async () => {
        const remembered = collapseRoots((await readFolders().catch(() => [])) || []);
        const rememberedNorms = remembered.map(norm);
        const known = (await readKnown().catch(() => [])) || [];
        const candidates = collapseRoots(inferredDirs(known));
        const inferred = [];
        for (let i = 0; i < candidates.length; i += 1) {
            const d = candidates[i];
            const dn = norm(d);
            let overlaps = false;
            for (let j = 0; j < rememberedNorms.length; j += 1) {
                const rn = rememberedNorms[j];
                if (isUnderNorm(dn, rn) || isUnderNorm(rn, dn)) { overlaps = true; break; }
            }
            if (!overlaps) inferred.push(d);
        }
        return { list: [...remembered, ...inferred], remembered, known };
    };
    let rememberedNow = [];

    const runQueue = async (gen) => {
        if (running) return;
        running = true;
        try {
            while (queue.length && gen === generation) {
                const root = queue.shift();
                if (!(await exists(root))) continue; // 拔掉的盘、改名的文件夹：不动
                const known = (await readKnown().catch(() => [])) || [];
                abort = new AbortController();
                let result;
                try { result = await scan(root, abort.signal); } catch (e) { log.warn?.('[MusicWatch] scan failed:', root, e?.message || e); continue; }
                if (gen !== generation || !result || result.stats?.aborted) continue;
                let tracks = result.tracks || [];
                const rootNorm = norm(root);
                const full = rememberedNow.some((r) => norm(r) === rootNorm);
                if (!full) {
                    const byPath = new Map();
                    for (let i = 0; i < known.length; i += 1) {
                        const t = known[i];
                        if (t && t.path) byPath.set(t.path, t);
                    }
                    tracks = tracks.filter((t) => {
                        const k = byPath.get(t.path);
                        return k && (Number(k.size) !== Number(t.size) || Math.abs((Number(k.mtimeMs) || 0) - (Number(t.mtimeMs) || 0)) > 1 || (!k.albumArt && t.albumArt));
                    });
                    if (!tracks.length) continue;
                    // 扫的这段时间里用户可能把其中一些移出了曲库（整理重复的歌）：按最新的曲库再筛一遍，不把它们加回去
                    const latestList = (await readKnown().catch(() => [])) || [];
                    const latest = new Set();
                    for (let i = 0; i < latestList.length; i += 1) {
                        const p = latestList[i] && latestList[i].path;
                        if (p) latest.add(p);
                    }
                    tracks = tracks.filter((t) => latest.has(t.path));
                    if (!tracks.length || gen !== generation) continue;
                } else {
                    const excluded = new Set((await readExcluded().catch(() => [])) || []);
                    if (excluded.size) tracks = tracks.filter((t) => !excluded.has(t.path));
                    if (!changedSince(known, tracks, root)) continue;
                }
                log.log?.(`[MusicWatch] ${root} changed on disk, syncing ${tracks.length} tracks (${full ? 'full' : 'update only'})`);
                // folderPath 为空时窗口只加、只更新，不删
                send('music-scan-complete', { tracks, folderPath: full ? root : null, stats: { total: result.stats?.total || 0, failed: result.stats?.failed || 0 }, background: true });
            }
        } finally {
            running = false;
            abort = null;
        }
    };

    const enqueue = (root) => {
        const rootNorm = norm(root);
        if (!queue.some((r) => norm(r) === rootNorm)) queue.push(root);
        runQueue(generation).catch(() => {});
    };

    const start = () => {
        stop();
        const gen = ++generation;
        const t = setTimer(async () => {
            timers.delete('start');
            if (gen !== generation) return;
            const { list, remembered } = await roots();
            if (gen !== generation) return;
            rememberedNow = remembered;
            list.forEach(enqueue);
            for (const root of list.slice(0, MAX_WATCHED)) {
                if (!(await exists(root)) || gen !== generation) continue;
                try {
                    const w = watch(root, (_type, file) => {
                        if (gen !== generation) return;
                        const f = String(file || '');
                        // 文件夹本身的变化（拷进来一整张专辑）也算；别的文件（封面、歌词）不管
                        if (f && path.extname(f) && !AUDIO_EXT.test(f)) return;
                        clearTimer(timers.get(root));
                        const dt = setTimer(() => { timers.delete(root); if (gen === generation) enqueue(root); }, DEBOUNCE_MS);
                        dt?.unref?.();
                        timers.set(root, dt);
                    });
                    const entry = { root, w };
                    w.on?.('error', () => {
                        const idx = watchers.indexOf(entry);
                        if (idx !== -1) watchers.splice(idx, 1);
                        try { w.close(); } catch (e) { /* 已关 */ }
                    });
                    watchers.push(entry);
                } catch (e) { log.warn?.('[MusicWatch] watch failed:', root, e?.message || e); }
            }
        }, START_DELAY_MS);
        t?.unref?.();
        timers.set('start', t);
    };

    function stop() {
        generation++;
        queue = [];
        abort?.abort();
        for (const t of timers.values()) clearTimer(t);
        timers.clear();
        for (const entry of watchers) { try { entry.w.close(); } catch (e) { /* 已关 */ } }
        watchers = [];
    }

    // 曲库存盘时比一比：少了的路径里文件还在磁盘上的，是用户移出曲库的（右键移除、整理重复的歌），记下来；
    // 又出现在曲库里的（重新加了文件夹、撤销），从记录里拿掉。
    let excludeChain = Promise.resolve();
    const noteLibrarySaved = (prev, next) => {
        excludeChain = excludeChain.then(async () => {
            const nextPaths = new Set();
            if (Array.isArray(next)) {
                for (let i = 0; i < next.length; i += 1) {
                    const p = next[i] && next[i].path;
                    if (p) nextPaths.add(p);
                }
            }
            const list = (await readExcluded().catch(() => [])) || [];
            const set = new Set();
            for (let i = 0; i < list.length; i += 1) {
                const p = list[i];
                if (!nextPaths.has(p)) set.add(p);
            }
            let changed = set.size !== list.length;
            const toCheck = [];
            if (Array.isArray(prev)) {
                for (let i = 0; i < prev.length && toCheck.length < 5000; i += 1) {
                    const p = prev[i] && prev[i].path;
                    if (typeof p === 'string' && !nextPaths.has(p) && !URL_SCHEME_RE.test(p) && !set.has(p)) {
                        toCheck.push(p);
                    }
                }
            }
            for (let at = 0; at < toCheck.length; at += 32) {
                const slice = toCheck.slice(at, at + 32);
                const results = await Promise.all(slice.map((p) => fileExists(p)));
                for (let i = 0; i < slice.length; i++) {
                    if (results[i] && !set.has(slice[i])) { set.add(slice[i]); changed = true; }
                }
            }
            if (changed) await writeExcluded([...set].slice(-20000));
        }).catch((e) => log.warn?.('[MusicWatch] note removals failed:', e?.message || e));
        return excludeChain;
    };

    const rememberAndSync = async (dir) => {
        await rememberFolder(dir);
        const dirNorm = norm(dir);
        if (!rememberedNow.some((r) => norm(r) === dirNorm)) rememberedNow = collapseRoots([...rememberedNow, dir]);
    };
    // 曲库文件夹管理用：加过的文件夹；「移出」时从记录里拿掉（连同它下面的子文件夹），之后不再同步它
    const folders = async () => collapseRoots((await readFolders().catch(() => [])) || []);
    const forgetFolder = async (dir) => {
        if (!dir) return false;
        const dirNorm = norm(dir);
        const underDir = (candidate) => isUnderNorm(norm(candidate), dirNorm);
        const list = (await readFolders().catch(() => [])) || [];
        const kept = list.filter((d) => !underDir(d));
        if (kept.length !== list.length) await writeFolders(kept);
        rememberedNow = rememberedNow.filter((d) => !underDir(d));
        queue = queue.filter((d) => !underDir(d));
        for (const [rootKey, timerId] of timers) {
            if (rootKey !== 'start' && underDir(rootKey)) {
                clearTimer(timerId);
                timers.delete(rootKey);
            }
        }
        for (let i = watchers.length - 1; i >= 0; i--) {
            if (underDir(watchers[i].root)) {
                try { watchers[i].w.close(); } catch (e) { /* 已关 */ }
                watchers.splice(i, 1);
            }
        }
        return kept.length !== list.length;
    };
    return {
        start,
        stop,
        noteLibrarySaved,
        folders,
        forgetFolder,
        rememberFolder: rememberAndSync,
        rescanNow: () => {
            const gen = generation;
            return roots().then(({ list, remembered }) => {
                if (gen !== generation) return;
                rememberedNow = remembered;
                list.forEach(enqueue);
            });
        }
    };
}

module.exports = { createLibraryWatch, collapseRoots, inferredDirs, changedSince };
