/*
 * 曲库检索索引：标题、歌手、专辑的即时匹配，支持拼音全拼和首字母、平假名片假名互通；
 * 同时给出每首歌按首字母归入的分组（A–Z、あ行…、0–9、其他）和组内排序键。
 * 汉字转拼音由外部传入的 pinyin(char) 提供（音乐窗口里用已有依赖按需加载），
 * 没有时汉字只按原文匹配、分组归到「其他」。不碰 DOM，方便在 node 里测试。
 */
(function (global) {
    'use strict';

    const NON_ASCII = /[^\x20-\x7e]/;
    // ASCII 可见字符、常用汉字（U+4E00–U+9FFF）和基础平假名（U+3041–U+3096）均为 NFKC 不变量且无片假名，
    // 命中快路径可跳过昂贵的 ICU NFKC 归一化与片假名正则替换。
    const NEEDS_NFKC = /[^\x20-\x7e\u4e00-\u9fff\u3041-\u3096]/;
    const KATAKANA = /[ァ-ヶ]/;
    const toHiragana = (s) => (KATAKANA.test(s) ? s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)) : s);
    const norm = (s) => {
        const raw = String(s || '');
        if (!raw) return '';
        if (!NEEDS_NFKC.test(raw)) return raw.toLowerCase().trim();
        return toHiragana(raw.normalize('NFKC').toLowerCase()).trim();
    };
    const isHanCode = (code) => (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0xf900 && code <= 0xfaff);
    const stripExt = (t) => {
        const raw = typeof t === 'string' ? t : String(t || '');
        const len = raw.length;
        if (!len) return '';
        const lo = len > 5 ? len - 5 : 0;
        for (let i = len - 1; i >= lo; i -= 1) {
            if (raw.charCodeAt(i) === 46) return raw.replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '');
        }
        return raw;
    };
    const HAN = /[㐀-䶿一-鿿豈-﫿]/;
    const LATIN = /[a-z]/;
    const DIGIT = /[0-9]/;
    const LEADING_JUNK = /^[\s\p{P}\p{S}]+/u;
    const SKIP_NON_ASCII = /\s|\p{P}|\p{S}/u;
    const WS_SPLIT_RE = /\s+/;
    const ASCII_TERM_RE = /^[a-z0-9]+$/;
    const BSLASH_RE = /\\/g;
    // 31-bit 正整数字符存在位图：a-z 占 bit 0..25，0-9 折叠到 bit 26..30（非负 Smi，零符号位溢出）。
    // romanizeNormalized 保留原文与首字母里的所有 ASCII 字母/数字，因此 alnumMask(py) 是 v/py/ini 的精确超集，
    // 查询时按位与未命中可直接跳过字符串 indexOf 与 Map 查找，保证零假阴性。
    const alnumMask = (s) => {
        let m = 0;
        for (let i = 0; i < s.length; i += 1) {
            const c = s.charCodeAt(i);
            if (c >= 97 && c <= 122) m |= 1 << (c - 97);
            else if (c >= 48 && c <= 57) m |= 1 << (26 + ((c - 48) % 5));
        }
        return m;
    };
    const PINYIN_CACHE = new WeakMap();
    const cachedPinyin = (pinyin, ch) => {
        let map = PINYIN_CACHE.get(pinyin);
        if (!map) { map = new Map(); PINYIN_CACHE.set(pinyin, map); }
        let hit = map.get(ch);
        if (hit === undefined) {
            hit = String(pinyin(ch) || '').normalize('NFD').toLowerCase().replace(/[^a-z]/g, '');
            if (map.size >= 8192) map.clear();
            map.set(ch, hit);
        }
        return hit;
    };

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
    const romanizeNormalized = (s, pinyin) => {
        if (!s) return { py: '', ini: '' };
        // 纯 ASCII 字符串走索引快路径，避免 for..of Unicode 迭代器分配
        if (!NON_ASCII.test(s)) {
            let py = '';
            let ini = '';
            let wordStart = true;
            for (let i = 0; i < s.length; i++) {
                const code = s.charCodeAt(i);
                if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
                    const ch = s[i];
                    py += ch;
                    if (wordStart) ini += ch;
                    wordStart = false;
                } else {
                    wordStart = true;
                }
            }
            return { py, ini };
        }
        let py = '';
        let ini = '';
        let wordStart = true;
        for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            if (code < 0x80) {
                if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
                    const ch = s[i];
                    py += ch;
                    if (wordStart) ini += ch;
                    wordStart = false;
                } else {
                    wordStart = true;
                }
            } else if (isHanCode(code)) {
                const c = s[i];
                const p = pinyin ? cachedPinyin(pinyin, c) : '';
                if (p) { py += p; ini += p[0]; } else { py += c; ini += c; }
                wordStart = true;
            } else {
                const c = (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) ? s.slice(i, i + 2) : s[i];
                if (c.length === 2) i += 1;
                if (KANA_ROW_OF.has(c) || (code >= 0x3040 && code <= 0x309f) || code === 0x30fc) {
                    py += c; ini += c; wordStart = true;
                } else {
                    if (!SKIP_NON_ASCII.test(c)) { py += c; ini += c; }
                    wordStart = true;
                }
            }
        }
        return { py, ini };
    };
    const romanize = (text, pinyin) => romanizeNormalized(norm(text), pinyin);

    const groupFromNorm = (normText, pinyin) => {
        if (!normText) return '#';
        const c0 = normText.charCodeAt(0);
        if (c0 >= 97 && c0 <= 122) return String.fromCharCode(c0 - 32);
        if (c0 >= 48 && c0 <= 57) return '0-9';
        const s = normText.replace(LEADING_JUNK, '');
        const c = s ? s[0] : '';
        if (!c) return '#';
        const code = c.charCodeAt(0);
        if (code >= 97 && code <= 122) return String.fromCharCode(code - 32);
        if (code >= 48 && code <= 57) return '0-9';
        const first = code >= 0xd800 && code <= 0xdbff ? [...s][0] : c;
        if (KANA_ROW_OF.has(first)) return KANA_ROW_OF.get(first);
        if (HAN.test(first) && pinyin) {
            const p = cachedPinyin(pinyin, first);
            if (p) return p[0].toUpperCase();
        }
        return '#';
    };
    const groupOf = (title, pinyin) => groupFromNorm(norm(stripExt(title)), pinyin);

    // 组内排序：数字按数值比（Song 2 在 Song 10 前面）
    const COLLATE = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare
        : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const LOCALE_CMP = typeof Intl !== 'undefined' ? new Intl.Collator().compare : (a, b) => a.localeCompare(b);

    const FIELD_CACHE_BY_PY = new WeakMap();
    const FIELD_CACHE_NO_PY = new Map();
    const EMPTY_FIELD = Object.freeze({ n: '', py: '', ini: '', grp: '#' });
    const cachedMetaField = (raw, pinyin, needGroup) => {
        if (!raw) return EMPTY_FIELD;
        let map = FIELD_CACHE_NO_PY;
        if (typeof pinyin === 'function') {
            map = FIELD_CACHE_BY_PY.get(pinyin);
            if (!map) { map = new Map(); FIELD_CACHE_BY_PY.set(pinyin, map); }
        }
        let hit = map.get(raw);
        if (!hit) {
            const n = norm(raw);
            const r = romanizeNormalized(n, pinyin);
            hit = { n, py: r.py, ini: r.ini, grp: needGroup ? (n ? groupFromNorm(n, pinyin) : '#') : null };
            if (map.size >= 4096) map.clear();
            map.set(raw, hit);
        } else if (needGroup && hit.grp === null) {
            hit.grp = hit.n ? groupFromNorm(hit.n, pinyin) : '#';
        }
        return hit;
    };

    /* 一首歌的检索条目：三个字段的原文、全拼、首字母，加上分组和排序键 */
    const entryOf = (t, pinyin) => {
        const titleRaw = stripExt(t && t.title);
        const titleN = norm(titleRaw);
        const titleR = romanizeNormalized(titleN, pinyin);
        const artistF = cachedMetaField((t && t.artist) || '', pinyin, true);
        const albumF = cachedMetaField((t && t.album) || '', pinyin, false);
        return {
            title: titleN,
            titlePy: titleR.py,
            titleIni: titleR.ini,
            artist: artistF.n,
            artistPy: artistF.py,
            artistIni: artistF.ini,
            album: albumF.n,
            albumPy: albumF.py,
            albumIni: albumF.ini,
            group: groupFromNorm(titleN, pinyin),
            sort: titleR.py || titleN,
            artistGroup: artistF.grp,
            artistSort: artistF.py || artistF.n
        };
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
            const keep = new Set();
            for (let i = 0; i < list.length; i += 1) keep.add(list[i] && list[i].path);
            for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
        }
        // 紧致整型位图数组（按曲库下标对齐）：缓存命中与 0 命中搜索先走 L1 整数按位与筛选，避免扫 5000 条字符串。
        const n = entries.length;
        const titleMasks = new Int32Array(n);
        const artistMasks = new Int32Array(n);
        const albumMasks = new Int32Array(n);
        const allMasks = new Int32Array(n);
        const artistMaskCache = new Map();
        const albumMaskCache = new Map();
        for (let i = 0; i < n; i += 1) {
            const e = entries[i];
            if (!e) continue;
            const tm = alnumMask(e.titlePy);
            let am = artistMaskCache.get(e.artistPy);
            if (am === undefined) { am = alnumMask(e.artistPy); artistMaskCache.set(e.artistPy, am); }
            let alm = albumMaskCache.get(e.albumPy);
            if (alm === undefined) { alm = alnumMask(e.albumPy); albumMaskCache.set(e.albumPy, alm); }
            titleMasks[i] = tm;
            artistMasks[i] = am;
            albumMasks[i] = alm;
            allMasks[i] = tm | am | alm;
        }

        /* 一个词在一个字段上的得分；0 表示不匹配（单趟 indexOf，跳过与原文等价的 py/ini） */
        const scoreField = (v, py, ini, w, term, ascii) => {
            if (!v) return 0;
            let idx = v.indexOf(term);
            if (idx === 0) return 100 * w;
            if (idx > 0) return 60 * w;
            if (ascii) {
                // 单字符数字/符号不可能由汉字转拼音凭空产生，原文未命中直接跳过 py/ini 扫描
                if (term.length === 1) {
                    const tc = term.charCodeAt(0);
                    if (tc < 97 || tc > 122) return 0;
                }
                if (py && py !== v) {
                    idx = py.indexOf(term);
                    if (idx === 0) return 45 * w;
                    if (idx > 0) return (ini && ini !== v && ini !== py && ini.startsWith(term)) ? 40 * w : 30 * w;
                }
                if (ini && ini !== v && ini !== py) {
                    idx = ini.indexOf(term);
                    if (idx === 0) return 40 * w;
                    if (idx > 0) return 22 * w;
                }
                return 0;
            }
            return (ini && ini !== v && ini.includes(term)) ? 20 * w : 0;
        };
        const scoreEntryTerm = (e, kindCode, term, ascii) => {
            if (kindCode === 1) return scoreField(e.artist, e.artistPy, e.artistIni, 2, term, ascii);
            if (kindCode === 2) return scoreField(e.album, e.albumPy, e.albumIni, 1, term, ascii);
            let best = scoreField(e.title, e.titlePy, e.titleIni, 3, term, ascii);
            if (best < 200) {
                const sa = scoreField(e.artist, e.artistPy, e.artistIni, 2, term, ascii);
                if (sa > best) best = sa;
            }
            if (best < 100) {
                const sal = scoreField(e.album, e.albumPy, e.albumIni, 1, term, ascii);
                if (sal > best) best = sal;
            }
            return best;
        };
        // 单槽增量收窄缓存：连续打字（如 A -> Ar -> Artist 1）的新词严格是上次查询词的超串或追加词时，
        // 数学上必为上次全量命中集的子集，直接在上次命中集上打分，免去每次按键重扫 5000+ 曲库；
        // 词项完全一致（如尾随空格 "Artist "）时直接切分复用上次结果。
        let lastQuery = null;
        const sameTerms = (a, b) => {
            if (a.length !== b.length) return false;
            for (let k = 0; k < a.length; k += 1) {
                if (a[k].term !== b[k].term) return false;
            }
            return true;
        };
        const canNarrowFrom = (prev, kindCode, terms) => {
            if (!prev || prev.kindCode !== kindCode || terms.length < prev.terms.length) return false;
            for (let k = 0; k < prev.terms.length; k += 1) {
                if (terms[k].ascii !== prev.terms[k].ascii || !terms[k].term.includes(prev.terms[k].term)) return false;
            }
            return true;
        };

        /*
         * kind: 'all' | 'artist' | 'album'；only: 限定在这些曲库下标里（「最近」按传入顺序）。
         * 多个词（空格分开）都要匹配上；返回按得分排好的曲库下标。
         */
        const query = (q, { kind = 'all', only = null, limit = Infinity } = {}) => {
            // 智能条件词（喜欢、没听过、次数>N、>5分钟……，见 music-smart.js）先筛一遍，剩下的词照常检索
            let pool = only || null;
            let hasSmart = false;
            const smart = global.MusicSmart && global.MusicSmart.ctx ? global.MusicSmart.parse(q) : null;
            if (smart && smart.preds.length) {
                hasSmart = true;
                const ctx = global.MusicSmart.ctx();
                const filtered = [];
                if (pool) {
                    for (let k = 0; k < pool.length; k++) {
                        const i = pool[k];
                        if (list[i] && smart.preds.every((p) => p.test(list[i], ctx))) filtered.push(i);
                    }
                } else {
                    for (let i = 0; i < entries.length; i++) {
                        if (list[i] && smart.preds.every((p) => p.test(list[i], ctx))) filtered.push(i);
                    }
                }
                pool = filtered;
                q = smart.text;
                if (!norm(q).trim()) return pool.slice(0, limit);
            }
            const rawParts = norm(q).split(WS_SPLIT_RE);
            const terms = [];
            let combinedMask = 0;
            for (let i = 0; i < rawParts.length; i += 1) {
                const term = rawParts[i];
                if (term) {
                    const mask = alnumMask(term);
                    combinedMask |= mask;
                    terms.push({ term, ascii: ASCII_TERM_RE.test(term), mask });
                }
            }
            const kindCode = kind === 'artist' ? 1 : kind === 'album' ? 2 : 0;
            if (!terms.length) return only ? pool.slice(0, limit) : [];
            const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : entries.length;
            if (cap === 0) return [];
            const cacheable = !only && !hasSmart;
            if (cacheable && lastQuery && lastQuery.kindCode === kindCode) {
                if (sameTerms(lastQuery.terms, terms) && lastQuery.cap >= cap) {
                    return lastQuery.topOut.slice(0, cap);
                }
                if (canNarrowFrom(lastQuery, kindCode, terms)) {
                    pool = lastQuery.matchedIds;
                }
            }
            const scanLen = pool ? pool.length : entries.length;
            const useFieldCache = scanLen > 64;
            const tLen = terms.length;
            // 1–4 词查询时得分必落在 1..1200 的离散整数桶内，按分桶 O(N) 收集天然保序且可提前截断，免去对象分配与排序；
            // 大曲库按唯一歌手/专辑串就地记忆得分，省去 5000 首歌上重复对同一歌手/专辑跑 indexOf。
            if (tLen <= 4) {
                const buckets = new Array(tLen * 300 + 1);
                let maxScore = 0;
                let totalHits = 0;
                const matchedIds = cacheable ? [] : null;
                const t0 = terms[0].term;
                const a0 = terms[0].ascii;
                const m0 = terms[0].mask;
                const t0Code = t0.charCodeAt(0);
                if (kindCode === 1 || kindCode === 2) {
                    const isArtist = kindCode === 1;
                    const weight = isArtist ? 2 : 1;
                    const fieldMasks = isArtist ? artistMasks : albumMasks;
                    const totalCache = useFieldCache ? new Map() : null;
                    for (let idxPos = 0; idxPos < scanLen; idxPos += 1) {
                        const i = pool ? pool[idxPos] : idxPos;
                        if (combinedMask && (fieldMasks[i] & combinedMask) !== combinedMask) continue;
                        const e = entries[i];
                        if (!e) continue;
                        const fieldVal = isArtist ? e.artist : e.album;
                        let total;
                        if (totalCache) {
                            total = totalCache.get(fieldVal);
                            if (total === undefined) {
                                const fieldPy = isArtist ? e.artistPy : e.albumPy;
                                const fieldIni = isArtist ? e.artistIni : e.albumIni;
                                total = scoreField(fieldVal, fieldPy, fieldIni, weight, t0, a0);
                                if (total) {
                                    for (let t = 1; t < tLen; t += 1) {
                                        const best = scoreField(fieldVal, fieldPy, fieldIni, weight, terms[t].term, terms[t].ascii);
                                        if (!best) { total = 0; break; }
                                        total += best;
                                    }
                                }
                                totalCache.set(fieldVal, total);
                            }
                        } else {
                            const fieldPy = isArtist ? e.artistPy : e.albumPy;
                            const fieldIni = isArtist ? e.artistIni : e.albumIni;
                            total = scoreField(fieldVal, fieldPy, fieldIni, weight, t0, a0);
                            if (total) {
                                for (let t = 1; t < tLen; t += 1) {
                                    const best = scoreField(fieldVal, fieldPy, fieldIni, weight, terms[t].term, terms[t].ascii);
                                    if (!best) { total = 0; break; }
                                    total += best;
                                }
                            }
                        }
                        if (!total) continue;
                        let b = buckets[total];
                        if (!b) buckets[total] = [i];
                        else b.push(i);
                        if (total > maxScore) maxScore = total;
                        totalHits += 1;
                        if (matchedIds) matchedIds.push(i);
                    }
                } else {
                    const aMaps = useFieldCache ? Array.from({ length: tLen }, () => new Map()) : null;
                    const alMaps = useFieldCache ? Array.from({ length: tLen }, () => new Map()) : null;
                    const aMap0 = aMaps ? aMaps[0] : null;
                    const alMap0 = alMaps ? alMaps[0] : null;
                    for (let idxPos = 0; idxPos < scanLen; idxPos += 1) {
                        const i = pool ? pool[idxPos] : idxPos;
                        if (combinedMask && (allMasks[i] & combinedMask) !== combinedMask) continue;
                        const e = entries[i];
                        if (!e) continue;
                        // 先查按歌手缓存的得分：当歌手前缀命中（200 分）时，仅标题前缀命中（300 分）能超越，
                        // 跳过 5000 首歌上标题全串/拼音/首字母与专辑扫描（数学上完全等价）。
                        let sa0;
                        if (m0 && (artistMasks[i] & m0) !== m0) {
                            sa0 = 0;
                        } else if (aMap0) {
                            sa0 = aMap0.get(e.artist);
                            if (sa0 === undefined) { sa0 = scoreField(e.artist, e.artistPy, e.artistIni, 2, t0, a0); aMap0.set(e.artist, sa0); }
                        } else sa0 = scoreField(e.artist, e.artistPy, e.artistIni, 2, t0, a0);
                        let best0;
                        if (sa0 === 200) {
                            best0 = (!m0 || (titleMasks[i] & m0) === m0) && e.title && e.title.charCodeAt(0) === t0Code && e.title.startsWith(t0) ? 300 : 200;
                        } else {
                            best0 = (m0 && (titleMasks[i] & m0) !== m0) ? 0 : scoreField(e.title, e.titlePy, e.titleIni, 3, t0, a0);
                            if (sa0 > best0) best0 = sa0;
                            if (best0 < 100 && (!m0 || (albumMasks[i] & m0) === m0)) {
                                let sal;
                                if (alMap0) {
                                    sal = alMap0.get(e.album);
                                    if (sal === undefined) { sal = scoreField(e.album, e.albumPy, e.albumIni, 1, t0, a0); alMap0.set(e.album, sal); }
                                } else sal = scoreField(e.album, e.albumPy, e.albumIni, 1, t0, a0);
                                if (sal > best0) best0 = sal;
                            }
                        }
                        if (!best0) continue;
                        let total = best0;
                        for (let t = 1; t < tLen; t += 1) {
                            const termObj = terms[t];
                            const term = termObj.term;
                            const ascii = termObj.ascii;
                            const mt = termObj.mask;
                            let sa;
                            if (mt && (artistMasks[i] & mt) !== mt) {
                                sa = 0;
                            } else if (aMaps) {
                                const am = aMaps[t];
                                sa = am.get(e.artist);
                                if (sa === undefined) { sa = scoreField(e.artist, e.artistPy, e.artistIni, 2, term, ascii); am.set(e.artist, sa); }
                            } else sa = scoreField(e.artist, e.artistPy, e.artistIni, 2, term, ascii);
                            let best;
                            if (sa === 200) {
                                best = (!mt || (titleMasks[i] & mt) === mt) && e.title && e.title.charCodeAt(0) === term.charCodeAt(0) && e.title.startsWith(term) ? 300 : 200;
                            } else {
                                best = (mt && (titleMasks[i] & mt) !== mt) ? 0 : scoreField(e.title, e.titlePy, e.titleIni, 3, term, ascii);
                                if (sa > best) best = sa;
                                if (best < 100 && (!mt || (albumMasks[i] & mt) === mt)) {
                                    let sal;
                                    if (alMaps) {
                                        const alm = alMaps[t];
                                        sal = alm.get(e.album);
                                        if (sal === undefined) { sal = scoreField(e.album, e.albumPy, e.albumIni, 1, term, ascii); alm.set(e.album, sal); }
                                    } else sal = scoreField(e.album, e.albumPy, e.albumIni, 1, term, ascii);
                                    if (sal > best) best = sal;
                                }
                            }
                            if (!best) { total = 0; break; }
                            total += best;
                        }
                        if (!total) continue;
                        let b = buckets[total];
                        if (!b) buckets[total] = [i];
                        else b.push(i);
                        if (total > maxScore) maxScore = total;
                        totalHits += 1;
                        if (matchedIds) matchedIds.push(i);
                    }
                }
                if (!totalHits) {
                    if (cacheable) lastQuery = { kindCode, terms, matchedIds, cap: entries.length, topOut: [] };
                    return [];
                }
                const want = Math.min(totalHits, cap);
                const out = new Array(want);
                let pos = 0;
                for (let s = maxScore; s > 0 && pos < want; s -= 1) {
                    const b = buckets[s];
                    if (!b) continue;
                    const take = Math.min(b.length, want - pos);
                    for (let k = 0; k < take; k += 1) out[pos++] = b[k];
                }
                if (cacheable) lastQuery = { kindCode, terms, matchedIds, cap: totalHits <= cap ? entries.length : cap, topOut: out.slice() };
                return out;
            }
            const hits = [];
            const matchedIds = cacheable ? [] : null;
            const gateMasks = kindCode === 1 ? artistMasks : kindCode === 2 ? albumMasks : allMasks;
            for (let order = 0; order < scanLen; order += 1) {
                const i = pool ? pool[order] : order;
                if (combinedMask && (gateMasks[i] & combinedMask) !== combinedMask) continue;
                const e = entries[i];
                if (!e) continue;
                let total = 0;
                for (let t = 0; t < tLen; t += 1) {
                    const best = scoreEntryTerm(e, kindCode, terms[t].term, terms[t].ascii);
                    if (!best) { total = 0; break; }
                    total += best;
                }
                if (!total) continue;
                hits.push({ i, total, order });
                if (matchedIds) matchedIds.push(i);
            }
            hits.sort((a, b) => b.total - a.total || a.order - b.order);
            const cappedLen = hits.length > cap ? cap : hits.length;
            const out = new Array(cappedLen);
            for (let k = 0; k < cappedLen; k++) out[k] = hits[k].i;
            if (cacheable) lastQuery = { kindCode, terms, matchedIds, cap: hits.length <= cap ? entries.length : cap, topOut: out.slice() };
            return out;
        };

        const groupFn = (i) => (entries[i] ? entries[i].group : '#');
        const artistGroupFn = (i) => (entries[i] ? entries[i].artistGroup : '#');
        const idxObj = {
            size: entries.length,
            entry: (i) => entries[i],
            group: groupFn,
            sortKey: (i) => (entries[i] ? entries[i].sort : ''),
            artistGroup: artistGroupFn,
            artistKey: (i) => (entries[i] ? entries[i].artistSort : ''),
            query
        };
        INDEX_META.set(idxObj, { entries, groupFn, artistGroupFn });
        return idxObj;
    };

    const INDEX_META = new WeakMap();

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
    const rankOf = (index, key, cmpFactory) => {
        let per = RANKS.get(index);
        if (!per) RANKS.set(index, per = {});
        if (!per[key]) {
            const cmp = cmpFactory();
            const n = index.size;
            let order = mergeOrder(index, LAST_ORDER[key], cmp);
            if (!order) {
                order = new Array(n);
                for (let i = 0; i < n; i += 1) order[i] = i;
                order.sort(cmp);
            }
            const rank = new Uint32Array(n);
            const packed = new Uint32Array(order.length);
            for (let k = 0; k < order.length; k += 1) {
                const idx = order[k];
                rank[idx] = k;
                packed[k] = idx;
            }
            per[key] = rank;
            per[key + 'Order'] = packed;
            if (index.entry) {
                const last = new Array(order.length);
                for (let k = 0; k < order.length; k += 1) last[k] = index.entry(order[k]);
                LAST_ORDER[key] = last;
            }
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
            const packed = new Uint32Array(order.length);
            for (let k = 0; k < order.length; k += 1) {
                const idx = order[k];
                rank[idx] = k;
                packed[k] = idx;
            }
            per[key] = rank;
            per[key + 'Order'] = packed;
            if (index.entry) {
                const last = new Array(order.length);
                for (let k = 0; k < order.length; k += 1) last[k] = index.entry(order[k]);
                LAST_ORDER[key] = last;
            }
            done = true;
        };
        return (budgetMs = 8, now = () => performance.now()) => {
            if (done || (RANKS.get(index) || {})[key]) return true;
            const end = now() + budgetMs;
            if (!runs) {
                const quick = mergeOrder(index, LAST_ORDER[key], cmp);
                if (quick) { finish(quick); return true; }
                runs = [];
                for (let i = 0; i < index.size; i += 1024) {
                    const chunkLen = Math.min(1024, index.size - i);
                    const chunk = new Array(chunkLen);
                    for (let k = 0; k < chunkLen; k += 1) chunk[k] = i + k;
                    runs.push(chunk);
                }
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
    // 先仅对去重后的非空歌手键做一次 Collator 排序（邻项 Collator 判等时共享名次），
    // 再基于已排好的 titleOrder 做 O(N) 稳定计数排序，免去全曲库 O(N log N) JS 比较器回调。
    const artistRankOf = (index) => {
        let per = RANKS.get(index);
        if (!per) RANKS.set(index, per = {});
        if (per.artist) return per.artist;
        const n = index.size;
        const titleOrder = per.titleOrder || (() => { rankOf(index, 'title', () => TITLE_CMP(index)); return RANKS.get(index).titleOrder; })();
        const uniq = new Map();
        const sorted = [];
        const rawKeys = new Array(n);
        for (let i = 0; i < n; i += 1) {
            const k = index.artistKey(i);
            rawKeys[i] = k;
            if (k && !uniq.has(k)) { uniq.set(k, 0); sorted.push(k); }
        }
        sorted.sort(COLLATE);
        let curRank = 0;
        for (let j = 0; j < sorted.length; j += 1) {
            if (j > 0 && COLLATE(sorted[j - 1], sorted[j]) !== 0) curRank = j;
            uniq.set(sorted[j], curRank);
        }
        const emptyRank = sorted.length;
        const counts = new Uint32Array(emptyRank + 1);
        const keyRanks = new Uint32Array(n);
        for (let i = 0; i < n; i += 1) {
            const k = rawKeys[i];
            const r = k ? uniq.get(k) : emptyRank;
            keyRanks[i] = r;
            counts[r] += 1;
        }
        const offsets = new Uint32Array(emptyRank + 1);
        let acc = 0;
        for (let r = 0; r <= emptyRank; r += 1) {
            offsets[r] = acc;
            acc += counts[r];
        }
        const packed = new Uint32Array(n);
        const rank = new Uint32Array(n);
        for (let k = 0; k < n; k += 1) {
            const idx = titleOrder[k];
            const pos = offsets[keyRanks[idx]]++;
            packed[pos] = idx;
            rank[idx] = pos;
        }
        per.artist = rank;
        per.artistOrder = packed;
        if (index.entry) {
            const last = new Array(n);
            for (let k = 0; k < n; k += 1) last[k] = index.entry(packed[k]);
            LAST_ORDER.artist = last;
        }
        return rank;
    };
    const DURATION_META = new Map(DURATION_BUCKETS.map(([id, , name, ref], k) => [id, { k, name, ref }]));
    /* 给界面用：为某种排序方式分片备好名次。返回 step(budgetMs) → 是否完成 */
    const prepareSort = (index, mode = 'title') => {
        const title = rankJob(index, 'title', TITLE_CMP(index));
        return (budgetMs = 8) => {
            if (!title(budgetMs)) return false;
            if (mode !== 'artist') return true;
            artistRankOf(index);
            return true;
        };
    };

    const sortSpec = (index, { mode = 'title', tracks = [], durationOf = null } = {}) => {
        // 标题的名次只排一次（按索引缓存）：之后各处比较都是数字相减，两万首切排序才不卡
        const titleRank = rankOf(index, 'title', () => TITLE_CMP(index));
        const byTitle = (a, b) => titleRank[a] - titleRank[b];
        const letter = { rank: (g) => GROUP_RANK.get(g) ?? 999, name: groupName, ref: groupRef, family: familyOf };
        if (mode === 'artist') {
            const artistRank = artistRankOf(index);
            const order = RANKS.get(index)?.artistOrder || null;
            return { mode, ...letter, group: (i) => index.artistGroup(i), cmp: (a, b) => artistRank[a] - artistRank[b], order };
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
                for (let b = 0; b < DURATION_BUCKETS.length; b += 1) {
                    if (d < DURATION_BUCKETS[b][1]) return DURATION_BUCKETS[b][0];
                }
                return DURATION_BUCKETS[DURATION_BUCKETS.length - 1][0];
            };
            return {
                mode,
                group: bucketOf,
                rank: (g) => (DURATION_META.has(g) ? DURATION_META.get(g).k : 999),
                name: (g) => (DURATION_META.get(g) || {}).name || g,
                ref: (g) => (DURATION_META.get(g) || {}).ref || g,
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
        const order = RANKS.get(index)?.titleOrder || null;
        return { mode: 'title', ...letter, group: (i) => index.group(i), cmp: byTitle, order };
    };

    const familyOf = (g) => (typeof g === 'string' && g.length === 1 && g >= 'A' && g <= 'Z' ? 'latin' : KANA_ROW_OF.has(g) ? 'kana' : g);
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
    const isFullRange = (indices, size) => {
        if (!indices || indices.length !== size) return false;
        for (let k = 0; k < size; k += 1) if (indices[k] !== k) return false;
        return true;
    };

    const directEntriesForGroup = (index, sp) => {
        const meta = INDEX_META.get(index);
        if (!meta) return null;
        if (sp.mode === 'title' && index.group === meta.groupFn && sp.group) return { entries: meta.entries, field: 'group' };
        if (sp.mode === 'artist' && index.artistGroup === meta.artistGroupFn && sp.group) return { entries: meta.entries, field: 'artistGroup' };
        return null;
    };

    const groupColumns = (index, indices, { minSize = 1, spec = null } = {}) => {
        const sp = spec || sortSpec(index);
        // 全库下标且已缓存全局有序序列时直接按序分桶：单组桶天然有序，省去各组 O(N log N) 重排
        const preSorted = Boolean(sp.order && sp.order.length === index.size && isFullRange(indices, index.size));
        const src = preSorted ? sp.order : indices;
        const groups = new Map();
        const fast = directEntriesForGroup(index, sp);
        let prevG = null;
        let prevBucket = null;
        if (fast) {
            const ents = fast.entries;
            const byArtist = fast.field === 'artistGroup';
            for (let k = 0; k < src.length; k += 1) {
                const i = src[k];
                const e = ents[i];
                const g = e ? (byArtist ? e.artistGroup : e.group) : '#';
                if (g === prevG) { prevBucket.push(i); continue; }
                let bucket = groups.get(g);
                if (!bucket) { bucket = []; groups.set(g, bucket); }
                bucket.push(i);
                prevG = g;
                prevBucket = bucket;
            }
        } else {
            for (let k = 0; k < src.length; k += 1) {
                const i = src[k];
                const g = sp.group(i);
                if (g === prevG) { prevBucket.push(i); continue; }
                let bucket = groups.get(g);
                if (!bucket) { bucket = []; groups.set(g, bucket); }
                bucket.push(i);
                prevG = g;
                prevBucket = bucket;
            }
        }
        const ordered = [...groups.entries()].sort((a, b) => sp.rank(a[0]) - sp.rank(b[0]));
        const runs = [];
        const appendAll = (dst, srcArr) => { for (let j = 0; j < srcArr.length; j++) dst.push(srcArr[j]); };
        for (let oi = 0; oi < ordered.length; oi += 1) {
            const g = ordered[oi][0];
            const items = ordered[oi][1];
            const last = runs[runs.length - 1];
            if (last && sp.family(last.groups[0]) === sp.family(g) && last.items.length < minSize) {
                last.groups.push(g); appendAll(last.items, items);
            } else {
                runs.push({ groups: [g], items });
            }
        }
        // 每一类最后一段还是太少，就并到同一类的前一段
        for (let k = runs.length - 1; k > 0; k--) {
            const cur = runs[k], prev = runs[k - 1];
            if (cur.items.length < minSize && sp.family(prev.groups[0]) === sp.family(cur.groups[0])) {
                appendAll(prev.groups, cur.groups); appendAll(prev.items, cur.items); runs.splice(k, 1);
            }
        }
        const prefix = sp.mode === 'title' ? 'letter:' : 'sort-' + sp.mode + ':';
        const out = new Array(runs.length);
        for (let ri = 0; ri < runs.length; ri += 1) {
            const gs = runs[ri].groups;
            const items = runs[ri].items;
            const first = gs[0], lastG = gs[gs.length - 1];
            const single = gs.length === 1;
            out[ri] = {
                id: prefix + (single ? first : first + '-' + lastG),
                kind: 'letter',
                group: first,
                groups: gs,
                name: single ? sp.name(first) : mergedName(first, lastG),
                ref: single ? sp.ref(first) : 'INDEX ' + first + '–' + lastG,
                items: preSorted && single ? items : items.sort(sp.cmp)
            };
        }
        return out;
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
            for (let i = 0; i < list.length; i += 1) {
                const t = list[i];
                const rawPath = t && t.path;
                if (!rawPath) continue;
                const k = String(rawPath).replace(BSLASH_RE, '/').toLowerCase();
                if (k && !byPath.has(k)) byPath.set(k, i);
            }
            const qNorm = q ? norm(q) : '';
            for (let order = 0; order < (playlists || []).length; order += 1) {
                const pl = playlists[order];
                if (!pl) continue;
                const tracksInPl = pl.tracks || [];
                const items = [];
                for (let j = 0; j < tracksInPl.length; j += 1) {
                    const hit = byPath.get(String(tracksInPl[j] || '').replace(BSLASH_RE, '/').toLowerCase());
                    if (hit !== undefined) items.push(hit);
                }
                const nameHit = Boolean(qNorm) && norm(pl.name).includes(qNorm);
                const hits = !q || nameHit ? items : index.query(q, { only: items });
                if (!hits.length && (q || items.length)) continue;
                const id = 'playlist:' + (pl.id ?? order);
                head(String(pl.name || '未命名歌单'), id, hits.length);
                for (let j = 0; j < hits.length; j += 1) push(hits[j], id);
            }
            return { rows, count };
        }
        if (kind === 'artist' || kind === 'album') {
            const field = kind;
            const fallbackName = field === 'artist' ? '未知歌手' : '未知专辑';
            const isAlbum = field === 'album';
            // 专辑按碟号、曲号排（排序方式是默认的「标题」时）；选了时长、加入时间就照选的排。
            // 若已按 sp.order 顺序入桶，则仅对含有碟号/曲号的专辑跑一次比较排序，无曲号专辑天然已是标题序。
            const trackOrder = !q && isAlbum && sp.mode === 'title' && global.MusicTrackOrder ? global.MusicTrackOrder : null;
            const useOrder = !q && Boolean(sp.order && sp.order.length === list.length);
            const checkOrder = Boolean(useOrder && trackOrder);
            const groups = new Map();
            let anyAlbumToSort = false;
            let prevRaw = undefined;
            let prevBucket = null;
            const pushGroup = (i) => {
                const tr = list[i];
                const raw = tr && tr[field];
                let bucket;
                if (raw === prevRaw && prevBucket) {
                    bucket = prevBucket;
                } else {
                    let name;
                    if (typeof raw === 'string') {
                        const rLen = raw.length;
                        name = rLen > 0 && raw.charCodeAt(0) > 32 && raw.charCodeAt(rLen - 1) > 32 ? raw : raw.trim();
                    } else {
                        name = String(raw || '').trim();
                    }
                    if (!name) name = fallbackName;
                    bucket = groups.get(name);
                    if (!bucket) { bucket = []; bucket._hasOrd = false; groups.set(name, bucket); }
                    prevRaw = raw;
                    prevBucket = bucket;
                }
                bucket.push(i);
                if (checkOrder && !bucket._hasOrd) {
                    const ordInfo = trackOrder.numberOf(tr);
                    if (ordInfo.no > 0 || ordInfo.disc > 0) { bucket._hasOrd = true; anyAlbumToSort = true; }
                }
            };
            if (q) {
                const pool = index.query(q, { kind: field });
                for (let k = 0; k < pool.length; k += 1) pushGroup(pool[k]);
            } else if (useOrder) {
                const ord = sp.order;
                for (let k = 0; k < ord.length; k += 1) pushGroup(ord[k]);
            } else {
                for (let i = 0; i < list.length; i += 1) pushGroup(i);
            }
            let ordered;
            if (q) {
                ordered = [...groups.entries()];
            } else {
                const keyed = [];
                for (const [name, items] of groups) keyed.push({ name, items, key: cachedMetaField(name, null, false).py });
                keyed.sort((a, b) => LOCALE_CMP(a.key, b.key));
                ordered = keyed;
            }
            const needInAlbum = !q && (!useOrder || anyAlbumToSort);
            const inAlbum = needInAlbum ? (trackOrder ? trackOrder.albumCompare(list, byTitle) : byTitle) : null;
            const prefix = field + ':';
            for (let oi = 0; oi < ordered.length; oi += 1) {
                const name = q ? ordered[oi][0] : ordered[oi].name;
                const items = q ? ordered[oi][1] : ordered[oi].items;
                const ctx = isAlbum ? 'album:' + name : null;
                head(name, prefix + name, items.length);
                if (inAlbum && items.length > 1 && (!useOrder || items._hasOrd)) items.sort(inAlbum);
                for (let j = 0; j < items.length; j += 1) {
                    const idx = items[j];
                    push(idx, ctx || allCtx(idx));
                }
            }
            return { rows, count };
        }
        // all
        if (q) {
            const hits = index.query(q);
            if (hits.length) head('检索结果', 'search', hits.length);
            for (let k = 0; k < hits.length; k += 1) push(hits[k], allCtx(hits[k]));
            return { rows, count };
        }
        const preSortedAll = Boolean(sp.order && sp.order.length === list.length);
        const groups = new Map();
        const fastAll = directEntriesForGroup(index, sp);
        let prevG = null;
        let prevBucket = null;
        if (preSortedAll) {
            const ord = sp.order;
            if (fastAll) {
                const ents = fastAll.entries;
                const byArtist = fastAll.field === 'artistGroup';
                for (let k = 0; k < ord.length; k += 1) {
                    const i = ord[k];
                    const e = ents[i];
                    const g = e ? (byArtist ? e.artistGroup : e.group) : '#';
                    if (g === prevG) { prevBucket.push(i); continue; }
                    let bucket = groups.get(g);
                    if (!bucket) { bucket = []; groups.set(g, bucket); }
                    bucket.push(i);
                    prevG = g;
                    prevBucket = bucket;
                }
            } else {
                for (let k = 0; k < ord.length; k += 1) {
                    const i = ord[k];
                    const g = sp.group(i);
                    if (g === prevG) { prevBucket.push(i); continue; }
                    let bucket = groups.get(g);
                    if (!bucket) { bucket = []; groups.set(g, bucket); }
                    bucket.push(i);
                    prevG = g;
                    prevBucket = bucket;
                }
            }
        } else {
            for (let i = 0; i < list.length; i += 1) {
                const g = sp.group(i);
                if (g === prevG) { prevBucket.push(i); continue; }
                let bucket = groups.get(g);
                if (!bucket) { bucket = []; groups.set(g, bucket); }
                bucket.push(i);
                prevG = g;
                prevBucket = bucket;
            }
        }
        // 标题、歌手排序：组标题是首字母（放在左侧外边距）；时长、添加时间：组标题是小标题行
        const letterHeads = sp.mode === 'title' || sp.mode === 'artist';
        const groupKeys = [...groups.keys()].sort((a, b) => sp.rank(a) - sp.rank(b));
        for (let gi = 0; gi < groupKeys.length; gi += 1) {
            const g = groupKeys[gi];
            const items = groups.get(g);
            head(sp.name(g), (letterHeads ? 'letter:' : 'sort:') + g, items.length);
            const bucketCtx = columnOfGroup ? columnOfGroup(g) : 'all';
            if (!preSortedAll) items.sort(sp.cmp);
            for (let k = 0; k < items.length; k += 1) push(items[k], bucketCtx);
        }
        return { rows, count };
    };

    /* 全局顺序：先按首字母分组的固定顺序，组内按标题（数字按数值）。阵列、目录、队列都用它 */
    const sortedIndices = (index, indices, spec = null) => groupColumns(index, indices, { spec }).flatMap((c) => c.items);

    const api = Object.freeze({ norm, toHiragana, romanize, groupOf, groupName, createIndex, warm, prepareSort, groupColumns, sortedIndices, listRows, sortSpec, SORTS, GROUP_ORDER });
    if (typeof module === 'object' && module.exports) module.exports = api;
    global.MusicArchiveIndex = api;
})(typeof window !== 'undefined' ? window : globalThis);
