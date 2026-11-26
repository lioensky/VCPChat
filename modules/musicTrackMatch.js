// modules/musicTrackMatch.js
//
// AI 点歌（MusicController playSong）按名字找曲目。原来取曲库里第一首「标题或歌手包含这段文字」的歌，
// 「Lemon」会先撞上排在前面的「Lemon Tree」，「歌名 - 歌手」这种写法一首也找不到。
// 现在给每首打分，取最高分；同分取曲库里靠前的。没有 electron 依赖，测试直接用。

const AUDIO_EXT = /\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff|wv)$/i;

function norm(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(AUDIO_EXT, '')
        .replace(/[\s_]+/g, ' ')
        .trim();
}

// 去掉空格和常见标点后再比一次：「星の余韻」和「星の 余韻」、全角半角括号都算一样。
function squash(value) {
    return norm(value).replace(/[\s\-–—·・.,，。、!！?？'"“”‘’()（）[\]【】「」『』]/g, '');
}

// 「歌名 - 歌手」「歌名 by 歌手」「歌手 的 歌名」这类写法拆成两半。
function splitQuery(q) {
    const parts = q.split(/\s+-\s+|\s+—\s+|\s+by\s+|\s*\/\s*|\s*的\s*/i).map((s) => s.trim()).filter(Boolean);
    return parts.length === 2 ? parts : null;
}

function scoreTrack(track, q, qs, pair) {
    const title = norm(track.title || (track.path ? String(track.path).split(/[\\/]/).pop() : ''));
    const artist = norm(track.artist);
    const album = norm(track.album);
    const titleS = squash(title);
    if (!title && !artist) return 0;
    if (title === q || (qs && titleS === qs)) return 100;
    if (pair) {
        const [a, b] = pair;
        const has = (field, part) => field && (field === part || field.includes(part));
        if ((has(title, a) && has(artist, b)) || (has(title, b) && has(artist, a))) {
            return (title === a || title === b) ? 95 : 90;
        }
    }
    if (title.startsWith(q)) return 80;
    if (title.includes(q) || (qs && titleS.includes(qs))) return 60;
    if (artist && artist === q) return 40;
    if (artist && artist.includes(q)) return 30;
    if (album && album.includes(q)) return 20;
    return 0;
}

function findTrack(playlist, target) {
    if (!Array.isArray(playlist) || typeof target !== 'string') return null;
    const q = norm(target);
    if (!q) return null;
    const qs = squash(q);
    const pair = splitQuery(q);
    let best = null;
    let bestScore = 0;
    for (const track of playlist) {
        if (!track || typeof track !== 'object') continue;
        const score = scoreTrack(track, q, qs, pair);
        if (score > bestScore) { best = track; bestScore = score; }
        if (score === 100) break;
    }
    return best;
}

module.exports = { findTrack };
