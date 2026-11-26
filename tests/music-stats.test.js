const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 听歌记录：听到一半（或满 4 分钟）算一次，30 秒内换歌算跳过，单曲循环每遍单独算。
const { setupMusicStats, playedEnough } = require(path.join(__dirname, '../Musicmodules/music-stats.js'));

function setup(saved) {
    let t = 1_000_000_000;
    const store = new Map(saved ? [['musicPlayStats', saved]] : []);
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    globalThis.document = { dispatchEvent() {} };
    globalThis.CustomEvent = class { constructor(type, init) { this.detail = init?.detail; } };
    const app = {
        playlist: [{ path: 'C:\\Music\\A.flac', duration: 200 }, { path: 'C:\\Music\\B.flac', duration: 180 }],
        currentTrackIndex: 0, isPlaying: true, isTrackLoading: false, lastKnownDuration: 200, pos: 0,
        playedSeconds: () => app.pos
    };
    const stats = setupMusicStats(app, { now: () => t, storage, setTimer: () => 1, clearTimer() {}, observe: false });
    const play = (sec) => { for (let i = 0; i < sec; i++) { t += 1000; app.pos += 1; stats.tick(); } };
    return { app, stats, play, store, advanceDays: (d) => { t += d * 86400000; } };
}

test('a play counts at half the track; switching within 30 s counts a skip', () => {
    const { app, stats, play } = setup();
    play(99);
    assert.equal(stats.get(app.playlist[0]), null);
    play(2);
    assert.equal(stats.get('c:/music/a.flac').plays, 1);
    app.currentTrackIndex = 1; app.lastKnownDuration = 180; app.pos = 0;
    play(10);
    app.currentTrackIndex = 0; app.lastKnownDuration = 200; app.pos = 0;
    stats.tick();
    assert.equal(stats.get(app.playlist[1]).skips, 1);
    assert.equal(stats.get(app.playlist[1]).plays, 0);
});

test('repeat-one counts each pass, paused time does not count', () => {
    const { app, stats, play } = setup();
    play(150);
    app.pos = 0; stats.tick();
    app.isPlaying = false;
    play(200);
    assert.equal(stats.get(app.playlist[0]).plays, 1);
    app.isPlaying = true;
    play(101);
    assert.equal(stats.get(app.playlist[0]).plays, 2);
});

test('top and forgotten lists, and it survives a reload', () => {
    const first = setup();
    for (let k = 0; k < 3; k++) { first.app.pos = 0; first.stats.tick(); first.play(120); }
    first.app.currentTrackIndex = 1; first.app.lastKnownDuration = 180; first.app.pos = 0; first.play(95);
    assert.deepEqual(first.stats.top(5, { minPlays: 1 }), ['C:\\Music\\A.flac', 'C:\\Music\\B.flac']);
    first.stats.flush();
    const again = setup(first.store.get('musicPlayStats'));
    assert.equal(again.stats.get('C:\\Music\\A.flac').plays, 3);
    assert.deepEqual(again.stats.forgotten(), []);
    again.advanceDays(40);
    assert.deepEqual(again.stats.forgotten(), ['C:\\Music\\A.flac']);
    assert.equal(playedEnough(30, 0), false);
    assert.equal(playedEnough(240, 900), true);
});

test('resume remembers the unfinished track and clears once it ends', () => {
    const { app, stats, play, store } = setup();
    assert.equal(stats.resume(), null);
    play(40);
    stats.flush();
    const r = stats.resume();
    assert.equal(r.track, app.playlist[0]);
    assert.equal(r.position, 40);
    assert.match(store.get('musicPlayResume'), /"position":40/);
    app.pos = 199; stats.tick();
    assert.equal(stats.resume(), null);
});
