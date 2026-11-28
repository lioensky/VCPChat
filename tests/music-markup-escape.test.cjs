// 曲目标签、歌单名、WebDAV 文件名都可能带尖括号：渲染出来必须是文字，不能变成元素（音乐窗口能调用 electronAPI）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const EVIL = '<img src=x onerror="window.__pwned=1">';

function load(file, setup, body) {
    const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(file, 'utf8'));
    const app = { stripAudioExtension: (s) => s, renderPlaylist() {}, updateAllCount() {} };
    dom.window.eval(setup).call(null, app);
    return { dom, app, doc: dom.window.document };
}

test('sidebar groups, playlists and the playlist editor render tags as text', () => {
    const { dom, app, doc } = load('Musicmodules/music-sidebar.js', '(app) => setupSidebar(app)',
        '<ul id="pl"></ul><div id="sidebar-category-view"></div><div id="footer"></div><div id="modal-list"></div>');
    Object.assign(app, {
        playlistEl: doc.getElementById('pl'), sidebarFooter: doc.getElementById('footer'), modalSongList: doc.getElementById('modal-list'), modalCount: doc.getElementById('footer'),
        playlist: [{ path: 'D:\\a.flac', title: EVIL, artist: EVIL, album: EVIL, albumArt: "D:\\cov'er.jpg" }],
        customPlaylists: [{ id: '1', name: EVIL, tracks: ['D:\\a.flac'] }],
        editingPlaylistId: '1', modalSearchQuery: ''
    });
    for (const view of ['albums', 'artists', 'playlists']) {
        app.renderSidebarContent(view);
        const view_ = doc.getElementById('sidebar-category-view');
        assert.equal(view_.querySelector('img'), null, view);
        assert.equal(view_.querySelector('.name').textContent, EVIL, view);
    }
    app.renderSidebarContent('albums');
    assert.match(doc.querySelector('#sidebar-category-view .cover').style.backgroundImage, /cov'er\.jpg/);
    app.renderModalSongList();
    assert.equal(doc.getElementById('modal-list').querySelector('img'), null);
    assert.equal(doc.querySelector('.music-modal-song-title').textContent, EVIL);
    assert.equal(dom.window.__pwned, undefined);
    dom.window.close();
});

test('WebDAV server names, errors and file names render as text', async () => {
    const { dom, app, doc } = load('Musicmodules/music-webdav.js', '(app) => setupWebDav(app)',
        '<div id="servers"></div><div id="files"></div><div id="crumb"></div>');
    let listing = { status: 'success', entries: [{ name: EVIL + '.mp3', href: '/m/x.mp3', url: 'http://h/m/x.mp3', isDir: false }] };
    Object.assign(app, {
        webdavServerList: doc.getElementById('servers'), webdavFileList: doc.getElementById('files'), webdavBreadcrumb: doc.getElementById('crumb'),
        webdavServers: [{ id: '"x', name: EVIL, url: 'http://h' }],
        api: { listWebdavDirectory: async () => listing }
    });
    app.activeWebDavServer = app.webdavServers[0];
    app.renderWebDavServerList();
    assert.equal(doc.getElementById('servers').querySelector('img'), null);
    assert.equal(doc.querySelector('.webdav-server-name').textContent, EVIL);
    await app.browseWebDav('/m');
    assert.equal(doc.getElementById('files').querySelector('img'), null);
    assert.equal(doc.querySelector('.webdav-file-name').textContent, EVIL + '.mp3');
    listing = { status: 'error', message: EVIL };
    await app.browseWebDav('/m');
    assert.equal(doc.getElementById('files').querySelector('img'), null);
    assert.equal(dom.window.__pwned, undefined);
    dom.window.close();
});
