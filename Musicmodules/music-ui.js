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
        if (app.backgroundTransitionTimer) clearTimeout(app.backgroundTransitionTimer);
        app.playerBackground.classList.remove('switching');
        next.style.backgroundImage = newBg;
        app.playerBackground.classList.add('switching');

        app.backgroundTransitionTimer = setTimeout(() => {
            if (token !== app.backgroundTransitionToken) return;
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
        app.phantomAudio.onplay = () => { if (!app.isPlaying && !app.isTrackLoading) app.playTrack(); };
        app.phantomAudio.onpause = () => { if (app.isPlaying && !app.isTrackLoading) app.pauseTrack(); };
    };

    app.updateMediaSessionMetadata = () => {
        if (!('mediaSession' in navigator) || app.playlist.length === 0 || !app.playlist[app.currentTrackIndex]) return;
        const t = app.playlist[app.currentTrackIndex];
        const art = t.albumArt ? `file://${t.albumArt.replace(/\\/g, '/')}` : '';
        navigator.mediaSession.metadata = new MediaMetadata({
            title: t.title || '未知标题', artist: t.artist || '未知艺术家',
            album: t.album || 'VCP Music Player', artwork: art ? [{ src: art }] : []
        });
        navigator.mediaSession.playbackState = app.isPlaying ? 'playing' : 'paused';
    };

    app.updateVolumeSliderBackground = (val) => {
        app.volumeSlider.style.backgroundSize = `${val * 100}% 100%`;
    };

    app.renderPlaylist = (filtered) => {
        const songs = filtered || app.playlist;
        app.playlistEl.innerHTML = '';
        const frag = document.createDocumentFragment();
        songs.forEach(t => {
            const li = document.createElement('li'); li.textContent = t.title || '未知标题';
            const origIdx = app.playlist.indexOf(t); li.dataset.index = origIdx;
            if (origIdx === app.currentTrackIndex) li.classList.add('active');
            frag.appendChild(li);
        });
        app.playlistEl.appendChild(frag); app.updateAllCount();
    };

    app.createSilentAudio = () => {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = ctx.createBuffer(1, 44100 * 60, 44100);
        const getWav = (b) => {
            const ds = b.length * 2, view = new DataView(new ArrayBuffer(44 + ds));
            let o = 0; const w = (s) => { for(let i=0;i<s.length;i++) view.setUint8(o++, s.charCodeAt(i)); };
            w('RIFF'); view.setUint32(o, 36+ds, true); o+=4; w('WAVEfmt '); view.setUint32(o, 16, true); o+=4;
            view.setUint16(o, 1, true); o+=2; view.setUint16(o, 1, true); o+=2;
            view.setUint32(o, 44100, true); o+=4; view.setUint32(o, 88200, true); o+=4;
            view.setUint16(o, 2, true); o+=2; view.setUint16(o, 16, true); o+=2;
            w('data'); view.setUint32(o, ds, true); o+=4;
            return view.buffer;
        };
        return URL.createObjectURL(new Blob([getWav(buf)], { type: 'audio/wav' }));
    };

    app.applyTheme = (theme) => {
        app.currentTheme = theme; document.body.classList.toggle('light-theme', theme === 'light');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const rgb = app.hexToRgb(getComputedStyle(document.body).getPropertyValue('--music-highlight'));
            if (rgb) app.visualizerColor = rgb;
            app.updateVolumeSliderBackground(app.volumeSlider.value);
        }));
        const curArt = app.albumArt.style.backgroundImage;
        if (!curArt || curArt.includes('musicdark.jpeg') || curArt.includes('musiclight.jpeg')) {
            const url = `url('../assets/${theme === 'light' ? 'musiclight.jpeg' : 'musicdark.jpeg'}')`;
            app.albumArt.style.backgroundImage = url; app.updateBlurredBackground(url);
        }
    };
}

class WebNowPlayingAdapter {
    constructor(app) {
        this.app = app; this.ws = null; this.connect();
    }
    connect() {
        try {
            this.ws = new WebSocket('ws://127.0.0.1:8974');
            this.ws.onopen = () => this.sendUpdate();
            this.ws.onerror = () => { this.ws = null; };
            this.ws.onclose = () => { this.ws = null; setTimeout(() => this.connect(), 5000); };
        } catch (e) { setTimeout(() => this.connect(), 5000); }
    }
    sendUpdate() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const t = this.app.playlist[this.app.currentTrackIndex];
        const data = {
            player: 'VCP Music Player', state: !t ? 0 : (this.app.isPlaying ? 1 : 2),
            title: t ? t.title || '' : 'No Track Loaded', artist: t ? t.artist || '' : '',
            album: t ? t.album || '' : '', cover: t && t.albumArt ? 'file://' + t.albumArt.replace(/\\/g, '/') : '',
            duration: this.app.lastKnownDuration || 0, position: this.app.lastKnownCurrentTime || 0,
            volume: Math.round(parseFloat(this.app.volumeSlider.value) * 100),
            repeat: this.app.playModes[this.app.currentPlayMode] === 'repeat-one' ? 1 : (this.app.playModes[this.app.currentPlayMode] === 'repeat' ? 2 : 0),
            shuffle: this.app.playModes[this.app.currentPlayMode] === 'shuffle' ? 1 : 0
        };
        try { this.ws.send(JSON.stringify(data)); } catch (e) {}
    }
}
