// Musicmodules/music-lyrics-ai.js
// 外语歌（日语、英语、韩语……）的歌词没有中文翻译时，用 VCP 上配置的模型翻好，放进每行的 translation，
// 歌词区、首页歌词、舞台、桌面歌词都照常显示（关掉「显示翻译」也照常藏起来）。
// 同一份歌词只翻一次（主进程缓存在歌词目录 translations/）；切歌了就不再往旧歌里填。
// 开关：命令面板「AI 翻译外语歌词」，存本机（默认开）。没配模型时什么都不做。
//
// 对外：app.lyricsAi = { enabled（读写）, translateNow() }。纯函数 needsTranslation 供测试。
(function (global) {
    'use strict';

    const KEY = 'musicLyricsAiTranslate';
    const NOTICE_KEY = 'musicLyricsAiNoticeShown';

    const textOf = (line) => String((line && (line.original ?? line.text ?? line.fullText)) || '').trim();

    // 这份歌词要不要翻：已有翻译的（三成以上行有译文）不翻；有正文的行里一半以上是外语才翻。
    // 外语 = 有假名或谚文，或者有拉丁字母而没有汉字。纯中文、纯音乐（没词）都不翻。
    function needsTranslation(lines) {
        if (!Array.isArray(lines) || lines.length < 2) return false;
        let withText = 0, foreign = 0, translated = 0;
        for (const line of lines) {
            const t = textOf(line);
            if (!t) continue;
            withText++;
            if (String(line.translation || '').trim()) translated++;
            const kanaOrHangul = /[぀-ヿ가-힯ᄀ-ᇿ]/.test(t);
            const latin = (t.match(/[A-Za-zÀ-ɏ]/g) || []).length;
            const han = /[一-鿿]/.test(t);
            if (kanaOrHangul || (latin >= 3 && !han)) foreign++;
        }
        if (withText < 2) return false;
        if (translated >= withText * 0.3) return false;
        return foreign >= withText * 0.5;
    }

    function setupMusicLyricsAi(app, { storage = (() => { try { return global.localStorage; } catch (e) { return null; } })() } = {}) {
        if (!app || app.lyricsAi || typeof app.fetchAndDisplayLyrics !== 'function') return;
        let enabled = true;
        try { enabled = storage?.getItem(KEY) !== '0'; } catch (e) { /* 默认开 */ }
        let unavailable = false; // 没配模型：这次运行不再问
        let inFlight = null;     // { token, lines, manual }：防止自动与连点并发发出重复翻译请求

        const toast = (message) => { try { global.MusicToast?.show?.({ message }); } catch (e) { /* 没有提示层 */ } };
        const currentTrack = () => (Array.isArray(app.playlist) ? app.playlist[app.currentTrackIndex] : null);

        const run = async ({ manual = false } = {}) => {
            if (!enabled && !manual) return;
            if (unavailable && !manual) return;
            if (!app.api?.translateMusicLyrics) return;
            const lines = app.currentLyrics;
            if (!needsTranslation(lines)) {
                if (manual) toast(Array.isArray(lines) && lines.length ? '这份歌词已经有翻译，或者本来就是中文' : '这首还没有歌词');
                return;
            }
            const token = app.lyricsRequestToken;
            if (inFlight && inFlight.token === token && inFlight.lines === lines && (!manual || inFlight.manual)) {
                if (manual) toast('正在翻译歌词…');
                return;
            }
            const flight = { token, lines, manual };
            inFlight = flight;
            const track = currentTrack();
            const texts = lines.map(textOf);
            if (manual) toast('正在翻译歌词…');
            let result;
            try {
                result = await app.api.translateMusicLyrics({
                    lines: texts,
                    title: app.stripAudioExtension ? app.stripAudioExtension(track?.title || '') : (track?.title || ''),
                    artist: track?.artist || '',
                    force: manual
                });
            } catch (e) {
                result = { status: 'error', message: e?.message || String(e) };
            } finally {
                if (inFlight === flight) inFlight = null;
            }
            // 切歌了、换了一份歌词、调了偏移：不往新的里填旧译文
            if (app.lyricsRequestToken !== token || app.currentLyrics !== lines) return;
            if (result?.status === 'unavailable') {
                unavailable = true;
                if (manual) toast(`没法翻译：${result.message}`);
                return;
            }
            if (result?.status !== 'success' || !Array.isArray(result.translations) || !result.translations.length || result.translations.length > texts.length) {
                if (manual) toast(`翻译没有成功：${result?.message || '模型没有回应'}`);
                return;
            }
            const next = lines.map((line, i) => {
                const tr = String(result.translations[i] || '').trim();
                if (!tr || tr === texts[i] || String(line.translation || '').trim()) return line;
                return { ...line, translation: tr, translationSource: 'ai' };
            });
            // 换一个新数组：首页歌词、舞台按引用判断歌词变了没有
            app.currentLyrics = next;
            app._lyricLayout = null;
            try { app.renderLyrics?.(); } catch (e) { /* 歌词区没准备好 */ }
            try { app.syncLyricsAfterSeek?.(); } catch (e) { /* 同上 */ }
            try { global.document?.dispatchEvent?.(new CustomEvent('music-lyrics-translated', { detail: { source: 'ai', cached: Boolean(result.cached) } })); } catch (e) { /* 旧内核 */ }
            let shown = false;
            try { shown = storage?.getItem(NOTICE_KEY) === '1'; } catch (e) { /* 照常提示 */ }
            if (manual) toast('歌词翻译好了');
            else if (!shown && !result.cached) {
                toast('外语歌词用 AI 翻成了中文；不想要可以在命令面板里关掉「AI 翻译外语歌词」');
                try { storage?.setItem(NOTICE_KEY, '1'); } catch (e) { /* 下次再提示 */ }
            }
        };

        // 取完歌词再看要不要翻译（取词是异步的，所以用 wrap 等它完成）。
        (global.MusicAppHooks || require('./music-app-hooks.js')).wrap(app, 'fetchAndDisplayLyrics', 'lyrics-ai', (base) => async function (...args) {
            const result = await base.apply(this, args);
            run().catch((e) => console.warn('[MusicLyricsAi] translate failed:', e?.message || e));
            return result;
        });

        app.lyricsAi = {
            get enabled() { return enabled; },
            set enabled(v) {
                enabled = Boolean(v);
                try { storage?.setItem(KEY, enabled ? '1' : '0'); } catch (e) { /* 只是偏好 */ }
                if (enabled) { unavailable = false; run().catch(() => {}); }
            },
            translateNow: () => run({ manual: true }),
            needsTranslation: () => needsTranslation(app.currentLyrics)
        };
    }

    const exported = { setupMusicLyricsAi, needsTranslation };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicLyricsAi = setupMusicLyricsAi;
})(typeof window !== 'undefined' ? window : globalThis);
