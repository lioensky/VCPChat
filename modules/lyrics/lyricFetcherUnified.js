// modules/lyrics/lyricFetcherUnified.js
// Multi-source lyrics fetcher supporting NetEase (YRC), QQ Music (QRC), Kugou (KRC), and AMLL (TTML)
// Includes score-based candidate selection, duration tolerance check, and structured LyricData output.

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { parseYRC, parseQRC, parseKRC, parseTTML, parseLRC, convertToLrcString } = require('./parserCore');
const { qrcDecrypt } = require('./qrcDecrypt');
const { krcDecrypt } = require('./krcDecrypt');
const { calculateMatchScore } = require('./matchScore');

const DEFAULT_TIMEOUT_MS = 6000;
const AMLL_DB_BASE_URL = 'https://amll-ttml-db.stevexmh.net';
const MANUAL_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const AUTO_MATCH_MIN_SCORE = 60;
const AUTO_CANDIDATES_PER_SOURCE = 3;
const LYRIC_QUALITY_BONUS = Object.freeze({
    wordByWord: 12,
    amllTtml: 3,
    translation: 1,
    romanization: 0.5
});
const manualCandidateCache = new Map();

const SOURCE_LABELS = {
    netease: '网易云音乐',
    qq: 'QQ 音乐',
    kugou: '酷狗音乐',
    amll: 'AMLL TTML'
};

// Helper: MD5 hash
function md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

// Helper: Base64
function toBase64(str) {
    return Buffer.from(str || '', 'utf8').toString('base64');
}

// ==========================================
// 1. NetEase Cloud Music Provider
// ==========================================
async function searchNetEase(query, targetSong) {
    try {
        const res = await axios.get('https://music.163.com/api/search/get/', {
            params: { s: query, type: 1, limit: 10 },
            headers: { 'Referer': 'https://music.163.com', 'User-Agent': 'Mozilla/5.0' },
            timeout: DEFAULT_TIMEOUT_MS
        });
        const songs = res.data?.result?.songs || [];
        return songs.map(s => ({
            source: 'netease',
            id: s.id,
            title: s.name,
            artist: (s.artists || []).map(a => a.name).join(', '),
            album: s.album?.name || '',
            durationMs: s.duration || 0,
            raw: s
        }));
    } catch (err) {
        console.warn('[LyricFetcher] NetEase search error:', err.message);
        return [];
    }
}

async function fetchNetEaseLyric(songId) {
    try {
        // Fetch new lyric payload (supporting YRC, LRC, translations, and romanization)
        const res = await axios.get('https://interface3.music.163.com/api/song/lyric', {
            params: {
                id: songId,
                cp: 'false',
                tv: '0',
                lv: '0',
                rv: '0',
                kv: '0',
                yv: '0',
                ytv: '0',
                yrv: '0'
            },
            headers: {
                'Referer': 'https://music.163.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: DEFAULT_TIMEOUT_MS
        });

        const data = res.data;
        if (!data) return null;

        const isPureMusic = Boolean(data.pureMusic || data.lrc?.lyric?.includes('纯音乐，请欣赏'));
        const yrc = data.yrc?.lyric;
        const lrc = data.lrc?.lyric;
        const trans = data.ytlrc?.lyric || data.tlyric?.lyric || '';
        const roma = data.yromalrc?.lyric || data.romalrc?.lyric || '';

        if (isPureMusic) {
            return { isPureMusic: true, lyrics: null, source: 'netease', id: songId };
        }

        if (yrc && yrc.trim()) {
            const parsed = parseYRC(yrc, trans, roma);
            return { lyrics: parsed, isPureMusic: false, source: 'netease', id: songId };
        } else if (lrc && lrc.trim()) {
            const parsed = parseLRC(lrc, trans, roma);
            return { lyrics: parsed, isPureMusic: false, source: 'netease', id: songId };
        }
        return null;
    } catch (err) {
        console.warn(`[LyricFetcher] NetEase fetch failed for ${songId}:`, err.message);
        return null;
    }
}

// ==========================================
// 2. QQ Music Provider
// ==========================================
async function requestQQMusic(method, module, param) {
    const payload = {
        comm: {
            ct: 11,
            cv: "1003006",
            v: "1003006",
            os_ver: "15",
            phonetype: "24122RKC7C",
            rom: "Redmi/miro/miro:15/AE3A.240806.005/OS2.0.102.0.VOMCNXM:user/release-keys",
            tmeAppID: "qqmusiclight",
            nettype: "NETWORK_WIFI",
            udid: "0",
            uid: "0",
        },
        request: { method, module, param }
    };

    const res = await axios.post('https://u.y.qq.com/cgi-bin/musicu.fcg', payload, {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'okhttp/3.14.9'
        },
        timeout: DEFAULT_TIMEOUT_MS
    });

    if (res.data?.code !== 0 || res.data?.request?.code !== 0) {
        throw new Error(`QQ Music API error: code ${res.data?.code || res.data?.request?.code}`);
    }
    return res.data?.request?.data;
}

async function searchQQ(query) {
    try {
        const param = {
            search_id: String(Math.floor(Math.random() * 100000000000000 + Date.now() % 86400000)),
            remoteplace: "search.android.keyboard",
            query: query.slice(0, 60),
            search_type: 0,
            num_per_page: 10,
            page_num: 1,
            highlight: 0,
            nqc_flag: 0,
            page_id: 1,
            grp: 1,
        };

        const data = await requestQQMusic("DoSearchForQQMusicLite", "music.search.SearchCgiService", param);
        const songs = data?.body?.item_song || [];
        return songs.map(info => ({
            source: 'qq',
            id: Number(info.id || 0),
            qqMid: info.mid,
            title: info.title || '',
            artist: (info.singer || []).map(s => s.name).join(', '),
            album: info.album?.name || '',
            durationMs: (info.interval || 0) * 1000,
            raw: info
        }));
    } catch (err) {
        console.warn('[LyricFetcher] QQ Music search error:', err.message);
        return [];
    }
}

async function fetchQQLyric(songCandidate) {
    try {
        const { id, qqMid, title, artist, album, durationMs } = songCandidate;
        const param = {
            albumName: toBase64(album || ''),
            crypt: 1,
            ct: 19,
            cv: 2111,
            interval: Math.floor((durationMs || 0) / 1000),
            lrc_t: 0,
            qrc: 1,
            qrc_t: 0,
            roma: 1,
            roma_t: 0,
            singerName: toBase64(artist || ''),
            songID: Number(id),
            songName: toBase64(title || ''),
            trans: 1,
            trans_t: 0,
            type: 0,
        };

        const data = await requestQQMusic("GetPlayLyricInfo", "music.musichallSong.PlayLyricInfo", param);
        const encryptedLyricHex = data?.lyric;
        const encryptedTransHex = data?.trans;
        const encryptedRomanHex = data?.roma;

        if (!encryptedLyricHex) return null;

        const decryptedLyric = await qrcDecrypt(encryptedLyricHex);
        const decryptedTrans = encryptedTransHex ? await qrcDecrypt(encryptedTransHex) : '';
        const decryptedRoma = encryptedRomanHex ? await qrcDecrypt(encryptedRomanHex) : '';

        const isQrc = decryptedLyric.includes('(') && decryptedLyric.includes(')') && /\[\d+,\d+\]/.test(decryptedLyric);
        const parsed = isQrc
            ? parseQRC(decryptedLyric, decryptedTrans, decryptedRoma)
            : parseLRC(decryptedLyric, decryptedTrans, decryptedRoma);

        return { lyrics: parsed, isPureMusic: false, source: 'qq', id, qqMid };
    } catch (err) {
        console.warn('[LyricFetcher] QQ Music fetch error:', err.message);
        return null;
    }
}

// ==========================================
// 3. Kugou Music Provider
// ==========================================
async function searchKugou(query) {
    try {
        const clientTimeMs = Date.now();
        const clientTimeSec = Math.floor(clientTimeMs / 1000);
        const mid = md5(String(clientTimeMs));
        const params = {
            sorttype: '0',
            keyword: query,
            pagesize: 10,
            page: 1,
            userid: '0',
            appid: '3116',
            token: '',
            clienttime: clientTimeSec,
            iscorrection: '1',
            uuid: '-',
            mid,
            dfid: '-',
            clientver: '11070',
            platform: 'AndroidFilter',
        };

        const signatureSource = Object.keys(params)
            .sort()
            .map(k => `${k}=${params[k]}`)
            .join('');
        params.signature = md5(`LnT6xpN3khm36zse0QzvmgTZ3waWdRSA${signatureSource}LnT6xpN3khm36zse0QzvmgTZ3waWdRSA`);

        const res = await axios.get('http://complexsearch.kugou.com/v2/search/song', {
            params,
            headers: {
                'User-Agent': 'Android14-1070-11070-201-0-SearchSong-wifi',
                'KG-Rec': '1',
                'KG-RC': '1',
                'KG-CLIENTTIMEMS': String(clientTimeMs),
                mid,
                'x-router': 'complexsearch.kugou.com',
            },
            timeout: DEFAULT_TIMEOUT_MS
        });

        const lists = res.data?.data?.lists || [];
        return lists.map(item => ({
            source: 'kugou',
            id: item.FileHash || item.OriSongHash || item.AuxiliaryHash || '',
            hash: (item.FileHash || item.OriSongHash || item.AuxiliaryHash || '').toUpperCase(),
            title: item.SongName || item.FileName || '',
            artist: item.SingerName || '',
            album: item.AlbumName || '',
            durationMs: (item.Duration || 0) * 1000,
            raw: item
        }));
    } catch (err) {
        console.warn('[LyricFetcher] Kugou search error:', err.message);
        return [];
    }
}

async function fetchKugouLyric(songCandidate) {
    try {
        const { hash, title, durationMs } = songCandidate;
        if (!hash) return null;

        // Search candidate in Kugou lyric center
        const searchRes = await axios.get('http://lyrics.kugou.com/search', {
            params: {
                ver: 1,
                man: 'yes',
                client: 'pc',
                keyword: title,
                hash: hash,
                timelength: durationMs || 0
            },
            timeout: DEFAULT_TIMEOUT_MS
        });

        const candidates = searchRes.data?.candidates || [];
        if (candidates.length === 0) return null;

        const candidate = candidates[0];
        const downloadRes = await axios.get('http://lyrics.kugou.com/download', {
            params: {
                ver: 1,
                client: 'pc',
                id: candidate.id,
                accesskey: candidate.accesskey,
                fmt: 'krc',
                charset: 'utf8'
            },
            timeout: DEFAULT_TIMEOUT_MS
        });

        const content = downloadRes.data?.content;
        if (!content) return null;

        const decrypted = krcDecrypt(content);
        const parsed = parseKRC(decrypted);

        return { lyrics: parsed, isPureMusic: false, source: 'kugou', id: hash };
    } catch (err) {
        console.warn('[LyricFetcher] Kugou fetch error:', err.message);
        return null;
    }
}

// ==========================================
// 4. AMLL TTML DB Provider
// ==========================================
async function fetchAmllDb(platform, songId) {
    try {
        const url = `${AMLL_DB_BASE_URL}/${platform}/${encodeURIComponent(String(songId))}?format=ttml`;
        const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT_MS });
        if (!res.data || typeof res.data !== 'string' || !res.data.includes('<p')) return null;

        const parsed = parseTTML(res.data);
        if (parsed.lines.length === 0) return null;

        return { lyrics: parsed, isPureMusic: false, source: 'amll', platform, id: songId };
    } catch (err) {
        return null;
    }
}

// ==========================================
// Manual candidate search / selection
// ==========================================
function cleanupManualCandidateCache() {
    const now = Date.now();
    for (const [key, entry] of manualCandidateCache) {
        if (!entry || now - entry.createdAt > MANUAL_CANDIDATE_TTL_MS) {
            manualCandidateCache.delete(key);
        }
    }
}

function scoreCandidates(target, candidates, limit = 3) {
    return (candidates || [])
        .map(candidate => {
            const details = calculateMatchScore(target, candidate);
            return { ...candidate, matchScore: details.score, scoreDetails: details };
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, limit);
}

async function fetchCandidateLyrics(candidate) {
    if (!candidate || !candidate.source) return null;
    if (candidate.source === 'netease') return fetchNetEaseLyric(candidate.id);
    if (candidate.source === 'qq') return fetchQQLyric(candidate);
    if (candidate.source === 'kugou') return fetchKugouLyric(candidate);
    if (candidate.source === 'amll') return fetchAmllDb(candidate.platform, candidate.id);
    return null;
}

function createCandidateSummary(candidate, result) {
    const lyrics = result?.lyrics;
    if (!lyrics || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) return null;

    const candidateKey = crypto.randomUUID();
    manualCandidateCache.set(candidateKey, {
        createdAt: Date.now(),
        lyrics,
        source: result.source || candidate.source,
        platform: result.platform || candidate.platform || null,
        sourceId: result.id || candidate.id
    });

    const preview = lyrics.lines
        .slice(0, 3)
        .map(line => line.fullText)
        .filter(Boolean)
        .join(' / ');

    return {
        candidateKey,
        source: result.source || candidate.source,
        sourceLabel: SOURCE_LABELS[result.source || candidate.source] || result.source || candidate.source,
        platform: result.platform || candidate.platform || null,
        title: candidate.title || '',
        artist: candidate.artist || '',
        album: candidate.album || '',
        durationMs: candidate.durationMs || 0,
        matchScore: Math.round(candidate.matchScore || 0),
        isWordByWord: Boolean(lyrics.isWordByWord),
        hasTranslation: lyrics.lines.some(line => Boolean(line.translation)),
        hasRomanization: lyrics.lines.some(line => Boolean(line.romanization)),
        lineCount: lyrics.lines.length,
        preview
    };
}

function buildCandidateProbeTasks(candidate) {
    const tasks = [
        fetchCandidateLyrics(candidate)
            .then(result => result?.lyrics ? { candidate, result } : null)
            .catch(() => null)
    ];

    if (candidate.source === 'netease' || candidate.source === 'qq') {
        const platform = candidate.source === 'netease' ? 'ncm' : 'qq';
        tasks.push(
            fetchAmllDb(platform, candidate.id)
                .then(result => result?.lyrics ? { candidate, result } : null)
                .catch(() => null)
        );
    }
    return tasks;
}

/**
 * Shared provider pipeline for manual and automatic lyric acquisition.
 * Both consumers see the exact same searched, scored, downloaded and parsed set.
 */
async function collectProbedLyrics(target) {
    const query = [target.title, target.artist].filter(Boolean).join(' ');
    const [netease, qq, kugou] = await Promise.all([
        searchNetEase(query, target),
        searchQQ(query),
        searchKugou(query)
    ]);

    const candidates = [
        ...scoreCandidates(target, netease),
        ...scoreCandidates(target, qq),
        ...scoreCandidates(target, kugou)
    ];

    return (await Promise.all(candidates.flatMap(buildCandidateProbeTasks)))
        .filter(Boolean);
}

async function searchLyricsCandidates({ artist, title, durationMs, album }) {
    if (!title) return [];
    cleanupManualCandidateCache();

    const target = {
        title: title.trim(),
        artist: (artist || '').trim(),
        durationMs: durationMs || 0,
        album: (album || '').trim()
    };
    const probed = await collectProbedLyrics(target);
    const summaries = probed
        .map(({ candidate, result }) => createCandidateSummary(candidate, result))
        .filter(Boolean);

    // 自动获取直接使用首项：
    // 匹配分数优先；分数相同则流式逐字符优先；
    // 仍相同则优先选择时长与目标音频时长更接近的歌词。
    return summaries.sort((a, b) =>
        b.matchScore - a.matchScore
        || Number(b.isWordByWord) - Number(a.isWordByWord)
        || Math.abs((a.durationMs || 0) - target.durationMs)
            - Math.abs((b.durationMs || 0) - target.durationMs)
    );
}

async function saveSelectedLyrics({ candidateKey, artist, title, lyricDir }) {
    if (!candidateKey || !title || !lyricDir) {
        return { success: false, message: '缺少歌词候选或曲目信息' };
    }

    cleanupManualCandidateCache();
    const cached = manualCandidateCache.get(candidateKey);
    if (!cached?.lyrics) {
        return { success: false, message: '歌词候选已过期，请重新搜索' };
    }

    const sanitize = (str) => (str || '').replace(/[\\/:"*?<>|]/g, '_').trim();
    const baseName = artist ? `${sanitize(artist)} - ${sanitize(title)}` : sanitize(title);
    const jsonPath = path.join(lyricDir, `${baseName}.json`);
    const lrcPath = path.join(lyricDir, `${baseName}.lrc`);

    await fs.ensureDir(lyricDir);
    await Promise.all([
        fs.writeJson(jsonPath, cached.lyrics, { spaces: 2 }),
        fs.writeFile(lrcPath, convertToLrcString(cached.lyrics), 'utf8')
    ]);
    manualCandidateCache.delete(candidateKey);

    return {
        success: true,
        lyrics: cached.lyrics,
        source: cached.source,
        platform: cached.platform
    };
}

// ==========================================
// Cross-provider audit and selection
// ==========================================
function getLyricFeatureFlags(result) {
    const lyrics = result?.lyrics;
    const lines = Array.isArray(lyrics?.lines) ? lyrics.lines : [];
    return {
        valid: lines.length > 0,
        isWordByWord: Boolean(lyrics?.isWordByWord),
        hasTranslation: lines.some(line => Boolean(line?.translation)),
        hasRomanization: lines.some(line => Boolean(line?.romanization))
    };
}

function createAuditedLyrics(candidate, result, target = {}) {
    const features = getLyricFeatureFlags(result);
    if (!features.valid || !Number.isFinite(Number(candidate?.matchScore))
        || Number(candidate.matchScore) < AUTO_MATCH_MIN_SCORE) return null;

    const qualityBonus =
        (features.isWordByWord ? LYRIC_QUALITY_BONUS.wordByWord : 0)
        + (result.source === 'amll' ? LYRIC_QUALITY_BONUS.amllTtml : 0)
        + (features.hasTranslation ? LYRIC_QUALITY_BONUS.translation : 0)
        + (features.hasRomanization ? LYRIC_QUALITY_BONUS.romanization : 0);

    return {
        candidate,
        result,
        features,
        matchScore: Number(candidate.matchScore),
        qualityBonus,
        durationDifference: target.durationMs > 0 && candidate.durationMs > 0
            ? Math.abs(Number(candidate.durationMs) - Number(target.durationMs))
            : Infinity,
        auditScore: Number(candidate.matchScore) + qualityBonus
    };
}

function rankAuditedLyrics(entries) {
    return (entries || [])
        .filter(Boolean)
        // 自动下载选优规则：
        // 匹配分数优先；同分时流式逐字符优先；
        // 仍相同则优先歌词时长与目标音频时长更接近；
        // 最后才使用质量加分和其他特性打破剩余平局。
        .sort((a, b) =>
            b.matchScore - a.matchScore
            || Number(b.features?.isWordByWord) - Number(a.features?.isWordByWord)
            || (a.durationDifference || 0) - (b.durationDifference || 0)
            || b.auditScore - a.auditScore
            || Number(b.result?.source === 'amll') - Number(a.result?.source === 'amll')
        );
}

// ==========================================
// Master Auto Match Pipeline
// ==========================================
async function autoMatchLyrics(target) {
    const { title, artist, durationMs } = target;
    const query = [title, artist].filter(Boolean).join(' ');
    console.log(`[LyricFetcher] Auditing shared provider results for "${query}" (duration: ${durationMs}ms)`);

    const probed = await collectProbedLyrics(target);
    const audited = rankAuditedLyrics(
        probed.map(({ candidate, result }) => createAuditedLyrics(candidate, result, target))
    );
    const winner = audited[0];

    if (!winner) {
        console.warn(`[LyricFetcher] No audited candidate contained usable lyrics for ${title} - ${artist}`);
        return null;
    }

    console.log(
        `[LyricFetcher] Audit winner: ${winner.result.source}`
        + `${winner.result.platform ? `/${winner.result.platform}` : ''}`
        + `, match=${winner.matchScore}, quality=+${winner.qualityBonus}, total=${winner.auditScore}`
        + `, wordByWord=${winner.features.isWordByWord}`
    );
    return winner.result;
}

/**
 * High-level fetch and save function used by IPC.
 * Stores both json (LyricData) and .lrc file for backwards compatibility.
 */
async function fetchAndSaveLyricsUnified({ artist, title, durationMs, album, lyricDir }) {
    if (!title) return null;

    const target = {
        title: title.trim(),
        artist: (artist || '').trim(),
        durationMs: durationMs || 0,
        album: (album || '').trim()
    };

    const result = await autoMatchLyrics(target);
    if (!result || !result.lyrics) {
        return null;
    }

    try {
        await fs.ensureDir(lyricDir);
        const sanitize = (str) => (str || '').replace(/[\\/:"*?<>|]/g, '_').trim();
        const baseName = artist ? `${sanitize(artist)} - ${sanitize(title)}` : sanitize(title);

        // Save structured JSON format for high precision UI
        const jsonPath = path.join(lyricDir, `${baseName}.json`);
        await fs.writeJson(jsonPath, result.lyrics, { spaces: 2 });

        // Save traditional LRC file for backwards compatibility
        const lrcString = convertToLrcString(result.lyrics);
        const lrcPath = path.join(lyricDir, `${baseName}.lrc`);
        await fs.writeFile(lrcPath, lrcString, 'utf8');

        console.log(`[LyricFetcher] Saved lyrics cache to ${lrcPath} and ${jsonPath}`);
    } catch (err) {
        console.error('[LyricFetcher] Failed to save lyric cache:', err.message);
    }

    return result.lyrics;
}

module.exports = {
    AUTO_MATCH_MIN_SCORE,
    LYRIC_QUALITY_BONUS,
    autoMatchLyrics,
    collectProbedLyrics,
    createCandidateSummary,
    createAuditedLyrics,
    rankAuditedLyrics,
    fetchAndSaveLyricsUnified,
    searchLyricsCandidates,
    saveSelectedLyrics,
    convertToLrcString
};