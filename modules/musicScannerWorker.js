// modules/musicScannerWorker.js
const { parentPort, workerData, threadId } = require('worker_threads');
const musicMetadata = require('music-metadata');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { repairTrackTags } = require('./musicTagText');

if (!parentPort) {
    throw new Error('This script must be run as a worker thread.');
}

const { coverCachePath } = workerData;
const PARSE_TIMEOUT_MS = 30000;
const MIME_EXT_MAP = Object.assign(Object.create(null), {
    jpeg: 'jpg',
    jpg: 'jpg',
    png: 'png',
    webp: 'webp',
    gif: 'gif',
    bmp: 'bmp',
    'x-ms-bmp': 'bmp',
    avif: 'avif',
    tiff: 'tiff',
    'svg+xml': 'svg'
});

const FAST_MIME_EXT = Object.assign(Object.create(null), {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
});

function safeCoverExtension(format) {
    if (typeof format === 'string' && FAST_MIME_EXT[format]) return FAST_MIME_EXT[format];
    const str = String(format || 'image/jpeg');
    const semi = str.indexOf(';');
    const raw = (semi !== -1 ? str.slice(0, semi) : str).trim().toLowerCase();
    const slash = raw.indexOf('/');
    const sub = slash !== -1 ? raw.slice(slash + 1) : raw;
    if (MIME_EXT_MAP[sub]) return MIME_EXT_MAP[sub];
    const clean = sub.replace(/[^a-z0-9]/g, '').slice(0, 8);
    return clean || 'jpg';
}

// 一张专辑的每首歌通常内嵌同一张封面：同名（内容哈希）文件写过一次就不再写。
// 写完后只保留路径到 Set，释放进行中的 Promise 引用；多 worker 同写用临时文件 + 改名防 Windows EBUSY/半截文件。
const coversDone = new Set();
const coversInFlight = new Map();
let tmpSeq = 0;

async function writeCoverAtomic(fullCoverPath, data) {
    const present = await fs.stat(fullCoverPath)
        .then((stat) => stat.size === data.length, () => false);
    if (present) return;
    const tmpPath = `${fullCoverPath}.${process.pid}.${threadId}.${++tmpSeq}.tmp`;
    await fs.writeFile(tmpPath, data);
    try {
        await fs.rename(tmpPath, fullCoverPath);
    } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        const already = await fs.stat(fullCoverPath)
            .then((stat) => stat.size === data.length, () => false);
        if (!already) throw err;
    }
}

function ensureCover(fullCoverPath, data) {
    if (coversDone.has(fullCoverPath)) return Promise.resolve();
    let pending = coversInFlight.get(fullCoverPath);
    if (!pending) {
        pending = writeCoverAtomic(fullCoverPath, data).then(
            () => {
                coversDone.add(fullCoverPath);
                coversInFlight.delete(fullCoverPath);
            },
            (err) => {
                coversInFlight.delete(fullCoverPath);
                throw err;
            }
        );
        coversInFlight.set(fullCoverPath, pending);
    }
    return pending;
}

async function parseTrack(filePath) {
    let timer = null;
    let metadata;
    try {
        const parsePromise = musicMetadata.parseFile(filePath, { duration: true });
        parsePromise.catch(() => {}); // 超时后底层延迟抛错时不触发 worker 未捕获拒绝
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Parsing timed out')), PARSE_TIMEOUT_MS);
        });
        metadata = await Promise.race([parsePromise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }

    // Find the best album art: prefer the 'Cover (front)' picture, else the first one
    let picture = null;
    if (metadata.common.picture && metadata.common.picture.length > 0) {
        picture = metadata.common.picture.find(p => p.type === 'Cover (front)') || metadata.common.picture[0];
    }

    let coverPath = null;
    if (picture) {
        // Content hash as the filename: identical covers share one cache file
        const hash = crypto.createHash('md5').update(picture.data).digest('hex');
        const extension = safeCoverExtension(picture.format);
        const fullCoverPath = path.join(coverCachePath, `${hash}.${extension}`);
        await ensureCover(fullCoverPath, picture.data);
        coverPath = fullCoverPath;
    }

    return repairTrackTags({
        path: filePath,
        title: metadata.common.title || path.basename(filePath),
        artist: metadata.common.artist,
        album: metadata.common.album,
        // 专辑里按碟号、曲号排；歌曲信息里显示年份、流派、专辑歌手
        trackNo: metadata.common.track && metadata.common.track.no || undefined,
        discNo: metadata.common.disk && metadata.common.disk.no || undefined,
        year: metadata.common.year || undefined,
        genre: Array.isArray(metadata.common.genre) && metadata.common.genre[0] || undefined,
        albumArtist: metadata.common.albumartist || undefined,
        albumArt: coverPath, // a file path, not raw data
        bitrate: metadata.format.bitrate,
        // 曲目档案卡显示的规格；旧歌单没有这些字段时界面按扩展名降级
        sampleRate: metadata.format.sampleRate,
        bitsPerSample: metadata.format.bitsPerSample,
        codec: metadata.format.codec || metadata.format.container,
        lossless: metadata.format.lossless,
        numberOfChannels: metadata.format.numberOfChannels,
        duration: metadata.format.duration
    });
}

// 消息是 { id, filePath }；也接受旧的纯路径字符串。
parentPort.on('message', async (message) => {
    const filePath = typeof message === 'string' ? message : message.filePath;
    const id = typeof message === 'string' ? undefined : message.id;
    try {
        parentPort.postMessage({ status: 'success', id, data: await parseTrack(filePath) });
    } catch (error) {
        // If any error occurs (including timeout), report it back
        parentPort.postMessage({
            status: 'error',
            id,
            error: `Failed to parse ${path.basename(filePath)}: ${error.message}`,
            path: filePath
        });
    }
});
