// Musicmodules/music-sleep.js
// 定时关闭：主流播放器都有的「睡眠定时」。两种：
//   - 过 N 分钟后停：最后 10 秒把引擎音量慢慢收到 0，再暂停，然后把音量还回去（只动引擎，不动滑块和存盘的音量）
//   - 播完这首再停：这首快放完时暂停，不让无缝播放接进下一首
// 对外：app.sleepTimer.set(minutes)、.setTrackEnd()、.cancel()、.state()
// 变化时在 document 上发 `music-sleep-change`（detail 就是 state()），入口和倒计时由界面自己画。
// 没开定时的时候没有任何计时器在跑。

(function (global) {
    'use strict';

    const FADE_SECONDS = 10;
    const TRACK_END_MARGIN = 0.4; // 秒：离结尾这么近就停，赶在引擎无缝切歌之前

    function setupMusicSleep(app, { now = () => Date.now(), setTimer = (fn, ms) => global.setInterval(fn, ms), clearTimer = (id) => global.clearInterval(id) } = {}) {
        if (!app || app.sleepTimer) return null;
        let mode = 'off';
        let endsAt = 0;
        let timer = null;
        let fading = false;

        const sliderVolume = () => {
            const v = parseFloat(app.volumeSlider?.value);
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        };
        // 和音量滑块走同一条「只发最新值」的通道：渐弱的请求和还原音量的请求各走各的连接，
        // 先发的晚到时会把还原盖掉，取消定时后音量一直停在渐弱到的那一档。
        const engineVolume = (v) => {
            try {
                if (!app.api?.setMusicVolume) return;
                if (app.sendLatest) app.sendLatest('volume', () => app.api.setMusicVolume(v));
                else app.api.setMusicVolume(v);
            } catch (e) { /* 引擎没连上 */ }
        };
        const state = () => ({
            mode,
            endsAt: mode === 'time' ? endsAt : 0,
            remaining: mode === 'time' ? Math.max(0, Math.ceil((endsAt - now()) / 1000)) : 0
        });
        const announce = () => {
            try { global.document?.dispatchEvent?.(new CustomEvent('music-sleep-change', { detail: state() })); } catch (e) { /* 旧内核 */ }
        };
        const toast = (message, undo) => {
            try { global.MusicToast?.show?.({ message, action: undo ? { label: '撤销', run: undo } : undefined }); } catch (e) { /* 没有提示层 */ }
        };
        let unfadeTimer = null;
        const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
        const clearUnfadeTimer = () => { if (unfadeTimer !== null) { global.clearTimeout?.(unfadeTimer); unfadeTimer = null; } };
        const unfade = () => { clearUnfadeTimer(); if (fading) { fading = false; engineVolume(sliderVolume()); } };
        const finish = (message) => {
            stopTimer();
            mode = 'off';
            endsAt = 0;
            const wasFading = fading;
            Promise.resolve(app.isPlaying ? app.pauseTrack?.() : null).catch(() => {}).finally(() => {
                // 先停再把音量还回去，不然最后一下会突然响一声
                if (wasFading) {
                    clearUnfadeTimer();
                    unfadeTimer = global.setTimeout?.(() => { unfadeTimer = null; unfade(); }, 300) ?? null;
                } else unfade();
            });
            toast(message);
            announce();
        };
        const tick = () => {
            if (mode === 'time') {
                const left = (endsAt - now()) / 1000;
                if (left <= 0) { finish('定时关闭：已暂停播放'); return; }
                if (left <= FADE_SECONDS && app.isPlaying) {
                    fading = true;
                    engineVolume(sliderVolume() * Math.max(0, left / FADE_SECONDS));
                } else unfade();
                // 每整分钟报一次，界面上的倒计时够用了；最后一分钟每秒报
                if (left <= 60 || Math.ceil(left) % 60 === 0) announce();
            } else if (mode === 'track') {
                const duration = Number(app.lastKnownDuration) || 0;
                const played = typeof app.playedSeconds === 'function' ? app.playedSeconds() : Number(app.lastKnownCurrentTime) || 0;
                if (app.isPlaying && duration > 1 && played > 0 && duration - played <= TRACK_END_MARGIN) finish('定时关闭：这首放完了，已暂停');
            }
        };
        const start = (interval) => { stopTimer(); timer = setTimer(tick, interval); };

        const api = {
            state,
            set(minutes, { quiet = false } = {}) {
                const m = Number(minutes);
                if (!(m > 0)) { api.cancel({ quiet }); return state(); }
                const before = state();
                unfade();
                mode = 'time';
                endsAt = now() + m * 60000;
                start(1000);
                announce();
                if (!quiet) toast(`${Math.round(m)} 分钟后暂停播放`, () => restore(before));
                return state();
            },
            setTrackEnd({ quiet = false } = {}) {
                const before = state();
                unfade();
                mode = 'track';
                endsAt = 0;
                start(200);
                announce();
                if (!quiet) toast('这首放完后暂停', () => restore(before));
                return state();
            },
            cancel({ quiet = false } = {}) {
                if (mode === 'off') return state();
                const before = state();
                stopTimer();
                unfade();
                mode = 'off';
                endsAt = 0;
                announce();
                if (!quiet) toast('已关闭定时', () => restore(before));
                return state();
            }
        };
        const restore = (s) => {
            if (s.mode === 'time' && s.endsAt > now()) api.set((s.endsAt - now()) / 60000, { quiet: true });
            else if (s.mode === 'track') api.setTrackEnd({ quiet: true });
            else api.cancel({ quiet: true });
        };
        global.addEventListener?.('beforeunload', () => {
            stopTimer();
            unfade();
        }, { once: true });
        app.sleepTimer = api;
        return api;
    }

    global.setupMusicSleep = setupMusicSleep;
    if (typeof module !== 'undefined' && module.exports) module.exports = { setupMusicSleep };
})(typeof window !== 'undefined' ? window : globalThis);
