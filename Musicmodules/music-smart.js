// Musicmodules/music-smart.js
// 智能歌单（iTunes、foobar2000、Feishin 都有）：歌单不是手动挑的，而是一条条件，曲库和听歌记录变了它自己跟着变。
//
// 条件直接写在目录检索框里，和普通检索词混着用，例如：
//   「喜欢 周杰伦」「没听过 >5分钟」「常听 很久没听」「次数>10」「Aki <3分钟」
// 支持的条件词：喜欢 / 没听过 / 常听（≥5 次）/ 很久没听（30 天以上没听、以前听过）/
//              次数>N、次数<N / >N分钟、<N分钟。其余的词按歌名、歌手、专辑匹配。
// 检索有条件词时，目录里的结果就是按条件筛过的；检索结果旁边的「存为智能歌单」会把这条检索存下来。
// 智能歌单仍是普通歌单（{ id, name, tracks, smart: { query } }），旧版播放器也能放，只是不会自动更新。
//
// 对外：MusicSmart.parse(q) → { preds: [{ word, test(track, ctx) }], text }
//       MusicSmart.evaluate(tracks, q, ctx) → 匹配的曲目
//       app.createSmartPlaylist(query, name?)、app.refreshSmartPlaylists()

(function (global) {
    'use strict';

    const DAY = 86400000;
    const norm = (s) => String(s || '').toLowerCase().normalize('NFKC');
    const statOf = (ctx, t) => (ctx && ctx.stats ? ctx.stats.get(t) : null);
    const lengthOf = (t) => Number(t && t.duration) || 0;

    const api = { parse, evaluate: null, hasRules: null, setupMusicSmart: null, ctx: null };

    const RULES = [
        [/^(喜欢|liked)$/i, (m) => ({ word: '喜欢', test: (t, ctx) => Boolean(ctx && ctx.isLiked && ctx.isLiked(t)) })],
        [/^(没听过|未听过|unplayed)$/i, () => ({ word: '没听过', test: (t, ctx) => !statOf(ctx, t) || !(statOf(ctx, t).plays > 0) })],
        [/^(常听|top)$/i, () => ({ word: '常听', test: (t, ctx) => (statOf(ctx, t)?.plays || 0) >= 5 })],
        [/^(很久没听|forgotten)$/i, () => ({ word: '很久没听', test: (t, ctx) => { const s = statOf(ctx, t); return Boolean(s && s.plays > 0 && s.last && (ctx.now || Date.now()) - s.last > 30 * DAY); } })],
        [/^(?:次数|plays)([<>]=?)(\d+)$/i, (m) => { const n = Number(m[2]); const op = m[1]; return { word: '次数' + op + n, test: (t, ctx) => cmp(statOf(ctx, t)?.plays || 0, op, n) }; }],
        [/^([<>]=?)(\d+(?:\.\d+)?)(?:分钟|分|min|m)$/i, (m) => { const n = Number(m[2]) * 60; const op = m[1]; return { word: m[1] + m[2] + '分钟', test: (t) => lengthOf(t) > 0 && cmp(lengthOf(t), op, n) }; }]
    ];
    function cmp(a, op, b) { return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b; }

    function parse(q) {
        const preds = [];
        const rest = [];
        for (const raw of String(q || '').trim().split(/\s+/).filter(Boolean)) {
            const token = raw.replace(/＞/g, '>').replace(/＜/g, '<');
            const rule = RULES.find(([re]) => re.test(token));
            if (rule) preds.push(rule[1](token.match(rule[0])));
            else rest.push(raw);
        }
        return { preds, text: rest.join(' ') };
    }
    const hasRules = (q) => parse(q).preds.length > 0;

    // 不经过检索索引的简单匹配（智能歌单自己刷新时用）：每个词都要出现在歌名、歌手或专辑里
    function evaluate(tracks, q, ctx = {}) {
        const { preds, text } = parse(q);
        const terms = norm(text).split(/\s+/).filter(Boolean);
        return (tracks || []).filter((t) => {
            if (!t || !t.path) return false;
            if (!preds.every((p) => p.test(t, ctx))) return false;
            if (!terms.length) return true;
            const hay = norm([t.title, t.artist, t.album].join(' '));
            return terms.every((w) => hay.includes(w));
        });
    }

    function setupMusicSmart(app) {
        if (!app || app.createSmartPlaylist) return;
        const ctx = () => ({ stats: app.musicStats || null, isLiked: app.isLiked, now: Date.now() });
        api.ctx = ctx; // 检索索引用它判断条件词
        const lists = () => (Array.isArray(app.customPlaylists) ? app.customPlaylists : (app.customPlaylists = []));
        const refreshViews = () => {
            try { app.saveCustomPlaylists?.(); } catch (e) { /* 存不了也先在界面上生效 */ }
            try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
            if (app.currentSidebarView === 'playlists') { try { app.renderSidebarContent?.('playlists'); } catch (e) { /* 旧侧栏 */ } }
        };
        // 把每个智能歌单按条件重新算一遍；有变化才存盘、重画
        app.refreshSmartPlaylists = () => {
            let changed = false;
            for (const pl of lists()) {
                if (!pl || !pl.smart || typeof pl.smart.query !== 'string') continue;
                const paths = evaluate(app.playlist, pl.smart.query, ctx()).map((t) => t.path);
                if (paths.length !== (pl.tracks || []).length || paths.some((p, k) => p !== pl.tracks[k])) { pl.tracks = paths; changed = true; }
            }
            if (changed) refreshViews();
            return changed;
        };
        app.createSmartPlaylist = (query, name) => {
            const q = String(query || '').trim();
            if (!q) return null;
            const pl = { id: 's' + Date.now(), name: String(name || '').trim() || '智能：' + q, tracks: evaluate(app.playlist, q, ctx()).map((t) => t.path), smart: { query: q } };
            lists().push(pl);
            refreshViews();
            try {
                global.MusicToast?.show?.({
                    message: `已存为智能歌单「${pl.name}」：现在 ${pl.tracks.length} 首，以后会自己更新`,
                    duration: 6000,
                    action: { label: '撤销', run: () => { const at = lists().indexOf(pl); if (at !== -1) { lists().splice(at, 1); refreshViews(); } } }
                });
            } catch (e) { /* 没有提示层 */ }
            return pl;
        };
        // 听歌记录、喜欢变了就重算（攒一下，播放中途不频繁写盘）
        let timer = null;
        const later = () => { if (timer) return; timer = global.setTimeout(() => { timer = null; app.refreshSmartPlaylists(); }, 4000); };
        global.document?.addEventListener?.('music-stats-change', later);
        global.document?.addEventListener?.('music-like-change', later);
        later();
    }

    Object.assign(api, { parse, evaluate, hasRules, setupMusicSmart });
    global.MusicSmart = api;
    global.setupMusicSmart = setupMusicSmart;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
