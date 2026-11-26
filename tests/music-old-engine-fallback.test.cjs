// 新音乐窗口配旧引擎（还没装新引擎的机器）必须照常工作：
// 旧引擎连上事件连接后不发 hello、频谱是 JSON 文本、/state 没有 cmd_seq、/settings 没有 crossfade_ms。
// 这时窗口要留在轮询模式、不发订阅、不显示淡入淡出设置，播完照常续下一首。
//
// 旧引擎的回应是从总分支上的引擎真实录下来的（tests/fixtures/music-engine/old-engine-protocol.json，
// 录法见 tests/music-window-bench/engine-protocol-record.cjs）。设了 VCP_OLD_ENGINE_BIN 时还会
// 现场启动那个引擎，核对它的回应仍和样本同形。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { WebSocketServer } = require('ws');

const OLD = require('./fixtures/music-engine/old-engine-protocol.json');
const NEW = require('./fixtures/music-engine/new-engine-protocol.json');
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => JSON.parse(JSON.stringify(value));

function classList() {
    const names = new Set();
    return {
        add: (...n) => n.forEach((x) => names.add(x)),
        remove: (...n) => n.forEach((x) => names.delete(x)),
        toggle: (n, force) => { if (force ?? !names.has(n)) names.add(n); else names.delete(n); },
        contains: (n) => names.has(n)
    };
}

// 照着录下的旧引擎回应扮演引擎。云端录的时候没有声卡，is_playing 一直是 false；
// 这里在 /play 之后把它当成真的在播，才能测到播放中的轮询。
async function startFakeEngine(sample, { hello = null } = {}) {
    const requests = [];
    let state = clone(sample.state.json.state);
    const reply = (res, body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            requests.push(req.url);
            const withState = (key, patch) => {
                state = { ...state, ...patch };
                return reply(res, { ...sample[key].json, state });
            };
            if (req.url === '/state') return reply(res, { ...sample.state.json, state });
            if (req.url === '/settings') return reply(res, sample.settings.json);
            if (req.url === '/load') {
                const body = JSON.parse(raw || '{}');
                withState('load', { ...sample.stateAfter.json.state, file_path: body.path, is_playing: false, current_time: 0, duration: 200 });
                // 旧引擎加载好只发一条 load_complete；新引擎先发 loading_progress。
                setTimeout(() => sample.ws.filter((m) => !m.binary).forEach(broadcast), 20);
                return undefined;
            }
            if (req.url === '/play') return withState('play', { is_playing: true, is_paused: false });
            if (req.url === '/pause') return withState('pause', { is_playing: false, is_paused: true });
            if (req.url === '/seek') return withState('seek', { current_time: JSON.parse(raw).position });
            if (req.url === '/save_settings') return reply(res, sample.saveSettings.json);
            return reply(res, { status: 'success' });
        });
    });
    const wss = new WebSocketServer({ server, path: '/ws' });
    const received = [];
    const sockets = new Set();
    const broadcast = (message) => {
        for (const socket of sockets) socket.send(JSON.stringify(message));
    };
    wss.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('message', (data) => received.push(String(data)));
        socket.on('close', () => sockets.delete(socket));
        if (hello) socket.send(JSON.stringify(hello));
        for (const message of sample.wsBeforeLoad) socket.send(JSON.stringify(message));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        base: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        requests, received, broadcast,
        close: () => new Promise((resolve) => {
            for (const socket of sockets) socket.terminate();
            wss.close(); server.close(resolve);
        })
    };
}

function startWindow(engine, { dir = 'Musicmodules' } = {}) {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, { id, textContent: '', style: {}, classList: classList(), options: [], value: '' });
        return elements.get(id);
    };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        WebSocket, ArrayBuffer, DataView, performance,
        requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        IntersectionObserver: class { observe() {} disconnect() {} },
        localStorage: { getItem: () => null, setItem() {} },
        navigator: {},
        addEventListener() {}, removeEventListener() {},
        electronAPI: { getAudioEngineEndpoint: async () => ({ wsUrl: engine.wsUrl }) },
        document: {
            hidden: false, readyState: 'complete', body: { classList: classList() },
            addEventListener() {}, removeEventListener() {},
            getElementById: (id) => (id === 'vocal-visualizer' ? null : element(id)),
            querySelector: () => null,
            createElement: () => ({ getContext: () => null, style: {} })
        }
    });
    vm.runInContext('globalThis.window = globalThis;', context);
    const musicDir = path.join(__dirname, '..', dir);
    // 旧版页面靠 legacy-bridge.js 把写死的 63789 换成引擎实际地址，和真窗口一样先载入它。
    const scripts = dir === 'Musicmodules-legacy' ? ['legacy-bridge.js'] : ['music-app-hooks.js'];
    for (const name of [...scripts, 'music-lyrics.js', 'music-player.js', 'music-visualizer.js']) {
        vm.runInContext(fs.readFileSync(path.join(musicDir, name), 'utf8'), context, { filename: name });
    }
    // music.js 是一个大闭包，只取出和引擎状态有关的两段。
    const musicJs = fs.readFileSync(path.join(musicDir, 'music.js'), 'utf8');
    const stateStart = musicJs.indexOf('app.updateUIWithState = ');
    const stateEnd = musicJs.indexOf('const syncInitialSettings');
    const fadeStart = musicJs.indexOf('// 旧引擎不认识 crossfade_ms');
    const fadeEnd = musicJs.indexOf('app.setPlayMode = ');
    assert.ok(stateStart > 0 && stateEnd > stateStart, 'music.js sections moved');
    // 旧版页面没有淡入淡出设置。
    const fadeBody = fadeStart > 0 && fadeEnd > fadeStart ? musicJs.slice(fadeStart, fadeEnd).replace(/\};\s*$/, '') : '';
    vm.runInContext(`function setupState(app) { ${musicJs.slice(stateStart, stateEnd)} }
        function syncCrossfade(app, s) { ${fadeBody} }`, context);

    const call = async (route, method = 'GET', body) => {
        const res = await fetch(engine.base + route, {
            method, headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        return res.json();
    };
    const track = (name) => ({ path: `C:/music/${name}.flac`, title: name, artist: 'x', duration: 200 });
    const loads = [];
    const app = {
        audioEngineWsUrl: engine.wsUrl,
        currentVisualizerData: [], targetVisualizerData: [],
        lyricsRequestToken: 0, pendingLoadRequestId: 0,
        lyricsList: { innerHTML: '', style: {}, children: [] }, lyricsContainer: null,
        currentLyrics: [], lyricSpeedFactor: 1, lyricOffset: 0,
        lastKnownDuration: 0, lastKnownCurrentTime: 0, lastStateUpdateTime: 0,
        playlist: [track('a'), track('b'), track('c')],
        playModes: ['repeat', 'repeat_one', 'shuffle'], currentPlayMode: 0, shuffleQueue: [],
        currentTrackIndex: 0, isPlaying: false, isTrackLoading: false,
        trackTitle: element('t'), trackArtist: element('ar'), trackBitrate: element('br'),
        albumArt: element('art'), playPauseBtn: element('pp'), progress: element('pr'),
        currentTimeEl: element('ct'), durationEl: element('du'),
        loudnessInfo: element('li'), loudnessCurrentLufs: element('lc'), dynamicLoudnessFactor: element('df'),
        crossfadeSelect: Object.assign(element('crossfade-select'), { options: [{ value: '0' }, { value: '2000' }] }),
        phantomAudio: { paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } },
        stripAudioExtension: (t) => t, formatTime: (s) => String(Math.floor(s)),
        normalizePathForCompare: (p) => (p || '').toLowerCase(),
        fileUrl: (p) => p,
        updateBlurredBackground() {}, renderPlaylist() {}, updateMediaSessionMetadata() {},
        rememberPlayed() {}, publishCapsuleState() {},
        api: {
            cancelMusicPreload: async () => ({ status: 'success' }),
            getMusicLyrics: async () => null,
            searchMusicLyricsCandidates: async () => ({ success: true, candidates: [] }),
            publishMusicGroove() {},
            getMusicState: () => call('/state'),
            getMusicSettings: () => call('/settings'),
            musicLoad: (t) => { loads.push(t.title); return call('/load', 'POST', { path: t.path }); },
            musicPlay: () => call('/play', 'POST'),
            musicPause: () => call('/pause', 'POST'),
            seekMusic: (s) => call('/seek', 'POST', { position: s }),
            saveMusicSettings: (data) => call('/save_settings', 'POST', data),
            musicQueueNext: async () => ({ status: 'success' })
        }
    };
    context.setupLyrics(app);
    context.setupPlayer(app);
    context.setupVisualizer(app);
    context.setupState(app);
    app.startVisualizerAnimation = () => {};
    app.wakeVisualizer = () => {};
    app.renderLyrics = () => {};
    app.handleNeedsPreload = () => {};
    app.syncCrossfade = (s) => context.syncCrossfade(app, s);
    app.loads = loads;
    app.crossfadeSection = element('crossfade-section');
    app.shutdown = () => {
        app.visualizerDestroyed = true;
        app.stopStatePolling();
        app.ws?.close();
    };
    return app;
}

const waitFor = async (check, label, ms = 3000) => {
    const until = Date.now() + ms;
    while (!check()) {
        if (Date.now() > until) assert.fail(`timed out waiting for ${label}`);
        await tick(20);
    }
};

test('old-engine sample really is the old protocol', () => {
    const types = [...OLD.wsBeforeLoad, ...OLD.ws].map((m) => m.type);
    assert.equal(types.includes('hello'), false);
    assert.equal(types.includes('playback_state'), false);
    assert.equal(OLD.ws.some((m) => m.binary), false);
    assert.equal('cmd_seq' in OLD.state.json.state, false);
    assert.equal('crossfade_ms' in OLD.settings.json.settings, false);
    assert.equal(OLD.saveSettings.http, 200, 'old engine accepts a save that carries crossfade_ms');
});

test('with an old engine the window polls, sends no subscribe, hides crossfade, and still continues to the next song', async (t) => {
    const engine = await startFakeEngine(OLD);
    const app = startWindow(engine);
    t.after(async () => { app.shutdown(); await engine.close(); });

    app.connectWebSocket();
    await waitFor(() => app.ws?.readyState === WebSocket.OPEN, 'socket open');
    await tick(150);
    assert.equal(app.enginePush, false, 'no hello: stays on polling');
    assert.deepEqual(engine.received, [], 'nothing is sent to an engine that never said hello');

    app.syncCrossfade((await app.api.getMusicSettings()).settings);
    assert.equal(app.crossfadeSection.style.display, 'none', 'the crossfade setting is hidden: the old engine ignores it');

    await app.loadTrack(0, true);
    await waitFor(() => engine.requests.includes('/play') && !app.isTrackLoading, 'first song started');
    await waitFor(() => app.statePollInterval, 'state polling runs while playing');
    assert.equal(app.isPlaying, true);
    assert.equal(app.lastIssuedCmdSeq, 0, 'replies without cmd_seq leave the sequence untouched');
    const polledBefore = engine.requests.filter((r) => r === '/state').length;
    await tick(1200);
    assert.ok(engine.requests.filter((r) => r === '/state').length >= polledBefore + 2, 'the window keeps asking /state');

    engine.broadcast({ type: 'spectrum_data', data: [0.1, 0.2, 0.3] });
    await waitFor(() => app.targetVisualizerData.length === 3, 'JSON spectrum reaches the visualizer');

    await app.seekTo(42);
    assert.ok(engine.requests.includes('/seek'));
    await app.pauseTrack();
    await waitFor(() => !app.isPlaying, 'paused');
    await app.playTrack();
    await waitFor(() => app.isPlaying, 'resumed');

    engine.broadcast({ type: 'playback_ended' });
    await waitFor(() => app.loads.length === 2 && !app.isTrackLoading && app.statePollInterval, 'next song playing');
    assert.equal(app.isPlaying, true);
    assert.deepEqual(app.loads, ['a', 'b']);
    assert.equal(app.currentTrackIndex, 1);
    assert.equal(app.enginePush, false);
});

test('the same window switches to pushed state when the engine does say hello (so the test above can tell them apart)', async (t) => {
    const hello = { type: 'hello', protocol: 2, features: ['playback_state', 'cmd_seq', 'spectrum_binary'] };
    const engine = await startFakeEngine(OLD, { hello });
    const app = startWindow(engine);
    t.after(async () => { app.shutdown(); await engine.close(); });
    app.connectWebSocket();
    await waitFor(() => app.enginePush === true, 'push mode');
    await waitFor(() => engine.received.length === 1, 'subscribe sent');
    assert.match(engine.received[0], /"spectrum":"binary"/);
});

test('the legacy music page on a new engine ignores hello and pushed state, keeps polling and continuing', async (t) => {
    // 旧版页面（Musicmodules-legacy）要一直能切回去用，所以它配新引擎也得照常放歌。
    const types = NEW.wsBeforeLoad.map((m) => m.type);
    assert.ok(types.includes('hello') && types.includes('playback_state'), 'sample is from a new engine');
    for (const key of Object.keys(OLD.state.json.state)) assert.ok(key in NEW.state.json.state, `/state still has ${key}`);
    for (const key of Object.keys(OLD.settings.json.settings)) assert.ok(key in NEW.settings.json.settings, `/settings still has ${key}`);
    assert.ok(NEW.wsBeforeLoad.some((m) => m.type === 'spectrum_data'), 'spectrum stays JSON until a window subscribes');

    const engine = await startFakeEngine(NEW);
    const app = startWindow(engine, { dir: 'Musicmodules-legacy' });
    t.after(async () => { app.shutdown(); await engine.close(); });
    await tick(10); // 等 legacy-bridge 拿到引擎地址
    app.connectWebSocket();
    await waitFor(() => app.ws?.readyState === WebSocket.OPEN, 'socket open');
    await tick(150);
    assert.deepEqual(engine.received, [], 'the legacy page never subscribes');

    await app.loadTrack(0, true);
    await waitFor(() => engine.requests.includes('/play') && !app.isTrackLoading, 'first song started');
    await waitFor(() => app.statePollInterval, 'legacy page polls');
    engine.broadcast({ ...NEW.wsBeforeLoad.find((m) => m.type === 'playback_state'), is_playing: false });
    engine.broadcast({ type: 'spectrum_data', data: [0.4, 0.5] });
    await waitFor(() => app.targetVisualizerData.length === 2, 'JSON spectrum reaches the legacy visualizer');
    assert.equal(app.isPlaying, true, 'a pushed state the page does not understand changes nothing');

    engine.broadcast({ type: 'playback_ended' });
    await waitFor(() => app.loads.length === 2 && !app.isTrackLoading && app.statePollInterval, 'next song playing');
    assert.deepEqual(app.loads, ['a', 'b']);
});

test('a live old engine still answers in the recorded shape', { skip: !process.env.VCP_OLD_ENGINE_BIN && 'set VCP_OLD_ENGINE_BIN to an old audio_server build' }, async () => {
    const { recordEngine } = require('./music-window-bench/engine-protocol-record.cjs');
    const live = await recordEngine(process.env.VCP_OLD_ENGINE_BIN);
    const keys = (o) => Object.keys(o || {}).sort();
    assert.deepEqual(keys(live.state.json.state), keys(OLD.state.json.state));
    assert.deepEqual(keys(live.settings.json.settings), keys(OLD.settings.json.settings));
    const types = [...live.wsBeforeLoad, ...live.ws].map((m) => (m.binary ? 'binary' : m.type));
    assert.equal(types.includes('hello'), false);
    assert.equal(types.includes('binary'), false);
    assert.ok(types.includes('load_complete'));
    assert.equal(live.saveSettings.http, 200);
});
