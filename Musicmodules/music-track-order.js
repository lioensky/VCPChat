// Musicmodules/music-track-order.js
// 专辑里的歌按「第几碟、第几首」排，不按标题字母排（以前「目录」的专辑分组按标题排，一张专辑的曲序全乱）。
// 曲号优先用标签里的（扫描时记下的 discNo / trackNo）；旧曲库没有这两个字段，就从文件名和所在文件夹猜：
//   「01 - 标题.flac」「01. 标题」「1-03 标题」「Disc 2\05 标题」「CD1\...」；都猜不出的排在后面，按原来的顺序。
//
// 对外：MusicTrackOrder = { numberOf(track), albumCompare(tracks, fallback) }。

(function (global) {
    'use strict';

    const baseName = (p) => { const b = String(p || '').split(/[\\/]/).pop() || ''; try { return /%[0-9a-f]{2}/i.test(b) ? decodeURIComponent(b) : b; } catch (e) { return b; } }; // 云端地址是 %20 这种
    const parentName = (p) => { const parts = String(p || '').split(/[\\/]/); return parts.length > 1 ? parts[parts.length - 2] : ''; };
    const positive = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 1000 ? n : 0; };

    // → { disc, no }，不知道的是 0
    const numberOf = (track) => {
        const t = track || {};
        let disc = positive(t.discNo);
        let no = positive(t.trackNo);
        if (!no) {
            const name = baseName(t.path).replace(/\.[a-z0-9]{1,5}$/i, '');
            // 1-03 标题 / 1.03 标题（碟号-曲号）；年份样的四位数（2019 xxx）不算曲号
            let m = /^\s*(\d{1,2})[-.](\d{1,3})(?=[\s._-]|$)/.exec(name);
            if (m && !/^\d{4}/.test(name)) { disc = disc || positive(m[1]); no = positive(m[2]); }
            else if ((m = /^\s*(\d{1,3})(?=\s*[\s._)\-]|$)/.exec(name)) && !/^\d{4}/.test(name)) no = positive(m[1]);
            else if ((m = /^\s*(?:track|トラック|曲目)\s*[_-]?\s*0*(\d{1,3})(?!\d)/i.exec(name))) no = positive(m[1]); // 抓轨软件默认的「Track01」「Track 1」
        }
        if (!disc) {
            const m = /(?:^|[\s_\-(\[])(?:cd|disc|disk|碟)\s*0*(\d{1,2})(?:\D|$)/i.exec(parentName(t.path));
            if (m) disc = positive(m[1]);
        }
        return { disc, no };
    };

    // 给一组曲库下标排序用：有曲号的在前按碟、曲号；同号或都没有的按 fallback（一般是标题）
    const albumCompare = (tracks, fallback) => {
        const cache = new Map();
        const get = (i) => { let v = cache.get(i); if (!v) { v = numberOf(tracks && tracks[i]); cache.set(i, v); } return v; };
        const rest = typeof fallback === 'function' ? fallback : (a, b) => a - b;
        return (a, b) => {
            const x = get(a), y = get(b);
            if (!x.no !== !y.no) return x.no ? -1 : 1;
            return ((x.disc || 1) - (y.disc || 1)) || (x.no - y.no) || rest(a, b);
        };
    };

    const exported = { numberOf, albumCompare };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicTrackOrder = exported;
})(typeof window !== 'undefined' ? window : globalThis);
