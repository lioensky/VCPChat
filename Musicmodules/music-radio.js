// Musicmodules/music-radio.js
// 电台与自动续播（Spotify 的「自动播放」、Plexamp 的电台）：
//   - 右键「从这首开电台」：以这首为种子，从曲库里挑同歌手、同专辑、常听、喜欢的歌排成一串接着放，
//     快放完时自己再续一段，不会绕回开头。
//   - 自动续播：从一组（专辑、歌手、歌单、检索结果）点播，放到这一组最后一首时，后面自动接上相似的歌，
//     不再绕回这一组开头。提示条上可以一键关掉；整个曲库顺序播放、单曲循环、随机时不接。
// 挑歌只用本机的曲目信息和听歌记录（music-stats.js），不联网。
//
// 对外：app.startRadio(trackOrIndex)、app.dailyMix()、app.neverPlayed()、app.autoplay.enabled（读写，存本机）、
//       app.radio（正在放的电台：{ seed, label } 或 null）。纯函数 pickSimilar 供测试。

(function (global) {
    'use strict';

    const KEY = 'musicAutoplay';
    const BATCH = 25;     // 一次续多少首
    const REFILL_AT = 4;  // 剩这么多首时再续
    const SHUFFLE_KEY = 'musicDailyMixShuffle';
    const SEEN_KEY = 'musicDailyMixSeen';
    const SEEN_BATCHES = 4;              // 存当前这批 + 之前 3 批
    const SEEN_DAMP = [0.15, 0.35, 0.6]; // 上一批、上上批、再往前一批
    const SEEN_DAYS = 7;

    const pad2 = (n) => String(n).padStart(2, '0');
    const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    // 之前推过的批次：去掉当前这批，只留 7 天内的前 3 批
    const recentBatches = (batches, id, day) => {
        const dayMs = Date.parse(day + 'T00:00:00');
        const maxAge = SEEN_DAYS * 86400000;
        const out = [];
        for (let i = 0; i < batches.length && out.length < SEEN_DAMP.length; i += 1) {
            const b = batches[i];
            if (b.id === id) continue;
            const at = Date.parse(String(b.id).slice(0, 10) + 'T00:00:00');
            if (Number.isFinite(at) && dayMs - at <= maxAge && dayMs >= at) out.push(b);
        }
        return out;
    };

    const norm = (s) => String(s || '').trim().toLowerCase();
    const ARTIST_SPLIT = /\s*(?:\/|,|，|、|&|;|feat\.?|ft\.)\s*/;
    const artistsOf = (t) => norm(t && t.artist).split(ARTIST_SPLIT).filter(Boolean);

    // 同一首歌的不同文件（flac 和 mp3、专辑版和合辑里的同一首、本机和 WebDAV 各一份）：歌名去掉扩展名 + 完整歌手相同就算一首。
    // 没有歌手的不合并：没标签时歌名常是「01」之类的文件名，会把不相干的歌并到一起。
    const AUDIO_EXT = /\.(flac|mp3|wav|m4a|aac|ogg|opus|ape|wv|alac|aiff?|dsf|dff|wma)$/i;
    const HTTP_SCHEME_RE = /^https?:\/\//i;
    const LOSSLESS_PATH_RE = /\.(flac|wav|ape|wv|aiff?|alac|dsf|dff)$/i;
    const BSLASH_RE = /\\/g;
    const recordingKey = (t) => {
        const artist = norm(t && t.artist);
        const title = norm(String((t && t.title) || '').replace(AUDIO_EXT, ''));
        return artist && title ? title + '\n' + artist : '';
    };
    // 同一首里放哪份：本机文件 > 网络；无损 > 有损；位深、采样率、码率高的优先。
    const isRemote = (t) => {
        if (!t) return false;
        if (t.isRemote) return true;
        const p = String(t.path || '');
        const c0 = p.charCodeAt(0);
        return (c0 === 104 || c0 === 72) && HTTP_SCHEME_RE.test(p);
    };
    const versionRank = (t) => (isRemote(t) ? 0 : 1e9)
        + (t.lossless === true || LOSSLESS_PATH_RE.test(String(t.path || '')) ? 1e8 : 0)
        + (Number(t.bitsPerSample) || 0) * 1e6
        + Math.min(999, Math.round((Number(t.sampleRate) || 0) / 1000)) * 1e3
        + Math.min(999, Math.round((Number(t.bitrate) || 0) / 1000));
    // 伴奏 / 纯音乐版 / 卡拉 OK：电台和推荐里往后放（种子本身是伴奏时不降）
    const INSTRUMENTAL = /instrumental|\binst\.?(?=\s*[)\]）】]|$)|off[\s-]?vocal|karaoke|backing track|伴奏|纯音乐版|純音樂|カラオケ|オフボーカル/i;
    // 无 /i、无词边界/前瞻的纯字面量预筛，对 99% 普通曲名走 V8 线性快路径；命中后再走精确匹配
    const INSTRUMENTAL_HINT = /inst|off|karaoke|backing|伴奏|纯音乐版|純音樂|カラオケ|オフボーカル/;
    const INSTRUMENTAL_LOWER = /instrumental|\binst\.?(?=\s*[)\]）】]|$)|off[\s-]?vocal|karaoke|backing track|伴奏|纯音乐版|純音樂|カラオケ|オフボーカル/;
    const isInstrumentalLower = (lowTitle) => Boolean(lowTitle) && INSTRUMENTAL_HINT.test(lowTitle) && INSTRUMENTAL_LOWER.test(lowTitle);
    const isInstrumental = (t) => isInstrumentalLower(norm(String((t && t.title) || '').replace(AUDIO_EXT, '')));

    /*
     * 从曲库里挑和种子相近的歌。seeds 是最近放的几首（越靠后越重要），exclude 是不要的（刚放过、已在队列里）。
     * 打分：同歌手 3、同专辑 1.5、同流派 1、常听 0..2、喜欢 1.5、跳得多的往后，再加一点随机让每次不一样；
     * 然后控制同一歌手不超过三分之一、同一专辑不超过 3 首，避免一串全是同一张专辑。
     * 同一首歌的几个文件只出一份（挑 versionRank 最高的），种子和 exclude 里那首的其他文件也不出；
     * 伴奏版分数打到四分之一；playable(t) 为 false 的（放不了的）不出。
     */
    function pickSimilar(library, seeds, { size = BATCH, exclude = new Set(), affinity = () => 0, liked = () => false, novelty = () => 0, random = Math.random, playable = () => true, damp = () => 1 } = {}) {
        const seedArtists = new Map();
        const seedAlbums = new Set();
        const seedGenres = new Set();
        const takenKeys = new Set();
        let instrumentalOk = false;
        const seedLen = seeds.length;
        for (let k = 0; k < seedLen; k += 1) {
            const t = seeds[k];
            const w = 0.6 + 0.4 * (k + 1) / seedLen; // 越近的种子分量越重
            const na = norm(t && t.artist);
            if (na) {
                const parts = na.split(ARTIST_SPLIT);
                for (let p = 0; p < parts.length; p += 1) {
                    const a = parts[p];
                    if (a) {
                        const prevW = seedArtists.get(a) || 0;
                        if (w > prevW) seedArtists.set(a, w);
                    }
                }
            }
            const nal = norm(t && t.album);
            if (nal) seedAlbums.add(nal + '\n' + na);
            const ng = norm(t && t.genre);
            if (ng) seedGenres.add(ng);
            const rawTitle = String((t && t.title) || '');
            const nt = norm(rawTitle.lastIndexOf('.') >= 0 ? rawTitle.replace(AUDIO_EXT, '') : rawTitle);
            if (na && nt) takenKeys.add(nt + '\n' + na);
            if (!instrumentalOk && isInstrumentalLower(nt)) instrumentalOk = true;
        }
        for (const t of exclude) { const k = recordingKey(t); if (k) takenKeys.add(k); }
        // 每首歌先挑出最好的那份文件，其余的不参加打分（缓存规范化歌手/标题并仅在重名录音冲突时懒算 versionRank）
        const n = library.length;
        const best = new Map();
        const bestRank = new Map();
        const keys = new Array(n);
        const normArtists = new Array(n);
        const normTitles = new Array(n);
        const ok = new Uint8Array(n);
        const hasSeedArtists = seedArtists.size > 0;
        const hasSeedAlbums = seedAlbums.size > 0;
        const hasSeedGenres = seedGenres.size > 0;
        const hasTakenKeys = takenKeys.size > 0;
        const artistNormCache = new Map();
        const normArtistCached = (raw) => {
            if (!raw) return '';
            let v = artistNormCache.get(raw);
            if (v === undefined) {
                v = norm(raw);
                artistNormCache.set(raw, v);
            }
            return v;
        };
        for (let i = 0; i < n; i += 1) {
            const t = library[i];
            if (!t || !t.path || exclude.has(t) || !playable(t)) continue;
            const na = normArtistCached(t.artist);
            const rawTitle = String(t.title || '');
            const stripped = rawTitle.lastIndexOf('.') >= 0 ? rawTitle.replace(AUDIO_EXT, '') : rawTitle;
            const nt = norm(stripped);
            const k = na && nt ? nt + '\n' + na : '';
            if (k && hasTakenKeys && takenKeys.has(k)) continue;
            ok[i] = 1;
            normArtists[i] = na;
            normTitles[i] = nt;
            keys[i] = k;
            if (!k) continue;
            const prev = best.get(k);
            if (prev === undefined) {
                best.set(k, t);
            } else {
                let prevRank = bestRank.get(k);
                if (prevRank === undefined) {
                    prevRank = versionRank(prev);
                    bestRank.set(k, prevRank);
                }
                const r = versionRank(t);
                if (r > prevRank) {
                    best.set(k, t);
                    bestRank.set(k, r);
                }
            }
        }
        const scored = [];
        // 歌手拆分与种子匹配、专辑/流派归一化按唯一字符串缓存，5000 曲库下仅算 ~100–300 次而非 5000 次
        const artistScoreCache = new Map();
        const albumNormCache = new Map();
        const genreHitCache = hasSeedGenres ? new Map() : null;
        for (let i = 0; i < n; i += 1) {
            if (!ok[i]) continue;
            const t = library[i];
            const key = keys[i];
            if (key && best.get(key) !== t) continue;
            let s = 0;
            const normArtist = normArtists[i];
            let firstArtist = '';
            if (normArtist) {
                let cachedArtist = artistScoreCache.get(normArtist);
                if (cachedArtist === undefined) {
                    const parts = normArtist.split(ARTIST_SPLIT);
                    let artistHit = 0;
                    let fa = '';
                    for (let p = 0; p < parts.length; p += 1) {
                        const a = parts[p];
                        if (!a) continue;
                        if (!fa) fa = a;
                        if (hasSeedArtists) {
                            const hit = seedArtists.get(a) || 0;
                            if (hit > artistHit) artistHit = hit;
                        }
                    }
                    cachedArtist = [fa, hasSeedArtists ? 3 * artistHit : 0];
                    artistScoreCache.set(normArtist, cachedArtist);
                }
                firstArtist = cachedArtist[0];
                s += cachedArtist[1];
            }
            const rawAlbum = t.album;
            let normAlbum = '';
            if (rawAlbum) {
                normAlbum = albumNormCache.get(rawAlbum);
                if (normAlbum === undefined) {
                    normAlbum = norm(rawAlbum);
                    albumNormCache.set(rawAlbum, normAlbum);
                }
            }
            const albumKey = normAlbum ? normAlbum + '\n' + normArtist : '';
            if (hasSeedAlbums && albumKey && seedAlbums.has(albumKey)) s += 1.5;
            if (hasSeedGenres && t.genre) {
                let gHit = genreHitCache.get(t.genre);
                if (gHit === undefined) {
                    const g = norm(t.genre);
                    gHit = (g && seedGenres.has(g)) ? 1 : 0;
                    genreHitCache.set(t.genre, gHit);
                }
                s += gHit;
            }
            s += 2 * affinity(t);
            if (liked(t)) s += 1.5;
            s += novelty(t); // 每日推荐里给没听过的歌一点加分，让曲库里沉着的歌浮上来
            s += 1.2 * random();
            if (!instrumentalOk && isInstrumentalLower(normTitles[i])) s *= 0.25;
            s *= damp(t); // 每日推荐：前几批刚推过的往后放
            scored.push([s, t, firstArtist, albumKey]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        const out = [];
        const picked = new Set();
        const perArtist = new Map();
        const perAlbum = new Map();
        const artistCap = Math.max(2, Math.ceil(size / 3));
        let prevArtist1 = '';
        let prevArtist2 = '';
        const pass = (strict) => {
            for (let i = 0; i < scored.length; i += 1) {
                if (out.length >= size) return;
                const entry = scored[i];
                const t = entry[1];
                if (picked.has(t)) continue;
                const a = entry[2];
                const al = entry[3];
                if (strict && ((perArtist.get(a) || 0) >= artistCap || (al && (perAlbum.get(al) || 0) >= 3))) continue;
                // 同一歌手不连着放两首以上
                if (strict && out.length >= 2 && a && prevArtist1 === a && prevArtist2 === a) continue;
                out.push(t);
                picked.add(t);
                prevArtist2 = prevArtist1;
                prevArtist1 = a;
                perArtist.set(a, (perArtist.get(a) || 0) + 1);
                if (al) perAlbum.set(al, (perAlbum.get(al) || 0) + 1);
            }
        };
        // 「不连着三首」会让一遍扫下来留空位，空位在后面几遍里补上，直到补不动
        for (let before = -1; out.length < size && out.length !== before;) { before = out.length; pass(true); }
        if (out.length < size) pass(false); // 曲库小、歌手少时放宽
        return out;
    }

    function setupMusicRadio(app, { storage = (() => { try { return global.localStorage; } catch (e) { return null; } })() } = {}) {
        if (!app || app.startRadio) return;
        const doc = global.document;
        let enabled = true;
        try { enabled = storage?.getItem(KEY) !== '0'; } catch (e) { /* 默认开 */ }
        app.autoplay = {
            get enabled() { return enabled; },
            set enabled(v) {
                enabled = Boolean(v);
                try { storage?.setItem(KEY, enabled ? '1' : '0'); } catch (e) { /* 只是偏好 */ }
                try { doc?.dispatchEvent?.(new CustomEvent('music-autoplay-change', { detail: { enabled } })); } catch (e) { /* 旧内核 */ }
            }
        };
        app.radio = null;

        const toast = (message, action) => { try { global.MusicToast?.show?.({ message, action, duration: action ? 8000 : undefined }); } catch (e) { /* 没有提示层 */ } };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';
        const normSlashPath = (p) => norm(String(p || '').replace(BSLASH_RE, '/'));
        const recentSet = (list) => {
            const set = new Set(list);
            // 最近放过的 30 首（档案页记的最近播放）先不放
            let paths = [];
            try { paths = JSON.parse(global.localStorage?.getItem('musicArchiveRecent') || '[]'); } catch (e) { paths = []; }
            const want = new Set();
            const cap = Math.min(30, paths.length);
            for (let i = 0; i < cap; i += 1) {
                const k = normSlashPath(paths[i]);
                if (k) want.add(k);
            }
            if (want.size) {
                const lib = app.playlist || [];
                for (let i = 0; i < lib.length; i += 1) {
                    const t = lib[i];
                    if (t && t.path && want.has(normSlashPath(t.path))) set.add(t);
                }
            }
            return set;
        };
        // 这次运行里已经放失败过的歌（文件不见了、格式不支持）不往电台里放
        const playable = (t) => !(app.failedTracks instanceof Map && app.failedTracks.has(t));
        const pick = (seeds, exclude, size = BATCH) => pickSimilar(app.playlist || [], seeds, {
            size,
            exclude,
            affinity: (t) => app.musicStats?.affinity?.(t) || 0,
            liked: (t) => Boolean(app.isLiked?.(t)),
            playable
        });
        const setContext = (list) => {
            app.currentFilteredTracks = list;
            if (app.playbackContext) app.playbackContext.list = list;
            try { doc?.dispatchEvent?.(new CustomEvent('music-queue-change')); } catch (e) { /* 旧内核 */ }
            try { app.refreshPreload?.(); } catch (e) { /* 还没在放 */ }
        };

        // ---- 同一首的另一份文件（这份放不了时顶上）：同录音里挑 versionRank 最高、这次没放失败过的 ----
        app.alternateCopy = (track) => {
            const wantArtist = norm(track && track.artist);
            const rawWantTitle = String((track && track.title) || '');
            const wantTitle = norm(rawWantTitle.lastIndexOf('.') >= 0 ? rawWantTitle.replace(AUDIO_EXT, '') : rawWantTitle);
            if (!wantArtist || !wantTitle) return null;
            const artistMatch = new Map();
            let best = null;
            let bestRank = -1;
            const lib = app.playlist || [];
            for (let i = 0; i < lib.length; i += 1) {
                const t = lib[i];
                if (!t || t === track || !t.path || t.path === track.path || !t.artist || !t.title) continue;
                let okArtist = artistMatch.get(t.artist);
                if (okArtist === undefined) {
                    okArtist = norm(t.artist) === wantArtist;
                    artistMatch.set(t.artist, okArtist);
                }
                if (!okArtist || !playable(t)) continue;
                const rawTitle = String(t.title);
                const stripped = rawTitle.lastIndexOf('.') >= 0 ? rawTitle.replace(AUDIO_EXT, '') : rawTitle;
                if (norm(stripped) !== wantTitle) continue;
                const r = versionRank(t);
                if (!best || r > bestRank) { best = t; bestRank = r; }
            }
            return best;
        };

        // ---- 从一首歌开电台 ----
        app.startRadio = (ref) => {
            const track = typeof ref === 'number' ? app.playlist?.[ref] : ref;
            if (!track || !(app.playlist || []).includes(track)) return false;
            const exclude = recentSet([track]);
            const list = [track, ...pick([track], exclude)];
            if (list.length < 2) { toast('曲库里没有能接着放的歌'); return false; }
            app.radio = { seed: track, label: `「${title(track)}」电台`, list };
            app.playFromContext(list, app.playlist.indexOf(track), { origin: 'radio', render: false });
            toast(`已开始${app.radio.label}：${list.length} 首，快放完时会自己续上`);
            return true;
        };

        // ---- 每日推荐（Spotify 的 Daily Mix）：以最常听、最近听的几首为种子，同一天结果不变；
        //      大约三分之一是还没听过的歌。没有听歌记录时用最近播放；都没有就随机。
        const seeded = (seedText) => {
            let h = 2166136261;
            for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
            return () => { h += 0x6D2B79F5; let x = h; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
        };
        const byPaths = (paths, sharedMap) => {
            if (!paths || !paths.length) return [];
            const lib = app.playlist || [];
            if (!lib.length) return [];
            if (sharedMap) {
                const out = [];
                for (let i = 0; i < paths.length; i++) {
                    const hit = sharedMap.get(normSlashPath(paths[i]));
                    if (hit) out.push(hit);
                }
                return out;
            }
            // 待查路径较少时（每日推荐通常仅 8~15 条），按需扫描并找齐即止，避免重建整张 5000+ 曲库 Map
            const keys = new Array(paths.length);
            const need = new Map();
            for (let i = 0; i < paths.length; i += 1) {
                const k = normSlashPath(paths[i]);
                keys[i] = k;
                if (k && !need.has(k)) need.set(k, null);
            }
            let remaining = need.size;
            if (!remaining) return [];
            for (let i = 0; i < lib.length && remaining > 0; i++) {
                const t = lib[i];
                if (!t || !t.path) continue;
                const k = normSlashPath(t.path);
                if (need.has(k) && need.get(k) === null) {
                    need.set(k, t);
                    remaining--;
                }
            }
            const out = [];
            for (let i = 0; i < keys.length; i++) {
                const hit = need.get(keys[i]);
                if (hit) out.push(hit);
            }
            return out;
        };
        // 「今天」按本机时区算（以前按 UTC，东八区要到早上 8 点才换）
        const today = () => localDay(new Date());
        // 换一批：同一天里第几批（存本机，跨天归零）
        const readShuffle = () => {
            try {
                const v = JSON.parse(storage?.getItem(SHUFFLE_KEY) || 'null');
                return v && v.day === today() ? Math.max(0, Number(v.n) || 0) : 0;
            } catch (e) { return 0; }
        };
        // 推过的批次（最新在前，最多 3 批、7 天内）：再挑时依次 ×0.15 / ×0.35 / ×0.6，
        // 让每日推荐每天、每换一批都真的不一样，又不至于把喜欢的歌永远挡在外面
        const readSeen = () => {
            try {
                const v = JSON.parse(storage?.getItem(SEEN_KEY) || 'null');
                return v && v.v === 1 && Array.isArray(v.b) ? v.b.filter((b) => b && typeof b.id === 'string' && Array.isArray(b.p)) : [];
            } catch (e) { return []; }
        };
        const writeSeen = (batches) => { try { storage?.setItem(SEEN_KEY, JSON.stringify({ v: 1, b: batches })); } catch (e) { /* 存不下就算了 */ } };
        const pathKey = (t) => normSlashPath(t && t.path);
        let mixCache = { key: '', list: [] };
        app.dailyMixKey = () => today() + '#' + readShuffle();
        app.dailyMix = ({ size = 30 } = {}) => {
            const lib = app.playlist || [];
            const day = today();
            const id = app.dailyMixKey();
            const key = id + '|' + lib.length + '|' + size;
            if (mixCache.key === key) return mixCache.list;
            const storedSeen = readSeen();
            const earlier = recentBatches(storedSeen, id, day);
            const damping = new Map();
            for (let k = 0; k < earlier.length; k += 1) {
                const ps = earlier[k].p;
                const dVal = SEEN_DAMP[k];
                for (let j = 0; j < ps.length; j += 1) {
                    const p = ps[j];
                    if (!damping.has(p)) damping.set(p, dVal);
                }
            }
            const stats = app.musicStats;
            const topPaths = stats ? stats.top(8, { minPlays: 1 }) : [];
            const lastPaths = stats ? stats.lastPlayed(15) : [];
            let recentPaths = [];
            if (topPaths.length < 3) {
                try { recentPaths = JSON.parse(global.localStorage?.getItem('musicArchiveRecent') || '[]').slice(0, 8); } catch (e) { recentPaths = []; }
            }
            // 三组小路径集一次线性查找收集，避免重复扫描曲库或重复构建 5000 项 Map
            let lookup = null;
            if (topPaths.length || recentPaths.length || lastPaths.length) {
                lookup = new Map();
                const addKeys = (arr) => {
                    for (let i = 0; i < arr.length; i += 1) {
                        const k = normSlashPath(arr[i]);
                        if (k && !lookup.has(k)) lookup.set(k, null);
                    }
                };
                addKeys(topPaths);
                addKeys(recentPaths);
                addKeys(lastPaths);
                let rem = lookup.size;
                for (let i = 0; i < lib.length && rem > 0; i += 1) {
                    const t = lib[i];
                    if (!t || !t.path) continue;
                    const k = normSlashPath(t.path);
                    if (lookup.has(k) && lookup.get(k) === null) {
                        lookup.set(k, t);
                        rem -= 1;
                    }
                }
            }
            const seeds = byPaths(topPaths, lookup);
            if (seeds.length < 3 && recentPaths.length) {
                const extra = byPaths(recentPaths, lookup);
                for (let i = 0; i < extra.length; i += 1) {
                    const t = extra[i];
                    if (!seeds.includes(t)) seeds.push(t);
                }
            }
            const shuffle = readShuffle();
            const random = seeded(day + '|' + lib.length + (shuffle ? '|' + shuffle : ''));
            const hasStat = stats ? (typeof stats.has === 'function' ? (t) => stats.has(t) : (t) => Boolean(stats.get(t))) : null;
            const list = pickSimilar(lib, seeds, {
                size,
                exclude: new Set(byPaths(lastPaths, lookup)),
                affinity: stats ? (t) => stats.affinity?.(t) || 0 : undefined,
                liked: (t) => Boolean(app.isLiked?.(t)),
                novelty: hasStat ? (t) => (hasStat(t) ? 0 : 1.6) : undefined,
                random,
                playable,
                damp: damping.size ? (t) => damping.get(pathKey(t)) || 1 : undefined
            });
            mixCache = { key, list };
            if (list.length) {
                const nextPaths = new Array(list.length);
                for (let i = 0; i < list.length; i += 1) nextPaths[i] = pathKey(list[i]);
                const prevTop = storedSeen[0];
                let sameAsStored = Boolean(prevTop && prevTop.id === id && Array.isArray(prevTop.p)
                    && prevTop.p.length === nextPaths.length);
                if (sameAsStored) {
                    const prevP = prevTop.p;
                    for (let i = 0; i < nextPaths.length; i += 1) {
                        if (prevP[i] !== nextPaths[i]) { sameAsStored = false; break; }
                    }
                }
                if (!sameAsStored) writeSeen([{ id, p: nextPaths }, ...earlier].slice(0, SEEN_BATCHES));
            }
            return list;
        };
        // 换一批：今天的批号加一，目录和阵列重排
        app.dailyMix.reshuffle = () => {
            const n = readShuffle() + 1;
            try { storage?.setItem(SHUFFLE_KEY, JSON.stringify({ day: today(), n })); } catch (e) { /* 只是偏好 */ }
            mixCache = { key: '', list: [] };
            try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页还没起来 */ }
            try { doc?.dispatchEvent?.(new CustomEvent('music-daily-mix-change', { detail: { id: app.dailyMixKey() } })); } catch (e) { /* 旧内核 */ }
            const list = app.dailyMix();
            toast(list.length ? `每日推荐换了一批：${list.length} 首` : '曲库里没有能推荐的歌');
            return list;
        };
        // 还没听过的歌：随机一批（同一天不变），按歌手打散
        app.neverPlayed = ({ size = 30 } = {}) => {
            const stats = app.musicStats;
            const hasStat = stats ? (typeof stats.has === 'function' ? (t) => stats.has(t) : (t) => Boolean(stats.get(t))) : null;
            const src = app.playlist || [];
            const lib = [];
            for (let i = 0; i < src.length; i += 1) {
                const t = src[i];
                if (t && t.path && !(hasStat && hasStat(t))) lib.push(t);
            }
            const random = seeded('never|' + today());
            return pickSimilar(lib, [], { size, random, playable });
        };

        // ---- 每换一首检查：电台快放完就续；一组放到最后一首就接上相似的歌 ----
        const lastOf = (list, k) => list.slice(Math.max(0, k - 4), k + 1);
        const onTrack = () => {
            const list = app.currentFilteredTracks;
            const current = app.playlist?.[app.currentTrackIndex];
            const mode = app.playModes?.[app.currentPlayMode] || 'repeat';
            if (!Array.isArray(list) || !current) { if (!Array.isArray(list)) app.radio = null; return; }
            const at = list.indexOf(current);
            if (at < 0) return;
            if (app.radio && app.radio.list !== list) app.radio = null; // 换了别的上下文，电台结束
            if (app.radio) {
                if (list.length - 1 - at > REFILL_AT || mode === 'repeat-one') return;
                const more = pick(lastOf(list, at), recentSet(list));
                if (!more.length) return;
                const next = list.concat(more);
                app.radio.list = next;
                setContext(next);
                return;
            }
            if (!enabled || mode !== 'repeat' || at !== list.length - 1 || list.length < 1) return;
            if (app.playbackContext && app.playbackContext.autoplayed === list) return;
            const more = pick(lastOf(list, at), recentSet(list));
            if (!more.length) return;
            const before = list;
            const next = list.concat(more);
            setContext(next);
            if (app.playbackContext) app.playbackContext.autoplayed = next;
            toast('这一组放到最后一首了，接下来接着放相似的歌', {
                label: '不要接',
                run: () => {
                    app.autoplay.enabled = false;
                    if (app.currentFilteredTracks === next) setContext(before);
                    toast('已关闭自动续播：一组放完会回到开头');
                }
            });
        };
        const hooks = (global.MusicAppHooks || require('./music-app-hooks.js'));
        hooks.wrap(app, 'loadTrack', 'radio', (loadTrack) => async function (...args) {
            const result = await loadTrack.apply(this, args);
            try { onTrack(); } catch (e) { console.warn('[MusicRadio] continue failed:', e?.message || e); }
            return result;
        });

        // 无缝切歌时引擎自己进了下一首，播放器走的是 syncTrackIndexByPath，不经过 loadTrack
        hooks.wrap(app, 'syncTrackIndexByPath', 'radio', (syncByPath) => function (...args) {
            const result = syncByPath.apply(this, args);
            try { onTrack(); } catch (e) { console.warn('[MusicRadio] continue failed:', e?.message || e); }
            return result;
        });

        // 抽屉「声音」页里的开关
        const sw = doc?.getElementById?.('autoplay-switch');
        if (sw) {
            sw.checked = enabled;
            const onSwitchChange = () => { app.autoplay.enabled = sw.checked; };
            const onAutoplayChange = (e) => { sw.checked = Boolean(e.detail?.enabled); };
            sw.addEventListener('change', onSwitchChange);
            doc.addEventListener('music-autoplay-change', onAutoplayChange);
            global.addEventListener?.('beforeunload', () => {
                sw.removeEventListener('change', onSwitchChange);
                doc.removeEventListener('music-autoplay-change', onAutoplayChange);
            }, { once: true });
        }

        // ---- 右键菜单：从这首开电台 ----
        const menu = app.contextMenu;
        if (menu && doc && !menu.querySelector('[data-action="start-radio"]')) {
            const item = doc.createElement('div');
            item.className = 'context-menu-item';
            item.dataset.action = 'start-radio';
            item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z" fill="currentColor"/></svg><span>从这首开电台</span>';
            const anchor = menu.querySelector('[data-action="add-to-queue"]') || menu.querySelector('[data-action="toggle-like"]');
            if (anchor && anchor.parentNode === menu) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.remove('visible');
                app.startRadio(app.contextMenuTrackIndex);
            });
        }
    }

    const exported = { setupMusicRadio, pickSimilar, recordingKey, versionRank, isInstrumental, recentBatches, localDay };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicRadio = setupMusicRadio;
    global.MusicRadioUtils = exported; // 整理重复的歌（music-dupes.js）也用同一套「同一首」判断
})(typeof window !== 'undefined' ? window : globalThis);
