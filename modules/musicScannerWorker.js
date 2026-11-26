// modules/musicScannerWorker.js
const { parentPort, workerData } = require('worker_threads');
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

// 一张专辑的每首歌通常内嵌同一张封面：同名（内容哈希）文件写过一次就不再写。
const coversWritten = new Map();
function ensureCover(fullCoverPath, data) {
    let pending = coversWritten.get(fullCoverPath);
    if (!pending) {
        pending = fs.stat(fullCoverPath)
            .then((stat) => stat.size === data.length, () => false)
            .then((present) => (present ? undefined : fs.writeFile(fullCoverPath, data)));
        coversWritten.set(fullCoverPath, pending);
        pending.catch(() => coversWritten.delete(fullCoverPath));
    }
    return pending;
}

async function parseTrack(filePath) {
    let timer = null;
    let metadata;
    try {
        const parsePromise = musicMetadata.parseFile(filePath, { duration: true });
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
        const extension = (picture.format || 'image/jpeg').split('/')[1] || 'jpg';
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
