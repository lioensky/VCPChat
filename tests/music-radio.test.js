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

test('pickSimilar deduplicates duplicate recordings deterministically and dailyMix handles empty stats cleanly', () => {
    const { app } = setup();
    app.musicStats = { top: () => [], lastPlayed: () => [], get: () => null, affinity: () => 0 };
    globalThis.localStorage = { getItem: () => null };
    const mix = app.dailyMix({ size: 12 });
    assert.equal(mix.length, 12);
    const dupLib = [
        { path: '/1.flac', title: 'Same Song', artist: 'A', album: 'X' },
        { path: '/2.flac', title: 'Same Song', artist: 'A', album: 'Y' },
        { path: '/3.flac', title: 'Other', artist: 'B', album: 'Z' }
    ];
    let n = 0;
    const rng = () => ((n += 0.17) % 1);
    const out = pickSimilar(dupLib, [], { size: 5, random: rng });
    assert.equal(out.length, 2, 'duplicate title+artist collapses to one recording');
    assert.equal(new Set(out.map((t) => t.title)).size, 2);

    // 同录音多版本冲突时懒算 versionRank 仍优先选本地无损高规格版本
    const rankLib = [
        { path: 'https://dav.example/s.flac', title: 'Track.flac', artist: 'A', isRemote: true, lossless: true },
        { path: '/local/s.mp3', title: 'Track.mp3', artist: 'A', bitrate: 320000 },
        { path: '/local/s.flac', title: 'Track.flac', artist: 'A', lossless: true, bitsPerSample: 24, sampleRate: 96000 }
    ];
    const ranked = pickSimilar(rankLib, [], { size: 5, random: () => 0.5 });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].path, '/local/s.flac', 'local high-res lossless beats mp3 and remote');
});

test('isInstrumental prefilter preserves exact matches and avoids false positives', () => {
    const { isInstrumental } = require(path.join(__dirname, '../Musicmodules/music-radio.js'));
    for (const title of [
        'Song (Instrumental).flac',
        'Song (Inst.).mp3',
        'Song [inst]',
        'Song - off vocal.wav',
        'Song (Off-Vocal).flac',
        'Song Karaoke Ver',
        'Song (Backing Track)',
        '晴天 伴奏.flac',
        '夜曲 (纯音乐版)',
        '星 (純音樂)',
        '夏 (カラオケ)',
        '冬 (オフボーカル)'
    ]) {
        assert.equal(isInstrumental({ title }), true, `expected instrumental: ${title}`);
    }
    for (const title of ['Instant Love.flac', 'Instagram.mp3', 'Coffee Shop', 'Office Hours', '晴天.flac', 'Instrument']) {
        assert.equal(isInstrumental({ title }), false, `expected vocal/normal: ${title}`);
    }
});

test('dailyMix avoids redundant localStorage writes when the same day batch is already recorded', () => {
    const store = new Map();
    let setCalls = 0;
    const storage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { setCalls += 1; store.set(k, String(v)); },
        removeItem: (k) => store.delete(k)
    };
    const library = Array.from({ length: 40 }, (_, i) => ({
        path: `D:\\Music\\a${i % 8}\\s${i}.flac`,
        title: `Song ${i}`,
        artist: `Artist ${i % 10}`,
        album: `Album ${i % 8}`
    }));
    const makeApp = () => {
        const app = { playlist: library, currentTrackIndex: -1, playModes: ['repeat'], currentPlayMode: 0, loadTrack: async () => {} };
        setupMusicRadio(app, { storage });
        return app;
    };
    const app1 = makeApp();
    const first = app1.dailyMix({ size: 15 });
    assert.equal(first.length, 15);
    assert.equal(setCalls, 1, 'initial dailyMix records today batch once');

    // 模拟重启窗口：同一天、同一曲库再算一次 dailyMix，不应重复写相同的 localStorage 历史
    const app2 = makeApp();
    const second = app2.dailyMix({ size: 15 });
    assert.deepEqual(second.map((t) => t.path), first.map((t) => t.path));
    assert.equal(setCalls, 1, 'recomputing identical same-day batch skips redundant localStorage write');
});

test('pickSimilar preserves multi-artist diversity caps and setupMusicRadio cleans up autoplay listeners on beforeunload', () => {
    const multiLib = [];
    for (let i = 0; i < 8; i++) {
        multiLib.push({ path: `/m/x/${i}.flac`, title: `X${i}`, artist: 'Alpha feat. Guest', album: `Alb-${i % 2}` });
        multiLib.push({ path: `/m/y/${i}.flac`, title: `Y${i}`, artist: 'Beta / Guest', album: `AlbB-${i % 2}` });
    }
    const out = pickSimilar(multiLib, [multiLib[0]], { size: 12, exclude: new Set([multiLib[0]]), random: () => 0.4 });
    assert.equal(out.length, 12);
    for (let i = 2; i < out.length; i++) {
        const a0 = out[i].artist.split(/\s*(?:\/|feat\.?)\s*/)[0];
        const a1 = out[i - 1].artist.split(/\s*(?:\/|feat\.?)\s*/)[0];
        const a2 = out[i - 2].artist.split(/\s*(?:\/|feat\.?)\s*/)[0];
        assert.ok(!(a0 === a1 && a1 === a2), 'precomputed firstArtist enforces no three-in-a-row');
    }

    const docListeners = new Map();
    const winListeners = new Map();
    const swListeners = new Map();
    const sw = {
        checked: false,
        addEventListener: (t, fn) => swListeners.set(t, fn),
        removeEventListener: (t, fn) => { if (swListeners.get(t) === fn) swListeners.delete(t); }
    };
    const origDoc = globalThis.document;
    const origAdd = globalThis.addEventListener;
    globalThis.document = {
        getElementById: (id) => (id === 'autoplay-switch' ? sw : null),
        addEventListener: (t, fn) => docListeners.set(t, fn),
        removeEventListener: (t, fn) => { if (docListeners.get(t) === fn) docListeners.delete(t); },
        dispatchEvent: (ev) => { const fn = docListeners.get(ev.type); if (fn) fn(ev); }
    };
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
    globalThis.addEventListener = (t, fn) => winListeners.set(t, fn);
    try {
        const store = new Map();
        const app = { playlist: lib, loadTrack: async () => {}, syncTrackIndexByPath() {} };
        setupMusicRadio(app, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
        assert.equal(sw.checked, true);
        assert.ok(swListeners.has('change'));
        assert.ok(docListeners.has('music-autoplay-change'));
        app.autoplay.enabled = false;
        assert.equal(sw.checked, false);
        winListeners.get('beforeunload')?.();
        assert.equal(swListeners.size, 0, 'beforeunload removes autoplay switch change listener');
        assert.equal(docListeners.size, 0, 'beforeunload removes music-autoplay-change listener');
    } finally {
        globalThis.document = origDoc;
        globalThis.addEventListener = origAdd;
    }
});

test('Batch 71: alternateCopy skips non-matching artists via cache, strips audio extensions, and selects highest-ranked playable copy', () => {
    const failed = { path: '/m/a/song.mp3', title: 'Midnight Echo.mp3', artist: 'Artist One', bitrate: 128000 };
    const remoteFlac = { path: 'https://dav.example/song.flac', title: 'Midnight Echo.flac', artist: ' artist one ', isRemote: true, lossless: true };
    const localMp3 = { path: '/m/a/song-320.mp3', title: 'Midnight Echo.mp3', artist: 'ARTIST ONE', bitrate: 320000 };
    const localHiRes = { path: '/m/a/song-hi.flac', title: 'Midnight Echo.flac', artist: 'Artist One', lossless: true, bitsPerSample: 24, sampleRate: 96000 };
    const wrongTitle = { path: '/m/a/other.flac', title: 'Other Track.flac', artist: 'Artist One', lossless: true };
    const otherArtists = Array.from({ length: 200 }, (_, i) => ({
        path: `/m/other/${i}.flac`,
        title: 'Midnight Echo.flac',
        artist: `Other Artist ${i % 20}`,
        lossless: true
    }));
    const store = new Map();
    const app = {
        playlist: [failed, remoteFlac, ...otherArtists, localMp3, wrongTitle, localHiRes],
        currentTrackIndex: 0,
        playModes: ['repeat'],
        currentPlayMode: 0,
        failedTracks: new Map(),
        loadTrack: async () => {}
    };
    setupMusicRadio(app, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });

    assert.equal(app.alternateCopy(failed), localHiRes, 'prefers local hi-res lossless copy with normalized artist & stripped ext');
    app.failedTracks.set(localHiRes, true);
    assert.equal(app.alternateCopy(failed), localMp3, 'skips failed hi-res copy and picks local 320k mp3 over remote');
    app.failedTracks.set(localMp3, true);
    assert.equal(app.alternateCopy(failed), remoteFlac, 'falls back to remote flac when all local copies failed');
    app.failedTracks.set(remoteFlac, true);
    assert.equal(app.alternateCopy(failed), null, 'returns null once every matching copy has failed');
    assert.equal(app.alternateCopy({ path: '/x.flac', title: 'No Artist.flac', artist: '' }), null, 'returns null when artist is empty');
});

test('Batch 92: pickSimilar artist/album/genre memoization matches repeated multi-artist and album tracks deterministically', () => {
    const seed = { path: '/seed.flac', title: 'Seed', artist: 'Alpha / Beta / Gamma', album: 'Shared Album', genre: 'Synthpop' };
    const library = [seed];
    const hitArtists = ['Beta feat. Delta', 'Alpha', 'Gamma'];
    // Repeated artists, albums, and genres exercise artistScoreCache / albumNormCache / genreHitCache
    for (let i = 0; i < 12; i += 1) {
        library.push({
            path: `/hit-${i}.flac`,
            title: `Hit ${i}`,
            artist: hitArtists[i % 3],
            album: i < 4 ? 'Shared Album' : `Other ${i % 3}`,
            genre: i % 3 === 0 ? 'synthpop' : 'Rock'
        });
    }
    for (let i = 0; i < 6; i += 1) {
        library.push({
            path: `/miss-${i}.flac`,
            title: `Miss ${i}`,
            artist: `Unrelated ${i}`,
            album: `Cold ${i}`,
            genre: 'Jazz'
        });
    }
    const picked = pickSimilar(library, [seed], { size: 6, random: () => 0 });
    assert.equal(picked.length, 6);
    assert.ok(picked.every((t) => t.path.startsWith('/hit-')), 'memoized artist/album/genre scoring ranks matching tracks above unrelated tracks');
    // Verify artist cap (ceil(6/3) = 2) still applies using cached firstArtist
    const betaCount = picked.filter((t) => t.artist.startsWith('Beta')).length;
    const alphaCount = picked.filter((t) => t.artist === 'Alpha').length;
    const gammaCount = picked.filter((t) => t.artist === 'Gamma').length;
    assert.ok(betaCount <= 2 && alphaCount <= 2 && gammaCount <= 2, `artistCap respected with cached firstArtist (${alphaCount}/${betaCount}/${gammaCount})`);
});
