// 经典视图列表空着时那句话：曲库是空的就说去哪添加，不能说「没有匹配的曲目」（明明没搜东西）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function load({ library, query = '' }) {
    const dom = new JSDOM('<input id="search-input"><ul id="playlist"></ul>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    window.eval(fs.readFileSync('Musicmodules/music-ui.js', 'utf8'));
    const doc = window.document;
    doc.getElementById('search-input').value = query;
    const app = {
        playlistEl: doc.getElementById('playlist'),
        searchInput: doc.getElementById('search-input'),
        playlist: library,
        currentTrackIndex: -1,
        updateAllCount() {},
        stripAudioExtension: (s) => s,
    };
    window.setupUI(app);
    return { dom, app };
}

test('empty library: the list tells you where to add music', () => {
    const { dom, app } = load({ library: [] });
    app.renderPlaylist();
    assert.match(app.playlistEl.dataset.emptyText || '', /曲库里还没有歌曲/);
    dom.window.close();
});

test('a search with no hits still says nothing matched, and a filled list carries no empty text', () => {
    const { dom, app } = load({ library: [{ title: 'a', path: 'a' }], query: 'zzz' });
    app.renderPlaylist([]);
    assert.equal(app.playlistEl.dataset.emptyText, '没有匹配的曲目');
    app.searchInput.value = '';
    app.renderPlaylist(app.playlist);
    assert.equal(app.playlistEl.dataset.emptyText, undefined);
    dom.window.close();
});

test('the stylesheet shows the text from the list itself', () => {
    const css = fs.readFileSync('Musicmodules/music-theme/music-skin.css', 'utf8');
    assert.match(css, /#playlist\[data-empty-text\]:empty::after\s*\{\s*content:\s*attr\(data-empty-text\)/);
});
