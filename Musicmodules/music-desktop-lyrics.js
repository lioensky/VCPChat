// Musicmodules/music-desktop-lyrics.js
// 桌面歌词（音乐窗口这一侧）：开着的时候，把正在唱的一行、下一行、逐字时间和播放进度送给桌面上的歌词条。
// 只在换行、换歌、播放/暂停、拖动进度时送，平时每 3 秒补一次对时；歌词条自己按进度往前走。
// 关着时没有任何计时器。
//
// 对外：app.desktopLyrics = { on, toggle(on?) }；状态变了在 document 上发 `music-desktop-lyrics-change`（detail: { on }）。
//       MusicDesktopLyrics.snapshot(app, t) → 要送出去的那一份（测试用）

(function (global) {
    'use strict';

    const POLL_MS = 250;
    const RESYNC_MS = 3000;

    const textOf = (line) => {
        const raw = line && (line.text || line.original || line.fullText);
        if (!raw) return '';
        return typeof raw === 'string' ? raw.trim() : String(raw).trim();
    };
    const lineAt = (lines, t) => {
        let lo = 0, hi = lines.length - 1, at = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((Number(lines[mid].time) || 0) <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return at;
    };
    const wordsCache = new WeakMap();
    const wordsOf = (line) => {
        if (!line || typeof line !== 'object') return null;
        const check = global.MusicArchiveLyrics && global.MusicArchiveLyrics.wordsOf;
        if (!check) return null;
        const raw = line.words;
        const len = Array.isArray(raw) ? raw.length : -1;
        const cached = wordsCache.get(line);
        if (cached && cached.check === check && cached.raw === raw && cached.len === len) return cached.packed;
        const words = check(line);
        let packed = null;
        if (words) {
            const wLen = words.length;
            packed = new Array(wLen);
            for (let i = 0; i < wLen; i += 1) {
                const w = words[i];
                packed[i] = { text: w.text, s: Number(w.startTime), e: Number(w.endTime) };
            }
        }
        wordsCache.set(line, { check, raw, len, packed });
        return packed;
    };
    const pack = (line, showTr = true) => {
        if (!line) return null;
        let tr = '';
        if (showTr && line.translation) {
            const rawTr = line.translation;
            tr = typeof rawTr === 'string' ? rawTr.trim() : String(rawTr).trim();
        }
        return { text: textOf(line), tr, time: Number(line.time) || 0 };
    };
    const position = (app) => {
        const base = Number(app.lastKnownCurrentTime) || 0;
        if (!app.isPlaying || !app.lastStateUpdateTime) return base;
        return base + Math.max(0, Date.now() - app.lastStateUpdateTime) / 1000;
    };

    // 按原数组引用与长度缓存过滤后的有效歌词行，避免每 250ms 轮询都重新过滤整首歌
    let cachedLyricsSrc = null;
    let cachedLyricsLen = -1;
    let cachedLyricsLines = [];
    const filteredLines = (all) => {
        if (all === cachedLyricsSrc && all.length === cachedLyricsLen) return cachedLyricsLines;
        cachedLyricsSrc = all;
        cachedLyricsLen = all.length;
        const out = [];
        for (let i = 0; i < all.length; i += 1) {
            if (textOf(all[i])) out.push(all[i]);
        }
        cachedLyricsLines = out;
        return out;
    };

    // 唱到第几行、这一行和下一行（空行跳过，间奏时显示下一句）
    function snapshot(app, t = position(app)) {
        const track = Array.isArray(app.playlist) ? app.playlist[app.currentTrackIndex] : null;
        const all = Array.isArray(app.currentLyrics) ? app.currentLyrics : [];
        const lines = filteredLines(all);
        const k = lineAt(lines, t);
        const line = k >= 0 ? lines[k] : null;
        const nextLine = lines[k + 1] || null;
        // 这一行已经唱完、下一行还早（间奏）：不再亮着上一句
        const end = line && line.words && line.words.length ? Number(line.words[line.words.length - 1].endTime) : null;
        const resting = Boolean(line && nextLine && Number.isFinite(end) && t > end + 2 && (Number(nextLine.time) || 0) - t > 4);
        const showTr = app.lyricsTranslation !== false;
        const cur = line && !resting ? { ...pack(line, showTr), words: wordsOf(line) } : null;
        return {
            path: track ? track.path : null,
            title: track ? String(track.title || '') : '',
            artist: track ? String(track.artist || '') : '',
            playing: Boolean(app.isPlaying),
            position: t,
            at: Date.now(),
            hasLyrics: lines.length > 0,
            index: resting ? -1 : k,
            line: cur,
            next: pack(nextLine, showTr)
        };
    }

    function setupMusicDesktopLyrics(app) {
        if (!app || app.desktopLyrics) return;
        const api = app.api || global.utilityAPI || global.electronAPI;
        const state = { on: false, timer: null, sent: null, sentAt: 0, sentLyrics: null, sentLyricsLen: -1, sentShowTr: true };
        const announce = () => {
            try { global.document?.dispatchEvent?.(new CustomEvent('music-desktop-lyrics-change', { detail: { on: state.on } })); } catch (e) { /* 旧内核 */ }
        };
        const key = (s) => `${s.path ?? ''}\u0001${s.index}\u0001${s.playing ? 1 : 0}\u0001${s.hasLyrics ? 1 : 0}\u0001${(s.line && s.line.text) || ''}\u0001${(s.line && s.line.tr) || ''}\u0001${(s.next && s.next.text) || ''}\u0001${(s.next && s.next.tr) || ''}`;
        const publish = (force = false, fromEvent = false) => {
            if (!state.on || !api?.publishDesktopLyrics) return;
            // 定时轮询快速短路：曲目/歌词引用/译文开关不变时，暂停零分配返回，播放中在同一行且未到对时间隔/未漂移时同样跳过快照分配
            if (!force && !fromEvent && state.sent) {
                const playing = Boolean(app.isPlaying);
                if (playing === state.sent.playing) {
                    const track = Array.isArray(app.playlist) ? app.playlist[app.currentTrackIndex] : null;
                    const path = track ? track.path : null;
                    const all = Array.isArray(app.currentLyrics) ? app.currentLyrics : null;
                    const lyricsLen = all ? all.length : 0;
                    const showTr = app.lyricsTranslation !== false;
                    if (path === state.sent.path && all === state.sentLyrics && lyricsLen === state.sentLyricsLen && showTr === state.sentShowTr) {
                        if (!playing) {
                            const pos = Number(app.lastKnownCurrentTime) || 0;
                            if (Math.abs(pos - state.sent.position) < 0.05) return;
                        } else {
                            const nowFast = Date.now();
                            const tFast = position(app);
                            const driftFast = Math.abs(tFast - (state.sent.position + (nowFast - state.sent.at) / 1000));
                            if (nowFast - state.sentAt < RESYNC_MS && driftFast < 1) {
                                const lines = filteredLines(all || []);
                                const k = lineAt(lines, tFast);
                                const line = k >= 0 ? lines[k] : null;
                                const nextLine = lines[k + 1] || null;
                                const end = line && line.words && line.words.length ? Number(line.words[line.words.length - 1].endTime) : null;
                                const resting = Boolean(line && nextLine && Number.isFinite(end) && tFast > end + 2 && (Number(nextLine.time) || 0) - tFast > 4);
                                if ((resting ? -1 : k) === state.sent.index) return;
                            }
                        }
                    }
                }
            }
            const snap = snapshot(app);
            const k = key(snap);
            const now = Date.now();
            // 暂停且进度未变时无需每 3 秒重发相同快照；播放中进度偏离 1 秒以上或到对时间隔再补发
            if (!force && k === state.sentKey) {
                if (!snap.playing && state.sent && !state.sent.playing) {
                    if (Math.abs(snap.position - state.sent.position) < 0.05) return;
                } else {
                    const drift = state.sent && state.sent.playing ? Math.abs(snap.position - (state.sent.position + (now - state.sent.at) / 1000)) : 0;
                    if (now - state.sentAt < RESYNC_MS && drift < 1) return;
                }
            }
            state.sent = snap;
            state.sentKey = k;
            state.sentAt = now;
            state.sentLyrics = Array.isArray(app.currentLyrics) ? app.currentLyrics : null;
            state.sentLyricsLen = state.sentLyrics ? state.sentLyrics.length : 0;
            state.sentShowTr = app.lyricsTranslation !== false;
            try { api.publishDesktopLyrics(snap); } catch (e) { /* 主进程没有这个接口 */ }
        };
        let bodyObserver = null;
        let lastBodyPlaying = false;
        const onUpdate = () => publish(false, true);
        const startBodyObserver = () => {
            if (!bodyObserver && global.MutationObserver && global.document?.body) {
                lastBodyPlaying = Boolean(global.document.body.classList?.contains('music-playing'));
                bodyObserver = new global.MutationObserver(() => {
                    const nowPlaying = Boolean(global.document.body.classList?.contains('music-playing'));
                    if (nowPlaying === lastBodyPlaying) return;
                    lastBodyPlaying = nowPlaying;
                    onUpdate();
                });
                bodyObserver.observe(global.document.body, { attributes: true, attributeFilter: ['class'] });
            }
        };
        const stopBodyObserver = () => {
            if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
        };
        const run = () => {
            if (state.on && state.timer === null) {
                startBodyObserver();
                publish(true);
                state.timer = global.setInterval(() => publish(false), POLL_MS);
            }
            if (!state.on) {
                stopBodyObserver();
                if (state.timer !== null) { global.clearInterval(state.timer); state.timer = null; }
            }
        };
        const apply = (p) => {
            if (!p || typeof p !== 'object') return;
            const on = p.on === true;
            if (on === state.on) return;
            state.on = on;
            run();
            announce();
        };

        app.desktopLyrics = {
            get on() { return state.on; },
            available: Boolean(api?.toggleDesktopLyrics),
            async toggle(on) {
                if (!api?.toggleDesktopLyrics) return state.on;
                const want = typeof on === 'boolean' ? on : !state.on;
                try {
                    apply({ on: await api.toggleDesktopLyrics(want) });
                } catch (e) {
                    console.warn('[Music] 桌面歌词开关失败：', e);
                    announce();
                    try { global.MusicToast?.show?.({ message: '桌面歌词开关失败，请稍后重试', kind: 'error', duration: 3000 }); } catch (_) { /* 没有提示层 */ }
                    return state.on;
                }
                try {
                    global.MusicToast?.show?.({ message: state.on ? '桌面歌词已打开：悬停在歌词上可以锁定、调字号' : '桌面歌词已关闭', duration: 3000 });
                } catch (e) { /* 没有提示层 */ }
                return state.on;
            },
            publish: () => publish(true)
        };
        // 设置卡片里的开关
        const doc = global.document;
        const item = doc?.getElementById?.('desktop-lyrics-item');
        const sw = doc?.getElementById?.('desktop-lyrics-switch');
        let onDeskSwitchSync = null;
        let onDeskSwitchChange = null;
        if (item && sw && app.desktopLyrics.available) {
            item.hidden = false;
            sw.checked = state.on;
            onDeskSwitchChange = () => app.desktopLyrics.toggle(sw.checked);
            sw.addEventListener('change', onDeskSwitchChange);
            onDeskSwitchSync = () => { sw.checked = state.on; };
            doc.addEventListener('music-desktop-lyrics-change', onDeskSwitchSync);
        }
        const unsubChanged = api?.onDesktopLyricsChanged?.(apply);
        try { api?.getDesktopLyrics?.().then(apply).catch(() => {}); } catch (e) { /* 同上 */ }
        // 换歌、播放状态、翻译/偏移/译文开关变了马上检查一次（内容没变就不送）
        const updateEvents = ['music-queue-change', 'music-lyrics-change', 'music-lyrics-translated', 'music-lyrics-offset', 'music-lyrics-translation'];
        updateEvents.forEach((name) => global.document?.addEventListener?.(name, onUpdate));
        global.addEventListener?.('beforeunload', () => {
            if (state.timer !== null) { global.clearInterval(state.timer); state.timer = null; }
            stopBodyObserver();
            if (onDeskSwitchChange) sw?.removeEventListener?.('change', onDeskSwitchChange);
            if (onDeskSwitchSync) doc?.removeEventListener?.('music-desktop-lyrics-change', onDeskSwitchSync);
            updateEvents.forEach((name) => global.document?.removeEventListener?.(name, onUpdate));
            try { if (typeof unsubChanged === 'function') unsubChanged(); } catch (e) { /* 同上 */ }
        }, { once: true });
        announce(); // 让已经画好的入口（歌词面板的按钮）知道这个功能在
    }

    const api = { setupMusicDesktopLyrics, snapshot, lineAt };
    global.MusicDesktopLyrics = api;
    global.setupMusicDesktopLyrics = setupMusicDesktopLyrics;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
