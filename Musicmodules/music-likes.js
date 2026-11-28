// Musicmodules/music-likes.js
// 「喜欢」：主流播放器都有的一键收藏。存成一个固定 id 的普通歌单「喜欢的歌曲」，
// 所以旧版播放器、歌单页、档案阵列（一列一个歌单）都直接认得它，不需要新的存储。
//
// 对外：app.isLiked(track)、app.toggleLike(trackOrTracks, { like })、app.likedPlaylist()。
// 变化时在 document 上发 `music-like-change`（detail: { tracks, liked }），各视图自己重画。
// 右键菜单里加一项「喜欢 / 取消喜欢」，打开菜单时按当前曲目更新文字。

(function (global) {
    'use strict';

    const LIKED_ID = 'liked';
    const LIKED_NAME = '喜欢的歌曲';

    function setupMusicLikes(app) {
        if (!app || app.toggleLike) return;
        const lists = () => (Array.isArray(app.customPlaylists) ? app.customPlaylists : (app.customPlaylists = []));
        app.likedPlaylist = () => lists().find((p) => String(p.id) === LIKED_ID) || null;
        const ensure = () => {
            let pl = app.likedPlaylist();
            if (!pl) {
                pl = { id: LIKED_ID, name: LIKED_NAME, tracks: [] };
                lists().unshift(pl); // 排在歌单最前面，和主流播放器一样
            }
            if (!Array.isArray(pl.tracks)) pl.tracks = [];
            return pl;
        };
        let likedCachePl = null;
        let likedCacheTracks = null;
        let likedCacheLen = -1;
        let likedCacheFirst = undefined;
        let likedCacheLast = undefined;
        let likedCacheSet = null;
        const invalidateLikedCache = () => { likedCacheTracks = null; likedCacheSet = null; };
        const likedSetOf = () => {
            const pl = app.likedPlaylist();
            const tracks = pl && Array.isArray(pl.tracks) ? pl.tracks : null;
            if (!tracks || !tracks.length) {
                invalidateLikedCache();
                return null;
            }
            const len = tracks.length;
            if (pl === likedCachePl && tracks === likedCacheTracks && len === likedCacheLen
                && tracks[0] === likedCacheFirst && tracks[len - 1] === likedCacheLast && likedCacheSet) {
                return likedCacheSet;
            }
            likedCachePl = pl;
            likedCacheTracks = tracks;
            likedCacheLen = len;
            likedCacheFirst = tracks[0];
            likedCacheLast = tracks[len - 1];
            likedCacheSet = new Set(tracks);
            return likedCacheSet;
        };
        app.isLiked = (track) => {
            if (!track || !track.path) return false;
            const set = likedSetOf();
            return Boolean(set && set.has(track.path));
        };
        const announce = (tracks, liked) => {
            try { app.saveCustomPlaylists?.(); } catch (e) { /* 存不了也先在界面上生效 */ }
            try { app.archiveView?.refresh?.(); } catch (e) { /* 档案页没开 */ }
            if (app.currentSidebarView === 'playlists') { try { app.renderSidebarContent?.('playlists'); } catch (e) { /* 旧侧栏 */ } }
            try { global.document?.dispatchEvent?.(new CustomEvent('music-like-change', { detail: { tracks, liked } })); } catch (e) { /* 旧内核 */ }
        };
        const toast = (message, undo) => {
            try { global.MusicToast?.show?.({ message, action: undo ? { label: '撤销', run: undo } : undefined }); } catch (e) { /* 没有提示层 */ }
        };
        // like 不传：单首时取反；多首时只要有一首没喜欢就全部设为喜欢（和多选「全部标记」的习惯一致）
        app.toggleLike = (input, { like, quiet = false } = {}) => {
            const tracks = [];
            if (Array.isArray(input)) {
                for (let i = 0; i < input.length; i += 1) {
                    const t = input[i];
                    if (t && t.path) tracks.push(t);
                }
            } else if (input && input.path) {
                tracks.push(input);
            }
            if (!tracks.length) return null;
            const pl = ensure();
            const existing = new Set(pl.tracks);
            let target;
            if (typeof like === 'boolean') {
                target = like;
            } else {
                target = false;
                for (let i = 0; i < tracks.length; i += 1) {
                    if (!existing.has(tracks[i].path)) { target = true; break; }
                }
            }
            const changed = [];
            if (target) {
                const added = [];
                for (let i = 0; i < tracks.length; i += 1) {
                    const t = tracks[i];
                    if (!existing.has(t.path)) { existing.add(t.path); added.push(t.path); changed.push(t); } // 最近喜欢的在最前
                }
                if (added.length === 1) {
                    pl.tracks.unshift(added[0]);
                } else if (added.length > 1) {
                    added.reverse();
                    pl.tracks = added.concat(pl.tracks);
                }
            } else {
                const toRemove = new Set();
                for (let i = 0; i < tracks.length; i += 1) {
                    const t = tracks[i];
                    if (existing.has(t.path) && !toRemove.has(t.path)) { toRemove.add(t.path); changed.push(t); }
                }
                if (toRemove.size) {
                    const kept = [];
                    const prev = pl.tracks;
                    for (let i = 0; i < prev.length; i += 1) {
                        if (!toRemove.has(prev[i])) kept.push(prev[i]);
                    }
                    pl.tracks = kept;
                }
            }
            if (!changed.length) return target;
            invalidateLikedCache();
            announce(changed, target);
            if (!quiet) {
                const name = changed.length === 1 ? `「${app.stripAudioExtension ? app.stripAudioExtension(changed[0].title || '') : (changed[0].title || '')}」` : `${changed.length} 首`;
                toast(target ? `已喜欢${name}` : `已取消喜欢${name}`, () => app.toggleLike(changed, { like: !target, quiet: true }));
            }
            return target;
        };

        // ---------- 右键菜单 ----------
        const menu = app.contextMenu;
        if (menu && !menu.querySelector('[data-action="toggle-like"]')) {
            const item = global.document.createElement('div');
            item.className = 'context-menu-item';
            item.dataset.action = 'toggle-like';
            item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path class="like-off" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z" fill="currentColor"/><path class="like-on" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="currentColor"/></svg><span>喜欢</span>';
            const anchor = menu.querySelector('[data-action="add-to-queue"]');
            if (anchor && anchor.nextSibling) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const track = app.playlist?.[app.contextMenuTrackIndex];
                menu.classList.remove('visible');
                if (track) app.toggleLike(track);
            });
            const labelEl = item.querySelector('span');
            const likeOnEl = item.querySelector('.like-on');
            const likeOffEl = item.querySelector('.like-off');
            const paint = () => {
                const track = app.playlist?.[app.contextMenuTrackIndex];
                const on = app.isLiked(track);
                item.classList.toggle('is-liked', on);
                labelEl.textContent = on ? '取消喜欢' : '喜欢';
                likeOnEl.style.display = on ? '' : 'none';
                likeOffEl.style.display = on ? 'none' : '';
            };
            (global.MusicAppHooks || require('./music-app-hooks.js')).before(app, 'showContextMenu', 'likes', () => paint());
        }
    }

    global.setupMusicLikes = setupMusicLikes;
    if (typeof module !== 'undefined' && module.exports) module.exports = { setupMusicLikes, LIKED_ID, LIKED_NAME };
})(typeof window !== 'undefined' ? window : globalThis);
