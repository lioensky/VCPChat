// Musicmodules/music-ui.js
// UI 辅助：背景切换、主题、MediaSession、WNP、音量、渲染列表

function setupUI(app) {
    let bgCurr = null;
    let bgNext = null;
    let bgResetRaf = 0;
    app.initBackgroundLayers = () => {
        if (!app.playerBackground) return;
        app.playerBackground.innerHTML = '<div class="bg-layer current"></div><div class="bg-layer next"></div>';
        bgCurr = app.playerBackground.firstElementChild;
        bgNext = bgCurr ? bgCurr.nextElementSibling : null;
    };

    app.updateBlurredBackground = (imageUrl) => {
        if (!app.playerBackground) return;
        if (!bgCurr || !bgNext || !bgCurr.isConnected || !bgNext.isConnected) {
            const layers = app.playerBackground.querySelectorAll('.bg-layer');
            if (layers.length < 2) {
                app.playerBackground.style.backgroundImage = imageUrl; return;
            }
            bgCurr = layers[0];
            bgNext = layers[1];
        }
        const curr = bgCurr;
        const next = bgNext;
        const newBg = imageUrl || 'none';
        if (curr.style.backgroundImage === newBg) return;

        const token = ++app.backgroundTransitionToken;
        if (app.backgroundTransitionTimer) {
            clearTimeout(app.backgroundTransitionTimer);
            app.backgroundTransitionTimer = null;
        }
        if (bgResetRaf && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(bgResetRaf);
            bgResetRaf = 0;
            curr.style.transition = '';
            next.style.transition = '';
        }
        const instant = Boolean(window.MusicMotion?.reduced?.()
            ?? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
            || (document.body.classList.contains('music-archive-on') && !document.body.classList.contains('music-stage-active'));
        app.playerBackground.classList.remove('switching');
        if (instant) {
            curr.style.backgroundImage = newBg;
            next.style.backgroundImage = 'none';
            return;
        }
        next.style.backgroundImage = newBg;
        app.playerBackground.classList.add('switching');

        app.backgroundTransitionTimer = setTimeout(() => {
            if (token !== app.backgroundTransitionToken) return;
            app.backgroundTransitionTimer = null;
            curr.style.transition = 'none'; next.style.transition = 'none';
            curr.style.backgroundImage = newBg; app.playerBackground.classList.remove('switching');
            bgResetRaf = requestAnimationFrame(() => {
                bgResetRaf = 0;
                if (token !== app.backgroundTransitionToken) return;
                curr.style.transition = ''; next.style.transition = '';
            });
        }, 800);
    };

    app.setupMediaSessionHandlers = () => {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.setActionHandler('play', () => app.playTrack());
        navigator.mediaSession.setActionHandler('pause', () => app.pauseTrack());
        navigator.mediaSession.setActionHandler('previoustrack', () => app.prevTrack());
        navigator.mediaSession.setActionHandler('nexttrack', () => app.nextTrack());
        app.phantomAudio.onplay = () => app.handlePhantomAudioEvent('play');
        app.phantomAudio.onpause = () => app.handlePhantomAudioEvent('pause');
    };

    app.updateMediaSessionMetadata = () => {
        if (!('mediaSession' in navigator) || app.playlist.length === 0 || !app.playlist[app.currentTrackIndex]) return;
        const t = app.playlist[app.currentTrackIndex];
        const art = t.albumArt ? app.fileUrl(t.albumArt) : '';
        navigator.mediaSession.metadata = new MediaMetadata({
            title: app.stripAudioExtension(t.title) || '未知标题', artist: t.artist || '未知艺术家',
            album: t.album || 'VCP Music Player', artwork: art ? [{ src: art }] : []
        });
        navigator.mediaSession.playbackState = app.isPlaying ? 'playing' : 'paused';
    };

    let lastVolBg = '';
    app.updateVolumeSliderBackground = (val) => {
        if (!app.volumeSlider) return;
        const next = `${val * 100}% 100%`;
        if (next === lastVolBg) return;
        lastVolBg = next;
        app.volumeSlider.style.backgroundSize = next;
    };

    // ───────── 经典列表：只画看得见的行 ─────────
    // 曲库上万首时把每首都建成一行 <li>，排序、搜索清空、删一首都要整表重建几万个节点（2 万首要几秒）。
    // 现在只建视口上下各 BUFFER 行；第一行的 margin-top 和最后一行的 margin-bottom 撑出其余行的高度，
    // 滚动条长度和位置都和整表一样。行号按在整个列表里的位置写在每行的 data-n 上。
    // 每行仍带 data-index（曲库里的下标），点击、右键、喜欢、高亮都照旧按它找歌。
    const BUFFER = 40;
    const FALLBACK_ROWS = 2 * BUFFER; // 还量不到视口和行高（隐藏、未排版）时先建这么多行
    let shownSongs = [];               // 当前列表要显示的全部歌，按显示顺序
    let positionOf = new Map();        // 歌 → 在 shownSongs 里的位置
    let libraryIndexOf = new Map();    // 歌 → 在曲库里的下标
    let renderedBase = null;
    let renderedBaseLength = -1;
    let renderedBaseFirst = null;
    let renderedBaseLast = null;
    let renderedTitles = null;
    let windowStart = 0;
    let windowEnd = 0;
    let rowPitch = 0;                  // 相邻两行的距离（行高 + 行间距）
    let cachedListHeight = 0;          // ResizeObserver 缓存的经典列表视口高度，避免排序/筛选时读取 clientHeight 强制重排
    app.classicShownSongs = () => shownSongs;

    const measurePitch = (list) => {
        const rows = list.children;
        if (rows.length >= 2) {
            const d = rows[1].offsetTop - rows[0].offsetTop;
            if (d > 0) rowPitch = d;
        } else if (rows.length === 1 && rows[0].offsetHeight > 0 && !rowPitch) {
            rowPitch = rows[0].offsetHeight;
        }
        return rowPitch;
    };
    const ROW_POOL_MAX = 160;
    const rowPool = [];
    const hydrateRow = (li, t) => {
        const titleText = app.stripAudioExtension(t.title) || '未知标题';
        const index = libraryIndexOf.has(t) ? libraryIndexOf.get(t) : -1;
        const indexStr = String(index);
        if (li.dataset.index !== indexStr) li.dataset.index = indexStr;
        const isActive = index === app.currentTrackIndex;
        if (li.classList.contains('active') !== isActive) li.classList.toggle('active', isActive);
        li._track = t;
        if (li._cl && typeof app.decorateClassicRow === 'function') {
            app.decorateClassicRow(li, true, titleText);
        } else {
            if (li.textContent !== titleText) li.textContent = titleText;
            app.decorateClassicRow?.(li, false, titleText);
        }
        return li;
    };
    // 按当前滚动位置算出要建的那一段，和已建的不一样才重建（留下的行原样复用，离开视口的行进池就地更新避免反复创建节点）。
    const renderWindow = (force = false, knownView, knownScrollTop) => {
        const list = app.playlistEl;
        if (!list) return;
        const total = shownSongs.length;
        const pitch = rowPitch;
        let view;
        if (knownView !== undefined) view = knownView;
        else if (cachedListHeight > 0) view = cachedListHeight;
        else {
            view = list.clientHeight;
            if (view > 0) cachedListHeight = view;
        }
        const scrollTop = knownScrollTop !== undefined ? knownScrollTop : list.scrollTop;
        let from = 0;
        let to = Math.min(total, FALLBACK_ROWS);
        if (pitch > 0 && view > 0) {
            from = Math.max(0, Math.floor(scrollTop / pitch) - BUFFER);
            to = Math.min(total, Math.ceil((scrollTop + view) / pitch) + BUFFER);
            if (from > to) from = Math.max(0, to - FALLBACK_ROWS);
        }
        if (!force && from === windowStart && to === windowEnd && list.children.length === to - from) return;
        const keep = new Map();
        const unused = [];
        for (const li of list.children) {
            const t = li._track;
            const idx = t && libraryIndexOf.has(t) ? libraryIndexOf.get(t) : -1;
            if (t && !keep.has(t) && li.dataset.index === String(idx)) keep.set(t, li);
            else unused.push(li);
        }
        const count = to - from;
        const rows = new Array(count);
        let keptCount = 0;
        for (let i = from; i < to; i += 1) {
            const t = shownSongs[i];
            const li = keep.get(t);
            if (li) {
                keep.delete(t);
                keptCount += 1;
                if (li.style.marginTop) li.style.marginTop = '';
                if (li.style.marginBottom) li.style.marginBottom = '';
                rows[i - from] = li;
            }
        }
        for (const li of keep.values()) unused.push(li);
        // FIFO 复用旧 DOM 行：排序/筛选无重叠曲目时保持原 DOM 节点顺序原地更新，零节点摘挂；
        // 有重叠曲目（增量滚动）时先摘除少数滑出视口的旧节点，让留下的行保持原地不动。
        let uHead = 0;
        const uLen = unused.length;
        for (let i = from; i < to; i += 1) {
            let li = rows[i - from];
            if (!li) {
                if (uHead < uLen) {
                    li = unused[uHead++];
                    if (keptCount > 0 && li.parentNode === list) li.remove();
                } else {
                    li = rowPool.length ? rowPool.pop() : document.createElement('li');
                }
                if (li.style.marginTop) li.style.marginTop = '';
                if (li.style.marginBottom) li.style.marginBottom = '';
                hydrateRow(li, shownSongs[i]);
                rows[i - from] = li;
            }
            // 行号写在行上（CSS 计数器在只建一段时会从 1 数起，而且 content-visibility 的样式隔离也会把它截断）
            const n = String(i + 1).padStart(2, '0');
            if (li.dataset.n !== n) { li.dataset.n = n; li.classList.toggle('n-long', n.length > 4); }
        }
        for (let u = uHead; u < uLen; u += 1) {
            const stale = unused[u];
            if (stale.parentNode === list) stale.remove();
            if (rowPool.length < ROW_POOL_MAX) {
                stale._track = null;
                rowPool.push(stale);
            }
        }
        // 原地对位补丁，避免 list.replaceChildren 整批摘下再重挂触发整表样式重算
        let cursor = list.firstElementChild;
        for (let k = 0; k < count; k += 1) {
            const want = rows[k];
            if (cursor === want) {
                cursor = cursor.nextElementSibling;
            } else {
                list.insertBefore(want, cursor);
            }
        }
        while (cursor) {
            const next = cursor.nextElementSibling;
            cursor.remove();
            cursor = next;
        }
        windowStart = from;
        windowEnd = to;
        if (!rowPitch) measurePitch(list);
        const p = rowPitch;
        // 第一次量到行高时按已读的 view/scrollTop 校准视口：若新范围落在已渲染前缀内直接裁尾复用，免去二次重建与强制回流
        if (!pitch && p > 0 && view > 0) {
            let nextFrom = Math.max(0, Math.floor(scrollTop / p) - BUFFER);
            const nextTo = Math.min(total, Math.ceil((scrollTop + view) / p) + BUFFER);
            if (nextFrom > nextTo) nextFrom = Math.max(0, nextTo - FALLBACK_ROWS);
            if (nextFrom === from && nextTo <= to) {
                for (let j = to - 1; j >= nextTo; j -= 1) {
                    const tail = rows[j - from];
                    tail.remove();
                    if (rowPool.length < ROW_POOL_MAX) { tail._track = null; rowPool.push(tail); }
                }
                rows.length = Math.max(0, nextTo - from);
                to = nextTo;
                windowEnd = to;
                if (rows.length) {
                    rows[0].style.marginTop = `${from * p}px`;
                    rows[rows.length - 1].style.marginBottom = `${(total - to) * p}px`;
                }
                return;
            }
            if (nextFrom !== from || nextTo !== to) {
                renderWindow(true, view, scrollTop);
                return;
            }
        }
        if (rows.length && p > 0) {
            rows[0].style.marginTop = `${from * p}px`;
            rows[rows.length - 1].style.marginBottom = `${(total - to) * p}px`;
        }
    };
    let windowQueued = 0;
    let windowQueuedIsRaf = false;
    let themeRaf1 = 0;
    let themeRaf2 = 0;
    const cancelWindowQueue = () => {
        if (!windowQueued) return;
        if (windowQueuedIsRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(windowQueued);
        else clearTimeout(windowQueued);
        windowQueued = 0;
        windowQueuedIsRaf = false;
    };
    const renderWindowSoon = () => {
        if (windowQueued || classicHidden()) return;
        const run = () => { windowQueued = 0; windowQueuedIsRaf = false; if (!classicHidden()) renderWindow(); };
        if (typeof requestAnimationFrame === 'function') {
            windowQueuedIsRaf = true;
            windowQueued = requestAnimationFrame(run);
        } else {
            windowQueuedIsRaf = false;
            windowQueued = setTimeout(run, 16) || 1;
        }
    };
    // 档案页开着时经典列表整个藏着：这时不重建（删一首歌、重扫、换排序都会走到这里），
    // 记下要画什么，切回经典视图再画。
    let deferred = null;
    const classicHidden = () => document.body.classList.contains('music-archive-on');
    app.classicPendingSongs = null;
    app.renderPlaylist = (filtered) => {
        if (classicHidden()) {
            deferred = { filtered };
            app.classicPendingSongs = filtered || app.playlist;
            app.updateAllCount();
            return;
        }
        deferred = null;
        app.classicPendingSongs = null;
        renderNow(filtered);
    };
    let listResizeObserver = null;
    const onListWindowResize = () => {
        cachedListHeight = 0;
        renderWindowSoon();
    };
    if (app.playlistEl) {
        app.playlistEl.addEventListener('scroll', renderWindowSoon, { passive: true });
        if (typeof ResizeObserver === 'function') {
            listResizeObserver = new ResizeObserver((entries) => {
                const rect = entries?.[entries.length - 1]?.contentRect;
                cachedListHeight = rect && rect.height > 0 ? rect.height : 0;
                renderWindowSoon();
            });
            listResizeObserver.observe(app.playlistEl);
        }
        if (typeof window !== 'undefined') window.addEventListener('resize', onListWindowResize);
    }
    let visibilityWatch = null;
    if (typeof MutationObserver === 'function') {
        // 合并成一个监听：仅在切回经典视图或列表显示状态变化时补画视口，忽略 body 上无关类名切换（如播放态）。
        let wasHidden = classicHidden();
        let wasListNone = Boolean(app.playlistEl && app.playlistEl.style.display === 'none');
        visibilityWatch = new MutationObserver(() => {
            const nowHidden = classicHidden();
            const nowListNone = Boolean(app.playlistEl && app.playlistEl.style.display === 'none');
            const unhidClassic = wasHidden && !nowHidden;
            const unhidList = wasListNone && !nowListNone;
            wasHidden = nowHidden;
            wasListNone = nowListNone;
            if (nowHidden) return;
            if (deferred) {
                const { filtered } = deferred;
                deferred = null;
                app.classicPendingSongs = null;
                // 走 app.renderPlaylist 让经典列表排序包装一步完成，避免先画未排序列表再在下一帧二次重排
                app.renderPlaylist(filtered);
                return;
            }
            if ((unhidClassic || unhidList) && app.playlistEl && !nowListNone) renderWindowSoon();
        });
        if (app.playlistEl) visibilityWatch.observe(app.playlistEl, { attributes: true, attributeFilter: ['style'] });
        visibilityWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', () => {
            visibilityWatch?.disconnect();
            visibilityWatch = null;
            listResizeObserver?.disconnect();
            listResizeObserver = null;
            cachedListHeight = 0;
            cancelWindowQueue();
            if (bgResetRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(bgResetRaf); bgResetRaf = 0; }
            if (themeRaf1 && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(themeRaf1); themeRaf1 = 0; }
            if (themeRaf2 && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(themeRaf2); themeRaf2 = 0; }
            if (app.backgroundTransitionTimer) { clearTimeout(app.backgroundTransitionTimer); app.backgroundTransitionTimer = null; }
            app.playlistEl?.removeEventListener('scroll', renderWindowSoon);
            window.removeEventListener('resize', onListWindowResize);
            rowPool.length = 0;
        }, { once: true });
    }
    // 列表空着时那句话（样式表里 #playlist:empty::after 显示它）：
    // 曲库本身是空的就告诉人去哪添加，别说「没有匹配」；搜不到才说没有匹配。
    const emptyText = (songs) => {
        if (songs.length) return null;
        if (!app.playlist.length) return '曲库里还没有歌曲，点上面的「本地」或「云端导入」添加，也可以把文件夹直接拖进窗口';
        if (String(app.searchInput?.value || '').trim()) return '没有匹配的曲目';
        return '这里还没有歌曲';
    };
    const renderNow = (filtered) => {
        const songs = filtered || app.playlist;
        const empty = emptyText(songs);
        // 先读取视口高度与滚动位置再改写 dataset.emptyText，避免 renderWindow(true) 写后即读触发强制同步布局
        let preView = cachedListHeight;
        if (!(preView > 0) && app.playlistEl) {
            preView = app.playlistEl.clientHeight;
            if (preView > 0) cachedListHeight = preView;
        }
        const preScrollTop = app.playlistEl ? app.playlistEl.scrollTop : 0;
        if (empty) {
            if (app.playlistEl.dataset.emptyText !== empty) app.playlistEl.dataset.emptyText = empty;
        } else if ('emptyText' in app.playlistEl.dataset) {
            delete app.playlistEl.dataset.emptyText;
        }
        const pl = app.playlist || [];
        const plLen = pl.length;
        const plFirst = plLen ? pl[0] : null;
        const plLast = plLen ? pl[plLen - 1] : null;
        const sameBase = renderedBase === app.playlist
            && renderedBaseLength === plLen
            && renderedBaseFirst === plFirst
            && renderedBaseLast === plLast;
        let unchanged = sameBase && shownSongs.length === songs.length;
        if (unchanged) {
            for (let i = 0; i < songs.length; i += 1) {
                if (shownSongs[i] !== songs[i] || renderedTitles[i] !== songs[i]?.title) {
                    unchanged = false;
                    break;
                }
            }
        }
        if (unchanged) {
            // 列表没变：单趟同步高亮
            const cur = app.currentTrackIndex;
            for (const li of app.playlistEl.children) {
                const isActive = Number(li.dataset.index) === cur;
                if (li.classList.contains('active') !== isActive) li.classList.toggle('active', isActive);
            }
            app.updateAllCount();
            return;
        }
        if (!sameBase || !libraryIndexOf.size) {
            libraryIndexOf = new Map();
            for (let i = 0; i < plLen; i += 1) {
                const t = pl[i];
                if (!libraryIndexOf.has(t)) libraryIndexOf.set(t, i);
            }
        }
        shownSongs = songs.slice();
        const nextTitles = new Array(shownSongs.length);
        if (songs === app.playlist) {
            positionOf = libraryIndexOf;
            for (let i = 0; i < shownSongs.length; i += 1) nextTitles[i] = shownSongs[i]?.title;
        } else {
            positionOf = new Map();
            for (let i = 0; i < shownSongs.length; i += 1) {
                const t = shownSongs[i];
                if (!positionOf.has(t)) positionOf.set(t, i);
                nextTitles[i] = t?.title;
            }
        }
        renderedBase = app.playlist;
        renderedBaseLength = plLen;
        renderedBaseFirst = plFirst;
        renderedBaseLast = plLast;
        renderedTitles = nextTitles;
        // 换了一组歌：已建的行按新下标重算，不能复用
        for (const li of app.playlistEl.children) li._track = null;
        renderWindow(true, preView, preScrollTop);
        app.updateAllCount();
    };

    app.scrollCurrentTrackToSidebarTop = () => {
        const playlist = app.playlistEl;
        if (!playlist || playlist.style.display === 'none' || classicHidden()) return false;
        const activeItem = playlist.querySelector('li.active');
        if (activeItem && Number(activeItem.dataset.index) === app.currentTrackIndex) {
            // Place the active row around 1/4 of the visible list instead of directly
            // against the top edge. Batch geometry reads before writing scrollTop and
            // forward known viewport/scrollTop to renderWindow to avoid back-to-back reflows.
            const playlistRect = playlist.getBoundingClientRect();
            const itemRect = activeItem.getBoundingClientRect();
            const viewH = cachedListHeight > 0 ? cachedListHeight : (playlist.clientHeight || playlistRect.height || 0);
            if (viewH > 0 && cachedListHeight <= 0) cachedListHeight = viewH;
            const curTop = playlist.scrollTop;
            const maxScrollTop = Math.max(0, playlist.scrollHeight - viewH);
            const desired = curTop + itemRect.top - playlistRect.top - viewH * 0.25;
            const nextTop = Math.min(maxScrollTop, Math.max(0, desired));
            if (nextTop !== curTop) playlist.scrollTop = nextTop;
            renderWindow(false, viewH, nextTop);
            return true;
        }
        // 正在放的那首不在已建的行里：按它在列表里的位置算出滚动量，再把那一段建出来
        const current = app.playlist[app.currentTrackIndex];
        const at = current ? positionOf.get(current) : undefined;
        if (at === undefined || !(rowPitch > 0)) return false;
        const viewH = cachedListHeight > 0 ? cachedListHeight : (playlist.clientHeight || playlist.getBoundingClientRect().height || 0);
        if (viewH > 0 && cachedListHeight <= 0) cachedListHeight = viewH;
        if (!(viewH > 0)) return false;
        const maxScrollTop = Math.max(0, playlist.scrollHeight - viewH);
        const nextTop = Math.min(maxScrollTop, Math.max(0, at * rowPitch - viewH * 0.25));
        if (playlist.scrollTop !== nextTop) playlist.scrollTop = nextTop;
        renderWindow(false, viewH, nextTop);
        return true;
    };

    app.createSilentAudio = () => {
        // The WAV only needs a known sample count for looped Media Session keepalive.
        // 8 kHz 16-bit mono × 10 s (~160 KB vs ~5.3 MB at 44.1 kHz × 60 s) cuts startup allocation time and heap footprint ~33x.
        if (app.silentAudioUrl) {
            try { URL.revokeObjectURL(app.silentAudioUrl); } catch (_) {}
            app.silentAudioUrl = null;
        }
        const sampleRate = 8000;
        const sampleCount = sampleRate * 10;
        const getWav = (length) => {
            const ds = length * 2, view = new DataView(new ArrayBuffer(44 + ds));
            let o = 0; const w = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(o++, s.charCodeAt(i)); };
            w('RIFF'); view.setUint32(o, 36 + ds, true); o += 4; w('WAVEfmt '); view.setUint32(o, 16, true); o += 4;
            view.setUint16(o, 1, true); o += 2; view.setUint16(o, 1, true); o += 2;
            view.setUint32(o, sampleRate, true); o += 4; view.setUint32(o, sampleRate * 2, true); o += 4;
            view.setUint16(o, 2, true); o += 2; view.setUint16(o, 16, true); o += 2;
            w('data'); view.setUint32(o, ds, true); o += 4;
            return view.buffer;
        };
        const url = URL.createObjectURL(new Blob([getWav(sampleCount)], { type: 'audio/wav' }));
        app.silentAudioUrl = url;
        return url;
    };

    const themeButton = document.getElementById('music-theme-toggle-btn');
    themeButton?.addEventListener('click', () => {
        app.applyTheme(document.body.classList.contains('light-theme') ? 'dark' : 'light');
    });
    app.applyTheme = (theme) => {
        const light = theme === 'light';
        app.currentTheme = theme;
        // 舞台用着自定义主题时，它的明/暗也跟着这次切换走（不然舞台和面板还停在原来那一版）
        app.stageHost?.followGlobalTheme?.(theme);
        document.body.classList.toggle('light-theme', light);
        if (themeButton) {
            const label = light ? '切换到深色' : '切换到浅色';
            themeButton.title = label;
            themeButton.setAttribute('aria-label', label);
        }
        // CSS variables are immediately readable after changing the theme class.
        // Notify the stage even while paused; no playback restart is necessary.
        app.stageHost?.updateTheme?.();
        if (themeRaf1 && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(themeRaf1); themeRaf1 = 0; }
        if (themeRaf2 && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(themeRaf2); themeRaf2 = 0; }
        if (typeof requestAnimationFrame === 'function') {
            themeRaf1 = requestAnimationFrame(() => {
                themeRaf1 = 0;
                themeRaf2 = requestAnimationFrame(() => {
                    themeRaf2 = 0;
                    const rgb = app.hexToRgb(getComputedStyle(document.body).getPropertyValue('--music-highlight'));
                    if (rgb) app.visualizerColor = rgb;
                    if (app.volumeSlider) app.updateVolumeSliderBackground(app.volumeSlider.value);
                });
            });
        }
        if (app.albumArt) {
            const curArt = app.albumArt.style.backgroundImage;
            if (!curArt || curArt.includes('musicdark.jpeg') || curArt.includes('musiclight.jpeg')) {
                const url = `url('../assets/${theme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
                app.albumArt.style.backgroundImage = url; app.updateBlurredBackground('none');
            }
        }
    };
}

class WebNowPlayingAdapter {
    constructor(app) {
        this.app = app;
        this.ws = null;
        this.reconnectTimer = null;
        this.reconnectDelay = 5000;
        this.lastSentPayload = '';
        this.destroyed = false;
        this.onVisible = null;
        this.connect();
    }
    clearVisibleWait() {
        if (this.onVisible && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.onVisible);
        }
        this.onVisible = null;
    }
    scheduleReconnect() {
        if (this.destroyed || this.reconnectTimer || this.onVisible) return;
        const delay = this.reconnectDelay;
        // 未安装桌面插件时逐次退避（5s → 60s），减少后台频繁探测本机端口与控制台报错
        this.reconnectDelay = Math.min(60000, Math.round(this.reconnectDelay * 2));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.destroyed) return;
            if (typeof document !== 'undefined' && document.hidden) {
                // 窗口隐藏时不再每分钟空转定时器，等重新可见后再连
                this.onVisible = () => {
                    if (document.hidden || this.destroyed) return;
                    this.clearVisibleWait();
                    this.connect();
                };
                document.addEventListener('visibilitychange', this.onVisible);
                return;
            }
            this.connect();
        }, delay);
    }
    connect() {
        if (this.destroyed) return;
        try {
            const socket = new WebSocket('ws://127.0.0.1:8974');
            this.ws = socket;
            socket.onopen = () => {
                if (this.destroyed || this.ws !== socket) {
                    socket.close();
                    return;
                }
                this.reconnectDelay = 5000;
                this.lastSentPayload = '';
                this.sendUpdate();
            };
            socket.onerror = () => socket.close();
            socket.onclose = () => {
                if (this.ws === socket) this.ws = null;
                this.scheduleReconnect();
            };
        } catch (e) {
            this.scheduleReconnect();
        }
    }
    sendUpdate() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const t = this.app.playlist[this.app.currentTrackIndex];
        const data = {
            player: 'VCP Music Player', state: !t ? 0 : (this.app.isPlaying ? 1 : 2),
            title: t ? this.app.stripAudioExtension(t.title) || '' : 'No Track Loaded', artist: t ? t.artist || '' : '',
            album: t ? t.album || '' : '', cover: t && t.albumArt ? this.app.fileUrl(t.albumArt) : '',
            duration: this.app.lastKnownDuration || 0, position: this.app.lastKnownCurrentTime || 0,
            volume: Math.round(parseFloat(this.app.volumeSlider?.value ?? 1) * 100),
            repeat: this.app.playModes[this.app.currentPlayMode] === 'repeat-one' ? 1 : (this.app.playModes[this.app.currentPlayMode] === 'repeat' ? 2 : 0),
            shuffle: this.app.playModes[this.app.currentPlayMode] === 'shuffle' ? 1 : 0
        };
        try {
            const payload = JSON.stringify(data);
            if (payload === this.lastSentPayload) return;
            this.lastSentPayload = payload;
            this.ws.send(payload);
        } catch (e) {}
    }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.clearVisibleWait();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const socket = this.ws;
        this.ws = null;
        if (socket) {
            socket.onopen = null;
            socket.onerror = null;
            socket.onclose = null;
            try { socket.close(); } catch (error) {}
        }
        this.app = null;
    }
}
