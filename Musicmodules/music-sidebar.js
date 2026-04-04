// Musicmodules/music-sidebar.js
// 侧边栏、上下文菜单、对话框、歌单逻辑

function setupSidebar(app) {
    app.loadCustomPlaylists = async () => {
        if (app.api?.getCustomPlaylists) {
            app.customPlaylists = await app.api.getCustomPlaylists() || [];
        }
    };

    app.saveCustomPlaylists = () => {
        if (app.api?.saveCustomPlaylists) {
            app.api.saveCustomPlaylists(app.customPlaylists);
        }
    };

    app.getAlbumGroups = () => {
        const albums = {};
        app.playlist.forEach(t => {
            const name = t.album || '未知专辑';
            if (!albums[name]) albums[name] = { name, art: t.albumArt, tracks: [] };
            albums[name].tracks.push(t);
        });
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
            groups.forEach(g => {
                const div = document.createElement('div');
                div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover ${view==='artists'?'artist-avatar':''}" style="${g.art ? `background-image: url('file://${g.art.replace(/\\/g, '/')}')` : ''}"></div>
                    <div class="info"><div class="name">${g.name}</div><div class="count">${g.tracks.length} 首</div></div>`;
                div.addEventListener('click', () => {
                    app.filteredPlaylistSource = { type: view==='albums'?'album':'artist', name: g.name };
                    app.currentFilteredTracks = g.tracks;
                    app.playlistEl.style.display = 'block'; categoryView.style.display = 'none';
                    app.renderPlaylist(g.tracks);
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                });
                categoryView.appendChild(div);
            });
        } else if (view === 'playlists') {
            app.playlistEl.style.display = 'none'; categoryView.style.display = 'block';
            categoryView.innerHTML = '';
            app.customPlaylists.forEach(pl => {
                const div = document.createElement('div'); div.className = 'category-item';
                div.innerHTML = `
                    <div class="cover" style="display:flex;align-items:center;justify-content:center;font-size:1.2em;">📁</div>
                    <div class="info"><div class="name">${pl.name}</div><div class="count">${pl.tracks.length} 首</div></div>
                    <button class="edit-btn" title="编辑歌单">✎</button><button class="delete-btn" title="删除歌单">✕</button>`;
                div.querySelector('.edit-btn').addEventListener('click', (e) => { e.stopPropagation(); app.openPlaylistEditModal(pl.id); });
                div.querySelector('.delete-btn').addEventListener('click', (e) => {
                    e.stopPropagation(); if (confirm(`确认删除 "${pl.name}"?`)) {
                        app.customPlaylists = app.customPlaylists.filter(p => p.id !== pl.id);
                        app.saveCustomPlaylists(); app.renderSidebarContent('playlists');
                    }
                });
                div.addEventListener('click', () => {
                    app.filteredPlaylistSource = { type: 'playlist', name: pl.name, id: pl.id };
                    app.currentFilteredTracks = pl.tracks.map(p => app.playlist.find(t => t.path === p)).filter(Boolean);
                    app.playlistEl.style.display = 'block'; categoryView.style.display = 'none';
                    app.renderPlaylist(app.currentFilteredTracks);
                    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                    document.querySelector('.sidebar-tab[data-view="all"]').classList.add('active');
                });
                categoryView.appendChild(div);
            });
        }
    };

    app.showPlaylistDialog = (callback) => {
        app.pendingAddToPlaylist = callback; app.playlistNameInput.value = '';
        app.playlistDialog.classList.add('visible'); app.playlistNameInput.focus();
    };

    app.hidePlaylistDialog = () => { app.playlistDialog.classList.remove('visible'); app.pendingAddToPlaylist = null; };

    app.showContextMenu = (x, y) => {
        app.updatePlaylistSubmenu();
        app.contextMenu.style.left = `${x}px`; app.contextMenu.style.top = `${y}px`;
        app.contextMenu.classList.add('visible');
        requestAnimationFrame(() => {
            const rect = app.contextMenu.getBoundingClientRect();
            if (rect.right > window.innerWidth) app.contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
            if (rect.bottom > window.innerHeight) app.contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
        });
    };

    app.updatePlaylistSubmenu = () => {
        app.playlistSubmenu.innerHTML = app.customPlaylists.length === 0 ? '<div class="submenu-empty">暂无歌单</div>' : '';
        app.customPlaylists.forEach(pl => {
            const item = document.createElement('div'); item.className = 'submenu-item'; item.textContent = pl.name;
            item.addEventListener('click', (e) => { e.stopPropagation(); app.addSelectedTracksToPlaylist(pl.id); app.contextMenu.classList.remove('visible'); });
            app.playlistSubmenu.appendChild(item);
        });
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
        app.modalSearchInput.value = ''; app.modalPlaylistTitle.textContent = `编辑: ${pl.name}`;
        app.renderModalSongList(); app.playlistEditModal.classList.add('visible');
    };

    app.renderModalSongList = () => {
        const pl = app.customPlaylists.find(p => p.id === app.editingPlaylistId); if (!pl) return;
        const q = app.modalSearchQuery.toLowerCase();
        const filtered = q ? app.playlist.filter(t => (t.title||'').toLowerCase().includes(q)||(t.artist||'').toLowerCase().includes(q)) : app.playlist;
        app.modalSongList.innerHTML = filtered.length === 0 ? '<div class="music-modal-empty">没有匹配的歌曲</div>' : '';
        const frag = document.createDocumentFragment();
        filtered.forEach((t, i) => {
            const isIn = pl.tracks.includes(t.path);
            const div = document.createElement('div'); div.className = `music-modal-song-item${isIn ? ' in-playlist' : ''}`;
            div.dataset.path = t.path; div.dataset.index = i;
            div.innerHTML = `<div class="music-modal-song-checkbox"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg></div>
                             <div class="music-modal-song-info"><div class="music-modal-song-title">${t.title||'未知标题'}</div><div class="music-modal-song-artist">${t.artist||'未知艺术家'}</div></div>`;
            div.addEventListener('click', (e) => {
                if (e.shiftKey && app.lastModalClickIndex !== -1) {
                    const [s, eIdx] = [Math.min(app.lastModalClickIndex, i), Math.max(app.lastModalClickIndex, i)];
                    const targetState = !pl.tracks.includes(t.path);
                    for (let j = s; j <= eIdx; j++) {
                        const path = filtered[j].path;
                        if (targetState && !pl.tracks.includes(path)) pl.tracks.push(path);
                        else if (!targetState && pl.tracks.includes(path)) pl.tracks.splice(pl.tracks.indexOf(path), 1);
                    }
                    app.saveCustomPlaylists(); app.renderModalSongList();
                } else {
                    const idx = pl.tracks.indexOf(t.path);
                    if (idx === -1) pl.tracks.push(t.path); else pl.tracks.splice(idx, 1);
                    app.saveCustomPlaylists(); div.classList.toggle('in-playlist');
                }
                app.lastModalClickIndex = i; app.modalCount.textContent = `${pl.tracks.length} 首已添加`;
            });
            frag.appendChild(div);
        });
        app.modalSongList.appendChild(frag); app.modalCount.textContent = `${pl.tracks.length} 首已添加`;
    };
}
