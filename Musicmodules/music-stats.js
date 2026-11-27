// Musicmodules/music-stats.js
// 听歌记录：每首歌听了几次、上次什么时候听、跳过几次、第一次听是哪天。存在本机（localStorage），不上传。
// 「最常听」「很久没听」、自动续播挑歌、首页「接着听」都从这里取数。
//
// 怎么算「听了一次」（和 Last.fm 的规则一样）：实际在放的时间到了这首的一半，或者满 4 分钟；
// 不知道时长时按 60 秒。没到 30 秒（也没到一半）就换了别的歌，算跳过一次。
// 只在播放时计时：暂停、加载时不走。单曲循环每重新开始一遍算新的一遍。
//
// 对外：app.musicStats.get(track|path) → { plays, skips, last, first } | null
//       app.musicStats.top(n) → [path]（按次数，次数一样按最近）
//       app.musicStats.forgotten({ minPlays, days, limit }) → [path]（以前常听、很久没碰的）
//       app.musicStats.lastPlayed(n) → [path]
//       app.musicStats.resume() → { track, position, at } | null（上次没听完的那首，首页「接着听」）
//       app.musicStats.summary({ days }) → 听歌统计页用：总秒数、次数、活跃天数、24 小时分布、按次数排的歌、daily（日期 → 秒）
//         （days 为 0 或不填 = 全部；按天的流水从这一版开始记，之前的只有总次数）
// 变化时在 document 上发 `music-stats-change`（detail: { path }）。

(function (global) {
    'use strict';

    const KEY = 'musicPlayStats';
    const SKIP_BEFORE = 30;      // 秒
    const MAX_FULL = 240;        // 满 4 分钟一定算一次
    const UNKNOWN_LEN = 60;      // 不知道时长时听满 60 秒算一次
    const DAY = 86400000;

    const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const playedEnough = (sec, duration) => {
        const d = Number(duration);
        const need = d > 0 ? Math.min(MAX_FULL, Math.max(d / 2, Math.min(d, SKIP_BEFORE))) : UNKNOWN_LEN;
        return sec >= need;
    };

    function setupMusicStats(app, {
        now = () => Date.now(),
        storage = (() => { try { return global.localStorage; } catch (e) { return null; } })(),
        setTimer = (fn, ms) => global.setInterval(fn, ms),
        clearTimer = (id) => global.clearInterval(id),
        observe = true
    } = {}) {
        if (!app || app.musicStats) return app && app.musicStats;

        // 存成 { v: 1, t: { 路径(小写、正斜杠): [次数, 上次时间, 跳过, 第一次时间, 原路径] } }，紧凑一些，两万首也不大
        let table = {};
        try {
            const raw = JSON.parse(storage?.getItem(KEY) || 'null');
            if (raw && raw.v === 1 && raw.t && typeof raw.t === 'object') table = raw.t;
        } catch (e) { table = {}; }
        // 接着听：上次没听完的那一首（路径、位置、时间），和次数表分开存
        const RESUME_KEY = 'musicPlayResume';
        let resume = null;
        try {
            const raw = JSON.parse(storage?.getItem(RESUME_KEY) || 'null');
            if (raw && typeof raw.path === 'string') resume = raw;
        } catch (e) { resume = null; }
        // 按天的流水：{ v: 1, d: { 'YYYY-MM-DD'(本地日期): { s: [24 个小时各听了几秒], p: { 路径键: 次数 } } } }，只留最近 400 天
        const LOG_KEY = 'musicListenLog';
        const KEEP_DAYS = 400;
        let log = {};
        try {
            const raw = JSON.parse(storage?.getItem(LOG_KEY) || 'null');
            if (raw && raw.v === 1 && raw.d && typeof raw.d === 'object') log = raw.d;
        } catch (e) { log = {}; }
        // 缓存当前小时窗口对应的本地日期与小时号，播放时每秒 tick 免去重复构造 Date 和拼串（跨小时自动重算，兼顾夏令时）
        let cachedHourStart = -1;
        let cachedHourEnd = -1;
        let cachedHourDayKey = '';
        let cachedHourNum = 0;
        const dayAndHour = (t) => {
            if (t >= cachedHourStart && t < cachedHourEnd) return { k: cachedHourDayKey, h: cachedHourNum };
            const d = new Date(t);
            const h = d.getHours();
            cachedHourDayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            cachedHourNum = h;
            cachedHourStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0, 0, 0).getTime();
            cachedHourEnd = cachedHourStart + 3600000;
            return { k: cachedHourDayKey, h: cachedHourNum };
        };
        const dayKey = (t) => dayAndHour(t).k;
        const dayOfKey = (k) => {
            if (!log[k]) {
                log[k] = { s: new Array(24).fill(0), p: {} };
                const keys = Object.keys(log).sort();
                for (let i = 0; i < keys.length - KEEP_DAYS; i++) delete log[keys[i]];
            }
            return log[k];
        };
        const dayOf = (t) => dayOfKey(dayKey(t));
        let resumeSaved = 0;
        const setResume = (next, force = false) => {
            const changed = (resume && resume.path) !== (next && next.path);
            resume = next;
            const t = now();
            if (!force && !changed && t - resumeSaved < 5000) return;
            resumeSaved = t;
            try { if (resume) storage?.setItem(RESUME_KEY, JSON.stringify(resume)); else storage?.removeItem?.(RESUME_KEY); } catch (e) { /* 只是方便 */ }
            if (changed) announce(next ? next.path : null);
        };
        let saveTimer = null;
        const save = () => {
            if (saveTimer !== null) return;
            saveTimer = global.setTimeout(() => {
                saveTimer = null;
                try { storage?.setItem(KEY, JSON.stringify({ v: 1, t: table })); } catch (e) { /* 存不下也不影响播放 */ }
                try { storage?.setItem(LOG_KEY, JSON.stringify({ v: 1, d: log })); } catch (e) { /* 同上 */ }
            }, 1500);
        };
        const announce = (path) => {
            try { global.document?.dispatchEvent?.(new CustomEvent('music-stats-change', { detail: { path } })); } catch (e) { /* 旧内核 */ }
        };
        const entry = (path) => {
            const k = normPath(path);
            if (!k) return null;
            if (!table[k]) table[k] = [0, 0, 0, 0, String(path)];
            return table[k];
        };
        const bump = (path, kind) => {
            const e = entry(path);
            if (!e) return;
            const t = now();
            if (kind === 'play') {
                e[0]++; e[1] = t; if (!e[3]) e[3] = t;
                const day = dayOf(t);
                const k = normPath(path);
                day.p[k] = (day.p[k] || 0) + 1;
            }
            else e[2]++;
            save();
            announce(path);
        };

        // ---- 一遍一遍地记 ----
        let session = null; // { path, listened, counted, lastTick, lastPos }
        let unsaved = 0;
        const currentTrack = () => {
            return Array.isArray(app.playlist) ? app.playlist[app.currentTrackIndex] || null : null;
        };
        const duration = () => Number(app.lastKnownDuration) || Number(currentTrack()?.duration) || 0;
        const position = () => { try { return Number(app.playedSeconds?.()) || 0; } catch (e) { return 0; } };
        const close = () => {
            if (!session) return;
            if (!session.counted && session.listened > 0.2 && session.listened < SKIP_BEFORE && !session.ended) bump(session.path, 'skip');
            session = null;
        };
        const tick = () => {
            const t = currentTrack();
            const path = t && t.path;
            const playing = app.isPlaying === true && !app.isTrackLoading;
            const at = now();
            if (!path) { close(); return; }
            if (session && session.path !== path) close();
            if (!session) session = { path, listened: 0, counted: false, lastTick: at, lastPos: position() };
            const pos = position();
            const d = duration();
            // 单曲循环：同一首又从头开始了，上一遍结束、新的一遍开始
            if (session.counted && pos + 5 < session.lastPos && pos < 5) {
                session = { path, listened: 0, counted: false, lastTick: at, lastPos: pos };
            }
            if (playing) {
                const step = Math.min(5, Math.max(0, (at - session.lastTick) / 1000));
                session.listened += step;
                if (step > 0) {
                    const dh = dayAndHour(at);
                    const day = dayOfKey(dh.k);
                    day.s[dh.h] += step;
                    unsaved += step;
                    if (unsaved >= 30) { unsaved = 0; save(); } // 听歌时长每半分钟存一次
                }
            }
            session.lastTick = at;
            session.lastPos = pos;
            if (d > 0 && pos >= d - 1.5) session.ended = true; // 放到结尾自然切走的不算跳过
            if (!session.counted && playedEnough(session.listened, d)) { session.counted = true; bump(path, 'play'); }
            // 听了 10 秒以上、离结尾还有 10 秒以上：记成「接着听」；放完了就清掉
            if (session.ended) { if (resume && resume.path === path) setResume(null); }
            else if (playing && pos >= 10 && (!(d > 0) || pos < d - 10)) setResume({ path, position: Math.floor(pos), at });
        };

        // 只在播放时开计时器（每秒一次）；暂停后停掉，空闲时没有任何计时器
        let timer = null;
        const sync = () => {
            const playing = app.isPlaying === true;
            if (playing && timer === null) { tick(); timer = setTimer(tick, 1000); }
            else if (!playing && timer !== null) { tick(); clearTimer(timer); timer = null; }
            else tick();
        };
        if (observe && global.MutationObserver && global.document?.body) {
            // 播放状态切换时 body 上的 music-playing 会变；切歌时也会经过这里
            let was = global.document.body.classList.contains('music-playing');
            new global.MutationObserver(() => {
                const is = global.document.body.classList.contains('music-playing');
                if (is !== was) { was = is; sync(); }
            }).observe(global.document.body, { attributes: true, attributeFilter: ['class'] });
            global.document.addEventListener?.('music-queue-change', () => tick());
        }

        // ---- 查询 ----
        const all = () => Object.values(table).filter((e) => e[0] > 0);
        const api = {
            get(input) {
                const e = table[normPath(input && typeof input === 'object' ? input.path : input)];
                return e ? { plays: e[0], last: e[1], skips: e[2], first: e[3] } : null;
            },
            top(n = 30, { minPlays = 2 } = {}) {
                return all().filter((e) => e[0] >= minPlays).sort((a, b) => b[0] - a[0] || b[1] - a[1]).slice(0, n).map((e) => e[4]);
            },
            lastPlayed(n = 30) {
                return all().sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[4]);
            },
            forgotten({ minPlays = 3, days = 30, limit = 30 } = {}) {
                const before = now() - days * DAY;
                return all().filter((e) => e[0] >= minPlays && e[1] && e[1] < before)
                    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, limit).map((e) => e[4]);
            },
            // 一首歌的「常听程度」0..1，自动续播挑歌时用来加权（跳过多的往后放）
            affinity(input) {
                const s = api.get(input);
                if (!s) return 0;
                const score = Math.log2(1 + s.plays) - 0.6 * Math.log2(1 + s.skips);
                return Math.max(0, Math.min(1, score / 5));
            },
            // 首页「接着听」：{ track, position, at } 或 null（那首歌已不在曲库里也返回 null）
            resume() {
                if (!resume) return null;
                const k = normPath(resume.path);
                const track = (app.playlist || []).find((t) => normPath(t && t.path) === k);
                return track ? { track, position: resume.position, at: resume.at } : null;
            },
            summary({ days = 0 } = {}) {
                const hours = new Array(24).fill(0);
                const plays = new Map();
                let seconds = 0;
                let activeDays = 0;
                let count = 0;
                const daily = {}; // 每天听了几秒（听歌日历用）
                const from = days > 0 ? dayKey(now() - (days - 1) * DAY) : '';
                for (const [k, day] of Object.entries(log)) {
                    if (from && k < from) continue;
                    let daySeconds = 0;
                    (day.s || []).forEach((v, h) => { hours[h] += v; daySeconds += v; });
                    seconds += daySeconds;
                    if (daySeconds > 0) daily[k] = Math.round(daySeconds);
                    let dayPlays = 0;
                    for (const [p, n] of Object.entries(day.p || {})) { plays.set(p, (plays.get(p) || 0) + n); dayPlays += n; }
                    count += dayPlays;
                    if (daySeconds >= 60 || dayPlays > 0) activeDays++;
                }
                // 「全部」时次数用总表（流水是这一版才开始记的，总表更全）
                if (!(days > 0)) {
                    plays.clear();
                    count = 0;
                    for (const [k, e] of Object.entries(table)) if (e[0] > 0) { plays.set(k, e[0]); count += e[0]; }
                }
                const tracks = [...plays.entries()]
                    .map(([k, n]) => ({ path: table[k] ? table[k][4] : k, plays: n, last: table[k] ? table[k][1] : 0 }))
                    .sort((a, b) => b.plays - a.plays || b.last - a.last);
                const firstDay = Object.keys(log).sort()[0] || '';
                return { seconds: Math.round(seconds), plays: count, activeDays, hours: hours.map(Math.round), tracks, since: firstDay, daily };
            },
            tick,
            sync,
            flush() {
                if (saveTimer !== null) { global.clearTimeout(saveTimer); saveTimer = null; }
                try { storage?.setItem(KEY, JSON.stringify({ v: 1, t: table })); } catch (e) { /* 同上 */ }
                try { storage?.setItem(LOG_KEY, JSON.stringify({ v: 1, d: log })); } catch (e) { /* 同上 */ }
                if (resume) setResume(resume, true);
            }
        };
        app.musicStats = api;
        global.addEventListener?.('beforeunload', () => api.flush());
        sync();
        return api;
    }

    const exported = { setupMusicStats, playedEnough, normPath };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicStats = setupMusicStats;
})(typeof window !== 'undefined' ? window : globalThis);
