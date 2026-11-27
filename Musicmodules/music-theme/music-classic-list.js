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

        const titleOf = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t?.title || '') : (t?.title || '')) || '';
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

        let sortedCache = null;
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
            if (len > 32 && sortedCache && sortedCache.songs === songs && sortedCache.len === len
                && sortedCache.first === first && sortedCache.mid === mid && sortedCache.last === last
                && sortedCache.key === sort.key && sortedCache.dir === sort.dir
                && sortedCache.pl === pl && sortedCache.plLen === plLen) {
                return sortedCache.result;
            }
            if (sort.key === 'added') {
                const rev = songs.slice().reverse();
                if (len > 32) {
                    sortedCache = { songs, len, first, mid, last, key: sort.key, dir: sort.dir, pl, plLen, result: rev };
                }
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
            // 字符串键按唯一值预排名（尤其是按歌手排序时唯一键远少于曲目数），保留 Collator 精确并列秩后按整数比较
            if (!isNum && len > 32) {
                const uniq = new Set();
                for (let i = 0; i < len; i += 1) if (!decorated[i].empty) uniq.add(decorated[i].v);
                if (uniq.size > 0 && uniq.size * 2 < len) {
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
                    const dir = sort.dir;
                    decorated.sort((a, b) => {
                        if (a.empty !== b.empty) return a.empty ? 1 : -1;
                        const c = a.rank - b.rank;
                        return c ? c * dir : a.ord - b.ord;
                    });
                    const result = decorated.map((item) => item.t);
                    sortedCache = { songs, len, first, mid, last, key: sort.key, dir: sort.dir, pl, plLen, result };
                    return result;
                }
            }
            decorated.sort((a, b) => {
                // 没有这一项的（没写歌手、时长未知）总是排在最后
                if (a.empty !== b.empty) return a.empty ? 1 : -1;
                const c = isNum ? a.v - b.v : collator.compare(a.v, b.v);
                return c ? c * sort.dir : a.ord - b.ord;
            });
            const result = decorated.map((item) => item.t);
            if (len > 32) {
                sortedCache = { songs, len, first, mid, last, key: sort.key, dir: sort.dir, pl, plLen, result };
            }
            return result;
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

        // 每行拆成标题 / 歌手 / 时长三格。原渲染只在列表内容变化时重建 <li>，已拆过的行跳过。
        const decorateRow = (li) => {
            if (li.dataset.cols === '1') return;
            const track = app.playlist[Number(li.dataset.index)];
            const titleText = li.textContent || '';
            const title = document.createElement('span');
            title.className = 'cl-title';
            title.textContent = titleText;
            const artist = document.createElement('span');
            artist.className = 'cl-artist';
            artist.textContent = track?.artist || '';
            const duration = document.createElement('span');
            duration.className = 'cl-duration';
            duration.textContent = formatDuration(track?.duration);
            // 喜欢：一格小心形（和主流播放器的列表一样，喜欢过的常亮，其他的悬停才出现）
            const like = document.createElement('button');
            like.type = 'button';
            like.className = 'cl-like';
            like.tabIndex = -1;
            like.textContent = '♥';
            li._likeBtn = like;
            li.replaceChildren(title, artist, like, duration);
            paintLike(li, track);
            const mainTitle = titleText || titleOf(track);
            const artistText = track?.artist || '';
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
        let watch = null;
        if (typeof MutationObserver === 'function') {
            // 仅在经典列表由隐藏切换为显示，或隐藏期间发生过重绘/推迟排序时补拆，避免无关 body class 变动触发无谓布局读取
            watch = new MutationObserver(() => {
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
            sortedCache = null;
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
        const head = document.createElement('div');
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
                sortedCache = null;
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
        list.before(head);

        // 已经渲染过的列表补一次
        if (list.children.length) app.renderPlaylist(app.currentFilteredTracks || undefined);
    };

    global.MusicClassicList = { formatDuration };
})(window);
