const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-visualizer.js'), 'utf8');

// 经典视图的逐帧循环（频谱、封面律动、背景，舞台开着时还负责驱动舞台）：
// 用模拟时钟数它排了多少帧，证明没有东西要画时一帧也不排。
function setup() {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let now = 1000;
    let queue = [];
    let scheduled = 0;
    let hidden = false;
    window.performance.now = () => now;
    window.requestAnimationFrame = (cb) => { scheduled += 1; queue.push(cb); return scheduled; };
    window.cancelAnimationFrame = () => { queue = []; };
    Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
    const ticker = { started: true, autoStart: true, updates: 0, stop() { this.started = false; }, update() { this.updates += 1; } };
    window.PIXI = { Ticker: { system: ticker } };
    window.eval(`${source}\nwindow.setupVisualizer = setupVisualizer;`);
    const noop = () => {};
    const ctx = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => ({ addColorStop: noop })), set: (target, key, value) => { target[key] = value; return true; } });
    const stageFrames = [];
    const app = {
        particles: [], PARTICLE_COUNT: 8, easingFactor: 0.2,
        visualizerCanvas: { width: 400, height: 80, clientWidth: 400, clientHeight: 80 },
        visualizerCtx: ctx, visualizerColor: { r: 1, g: 2, b: 3 },
        targetVisualizerData: [], currentVisualizerData: [],
        isPlaying: false, isTrackLoading: false, bassScale: 1.0,
        COVER_MID_START_RATIO: 0.1, COVER_MID_END_RATIO: 0.4, COVER_PULSE_SMOOTHING: 0.3, COVER_PULSE_INTENSITY: 0.05,
        albumArtWrapper: window.document.createElement('div'),
        animateLyrics: noop, drawVocalVisualizer: noop, updateAmbientPixi: noop,
        isStageActive: false, stageHost: { active: false, updateFrame: (t) => stageFrames.push(t) }
    };
    window.setupVisualizer(app);
    if (typeof app.drawVisualizer !== 'function') app.drawVisualizer = noop;
    const run = (ms) => {
        for (let t = 0; t < ms; t += 16) {
            now += 16;
            const batch = queue; queue = [];
            for (const cb of batch) cb(now);
        }
    };
    const count = (ms) => { const before = scheduled; run(ms); return scheduled - before; };
    return { window, app, ticker, stageFrames, run, count, setHidden: (v) => { hidden = v; } };
}

test('classic view: paused for 2 s schedules no animation frames at all', () => {
    const { app, ticker, run, count } = setup();
    app.startVisualizerAnimation();
    assert.equal(ticker.started, false, 'the graphics library\'s free-running ticker is stopped on the first frame');
    assert.equal(ticker.autoStart, false);
    run(4000); // 刚打开：先画一小会儿背景
    assert.equal(app.animationFrameId, null, 'the loop ends once the opening frames are drawn');
    assert.equal(count(2000), 0, 'nothing is scheduled while paused');

    // 播放：循环回来，图形库的计时器跟着真实帧走
    app.isPlaying = true;
    app.targetVisualizerData = [0.5, 0.6, 0.4, 0.2];
    app.wakeVisualizer();
    const updatesBefore = ticker.updates;
    assert.ok(count(500) > 20, 'playing animates every frame');
    assert.ok(ticker.updates - updatesBefore > 20);

    // 暂停：频谱和封面落回静止后停下
    app.isPlaying = false;
    run(6000);
    assert.equal(app.animationFrameId, null, 'the loop ends after the spectrum settles');
    const idleUpdates = ticker.updates;
    assert.equal(count(2000), 0, 'paused again: zero frames');
    assert.equal(ticker.updates, idleUpdates, 'and the graphics ticker is not advanced either');
});

test('the loop also rests when hidden or covered by the archive page, and keeps driving an open lyric stage', () => {
    const { window, app, stageFrames, run, count, setHidden } = setup();
    const body = window.document.body;
    app.isPlaying = true;
    app.targetVisualizerData = [0.5, 0.6];
    app.startVisualizerAnimation();
    assert.ok(count(500) > 20);

    // 档案页盖住经典视图：播放着也不画
    body.classList.add('music-archive-on');
    run(200);
    assert.equal(count(2000), 0, 'covered by the archive page');
    body.classList.remove('music-archive-on');
    app.wakeVisualizer();
    assert.ok(count(500) > 20, 'back in the classic view it resumes');

    // 窗口不可见
    setHidden(true);
    run(200);
    assert.equal(count(2000), 0, 'hidden window');
    setHidden(false);
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assert.ok(count(500) > 20, 'visible again');

    // 舞台开着：即使暂停、即使在档案页上，舞台的每一帧都靠这条循环
    app.isPlaying = false;
    body.classList.add('music-archive-on');
    app.isStageActive = true;
    app.stageHost.active = true;
    app.wakeVisualizer();
    const before = stageFrames.length;
    assert.ok(count(1000) > 40);
    assert.ok(stageFrames.length - before > 40, 'stage frames keep coming');
    app.isStageActive = false;
    app.stageHost.active = false;
    run(8000);
    assert.equal(count(2000), 0, 'leaving the stage while paused lets it rest again');

    app.destroyVisualizer();
    assert.equal(app._visualizerWakeObserver, null);
});

test('socket onclose and destroyVisualizer skip redundant idle publishMusicGroove IPC', () => {
    const { window, app } = setup();
    const published = [];
    const sockets = [];
    app.api = { publishMusicGroove: (payload) => published.push(payload) };
    window.WebSocket = class FakeSocket {
        constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
        close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;

    app.connectWebSocket();
    assert.equal(sockets.length, 1);
    sockets[0].onclose();
    assert.equal(published.length, 0, 'idle disconnect does not spam publishMusicGroove({ playing: false })');

    app.destroyVisualizer();
    assert.equal(published.length, 0, 'destroy while already idle does not emit redundant groove stop');

    const active = setup();
    const activePublished = [];
    active.app.api = { publishMusicGroove: (payload) => activePublished.push(payload) };
    active.app._lastGroovePlaying = true;
    active.app.destroyVisualizer();
    assert.equal(activePublished.length, 1, 'destroy emits one stop event when groove was playing');
    assert.equal(activePublished[0].playing, false);
    assert.equal(active.app._lastGroovePlaying, false);

    active.app.destroyVisualizer();
    assert.equal(activePublished.length, 1, 'second destroy stays silent');
});
