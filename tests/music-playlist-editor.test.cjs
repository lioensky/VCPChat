// 编辑歌单弹窗：列表是整个曲库，要经得起几千首。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function setup(n = 30) {
    const dom = new JSDOM('<!doctype html><body><div id="sidebar-category-view"></div><div id="list"></div><span id="count"></span><h3 id="title"></h3></body>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const doc = dom.window.document;
    const tracks = Array.from({ length: n }, (_, i) => ({ path: `D:/m/${i}.flac`, title: `t${i}`, artist: 'A' }));
    const saves = [];
    const app = {
        playlist: tracks, stripAudioExtension: (s) => s,
        customPlaylists: [{ id: '1', name: 'L', tracks: [tracks[0].path] }],
        modalSongList: doc.getElementById('list'), modalCount: doc.getElementById('count'), modalPlaylistTitle: doc.getElementById('title'),
        modalSearchInput: { value: '' }, playlistEditModal: doc.createElement('div'),
        api: { saveCustomPlaylists: async (pls) => { saves.push(pls[0].tracks.slice()); return { success: true }; } },
        searchTracks: (list, q) => list.filter((t) => t.title.includes(q))
    };
    dom.window.setupSidebar(app);
    app.openPlaylistEditModal('1');
    const rows = () => [...doc.querySelectorAll('.music-modal-song-item')];
    const click = (el, shiftKey = false) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey }));
    return { dom, app, rows, click, saves, pl: app.customPlaylists[0] };
}

test('ticking a song and shift-ticking a range change those rows in place, without rebuilding or reordering the list', () => {
    const { dom, rows, click, pl, app } = setup();
    const before = rows();
    assert.equal(before[0].textContent.includes('t0'), true, 'songs already in the playlist come first');
    click(before[5]);
    assert.ok(pl.tracks.includes('D:/m/5.flac'));
    assert.ok(before[5].classList.contains('in-playlist'));
    click(before[9], true);
    const after = rows();
    assert.equal(after[7], before[7], 'same row elements: the list was not rebuilt');
    assert.deepEqual(after.map((r) => r.textContent), before.map((r) => r.textContent), 'nothing jumped to the top');
    for (const i of [5, 6, 7, 8, 9]) assert.ok(after[i].classList.contains('in-playlist'), `row ${i}`);
    assert.deepEqual(pl.tracks, ['D:/m/0.flac', 'D:/m/5.flac', 'D:/m/6.flac', 'D:/m/7.flac', 'D:/m/8.flac', 'D:/m/9.flac']);
    // 再按住 Shift 从 9 点回 6：这一段取消
    click(after[6]);
    click(after[8], true);
    assert.deepEqual(pl.tracks, ['D:/m/0.flac', 'D:/m/5.flac', 'D:/m/9.flac']);
    assert.equal(app.modalCount.textContent, '3 首已添加');
    dom.window.close();
});

test('a shift-click right after a new search does not reach back to a row of the old list', () => {
    const { dom, rows, click, pl, app } = setup();
    click(rows()[3]);
    app.modalSearchQuery = 't2'; app.renderModalSongList();
    const r = rows();
    click(r[r.length - 1], true);
    assert.equal(pl.tracks.length, 3, 'only the clicked song was added, not a range from the old row 3');
    dom.window.close();
});

test('rows off screen are not laid out (the list is the whole library)', () => {
    const css = fs.readFileSync('Musicmodules/music.css', 'utf8');
    const rule = /\.music-modal-song-item \{[^}]*\}/.exec(css)[0];
    assert.match(rule, /content-visibility:\s*auto/);
    assert.match(rule, /contain-intrinsic-size/);
});

test('album and artist cards in the classic sidebar skip layout and covers off screen', () => {
    // 5000 首、1200 张专辑、CPU 降速 4 倍：打开专辑页 1062 ms → 约 120 ms
    const css = fs.readFileSync('Musicmodules/music.css', 'utf8');
    const rule = /\n\.category-item \{[^}]*\}/.exec(css)[0];
    assert.match(rule, /content-visibility:\s*auto/);
    assert.match(rule, /contain-intrinsic-size/);
});

test('Batch 60: modal song list uses stable O(N) partition, single-track albums skip albumCompare, and sidebar scroll class is localized', () => {
    const dom = new JSDOM('<!doctype html><body><div id="sidebar-category-view"></div><div id="list"></div><span id="count"></span><h3 id="title"></h3></body>', { runScripts: 'outside-only' });
    let compareCalls = 0;
    dom.window.MusicTrackOrder = {
        albumCompare: (list) => {
            compareCalls += 1;
            return (ia, ib) => (list[ia].trackNumber || 0) - (list[ib].trackNumber || 0);
        }
    };
    dom.window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const doc = dom.window.document;
    const tracks = [
        { path: 'D:/m/0.flac', title: 't0', artist: 'A', album: 'Solo1' },
        { path: 'D:/m/1.flac', title: 't1', artist: 'A', album: 'Duo', trackNumber: 2 },
        { path: 'D:/m/2.flac', title: 't2', artist: 'A', album: 'Solo2' },
        { path: 'D:/m/3.flac', title: 't3', artist: 'A', album: 'Duo', trackNumber: 1 },
        { path: 'D:/m/4.flac', title: 't4', artist: 'A', album: 'Solo3' }
    ];
    const app = {
        playlist: tracks, stripAudioExtension: (s) => s,
        customPlaylists: [{ id: '1', name: 'L', tracks: ['D:/m/3.flac', 'D:/m/1.flac'] }],
        modalSongList: doc.getElementById('list'), modalCount: doc.getElementById('count'), modalPlaylistTitle: doc.getElementById('title'),
        modalSearchInput: { value: '' }, playlistEditModal: doc.createElement('div'),
        api: { saveCustomPlaylists: async () => ({ success: true }) },
        searchTracks: (list) => list
    };
    dom.window.setupSidebar(app);
    app.openPlaylistEditModal('1');
    const titles = [...doc.querySelectorAll('.music-modal-song-item .music-modal-song-title')].map((el) => el.textContent);
    assert.deepEqual(titles, ['t1', 't3', 't0', 't2', 't4'], 'selected tracks come first while preserving exact relative order in both partitions');

    compareCalls = 0;
    const albums = app.getAlbumGroups();
    assert.equal(compareCalls, 1, 'single-track albums skip albumCompare; only multi-track album Duo sorts');
    assert.deepEqual(Array.from(albums.find((g) => g.name === 'Duo').tracks, (t) => t.title), ['t3', 't1'], 'multi-track album still sorted by albumCompare');

    const musicJs = fs.readFileSync('Musicmodules/music.js', 'utf8');
    assert.doesNotMatch(musicJs, /document\.body\.classList\.add\('sidebar-is-scrolling'\)/, 'sidebar scroll hot path no longer adds class to document.body');
    assert.match(musicJs, /sidebarScrollHost\.classList\.add\('sidebar-is-scrolling'\)/, 'sidebar scroll hot path scopes class to sidebarScrollHost');
    const musicCss = fs.readFileSync('Musicmodules/music.css', 'utf8');
    assert.match(musicCss, /\.left-sidebar\.sidebar-is-scrolling\s*\.sidebar-playlist\s+li/);
    dom.window.close();
});

test('Batch 70: showContextMenu cancels stale rAF on rapid reopen or beforeunload and skips bud when hidden', () => {
    const dom = new JSDOM('<!doctype html><body><div id="ctx" class="context-menu"><div class="context-submenu"></div></div></body>', { runScripts: 'outside-only' });
    const { window } = dom;
    const doc = window.document;
    const queued = [];
    const cancelled = [];
    let rid = 0;
    window.requestAnimationFrame = (cb) => { const id = ++rid; queued.push({ id, cb }); return id; };
    window.cancelAnimationFrame = (id) => { cancelled.push(id); };
    let budCalls = 0;
    window.MusicFluid = { bud: () => { budCalls += 1; } };
    window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const menu = doc.getElementById('ctx');
    const app = {
        contextMenu: menu,
        playlistSubmenu: null,
        customPlaylists: []
    };
    window.setupSidebar(app);

    app.showContextMenu(10, 20);
    app.showContextMenu(30, 40);
    assert.deepEqual(cancelled, [1], 'second showContextMenu cancels first pending rAF');

    // Hide menu before second rAF fires -> bud must not run on closed menu
    menu.classList.remove('visible');
    queued[1].cb();
    assert.equal(budCalls, 0, 'rAF skips MusicFluid.bud when context menu is no longer visible');

    // Open again and fire beforeunload -> pending rAF cancelled
    app.showContextMenu(50, 60);
    window.dispatchEvent(new window.Event('beforeunload'));
    assert.ok(cancelled.includes(3), 'beforeunload cancels pending showContextMenu rAF');
    dom.window.close();
});

test('Batch 74: music.js scopes progress drag listeners to active drag, fast-paths classicOrder, and refreshes archiveView on playlist creation', () => {
    const musicJs = fs.readFileSync('Musicmodules/music.js', 'utf8');
    assert.match(musicJs, /const detachProgressDrag\s*=\s*\(\)\s*=>/, 'music.js detaches global progress drag listeners when idle');
    assert.match(musicJs, /app\.progressContainer\.onmousedown\s*=\s*\(e\)\s*=>[\s\S]{0,400}window\.addEventListener\('mousemove', onProgressMove\)/, 'progress drag binds global listeners only on mousedown');
    assert.match(musicJs, /dragRect\s*=\s*app\.progressContainer\.getBoundingClientRect\(\)/, 'progress bar caches bounding rect on mousedown');
    assert.match(musicJs, /if\s*\(shown === app\.playlist\)\s*return app\.playlist\.slice\(\)/, 'classicOrder fast-paths full playlist without Set construction');
    assert.match(musicJs, /else if \(action === 'create-playlist-add'\)\s*\{\s*\r?\n\s*const track = app\.playlist\[app\.contextMenuTrackIndex\];/, 'create-playlist-add captures target track before opening modal');
    assert.doesNotMatch(musicJs, /const scannedPaths = new Set\(scannedMap\.keys\(\)\)/, 'onMusicScanComplete uses scannedMap.has directly without redundant Set');
});

test('Batch 78: sidebar playlists match Windows slash/case variants and modal list uses partitioned count directly', () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="sidebar-tab active" data-view="playlists"></div>
        <div class="sidebar-tab" data-view="all"></div>
        <div id="sidebar-category-view"></div>
        <div id="playlist-el"></div>
        <div id="list"></div><span id="count"></span><h3 id="title"></h3>
    </body>`, { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const doc = dom.window.document;
    const tracks = [
        { path: 'D:/Music/Track0.flac', title: 'Track 0', artist: 'A' },
        { path: 'D:/Music/Track1.flac', title: 'Track 1', artist: 'B' }
    ];
    let rendered = null;
    const app = {
        playlist: tracks,
        playlistEl: doc.getElementById('playlist-el'),
        sidebarFooter: doc.createElement('div'),
        stripAudioExtension: (s) => s,
        customPlaylists: [{ id: 'pl1', name: 'Mix', tracks: ['d:\\music\\track1.FLAC'] }],
        modalSongList: doc.getElementById('list'),
        modalCount: doc.getElementById('count'),
        modalPlaylistTitle: doc.getElementById('title'),
        modalSearchInput: { value: '' },
        playlistEditModal: doc.createElement('div'),
        renderPlaylist: (list) => { rendered = list; },
        api: { saveCustomPlaylists: async () => ({ success: true }) },
        searchTracks: (list) => list
    };
    dom.window.setupSidebar(app);
    app.renderSidebarContent('playlists');
    const item = doc.querySelector('#sidebar-category-view .category-item');
    assert.ok(item, 'playlist sidebar item rendered');
    item.click();
    assert.equal(rendered?.length, 1, 'Windows slash/case variant path resolves to library track');
    assert.equal(rendered[0].path, 'D:/Music/Track1.flac');

    app.customPlaylists[0].tracks = ['D:/Music/Track1.flac'];
    app.openPlaylistEditModal('pl1');
    const rows = [...doc.querySelectorAll('.music-modal-song-item')];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].classList.contains('in-playlist'), true);
    assert.equal(rows[1].classList.contains('in-playlist'), false);
    dom.window.close();
});

test('Batch 83: sidebar caches album/artist groups, delegates category clicks, and escapes special cover paths', () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="sidebar-tab active" data-view="albums"></div>
        <div class="sidebar-tab" data-view="all"></div>
        <div id="sidebar-category-view"></div>
        <div id="playlist-el"></div>
        <div id="list"></div><span id="count"></span><h3 id="title"></h3>
    </body>`, { runScripts: 'outside-only' });
    let compareCalls = 0;
    dom.window.MusicTrackOrder = {
        albumCompare: (list) => {
            compareCalls += 1;
            return (ia, ib) => (list[ia].trackNumber || 0) - (list[ib].trackNumber || 0);
        }
    };
    dom.window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const doc = dom.window.document;
    const tracks = [
        { path: 'D:/m/0.flac', title: 't0', artist: 'A', album: 'Duo', trackNumber: 2, albumArt: 'C:/art/a"b\\c(1).jpg' },
        { path: 'D:/m/1.flac', title: 't1', artist: 'A', album: 'Duo', trackNumber: 1 }
    ];
    let rendered = null;
    const app = {
        playlist: tracks,
        playlistEl: doc.getElementById('playlist-el'),
        sidebarFooter: doc.createElement('div'),
        stripAudioExtension: (s) => s,
        fileUrl: (p) => `file:///${p}`,
        customPlaylists: [],
        modalSongList: doc.getElementById('list'),
        modalCount: doc.getElementById('count'),
        modalPlaylistTitle: doc.getElementById('title'),
        modalSearchInput: { value: '' },
        playlistEditModal: doc.createElement('div'),
        renderPlaylist: (list) => { rendered = list; },
        api: { saveCustomPlaylists: async () => ({ success: true }) },
        searchTracks: (list) => list
    };
    dom.window.setupSidebar(app);

    // 1. Repeated getAlbumGroups reuses cache without re-invoking albumCompare
    const g1 = app.getAlbumGroups();
    const g2 = app.getAlbumGroups();
    assert.equal(compareCalls, 1, 'cached getAlbumGroups avoids re-running albumCompare');
    assert.deepEqual(Array.from(g1[0].tracks, (t) => t.title), ['t1', 't0']);
    assert.deepEqual(Array.from(g2[0].tracks, (t) => t.title), ['t1', 't0']);

    // Mutating playlist invalidates cache
    app.playlist.push({ path: 'D:/m/2.flac', title: 't2', artist: 'B', album: 'Solo' });
    const g3 = app.getAlbumGroups();
    assert.equal(g3.length, 2, 'playlist length change invalidates album group cache');
    assert.equal(compareCalls, 2);

    // 2. Delegated category-item click renders album tracks and safely escapes special cover URL characters
    app.renderSidebarContent('albums');
    const items = [...doc.querySelectorAll('#sidebar-category-view .category-item')];
    assert.equal(items.length, 2);
    const coverStyle = items[0].querySelector('.cover').getAttribute('style') || '';
    assert.ok(coverStyle.includes('%22') && coverStyle.includes('%5C') && coverStyle.includes('%29'), 'special quotes, backslashes, and parens in cover URL are percent-encoded');
    items[0].click();
    assert.equal(rendered?.length, 2, 'delegated click opens selected album tracks');
    assert.equal(doc.querySelector('.sidebar-tab[data-view="all"]').classList.contains('active'), true);
    dom.window.close();
});

test('Batch 111: MusicTrackOrder.hasAlbumOrder skips albumCompare for unnumbered sidebar albums and empty playlists skip modal partition', () => {
    const TrackOrder = require('../Musicmodules/music-track-order.js');
    const plain = [
        { path: 'D:/Music/AlbumA/Alpha.flac', title: 'Alpha', artist: 'A', album: 'Plain' },
        { path: 'D:/Music/AlbumA/Beta.flac', title: 'Beta', artist: 'A', album: 'Plain' }
    ];
    const numbered = [
        { path: 'D:/Music/AlbumB/02 Second.flac', title: 'Second', artist: 'B', album: 'Num' },
        { path: 'D:/Music/AlbumB/01 First.flac', title: 'First', artist: 'B', album: 'Num' }
    ];
    assert.equal(TrackOrder.hasAlbumOrder(plain), false, 'unnumbered album reports hasAlbumOrder=false');
    assert.equal(TrackOrder.hasAlbumOrder(numbered), true, 'track-numbered album reports hasAlbumOrder=true');
    assert.equal(TrackOrder.hasAlbumOrder([{ path: 'D:/m/CD2/Song.flac' }, { path: 'D:/m/CD1/Song.flac' }]), true, 'disc-numbered album reports hasAlbumOrder=true');

    const dom = new JSDOM(`<!doctype html><body>
        <div id="sidebar-category-view"></div>
        <div id="playlist-el"></div>
        <div id="list"></div><span id="count"></span><h3 id="title"></h3>
    </body>`, { runScripts: 'outside-only' });
    let cmpCalls = 0;
    dom.window.MusicTrackOrder = {
        hasAlbumOrder: TrackOrder.hasAlbumOrder,
        albumCompare: (...args) => { cmpCalls += 1; return TrackOrder.albumCompare(...args); }
    };
    dom.window.eval(fs.readFileSync('Musicmodules/music-sidebar.js', 'utf8'));
    const doc = dom.window.document;
    const app = {
        playlist: [...plain, ...numbered],
        playlistEl: doc.getElementById('playlist-el'),
        sidebarFooter: doc.createElement('div'),
        stripAudioExtension: (s) => s,
        customPlaylists: [{ id: 'empty', name: '空歌单', tracks: [] }],
        modalSongList: doc.getElementById('list'),
        modalCount: doc.getElementById('count'),
        modalPlaylistTitle: doc.getElementById('title'),
        modalSearchInput: { value: '' },
        playlistEditModal: doc.createElement('div'),
        renderPlaylist() {},
        api: { saveCustomPlaylists: async () => ({ success: true }) },
        searchTracks: (list) => list
    };
    dom.window.setupSidebar(app);
    const groups = app.getAlbumGroups();
    assert.equal(cmpCalls, 1, 'getAlbumGroups runs albumCompare only on numbered album, skipping unnumbered album');
    const numGroup = groups.find((g) => g.name === 'Num');
    assert.deepEqual(Array.from(numGroup.tracks, (t) => t.title), ['First', 'Second']);
    app.openPlaylistEditModal('empty');
    assert.equal(app.modalRows, app.playlist, 'empty playlist reuses filtered playlist array directly without partitioning');
    assert.equal(doc.querySelectorAll('.music-modal-song-item').length, 4);
    dom.window.close();
});
