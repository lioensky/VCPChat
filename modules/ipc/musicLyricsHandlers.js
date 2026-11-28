// modules/ipc/musicLyricsHandlers.js
// 歌词的 IPC：读本地歌词（和歌同目录的 .ttml/.lrc 优先，其次歌词目录的 JSON / LRC 缓存）、联网抓词、
// 搜索候选、用选中的候选覆盖。抓词本身在 modules/lyricFetcher.js 和 modules/lyrics/。
// 由 musicHandlers.js 在注册 IPC 时调用；从那里搬出来，行为不变。
const path = require('path');
const fs = require('fs-extra');
const { decodeLyricText } = require('../lyrics/decodeLyricText');
const { parseTTML } = require('../lyrics/parserCore');

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]{2,}:\/\//i;
const LRC_TIMESTAMP_RE = /\[\d{1,3}:\d{2}/;
const SANITIZE_RE = /[\\/:"*?<>|]/g;
const SIDECAR_EXTS = ['.ttml', '.lrc'];
const sanitizeFilePart = (str) => String(str || '').replace(SANITIZE_RE, '_').trim();

function registerMusicLyricsHandlers({ ipcMain, lyricFetcher, getLyricDir }) {
    const ensuredLyricDirs = new Set();
    // 和歌放在一起的歌词（同目录同名的 .ttml / .lrc，很多人整理曲库时就这么放）：比歌词目录里自动下载的优先
    const statSidecar = async (file) => {
        try {
            const stat = await fs.stat(file);
            return stat.isFile() && stat.size <= 2 * 1024 * 1024 ? file : null;
        } catch (err) {
            if (err && err.code !== 'ENOENT') console.warn(`[Music] Error reading lyrics next to the track ${file}:`, err.message);
            return null;
        }
    };
    const readSidecarLyrics = async (trackPath) => {
        const p = typeof trackPath === 'string' ? trackPath : '';
        if (!p || URL_SCHEME_RE.test(p) || !path.isAbsolute(p)) return null;
        const base = p.slice(0, p.length - path.extname(p).length);
        if (!base || base === p) return null;
        // 并行探测同目录 .ttml 与 .lrc，仍严格按 .ttml 优先的顺序读取与解析
        const hits = await Promise.all(SIDECAR_EXTS.map((ext) => statSidecar(base + ext)));
        for (let i = 0; i < SIDECAR_EXTS.length; i += 1) {
            const file = hits[i];
            if (!file) continue;
            const ext = SIDECAR_EXTS[i];
            try {
                const text = decodeLyricText(await fs.readFile(file));
                if (ext === '.ttml') {
                    const parsed = parseTTML(text);
                    if (parsed && parsed.lines.length) return { ...parsed, source: 'sidecar' };
                    continue;
                }
                if (LRC_TIMESTAMP_RE.test(text)) return text;
            } catch (err) {
                if (err && err.code !== 'ENOENT') console.warn(`[Music] Error reading lyrics next to the track ${file}:`, err.message);
            }
        }
        return null;
    };

    ipcMain.handle('music-get-lyrics', async (event, { artist, title, rawObject, path: trackPath } = {}) => {
        if (!title) return null;

        const sidecar = await readSidecarLyrics(trackPath);
        if (sidecar) return sidecar;

        const sanitizedTitle = sanitizeFilePart(title);
        if (!sanitizedTitle) return null;
        const sanitizedArtist = artist ? sanitizeFilePart(artist) : '';
        const baseName = sanitizedArtist ? `${sanitizedArtist} - ${sanitizedTitle}` : sanitizedTitle;
        const lyricDir = getLyricDir();

        // Check JSON first if rawObject requested or available
        const jsonPath = path.join(lyricDir, `${baseName}.json`);
        try {
            return await fs.readJson(jsonPath);
        } catch (err) {
            if (!err || err.code !== 'ENOENT') {
                console.warn(`[Music] Error reading JSON lyric cache ${jsonPath}:`, err.message);
            }
        }

        // Fallback to LRC text cache
        const lrcPath = path.join(lyricDir, `${baseName}.lrc`);
        try {
            // 自己放进歌词目录的 .lrc 常是 GBK 或带 BOM 的 UTF-8/UTF-16
            return decodeLyricText(await fs.readFile(lrcPath));
        } catch (error) {
            if (!error || error.code !== 'ENOENT') {
                console.error(`[Music] Error reading lyric file ${lrcPath}:`, error);
            }
        }

        return null;
    });

    ipcMain.handle('music-fetch-lyrics', async (event, { artist, title, duration, durationMs, album, rawObject } = {}) => {
        if (!title) return null;
        console.log(`[Music] IPC: Received request to fetch lyrics for "${title}" by "${artist}"`);
        const lyricDir = getLyricDir();
        try {
            if (!ensuredLyricDirs.has(lyricDir)) {
                await fs.ensureDir(lyricDir);
                ensuredLyricDirs.add(lyricDir);
            }
            const result = await lyricFetcher.fetchAndSaveLyrics(artist, title, lyricDir, {
                duration,
                durationMs,
                album,
                rawObject: rawObject !== undefined ? rawObject : true
            });
            return result;
        } catch (error) {
            ensuredLyricDirs.delete(lyricDir);
            console.error(`[Music] Error fetching lyrics via IPC for "${title}":`, error);
            return null;
        }
    });

    ipcMain.handle('music-search-lyrics-candidates', async (event, options = {}) => {
        const title = typeof options.title === 'string' ? options.title.trim() : '';
        if (!title) return { success: false, message: '缺少歌曲标题', candidates: [] };

        try {
            const candidates = await lyricFetcher.searchLyricsCandidates({
                title,
                artist: typeof options.artist === 'string' ? options.artist.trim() : '',
                album: typeof options.album === 'string' ? options.album.trim() : '',
                durationMs: Number.isFinite(Number(options.durationMs))
                    ? Math.max(0, Number(options.durationMs))
                    : 0
            });
            return { success: true, candidates };
        } catch (error) {
            console.error(`[Music] Error searching lyric candidates for "${title}":`, error);
            return { success: false, message: error.message || '搜索歌词失败', candidates: [] };
        }
    });

    ipcMain.handle('music-apply-lyrics-candidate', async (event, options = {}) => {
        const title = typeof options.title === 'string' ? options.title.trim() : '';
        const candidateKey = typeof options.candidateKey === 'string' ? options.candidateKey : '';
        if (!title || !candidateKey) {
            return { success: false, message: '缺少歌曲或歌词候选信息' };
        }

        try {
            return await lyricFetcher.saveSelectedLyrics({
                candidateKey,
                title,
                artist: typeof options.artist === 'string' ? options.artist.trim() : '',
                lyricDir: getLyricDir()
            });
        } catch (error) {
            console.error(`[Music] Error applying lyric candidate for "${title}":`, error);
            return { success: false, message: error.message || '覆盖歌词失败' };
        }
    });
}

module.exports = { registerMusicLyricsHandlers };
