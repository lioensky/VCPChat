// 给 AI 的「播放列表」段落：只在曲库文件变了时重读，去掉重复和音频扩展名，过长时截断并说明。
// 点歌按歌名在整个曲库里匹配（musicTrackMatch），不在列表里的歌照样能点。
'use strict';

const fs = require('fs-extra');

const AUDIO_EXT = /\.(mp3|flac|wav|m4a|ogg|aac|wma|ape|dsf|dff|alac|aiff|opus|wv)$/i;
const DEFAULT_LIMIT = 1500;
let cache = null; // { file, mtimeMs, size, limit, text }

function formatPlaylistPrompt(tracks, limit = DEFAULT_LIMIT) {
    if (!Array.isArray(tracks)) return '';
    const seen = new Set();
    const titles = [];
    for (const track of tracks) {
        const title = String(track?.title || '').replace(AUDIO_EXT, '').replace(/\s+/g, ' ').trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        titles.push(title);
    }
    if (!titles.length) return '';
    const shown = titles.slice(0, limit);
    const more = titles.length > shown.length
        ? `\n（曲库共 ${titles.length} 首，这里只列出前 ${shown.length} 首；不在列表里的歌也可以直接按歌名点）`
        : '';
    return `[播放列表——\n${shown.join('\n')}${more}\n]`;
}

async function playlistPrompt(file, { limit = DEFAULT_LIMIT } = {}) {
    let stat;
    try { stat = await fs.stat(file); } catch (_) { return ''; }
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.limit === limit) {
        return cache.text;
    }
    let tracks = [];
    try { tracks = await fs.readJson(file); } catch (_) { return cache?.file === file ? cache.text : ''; }
    const text = formatPlaylistPrompt(tracks, limit);
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, limit, text };
    return text;
}

module.exports = { playlistPrompt, formatPlaylistPrompt, DEFAULT_LIMIT };
