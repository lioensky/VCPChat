const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 电台与自动续播：挑同歌手/同专辑/常听的歌，控制同一歌手占比；一组放到最后一首时接上相似的歌，电台快完时自己续。
const { setupMusicRadio, pickSimilar } = require(path.join(__dirname, '../Musicmodules/music-radio.js'));

const lib = [];
['A', 'B', 'C', 'D'].forEach((artist, a) => {
    for (let k = 0; k < 12; k++) lib.push({ path: `/m/${artist}/${k}.flac`, title: `${artist}${k}`, artist, album: `${artist}-${k % 3}` });
});

test('pickSimilar favours the seed artist but keeps variety', () => {
    const seed = lib[0];
    const out = pickSimilar(lib, [seed], { size: 12, exclude: new Set([seed]), random: () => 0.5 });
    assert.equal(out.length, 12);
    assert.ok(!out.includes(seed));
    const fromA = out.filter((t) => t.artist === 'A').length;
    assert.ok(fromA >= 3 && fromA <= 4, 'seed artist capped at a third: ' + fromA);
    for (let k = 2; k < out.length; k++) assert.ok(!(out[k].artist === out[k - 1].artist && out[k].artist === out[k - 2].artist), 'no three in a row');
    const liked = pickSimilar(lib, [seed], { size: 3, exclude: new Set([seed]), random: () => 0, liked: (t) => t.artist === 'D' });
    assert.ok(liked.some((t) => t.artist === 'D'));
});

function setup({ mode = 'repeat' } = {}) {
    const toasts = [];
    const store = new Map();
    globalThis.document = { dispatchEvent() {} };
    globalThis.CustomEvent = class { constructor(type, init) { this.detail = init?.detail; } };
    globalThis.MusicToast = { show: (t) => toasts.push(t) };
    const app = {
        playlist: lib, currentTrackIndex: 0, playModes: ['repeat', 'repeat-one', 'shuffle'], currentPlayMode: ['repeat', 'repeat-one', 'shuffle'].indexOf(mode),
        currentFilteredTracks: null, playbackContext: null,
        loadTrack: async (i) => { app.currentTrackIndex = i; },
        playFromContext: (list, i) => { app.currentFilteredTracks = list; app.playbackContext = { list }; return app.loadTrack(i); }
    };
    setupMusicRadio(app, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
    return { app, toasts, store };
}

test('autoplay: the last track of a group gets similar songs appended, and the toast can turn it off', async () => {
    const { app, toasts, store } = setup();
    const group = lib.slice(12, 16);
    await app.playFromContext(group, 12);
    assert.equal(app.currentFilteredTracks.length, 4);
    await app.loadTrack(15);
    assert.ok(app.currentFilteredTracks.length > 4);
    assert.deepEqual(app.currentFilteredTracks.slice(0, 4), group);
    assert.ok(!app.currentFilteredTracks.slice(4).some((t) => group.includes(t)));
    toasts.at(-1).action.run();
    assert.equal(app.currentFilteredTracks, group);
    assert.equal(store.get('musicAutoplay'), '0');
    await app.playFromContext(group, 15);
    assert.equal(app.currentFilteredTracks.length, 4);
});

test('no autoplay in repeat-one or for the whole library', async () => {
    const one = setup({ mode: 'repeat-one' });
    await one.app.playFromContext(lib.slice(0, 3), 2);
    assert.equal(one.app.currentFilteredTracks.length, 3);
    const whole = setup();
    await whole.app.loadTrack(lib.length - 1);
    assert.equal(whole.app.currentFilteredTracks, null);
});

test('radio from a track starts with it and refills near the end', async () => {
    const { app } = setup();
    assert.equal(app.startRadio(5), true);
    const list = app.currentFilteredTracks;
    assert.equal(list[0], lib[5]);
    assert.equal(app.currentTrackIndex, 5);
    const n = list.length;
    await app.loadTrack(lib.indexOf(list[n - 2]));
    assert.ok(app.currentFilteredTracks.length > n);
    assert.equal(app.radio.list, app.currentFilteredTracks);
});

test('daily mix is stable within a day and leans on unplayed songs; never-played excludes played ones', () => {
    const { app } = setup();
    const played = new Set(lib.slice(0, 6));
    app.musicStats = {
        top: () => lib.slice(0, 3).map((t) => t.path),
        lastPlayed: () => lib.slice(0, 2).map((t) => t.path),
        get: (t) => (played.has(t) ? { plays: 3 } : null),
        affinity: (t) => (played.has(t) ? 0.5 : 0)
    };
    globalThis.localStorage = { getItem: () => null };
    const a = app.dailyMix();
    const b = app.dailyMix({ size: 30 });
    assert.equal(a, b);
    assert.equal(a.length, 30);
    assert.ok(!a.includes(lib[0]) && !a.includes(lib[1]), 'just-played songs are left out');
    assert.ok(a.filter((t) => !played.has(t)).length >= 10, 'about a third or more are unplayed');
    const fresh = app.neverPlayed({ size: 10 });
    assert.equal(fresh.length, 10);
    assert.ok(fresh.every((t) => !played.has(t)));
});
