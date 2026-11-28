// modules/musicLibraryScanner.js
//
// 曲库扫描：遍历文件夹、读取曲目信息、缓存封面。没有 electron 依赖，主进程和测试都能直接用。
//
// 三件事决定了它的形状：
//   1. 同时在读的文件数有上限。每个文件解析时都会把内嵌封面整张读进内存，
//      一次性把整个文件夹交给 worker 会让占用随曲库大小线性上涨。
//   2. 文件大小和修改时间都没变的曲目直接沿用上次的结果，不再打开文件。
//   3. 结果边扫边成批送出，进度按时间节流，而不是每个文件一条消息。

const path = require('path');
const fsp = require('fs/promises');
const os = require('os');
const { Worker } = require('worker_threads');
const { repairTrackTags } = require('./musicTagText');

const SUPPORTED_FORMATS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);
const isAudioFile = (file) => SUPPORTED_FORMATS.has(path.extname(String(file)).toLowerCase());
const WORKER_FILE = path.join(__dirname, 'musicScannerWorker.js');
const DEFAULTS = {
    batchSize: 64,
    batchIntervalMs: 250,
    progressIntervalMs: 100,
    statConcurrency: 32,
    perWorkerInFlight: 2
};

function defaultWorkerCount() {
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(4, cores - 1));
}

async function collectAudioFiles(rootDir, { signal, unreadable } = {}) {
    const found = [];
    const pending = [rootDir];
    while (pending.length) {
        if (signal?.aborted) break;
        const dir = pending.pop();
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
            console.error(`[MusicScan] Cannot read ${dir}: ${error.message}`);
            if (unreadable) unreadable.push(dir);
            continue;
        }
        // 同一目录内按名字排，目录按深度优先接在后面：结果顺序只取决于磁盘内容，不取决于谁先解析完。
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const subdirs = [];
        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            if (entry.isDirectory()) subdirs.push(path.join(dir, entry.name));
            else if (SUPPORTED_FORMATS.has(path.extname(entry.name).toLowerCase())) found.push(path.join(dir, entry.name));
        }
        for (let i = subdirs.length - 1; i >= 0; i--) pending.push(subdirs[i]);
    }
    return found;
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    const count = Math.min(limit, items.length);
    const workers = new Array(count);
    for (let i = 0; i < count; i += 1) workers[i] = run();
    await Promise.all(workers);
    return results;
}

const exists = (file) => fsp.access(file).then(() => true, () => false);

// 文件里没嵌封面的歌，用同目录的封面图（很多整轨 / 抓轨专辑只放一张 cover.jpg 或 folder.jpg）。
// 名字按常见程度排：cover > folder > front > albumart*，jpg/png/webp 都行，大小写不管。
const FOLDER_COVER_RANK = [/^cover\.(jpe?g|png|webp)$/i, /^folder\.(jpe?g|png|webp)$/i, /^front\.(jpe?g|png|webp)$/i, /^albumart.*\.(jpe?g|png)$/i];
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:\/\//i;
const DISC_DIR_RE = /^(?:cd|disc|disk|碟)\s*[-_]?\s*\d{1,2}\b/i;
const TRAIL_SEP_RE = /[\\/]+$/;
function pickFolderCover(names) {
    if (!names || !names.length) return null;
    for (let r = 0; r < FOLDER_COVER_RANK.length; r += 1) {
        const re = FOLDER_COVER_RANK[r];
        let best = null;
        for (let i = 0; i < names.length; i += 1) {
            const n = names[i];
            if (re.test(n) && (best === null || n < best)) best = n;
        }
        if (best !== null) return best;
    }
    return null;
}
async function fillFolderCovers(tracks, readdir = (dir) => fsp.readdir(dir)) {
    const candidates = [];
    const uniqueDirs = [];
    const seenDirs = new Set();
    for (const t of tracks) {
        if (!t || t.albumArt || typeof t.path !== 'string' || (t.path.indexOf('://') !== -1 && URL_SCHEME_RE.test(t.path))) continue;
        const dir = path.dirname(t.path);
        candidates.push({ track: t, dir });
        if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            uniqueDirs.push(dir);
        }
    }
    if (!candidates.length) return 0;
    // 同一目录及其父目录（CD1/CD2 共享专辑根目录）只读一次，并控制并发度并行查询
    const dirNamesCache = new Map();
    const readDirCached = (dir) => {
        if (!dirNamesCache.has(dir)) {
            dirNamesCache.set(dir, Promise.resolve().then(() => readdir(dir)).catch(() => []));
        }
        return dirNamesCache.get(dir);
    };
    const byDir = new Map();
    await mapLimit(uniqueDirs, 16, async (dir) => {
        const names = await readDirCached(dir);
        let hit = pickFolderCover(names);
        let home = dir;
        // 多碟专辑常把封面放在上一层（专辑/cover.jpg，歌在 专辑/CD1/ 里）
        if (!hit && DISC_DIR_RE.test(path.basename(dir))) {
            const up = path.dirname(dir);
            const upNames = await readDirCached(up);
            hit = pickFolderCover(upNames);
            if (hit) home = up;
        }
        byDir.set(dir, hit ? path.join(home, hit) : null);
    });
    let filled = 0;
    for (const { track, dir } of candidates) {
        const cover = byDir.get(dir);
        if (cover) { track.albumArt = cover; filled++; }
    }
    return filled;
}

// 上次扫到的曲目能不能原样沿用：文件没动过，而且它指向的封面缓存还在。
async function reusable(known, stat, coverSeen) {
    if (!known || !Number.isFinite(known.mtimeMs) || !Number.isFinite(known.size)) return false;
    if (known.size !== stat.size || Math.abs(known.mtimeMs - stat.mtimeMs) > 1) return false;
    if (!known.albumArt) return true;
    if (!coverSeen.has(known.albumArt)) coverSeen.set(known.albumArt, exists(known.albumArt));
    return await coverSeen.get(known.albumArt);
}

/**
 * @param {object} options
 * @param {string} [options.folderPath]
 * @param {string[]} [options.filePaths]  给了就只读这些音频文件，不遍历 folderPath
 * @param {string} options.coverCachePath
 * @param {Iterable<object>} [options.knownTracks]  上次保存的曲目（带 mtimeMs、size 的可以免解析）
 * @param {(info: {total: number, folderPath: string}) => void} [options.onStart]
 * @param {(info: {current: number, total: number, reused: number}) => void} [options.onProgress]
 * @param {(tracks: object[]) => void} [options.onBatch]  新解析出的曲目，按完成先后成批给
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{tracks: object[], folderPath: string, stats: object}>} tracks 按磁盘顺序
 */
async function scanFolder(options) {
    const {
        folderPath, filePaths, coverCachePath, knownTracks, onStart, onProgress, onBatch, signal,
        workerCount = defaultWorkerCount(), workerFile = WORKER_FILE
    } = options;
    const tune = { ...DEFAULTS, ...options.tuning };
    const startedAt = Date.now();

    // 读不了的目录（拔掉的移动硬盘、没权限、正被别的程序占着）：里面上次扫到的曲目原样留着，
    // 不当成「文件已删除」。解析失败的曲目同理沿用上次的结果。
    const unreadable = [];
    // filePaths：只读这几个文件（拖进窗口的单曲），不遍历文件夹
    let files;
    if (Array.isArray(filePaths)) {
        const seenFiles = new Set();
        files = [];
        for (let i = 0; i < filePaths.length; i += 1) {
            const f = filePaths[i];
            if (typeof f === 'string' && isAudioFile(f) && !seenFiles.has(f)) {
                seenFiles.add(f);
                files.push(f);
            }
        }
    } else {
        files = await collectAudioFiles(folderPath, { signal, unreadable });
    }
    const total = files.length;
    onStart?.({ total, folderPath });
    const stats = { total, parsed: 0, reused: 0, failed: 0, kept: 0, unreadable: unreadable.length, elapsedMs: 0, aborted: false };

    const known = new Map();
    if (knownTracks) for (const track of knownTracks) if (track && track.path) known.set(track.path, track);
    const isWin = process.platform === 'win32';
    const keptFromUnreadable = () => {
        if (!unreadable.length) return [];
        const bases = new Array(unreadable.length);
        for (let i = 0; i < unreadable.length; i += 1) {
            const trimmed = unreadable[i].replace(TRAIL_SEP_RE, '');
            bases[i] = { len: trimmed.length, target: isWin ? trimmed.toLowerCase() : trimmed };
        }
        const listed = new Set(files);
        const kept = [];
        for (const track of known.values()) {
            const file = track.path;
            if (listed.has(file)) continue;
            const normFile = isWin ? file.toLowerCase() : file;
            for (let i = 0; i < bases.length; i++) {
                const b = bases[i];
                if (file.length > b.len && (file[b.len] === '\\' || file[b.len] === '/') && normFile.startsWith(b.target)) {
                    kept.push(track);
                    break;
                }
            }
        }
        stats.kept += kept.length;
        return kept;
    };
    if (!total) return { tracks: keptFromUnreadable(), folderPath, stats };

    await fsp.mkdir(coverCachePath, { recursive: true });

    const slots = new Array(total).fill(null);
    let done = 0;
    let lastProgressAt = 0;
    let batch = [];
    let batchTimer = null;

    const flushBatch = () => {
        if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
        if (!batch.length) return;
        const out = batch;
        batch = [];
        onBatch?.(out);
    };
    const pushBatch = (track) => {
        if (!onBatch) return;
        batch.push(track);
        if (batch.length >= tune.batchSize) flushBatch();
        else if (!batchTimer) batchTimer = setTimeout(flushBatch, tune.batchIntervalMs);
    };
    const reportProgress = (force) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < tune.progressIntervalMs) return;
        lastProgressAt = now;
        onProgress?.({ current: done, total, reused: stats.reused });
    };

    // 第一步：只 stat，不开文件。没变的曲目在这里就定了。
    const coverSeen = new Map();
    const toParse = [];
    await mapLimit(files, tune.statConcurrency, async (filePath, index) => {
        if (signal?.aborted) return;
        let stat = null;
        try { stat = await fsp.stat(filePath); } catch (_) { /* 遍历之后被删掉的文件交给解析去报错 */ }
        const prior = known.get(filePath);
        if (stat && await reusable(prior, stat, coverSeen)) {
            // 没变的文件不重读，但旧版留下的 GBK 乱码标签顺手修好
            slots[index] = repairTrackTags(prior);
            stats.reused++;
            done++;
            reportProgress(false);
            return;
        }
        toParse.push({ index, filePath, size: stat ? stat.size : undefined, mtimeMs: stat ? stat.mtimeMs : undefined });
    });
    toParse.sort((a, b) => a.index - b.index);

    // 第二步：剩下的交给 worker，每个 worker 手里最多 perWorkerInFlight 个文件。
    if (toParse.length && !signal?.aborted) {
        const count = Math.max(1, Math.min(workerCount, Math.ceil(toParse.length / 8)));
        let cursor = 0;
        await new Promise((resolve) => {
            const workers = [];
            let alive = 0;
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener?.('abort', onAbort);
                for (const w of workers) w.terminate().catch(() => {});
                resolve();
            };
            const onAbort = () => finish();
            signal?.addEventListener?.('abort', onAbort, { once: true });

            const feed = (entry) => {
                while (entry.inFlight.size < tune.perWorkerInFlight && cursor < toParse.length) {
                    const job = toParse[cursor++];
                    entry.inFlight.set(job.index, job);
                    entry.worker.postMessage({ id: job.index, filePath: job.filePath });
                }
            };
            const settle = (job, track) => {
                if (track) {
                    track.size = job.size;
                    track.mtimeMs = job.mtimeMs;
                    slots[job.index] = track;
                    stats.parsed++;
                    pushBatch(track);
                } else {
                    stats.failed++;
                    // 这次读失败了（文件被占用、解析超时），上次读到过就先用上次的，不让它从曲库里消失。
                    const prior = known.get(job.filePath);
                    if (prior) { slots[job.index] = prior; stats.kept++; }
                }
                done++;
                reportProgress(false);
                if (done === total) finish();
            };

            const entries = [];
            try {
                for (let i = 0; i < count; i++) {
                    const entry = { worker: new Worker(workerFile, { workerData: { coverCachePath } }), inFlight: new Map() };
                    entries.push(entry);
                    workers.push(entry.worker);
                    alive++;
                    entry.worker.on('message', (result) => {
                        const job = entry.inFlight.get(result.id);
                        if (!job) return;
                        entry.inFlight.delete(result.id);
                        if (result.status !== 'success') console.error(result.error);
                        settle(job, result.status === 'success' ? result.data : null);
                        if (!settled) feed(entry);
                    });
                    const lost = (reason) => {
                        if (entry.dead) return;
                        entry.dead = true;
                        alive--;
                        if (settled) return;
                        console.error(`[MusicScan] Scanner worker stopped: ${reason}`);
                        // 这个 worker 手里的文件记为失败；还有别的 worker 就让它们接着做剩下的。
                        for (const job of entry.inFlight.values()) settle(job, null);
                        entry.inFlight.clear();
                        if (!alive && !settled) {
                            while (cursor < toParse.length) settle(toParse[cursor++], null);
                            finish();
                        }
                    };
                    entry.worker.on('error', (error) => lost(error.message));
                    entry.worker.on('exit', (code) => { if (code !== 0) lost(`exit code ${code}`); });
                    feed(entry);
                }
            } catch (err) {
                console.error(`[MusicScan] Failed to spawn scanner worker: ${err.message}`);
                for (const entry of entries) {
                    for (const job of entry.inFlight.values()) settle(job, null);
                    entry.inFlight.clear();
                }
                while (cursor < toParse.length) settle(toParse[cursor++], null);
                finish();
            }
        });
    }

    flushBatch();
    const foundTracks = [];
    for (let i = 0; i < slots.length; i += 1) {
        if (slots[i]) foundTracks.push(slots[i]);
    }
    if (!signal?.aborted) {
        try { stats.folderCovers = await fillFolderCovers(foundTracks); } catch (_) { /* 只是补封面 */ }
    }
    stats.aborted = Boolean(signal?.aborted);
    reportProgress(true);
    stats.elapsedMs = Date.now() - startedAt;
    return { tracks: foundTracks.concat(keptFromUnreadable()), folderPath, stats };
}

module.exports = { scanFolder, collectAudioFiles, SUPPORTED_FORMATS, pickFolderCover, fillFolderCovers };
