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
    // ASCII、常用汉字（U+4E00–U+9FFF）和基础平假名（U+3041–U+3096）均为 NFKC 不变量，跳过昂贵的 ICU normalize('NFKC')
    const NEEDS_NFKC_RE = /[^\x00-\x7f\u4e00-\u9fff\u3041-\u3096]/;
    const norm = (s) => {
        const str = String(s || '');
        return NEEDS_NFKC_RE.test(str) ? str.toLowerCase().normalize('NFKC') : str.toLowerCase();
    };
    const statOf = (ctx, t) => (ctx && ctx.stats ? ctx.stats.get(t) : null);
    const lengthOf = (t) => Number(t && t.duration) || 0;

    const api = { parse, evaluate: null, hasRules: null, setupMusicSmart: null, ctx: null };

    const PRED_LIKED = Object.freeze({ word: '喜欢', test: (t, ctx) => Boolean(ctx && ctx.isLiked && ctx.isLiked(t)) });
    const PRED_UNPLAYED = Object.freeze({ word: '没听过', test: (t, ctx) => !statOf(ctx, t) || !(statOf(ctx, t).plays > 0) });
    const PRED_TOP = Object.freeze({ word: '常听', test: (t, ctx) => (statOf(ctx, t)?.plays || 0) >= 5 });
    const PRED_FORGOTTEN = Object.freeze({
        word: '很久没听',
        test: (t, ctx) => {
            const s = statOf(ctx, t);
            return Boolean(s && s.plays > 0 && s.last && (ctx.now || Date.now()) - s.last > 30 * DAY);
        }
    });
    const EXACT_RULES = new Map([
        ['喜欢', PRED_LIKED], ['liked', PRED_LIKED],
        ['没听过', PRED_UNPLAYED], ['未听过', PRED_UNPLAYED], ['unplayed', PRED_UNPLAYED],
        ['常听', PRED_TOP], ['top', PRED_TOP],
        ['很久没听', PRED_FORGOTTEN], ['forgotten', PRED_FORGOTTEN]
    ]);
    const CMP_RULES = [
        [/^(?:次数|plays)([<>]=?)(\d+)$/i, (m) => { const n = Number(m[2]); const op = m[1]; return { word: '次数' + op + n, test: (t, ctx) => cmp(statOf(ctx, t)?.plays || 0, op, n) }; }],
        [/^([<>]=?)(\d+(?:\.\d+)?)(?:分钟|分|min|m)$/i, (m) => { const n = Number(m[2]) * 60; const op = m[1]; return { word: m[1] + m[2] + '分钟', test: (t) => lengthOf(t) > 0 && cmp(lengthOf(t), op, n) }; }]
    ];
    const hasCmpChar = (s) => s.includes('>') || s.includes('<') || s.includes('＞') || s.includes('＜');
    const WHITESPACE = /\s/;
    const WS_SPLIT_RE = /\s+/;
    const GT_FULL_RE = /＞/g;
    const LT_FULL_RE = /＜/g;
    function cmp(a, op, b) { return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b; }

    function matchCmpRule(raw) {
        if (!hasCmpChar(raw)) return null;
        const token = raw.includes('＞') || raw.includes('＜')
            ? raw.replace(GT_FULL_RE, '>').replace(LT_FULL_RE, '<')
            : raw;
        for (let i = 0; i < CMP_RULES.length; i++) {
            const m = CMP_RULES[i][0].exec(token);
            if (m) return CMP_RULES[i][1](m);
        }
        return null;
    }

    function parse(q) {
        const str = String(q || '').trim();
        if (!str) return { preds: [], text: '' };
        // 单一普通检索词占绝大多数输入：走 O(1) 哈希查表，免去分词数组与逐条正则回溯
        if (!WHITESPACE.test(str)) {
            const exact = EXACT_RULES.get(str.toLowerCase());
            if (exact) return { preds: [exact], text: '' };
            const cmpPred = matchCmpRule(str);
            return cmpPred ? { preds: [cmpPred], text: '' } : { preds: [], text: str };
        }
        const preds = [];
        const rest = [];
        const tokens = str.split(WS_SPLIT_RE);
        for (let t = 0; t < tokens.length; t++) {
            const raw = tokens[t];
            if (!raw) continue;
            const exact = EXACT_RULES.get(raw.toLowerCase());
            if (exact) {
                preds.push(exact);
                continue;
            }
            const cmpPred = matchCmpRule(raw);
            if (cmpPred) {
                preds.push(cmpPred);
                continue;
            }
            rest.push(raw);
        }
        return { preds, text: rest.join(' ') };
    }
    const hasRules = (q) => parse(q).preds.length > 0;

    // 不经过检索索引的简单匹配（智能歌单自己刷新时用）：每个词都要出现在歌名、歌手或专辑里
    function evaluate(tracks, q, ctx = {}) {
        const list = Array.isArray(tracks) ? tracks : [];
        if (!list.length) return [];
        const { preds, text } = parse(q);
        const terms = [];
        if (text) {
            const nt = norm(text);
            if (!WHITESPACE.test(nt)) {
                if (nt) terms.push(nt);
            } else {
                const rawTerms = nt.split(WS_SPLIT_RE);
                for (let i = 0; i < rawTerms.length; i += 1) {
                    if (rawTerms[i]) terms.push(rawTerms[i]);
                }
            }
        }
        const evalCtx = ctx && ctx.now ? ctx : { ...ctx, now: Date.now() };
        const predLen = preds.length;
        const termLen = terms.length;
        const out = [];
        for (let i = 0; i < list.length; i += 1) {
            const t = list[i];
            if (!t || !t.path) continue;
            let ok = true;
            for (let p = 0; p < predLen; p += 1) {
                if (!preds[p].test(t, evalCtx)) { ok = false; break; }
            }
            if (!ok) continue;
            if (termLen > 0) {
                const hay = norm(`${t.title || ''} ${t.artist || ''} ${t.album || ''}`);
                for (let w = 0; w < termLen; w += 1) {
                    if (!hay.includes(terms[w])) { ok = false; break; }
                }
                if (!ok) continue;
            }
            out.push(t);
        }
        return out;
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
            const listArr = lists();
            for (let li = 0; li < listArr.length; li += 1) {
                const pl = listArr[li];
                if (!pl || !pl.smart || typeof pl.smart.query !== 'string') continue;
                const matched = evaluate(app.playlist, pl.smart.query, ctx());
                const prev = pl.tracks || [];
                let diff = matched.length !== prev.length;
                if (!diff) {
                    for (let k = 0; k < matched.length; k += 1) {
                        if (matched[k].path !== prev[k]) { diff = true; break; }
                    }
                }
                if (diff) {
                    const paths = new Array(matched.length);
                    for (let k = 0; k < matched.length; k += 1) paths[k] = matched[k].path;
                    pl.tracks = paths;
                    changed = true;
                }
            }
            if (changed) refreshViews();
            return changed;
        };
        app.createSmartPlaylist = (query, name) => {
            const q = String(query || '').trim();
            if (!q) return null;
            const listArr = lists();
            const taken = new Set();
            for (let i = 0; i < listArr.length; i += 1) taken.add(String(listArr[i] && listArr[i].id || ''));
            let idNum = Date.now();
            while (taken.has('s' + idNum)) idNum += 1;
            const matched = evaluate(app.playlist, q, ctx());
            const tracks = new Array(matched.length);
            for (let i = 0; i < matched.length; i += 1) tracks[i] = matched[i].path;
            const pl = { id: 's' + idNum, name: String(name || '').trim() || '智能：' + q, tracks, smart: { query: q } };
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
        // 听歌记录、喜欢变了就重算（攒一下，播放中途不频繁写盘；没有智能歌单时不排空定时器）
        let timer = null;
        const hasSmart = () => {
            const listArr = lists();
            for (let i = 0; i < listArr.length; i += 1) {
                const pl = listArr[i];
                if (pl && pl.smart && typeof pl.smart.query === 'string') return true;
            }
            return false;
        };
        const later = () => { if (timer || !hasSmart()) return; timer = global.setTimeout(() => { timer = null; app.refreshSmartPlaylists(); }, 4000); };
        global.document?.addEventListener?.('music-stats-change', later);
        global.document?.addEventListener?.('music-like-change', later);
        global.addEventListener?.('beforeunload', () => {
            if (timer) { global.clearTimeout?.(timer); timer = null; }
            global.document?.removeEventListener?.('music-stats-change', later);
            global.document?.removeEventListener?.('music-like-change', later);
        }, { once: true });
        later();
    }

    Object.assign(api, { parse, evaluate, hasRules, setupMusicSmart });
    global.MusicSmart = api;
    global.setupMusicSmart = setupMusicSmart;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
