// Musicmodules/music-ui.js
// UI 辅助：背景切换、主题、MediaSession、WNP、音量、渲染列表

function setupUI(app) {
    app.initBackgroundLayers = () => {
        if (!app.playerBackground) return;
        app.playerBackground.innerHTML = '<div class="bg-layer current"></div><div class="bg-layer next"></div>';
    };

    app.updateBlurredBackground = (imageUrl) => {
        if (!app.playerBackground) return;
        const layers = app.playerBackground.querySelectorAll('.bg-layer');
        if (layers.length < 2) {
            app.playerBackground.style.backgroundImage = imageUrl; return;
        }
        const [curr, next] = layers;
        const newBg = imageUrl || 'none';
        if (curr.style.backgroundImage === newBg) return;

        const token = ++app.backgroundTransitionToken;
        if (app.backgroundTransitionTimer) {
            clearTimeout(app.backgroundTransitionTimer);
            app.backgroundTransitionTimer = null;
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
            requestAnimationFrame(() => { curr.style.transition = ''; next.style.transition = ''; });
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

    app.updateVolumeSliderBackground = (val) => {
        app.volumeSlider.style.backgroundSize = `${val * 100}% 100%`;
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
    let renderedTitles = null;
    let windowStart = 0;
    let windowEnd = 0;
    let rowPitch = 0;                  // 相邻两行的距离（行高 + 行间距）
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
    const makeRow = (t) => {
        const li = document.createElement('li');
        li.textContent = app.stripAudioExtension(t.title) || '未知标题';
        const index = libraryIndexOf.has(t) ? libraryIndexOf.get(t) : -1;
        li.dataset.index = index;
        if (index === app.currentTrackIndex) li.classList.add('active');
        app.decorateClassicRow?.(li);
        return li;
    };
    // 按当前滚动位置算出要建的那一段，和已建的不一样才重建（留下的行原样复用）。
    const renderWindow = (force = false) => {
        const list = app.playlistEl;
        if (!list) return;
        const total = shownSongs.length;
        const pitch = rowPitch;
        const view = list.clientHeight;
        let from = 0;
        let to = Math.min(total, FALLBACK_ROWS);
        if (pitch > 0 && view > 0) {
            from = Math.max(0, Math.floor(list.scrollTop / pitch) - BUFFER);
            to = Math.min(total, Math.ceil((list.scrollTop + view) / pitch) + BUFFER);
            if (from > to) from = Math.max(0, to - FALLBACK_ROWS);
        }
        if (!force && from === windowStart && to === windowEnd && list.children.length === to - from) return;
        const keep = new Map();
        for (const li of list.children) {
            const t = li._track;
            if (t && li.dataset.index === String(libraryIndexOf.has(t) ? libraryIndexOf.get(t) : -1)) keep.set(t, li);
        }
        const rows = [];
        for (let i = from; i < to; i += 1) {
            const t = shownSongs[i];
            let li = keep.get(t);
            if (li) {
                li.style.marginTop = '';
                li.style.marginBottom = '';
            } else {
                li = makeRow(t);
                li._track = t;
            }
            // 行号写在行上（CSS 计数器在只建一段时会从 1 数起，而且 content-visibility 的样式隔离也会把它截断）
            const n = String(i + 1).padStart(2, '0');
            if (li.dataset.n !== n) { li.dataset.n = n; li.classList.toggle('n-long', n.length > 4); }
            rows.push(li);
        }
        list.replaceChildren(...rows);
        windowStart = from;
        windowEnd = to;
        if (!rowPitch) measurePitch(list);
        const p = rowPitch;
        if (rows.length && p > 0) {
            rows[0].style.marginTop = `${from * p}px`;
            rows[rows.length - 1].style.marginBottom = `${(total - to) * p}px`;
        }

        // 第一次量到行高时补一遍（之前按估计的行数建的）
        if (!pitch && p > 0 && view > 0) renderWindow(true);
    };
    let windowQueued = 0;
    const renderWindowSoon = () => {
        if (windowQueued || classicHidden()) return;
        const run = () => { windowQueued = 0; if (!classicHidden()) renderWindow(); };
        windowQueued = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) || 1);
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
    if (app.playlistEl) {
        app.playlistEl.addEventListener('scroll', renderWindowSoon, { passive: true });
        if (typeof window !== 'undefined') window.addEventListener('resize', renderWindowSoon);
    }
    if (typeof MutationObserver === 'function') {
        // 合并成一个监听：切回经典视图时先刷延迟的列表，或者列表从隐藏变显示时补画视口。
        const visibilityWatch = new MutationObserver(() => {
            if (classicHidden()) return;
            if (deferred) {
                const { filtered } = deferred;
                deferred = null;
                app.classicPendingSongs = null;
                renderNow(filtered);
                return;
            }
            if (app.playlistEl && app.playlistEl.style.display !== 'none') renderWindowSoon();
        });
        if (app.playlistEl) visibilityWatch.observe(app.playlistEl, { attributes: true, attributeFilter: ['style'] });
        visibilityWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
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
        if (empty) app.playlistEl.dataset.emptyText = empty; else delete app.playlistEl.dataset.emptyText;
        const unchanged = renderedBase === app.playlist
            && renderedBaseLength === app.playlist.length
            && shownSongs.length === songs.length
            && songs.every((t, i) => shownSongs[i] === t && renderedTitles[i] === t.title);
        if (unchanged) {
            // 列表没变：只移动高亮
            for (const li of app.playlistEl.querySelectorAll('li.active')) li.classList.remove('active');
            for (const li of app.playlistEl.children) {
                if (Number(li.dataset.index) === app.currentTrackIndex) li.classList.add('active');
            }
            app.updateAllCount();
            return;
        }
        libraryIndexOf = new Map();
        app.playlist.forEach((t, i) => { if (!libraryIndexOf.has(t)) libraryIndexOf.set(t, i); });
        shownSongs = songs.slice();
        positionOf = new Map();
        shownSongs.forEach((t, i) => { if (!positionOf.has(t)) positionOf.set(t, i); });
        renderedBase = app.playlist;
        renderedBaseLength = app.playlist.length;
        renderedTitles = shownSongs.map(t => t.title);
        // 换了一组歌：已建的行按新下标重算，不能复用
        for (const li of app.playlistEl.children) li._track = null;
        renderWindow(true);
        app.updateAllCount();
    };

    app.scrollCurrentTrackToSidebarTop = () => {
        const playlist = app.playlistEl;
        if (!playlist || playlist.style.display === 'none') return false;
        const viewportHeight = () => playlist.clientHeight || playlist.getBoundingClientRect().height || 0;
        const place = (desiredScrollTop) => {
            const maxScrollTop = Math.max(0, playlist.scrollHeight - viewportHeight());
            playlist.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop));
        };

        const activeItem = playlist.querySelector('li.active');
        if (activeItem && Number(activeItem.dataset.index) === app.currentTrackIndex) {
            // Place the active row around 1/4 of the visible list instead of directly
            // against the top edge. This leaves tolerance for restored layout/rounded
            // panel clipping while preserving useful context above and below the track.
            const playlistRect = playlist.getBoundingClientRect();
            const itemRect = activeItem.getBoundingClientRect();
            place(playlist.scrollTop + itemRect.top - playlistRect.top - viewportHeight() * 0.25);
            renderWindow();
            return true;
        }
        // 正在放的那首不在已建的行里：按它在列表里的位置算出滚动量，再把那一段建出来
        const current = app.playlist[app.currentTrackIndex];
        const at = current ? positionOf.get(current) : undefined;
        if (at === undefined || !(rowPitch > 0) || !(viewportHeight() > 0)) return false;
        place(at * rowPitch - viewportHeight() * 0.25);
        renderWindow();
        return true;
    };

    app.createSilentAudio = () => {
        // The WAV only needs a known sample count. Creating an AudioContext here
        // left a native audio graph alive for the entire renderer lifetime.
        const sampleCount = 44100 * 60;
        const getWav = (length) => {
            const ds = length * 2, view = new DataView(new ArrayBuffer(44 + ds));
            let o = 0; const w = (s) => { for(let i=0;i<s.length;i++) view.setUint8(o++, s.charCodeAt(i)); };
            w('RIFF'); view.setUint32(o, 36+ds, true); o+=4; w('WAVEfmt '); view.setUint32(o, 16, true); o+=4;
            view.setUint16(o, 1, true); o+=2; view.setUint16(o, 1, true); o+=2;
            view.setUint32(o, 44100, true); o+=4; view.setUint32(o, 88200, true); o+=4;
            view.setUint16(o, 2, true); o+=2; view.setUint16(o, 16, true); o+=2;
            w('data'); view.setUint32(o, ds, true); o+=4;
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
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const rgb = app.hexToRgb(getComputedStyle(document.body).getPropertyValue('--music-highlight'));
            if (rgb) app.visualizerColor = rgb;
            if (app.volumeSlider) app.updateVolumeSliderBackground(app.volumeSlider.value);
        }));
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
        this.connect();
    }
    scheduleReconnect() {
        if (this.destroyed || this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        // 未安装桌面插件时逐次退避（5s → 60s），减少后台频繁探测本机端口与控制台报错
        this.reconnectDelay = Math.min(60000, Math.round(this.reconnectDelay * 2));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (typeof document !== 'undefined' && document.hidden) {
                this.scheduleReconnect();
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
            volume: Math.round(parseFloat(this.app.volumeSlider.value) * 100),
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
