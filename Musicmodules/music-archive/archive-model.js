/*
 * 曲目档案阵列的数据层：把播放器的曲库和歌单整理成「列」。
 * 一列 = 一个歌单（第一列是全部曲目，之后是自建歌单，再之后是专辑），
 * 一张卡 = 一首歌。这里不碰 DOM 和 WebGL，方便在 node 里测试。
 */
(function (global) {
    'use strict';

    const BSLASH_RE = /\\/g;
    const AUDIO_EXT_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i;
    const NON_ASCII_RE = /[^\x00-\x7f]/;
    const NON_PRINT_RE = /[^\x20-\x7e]/g;
    const WS_RE = /\s+/g;

    const wrap = (value, size) => (size > 0 ? ((value % size) + size) % size : 0);

    const normalizePath = (value) => {
        const s = String(value || '');
        return (s.indexOf('\\') >= 0 ? s.replace(BSLASH_RE, '/') : s).toLowerCase();
    };

    const stripExtension = (title) => {
        const s = String(title || '');
        const dot = s.lastIndexOf('.');
        return dot >= 0 && s.length - dot <= 5 ? s.replace(AUDIO_EXT_RE, '') : s;
    };

    const LOCALE_CMP = typeof Intl !== 'undefined' ? new Intl.Collator().compare : (a, b) => a.localeCompare(b);

    const asciiRef = (name, fallback) => {
        const raw = String(name || '');
        const norm = NON_ASCII_RE.test(raw) ? raw.normalize('NFKD') : raw;
        const ascii = norm.replace(NON_PRINT_RE, '').replace(WS_RE, ' ').trim().toUpperCase();
        return ascii.length >= 2 ? ascii.slice(0, 28) : fallback;
    };

    /*
     * 把播放器状态整理成列。tracks 是 app.playlist（全局曲库，下标就是 loadTrack 用的下标），
     * playlists 是 app.customPlaylists（{ id, name, tracks: [path] }）。
     * 专辑列只收两首以上的专辑，按曲目数从多到少，最多 maxAlbums 列。
     */
    const pathIndex = (list) => {
        const map = new Map();
        if (!Array.isArray(list)) return map;
        for (let index = 0; index < list.length; index += 1) {
            const track = list[index];
            const key = normalizePath(track && track.path);
            if (key && !map.has(key)) map.set(key, index);
        }
        return map;
    };
    const buildColumns = (tracks, playlists, options = {}) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const maxAlbums = Number.isFinite(options.maxAlbums) ? options.maxAlbums : 24;
        // 路径 → 曲库下标。调用方已经有这张表时（options.indexByPath）直接用，大曲库省一遍
        const indexByPath = options.indexByPath || pathIndex(list);

        const allItems = new Array(list.length);
        for (let index = 0; index < list.length; index += 1) allItems[index] = index;
        const columns = [{
            id: 'all',
            kind: 'all',
            name: '全部曲目',
            ref: 'ALL FILES',
            items: allItems
        }];

        const plList = Array.isArray(playlists) ? playlists : [];
        for (let order = 0; order < plList.length; order += 1) {
            const playlist = plList[order];
            if (!playlist) continue;
            const items = [];
            const plTracks = playlist.tracks || [];
            for (let j = 0; j < plTracks.length; j += 1) {
                const index = indexByPath.get(normalizePath(plTracks[j]));
                if (index !== undefined) items.push(index);
            }
            columns.push({
                id: 'playlist:' + (playlist.id ?? order),
                kind: 'playlist',
                playlistId: playlist.id,
                name: String(playlist.name || '未命名歌单'),
                ref: asciiRef(playlist.name, 'PLAYLIST ' + String(order + 1).padStart(2, '0')),
                items
            });
        }

        if (maxAlbums > 0) {
            const albums = new Map();
            for (let index = 0; index < list.length; index += 1) {
                const track = list[index];
                const name = track && track.album ? String(track.album).trim() : '';
                if (!name) continue;
                let bucket = albums.get(name);
                if (!bucket) { bucket = []; albums.set(name, bucket); }
                bucket.push(index);
            }
            const multiAlbums = [];
            for (const entry of albums) {
                if (entry[1].length >= 2) multiAlbums.push(entry);
            }
            multiAlbums.sort((a, b) => b[1].length - a[1].length || LOCALE_CMP(a[0], b[0]));
            const trackOrder = global.MusicTrackOrder || null;
            const cap = Math.min(maxAlbums, multiAlbums.length);
            for (let order = 0; order < cap; order += 1) {
                const name = multiAlbums[order][0];
                const items = multiAlbums[order][1];
                if (trackOrder) {
                    let anyNumbered = false;
                    for (let j = 0; j < items.length; j += 1) {
                        const ord = trackOrder.numberOf(list[items[j]]);
                        if (ord.no > 0 || ord.disc > 0) { anyNumbered = true; break; }
                    }
                    if (anyNumbered) items.sort(trackOrder.albumCompare(list, (a, b) => a - b));
                }
                columns.push({
                    id: 'album:' + name,
                    kind: 'album',
                    name,
                    ref: asciiRef(name, 'ALBUM ' + String(order + 1).padStart(2, '0')),
                    items
                });
            }
        }
        return columns;
    };

    /* 普通搜索：标题、歌手、专辑包含关键字（不分大小写），返回曲库下标。 */
    const search = (tracks, query) => {
        const q = String(query || '').trim().toLowerCase();
        if (!q || !Array.isArray(tracks) || !tracks.length) return [];
        const out = [];
        const multiLine = q.includes('\n');
        for (let index = 0; index < tracks.length; index += 1) {
            const track = tracks[index];
            if (!track) continue;
            if (multiLine) {
                const hay = (stripExtension(track.title) + '\n' + (track.artist || '') + '\n' + (track.album || '')).toLowerCase();
                if (hay.includes(q)) out.push(index);
            } else if (
                (track.title && stripExtension(track.title).toLowerCase().includes(q)) ||
                (track.artist && String(track.artist).toLowerCase().includes(q)) ||
                (track.album && String(track.album).toLowerCase().includes(q))
            ) {
                out.push(index);
            }
        }
        return out;
    };

    const searchColumn = (tracks, query) => ({
        id: 'search',
        kind: 'search',
        name: '检索：' + String(query || '').trim(),
        ref: 'SEARCH RESULT',
        items: search(tracks, query)
    });

    /* 档案号：曲库里的序号，至少三位。 */
    const fileCode = (index) => String(index + 1).padStart(3, '0');

    /* 某一格（列、行可以越界，阵列是循环的）对应的曲库下标；空列返回 -1。 */
    const cellTrack = (columns, lane, row) => {
        if (!columns || !columns.length) return -1;
        const column = columns[wrap(lane, columns.length)];
        if (!column.items.length) return -1;
        return column.items[wrap(row, column.items.length)];
    };

    /* 找曲库下标 index 所在的位置，优先 preferLane 那一列。 */
    const locate = (columns, index, preferLane = 0) => {
        if (!columns || !columns.length || index < 0) return null;
        const order = [wrap(preferLane, columns.length)];
        for (let i = 0; i < columns.length; i++) if (i !== order[0]) order.push(i);
        for (const lane of order) {
            const col = columns[lane];
            if (col.kind === 'all' && col.items[index] === index) return { lane, row: index };
            const row = col.items.indexOf(index);
            if (row !== -1) return { lane, row };
        }
        return null;
    };

    /* 键盘方向 → 选中格的变化。阵列在两个方向都循环。 */
    const KEY_STEPS = Object.freeze({
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        PageUp: [0, -10], PageDown: [0, 10]
    });

    const step = (selection, key) => {
        const delta = KEY_STEPS[key];
        if (!delta) return null;
        return { lane: selection.lane + delta[0], row: selection.row + delta[1] };
    };

    /* 滚轮累计：超过阈值走一格，返回走的格数（带符号）并保留余量。 */
    const createWheel = (threshold = 60) => {
        let acc = 0;
        let lastAt = 0;
        return (deltaY, now = 0) => {
            if (now - lastAt > 400) acc = 0;
            lastAt = now;
            acc += deltaY;
            const steps = Math.trunc(acc / threshold);
            if (steps) acc -= steps * threshold;
            return Math.max(-6, Math.min(6, steps));
        };
    };

    /*
     * 这一下滚动是不是鼠标滚轮的一格（而不是触控板的连续小增量）。
     * 按行/按页的滚动一定是一格；按像素的，一格在 Chromium 里是 100 像素再除以系统缩放，
     * 缩放 125%、150% 时是 80、66.67 这种小数，乘回缩放比才是整数。只看整数会把这类一格当成触控板，
     * 累计余量偶尔一下走两张，也没有连拨的惯性。
     */
    const isWheelNotch = (e, dpr = 1) => {
        if (e.deltaMode !== 0) return true;
        const y = Math.abs(e.deltaY);
        if (Math.abs(e.deltaX) >= 1 || y < 50) return false;
        if (Number.isInteger(y)) return true;
        const scaled = y * (dpr || 1);
        return Math.abs(scaled - Math.round(scaled)) < 0.02;
    };

    /*
     * 滚轮惯性：快速连续滚动松手后再滑一段，越快滑得越远，按指数衰减停下。
     * push(格数, 秒) 记下每次滚动走的格数；滚轮停了调 release(秒)；之后每帧 tick(秒) 返回这一帧该再走几格。
     * 触控板自带的惯性尾巴速度很低，不会再叠一段。
     */
    const createInertia = ({ tau = 0.22, minSpeed = 8, window = 0.16, maxSpeed = 70 } = {}) => {
        let samples = [];
        let v = 0, pos = 0, last = 0, gliding = false;
        return {
            push(rows, t) {
                gliding = false; v = 0; pos = 0;
                samples.push([t, rows]);
                let drop = 0;
                while (drop < samples.length && t - samples[drop][0] > window) drop += 1;
                if (drop > 0) samples.splice(0, drop);
            },
            release(t) {
                if (!samples.length) return false;
                const total = samples.reduce((sum, sample) => sum + sample[1], 0);
                const span = Math.max(0.06, t - samples[0][0]);
                samples = [];
                const speed = total / span;
                if (Math.abs(speed) < minSpeed) return false;
                v = Math.max(-maxSpeed, Math.min(maxSpeed, speed));
                pos = 0; last = t; gliding = true;
                return true;
            },
            tick(t) {
                if (!gliding) return 0;
                const dt = Math.max(0, Math.min(0.05, t - last));
                last = t;
                v *= Math.exp(-dt / tau);
                pos += v * dt;
                const n = Math.trunc(pos);
                pos -= n;
                if (Math.abs(v) < minSpeed / 3) gliding = false;
                return n;
            },
            stop() { gliding = false; samples = []; },
            get active() { return gliding; }
        };
    };

    /* 拖动/点击位置条：横向比例 → 列里第几首 */
    const rowAtFraction = (fraction, count) => (count > 0 ? Math.round(Math.max(0, Math.min(1, fraction)) * (count - 1)) : 0);

    /* 两次 build 之间列结构有没有变（决定要不要重建 HUD 和保持选中） */
    const signature = (columns) => columns.map((c) => c.id + ':' + c.items.length).join('|');

    const api = Object.freeze({
        wrap, normalizePath, pathIndex, stripExtension, buildColumns, search, searchColumn,
        fileCode, cellTrack, locate, step, createWheel, isWheelNotch, createInertia, rowAtFraction, signature
    });

    if (typeof module === 'object' && module.exports) module.exports = api;
    global.MusicArchiveModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
