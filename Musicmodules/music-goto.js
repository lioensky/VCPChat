// Musicmodules/music-goto.js
// 右键「转到歌手 / 转到专辑」：主流播放器的右键菜单都有，从一首歌直接跳到它所在的那一组。
// 落点是档案页目录：换到「歌手」或「专辑」分类，把这一组顶到最上面并选中这首。
// 只在档案页（不在舞台、不在经典视图）显示；曲目没有歌手或专辑信息时对应那一项隐藏。
// 另有「复制歌名」（歌名 - 歌手），任何视图都显示。

(function (global) {
    'use strict';

    const ITEMS = [
        ['artist', '转到歌手', 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'],
        ['album', '转到专辑', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z']
    ];

    const EXT_FALLBACK_RE = /\.[a-z0-9]{2,4}$/i;
    const fieldOf = (track, kind) => String((track && track[kind]) || '').trim();

    /* 复制出去的文字：「歌名 - 歌手」，没有歌手就只有歌名；去掉文件扩展名 */
    function copyText(app, track) {
        if (!track) return '';
        const raw = String(track.title || '').trim();
        const title = app.stripAudioExtension ? app.stripAudioExtension(raw) : raw.replace(EXT_FALLBACK_RE, '');
        const artist = fieldOf(track, 'artist');
        return title ? (artist ? `${title} - ${artist}` : title) : '';
    }

    function archiveReady(app) {
        const view = app.archiveView;
        if (!view || view.mode !== 'archive' || !view.list) return null;
        if (app.isStageActive || global.document?.body?.classList.contains('music-stage-active')) return null;
        return view;
    }

    /* 换到分类并选中；成功返回 true。不依赖菜单，方便别处（比如详情卡）直接调用 */
    function goToGroup(app, index, kind) {
        const view = archiveReady(app);
        const track = app.playlist?.[index];
        if (!view || !track || !fieldOf(track, kind)) return false;
        try { view.setListOpen?.(true, { persist: false }); } catch (e) { /* 旧档案页 */ }
        return Boolean(view.list.goToGroup?.(index, kind));
    }

    function setupMusicGoto(app) {
        if (!app || app.goToGroup) return;
        app.goToGroup = (index, kind) => goToGroup(app, index, kind);

        const menu = app.contextMenu;
        const doc = global.document;
        if (!menu || !doc || menu.querySelector('[data-action^="goto-"]')) return;
        const anchor = menu.querySelector('[data-action="toggle-like"]') || menu.querySelector('[data-action="add-to-queue"]');
        let after = anchor;
        const nodes = ITEMS.map(([kind, label, d]) => {
            const item = doc.createElement('div');
            item.className = 'context-menu-item';
            item.dataset.action = 'goto-' + kind;
            item.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg><span>${label}</span>`;
            if (after && after.parentNode === menu) { menu.insertBefore(item, after.nextSibling); after = item; } else menu.appendChild(item);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = app.contextMenuTrackIndex;
                menu.classList.remove('visible');
                goToGroup(app, index, kind);
            });
            return { kind, label, item };
        });

        // 「复制歌名」：歌名 - 歌手，分享给别人或贴进搜索框用；任何视图都有
        const copy = doc.createElement('div');
        copy.className = 'context-menu-item';
        copy.dataset.action = 'copy-title';
        copy.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/></svg><span>复制歌名</span>';
        if (after && after.parentNode === menu) menu.insertBefore(copy, after.nextSibling); else menu.appendChild(copy);
        copy.addEventListener('click', (e) => {
            e.stopPropagation();
            const track = app.playlist?.[app.contextMenuTrackIndex];
            menu.classList.remove('visible');
            const text = copyText(app, track);
            if (!text) return;
            const done = () => { try { global.MusicToast?.show?.({ message: `已复制「${text}」` }); } catch (err) { /* 没有提示层 */ } };
            const fail = () => { try { global.MusicToast?.show?.({ kind: 'error', message: '复制歌名失败，剪贴板不可用' }); } catch (err) { /* 没有提示层 */ } };
            try {
                const write = global.navigator?.clipboard?.writeText;
                if (typeof write !== 'function') { fail(); return; }
                const p = write.call(global.navigator.clipboard, text);
                if (p && typeof p.then === 'function') p.then(done, fail); else done();
            } catch (err) { fail(); }
        });

        const paint = () => {
            const track = app.playlist?.[app.contextMenuTrackIndex];
            const ready = Boolean(archiveReady(app));
            for (const { kind, label, item } of nodes) {
                const name = fieldOf(track, kind);
                const show = ready && Boolean(name);
                const nextDisplay = show ? '' : 'none';
                const nextTitle = show ? `${label}「${name}」` : '';
                if (item.style.display !== nextDisplay) item.style.display = nextDisplay;
                if (item.title !== nextTitle) item.title = nextTitle;
            }
        };
        (global.MusicAppHooks || require('./music-app-hooks.js')).before(app, 'showContextMenu', 'goto', () => paint());
    }

    global.setupMusicGoto = setupMusicGoto;
    if (typeof module !== 'undefined' && module.exports) module.exports = { setupMusicGoto, copyText };
})(typeof window !== 'undefined' ? window : globalThis);
