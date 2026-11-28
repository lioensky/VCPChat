// Musicmodules/music-track-order.js
// 专辑里的歌按「第几碟、第几首」排，不按标题字母排（以前「目录」的专辑分组按标题排，一张专辑的曲序全乱）。
// 曲号优先用标签里的（扫描时记下的 discNo / trackNo）；旧曲库没有这两个字段，就从文件名和所在文件夹猜：
//   「01 - 标题.flac」「01. 标题」「1-03 标题」「Disc 2\05 标题」「CD1\...」；都猜不出的排在后面，按原来的顺序。
//
// 对外：MusicTrackOrder = { numberOf(track), albumCompare(tracks, fallback) }。

(function (global) {
    'use strict';

    const PCT_HEX_RE = /%[0-9a-f]{2}/i;
    const decodeBase = (b) => {
        if (!b || b.indexOf('%') === -1) return b;
        try { return PCT_HEX_RE.test(b) ? decodeURIComponent(b) : b; } catch (e) { return b; } // 云端地址是 %20 这种
    };
    const positive = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 1000 ? n : 0; };

    const EXT_TRIM_RE = /\.[a-z0-9]{1,5}$/i;
    const DISC_TRACK_RE = /^\s*(\d{1,2})[-.](\d{1,3})(?=[\s._-]|$)/;
    const FOUR_DIGIT_RE = /^\d{4}/;
    const LEADING_NO_RE = /^\s*(\d{1,3})(?=\s*[\s._)\-]|$)/;
    const TRACK_PREFIX_RE = /^\s*(?:track|トラック|曲目)\s*[_-]?\s*0*(\d{1,3})(?!\d)/i;
    const PARENT_DISC_RE = /(?:^|[\s_\-(\[])(?:cd|disc|disk|碟)\s*0*(\d{1,2})(?:\D|$)/i;
    const EMPTY_ORDER = Object.freeze({ disc: 0, no: 0 });
    const parentDiscCache = new Map();
    // 快速扫描 [start, end) 是否含 cd / di(disc|disk) / 碟：绝大部分专辑目录不含这些关键字，跳过 slice + Map + 正则。
    const mayHaveParentDisc = (s, start, end) => {
        for (let i = start; i < end; i += 1) {
            const c = s.charCodeAt(i);
            if (c === 0x789f) return true; // '碟'
            if (c === 67 || c === 99) { // C / c -> cd
                if (i + 1 < end) {
                    const n = s.charCodeAt(i + 1);
                    if (n === 68 || n === 100) return true;
                }
            } else if (c === 68 || c === 100) { // D / d -> di (disc / disk)
                if (i + 1 < end) {
                    const n = s.charCodeAt(i + 1);
                    if (n === 73 || n === 105) return true;
                }
            }
        }
        return false;
    };
    const discFromParent = (parent) => {
        if (!parent) return 0;
        let hit = parentDiscCache.get(parent);
        if (hit !== undefined) return hit;
        const m = PARENT_DISC_RE.exec(parent);
        hit = m ? positive(m[1]) : 0;
        if (parentDiscCache.size >= 4096) parentDiscCache.clear();
        parentDiscCache.set(parent, hit);
        return hit;
    };
    const mayHaveTrackPrefix = (s, start) => {
        if (start >= s.length) return false;
        const c0 = s.charCodeAt(start);
        // 数字、空白、%（URL 编码）、T/t（Track）、ト（トラック）、曲（曲目）才可能命中曲号正则
        if ((c0 >= 48 && c0 <= 57) || c0 <= 32 || c0 === 37 || c0 === 0x30c8 || c0 === 0x66f2) return true;
        if (c0 === 84 || c0 === 116) {
            const c1 = s.charCodeAt(start + 1);
            return c1 === 82 || c1 === 114; // Tr / tr
        }
        return false;
    };

    const parsedCache = new WeakMap();
    // → { disc, no }，不知道的是 0
    const numberOf = (track) => {
        if (track && typeof track === 'object') {
            const hit = parsedCache.get(track);
            if (hit && hit.p === track.path && hit.d === track.discNo && hit.n === track.trackNo) return hit.v;
        }
        const t = track || {};
        let disc = positive(t.discNo);
        let no = positive(t.trackNo);
        const s = (!no || !disc) && t.path ? String(t.path) : '';
        if (s) {
            const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
            const baseStart = cut + 1;
            if (!no && mayHaveTrackPrefix(s, baseStart)) {
                const b = decodeBase(baseStart > 0 ? s.slice(baseStart) : s);
                const name = b.replace(EXT_TRIM_RE, '');
                // 1-03 标题 / 1.03 标题（碟号-曲号）；年份样的四位数（2019 xxx）不算曲号
                let m = DISC_TRACK_RE.exec(name);
                if (m && !FOUR_DIGIT_RE.test(name)) { disc = disc || positive(m[1]); no = positive(m[2]); }
                else if ((m = LEADING_NO_RE.exec(name)) && !FOUR_DIGIT_RE.test(name)) no = positive(m[1]);
                else if ((m = TRACK_PREFIX_RE.exec(name))) no = positive(m[1]); // 抓轨软件默认的「Track01」「Track 1」
            }
            if (!disc && cut > 0) {
                const prev = Math.max(s.lastIndexOf('/', cut - 1), s.lastIndexOf('\\', cut - 1));
                const pStart = prev + 1;
                if (cut > pStart && mayHaveParentDisc(s, pStart, cut)) disc = discFromParent(s.slice(pStart, cut));
            }
        }
        const v = (disc || no) ? { disc, no } : EMPTY_ORDER;
        if (track && typeof track === 'object') parsedCache.set(track, { p: track.path, d: track.discNo, n: track.trackNo, v });
        return v;
    };

    // 将 { disc, no } 打包进正整数键（位 29 标记无曲号，使有曲号恒排在前、同组再按碟号与曲号比较；0 保留作未计算哨兵）。
    const UNNUMBERED_BIT = 0x20000000;
    const packOrder = (v) => (v.no > 0
        ? (((v.disc || 1) << 10) | v.no)
        : (UNNUMBERED_BIT | ((v.disc || 1) << 10)));

    // 给一组曲库下标排序用：有曲号的在前按碟、曲号；同号或都没有的按 fallback（一般是标题）
    const albumCompare = (tracks, fallback) => {
        const list = Array.isArray(tracks) ? tracks : null;
        const len = list ? list.length : 0;
        const keys = len > 0 ? new Int32Array(len) : null;
        const keyOf = (i) => {
            if (keys && i >= 0 && i < len) {
                let k = keys[i];
                if (k === 0) keys[i] = k = packOrder(numberOf(list[i]));
                return k;
            }
            return packOrder(numberOf(tracks && tracks[i]));
        };
        const rest = typeof fallback === 'function' ? fallback : (a, b) => a - b;
        return (a, b) => (keyOf(a) - keyOf(b)) || rest(a, b);
    };

    // 快速检查一组曲目里是否存在任何碟号或曲号：无编号专辑可跳过比较器构造与排序。
    const hasAlbumOrder = (tracks) => {
        if (!Array.isArray(tracks) || tracks.length <= 1) return false;
        for (let i = 0; i < tracks.length; i += 1) {
            const v = numberOf(tracks[i]);
            if (v.no > 0 || v.disc > 0) return true;
        }
        return false;
    };

    const exported = { numberOf, albumCompare, hasAlbumOrder };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicTrackOrder = exported;
})(typeof window !== 'undefined' ? window : globalThis);
