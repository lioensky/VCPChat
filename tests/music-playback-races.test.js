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
        phantomAudio: {
            paused: true,
            // 和真实 <audio> 一样：play()/pause() 之后事件是异步派发的。
            play() { if (this.paused) { this.paused = false; setTimeout(() => this.onplay?.(), 20); } return Promise.resolve(); },
            pause() { if (!this.paused) { this.paused = true; setTimeout(() => this.onpause?.(), 20); } }
        },
        stripAudioExtension: t => t, formatTime: s => String(Math.floor(s)),
        normalizePathForCompare: p => (p || '').toLowerCase(),
        updateBlurredBackground() {}, renderPlaylist() {}, updateMediaSessionMetadata() {},
        api: {
            cancelMusicPreload: async () => ({ status: 'success' }),
            getMusicLyrics: async () => null,
            searchMusicLyricsCandidates: async () => ({ success: true, candidates: [] }),
            musicLoad: async t => { calls.push(`load:${t.title}`); app.lastLoadedPath = t.path; return { status: 'success', state: {} }; },
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
    app.phantomAudio.onplay = () => app.handlePhantomAudioEvent('play');
    app.phantomAudio.onpause = () => app.handlePhantomAudioEvent('pause');
    app.engineTrackPath = track.path; // 默认当作第一首已经在引擎里
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
    await tick(5); // 播放指令已经发出、还没回来
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

test('play after a failed load retries the load instead of playing nothing', async t => {
    let ready = false;
    const app = setup({ getMusicState: async () => ready ? readyState() : ({ status: 'success', state: { is_loading: false } }) });
    t.after(() => app.stopStatePolling());
    const loading = app.loadTrack(0, true);
    await tick(20);
    app.handleEngineLoadEvent({ type: 'load_error', error: 'file locked' });
    await loading;
    assert.equal(app.calls.includes('play'), false);

    ready = true;
    await app.playTrack();
    await tick(5);
    assert.deepEqual(app.calls, ['load:a', 'load:a', 'play']);
    assert.equal(app.isPlaying, true);
});

test('skipping quickly through tracks only loads the one the user stops on', async t => {
    const app = setup({ getMusicState: async () => readyState({ file_path: 'C:/music/b.flac' }) });
    t.after(() => app.stopStatePolling());
    app.playlist.push({ path: 'C:/music/c.flac', title: 'c' }, { path: 'C:/music/d.flac', title: 'd' });
    app.loadTrack(0, true);
    await tick(10);
    app.loadTrack(2, true);
    await tick(10);
    app.loadTrack(3, true);
    await tick(10);
    const last = app.loadTrack(1, true);
    await last;
    assert.deepEqual(app.calls.filter(c => c.startsWith('load')), ['load:a', 'load:b']);
});

test('previous returns to the track that was actually playing before', async t => {
    const app = setup({ getMusicState: async () => readyState({ file_path: app.lastLoadedPath }) });
    t.after(() => app.stopStatePolling());
    app.playlist.push({ path: 'C:/music/c.flac', title: 'c' }, { path: 'C:/music/d.flac', title: 'd' });
    app.playModes = ['shuffle']; app.currentPlayMode = 0;
    await app.loadTrack(3, false);
    await app.loadTrack(1, false);
    app.prevTrack();
    assert.equal(app.currentTrackIndex, 1, 'index changes once the load starts');
    await tick(250);
    assert.equal(app.currentTrackIndex, 3);
});

test('previous stays inside the filtered list', async t => {
    const app = setup({ getMusicState: async () => readyState() });
    t.after(() => app.stopStatePolling());
    const c = { path: 'C:/music/c.flac', title: 'c' };
    const d = { path: 'C:/music/d.flac', title: 'd' };
    app.playlist.push(c, d);
    app.currentFilteredTracks = [app.playlist[0], d];
    app.currentTrackIndex = 3;
    app.prevTrack();
    await tick(250);
    assert.equal(app.currentTrackIndex, 0);
});

function effectsApp(api) {
    const app = { eqBands: {}, api };
    vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '../Musicmodules/music-effects.js'), 'utf8') + '\nsetupEffects(app);',
        { app, document: {}, console }
    );
    return app;
}

test('dragging a setting slider sends one request at a time and ends on the last value', async () => {
    const sent = [];
    const gates = [];
    const app = effectsApp({});
    const send = value => app.sendLatest('volume', () => new Promise(resolve => {
        sent.push(value);
        gates.push(resolve);
    }));
    const all = [0.1, 0.2, 0.3, 0.4, 0.5].map(send);
    await tick(5);
    assert.deepEqual(sent, [0.1], 'only one request is in flight');
    gates.shift()();
    await tick(5);
    assert.deepEqual(sent, [0.1, 0.5], 'intermediate values are dropped');
    gates.shift()();
    await Promise.all(all);
    assert.deepEqual(sent, [0.1, 0.5]);
});

test('a song with no lyrics is not searched again right away, and skipped songs are not searched at all', async () => {
    let searches = 0;
    const app = setup({ searchMusicLyricsCandidates: async () => { searches++; return { success: true, candidates: [] }; } });
    app.applyMusicLyricsCandidate = async () => ({ success: false });
    app.api.applyMusicLyricsCandidate = async () => ({ success: false });

    const passing = app.fetchAndDisplayLyrics('x', 'passing-by');
    await tick(20);
    const staying = app.fetchAndDisplayLyrics('x', 'staying');
    await Promise.all([passing, staying]);
    assert.equal(searches, 1, 'only the song the user stayed on is searched');

    await app.fetchAndDisplayLyrics('x', 'staying');
    assert.equal(searches, 1, 'a fresh miss is remembered');
    assert.match(app.lyricsList.innerHTML, /暂无歌词/);
});

const playingState = (extra = {}) => readyState({ is_playing: true, ...extra }).state;

test('our own play and pause calls on the media-key audio element are not mistaken for key presses', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    await app.playTrack();
    // 播放事件还没派发，界面就又被切回暂停，再切回播放：旧实现里这些迟到的事件会互相触发，停不下来。
    app.applyPlayingUi(false);
    app.applyPlayingUi(true);
    app.applyPlayingUi(false);
    await tick(120);
    assert.deepEqual(app.calls, ['play'], 'late echo events must not send anything to the engine');
    assert.equal(app.isPlaying, false);
});

test('a real media key press still pauses and resumes', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    await app.playTrack();
    await tick(60);
    app.phantomAudio.paused = true; // 系统媒体键直接暂停了占位音频
    app.phantomAudio.onpause();
    await tick(30);
    assert.equal(app.isPlaying, false);
    app.phantomAudio.paused = false;
    app.phantomAudio.onplay();
    await tick(60);
    assert.equal(app.isPlaying, true);
    assert.deepEqual(app.calls, ['play', 'pause', 'play']);
});

test('a storm of media events cannot flood the engine', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    await app.playTrack();
    await tick(60);
    for (let i = 0; i < 500; i++) {
        app.phantomAudio.paused = i % 2 === 0;
        app.handlePhantomAudioEvent(i % 2 === 0 ? 'pause' : 'play');
    }
    await tick(60);
    assert.ok(app.calls.length <= 6, `engine got ${app.calls.length} commands`);
});

test('hammering play and pause while the engine is busy keeps at most one command waiting', async t => {
    const gate = deferred();
    const arrived = [];
    const app = setup({
        musicPlay: async () => { arrived.push('play'); await gate.promise; return { status: 'success' }; },
        musicPause: async () => { arrived.push('pause'); await gate.promise; return { status: 'success' }; }
    });
    t.after(() => app.stopStatePolling());
    const pending = [app.playTrack()];
    await tick(5); // 第一条已经发给引擎，引擎还没回
    for (let i = 0; i < 200; i++) pending.push(i % 2 === 0 ? app.pauseTrack() : app.playTrack());
    pending.push(app.pauseTrack());
    await tick(5);
    gate.resolve();
    await Promise.all(pending);
    assert.deepEqual(arrived, ['play', 'pause'], 'the first command and the final one');
    assert.equal(app.isPlaying, false);
});

test('the button stays on playing while the engine is still opening its output', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    app.setNow(1000);
    await app.playTrack();
    await tick(40); // 让占位音频的 play 事件先派发完，再拨动时钟
    // 引擎要等输出流建好才报 is_playing，这里拖了 3 秒
    for (const at of [1500, 2000, 2500, 3000, 3500, 4000]) {
        app.setNow(at);
        app.updateUIWithState(readyState({ current_time: 0 }).state);
        assert.equal(app.isPlaying, true, `flipped to paused at ${at}`);
    }
    app.setNow(4500);
    app.updateUIWithState(playingState({ current_time: 0.3 }));
    assert.equal(app.isPlaying, true);
});

test('progress that keeps moving counts as playing even when the engine flag says otherwise', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    app.setNow(1000);
    await app.playTrack();
    await tick(40); // 让占位音频的 play 事件先派发完，再拨动时钟
    app.setNow(8000);
    app.updateUIWithState(playingState({ current_time: 7 }));
    for (let i = 1; i <= 10; i++) {
        app.setNow(8000 + i * 500);
        app.updateUIWithState(readyState({ is_playing: false, current_time: 7 + i * 0.5 }).state);
        assert.equal(app.isPlaying, true);
    }
});

test('playback that really stopped flips the button after two polls, not one', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    app.setNow(1000);
    await app.playTrack();
    await tick(40); // 让占位音频的 play 事件先派发完，再拨动时钟
    app.setNow(8000);
    app.updateUIWithState(playingState({ current_time: 7 }));
    app.setNow(8500);
    app.updateUIWithState(readyState({ current_time: 7.2 }).state); // 还在动：算在播
    app.setNow(9000);
    app.updateUIWithState(readyState({ current_time: 7.2 }).state);
    assert.equal(app.isPlaying, true, 'one stalled poll is not enough');
    app.setNow(9500);
    app.updateUIWithState(readyState({ current_time: 7.2 }).state);
    assert.equal(app.isPlaying, false);
    assert.equal(app.statePollInterval, null);
});

test('an engine that reports paused is believed at once after the grace period', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    app.setNow(1000);
    await app.playTrack();
    await tick(40); // 让占位音频的 play 事件先派发完，再拨动时钟
    app.setNow(8000);
    app.updateUIWithState(playingState({ current_time: 7 }));
    app.setNow(8500);
    app.updateUIWithState(readyState({ is_paused: true, current_time: 7.5 }).state);
    app.setNow(9000);
    app.updateUIWithState(readyState({ is_paused: true, current_time: 8 }).state);
    assert.equal(app.isPlaying, false, 'paused wins even if the clock still creeps');
});
test('loading intent does not advance the clock or send pause; readiness uses the accepted target', async t => {
    const canonical = 'D:/library/a.flac';
    const firstPoll = deferred();
    const app = setup({
        musicLoad: async () => ({ status: 'success', accepted_path: canonical }),
        getMusicState: async () => {
            if (++polls === 1) {
                firstPoll.resolve();
                return readyState(); // old track, same basename, different physical path
            }
            return readyState({ file_path: canonical });
        }
    });
    let polls = 0;
    t.after(() => app.stopStatePolling());
    const pending = app.loadTrack(0, true);
    await firstPoll.promise;
    assert.equal(app.isPlaying, false);
    assert.equal(app.phantomAudio.paused, true);
    assert.equal(app.playPauseBtn.classList.contains('is-playing'), true);
    await app.toggleTransport();
    assert.equal(app.playIntent, false);
    await pending;
    assert.equal(polls, 2);
    assert.equal(app.engineTrackPath, app.playlist[0].path);
    assert.deepEqual(app.calls, []);
    assert.equal(app.lastKnownCurrentTime, 0);
});
