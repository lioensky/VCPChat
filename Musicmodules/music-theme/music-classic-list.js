// 经典视图的曲目列表：标题、歌手、时长三列，表头可以按标题 / 歌手 / 时长 / 添加时间（行号那一格的 #）排序。
// 只包一层 app.renderPlaylist：排好序再交给原来的渲染，渲染完给每行补上歌手和时长。
// 排序只改变显示顺序，不改曲库本身的顺序。
(function (global) {
    'use strict';

    const SORT_KEY = 'musicClassicSort';
    const COLUMNS = [
        { key: 'title', label: '标题', hint: '按标题排序' },
        { key: 'artist', label: '歌手', hint: '按歌手排序' },
        { key: 'duration', label: '时长', hint: '按时长排序' },
        { key: 'added', label: '#', hint: '按添加时间排序' }
    ];

    const formatDuration = (seconds) => {
        const s = Number(seconds);
        if (!(s > 0) || !Number.isFinite(s)) return '';
        const total = Math.round(s);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = String(total % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    };

    const collator = typeof Intl !== 'undefined' && Intl.Collator
        ? new Intl.Collator(['zh-Hans-CN', 'ja', 'en'], { numeric: true, sensitivity: 'base' })
        : { compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };

    global.setupMusicClassicList = (app) => {
        const list = app.playlistEl || document.getElementById('playlist');
        if (!list || typeof app.renderPlaylist !== 'function') return;

        let sort = { key: 'added', dir: 1 };
        try {
            const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
            if (saved && COLUMNS.some((c) => c.key === saved.key)) sort = { key: saved.key, dir: saved.dir === -1 ? -1 : 1 };
        } catch (e) { /* 用默认顺序 */ }

        const strippedTitles = new WeakMap();
        const titleOf = (t) => {
            if (!t || typeof t !== 'object') return '';
            const raw = t.title || '';
            const cached = strippedTitles.get(t);
            if (cached && cached.raw === raw) return cached.clean;
            const clean = (app.stripAudioExtension ? app.stripAudioExtension(raw) : raw) || '';
            strippedTitles.set(t, { raw, clean });
            return clean;
        };
        const value = {
            title: (t) => titleOf(t),
            artist: (t) => String(t?.artist || ''),
            duration: (t) => Number(t?.duration) || 0
        };

        let orderCacheList = null;
        let orderCacheLen = -1;
        let orderCacheFirst = null;
        let orderCacheLast = null;
        let orderCacheMap = null;
        const getOrderMap = () => {
            const pl = app.playlist || [];
            const len = pl.length;
            const first = len ? pl[0] : null;
            const last = len ? pl[len - 1] : null;
            if (orderCacheMap && orderCacheList === app.playlist && orderCacheLen === len
                && orderCacheFirst === first && orderCacheLast === last) {
                return orderCacheMap;
            }
            const map = new Map();
            for (let i = 0; i < len; i += 1) map.set(pl[i], i);
            orderCacheList = app.playlist;
            orderCacheLen = len;
            orderCacheFirst = first;
            orderCacheLast = last;
            orderCacheMap = map;
            return map;
        };

        // 按同组曲目与列键缓存正/倒序结果：从正序按并列秩分段反排即可 O(N) 得到倒序（保留空项垫底与并列稳定顺序），不再重跑 Collator。
        const reverseByRanks = (nonEmpty, ranks, empty) => {
            const out = new Array(nonEmpty.length + empty.length);
            let w = 0;
            let hi = nonEmpty.length - 1;
            while (hi >= 0) {
                const r = ranks[hi];
                let lo = hi;
                while (lo > 0 && ranks[lo - 1] === r) lo -= 1;
                for (let i = lo; i <= hi; i += 1) out[w++] = nonEmpty[i];
                hi = lo - 1;
            }
            for (let i = 0; i < empty.length; i += 1) out[w++] = empty[i];
            return out;
        };
        const ensureRanks = (entry) => {
            if (entry.ranks) return entry.ranks;
            const neLen = entry.nonEmpty.length;
            const ranks = new Int32Array(neLen);
            let curRank = 0;
            if (entry.usedRank) {
                const rk = entry.rankKeys;
                for (let i = 1; i < neLen; i += 1) {
                    if (rk[i] !== rk[i - 1]) curRank += 1;
                    ranks[i] = curRank;
                }
            } else {
                const vals = entry.vals;
                const isNum = entry.isNum;
                for (let i = 1; i < neLen; i += 1) {
                    const prev = vals[i - 1];
                    const curr = vals[i];
                    const diff = isNum ? (curr !== prev) : (curr !== prev && collator.compare(prev, curr) !== 0);
                    if (diff) curRank += 1;
                    ranks[i] = curRank;
                }
            }
            entry.ranks = ranks;
            entry.vals = null;
            entry.rankKeys = null;
            return ranks;
        };
        let sortCache = null;
        const sorted = (songs) => {
            if (sort.key === 'added' && sort.dir === 1) {
                // 添加时间正序就是进曲库的先后，原样返回。
                return null;
            }
            const len = songs.length;
            const first = len ? songs[0] : null;
            const mid = len ? songs[len >> 1] : null;
            const last = len ? songs[len - 1] : null;
            const pl = app.playlist;
            const plLen = Array.isArray(pl) ? pl.length : -1;
            let bucket = null;
            if (len > 32) {
                if (!sortCache || sortCache.songs !== songs || sortCache.len !== len
                    || sortCache.first !== first || sortCache.mid !== mid || sortCache.last !== last
                    || sortCache.pl !== pl || sortCache.plLen !== plLen) {
                    sortCache = { songs, len, first, mid, last, pl, plLen, byKey: new Map() };
                }
                bucket = sortCache.byKey.get(sort.key) || null;
                if (bucket) {
                    if (sort.dir === 1 && bucket.asc) return bucket.asc;
                    if (sort.dir === -1 && bucket.desc) return bucket.desc;
                    if (sort.dir === -1 && bucket.nonEmpty) {
                        bucket.desc = reverseByRanks(bucket.nonEmpty, ensureRanks(bucket), bucket.empty);
                        return bucket.desc;
                    }
                }
            }
            if (sort.key === 'added') {
                const rev = songs.slice().reverse();
                if (len > 32) sortCache.byKey.set('added', { desc: rev });
                return rev;
            }
            const get = value[sort.key];
            const isFull = songs === pl;
            const order = isFull ? null : getOrderMap();
            const isNum = sort.key === 'duration';
            // 预先提取一次排序键，避免 O(N log N) 次重复正则去扩展名与属性访问
            const decorated = songs.map((t, i) => {
                const v = get(t);
                return { t, v, empty: v === '' || v === 0, ord: isFull ? i : (order.get(t) ?? 0), rank: 0 };
            });
            // 始终先按正序排并按需懒算并列秩，同源下再点表头切倒序直接 O(N) 翻转并列段
            let usedRank = false;
            if (!isNum && len > 32) {
                const uniq = new Set();
                const uniqLimit = (len - 1) >> 1;
                let tooMany = false;
                for (let i = 0; i < len; i += 1) {
                    if (!decorated[i].empty) {
                        uniq.add(decorated[i].v);
                        if (uniq.size > uniqLimit) { tooMany = true; break; }
                    }
                }
                if (!tooMany && uniq.size > 0) {
                    const keys = Array.from(uniq);
                    keys.sort(collator.compare);
                    const rankMap = new Map();
                    let r = 0;
                    rankMap.set(keys[0], 0);
                    for (let i = 1; i < keys.length; i += 1) {
                        if (collator.compare(keys[i - 1], keys[i]) !== 0) r = i;
                        rankMap.set(keys[i], r);
                    }
                    for (let i = 0; i < len; i += 1) {
                        const d = decorated[i];
                        if (!d.empty) d.rank = rankMap.get(d.v);
                    }
                    usedRank = true;
                }
            }
            decorated.sort((a, b) => {
                // 没有这一项的（没写歌手、时长未知）总是排在最后
                if (a.empty !== b.empty) return a.empty ? 1 : -1;
                const c = usedRank ? a.rank - b.rank : (isNum ? a.v - b.v : collator.compare(a.v, b.v));
                return c || (a.ord - b.ord);
            });
            const nonEmpty = [];
            const empty = [];
            const vals = usedRank ? null : [];
            const rankKeys = usedRank ? [] : null;
            const asc = new Array(len);
            for (let i = 0; i < len; i += 1) {
                const d = decorated[i];
                asc[i] = d.t;
                if (d.empty) empty.push(d.t);
                else {
                    nonEmpty.push(d.t);
                    if (usedRank) rankKeys.push(d.rank);
                    else vals.push(d.v);
                }
            }
            const entry = { asc, desc: null, nonEmpty, empty, vals, rankKeys, usedRank, isNum, ranks: null };
            if (len > 32) {
                sortCache.byKey.set(sort.key, entry);
                if (sort.dir === -1) {
                    entry.desc = reverseByRanks(nonEmpty, ensureRanks(entry), empty);
                    return entry.desc;
                }
                return asc;
            }
            return sort.dir === -1 ? reverseByRanks(nonEmpty, ensureRanks(entry), empty) : asc;
        };

        const paintLike = (li, track) => {
            const button = li._likeBtn || li.querySelector('.cl-like');
            if (!button) return;
            const on = typeof app.isLiked === 'function' && app.isLiked(track);
            const pressed = String(on);
            if (button._likeState === pressed) return;
            button._likeState = pressed;
            li.classList.toggle('is-liked', on);
            button.setAttribute('aria-pressed', pressed);
            const label = on ? '取消喜欢' : '喜欢';
            button.setAttribute('aria-label', label);
            button.title = label;
        };
        // 点心形只切换喜欢，不触发这一行的播放
        const onLikeClick = (e) => {
            const button = e.target.closest?.('.cl-like');
            if (!button || typeof app.toggleLike !== 'function') return;
            e.stopPropagation();
            e.preventDefault();
            const li = button.closest('li');
            const track = li && app.playlist[Number(li.dataset.index)];
            if (track) app.toggleLike(track);
        };
        const onLikeDblClick = (e) => { if (e.target.closest?.('.cl-like')) { e.stopPropagation(); e.preventDefault(); } };
        list.addEventListener('click', onLikeClick, true);
        list.addEventListener('dblclick', onLikeDblClick, true);
        const onLikeChange = (event) => {
            const changed = Array.isArray(event?.detail?.tracks) && event.detail.tracks.length
                ? new Set(event.detail.tracks.map((t) => t && t.path).filter(Boolean))
                : null;
            for (const li of list.children) {
                if (li.dataset.cols !== '1') continue;
                const track = app.playlist[Number(li.dataset.index)];
                if (changed && (!track || !changed.has(track.path))) continue;
                paintLike(li, track);
            }
        };
        document.addEventListener('music-like-change', onLikeChange);

        // 预构四列模板碎片：批量建行时 cloneNode(true) 并预填未喜欢态，省去每行四次 createElement 与三次 setAttribute
        let colProto = null;
        const getColProto = () => {
            if (colProto) return colProto;
            const frag = document.createDocumentFragment();
            const title = document.createElement('span');
            title.className = 'cl-title';
            const artist = document.createElement('span');
            artist.className = 'cl-artist';
            const like = document.createElement('button');
            like.type = 'button';
            like.className = 'cl-like';
            like.tabIndex = -1;
            like.textContent = '♥';
            like.setAttribute('aria-pressed', 'false');
            like.setAttribute('aria-label', '喜欢');
            like.title = '喜欢';
            const duration = document.createElement('span');
            duration.className = 'cl-duration';
            frag.append(title, artist, like, duration);
            colProto = frag;
            return colProto;
        };

        // 每行拆成标题 / 歌手 / 时长三格。原渲染只在列表内容变化时重建 <li>，已拆过的行在虚拟列表复用时就地更新字段避免重复建节点。
        const decorateRow = (li, update = false, preTitle) => {
            const track = app.playlist[Number(li.dataset.index)];
            if (li.dataset.cols === '1') {
                if (!update || !li._cl) return;
                const titleText = preTitle !== undefined ? preTitle : (titleOf(track) || '未知标题');
                const artistText = track?.artist || '';
                const durText = formatDuration(track?.duration);
                const c = li._cl;
                if (c.title.textContent !== titleText) c.title.textContent = titleText;
                if (c.artist.textContent !== artistText) c.artist.textContent = artistText;
                if (c.duration.textContent !== durText) c.duration.textContent = durText;
                paintLike(li, track);
                const mainTitle = titleText || titleOf(track);
                const tip = mainTitle && artistText ? `${mainTitle} — ${artistText}` : (mainTitle || artistText);
                if (li.title !== tip) li.title = tip;
                return;
            }
            const titleText = preTitle !== undefined ? preTitle : (li.textContent || '');
            const artistText = track?.artist || '';
            const frag = getColProto().cloneNode(true);
            const title = frag.childNodes[0];
            const artist = frag.childNodes[1];
            const like = frag.childNodes[2];
            const duration = frag.childNodes[3];
            title.textContent = titleText;
            artist.textContent = artistText;
            duration.textContent = formatDuration(track?.duration);
            like._likeState = 'false';
            li._likeBtn = like;
            li._cl = { title, artist, like, duration };
            li.replaceChildren(frag);
            paintLike(li, track);
            const mainTitle = titleText || titleOf(track);
            li.title = mainTitle && artistText ? `${mainTitle} — ${artistText}` : (mainTitle || artistText);
            li.dataset.cols = '1';
        };

        // 列表只建看得见的行时（music-ui 的虚拟列表），每建一行就当场拆好
        app.decorateClassicRow = decorateRow;

        // 曲库大的时候全部拆一遍要几百毫秒，所以：
        // 列表没显示（在档案页，或者切到专辑 / 歌手分页）时不拆，等它显示出来；
        // 显示时只拆视口上下各 BUFFER 行，滚到哪拆到哪。
        const BUFFER = 30;
        const shown = () => !document.body.classList.contains('music-archive-on') && list.style.display !== 'none';
        const decorate = () => {
            const rows = list.children;
            const count = rows.length;
            if (!count || !shown()) return;
            // 虚拟列表建行时已逐行拆完：纯 JS 快速扫描全部可见节点，已全拆则直接返回，避免无谓读取 offsetTop/clientHeight 触发强制布局
            let anyUndecorated = false;
            for (let i = 0; i < count; i += 1) {
                if (rows[i].dataset.cols !== '1') { anyUndecorated = true; break; }
            }
            if (!anyUndecorated) return;
            const pitch = count > 1 ? rows[1].offsetTop - rows[0].offsetTop : rows[0].offsetHeight;
            const view = list.clientHeight;
            let from = 0;
            let to = count;
            // 量不到行高（还没排版）就整列处理，保证内容是对的
            if (pitch > 0 && view > 0) {
                from = Math.max(0, Math.floor(list.scrollTop / pitch) - BUFFER);
                to = Math.min(count, Math.ceil((list.scrollTop + view) / pitch) + BUFFER);
            }
            for (let i = from; i < to; i += 1) decorateRow(rows[i]);
        };

        let queued = 0;
        let lastFiltered = null;
        let deferredSort = false;
        let wasShown = shown();
        let needsSync = !wasShown;
        const decorateSoon = () => {
            if (queued || !shown()) return;
            queued = requestAnimationFrame(() => {
                queued = 0;
                if (!shown()) return;
                needsSync = false;
                if (deferredSort) {
                    deferredSort = false;
                    app.renderPlaylist(lastFiltered || undefined);
                    return;
                }
                decorate();
            });
        };
        list.addEventListener('scroll', decorateSoon, { passive: true });
        global.addEventListener('resize', decorateSoon);
        let head = null;
        const syncHeadHidden = () => {
            if (!head) return;
            const hide = list.style.display === 'none';
            if (head.hidden !== hide) head.hidden = hide;
        };
        let watch = null;
        if (typeof MutationObserver === 'function') {
            // 仅在经典列表由隐藏切换为显示，或隐藏期间发生过重绘/推迟排序时补拆，避免无关 body class 变动触发无谓布局读取
            watch = new MutationObserver(() => {
                syncHeadHidden();
                const nowShown = shown();
                if (nowShown && (!wasShown || needsSync || deferredSort)) decorateSoon();
                wasShown = nowShown;
            });
            watch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            watch.observe(list, { attributes: true, attributeFilter: ['style'] });
        }
        global.addEventListener?.('beforeunload', () => {
            if (queued) { cancelAnimationFrame(queued); queued = 0; }
            list.removeEventListener('scroll', decorateSoon);
            list.removeEventListener('click', onLikeClick, true);
            list.removeEventListener('dblclick', onLikeDblClick, true);
            global.removeEventListener('resize', decorateSoon);
            document.removeEventListener('music-like-change', onLikeChange);
            watch?.disconnect();
            watch = null;
            orderCacheList = orderCacheFirst = orderCacheLast = orderCacheMap = null;
            sortCache = null;
        }, { once: true });

        global.MusicAppHooks.wrap(app, 'renderPlaylist', 'classic-list', (base) => (filtered) => {
            lastFiltered = filtered || null;
            const songs = filtered || app.playlist;
            // 列表未显示（例如处于档案页或切到其他分页）时跳过分列，非默认排序一并推迟到切回经典列表
            if (!shown()) {
                wasShown = false;
                needsSync = true;
                if (sort.key !== 'added' || sort.dir !== 1) deferredSort = true;
                return base(filtered);
            }
            wasShown = true;
            needsSync = false;
            deferredSort = false;
            const result = base(sorted(songs) || filtered);
            decorate();
            return result;
        });

        // 表头
        head = document.createElement('div');
        head.className = 'music-list-head';
        head.setAttribute('role', 'toolbar');
        head.setAttribute('aria-label', '排序');
        const buttons = COLUMNS.map((col) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `music-list-sort is-${col.key}`;
            button.dataset.sort = col.key;
            button.title = col.hint;
            button.setAttribute('aria-label', col.hint);
            button.innerHTML = `<span>${col.label}</span><i aria-hidden="true"></i>`;
            button.addEventListener('click', () => {
                sort = sort.key === col.key ? { key: col.key, dir: -sort.dir } : { key: col.key, dir: 1 };
                try { localStorage.setItem(SORT_KEY, JSON.stringify(sort)); } catch (e) { /* 只是记住排序 */ }
                syncHead();
                app.renderPlaylist(lastFiltered || undefined);
            });
            head.appendChild(button);
            return { button, arrow: button.querySelector('i') };
        });
        const syncHead = () => {
            for (const { button, arrow } of buttons) {
                const on = button.dataset.sort === sort.key;
                button.classList.toggle('is-on', on);
                button.setAttribute('aria-pressed', String(on));
                const nextArrow = on ? (sort.dir === 1 ? '↑' : '↓') : '';
                if (arrow && arrow.textContent !== nextArrow) arrow.textContent = nextArrow;
            }
        };
        syncHead();
        syncHeadHidden();
        list.before(head);

        // 已经渲染过的列表补一次
        if (list.children.length) app.renderPlaylist(app.currentFilteredTracks || undefined);
    };

    global.MusicClassicList = { formatDuration };
})(window);
