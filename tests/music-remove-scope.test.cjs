const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// 「从列表中移除」的作用范围那一段写在 music.js 的大闭包里，单独取出来测。
const musicJs = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
const START = '// ── 右键菜单的作用范围 ──';
const END = "app.contextMenu.querySelectorAll('.context-menu-item')";

function setup({ confirmAnswer = true } = {}) {
    const start = musicJs.indexOf(START);
    const end = musicJs.indexOf(END, start);
    assert.ok(start > 0 && end > start, 'remove scope block not found in music.js');
    const dom = new JSDOM(`<!doctype html><body>
        <ul id="playlist"><li data-index="0">A</li></ul>
        <div id="music-archive-view"><canvas></canvas><button data-act="save"></button></div></body>`,
    { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const toasts = [];
    const confirms = [];
    window.confirm = (msg) => { confirms.push(msg); return confirmAnswer; };
    window.MusicToast = { show: (opts) => toasts.push(opts) };
    const tracks = ['a', 'b', 'c', 'd'].map((n) => ({ path: `C:/${n}.flac`, title: `${n}.flac` }));
    const calls = [];
    const app = {
        playlist: tracks.slice(),
        customPlaylists: [{ id: 'p1', name: '通勤', tracks: ['C:/b.flac', 'C:/c.flac'] }],
        filteredPlaylistSource: null,
        currentFilteredTracks: null,
        currentTrackIndex: 0,
        isPlaying: true,
        stripAudioExtension: (t) => t.replace(/\.flac$/, ''),
        renderPlaylist(filtered) { calls.push(['render', filtered ? filtered.map((t) => t.path) : null]); },
        showContextMenu() { calls.push('menu'); },
        saveCustomPlaylists() { calls.push('savePl'); },
        saveLibrary() { return app.api.saveMusicPlaylist(app.playlist); },
        loadTrack(i, play) { calls.push(['load', i, play]); app.currentTrackIndex = i; },
        pauseTrack() { calls.push('pause'); },
        nextTrack() { calls.push('next'); },
        api: { saveMusicPlaylist(list) { calls.push(['saveLib', list.length]); } },
        archiveView: { lane: 0, columns: [{ id: 'all', n: 4 }], debug() { return { lane: this.lane, columns: this.columns }; }, refresh() { calls.push('archiveRefresh'); } }
    };
    window.__app = app;
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(`(function (app) { ${musicJs.slice(start, end)} })(window.__app);`);
    const rightClick = (selector) => {
        window.document.querySelector(selector).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        app.showContextMenu(0, 0);
    };
    return { window, app, calls, toasts, confirms, tracks, rightClick };
}

test('classic list showing a playlist removes from that playlist only, with undo', () => {
    const { app, calls, toasts, confirms, rightClick } = setup();
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1', name: '通勤' };
    app.currentFilteredTracks = [app.playlist[1], app.playlist[2]];
    app.renderPlaylist(app.currentFilteredTracks);
    // 之后从档案页别的列点播会改掉 filteredPlaylistSource，但经典列表显示的还是歌单
    app.filteredPlaylistSource = null;
    rightClick('#playlist li');
    assert.deepEqual(app.contextMenuScope, { type: 'playlist', id: 'p1', name: '通勤' });
    app.removeTrackInScope(1);
    assert.deepEqual(app.customPlaylists[0].tracks, ['C:/c.flac']);
    assert.equal(app.playlist.length, 4, 'library untouched');
    assert.equal(confirms.length, 0);
    assert.match(toasts[0].message, /通勤/);
    toasts[0].action.run();
    assert.deepEqual(app.customPlaylists[0].tracks, ['C:/b.flac', 'C:/c.flac']);
    assert.ok(calls.includes('savePl'));
});

test('classic list showing the library asks first and can be undone', () => {
    const { app, calls, toasts, confirms, tracks, rightClick } = setup();
    app.currentTrackIndex = 3;
    app.renderPlaylist();
    rightClick('#playlist li');
    assert.equal(app.contextMenuScope, null);
    app.removeTrackInScope(1);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /磁盘上的文件不会删除/);
    assert.deepEqual(app.playlist.map((t) => t.path), ['C:/a.flac', 'C:/c.flac', 'C:/d.flac']);
    assert.equal(app.currentTrackIndex, 2, 'playing index follows the shift');
    assert.deepEqual(calls.filter((c) => c[0] === 'saveLib').pop(), ['saveLib', 3]);
    toasts[0].action.run();
    assert.deepEqual(app.playlist, tracks);
    assert.equal(app.currentTrackIndex, 3);
});

test('cancelling the library confirmation removes nothing', () => {
    const { app, toasts, rightClick } = setup({ confirmAnswer: false });
    app.renderPlaylist();
    rightClick('#playlist li');
    app.removeTrackInScope(0);
    assert.equal(app.playlist.length, 4);
    assert.equal(toasts.length, 0);
});

test('a search that started from a playlist view is not treated as the playlist', () => {
    const { app, confirms, rightClick } = setup();
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1', name: '通勤' };
    app.renderPlaylist([app.playlist[0], app.playlist[1]]); // a 不在歌单里
    rightClick('#playlist li');
    assert.equal(app.contextMenuScope.type, 'filter');
    app.removeTrackInScope(0);
    assert.equal(confirms.length, 1, 'falls back to the confirmed library removal');
    assert.deepEqual(app.customPlaylists[0].tracks, ['C:/b.flac', 'C:/c.flac']);
});

test('archive right-click uses the selected column, not the last playback source', () => {
    const { app, confirms, rightClick } = setup();
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1', name: '通勤' };
    app.archiveView.columns = [{ id: 'all', n: 4 }, { id: 'playlist:p1', n: 2 }];
    app.archiveView.lane = 0;
    rightClick('#music-archive-view canvas');
    assert.equal(app.contextMenuScope, null, 'all-tracks column means library');
    app.archiveView.lane = 1;
    rightClick('#music-archive-view canvas');
    assert.equal(app.contextMenuScope.type, 'playlist');
    app.removeTrackInScope(2);
    assert.deepEqual(app.customPlaylists[0].tracks, ['C:/b.flac']);
    assert.equal(confirms.length, 0);
    app.contextMenuScopeHint = { type: 'playlist', id: 'p1', name: '通勤' };
    app.archiveView.lane = 0;
    rightClick('#music-archive-view canvas');
    assert.equal(app.contextMenuScope.type, 'playlist', 'explicit hint from the archive wins');
});

test('removing the playing track continues with the one after it', () => {
    const { app, calls, rightClick } = setup();
    app.currentTrackIndex = 1;
    app.renderPlaylist();
    rightClick('#playlist li');
    app.removeTrackInScope(1);
    assert.deepEqual(calls.filter((c) => c[0] === 'load').pop(), ['load', 1, true]);
    assert.equal(app.playlist[app.currentTrackIndex].path, 'C:/c.flac');
    assert.ok(!calls.includes('next'));
});

test('a re-render of the classic list reorders the playing context only while the classic list owns it', () => {
    const { app } = setup();
    const reorders = [];
    let owned = true;
    app.classicOrder = () => ['shown-order'];
    app.contextFrom = (origin) => origin === 'classic' && owned;
    app.reorderContext = (list, origin) => reorders.push([list[0], origin]);
    app.renderPlaylist(null);
    assert.deepEqual(reorders, [['shown-order', 'classic']]);
    owned = false;
    app.renderPlaylist(null);
    assert.equal(reorders.length, 1, 'a context set elsewhere is left alone');
});
