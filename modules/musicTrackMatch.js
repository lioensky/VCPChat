// modules/musicTrackMatch.js
//
// AI 点歌（MusicController playSong）按名字找曲目。原来取曲库里第一首「标题或歌手包含这段文字」的歌，
// 「Lemon」会先撞上排在前面的「Lemon Tree」，「歌名 - 歌手」这种写法一首也找不到。
// 现在给每首打分，取最高分；同分取曲库里靠前的。没有 electron 依赖，测试直接用。

const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'ape', 'wma', 'alac', 'aif', 'aiff', 'dsf', 'dff', 'wv']);
const SPACE_UNDER_RE = /[\s_]+/g;
const SPLIT_QUERY_RE = /\s+[-–—]\s+|\s+by\s+|\s*\/\s*|\s*的\s*/i;

function baseNameOf(rawPath) {
    const s = String(rawPath);
    for (let i = s.length - 1; i >= 0; i -= 1) {
        const c = s.charCodeAt(i);
        if (c === 47 || c === 92) return s.slice(i + 1);
    }
    return s;
}

// ASCII、基础平假名与 CJK 统一汉字在 NFKC 下恒等，跳过常规曲名的 ICU 规范化开销
function needsNfkc(s) {
    for (let i = 0, n = s.length; i < n; i += 1) {
        const c = s.charCodeAt(i);
        if (c <= 0x7f || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3041 && c <= 0x3096)) continue;
        return true;
    }
    return false;
}

function stripAudioExtLower(s) {
    const len = s.length;
    const lo = len > 5 ? len - 5 : 0;
    for (let i = len - 1; i >= lo; i -= 1) {
        if (s.charCodeAt(i) === 46) {
            return i < len - 1 && AUDIO_EXTS.has(s.slice(i + 1)) ? s.slice(0, i) : s;
        }
    }
    return s;
}

function needsSpaceNorm(s) {
    const len = s.length;
    if (!len) return false;
    if (s.charCodeAt(0) <= 32 || s.charCodeAt(len - 1) <= 32) return true;
    let prevSpace = false;
    for (let i = 0; i < len; i += 1) {
        const c = s.charCodeAt(i);
        if (c === 95) return true; // '_'
        if (c === 32) {
            if (prevSpace) return true;
            prevSpace = true;
        } else if (c <= 32 || c === 0xa0 || c === 0x3000) {
            return true;
        } else {
            prevSpace = false;
        }
    }
    return false;
}

function norm(value) {
    const raw = value == null ? '' : (typeof value === 'string' ? value : String(value));
    if (!raw) return '';
    const lower = (needsNfkc(raw) ? raw.normalize('NFKC') : raw).toLowerCase();
    const noExt = stripAudioExtLower(lower);
    return needsSpaceNorm(noExt) ? noExt.replace(SPACE_UNDER_RE, ' ').trim() : noExt;
}

// 去掉空格和常见标点后再比一次：「星の余韻」和「星の 余韻」、全角半角括号都算一样。
const NOISE_TEST_RE = /[\s\-–—·・.,，。、!！?？'"“”‘’()（）[\]【】「」『』]/;
const NOISE_RE = /[\s\-–—·・.,，。、!！?？'"“”‘’()（）[\]【】「」『』]/g;
function stripNoise(normalized) {
    return NOISE_TEST_RE.test(normalized) ? normalized.replace(NOISE_RE, '') : normalized;
}

const fieldNormCache = new Map();
function normField(raw) {
    if (!raw) return '';
    let hit = fieldNormCache.get(raw);
    if (hit === undefined) {
        hit = norm(raw);
        if (fieldNormCache.size >= 4096) fieldNormCache.clear();
        fieldNormCache.set(raw, hit);
    }
    return hit;
}

const trackNormCache = new WeakMap();
function getTrackNorm(track) {
    const rawTitle = track.title || '';
    const rawPath = track.path || '';
    const rawArtist = track.artist || '';
    const rawAlbum = track.album || '';
    const hit = trackNormCache.get(track);
    if (hit && hit.rawTitle === rawTitle && hit.rawPath === rawPath && hit.rawArtist === rawArtist && hit.rawAlbum === rawAlbum) {
        return hit;
    }
    const title = norm(rawTitle || (rawPath ? baseNameOf(rawPath) : ''));
    const entry = {
        rawTitle, rawPath, rawArtist, rawAlbum,
        title,
        titleS: title ? stripNoise(title) : '',
        artist: null,
        album: null
    };
    trackNormCache.set(track, entry);
    return entry;
}

// 「歌名 - 歌手」「歌名 by 歌手」「歌手 的 歌名」这类写法拆成两半。
function splitQuery(q) {
    const raw = q.split(SPLIT_QUERY_RE);
    let a = '';
    let b = '';
    let count = 0;
    for (let i = 0; i < raw.length; i += 1) {
        const s = raw[i].trim();
        if (!s) continue;
        count += 1;
        if (count === 1) a = s;
        else if (count === 2) b = s;
        else return null;
    }
    return count === 2 ? [a, b] : null;
}

const fieldMatches = (field, part) => Boolean(field && (field === part || field.includes(part)));

function scoreTrack(track, q, qs, pair, minScore = 0) {
    const entry = getTrackNorm(track);
    const { title, titleS } = entry;
    if (title && (title === q || (qs && titleS === qs))) return 100;
    let aName = null;
    if (pair && minScore < 95) {
        aName = entry.artist === null ? (entry.artist = normField(entry.rawArtist)) : entry.artist;
        if (title || aName) {
            const [a, b] = pair;
            if ((fieldMatches(title, a) && fieldMatches(aName, b)) || (fieldMatches(title, b) && fieldMatches(aName, a))) {
                return (title === a || title === b) ? 95 : 90;
            }
        }
    }
    if (minScore < 80 && title && title.startsWith(q)) return 80;
    if (minScore < 60 && title && (title.includes(q) || (qs && titleS.includes(qs)))) return 60;
    if (minScore < 40) {
        if (aName === null) aName = entry.artist === null ? (entry.artist = normField(entry.rawArtist)) : entry.artist;
        if (aName && aName === q) return 40;
        if (minScore < 30 && aName && aName.includes(q)) return 30;
    }
    if (minScore < 20) {
        const album = entry.album === null ? (entry.album = normField(entry.rawAlbum)) : entry.album;
        if (album && album.includes(q)) return 20;
    }
    return 0;
}

function findTrack(playlist, target) {
    if (!Array.isArray(playlist) || typeof target !== 'string') return null;
    const q = norm(target);
    if (!q) return null;
    const qs = stripNoise(q);
    const pair = splitQuery(q);
    let best = null;
    let bestScore = 0;
    for (let i = 0, len = playlist.length; i < len; i += 1) {
        const track = playlist[i];
        if (!track || typeof track !== 'object') continue;
        const score = scoreTrack(track, q, qs, pair, bestScore);
        if (score > bestScore) { best = track; bestScore = score; }
        if (score === 100) break;
    }
    return best;
}

module.exports = { findTrack };
