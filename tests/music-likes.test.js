const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 「喜欢」存成固定 id 的普通歌单，旧版播放器和歌单视图都认得。
const { setupMusicLikes, LIKED_ID } = require(path.join(__dirname, '../Musicmodules/music-likes.js'));

function setup() {
    const saves = [];
    const events = [];
    globalThis.document = { dispatchEvent: (e) => events.push(e.detail) };
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    const playlist = ['a', 'b', 'c'].map((t) => ({ path: `C:/m/${t}.flac`, title: `${t}.flac` }));
    const app = {
        playlist,
        customPlaylists: [{ id: '1', name: '夜间散步', tracks: [] }],
        saveCustomPlaylists: () => saves.push(JSON.stringify(app.customPlaylists)),
        stripAudioExtension: (s) => s.replace(/\.flac$/, '')
    };
    setupMusicLikes(app);
    return { app, playlist, saves, events };
}

test('liking creates the 喜欢的歌曲 playlist first in the list and saves it', () => {
    const { app, playlist, saves } = setup();
    assert.equal(app.isLiked(playlist[0]), false);
    assert.equal(app.toggleLike(playlist[0]), true);
    assert.equal(app.customPlaylists[0].id, LIKED_ID);
    assert.equal(app.customPlaylists[0].name, '喜欢的歌曲');
    assert.deepEqual(app.customPlaylists[0].tracks, ['C:/m/a.flac']);
    assert.equal(app.isLiked(playlist[0]), true);
    assert.equal(saves.length, 1);
    assert.equal(app.toggleLike(playlist[0]), false);
    assert.equal(app.isLiked(playlist[0]), false);
});

test('newest like goes first; several tracks are all liked unless all already are', () => {
    const { app, playlist, events } = setup();
    app.toggleLike(playlist[0]);
    app.toggleLike([playlist[0], playlist[1]]);
    assert.deepEqual(app.likedPlaylist().tracks, ['C:/m/b.flac', 'C:/m/a.flac']);
    assert.deepEqual(events.at(-1).tracks.map((t) => t.title), ['b.flac'], 'only the changed track is announced');
    app.toggleLike([playlist[0], playlist[1]]);
    assert.deepEqual(app.likedPlaylist().tracks, []);
});

test('an existing liked playlist from an earlier run is reused, not duplicated', () => {
    const { app, playlist } = setup();
    app.customPlaylists.push({ id: LIKED_ID, name: '喜欢的歌曲', tracks: ['C:/m/c.flac'] });
    assert.equal(app.isLiked(playlist[2]), true);
    app.toggleLike(playlist[1]);
    assert.equal(app.customPlaylists.filter((p) => p.id === LIKED_ID).length, 1);
});

test('O(1) liked cache stays accurate after external tracks mutations and array replacement', () => {
    const { app, playlist } = setup();
    app.toggleLike(playlist[0]);
    assert.equal(app.isLiked(playlist[0]), true);
    assert.equal(app.isLiked(playlist[1]), false);
    const liked = app.likedPlaylist();
    liked.tracks.push(playlist[1].path);
    assert.equal(app.isLiked(playlist[1]), true, 'detects external push');
    liked.tracks[0] = playlist[2].path;
    assert.equal(app.isLiked(playlist[0]), false, 'detects in-place head swap');
    assert.equal(app.isLiked(playlist[2]), true);
    liked.tracks = [playlist[0].path];
    assert.equal(app.isLiked(playlist[0]), true, 'detects array replacement');
    assert.equal(app.isLiked(playlist[1]), false);
    assert.equal(app.isLiked(playlist[2]), false);
});

test('Batch 96: batch toggleLike prepends new tracks in newest-first order without duplicates and removes cleanly', () => {
    const { app, playlist, events } = setup();
    app.toggleLike(playlist[0]);
    // Batch like [a, b, c, b]: b and c are new, appended in newest-first order [c, b, a]
    const res = app.toggleLike([playlist[0], playlist[1], playlist[2], playlist[1], null], { quiet: true });
    assert.equal(res, true);
    assert.deepEqual(app.likedPlaylist().tracks, ['C:/m/c.flac', 'C:/m/b.flac', 'C:/m/a.flac']);
    assert.deepEqual(events.at(-1).tracks.map((t) => t.path), ['C:/m/b.flac', 'C:/m/c.flac']);

    // Batch unlike [a, c] keeps only b
    const off = app.toggleLike([playlist[0], playlist[2]], { like: false, quiet: true });
    assert.equal(off, false);
    assert.deepEqual(app.likedPlaylist().tracks, ['C:/m/b.flac']);
});
