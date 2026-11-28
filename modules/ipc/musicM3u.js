// modules/ipc/musicM3u.js
// 歌单和别的播放器互通：读写 .m3u / .m3u8。
// 读：#EXTINF 的时长和「歌手 - 标题」留着做提示；相对路径按列表文件所在目录解析；file:// 地址转成本机路径；
// 网络地址跳过（曲库只收本机文件）。.m3u 常见 GBK 编码（老的 Windows 播放器导出的），不是合法 UTF-8 时按 GBK 读。
// 写：总是 UTF-8 的 .m3u8，带 #EXTM3U / #PLAYLIST / #EXTINF，路径写绝对路径（拷到别的目录也能用）。

const path = require('path');

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
let gb18030Decoder = null;
const getGb18030Decoder = () => {
    if (gb18030Decoder === null) {
        try { gb18030Decoder = new TextDecoder('gb18030'); } catch (_) { gb18030Decoder = false; }
    }
    return gb18030Decoder;
};
let iconvCache = undefined;
const getIconv = () => {
    if (iconvCache === undefined) {
        try { iconvCache = require('iconv-lite'); } catch (_) { iconvCache = null; }
    }
    return iconvCache;
};
const M3U8_EXT_RE = /\.m3u8$/i;
const FILE_URL_PARSE_RE = /^file:\/\/([^/]*)(\/.*)?$/i;
const LINE_SPLIT_RE = /\r\n|\r|\n/;
const EXTINF_RE = /^#EXTINF:\s*(-?[\d.]+)?[^,]*,(.*)$/i;
const PLAYLIST_RE = /^#PLAYLIST:/i;
const FILE_URL_RE = /^file:\/\//i;
const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]+:\/\//i;
const ONE_LINE_RE = /[\r\n]+/g;
const SLASH_RE = /\//g;
const WIN_DRIVE_RE = /^\/([a-zA-Z]:)/;
const SAFE_BAD_RE = /[\\/:*?"<>|\x00-\x1f]+/g;
const LEAD_DOTS_RE = /^\.+/;
const TRAIL_DOT_SPACE_RE = /[. ]+$/;

const looksUtf8 = (buf) => {
    try { UTF8_FATAL.decode(buf); return true; } catch (e) { return false; }
};

function decodeM3u(buf, fileName = '') {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
    if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
    if (buf[0] === 0xFE && buf[1] === 0xFF) { const le = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))); return le.swap16().toString('utf16le'); }
    if (M3U8_EXT_RE.test(fileName) || looksUtf8(buf)) return buf.toString('utf8');
    const gb = getGb18030Decoder();
    if (gb) {
        try { return gb.decode(buf); } catch (_) { /* fall through */ }
    }
    const iconv = getIconv();
    if (iconv) {
        try { return iconv.decode(buf, 'gbk'); } catch (_) { /* fall through */ }
    }
    return buf.toString('latin1');
}

// file:///C:/a%20b.flac → C:\a b.flac；file://server/share/x → \\server\share\x（UNC）
function fileUrlToPath(url, platform) {
    const m = FILE_URL_PARSE_RE.exec(url);
    if (!m) return '';
    let rest;
    try { rest = decodeURIComponent(m[2] || ''); } catch (e) { return ''; }
    const host = m[1] && m[1].toLowerCase() !== 'localhost' ? m[1] : '';
    if (platform !== 'win32') return host ? '' : rest;
    if (host) return '\\\\' + host + rest.replace(SLASH_RE, '\\');
    return rest.replace(WIN_DRIVE_RE, '$1').replace(SLASH_RE, '\\');
}

// 解析成 { name, entries: [{ path, title, duration }], skipped }；skipped 是网络地址之类没法收进曲库的行数。
function parseM3u(text, { baseDir = '', platform = process.platform } = {}) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const entries = [];
    let name = '';
    let skipped = 0;
    let pending = null;
    const lines = String(text || '').split(LINE_SPLIT_RE);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.charCodeAt(0) === 35) { // '#'
            const info = EXTINF_RE.exec(line);
            if (info) {
                const d = Number(info[1]);
                pending = { duration: Number.isFinite(d) && d > 0 ? d : 0, title: info[2].trim() };
            } else if (PLAYLIST_RE.test(line)) {
                name = line.slice(10).trim();
            }
            continue;
        }
        let file = line;
        if (FILE_URL_RE.test(file)) {
            const local = fileUrlToPath(file, platform);
            if (!local) { skipped++; pending = null; continue; }
            file = local;
        } else if (SCHEME_URL_RE.test(file)) {
            skipped++; pending = null; continue;
        }
        if (platform === 'win32') file = file.replace(SLASH_RE, '\\');
        if (!p.isAbsolute(file)) {
            if (!baseDir) { skipped++; pending = null; continue; }
            file = p.resolve(baseDir, file);
        } else {
            file = p.normalize(file);
        }
        entries.push({ path: file, title: pending?.title || '', duration: pending?.duration || 0 });
        pending = null;
    }
    return { name, entries, skipped };
}

const oneLine = (s) => String(s || '').replace(ONE_LINE_RE, ' ').trim();

// tracks: [{ path, title, artist, duration }]（duration 秒，可缺）
function buildM3u(name, tracks) {
    const out = ['#EXTM3U'];
    const playlistName = oneLine(name);
    if (playlistName) out.push('#PLAYLIST:' + playlistName);
    for (const t of tracks || []) {
        if (!t || typeof t.path !== 'string' || !t.path) continue;
        const artist = oneLine(t.artist);
        const title = oneLine(t.title);
        const label = artist && title ? `${artist} - ${title}` : (artist || title);
        const d = Math.round(Number(t.duration) || 0);
        if (label || d > 0) out.push(`#EXTINF:${d > 0 ? d : -1},${label}`);
        out.push(oneLine(t.path));
    }
    return out.join('\r\n') + '\r\n';
}

const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

// 文件名里不能有的字符换掉，给保存对话框当默认名
const safeFileName = (name) => {
    let clean = oneLine(name)
        .replace(SAFE_BAD_RE, '_')
        .replace(LEAD_DOTS_RE, '')
        .replace(TRAIL_DOT_SPACE_RE, '')
        .slice(0, 120)
        .replace(TRAIL_DOT_SPACE_RE, '');
    if (!clean) return '歌单';
    if (WIN_RESERVED_RE.test(clean)) clean = '_' + clean;
    return clean;
};

module.exports = { decodeM3u, parseM3u, buildM3u, safeFileName };
