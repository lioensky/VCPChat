// Musicmodules/music-window-title.js
// 窗口标题跟着歌走：任务栏、Alt+Tab、任务栏缩略图上看到的是「标题 - 歌手」，不再永远是「音乐播放器」。
// 不改播放器本身：盯着底栏的曲名、歌手两个文字节点，变了就改 document.title（Electron 会同步成窗口标题）。
//
// 对外：纯函数 windowTitle(title, artist) 供测试。

(function (global) {
    'use strict';

    const BASE = '音乐播放器';
    const PLACEHOLDER_TITLES = new Set(['', '未选择歌曲', '未知标题']);
    const PLACEHOLDER_ARTISTS = new Set(['', '未知艺术家', '未知歌手']);
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const windowTitle = (title, artist) => {
        const t = clean(title);
        if (PLACEHOLDER_TITLES.has(t)) return BASE;
        const a = clean(artist);
        const text = PLACEHOLDER_ARTISTS.has(a) ? t : `${t} - ${a}`;
        return text.length > 120 ? text.slice(0, 119) + '…' : text;
    };

    function setupMusicWindowTitle(app) {
        const doc = global.document;
        if (!app || app.windowTitleWatch || !doc || typeof global.MutationObserver !== 'function') return;
        const titleEl = app.trackTitle;
        const artistEl = app.trackArtist;
        if (!titleEl || !artistEl) return;
        let last = null;
        const sync = () => {
            const next = windowTitle(titleEl.textContent, artistEl.textContent);
            if (next !== last) { last = next; doc.title = next; }
        };
        const mo = new global.MutationObserver(sync);
        for (const node of [titleEl, artistEl]) mo.observe(node, { childList: true, characterData: true, subtree: true });
        sync();
        app.windowTitleWatch = { stop: () => { mo.disconnect(); doc.title = BASE; } };
    }

    const exported = { setupMusicWindowTitle, windowTitle };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicWindowTitle = exported;
})(typeof window !== 'undefined' ? window : globalThis);
