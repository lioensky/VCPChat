/*
 * 曲库检索索引：标题、歌手、专辑的即时匹配，支持拼音全拼和首字母、平假名片假名互通；
 * 同时给出每首歌按首字母归入的分组（A–Z、あ行…、0–9、其他）和组内排序键。
 * 汉字转拼音由外部传入的 pinyin(char) 提供（音乐窗口里用已有依赖按需加载），
 * 没有时汉字只按原文匹配、分组归到「其他」。不碰 DOM，方便在 node 里测试。
 */
(function (global) {
    'use strict';

    const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    const norm = (s) => toHiragana(String(s || '').normalize('NFKC').toLowerCase()).trim();
    const stripExt = (t) => String(t || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '');
    const HAN = /[㐀-䶿一-鿿豈-﫿]/;
    const LATIN = /[a-z]/;
    const DIGIT = /[0-9]/;
    const LEADING_JUNK = /^[\s\p{P}\p{S}]+/u;

    const KANA_ROWS = [
        ['あ', 'ぁあぃいぅうぇえぉおゔ'], ['か', 'かがきぎくぐけげこごゕゖ'], ['さ', 'さざしじすずせぜそぞ'],
        ['た', 'ただちぢっつづてでとど'], ['な', 'なにぬねの'], ['は', 'はばぱひびぴふぶぷへべぺほぼぽ'],
        ['ま', 'まみむめも'], ['や', 'ゃやゅゆょよ'], ['ら', 'らりるれろ'], ['わ', 'ゎわゐゑをん']
    ];
    const KANA_ROW_OF = new Map();
    KANA_ROWS.forEach(([row, chars]) => { for (const c of chars) KANA_ROW_OF.set(c, row); });

    /* 分组顺序：A–Z、あ行…わ行、0–9、其他 */
    const GROUP_ORDER = [
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
        ...KANA_ROWS.map(([row]) => row),
        '0-9', '#'
    ];
    const GROUP_RANK = new Map(GROUP_ORDER.map((g, i) => [g, i]));
    const groupName = (g) => (KANA_ROW_OF.has(g) ? g + '行' : g === '0-9' ? '0–9' : g === '#' ? '其他' : g);
    const groupRef = (g) => (KANA_ROW_OF.has(g) ? 'INDEX ' + g : g === '#' ? 'INDEX OTHERS' : 'INDEX ' + g);

    /*
     * pinyin: (char) => 'zhan' | ''。返回 { py, ini }：
     * py  = 全拼串（汉字换成拼音，其他字母数字原样，去掉空白和符号），
     * ini = 首字母串（汉字取拼音首字母，拉丁词取词首，假名和数字原样）。
     */
    const romanize = (text, pinyin) => {
        const s = norm(text);
        let py = '';
        let ini = '';
        let wordStart = true;
        for (const c of s) {
            if (HAN.test(c)) {
                const p = pinyin ? String(pinyin(c) || '').normalize('NFD').toLowerCase().replace(/[^a-z]/g, '') : '';
                if (p) { py += p; ini += p[0]; } else { py += c; ini += c; }
                wordStart = true;
            } else if (LATIN.test(c) || DIGIT.test(c)) {
                py += c;
                if (wordStart) ini += c;
                wordStart = false;
            } else if (KANA_ROW_OF.has(c) || /[぀-ゟー]/.test(c)) {
                py += c; ini += c; wordStart = true;
            } else {
                if (!/\s|\p{P}|\p{S}/u.test(c)) { py += c; ini += c; }
                wordStart = true;
            }
        }
        return { py, ini };
    };

    const groupOf = (title, pinyin) => {
        const s = norm(stripExt(title)).replace(LEADING_JUNK, '');
        const c = [...s][0] || '';
        if (!c) return '#';
        if (LATIN.test(c)) return c.toUpperCase();
        if (DIGIT.test(c)) return '0-9';
        if (KANA_ROW_OF.has(c)) return KANA_ROW_OF.get(c);
        if (HAN.test(c) && pinyin) {
            const p = String(pinyin(c) || '').normalize('NFD').toLowerCase();
            if (/^[a-z]/.test(p)) return p[0].toUpperCase();
        }
        return '#';
    };

    // 组内排序：数字按数值比（Song 2 在 Song 10 前面）
    const COLLATE = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare
        : (a, b) => (a < b ? -1 : a > b ? 1 : 0);

    const FIELDS = [['title', 3], ['artist', 2], ['album', 1]];

    /* 一首歌的检索条目：三个字段的原文、全拼、首字母，加上分组和排序键 */
    const entryOf = (t, pinyin) => {
        const e = { group: groupOf(t && t.title, pinyin) };
        for (const [f] of FIELDS) {
            const raw = f === 'title' ? stripExt(t && t.title) : (t && t[f]) || '';
            const r = romanize(raw, pinyin);
            e[f] = norm(raw);
            e[f + 'Py'] = r.py;
            e[f + 'Ini'] = r.ini;
        }
        e.sort = e.titlePy || e.title;
        e.artistGroup = e.artist ? groupOf(t && t.artist, pinyin) : '#';
        e.artistSort = e.artistPy || e.artist;
        return e;
    };
    /*
     * 条目缓存（可选）：按路径记住算好的条目，标题、歌手、专辑和拼音表都没变就直接用。
     * 曲库整体变化（扫进来一批新歌）时只有新歌要算；很大的曲库第一次可以用 warm 分片先算好，不卡输入。
     */
    const cachedEntry = (t, pinyin, cache) => {
        const key = t && t.path;
        if (!cache || !key) return entryOf(t, pinyin);
        const hit = cache.get(key);
        if (hit && hit.pinyin === pinyin && hit.title === t.title && hit.artist === t.artist && hit.album === t.album) return hit.e;
        const e = entryOf(t, pinyin);
        cache.set(key, { pinyin, title: t.title, artist: t.artist, album: t.album, e });
        return e;
    };
    /* 从第 from 首开始算，最多用 budgetMs 毫秒；返回下一次从哪首接着算，算完返回 -1 */
    const warm = (tracks, { pinyin = null, cache, from = 0, budgetMs = 8, now = () => performance.now() } = {}) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const end = now() + budgetMs;
        let i = from;
        while (i < list.length) {
            for (const stop = Math.min(list.length, i + 40); i < stop; i++) cachedEntry(list[i], pinyin, cache);
            if (now() >= end) break;
        }
        return i < list.length ? i : -1;
    };

    const createIndex = (tracks, { pinyin = null, cache = null } = {}) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const entries = list.map((t) => cachedEntry(t, pinyin, cache));
        if (cache && cache.size > list.length + 64) {
            // 曲库里已经没有的歌，条目不留
            const keep = new Set(list.map((t) => t && t.path));
            for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
        }

        /* 一个词在一个字段上的得分；0 表示不匹配 */
        const termScore = (e, f, w, term, ascii) => {
            const v = e[f];
            if (v.startsWith(term)) return 100 * w;
            if (v.includes(term)) return 60 * w;
            if (ascii) {
                const py = e[f + 'Py'], ini = e[f + 'Ini'];
                if (py.startsWith(term)) return 45 * w;
                if (ini.startsWith(term)) return 40 * w;
                if (py.includes(term)) return 30 * w;
                if (ini.includes(term)) return 22 * w;
            } else {
                const ini = e[f + 'Ini'];
                if (ini.includes(term)) return 20 * w;
            }
            return 0;
        };

        /*
         * kind: 'all' | 'artist' | 'album'；only: 限定在这些曲库下标里（「最近」按传入顺序）。
         * 多个词（空格分开）都要匹配上；返回按得分排好的曲库下标。
         */
        const query = (q, { kind = 'all', only = null, limit = Infinity } = {}) => {
            // 智能条件词（喜欢、没听过、次数>N、>5分钟……，见 music-smart.js）先筛一遍，剩下的词照常检索
            let pool = only ? only : entries.map((_, i) => i);
            const smart = global.MusicSmart && global.MusicSmart.ctx ? global.MusicSmart.parse(q) : null;
            if (smart && smart.preds.length) {
                const ctx = global.MusicSmart.ctx();
                pool = pool.filter((i) => list[i] && smart.preds.every((p) => p.test(list[i], ctx)));
                q = smart.text;
                if (!norm(q).trim()) return pool.slice(0, limit);
            }
            const terms = norm(q).split(/\s+/).filter(Boolean);
            const fields = kind === 'artist' ? [['artist', 2]] : kind === 'album' ? [['album', 1]] : FIELDS;
            if (!terms.length) return only ? pool.slice(0, limit) : [];
            const hits = [];
            pool.forEach((i, order) => {
                const e = entries[i];
                if (!e) return;
                let total = 0;
                for (const term of terms) {
                    const ascii = /^[a-z0-9]+$/.test(term);
                    let best = 0;
                    for (const [f, w] of fields) best = Math.max(best, termScore(e, f, w, term, ascii));
                    if (!best) return;
                    total += best;
                }
                hits.push({ i, total, order });
            });
            hits.sort((a, b) => b.total - a.total || a.order - b.order);
            return hits.slice(0, limit).map((h) => h.i);
        };

        return {
            size: entries.length,
            entry: (i) => entries[i],
            group: (i) => (entries[i] ? entries[i].group : '#'),
            sortKey: (i) => (entries[i] ? entries[i].sort : ''),
            artistGroup: (i) => (entries[i] ? entries[i].artistGroup : '#'),
            artistKey: (i) => (entries[i] ? entries[i].artistSort : ''),
            query
        };
    };

    /*
     * 排序方式：标题（默认）、歌手、时长、添加时间。每种方式给出：
     * group(i) 分到哪一组、组的顺序 rank、组名 name/ref、同类可合并 family、组内比较 cmp。
     * 阵列的列、目录的分组、播放队列都按它排，换排序时三者一起变。
     * 曲库里没有记录添加时间，按曲库里的先后（新扫进来的追加在后面）当添加顺序，新的在前。
     */
    const SORTS = ['title', 'artist', 'duration', 'added'];
    const DURATION_BUCKETS = [
        ['d0', 180, '3 分钟以内', 'UNDER 03:00'],
        ['d3', 240, '3–4 分钟', '03:00–04:00'],
        ['d4', 300, '4–5 分钟', '04:00–05:00'],
        ['d5', 420, '5–7 分钟', '05:00–07:00'],
        ['d7', Infinity, '7 分钟以上', 'OVER 07:00'],
        ['d?', 0, '时长未知', 'UNKNOWN LENGTH']
    ];
    /*
     * 名次表：每个索引、每种排序键只排一次。曲库整体变化后新索引里绝大多数条目还是原来那些（条目缓存），
     * 这时沿用上一次排好的顺序：留下还在的，只把新来的排好再归并进去，比较次数从 n·log n 降到约 n。
     */
    const RANKS = new WeakMap();
    const LAST_ORDER = {};
    const mergeOrder = (index, prev, cmp) => {
        const n = index.size;
        if (!prev || !index.entry || prev.length < n / 2) return null;
        const at = new Map();
        for (let i = 0; i < n; i++) {
            const e = index.entry(i);
            if (at.has(e)) return null; // 同一路径出现两次（共用条目）：不走捷径
            at.set(e, i);
        }
        const kept = [];
        const seen = new Uint8Array(n);
        for (const e of prev) {
            const i = at.get(e);
            if (i !== undefined) { kept.push(i); seen[i] = 1; }
        }
        if (kept.length < n / 2) return null;
        const fresh = [];
        for (let i = 0; i < n; i++) if (!seen[i]) fresh.push(i);
        fresh.sort(cmp);
        const order = new Array(n);
        let a = 0, b = 0, k = 0;
        while (a < kept.length && b < fresh.length) order[k++] = cmp(kept[a], fresh[b]) <= 0 ? kept[a++] : fresh[b++];
        while (a < kept.length) order[k++] = kept[a++];
        while (b < fresh.length) order[k++] = fresh[b++];
        return order;
    };
    const rankOf = (index, key, cmp) => {
        let per = RANKS.get(index);
        if (!per) RANKS.set(index, per = {});
        if (!per[key]) {
            const order = mergeOrder(index, LAST_ORDER[key], cmp) || Array.from({ length: index.size }, (_, i) => i).sort(cmp);
            const rank = new Uint32Array(index.size);
            order.forEach((i, k) => { rank[i] = k; });
            per[key] = rank;
            if (index.entry) LAST_ORDER[key] = order.map((i) => index.entry(i));
        }
        return per[key];
    };
    /*
     * 分片排名次：先把下标切成小段各自排好，再两两归并；每一步都很短，step(budgetMs) 用完预算就返回 false，下次接着来。
     * 排完把结果放进名次表，之后 sortSpec 直接用。上一次的顺序能沿用时（mergeOrder）一步就完。
     */
    const rankJob = (index, key, cmp) => {
        let runs = null, sorted = 0, done = false;
        const finish = (order) => {
            let per = RANKS.get(index);
            if (!per) RANKS.set(index, per = {});
            const rank = new Uint32Array(index.size);
            order.forEach((i, k) => { rank[i] = k; });
            per[key] = rank;
            if (index.entry) LAST_ORDER[key] = order.map((i) => index.entry(i));
            done = true;
        };
        return (budgetMs = 8, now = () => performance.now()) => {
            if (done || (RANKS.get(index) || {})[key]) return true;
            const end = now() + budgetMs;
            if (!runs) {
                const quick = mergeOrder(index, LAST_ORDER[key], cmp);
                if (quick) { finish(quick); return true; }
                runs = [];
                for (let i = 0; i < index.size; i += 1024) runs.push(Array.from({ length: Math.min(1024, index.size - i) }, (_, k) => i + k));
                if (!runs.length) { finish([]); return true; }
            }
            while (sorted < runs.length) { runs[sorted++].sort(cmp); if (now() >= end) return false; }
            while (runs.length > 1) {
                // 每次归并最短的相邻一对里的第一对；一对最多 n 次比较
                const next = [];
                for (let k = 0; k < runs.length; k += 2) {
                    const a = runs[k], b = runs[k + 1];
                    if (!b) { next.push(a); continue; }
                    if (now() >= end) { next.push(a, b); continue; }
                    const out = new Array(a.length + b.length);
                    let x = 0, y = 0, z = 0;
                    while (x < a.length && y < b.length) out[z++] = cmp(a[x], b[y]) <= 0 ? a[x++] : b[y++];
                    while (x < a.length) out[z++] = a[x++];
                    while (y < b.length) out[z++] = b[y++];
                    next.push(out);
                }
                const stuck = next.length === runs.length;
                runs = next;
                if (stuck || now() >= end) return false;
            }
            finish(runs[0]);
            return true;
        };
    };
    const TITLE_CMP = (index) => (a, b) => COLLATE(index.sortKey(a), index.sortKey(b)) || a - b;
    const ARTIST_CMP = (index, titleRank) => (a, b) => {
        const ka = index.artistKey(a), kb = index.artistKey(b);
        if (!ka !== !kb) return ka ? -1 : 1; // 没写歌手的放最后
        return COLLATE(ka, kb) || titleRank[a] - titleRank[b];
    };
    /* 给界面用：为某种排序方式分片备好名次。返回 step(budgetMs) → 是否完成 */
    const prepareSort = (index, mode = 'title') => {
        const title = rankJob(index, 'title', TITLE_CMP(index));
        let artist = null;
        return (budgetMs = 8) => {
            if (!title(budgetMs)) return false;
            if (mode !== 'artist') return true;
            if (!artist) { artist = rankJob(index, 'artist', ARTIST_CMP(index, RANKS.get(index).title)); return false; }
            return artist(budgetMs);
        };
    };

    const sortSpec = (index, { mode = 'title', tracks = [], durationOf = null } = {}) => {
        // 标题的名次只排一次（按索引缓存）：之后各处比较都是数字相减，两万首切排序才不卡
        const titleRank = rankOf(index, 'title', TITLE_CMP(index));
        const byTitle = (a, b) => titleRank[a] - titleRank[b];
        const letter = { rank: (g) => GROUP_RANK.get(g) ?? 999, name: groupName, ref: groupRef, family: familyOf };
        if (mode === 'artist') {
            const artistRank = rankOf(index, 'artist', ARTIST_CMP(index, titleRank));
            return { mode, ...letter, group: (i) => index.artistGroup(i), cmp: (a, b) => artistRank[a] - artistRank[b] };
        }
        if (mode === 'duration') {
            const len = (i) => {
                const t = tracks[i];
                const d = Number(t && t.duration);
                return d > 0 ? d : Number(durationOf ? durationOf(t, i) : 0) || 0;
            };
            const bucketOf = (i) => {
                const d = len(i);
                if (!(d > 0)) return 'd?';
                return DURATION_BUCKETS.find(([, max]) => d < max)[0];
            };
            const meta = new Map(DURATION_BUCKETS.map(([id, , name, ref], k) => [id, { k, name, ref }]));
            return {
                mode,
                group: bucketOf,
                rank: (g) => (meta.has(g) ? meta.get(g).k : 999),
                name: (g) => (meta.get(g) || {}).name || g,
                ref: (g) => (meta.get(g) || {}).ref || g,
                family: (g) => g, // 时长段不合并
                cmp: (a, b) => {
                    const da = len(a), db = len(b);
                    if (!(da > 0) || !(db > 0)) return (da > 0 ? -1 : db > 0 ? 1 : 0) || byTitle(a, b);
                    return da - db || byTitle(a, b);
                }
            };
        }
        if (mode === 'added') {
            const n = Math.max(1, index.size);
            const chunk = Math.max(50, Math.ceil(n / 12));
            const pos = (i) => n - 1 - i; // 0 = 最新加入
            const range = (g) => {
                const k = Number(String(g).slice(1));
                return [k * chunk + 1, Math.min(n, (k + 1) * chunk)];
            };
            return {
                mode,
                group: (i) => 'n' + Math.floor(pos(i) / chunk),
                rank: (g) => Number(String(g).slice(1)),
                name: (g) => { const [a, b] = range(g); return a === 1 ? '最近加入 ' + b + ' 首' : '第 ' + a + '–' + b + ' 首'; },
                ref: (g) => { const [a, b] = range(g); return 'ADDED ' + String(a).padStart(3, '0') + '–' + String(b).padStart(3, '0'); },
                family: (g) => g,
                cmp: (a, b) => b - a
            };
        }
        return { mode: 'title', ...letter, group: (i) => index.group(i), cmp: byTitle };
    };

    const familyOf = (g) => (/^[A-Z]$/.test(g) ? 'latin' : KANA_ROW_OF.has(g) ? 'kana' : g);
    const mergedName = (a, b) => {
        if (a === b) return groupName(a);
        if (familyOf(a) === 'kana') return a + '–' + b + '行';
        return a + '–' + b;
    };

    /*
     * 按首字母分好的组，组内按排序键排；只返回有歌的组。
     * minSize > 1 时，同一类（拉丁字母、假名行）里歌太少的相邻组合并成「X–Z」这样的一列，免得一列只有一两张卡。
     * 返回的每列带 groups（包含的首字母），方便从首字母找到所在列。
     */
    const groupColumns = (index, indices, { minSize = 1, spec = null } = {}) => {
        const sp = spec || sortSpec(index);
        const groups = new Map();
        for (const i of indices) {
            const g = sp.group(i);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(i);
        }
        const ordered = [...groups.entries()].sort((a, b) => sp.rank(a[0]) - sp.rank(b[0]));
        const runs = [];
        for (const [g, items] of ordered) {
            const last = runs[runs.length - 1];
            if (last && sp.family(last.groups[0]) === sp.family(g) && last.items.length < minSize) {
                last.groups.push(g); last.items.push(...items);
            } else {
                runs.push({ groups: [g], items: [...items] });
            }
        }
        // 每一类最后一段还是太少，就并到同一类的前一段
        for (let k = runs.length - 1; k > 0; k--) {
            const cur = runs[k], prev = runs[k - 1];
            if (cur.items.length < minSize && sp.family(prev.groups[0]) === sp.family(cur.groups[0])) {
                prev.groups.push(...cur.groups); prev.items.push(...cur.items); runs.splice(k, 1);
            }
        }
        const prefix = sp.mode === 'title' ? 'letter:' : 'sort-' + sp.mode + ':';
        return runs.map(({ groups: gs, items }) => {
            const first = gs[0], lastG = gs[gs.length - 1];
            const single = gs.length === 1;
            return {
                id: prefix + (single ? first : first + '-' + lastG),
                kind: 'letter',
                group: first,
                groups: gs,
                name: single ? sp.name(first) : mergedName(first, lastG),
                ref: single ? sp.ref(first) : 'INDEX ' + first + '–' + lastG,
                items: items.sort(sp.cmp)
            };
        });
    };

    /*
     * 目录列表的行：{ type: 'head', label, key } 或 { type: 'track', i, ctx }。
     * ctx 是这一行在阵列里对应的列 id（选中时相机跟到那一列）。
     * kind: all | artist | album | playlist | recent（recent 后面再接 sections：[{ label, key, items }]）。有检索词时 all 按得分排成一组。
     * columnOfGroup(g)：首字母分组对应的列 id（阵列按首字母拆列时用），没有就用 'all'。
     */
    const listRows = ({ tracks, playlists = [], recent = [], sections = [], index, kind = 'all', query = '', columnOfGroup = null, spec = null }) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const q = String(query || '').trim();
        const rows = [];
        let count = 0;
        const head = (label, key, n) => rows.push({ type: 'head', label, key, n });
        const push = (i, ctx) => { rows.push({ type: 'track', i, ctx }); count++; };
        const sp = spec || sortSpec(index, { tracks: list });
        const allCtx = (i) => (columnOfGroup ? columnOfGroup(sp.group(i)) : 'all');
        const byTitle = sp.cmp; // 组内顺序跟着排序方式

        if (kind === 'recent') {
            const pool = recent.filter((i) => i >= 0 && i < list.length);
            const hits = q ? index.query(q, { only: pool }) : pool;
            if (hits.length) head('最近播放', 'recent', hits.length);
            hits.forEach((i) => push(i, 'recent'));
            // 听歌记录给的几组（最常听、很久没听……）：同一首可以出现在几组里，ctx 区分
            for (const sec of sections || []) {
                const items = (sec && sec.items || []).filter((i) => i >= 0 && i < list.length);
                const got = q ? index.query(q, { only: items }) : items;
                if (!got.length) continue;
                head(String(sec.label), String(sec.key), got.length);
                got.forEach((i) => push(i, String(sec.key)));
            }
            return { rows, count };
        }
        if (kind === 'playlist') {
            const byPath = new Map();
            list.forEach((t, i) => { const k = String(t && t.path || '').replace(/\\/g, '/').toLowerCase(); if (k && !byPath.has(k)) byPath.set(k, i); });
            (playlists || []).forEach((pl, order) => {
                if (!pl) return;
                const items = (pl.tracks || []).map((p) => byPath.get(String(p || '').replace(/\\/g, '/').toLowerCase())).filter((i) => i !== undefined);
                const nameHit = q && norm(pl.name).includes(norm(q));
                const hits = !q || nameHit ? items : index.query(q, { only: items });
                if (!hits.length && (q || items.length)) return;
                const id = 'playlist:' + (pl.id ?? order);
                head(String(pl.name || '未命名歌单'), id, hits.length);
                hits.forEach((i) => push(i, id));
            });
            return { rows, count };
        }
        if (kind === 'artist' || kind === 'album') {
            const field = kind;
            const pool = q ? index.query(q, { kind: field }) : list.map((_, i) => i);
            const groups = new Map();
            for (const i of pool) {
                const name = String(list[i] && list[i][field] || '').trim() || (field === 'artist' ? '未知歌手' : '未知专辑');
                if (!groups.has(name)) groups.set(name, []);
                groups.get(name).push(i);
            }
            const sortName = (n) => romanize(n, null).py;
            [...groups.entries()]
                .sort((a, b) => (q ? 0 : sortName(a[0]).localeCompare(sortName(b[0]))))
                .forEach(([name, items]) => {
                    const ctx = field === 'album' ? 'album:' + name : null;
                    head(name, field + ':' + name, items.length);
                    // 专辑按碟号、曲号排（排序方式是默认的「标题」时）；选了时长、加入时间就照选的排
                    const inAlbum = field === 'album' && sp.mode === 'title' && global.MusicTrackOrder ? global.MusicTrackOrder.albumCompare(list, byTitle) : byTitle;
                    (q ? items : items.sort(inAlbum)).forEach((i) => push(i, ctx || allCtx(i)));
                });
            return { rows, count };
        }
        // all
        if (q) {
            const hits = index.query(q);
            if (hits.length) head('检索结果', 'search', hits.length);
            hits.forEach((i) => push(i, allCtx(i)));
            return { rows, count };
        }
        const groups = new Map();
        list.forEach((_, i) => {
            const g = sp.group(i);
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(i);
        });
        // 标题、歌手排序：组标题是首字母（放在左侧外边距）；时长、添加时间：组标题是小标题行
        const letterHeads = sp.mode === 'title' || sp.mode === 'artist';
        [...groups.entries()]
            .sort((a, b) => sp.rank(a[0]) - sp.rank(b[0]))
            .forEach(([g, items]) => {
                head(sp.name(g), (letterHeads ? 'letter:' : 'sort:') + g, items.length);
                items.sort(sp.cmp).forEach((i) => push(i, allCtx(i)));
            });
        return { rows, count };
    };

    /* 全局顺序：先按首字母分组的固定顺序，组内按标题（数字按数值）。阵列、目录、队列都用它 */
    const sortedIndices = (index, indices, spec = null) => groupColumns(index, indices, { spec }).flatMap((c) => c.items);

    const api = Object.freeze({ norm, toHiragana, romanize, groupOf, groupName, createIndex, warm, prepareSort, groupColumns, sortedIndices, listRows, sortSpec, SORTS, GROUP_ORDER });
    if (typeof module === 'object' && module.exports) module.exports = api;
    global.MusicArchiveIndex = api;
})(typeof window !== 'undefined' ? window : globalThis);
