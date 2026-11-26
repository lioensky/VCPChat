// modules/ipc/musicM3u.js
// 歌单和别的播放器互通：读写 .m3u / .m3u8。
// 读：#EXTINF 的时长和「歌手 - 标题」留着做提示；相对路径按列表文件所在目录解析；file:// 地址转成本机路径；
// 网络地址跳过（曲库只收本机文件）。.m3u 常见 GBK 编码（老的 Windows 播放器导出的），不是合法 UTF-8 时按 GBK 读。
// 写：总是 UTF-8 的 .m3u8，带 #EXTM3U / #PLAYLIST / #EXTINF，路径写绝对路径（拷到别的目录也能用）。

const path = require('path');

const looksUtf8 = (buf) => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (e) { return false; }
};

function decodeM3u(buf, fileName = '') {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
    if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
    if (buf[0] === 0xFE && buf[1] === 0xFF) { const le = Buffer.from(buf.slice(2, buf.length - (buf.length % 2))); return le.swap16().toString('utf16le'); }
    if (/\.m3u8$/i.test(fileName) || looksUtf8(buf)) return buf.toString('utf8');
    try { return require('iconv-lite').decode(buf, 'gbk'); } catch (e) { return buf.toString('latin1'); }
}

// file:///C:/a%20b.flac → C:\a b.flac；file://server/share/x → \\server\share\x（UNC）
function fileUrlToPath(url, platform) {
    const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(url);
    if (!m) return '';
    let rest;
    try { rest = decodeURIComponent(m[2] || ''); } catch (e) { return ''; }
    const host = m[1] && m[1].toLowerCase() !== 'localhost' ? m[1] : '';
    if (platform !== 'win32') return host ? '' : rest;
    if (host) return '\\\\' + host + rest.replace(/\//g, '\\');
    return rest.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\');
}

// 解析成 { name, entries: [{ path, title, duration }], skipped }；skipped 是网络地址之类没法收进曲库的行数。
function parseM3u(text, { baseDir = '', platform = process.platform } = {}) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const entries = [];
    let name = '';
    let skipped = 0;
    let pending = null;
    for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            const info = /^#EXTINF:\s*(-?[\d.]+)?[^,]*,(.*)$/i.exec(line);
            if (info) {
                const d = Number(info[1]);
                pending = { duration: Number.isFinite(d) && d > 0 ? d : 0, title: info[2].trim() };
            } else if (/^#PLAYLIST:/i.test(line)) {
                name = line.slice(10).trim();
            }
            continue;
        }
        let file = line;
        if (/^file:\/\//i.test(file)) {
            const local = fileUrlToPath(file, platform);
            if (!local) { skipped++; pending = null; continue; }
            file = local;
        } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(file)) {
            skipped++; pending = null; continue;
        }
        if (platform === 'win32') file = file.replace(/\//g, '\\');
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

const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

// tracks: [{ path, title, artist, duration }]（duration 秒，可缺）
function buildM3u(name, tracks) {
    const out = ['#EXTM3U'];
    if (oneLine(name)) out.push('#PLAYLIST:' + oneLine(name));
    for (const t of tracks || []) {
        if (!t || typeof t.path !== 'string' || !t.path) continue;
        const label = [oneLine(t.artist), oneLine(t.title)].filter(Boolean).join(' - ');
        const d = Math.round(Number(t.duration) || 0);
        if (label || d > 0) out.push(`#EXTINF:${d > 0 ? d : -1},${label}`);
        out.push(oneLine(t.path));
    }
    return out.join('\r\n') + '\r\n';
}

// 文件名里不能有的字符换掉，给保存对话框当默认名
const safeFileName = (name) => (oneLine(name).replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120) || '歌单');

module.exports = { decodeM3u, parseM3u, buildM3u, safeFileName };
