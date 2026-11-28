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
    for (const name of ['music-app-hooks.js', 'music-lyrics.js', 'music-player.js']) {
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
    app.vmContext = context;
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
    app.failureSkipDelayMs = 60000;
    const startedAt = Date.now();
    const loading = app.loadTrack(0, true);
    await tick(20);
    app.handleEngineLoadEvent({ type: 'load_error', error: 'unsupported codec' });
    await loading;
    assert.ok(Date.now() - startedAt < 2000, 'must not sit in the polling loop until the timeout');
    assert.equal(app.isTrackLoading, false);
    assert.equal(app.isPlaying, false);
    assert.equal(app.calls.includes('play'), false);
    assert.match(app.trackBitrate.textContent, /加载失败：不支持这种音频格式/);
    app.cancelFailureSkip();
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

// --- 引擎推送（协议 2）---

const hello = { type: 'hello', protocol: 2, features: ['playback_state', 'cmd_seq', 'spectrum_binary', 'streaming'] };
const pushed = (fields) => ({
    type: 'playback_state', state: 'playing', is_playing: true, position: 10, duration: 200,
    file_path: 'C:/music/a.flac', rev: 1, applied_seq: 0, ...fields
});

test('an engine that pushes state turns polling off, and a dropped socket turns it back on', () => {
    const app = setup();
    app.isPlaying = true;
    app.startStatePolling();
    assert.notEqual(app.statePollInterval, null);
    app.handleEngineHello(hello);
    assert.equal(app.statePollInterval, null);
    app.startStatePolling();
    assert.equal(app.statePollInterval, null, 'no polling while pushes arrive');
    app.handleEngineDisconnected();
    assert.notEqual(app.statePollInterval, null, 'falls back to polling an old or vanished engine');
    app.stopStatePolling();
});

test('an older engine without hello keeps polling', () => {
    const app = setup();
    app.handleEnginePlaybackState(pushed({ is_playing: false }));
    assert.equal(app.enginePush, false);
    app.startStatePolling();
    assert.notEqual(app.statePollInterval, null);
    app.stopStatePolling();
});

test('pushed state from before our last command is ignored', async () => {
    const app = setup({ musicPlay: async () => ({ status: 'success', state: { cmd_seq: 7 } }) });
    app.handleEngineHello(hello);
    await app.playTrack();
    assert.equal(app.isPlaying, true);
    app.handleEnginePlaybackState(pushed({ rev: 2, applied_seq: 6, state: 'stopped', is_playing: false }));
    assert.equal(app.isPlaying, true, 'state from before the play command must not flip the button back');
    app.handleEnginePlaybackState(pushed({ rev: 3, applied_seq: 7, position: 42 }));
    assert.equal(app.isPlaying, true);
    assert.equal(app.lastKnownCurrentTime, 42);
});

test('a push that lands while the command is in flight is applied once the command returns', async () => {
    const reply = deferred();
    const app = setup({ musicPlay: () => reply.promise });
    app.handleEngineHello(hello);
    const playing = app.playTrack();
    await tick(1);
    // 引擎执行了播放但没有输出设备，立刻停了；HTTP 回包比推送晚到。
    app.handleEnginePlaybackState(pushed({ rev: 5, applied_seq: 3, state: 'stopped', is_playing: false }));
    assert.equal(app.isPlaying, true, 'held while the command is in flight');
    reply.resolve({ status: 'success', state: { cmd_seq: 3 } });
    await playing;
    await tick(1);
    assert.equal(app.isPlaying, false, 'the engine’s confirmed state wins over the optimistic button');
});

test('buffering is shown while the streamed track waits for the decoder', () => {
    const app = setup();
    app.handleEngineHello(hello);
    app.handleEnginePlaybackState(pushed({ rev: 1, state: 'buffering' }));
    assert.equal(app.isBuffering, true);
    assert.equal(app.isPlaying, true, 'buffering is still playing, not paused');
    app.handleEnginePlaybackState(pushed({ rev: 2, state: 'playing' }));
    assert.equal(app.isBuffering, false);
});

test('binary spectrum frames decode to the same array the JSON frames carried', () => {
    const source = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-visualizer.js'), 'utf8');
    const start = source.indexOf('app.decodeEngineBinaryFrame = ');
    const end = source.indexOf('app.destroyVisualizer = ');
    assert.ok(start > 0 && end > start);
    const app = {};
    vm.runInNewContext(source.slice(start, end), { app, DataView, ArrayBuffer, Array });
    const bins = [0.5, 0.25, 1];
    const buffer = new ArrayBuffer(4 + bins.length * 4);
    const view = new DataView(buffer);
    view.setUint8(0, 1); view.setUint8(1, 1); view.setUint16(2, bins.length, true);
    bins.forEach((v, i) => view.setFloat32(4 + i * 4, v, true));
    // 跨 vm 上下文的数组原型不同，比较结构即可。
    assert.equal(JSON.stringify(app.decodeEngineBinaryFrame(buffer)), JSON.stringify({ type: 'spectrum_data', data: bins }));
    view.setUint8(0, 9);
    assert.equal(app.decodeEngineBinaryFrame(buffer), null, 'unknown frame kinds are ignored');
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

// 放不了的歌：提示「跳过」并自己跳下一首；连续几首都放不了就停下。
function failingSetup(broken, extra = {}) {
    const toasts = [];
    const app = setup({
        musicLoad: async t => {
            app.calls.push(`load:${t.title}`);
            app.lastLoadedPath = t.path;
            return broken.has(t.title) ? { status: 'error', message: '文件不存在' } : { status: 'success', state: {} };
        },
        getMusicState: async () => ({
            status: 'success',
            state: { file_path: app.lastLoadedPath, is_loading: false, is_playing: false, current_time: 0, duration: 200 }
        }),
        ...extra
    });
    app.playlist = ['a', 'b', 'c', 'd', 'e'].map(title => ({ path: `C:/music/${title}.flac`, title, artist: 'x' }));
    app.playModes = ['repeat', 'repeat-one', 'shuffle'];
    app.currentPlayMode = 0;
    app.engineTrackPath = null;
    app.failureSkipDelayMs = 30;
    app.vmContext.MusicToast = {
        show: opts => { toasts.push(opts); return { close() {}, update() {} }; },
        dismiss: id => { toasts.push({ dismissed: id }); }
    };
    app.toasts = toasts;
    app.shown = () => toasts.filter(t => t.message);
    return app;
}
const loads = app => app.calls.filter(c => c.startsWith('load:')).map(c => c.slice(5));

test('a track that cannot be loaded offers to skip and moves on by itself', async t => {
    const app = failingSetup(new Set(['a']));
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, true);
    const toast = app.shown().at(-1);
    assert.match(toast.message, /无法播放「a」.*文件不存在/);
    assert.equal(toast.action.label, '跳过');
    assert.equal(app.isPlaying, false);
    assert.deepEqual(loads(app), ['a'], 'does not jump before the notice had its time');
    await tick(4200); // 提示层在时，兜底定时器比倒计时多等几秒
    assert.deepEqual(loads(app), ['a', 'b']);
    assert.equal(app.isPlaying, true);
    assert.equal(app.failureStreak, 0, 'a track that plays ends the streak');
});

test('pressing skip on the notice moves on at once, and only once', async t => {
    const app = failingSetup(new Set(['a']));
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, true);
    const { action } = app.shown().at(-1);
    action.run();
    action.run();
    await tick(300);
    assert.deepEqual(loads(app), ['a', 'b']);
});

test('three unplayable tracks in a row stop playback instead of racing through the list', async t => {
    const app = failingSetup(new Set(['a', 'b', 'c', 'd', 'e']));
    delete app.vmContext.MusicToast.show; // 没有提示层时也要能自己跳、自己停
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, true);
    await tick(600);
    assert.deepEqual(loads(app), ['a', 'b', 'c'], 'stops after the third failure');
    assert.equal(app.isPlaying, false);
    assert.match(app.trackBitrate.textContent, /加载失败/);
});

test('the stop after three failures is announced', async t => {
    const app = failingSetup(new Set(['a', 'b', 'c', 'd', 'e']));
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, true);
    for (let i = 0; i < 2; i++) { app.shown().at(-1).action.run(); await tick(250); }
    const last = app.shown().at(-1);
    assert.match(last.message, /连续 3 首无法播放，已停止/);
    assert.equal(last.action, undefined, 'nothing left to skip to');
    await tick(300);
    assert.deepEqual(loads(app), ['a', 'b', 'c']);
});

test('choosing another track while the skip is counting down cancels the skip', async t => {
    const app = failingSetup(new Set(['a']));
    delete app.vmContext.MusicToast.show;
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, true);
    await app.loadTrack(3, true);
    await tick(300);
    assert.deepEqual(loads(app), ['a', 'd'], 'the automatic skip must not pull playback away from the chosen track');
    assert.ok(app.toasts.some(t => t.dismissed === 'playback-failure'), 'the old notice is taken down');
});

test('a track that fails while only being restored is reported but nothing is skipped', async t => {
    const app = failingSetup(new Set(['a']));
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, false);
    await tick(300);
    assert.deepEqual(loads(app), ['a']);
    assert.match(app.shown().at(-1).message, /无法播放「a」/);
    assert.equal(app.shown().at(-1).action, undefined);
    assert.equal(app.failureStreak, 0);
});

test('a play echo that arrives very late, after we already paused again, is not taken for a key press', async t => {
    const app = failingSetup(new Set(['a']));
    app.failureSkipDelayMs = 60000;
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    // 机器很卡：占位音频的事件过了几秒才派发
    app.phantomAudio.play = function () { this.paused = false; return Promise.resolve(); };
    app.phantomAudio.pause = function () { this.paused = true; };
    await app.loadTrack(0, true);
    assert.deepEqual(loads(app), ['a']);
    assert.equal(app.phantomAudio.paused, true);
    app.setNow(Date.now() + 5000);
    app.phantomAudio.onplay();
    app.phantomAudio.onpause();
    await tick(50);
    assert.deepEqual(loads(app), ['a'], 'the failed track must not be loaded again by a stale event');
    assert.equal(app.failureStreak, 1);
});

test('a track that failed is remembered with its reason until it plays again', async t => {
    const failing = new Set(['a']);
    const app = failingSetup(failing);
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip(); });
    await app.loadTrack(0, false);
    const track = app.playlist[0];
    assert.match(app.failedTracks.get(track) || '', /文件不存在/);
    failing.delete('a');
    await app.loadTrack(0, false);
    assert.equal(app.failedTracks.has(track), false, 'playing it again clears the mark');
});

test('a seek to a position that could not be worked out (NaN) is not sent to the engine', async () => {
    const app = setup();
    const before = app.calls.length;
    const result = await app.seekTo(NaN);
    assert.equal(result.status, 'error');
    assert.equal(app.calls.slice(before).some(c => c.startsWith('seek')), false, 'the engine would read NaN as 0 and restart the song');
    await app.seekTo(12);
    assert.ok(app.calls.slice(before).some(c => c.startsWith('seek')));
});

test('a gapless switch restarts the playback clock and clears an old failure mark', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    app.playModes = ['repeat'];
    app.currentPlayMode = 0;
    app.shuffleQueue = [];
    app.fileUrl = p => p;
    app.playlist[1].duration = 245;
    // 第二首上次没加载成功，标灰过
    app.failedTracks.set(app.playlist[1], '加载超时');
    app.isPlaying = true;
    app.lastKnownCurrentTime = 190;
    app.lastStateUpdateTime = Date.now();
    app.syncTrackIndexByPath('C:/music/b.flac');
    assert.equal(app.currentTrackIndex, 1);
    assert.equal(app.lastKnownCurrentTime, 0, 'lyrics and progress start from the top of the new song');
    assert.equal(app.durationEl.textContent, '245');
    assert.equal(app.progress.style.width, '0%');
    assert.equal(app.failedTracks.has(app.playlist[1]), false, 'it played, so it is not broken');
});

test('a gapless switch reported with a different path spelling still finds the song by file name', async t => {
    const app = setup();
    t.after(() => app.stopStatePolling());
    app.playModes = ['repeat'];
    app.currentPlayMode = 0;
    app.shuffleQueue = [];
    app.syncTrackIndexByPath('\\\\?\\D:/elsewhere/B.FLAC');
    assert.equal(app.currentTrackIndex, 1);
});

// 引擎进程退出（崩溃、被杀）：以前每次查询都失败也没人管，按钮一直是「在播」、进度照走，其实没声音。
test('when the engine stops answering while playing, the player stops and says why', async t => {
    let alive = true;
    const app = setup({
        getMusicState: async () => (alive ? readyState({ is_playing: true }) : { status: 'error', message: 'fetch failed' })
    });
    const notices = [];
    app.showPlaybackNotice = (m) => notices.push(m);
    t.after(() => app.stopStatePolling());
    await app.playTrack();
    await tick(20);
    assert.equal(app.isPlaying, true);
    alive = false;
    for (let i = 0; i < 4; i++) await app.pollState();
    assert.equal(app.isPlaying, false, 'the button no longer claims it is playing');
    assert.equal(notices.length, 1, 'said once, not on every poll');
    assert.match(notices[0], /连不上音频引擎/);
    for (let i = 0; i < 4; i++) await app.pollState();
    assert.equal(notices.length, 1);
    // 主进程把引擎重新拉起来以后，按播放是重新加载这首，不是对着空引擎发「播放」
    alive = true;
    app.calls.length = 0;
    await app.playTrack();
    assert.deepEqual(app.calls.slice(0, 1), ['load:a']);
});

test('an engine that came back empty after a restart gets the track loaded again on play', async t => {
    let reloaded = false;
    const app = setup({
        getMusicState: async () => (reloaded ? readyState() : { status: 'success', state: { file_path: null, is_loading: false, is_playing: false, current_time: 0, duration: 0 } }),
        musicLoad: async (t) => { app.calls.push(`load:${t.title}`); reloaded = true; return { status: 'success', state: {} }; }
    });
    t.after(() => app.stopStatePolling());
    await app.pollState();
    app.calls.length = 0;
    await app.playTrack();
    assert.equal(app.calls[0], 'load:a', 'play reloads instead of sending play to an empty engine');
});

// 引擎进程没了的时候切歌：不是歌的问题，不能把好好的歌标成坏文件、再自动跳下一首（下一首也一样失败）。
test('a load that fails because the engine is gone does not mark the song broken or skip', async t => {
    const app = setup({ musicLoad: async () => ({ status: 'error', message: 'fetch failed' }) });
    const notices = [];
    app.showPlaybackNotice = (m) => notices.push(m);
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip?.(); });
    await app.loadTrack(1, true);
    assert.equal(app.failedTracks.has(app.playlist[1]), false, 'the song is not greyed out as broken');
    assert.equal(app.currentTrackIndex, 1);
    await tick(30);
    assert.equal(app.currentTrackIndex, 1, 'no automatic skip to the next song');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /加载中断：连不上音频引擎/);
});

test('when the engine dies in the middle of a load, the wait ends early with the same message', async t => {
    const app = setup({ getMusicState: async () => ({ status: 'error', message: 'fetch failed' }) });
    const notices = [];
    app.showPlaybackNotice = (m) => notices.push(m);
    t.after(() => { app.stopStatePolling(); app.cancelFailureSkip?.(); });
    const started = Date.now();
    await app.loadTrack(1, true);
    assert.ok(Date.now() - started < 8000, 'does not sit out the 12 second load timeout');
    assert.equal(app.isTrackLoading, false);
    assert.equal(app.failedTracks.has(app.playlist[1]), false);
    assert.match(notices[0] || '', /加载中断：连不上音频引擎/);
});

// 推送连接断开那几秒里正好放完：playback_ended 只发给当时连着的客户端，丢了就停在结尾不往下走。
test('a song that ends while the push connection is down still moves on, and only once', async t => {
    let ended = false;
    const app = setup({
        getMusicState: async () => readyState(app.lastLoadedPath === 'C:/music/b.flac'
            ? { is_playing: true, current_time: 1, duration: 180, file_path: 'C:/music/b.flac' }
            : ended ? { is_playing: false, current_time: 200, duration: 200 } : { is_playing: true, current_time: 199.4, duration: 200 })
    });
    app.playModes = app.playModes || ['repeat'];
    app.currentPlayMode = app.currentPlayMode || 0;
    t.after(async () => { await tick(300); app.stopStatePolling(); app.cancelFailureSkip?.(); });
    await app.playTrack();
    app.stopStatePolling(); // 下面手动一次次轮询
    await tick(5);
    await app.pollState();
    assert.equal(app.isPlaying, true);
    app.calls.length = 0;
    ended = true;
    await app.pollState();
    // 同一次放完又从另一条路报上来（旧引擎没有推送、但连接上还会发 playback_ended）：不再切一次
    assert.equal(app.handlePlaybackEnded('push'), false);
    await tick(20);
    assert.deepEqual(app.calls.filter(c => c.startsWith('load:')), ['load:b'], 'the next song is loaded');
    app.stopStatePolling();
    await app.pollState();
    assert.deepEqual(app.calls.filter(c => c.startsWith('load:')), ['load:b'], 'and only once');
});

test('with the push connection up, a stopped engine at the end is left to the push event', async t => {
    const app = setup({ getMusicState: async () => readyState({ is_playing: true, current_time: 100, duration: 200 }) });
    app.playModes = ['repeat']; app.currentPlayMode = 0;
    t.after(() => app.stopStatePolling());
    await app.playTrack();
    app.stopStatePolling();
    await tick(5);
    await app.pollState();
    app.ws = { readyState: 1 };
    app.api.getMusicState = async () => readyState({ is_playing: false, current_time: 200, duration: 200 });
    app.calls.length = 0;
    await app.pollState();
    assert.deepEqual(app.calls.filter(c => c.startsWith('load:')), []);
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

test('refreshPreload deduplicates retries while preloading, saveSessionTime skips unchanged writes, and gapless switch resets engine progress', async t => {
    let cancelCount = 0;
    let queueNextCount = 0;
    const app = setup({
        cancelMusicPreload: async () => { cancelCount += 1; return { status: 'success' }; },
        queueNextMusicTrack: async () => { queueNextCount += 1; return { status: 'success' }; }
    });
    app.playModes = ['repeat'];
    app.currentPlayMode = 0;
    t.after(() => app.stopStatePolling());

    // 1. saveSessionTime skips unchanged (track, time) writes unless forced
    const storeWrites = [];
    app.vmContext.localStorage = {
        getItem: () => null,
        setItem: (k, v) => storeWrites.push([k, JSON.parse(v)])
    };
    app.lastKnownCurrentTime = 12.34;
    app.saveSessionTime();
    app.saveSessionTime();
    assert.equal(storeWrites.length, 1, 'identical (track, time) should not rewrite localStorage');
    assert.equal(storeWrites[0][1].time, 12.3);
    app.saveSessionTime(true);
    assert.equal(storeWrites.length, 2, 'force=true always persists session time');
    app.lastKnownCurrentTime = 13.0;
    app.saveSessionTime();
    assert.equal(storeWrites.length, 3, 'changed time persists normally');

    // 2. adoptSwitchedTrack (via syncTrackIndexByPath) calls resetEngineProgress
    let resetCalls = 0;
    app.resetEngineProgress = () => { resetCalls += 1; };
    app.publishCapsuleState = () => {};
    app.syncTrackIndexByPath('C:/music/b.flac');
    assert.equal(resetCalls, 1, 'gapless track adoption resets cached engine progress');
    assert.equal(app.currentTrackIndex, 1);

    // 3. refreshPreload deduplicates overlapping retry timers while isPreloadingNext is true
    const pendingTimers = new Map();
    let nextTimerId = 1;
    let clearedCount = 0;
    app.vmContext.setTimeout = (fn) => {
        const id = nextTimerId++;
        pendingTimers.set(id, fn);
        return id;
    };
    app.vmContext.clearTimeout = (id) => {
        if (pendingTimers.delete(id)) clearedCount += 1;
    };
    app.preloadIssuedFor = app.playlist[1].path;
    app.isPreloadingNext = true;
    app.refreshPreload();
    app.refreshPreload();
    app.refreshPreload();
    assert.equal(pendingTimers.size, 1, 'rapid refreshPreload calls keep only a single retry timer');
    assert.equal(clearedCount, 2, 'prior retry timers are cancelled before scheduling replacement');

    app.isPreloadingNext = false;
    const [retryFn] = [...pendingTimers.values()];
    pendingTimers.clear();
    retryFn();
    await tick(10);
    assert.equal(cancelCount, 1);
    assert.equal(queueNextCount, 1);
});
