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

    const textOf = (line) => String((line && (line.text || line.original || line.fullText)) || '').trim();
    const lineAt = (lines, t) => {
        let lo = 0, hi = lines.length - 1, at = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((Number(lines[mid].time) || 0) <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return at;
    };
    const wordsOf = (line) => {
        const check = global.MusicArchiveLyrics && global.MusicArchiveLyrics.wordsOf;
        const words = check ? check(line) : null;
        return words ? words.map((w) => ({ text: w.text, s: Number(w.startTime), e: Number(w.endTime) })) : null;
    };
    const pack = (line, showTr = true) => (line ? { text: textOf(line), tr: showTr ? String(line.translation || '').trim() : '', time: Number(line.time) || 0 } : null);
    const position = (app) => {
        const base = Number(app.lastKnownCurrentTime) || 0;
        if (!app.isPlaying || !app.lastStateUpdateTime) return base;
        return base + Math.max(0, Date.now() - app.lastStateUpdateTime) / 1000;
    };

    // 按原数组引用缓存过滤后的有效歌词行，避免每 250ms 轮询都重新过滤整首歌
    let cachedLyricsSrc = null;
    let cachedLyricsLines = [];
    const filteredLines = (all) => {
        if (all === cachedLyricsSrc && cachedLyricsLines.length <= all.length) return cachedLyricsLines;
        cachedLyricsSrc = all;
        cachedLyricsLines = all.filter((l) => textOf(l));
        return cachedLyricsLines;
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
        const state = { on: false, timer: null, sent: null, sentAt: 0 };
        const announce = () => {
            try { global.document?.dispatchEvent?.(new CustomEvent('music-desktop-lyrics-change', { detail: { on: state.on } })); } catch (e) { /* 旧内核 */ }
        };
        const key = (s) => [s.path, s.index, s.playing, s.hasLyrics, s.line && s.line.text, s.line && s.line.tr].join('\u0001');
        const publish = (force = false) => {
            if (!state.on || !api?.publishDesktopLyrics) return;
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
            state.sent = snap; state.sentKey = k; state.sentAt = now;
            try { api.publishDesktopLyrics(snap); } catch (e) { /* 主进程没有这个接口 */ }
        };
        let bodyObserver = null;
        const onUpdate = () => publish(false);
        const startBodyObserver = () => {
            if (!bodyObserver && global.MutationObserver && global.document?.body) {
                bodyObserver = new global.MutationObserver(onUpdate);
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
                try { apply({ on: await api.toggleDesktopLyrics(want) }); } catch (e) { console.warn('[Music] 桌面歌词开关失败：', e); }
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
        if (item && sw && app.desktopLyrics.available) {
            item.hidden = false;
            sw.addEventListener('change', () => app.desktopLyrics.toggle(sw.checked));
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
