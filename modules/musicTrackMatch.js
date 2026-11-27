// modules/musicTrackMatch.js
//
// AI 点歌（MusicController playSong）按名字找曲目。原来取曲库里第一首「标题或歌手包含这段文字」的歌，
// 「Lemon」会先撞上排在前面的「Lemon Tree」，「歌名 - 歌手」这种写法一首也找不到。
// 现在给每首打分，取最高分；同分取曲库里靠前的。没有 electron 依赖，测试直接用。

const AUDIO_EXT = /\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff|wv)$/i;
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const SPACE_UNDER_RE = /[\s_]+/g;
const PATH_SEP_RE = /[\\/]/;
const SPLIT_QUERY_RE = /\s+[-–—]\s+|\s+by\s+|\s*\/\s*|\s*的\s*/i;

function norm(value) {
    const raw = String(value ?? '');
    if (!raw) return '';
    return (ASCII_ONLY.test(raw) ? raw : raw.normalize('NFKC'))
        .toLowerCase()
        .replace(AUDIO_EXT, '')
        .replace(SPACE_UNDER_RE, ' ')
        .trim();
}

// 去掉空格和常见标点后再比一次：「星の余韻」和「星の 余韻」、全角半角括号都算一样。
const NOISE_RE = /[\s\-–—·・.,，。、!！?？'"“”‘’()（）[\]【】「」『』]/g;
function stripNoise(normalized) {
    return normalized.replace(NOISE_RE, '');
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
    const title = norm(rawTitle || (rawPath ? String(rawPath).split(PATH_SEP_RE).pop() : ''));
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
    const parts = q.split(SPLIT_QUERY_RE).map((s) => s.trim()).filter(Boolean);
    return parts.length === 2 ? parts : null;
}

const fieldMatches = (field, part) => Boolean(field && (field === part || field.includes(part)));

function scoreTrack(track, q, qs, pair, minScore = 0) {
    const entry = getTrackNorm(track);
    const { title, titleS } = entry;
    if (title && (title === q || (qs && titleS === qs))) return 100;
    let aName = null;
    if (pair && minScore < 95) {
        aName = entry.artist === null ? (entry.artist = norm(entry.rawArtist)) : entry.artist;
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
        if (aName === null) aName = entry.artist === null ? (entry.artist = norm(entry.rawArtist)) : entry.artist;
        if (aName && aName === q) return 40;
        if (minScore < 30 && aName && aName.includes(q)) return 30;
    }
    if (minScore < 20) {
        const album = entry.album === null ? (entry.album = norm(entry.rawAlbum)) : entry.album;
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
    for (const track of playlist) {
        if (!track || typeof track !== 'object') continue;
        const score = scoreTrack(track, q, qs, pair, bestScore);
        if (score > bestScore) { best = track; bestScore = score; }
        if (score === 100) break;
    }
    return best;
}

module.exports = { findTrack };
