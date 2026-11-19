const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function classList() {
    const names = new Set();
    return {
        add: (...n) => n.forEach(x => names.add(x)),
        remove: (...n) => n.forEach(x => names.delete(x)),
        toggle: (n, force) => { if (force) names.add(n); else names.delete(n); },
        contains: n => names.has(n)
    };
}

function setup(api = {}) {
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        document: { body: { classList: classList() } },
        navigator: {}
    });
    vm.runInContext('globalThis.__now = 0; const realNow = Date.now; Date.now = () => globalThis.__now || realNow();', context);
    for (const name of ['music-lyrics.js', 'music-player.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules', name), 'utf8'), context);
    }
    // updateUIWithState 定义在 music.js 的大闭包里，单独取出来和播放逻辑一起测。
    const musicJs = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
    const start = musicJs.indexOf('app.updateUIWithState = ');
    const end = musicJs.indexOf('const syncInitialSettings');
    assert.ok(start > 0 && end > start, 'updateUIWithState not found in music.js');
    vm.runInContext(`function setupState(app) { ${musicJs.slice(start, end)} }`, context);

    const calls = [];
    const track = { path: 'C:/music/a.flac', title: 'a', artist: 'x' };
    const element = () => ({ textContent: '', style: {}, classList: classList() });
    const app = {
        calls,
        lyricsRequestToken: 0, pendingLoadRequestId: 0,
        lyricsList: { innerHTML: '', style: {}, children: [] },
        lyricsContainer: null,
        currentLyrics: [], lyricSpeedFactor: 1, lyricOffset: 0,
        lastKnownDuration: 0, lastKnownCurrentTime: 0, lastStateUpdateTime: 0,
        playlist: [track, { path: 'C:/music/b.flac', title: 'b', artist: 'x' }],
        currentTrackIndex: 0, isPlaying: false, isTrackLoading: false,
        trackTitle: element(), trackArtist: element(), trackBitrate: element(),
        albumArt: element(), playPauseBtn: element(), progress: element(),
        currentTimeEl: element(), durationEl: element(),
        loudnessInfo: element(), loudnessCurrentLufs: element(), dynamicLoudnessFactor: element(),
        phantomAudio: { play: async () => {}, pause() {} },
        stripAudioExtension: t => t, formatTime: s => String(Math.floor(s)),
        normalizePathForCompare: p => (p || '').toLowerCase(),
        updateBlurredBackground() {}, renderPlaylist() {}, updateMediaSessionMetadata() {},
        api: {
            cancelMusicPreload: async () => ({ status: 'success' }),
            getMusicLyrics: async () => null,
            searchMusicLyricsCandidates: async () => ({ success: true, candidates: [] }),
            musicLoad: async t => { calls.push(`load:${t.title}`); return { status: 'success', state: {} }; },
            musicPlay: async () => { calls.push('play'); return { status: 'success' }; },
            musicPause: async () => { calls.push('pause'); return { status: 'success' }; },
            seekMusic: async s => { calls.push(`seek:${s}`); return { status: 'success' }; },
            getMusicState: async () => ({ status: 'success', state: { file_path: null, is_loading: true } }),
            ...api
        }
    };
    context.setupLyrics(app);
    context.setupPlayer(app);
    context.setupState(app);
    app.renderLyrics = () => {};
    app.setNow = value => { context.__now = value; };
    return app;
}

const readyState = (extra = {}) => ({
    status: 'success',
    state: { file_path: 'C:/music/a.flac', is_loading: false, is_playing: false, current_time: 0, duration: 200, ...extra }
});

test('pausing while a track is still loading cancels the automatic start', async t => {
    const gate = deferred();
    const app = setup({ getMusicState: async () => { await gate.promise; return readyState(); } });
    t.after(() => app.stopStatePolling());
    const loading = app.loadTrack(0, true);
    await tick(5);
    assert.equal(app.isTrackLoading, true);
    await app.pauseTrack();
    gate.resolve();
    await loading;
    await tick(5);
    assert.equal(app.calls.includes('play'), false, 'engine must not be told to play after the user paused');
    assert.equal(app.isPlaying, false);
});

test('pressing play while a track is still loading starts it once ready', async t => {
    const gate = deferred();
    const app = setup({ getMusicState: async () => { await gate.promise; return readyState(); } });
    t.after(() => app.stopStatePolling());
    const loading = app.loadTrack(0, false);
    await tick(5);
    await app.playTrack();
    assert.equal(app.calls.includes('play'), false, 'nothing is sent before the engine has the track');
    gate.resolve();
    await loading;
    await tick(5);
    assert.equal(app.calls.filter(c => c === 'play').length, 1);
    assert.equal(app.isPlaying, true);
});

test('play and pause reach the engine in the order they were pressed', async t => {
    const slowPlay = deferred();
    const arrived = [];
    const app = setup({
        musicPlay: async () => { await slowPlay.promise; arrived.push('play'); return { status: 'success' }; },
        musicPause: async () => { arrived.push('pause'); return { status: 'success' }; }
    });
    t.after(() => app.stopStatePolling());
    const playing = app.playTrack();
    assert.equal(app.isPlaying, true, 'button flips immediately');
    const pausing = app.pauseTrack();
    await tick(5);
    slowPlay.resolve();
    await Promise.all([playing, pausing]);
    assert.deepEqual(arrived, ['play', 'pause']);
    assert.equal(app.isPlaying, false);
    assert.equal(app.statePollInterval, null, 'a superseded play must not restart polling');
});

test('a failed play rolls the button back and says why', async () => {
    const app = setup({ musicPlay: async () => ({ status: 'error', message: 'engine down' }) });
    await app.playTrack();
    assert.equal(app.isPlaying, false);
    assert.match(app.trackBitrate.textContent, /engine down/);
});

test('a state reply that was requested before a seek is dropped', async () => {
    const reply = deferred();
    const app = setup({ getMusicState: () => reply.promise });
    app.isPlaying = true;
    app.lastKnownDuration = 200;
    const polling = app.pollState();
    await app.seekTo(120);
    app.stopStatePolling();
    reply.resolve(readyState({ is_playing: true, current_time: 5 }));
    await polling;
    assert.equal(app.lastKnownCurrentTime, 120);
});

test('state polls never overlap', async () => {
    const reply = deferred();
    let requests = 0;
    const app = setup({ getMusicState: () => { requests++; return reply.promise; } });
    const first = app.pollState();
    const second = app.pollState();
    reply.resolve(readyState());
    await Promise.all([first, second]);
    assert.equal(requests, 1);
});

test('an engine load error ends the wait at once and is shown', async () => {
    const app = setup();
    const startedAt = Date.now();
    const loading = app.loadTrack(0, true);
    await tick(20);
    app.handleEngineLoadEvent({ type: 'load_error', error: 'unsupported codec' });
    await loading;
    assert.ok(Date.now() - startedAt < 2000, 'must not sit in the polling loop until the timeout');
    assert.equal(app.isTrackLoading, false);
    assert.equal(app.isPlaying, false);
    assert.equal(app.calls.includes('play'), false);
    assert.match(app.trackBitrate.textContent, /unsupported codec/);
});

test('old-track state arriving during a load does not touch the progress bar', async () => {
    const app = setup();
    app.isTrackLoading = true;
    app.progress.style.width = '0%';
    app.updateUIWithState({ is_playing: false, current_time: 90, duration: 180 });
    assert.equal(app.progress.style.width, '0%');
});

test('resuming after a long pause does not jump the lyric clock forward', async () => {
    const app = setup();
    app.setNow(1000000);
    app.isPlaying = true;
    app.lastKnownCurrentTime = 30;
    app.lastStateUpdateTime = 1000000;
    app.setNow(1001000);
    await app.pauseTrack();
    app.setNow(1061000); // 暂停一分钟
    await app.playTrack();
    app.stopStatePolling();
    const estimated = app.lastKnownCurrentTime + (1061000 - app.lastStateUpdateTime) / 1000;
    assert.ok(Math.abs(estimated - 31) < 0.01, `lyric clock at ${estimated}s, expected 31s`);
});

test('lyric lines are restyled only when the current line changes', () => {
    const app = setup();
    let styleWrites = 0;
    let layoutReads = 0;
    const line = () => {
        const style = new Proxy({}, { set(target, key, value) { styleWrites++; target[key] = value; return true; } });
        return {
            style, classList: classList(), querySelectorAll: () => [],
            get offsetTop() { layoutReads++; return 0; },
            get clientHeight() { layoutReads++; return 30; }
        };
    };
    app.lyricsList.children = Array.from({ length: 80 }, line);
    app.lyricsContainer = { clientWidth: 400, clientHeight: 600 };
    app.currentLyrics = app.lyricsList.children.map((_, i) => ({ time: i * 5, original: `line ${i}` }));
    app.currentLyricIndex = -1;
    app.isPlaying = true;
    app.setNow(5000000);
    app.lastKnownCurrentTime = 11;
    app.lastStateUpdateTime = 5000000;

    app.animateLyrics();
    assert.equal(app.currentLyricIndex, 2);
    assert.ok(styleWrites >= 80, 'first frame styles every line');

    app.setNow(5001000); // 换行后的字号过渡已结束
    styleWrites = 0;
    layoutReads = 0;
    for (let frame = 0; frame < 60; frame++) app.animateLyrics();
    assert.equal(app.currentLyricIndex, 2);
    assert.equal(styleWrites, 0, 'steady frames must not rewrite per-line styles');
    assert.equal(layoutReads, 0, 'steady frames must not force layout');
});
