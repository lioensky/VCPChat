// Musicmodules/music-sidebar.js
// 侧边栏、上下文菜单、对话框、歌单逻辑

function setupSidebar(app) {
    // 曲名、歌手、专辑来自文件标签，歌单名、服务器名、WebDAV 文件名来自用户或远端：拼进 HTML 前都要转义。
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    app.loadCustomPlaylists = async () => {
        if (app.api?.getCustomPlaylists) {
            app.customPlaylists = await app.api.getCustomPlaylists() || [];
        }
    };

    // 存盘失败（磁盘满、文件被占用、没有权限）以前没人看结果：界面上改好了，重开就没了。
    // 现在弹一条提示，同一类失败只留一条。
    const reportSaveFailure = (what, error) => {
        const reason = (globalThis.MusicErrorText || ((m, f) => f))(error, '原因不明');
        const message = `${what}没能存盘（${reason.replace(/^原因不明：/, '')}），这次的改动重开播放器后会丢失。`;
        console.error(`[Music] Saving ${what} failed:`, error);
        try { globalThis.MusicToast?.show?.({ id: `save-${what}`, kind: 'error', message }); } catch (e) { /* 没有提示层就只记日志 */ }
    };
    const checkedSave = (what, send) => Promise.resolve()
        .then(send)
        .then((result) => {
            if (result && result.success === false) reportSaveFailure(what, result.error);
            return result;
        })
        .catch((error) => { reportSaveFailure(what, error); return { success: false, error: error?.message || String(error) }; });

    app.saveCustomPlaylists = () => {
        if (!app.api?.saveCustomPlaylists) return Promise.resolve(null);
        return checkedSave('歌单', () => app.api.saveCustomPlaylists(app.customPlaylists));
    };
    app.saveLibrary = () => {
        if (!app.api?.saveMusicPlaylist) return Promise.resolve(null);
        return checkedSave('曲库', () => app.api.saveMusicPlaylist(app.playlist));
    };

    const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    let cachedNormList = null;
    let cachedNormLen = -1;
    let cachedNormFirst = null;
    let cachedNormLast = null;
    let cachedNormMap = null;
    const getNormTrackMap = () => {
        const list = Array.isArray(app.playlist) ? app.playlist : [];
        const len = list.length;
        const first = len ? list[0] : null;
        const last = len ? list[len - 1] : null;
        if (cachedNormMap && cachedNormList === app.playlist && cachedNormLen === len
            && cachedNormFirst === first && cachedNormLast === last) {
            return cachedNormMap;
        }
        const byPath = new Map();
        for (let i = 0; i < len; i += 1) {
            const t = list[i];
            const key = normPath(t && t.path);
            if (key && !byPath.has(key)) byPath.set(key, t);
        }
        cachedNormList = app.playlist;
        cachedNormLen = len;
        cachedNormFirst = first;
        cachedNormLast = last;
        cachedNormMap = byPath;
        return byPath;
    };

    let albumCache = null;
    let artistCache = null;
    const playlistSig = (list) => {
        const len = list.length;
        const f = len ? list[0] : null;
        const l = len ? list[len - 1] : null;
        return {
            list, len, f, l,
            fMeta: f ? `${f.album || ''}\x1f${f.artist || ''}\x1f${f.albumArt || ''}` : '',
            lMeta: l ? `${l.album || ''}\x1f${l.artist || ''}\x1f${l.albumArt || ''}` : ''
        };
    };
    const sameSig = (a, b) => a && a.list === b.list && a.len === b.len && a.f === b.f && a.l === b.l
        && a.fMeta === b.fMeta && a.lMeta === b.lMeta;

    app.getAlbumGroups = () => {
        const tracks = Array.isArray(app.playlist) ? app.playlist : [];
        const order = globalThis.MusicTrackOrder || null;
        const sig = playlistSig(tracks);
        if (albumCache && sameSig(albumCache.sig, sig) && albumCache.order === order) {
            return albumCache.groups.slice();
        }
        const albums = new Map();
        for (let i = 0; i < tracks.length; i += 1) {
            const t = tracks[i];
            const name = t.album || '未知专辑';
            let group = albums.get(name);
            if (!group) {
                group = { name, art: t.albumArt, tracks: [] };
                albums.set(name, group);
            }
            group.tracks.push(t);
        }
        // 专辑里按碟号、曲号排，和「目录」一致（单首专辑跳过比较器构造）
        const list = Array.from(albums.values());
        if (order) {
            for (let gIdx = 0; gIdx < list.length; gIdx += 1) {
                const g = list[gIdx];
                const n = g.tracks.length;
                if (n <= 1) continue;
                const cmp = order.albumCompare(g.tracks, (a, b) => a - b);
                const idx = new Array(n);
                for (let k = 0; k < n; k += 1) idx[k] = k;
                idx.sort(cmp);
                const sorted = new Array(n);
                for (let k = 0; k < n; k += 1) sorted[k] = g.tracks[idx[k]];
                g.tracks = sorted;
            }
        }
        list.sort((a, b) => b.tracks.length - a.tracks.length);
        albumCache = { sig, order, groups: list };
        return list.slice();
    };

    app.getArtistGroups = () => {
        const tracks = Array.isArray(app.playlist) ? app.playlist : [];
        const sig = playlistSig(tracks);
        if (artistCache && sameSig(artistCache.sig, sig)) {
            return artistCache.groups.slice();
        }
        const artists = new Map();
        for (let i = 0; i < tracks.length; i += 1) {
            const t = tracks[i];
            const name = t.artist || '未知艺术家';
            let group = artists.get(name);
            if (!group) {
                group = { name, art: t.albumArt, tracks: [] };
                artists.set(name, group);
            }
            group.tracks.push(t);
        }
        const list = Array.from(artists.values()).sort((a, b) => b.tracks.length - a.tracks.length);
        artistCache = { sig, groups: list };
        return list.slice();
    };

    let allCountEl = null;
    app.updateAllCount = () => {
        const el = (allCountEl && allCountEl.isConnected) ? allCountEl : (allCountEl = document.getElementById('all-count'));
        if (!el) return;
        const next = String(app.playlist.length);
        if (el.textContent !== next) el.textContent = next;
    };

    const PLAYLIST_COVER_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 17.5V9l4-1v7.5"/><circle cx="14.2" cy="17.5" r="1.8"/><circle cx="18.2" cy="15.5" r="1.8"/></svg>';
    const EDIT_BTN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
    const DEL_BTN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    const categoryViewsWired = new WeakSet();
    let renderedCategoryKind = '';
    let renderedGroups = [];
    let renderedPlaylists = [];

    const activateAllTab = () => {
        const tabs = document.querySelectorAll('.sidebar-tab');
        for (let i = 0; i < tabs.length; i += 1) {
            tabs[i].classList.toggle('active', tabs[i].dataset.view === 'all');
        }
    };

    const wireCategoryView = (categoryView) => {
        if (!categoryView || categoryViewsWired.has(categoryView)) return;
        categoryViewsWired.add(categoryView);
        categoryView.addEventListener('click', (e) => {
            const item = e.target?.closest?.('.category-item');
            if (!item || !categoryView.contains(item)) return;
            const idx = Number(item.dataset.catIdx);
            if (!Number.isInteger(idx) || idx < 0) return;
            if (renderedCategoryKind === 'albums' || renderedCategoryKind === 'artists') {
                const g = renderedGroups[idx];
                if (!g) return;
                app.filteredPlaylistSource = { type: renderedCategoryKind === 'albums' ? 'album' : 'artist', name: g.name };
                app.currentFilteredTracks = g.tracks;
                app.playlistEl.style.display = 'block';
                categoryView.style.display = 'none';
                app.renderPlaylist(g.tracks);
                activateAllTab();
                return;
            }
            if (renderedCategoryKind === 'playlists') {
                const pl = renderedPlaylists[idx];
                if (!pl) return;
                if (e.target.closest?.('.edit-btn')) {
                    e.stopPropagation();
                    app.openPlaylistEditModal(pl.id);
                    return;
                }
                if (e.target.closest?.('.delete-btn')) {
                    e.stopPropagation();
                    const ask = { title: `删除歌单「${pl.name}」？`, message: '只删除这个歌单，里面的歌还在曲库里。', confirmText: '删除', danger: true };
                    Promise.resolve(window.MusicDialog ? window.MusicDialog.confirm(ask) : confirm(ask.title)).then((ok) => {
                        if (!ok) return;
                        app.customPlaylists = app.customPlaylists.filter(p => p.id !== pl.id);
                        app.saveCustomPlaylists(); app.renderSidebarContent('playlists');
                        try { app.archiveView?.refresh?.(); } catch (err) { /* 档案页未激活 */ }
                        if (String(pl.id) === 'liked') {
                            try { document.dispatchEvent(new CustomEvent('music-like-change', { detail: { tracks: [], liked: false } })); } catch (err) { /* 旧内核 */ }
                        }
                    });
                    return;
                }
                app.filteredPlaylistSource = { type: 'playlist', name: pl.name, id: pl.id };
                const byPath = getNormTrackMap();
                const matched = [];
                for (let i = 0; i < pl.tracks.length; i += 1) {
                    const hit = byPath.get(normPath(pl.tracks[i]));
                    if (hit) matched.push(hit);
                }
                app.currentFilteredTracks = matched;
                app.playlistEl.style.display = 'block';
                categoryView.style.display = 'none';
                app.renderPlaylist(app.currentFilteredTracks);
                activateAllTab();
            }
        });
    };

    app.renderSidebarContent = (view) => {
        app.currentSidebarView = view;
        app.sidebarFooter.style.display = view === 'playlists' ? 'block' : 'none';
        const categoryView = document.getElementById('sidebar-category-view');
        wireCategoryView(categoryView);

        if (view === 'all') {
            renderedCategoryKind = '';
            renderedGroups = [];
            renderedPlaylists = [];
            app.filteredPlaylistSource = null; app.currentFilteredTracks = null;
            app.playlistEl.style.display = 'block'; categoryView.style.display = 'none';
            app.renderPlaylist(); app.updateAllCount();
        } else if (view === 'albums' || view === 'artists') {
            app.playlistEl.style.display = 'none'; categoryView.style.display = 'block';
            const groups = view === 'albums' ? app.getAlbumGroups() : app.getArtistGroups();
            renderedCategoryKind = view;
            renderedGroups = groups;
            renderedPlaylists = [];
            const avatarCls = view === 'artists' ? ' artist-avatar' : '';
            const parts = new Array(groups.length);
            for (let i = 0; i < groups.length; i += 1) {
                const g = groups[i];
                let styleAttr = '';
                if (g.art) {
                    const artUrl = app.fileUrl ? app.fileUrl(g.art) : `file://${encodeURI(g.art.replace(/\\/g, '/'))}`;
                    const safeUrl = String(artUrl).replace(/["\\)]/g, (ch) => ({ '"': '%22', '\\': '%5C', ')': '%29' }[ch]));
                    styleAttr = ` style="background-image:url(&quot;${esc(safeUrl)}&quot;)"`;
                }
                parts[i] = `<div class="category-item" data-cat-idx="${i}">`
                    + `<div class="cover${avatarCls}"${styleAttr}></div>`
                    + `<div class="info"><div class="name">${esc(g.name)}</div><div class="count">${g.tracks.length} 首</div></div></div>`;
            }
            categoryView.innerHTML = parts.join('');
        } else if (view === 'playlists') {
            app.playlistEl.style.display = 'none'; categoryView.style.display = 'block';
            const pls = Array.isArray(app.customPlaylists) ? app.customPlaylists : [];
            renderedCategoryKind = 'playlists';
            renderedGroups = [];
            renderedPlaylists = pls.slice();
            const parts = new Array(pls.length);
            for (let i = 0; i < pls.length; i += 1) {
                const pl = pls[i];
                parts[i] = `<div class="category-item" data-cat-idx="${i}">`
                    + `<div class="cover playlist-cover" style="display:flex;align-items:center;justify-content:center;">${PLAYLIST_COVER_SVG}</div>`
                    + `<div class="info"><div class="name">${esc(pl.name)}</div><div class="count">${pl.tracks.length} 首</div></div>`
                    + `<button class="edit-btn" title="编辑歌单" aria-label="编辑歌单">${EDIT_BTN_SVG}</button>`
                    + `<button class="delete-btn" title="删除歌单" aria-label="删除歌单">${DEL_BTN_SVG}</button></div>`;
            }
            categoryView.innerHTML = parts.join('');
        }
    };

    app.showPlaylistDialog = (callback) => {
        app.pendingAddToPlaylist = callback; app.playlistNameInput.value = '';
        app.playlistDialog.classList.add('visible'); app.playlistNameInput.focus();
    };

    app.hidePlaylistDialog = () => { app.playlistDialog.classList.remove('visible'); app.pendingAddToPlaylist = null; };

    let ctxMenuRaf = 0;
    window.addEventListener?.('beforeunload', () => {
        if (ctxMenuRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(ctxMenuRaf); ctxMenuRaf = 0; }
    }, { once: true });

    app.showContextMenu = (x, y) => {
        app.updatePlaylistSubmenu();
        const sub = app.contextMenu.querySelector('.context-submenu');
        if (sub && sub.style.maxWidth) sub.style.maxWidth = '';
        app.contextMenu.style.left = `${x}px`; app.contextMenu.style.top = `${y}px`;
        app.contextMenu.classList.add('visible');
        if (ctxMenuRaf && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(ctxMenuRaf); ctxMenuRaf = 0; }
        ctxMenuRaf = requestAnimationFrame(() => {
            ctxMenuRaf = 0;
            if (!app.contextMenu || !app.contextMenu.classList.contains('visible')) return;
            // 先一次性读完几何信息，再写样式，避免单帧多次强制回流
            const rect = app.contextMenu.getBoundingClientRect();
            const subWidth = sub ? Math.max(sub.offsetWidth, 160) : 160;
            const winW = window.innerWidth;
            const winH = window.innerHeight;
            let finalLeft = rect.left;
            let finalTop = rect.top;
            if (rect.right > winW) finalLeft = winW - rect.width - 10;
            if (rect.bottom > winH) finalTop = winH - rect.height - 10;
            // 菜单比窗口剩下的空间还高、或按键打开时锚点在可视区外：贴住上边/左边，不顶出窗口。
            if (finalTop < 10) finalTop = 10;
            if (finalLeft < 10) finalLeft = 10;
            if (finalLeft !== rect.left) app.contextMenu.style.left = `${finalLeft}px`;
            if (finalTop !== rect.top) app.contextMenu.style.top = `${finalTop}px`;
            // 右边放不下「添加到歌单」的子菜单时，往左边展开（不然歌单名被窗口边裁掉）
            // 窗口窄到两边都放不下时（最小宽度 420），挑空间大的一边，把子菜单收窄到放得下，歌单名用省略号
            const roomRight = winW - (finalLeft + rect.width) - 4 - 8;
            const roomLeft = finalLeft - 4 - 8;
            const left = subWidth > roomRight && roomLeft > roomRight;
            app.contextMenu.classList.toggle('sub-left', left);
            const room = Math.floor(left ? roomLeft : roomRight);
            if (sub && subWidth > room) sub.style.maxWidth = `${Math.max(room, 120)}px`;
            // 从按下右键的那一点长出来
            window.MusicFluid?.bud(app.contextMenu, { x, y });
        });
    };

    let submenuWired = null;
    let lastSubmenuSig = null;
    app.updatePlaylistSubmenu = () => {
        const sub = app.playlistSubmenu;
        if (!sub) return;
        if (submenuWired !== sub) {
            submenuWired = sub;
            sub.addEventListener('click', (e) => {
                const item = e.target?.closest?.('.submenu-item');
                if (!item || !sub.contains(item) || !('_playlistId' in item)) return;
                e.stopPropagation();
                app.addSelectedTracksToPlaylist(item._playlistId);
                app.contextMenu.classList.remove('visible');
            });
        }
        const list = Array.isArray(app.customPlaylists) ? app.customPlaylists : [];
        let sig = '';
        for (let i = 0; i < list.length; i += 1) {
            const pl = list[i];
            sig += (i ? '\x1e' : '') + typeof pl?.id + ':' + String(pl?.id ?? '') + '\x1f' + String(pl?.name ?? '');
        }
        if (sig === lastSubmenuSig && sub.childNodes.length > 0) return;
        lastSubmenuSig = sig;
        if (list.length === 0) {
            sub.innerHTML = '<div class="submenu-empty">暂无歌单</div>';
            return;
        }
        sub.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = 0; i < list.length; i += 1) {
            const pl = list[i];
            const item = document.createElement('div');
            item.className = 'submenu-item';
            item.dataset.playlistId = String(pl.id);
            item._playlistId = pl.id;
            item.textContent = pl.name;
            item.title = pl.name;
            frag.appendChild(item);
        }
        sub.appendChild(frag);
    };

    app.addSelectedTracksToPlaylist = (playlistId) => {
        const pl = app.customPlaylists.find(p => p.id === playlistId);
        if (!pl || app.contextMenuTrackIndex === null) return;
        const track = app.playlist[app.contextMenuTrackIndex];
        if (!track || pl.tracks.includes(track.path)) return;
        pl.tracks.push(track.path); app.saveCustomPlaylists();
        if (app.currentSidebarView === 'playlists') app.renderSidebarContent('playlists');
        try { app.archiveView?.refresh?.(); } catch (err) { /* 档案页未激活 */ }
        if (String(pl.id) === 'liked') {
            try { document.dispatchEvent(new CustomEvent('music-like-change', { detail: { tracks: [track], liked: true } })); } catch (err) { /* 旧内核 */ }
        }
    };

    app.openPlaylistEditModal = (id) => {
        const pl = app.customPlaylists.find(p => p.id === id); if (!pl) return;
        app.editingPlaylistId = id; app.modalSearchQuery = ''; app.lastModalClickIndex = -1;
        app.modalSearchInput.value = ''; app.modalPlaylistTitle.textContent = `编辑歌单「${pl.name}」`;
        app.renderModalSongList(); app.playlistEditModal.classList.add('visible');
    };

    const MODAL_CHECK_HTML = '<div class="music-modal-song-checkbox"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg></div>';
    app.renderModalSongList = () => {
        const pl = app.customPlaylists.find(p => p.id === app.editingPlaylistId); if (!pl) return;
        const q = String(app.modalSearchQuery || '').trim();
        const selectedPaths = new Set(pl.tracks);
        const filtered = q && app.searchTracks ? app.searchTracks(app.playlist, q) : app.playlist;
        // 单趟稳定分区（已选歌在前，未选歌在后），保持原有相对顺序，避免 O(N log N) 排序与临时包装对象
        const inPl = [];
        const rest = [];
        for (let i = 0; i < filtered.length; i += 1) {
            const t = filtered[i];
            if (selectedPaths.has(t.path)) inPl.push(t); else rest.push(t);
        }
        const inPlCount = inPl.length;
        const sortedFiltered = inPl.concat(rest);
        // 一次拼好整张列表再写进去，点击交给列表本身（以前每行各建三层元素、各挂一个监听，5000 首打开、每敲一个字都要重建半秒多）
        app.modalRows = sortedFiltered;
        app.lastModalClickIndex = -1; // 行号换了一套：Shift 连选从下一次单击重新算起
        const totalRows = sortedFiltered.length;
        if (totalRows === 0) {
            app.modalSongList.innerHTML = '<div class="music-modal-empty">没有匹配的歌曲</div>';
        } else {
            const parts = new Array(totalRows);
            for (let i = 0; i < totalRows; i += 1) {
                const t = sortedFiltered[i];
                parts[i] = `<div class="music-modal-song-item${i < inPlCount ? ' in-playlist' : ''}" data-index="${i}">`
                    + MODAL_CHECK_HTML
                    + `<div class="music-modal-song-info"><div class="music-modal-song-title">${esc(app.stripAudioExtension(t.title) || '未知标题')}</div><div class="music-modal-song-artist">${esc(t.artist || '未知艺术家')}</div></div></div>`;
            }
            app.modalSongList.innerHTML = parts.join('');
        }
        const countText = `${pl.tracks.length} 首已添加`;
        if (app.modalCount.textContent !== countText) app.modalCount.textContent = countText;
        if (!modalListsWired.has(app.modalSongList)) {
            modalListsWired.add(app.modalSongList);
            app.modalSongList.addEventListener('click', onModalSongClick);
        }
    };

    const modalListsWired = new WeakSet();
    // 勾选、取消勾选（按住 Shift 连选一段）：只改这几行的样子，不重建列表，也不把勾上的歌挪到顶上
    function onModalSongClick(e) {
        const row = e.target.closest?.('.music-modal-song-item');
        if (!row || !app.modalSongList.contains(row)) return;
        const pl = app.customPlaylists.find(p => p.id === app.editingPlaylistId);
        const rows = app.modalRows || [];
        const i = Number(row.dataset.index);
        const t = rows[i];
        if (!pl || !t) return;
        const items = app.modalSongList.children;
        const paint = (j, selected) => { const el = items[j]; if (el) el.classList.toggle('in-playlist', selected); };
        const changedTracks = [];
        let changedLiked = true;
        if (e.shiftKey && app.lastModalClickIndex !== -1 && rows[app.lastModalClickIndex]) {
            const [s, eIdx] = [Math.min(app.lastModalClickIndex, i), Math.max(app.lastModalClickIndex, i)];
            const inList = new Set(pl.tracks);
            const targetState = !inList.has(t.path);
            changedLiked = targetState;
            for (let j = s; j <= eIdx; j++) {
                const path = rows[j].path;
                if (targetState && !inList.has(path)) { pl.tracks.push(path); inList.add(path); changedTracks.push(rows[j]); }
                else if (!targetState && inList.has(path)) { inList.delete(path); changedTracks.push(rows[j]); }
            }
            if (!targetState) { const keep = pl.tracks.filter((p) => inList.has(p)); pl.tracks.length = 0; pl.tracks.push(...keep); }
            for (let j = s; j <= eIdx; j++) paint(j, inList.has(rows[j].path));
        } else {
            const idx = pl.tracks.indexOf(t.path);
            const added = idx === -1;
            changedLiked = added;
            if (added) pl.tracks.push(t.path); else pl.tracks.splice(idx, 1);
            changedTracks.push(t);
            paint(i, added);
        }
        app.saveCustomPlaylists();
        try { app.archiveView?.refresh?.(); } catch (err) { /* 档案页未激活 */ }
        if (String(pl.id) === 'liked' && changedTracks.length) {
            try { document.dispatchEvent(new CustomEvent('music-like-change', { detail: { tracks: changedTracks, liked: changedLiked } })); } catch (err) { /* 旧内核 */ }
        }
        app.lastModalClickIndex = i; app.modalCount.textContent = `${pl.tracks.length} 首已添加`;
    }
}
