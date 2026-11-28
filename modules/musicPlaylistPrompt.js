// 给 AI 的「播放列表」段落：只在曲库文件变了时重读，去掉重复和音频扩展名，过长时截断并说明。
// 点歌按歌名在整个曲库里匹配（musicTrackMatch），不在列表里的歌照样能点。
'use strict';

const fs = require('fs-extra');

const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'wma', 'ape', 'dsf', 'dff', 'alac', 'aif', 'aiff', 'opus', 'wv']);
const WS_RE = /\s+/g;
const DEFAULT_LIMIT = 1500;
let cache = null; // { file, mtimeMs, size, limit, text }

function stripAudioExt(s) {
    const len = s.length;
    const lo = len > 5 ? len - 5 : 0;
    for (let i = len - 1; i >= lo; i -= 1) {
        if (s.charCodeAt(i) === 46) {
            return i < len - 1 && AUDIO_EXTS.has(s.slice(i + 1).toLowerCase()) ? s.slice(0, i) : s;
        }
    }
    return s;
}

function normalizeTitleWs(s) {
    const len = s.length;
    if (!len) return '';
    let needs = s.charCodeAt(0) <= 32 || s.charCodeAt(len - 1) <= 32;
    if (!needs) {
        let prevSpace = false;
        for (let i = 0; i < len; i += 1) {
            const c = s.charCodeAt(i);
            if (c === 32) {
                if (prevSpace) { needs = true; break; }
                prevSpace = true;
            } else if (c <= 32 || c === 0xa0 || c === 0x3000) {
                needs = true; break;
            } else {
                prevSpace = false;
            }
        }
    }
    return needs ? s.replace(WS_RE, ' ').trim() : s;
}

function formatPlaylistPrompt(tracks, limit = DEFAULT_LIMIT) {
    if (!Array.isArray(tracks)) return '';
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const seen = new Set();
    const shown = [];
    for (let i = 0, len = tracks.length; i < len; i += 1) {
        const raw = tracks[i]?.title;
        if (!raw) continue;
        const s = typeof raw === 'string' ? raw : String(raw);
        const title = normalizeTitleWs(stripAudioExt(s));
        if (!title || seen.has(title)) continue;
        seen.add(title);
        if (shown.length < cap) shown.push(title);
    }
    if (!shown.length) return '';
    const total = seen.size;
    const more = total > shown.length
        ? `\n（曲库共 ${total} 首，这里只列出前 ${shown.length} 首；不在列表里的歌也可以直接按歌名点）`
        : '';
    return `[播放列表——\n${shown.join('\n')}${more}\n]`;
}

async function playlistPrompt(file, { limit = DEFAULT_LIMIT } = {}) {
    let stat;
    try { stat = await fs.stat(file); } catch (_) {
        if (cache && cache.file === file) cache = null;
        return '';
    }
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.limit === cap) {
        return cache.text;
    }
    let tracks = [];
    try { tracks = await fs.readJson(file); } catch (_) { return cache?.file === file ? cache.text : ''; }
    const text = formatPlaylistPrompt(tracks, cap);
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, limit: cap, text };
    return text;
}

module.exports = { playlistPrompt, formatPlaylistPrompt, DEFAULT_LIMIT };
