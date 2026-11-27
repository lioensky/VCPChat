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

    app.getAlbumGroups = () => {
        const albums = {};
        app.playlist.forEach(t => {
            const name = t.album || '未知专辑';
            if (!albums[name]) albums[name] = { name, art: t.albumArt, tracks: [] };
            albums[name].tracks.push(t);
        });
        // 专辑里按碟号、曲号排，和「目录」一致
        const order = globalThis.MusicTrackOrder;
        if (order) for (const g of Object.values(albums)) { const cmp = order.albumCompare(g.tracks, (a, b) => a - b); g.tracks = g.tracks.map((t, i) => i).sort(cmp).map((i) => g.tracks[i]); }
        return Object.values(albums).sort((a,b) => b.tracks.length - a.tracks.length);
    };

    app.getArtistGroups = () => {
        const artists = {};
        app.playlist.forEach(t => {
            const name = t.artist || '未知艺术家';
            if (!artists[name]) artists[name] = { name, art: t.albumArt, tracks: [] };
            artists[name].tracks.push(t);
        });
        return Object.values(artists).sort((a,b) => b.tracks.length - a.tracks.length);
    };

    app.updateAllCount = () => {
        const el = document.getElementById('all-count');
        if (el) el.textContent = app.playlist.length;
    };

    app.renderSidebarContent = (view) => {
        app.currentSidebarView = view;
        app.sidebarFooter.style.display = view === 'playlists' ? 'block' : 'none';
        const categoryView = document.getElementById('sidebar-category-view');

        if (view === 'all') {
            app.filteredPlaylistSource = null; app.currentFilteredTracks = null;
            app.playlistEl.style.display = 'block'; categoryView.style.display = 'none';
            app.renderPlaylist(); app.updateAllCount();
        } else if (view === 'albums' || view === 'artists') {
            app.playlistEl.style.display = 'none'; categoryView.style.display = 'block';
            const groups = view === 'albums' ? app.getAlbumGroups() : app.getArtistGroups();
            categoryView.innerHTML = '';
            const frag = document.createDocumentFragment();
            groups.forEach(g => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover ${view==='artists'?'artist-avatar':''}"></div>
                    <div class="info"><div class="name">${esc(g.name)}</div><div class="count">${g.tracks.length} 首</div></div>`;
                if (g.art) {
                    const artUrl = app.fileUrl ? app.fileUrl(g.art) : `file://${encodeURI(g.art.replace(/\\/g, '/'))}`;
                    div.querySelector('.cover').style.backgroundImage = `url("${artUrl}")`;
                }
                div.addEventListener('click', () => {
                    app.filteredPlaylistSource = { type: view==='albums'?'album':'artist', name: g.name };
                    app.currentFilteredTracks = g.tracks;
                    app.playlistEl.style.display = 'block'; categoryView.style.display = 'none';
                    app.renderPlaylist(g.tracks);
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                });
                frag.appendChild(div);
            });
            categoryView.appendChild(frag);
        } else if (view === 'playlists') {
            app.playlistEl.style.display = 'none'; categoryView.style.display = 'block';
            categoryView.innerHTML = '';
            const frag = document.createDocumentFragment();
            app.customPlaylists.forEach(pl => {
                const div = document.createElement('div'); div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover playlist-cover" style="display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 17.5V9l4-1v7.5"/><circle cx="14.2" cy="17.5" r="1.8"/><circle cx="18.2" cy="15.5" r="1.8"/></svg></div>
                    <div class="info"><div class="name">${esc(pl.name)}</div><div class="count">${pl.tracks.length} 首</div></div>
                    <button class="edit-btn" title="编辑歌单" aria-label="编辑歌单"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg></button><button class="delete-btn" title="删除歌单" aria-label="删除歌单"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
                div.querySelector('.edit-btn').addEventListener('click', (e) => { e.stopPropagation(); app.openPlaylistEditModal(pl.id); });
                div.querySelector('.delete-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    const ask = { title: `删除歌单「${pl.name}」？`, message: '只删除这个歌单，里面的歌还在曲库里。', confirmText: '删除', danger: true };
                    Promise.resolve(window.MusicDialog ? window.MusicDialog.confirm(ask) : confirm(ask.title)).then((ok) => {
                        if (!ok) return;
                        app.customPlaylists = app.customPlaylists.filter(p => p.id !== pl.id);
                        app.saveCustomPlaylists(); app.renderSidebarContent('playlists');
                    });
                });
                div.addEventListener('click', () => {
                    app.filteredPlaylistSource = { type: 'playlist', name: pl.name, id: pl.id };
                    const byPath = new Map();
                    for (const t of app.playlist) if (t && t.path && !byPath.has(t.path)) byPath.set(t.path, t);
                    app.currentFilteredTracks = pl.tracks.map(p => byPath.get(p)).filter(Boolean);
                    app.playlistEl.style.display = 'block'; categoryView.style.display = 'none';
                    app.renderPlaylist(app.currentFilteredTracks);
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                });
                frag.appendChild(div);
            });
            categoryView.appendChild(frag);
        }
    };

    app.showPlaylistDialog = (callback) => {
        app.pendingAddToPlaylist = callback; app.playlistNameInput.value = '';
        app.playlistDialog.classList.add('visible'); app.playlistNameInput.focus();
    };

    app.hidePlaylistDialog = () => { app.playlistDialog.classList.remove('visible'); app.pendingAddToPlaylist = null; };

    app.showContextMenu = (x, y) => {
        app.updatePlaylistSubmenu();
        const sub = app.contextMenu.querySelector('.context-submenu');
        if (sub) sub.style.maxWidth = '';
        app.contextMenu.style.left = `${x}px`; app.contextMenu.style.top = `${y}px`;
        app.contextMenu.classList.add('visible');
        requestAnimationFrame(() => {
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

    app.updatePlaylistSubmenu = () => {
        if (app.customPlaylists.length === 0) {
            app.playlistSubmenu.innerHTML = '<div class="submenu-empty">暂无歌单</div>';
            return;
        }
        app.playlistSubmenu.innerHTML = '';
        const frag = document.createDocumentFragment();
        app.customPlaylists.forEach(pl => {
            const item = document.createElement('div'); item.className = 'submenu-item'; item.textContent = pl.name; item.title = pl.name;
            item.addEventListener('click', (e) => { e.stopPropagation(); app.addSelectedTracksToPlaylist(pl.id); app.contextMenu.classList.remove('visible'); });
            frag.appendChild(item);
        });
        app.playlistSubmenu.appendChild(frag);
    };

    app.addSelectedTracksToPlaylist = (playlistId) => {
        const pl = app.customPlaylists.find(p => p.id === playlistId);
        if (!pl || app.contextMenuTrackIndex === null) return;
        const track = app.playlist[app.contextMenuTrackIndex];
        if (!track || pl.tracks.includes(track.path)) return;
        pl.tracks.push(track.path); app.saveCustomPlaylists();
        if (app.currentSidebarView === 'playlists') app.renderSidebarContent('playlists');
    };

    app.openPlaylistEditModal = (id) => {
        const pl = app.customPlaylists.find(p => p.id === id); if (!pl) return;
        app.editingPlaylistId = id; app.modalSearchQuery = ''; app.lastModalClickIndex = -1;
        app.modalSearchInput.value = ''; app.modalPlaylistTitle.textContent = `编辑歌单「${pl.name}」`;
        app.renderModalSongList(); app.playlistEditModal.classList.add('visible');
    };

    app.renderModalSongList = () => {
        const pl = app.customPlaylists.find(p => p.id === app.editingPlaylistId); if (!pl) return;
        const q = String(app.modalSearchQuery || '').trim();
        const selectedPaths = new Set(pl.tracks);
        const filtered = q && app.searchTracks ? app.searchTracks(app.playlist, q) : app.playlist;
        const sortedFiltered = filtered
            .map((track, index) => ({ track, index }))
            .sort((a, b) => {
                const aSelected = selectedPaths.has(a.track.path);
                const bSelected = selectedPaths.has(b.track.path);
                if (aSelected !== bSelected) return aSelected ? -1 : 1;
                return a.index - b.index;
            })
            .map(item => item.track);
        // 一次拼好整张列表再写进去，点击交给列表本身（以前每行各建三层元素、各挂一个监听，5000 首打开、每敲一个字都要重建半秒多）
        app.modalRows = sortedFiltered;
        app.lastModalClickIndex = -1; // 行号换了一套：Shift 连选从下一次单击重新算起
        app.modalSongList.innerHTML = sortedFiltered.length === 0 ? '<div class="music-modal-empty">没有匹配的歌曲</div>'
            : sortedFiltered.map((t, i) => `<div class="music-modal-song-item${selectedPaths.has(t.path) ? ' in-playlist' : ''}" data-index="${i}">`
                + `<div class="music-modal-song-checkbox"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg></div>`
                + `<div class="music-modal-song-info"><div class="music-modal-song-title">${esc(app.stripAudioExtension(t.title) || '未知标题')}</div><div class="music-modal-song-artist">${esc(t.artist || '未知艺术家')}</div></div></div>`).join('');
        app.modalCount.textContent = `${pl.tracks.length} 首已添加`;
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
        if (e.shiftKey && app.lastModalClickIndex !== -1 && rows[app.lastModalClickIndex]) {
            const [s, eIdx] = [Math.min(app.lastModalClickIndex, i), Math.max(app.lastModalClickIndex, i)];
            const inList = new Set(pl.tracks);
            const targetState = !inList.has(t.path);
            for (let j = s; j <= eIdx; j++) {
                const path = rows[j].path;
                if (targetState && !inList.has(path)) { pl.tracks.push(path); inList.add(path); }
                else if (!targetState && inList.has(path)) { inList.delete(path); }
            }
            if (!targetState) { const keep = pl.tracks.filter((p) => inList.has(p)); pl.tracks.length = 0; pl.tracks.push(...keep); }
            for (let j = s; j <= eIdx; j++) paint(j, inList.has(rows[j].path));
        } else {
            const idx = pl.tracks.indexOf(t.path);
            const added = idx === -1;
            if (added) pl.tracks.push(t.path); else pl.tracks.splice(idx, 1);
            paint(i, added);
        }
        app.saveCustomPlaylists();
        app.lastModalClickIndex = i; app.modalCount.textContent = `${pl.tracks.length} 首已添加`;
    }
}
