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

test('visualizer passes numeric timestamp on frame 0, ignores unrelated body classes while paused, and guards zero/short inputs', async () => {
    const { window, app, stageFrames, run, count } = setup();
    const tickerArgs = [];
    window.PIXI.Ticker.system.update = (ts) => { tickerArgs.push(ts); };
    app.isStageActive = true;
    app.stageHost.active = true;
    app.startVisualizerAnimation();
    assert.equal(typeof stageFrames[0], 'number', 'frame 0 passes numeric timestamp to stageHost.updateFrame');
    assert.equal(typeof tickerArgs[0], 'number', 'frame 0 passes numeric timestamp to PIXI system ticker');

    // Leave stage & let paused loop settle
    app.isStageActive = false;
    app.stageHost.active = false;
    run(4000);
    assert.equal(app.animationFrameId, null);

    // Unrelated body class mutation must not wake paused visualizer
    window.document.body.classList.add('unrelated-modal-open');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(app.animationFrameId, null, 'unrelated body class does not wake paused visualizer');
    assert.equal(count(500), 0);

    // Theme class mutation DOES wake paused visualizer
    window.document.body.classList.add('light-theme');
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(app.animationFrameId !== null, 'light-theme class wakes paused visualizer');

    // drawVisualizer and drawVocalVisualizer guard short/zero inputs cleanly
    let bezierCalls = 0;
    app.visualizerCtx.bezierCurveTo = (...args) => {
        bezierCalls += 1;
        for (const v of args) assert.ok(Number.isFinite(v), 'bezier coord must be finite');
    };
    app.drawVisualizer([0.5]);
    assert.equal(bezierCalls, 0, 'single-bin spectrum skips bezier curve division by zero');
    app.drawVisualizer([0.2, 0.5, 0.8, 0.3]);
    assert.equal(bezierCalls, 3, 'normal spectrum draws N-1 bezier segments with finite coordinates');

    // destroyVisualizer clears _gaplessSwitchTimer and tolerates missing visualizerCanvas
    let cleared = false;
    app._gaplessSwitchTimer = window.setTimeout(() => { cleared = true; }, 50);
    app.visualizerCanvas = null;
    app.destroyVisualizer();
    assert.equal(app._gaplessSwitchTimer, null);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(cleared, false, 'destroyVisualizer cancels pending _gaplessSwitchTimer');
    window.close();
});

test('drawVocalVisualizer caches layout size across 60fps frames and re-measures only on resize/class/visibility dirtying', () => {
    const dom = new JSDOM('<!doctype html><body><canvas id="vocal-visualizer"></canvas></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    try {
        const { window } = dom;
        let widthReads = 0;
        let curW = 320, curH = 60;
        const canvas = window.document.getElementById('vocal-visualizer');
        const noop = () => {};
        canvas.getContext = () => ({ clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop });
        Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => { widthReads += 1; return curW; } });
        Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => curH });
        window.eval(`${source}\nwindow.setupVisualizer = setupVisualizer;`);
        const app = {
            particles: [], PARTICLE_COUNT: 4, easingFactor: 0.2,
            visualizerCanvas: { width: 320, height: 60 },
            visualizerCtx: { clearRect: noop }, visualizerColor: { r: 10, g: 20, b: 30 },
            targetVisualizerData: [], currentVisualizerData: new Array(128).fill(0.25),
            isPlaying: false, isTrackLoading: false, bassScale: 1.0
        };
        window.setupVisualizer(app);
        for (let i = 0; i < 10; i++) app.drawVocalVisualizer();
        assert.equal(widthReads, 1, 'steady-state 60fps vocal frames read clientWidth only once');
        assert.equal(canvas.width, 320);

        curW = 480;
        window.dispatchEvent(new window.Event('resize'));
        app.drawVocalVisualizer();
        app.drawVocalVisualizer();
        assert.equal(widthReads, 2, 'resize marks vocal canvas dirty for exactly one re-measure');
        assert.equal(canvas.width, 480);
        app.destroyVisualizer();
    } finally {
        dom.window.close();
    }
});

test('Batch 58: visualizer deduplicates albumArtWrapper scale transform writes on steady playing frames', () => {
    const { window, app, run } = setup();
    let transformWrites = 0;
    const styleObj = {
        _t: '',
        get transform() { return this._t; },
        set transform(v) { transformWrites += 1; this._t = v; }
    };
    app.albumArtWrapper = { style: styleObj };
    app.COVER_MID_START_RATIO = 0.1;
    app.COVER_MID_END_RATIO = 0.5;
    app.COVER_PULSE_FLOOR = 0.22;
    app.COVER_PULSE_SMOOTHING = 0.5;
    app.COVER_PULSE_INTENSITY = 0.08;
    app.isPlaying = true;
    app.targetVisualizerData = new Array(32).fill(0);
    app.currentVisualizerData = new Array(32).fill(0);
    app.startVisualizerAnimation();
    run(200); // ~12 frames of steady silence (scale stays 1.0000)
    assert.equal(transformWrites, 1, 'steady zero energy writes scale(1.0000) once instead of every frame');
    assert.equal(styleObj._t, 'scale(1.0000)');
    app.destroyVisualizer();
    window.close();
});

test('Batch 68: vocalResizeObserver captures contentRect directly so drawVocalVisualizer resizes with 0 clientWidth reflows', () => {
    const dom = new JSDOM('<!doctype html><body><canvas id="vocal-visualizer"></canvas></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    try {
        const { window } = dom;
        let roCb = null;
        window.ResizeObserver = class {
            constructor(cb) { roCb = cb; }
            observe() {}
            disconnect() {}
        };
        let clientReads = 0;
        const canvas = window.document.getElementById('vocal-visualizer');
        const noop = () => {};
        canvas.getContext = () => ({ clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop });
        Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => { clientReads += 1; return 320; } });
        Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => { clientReads += 1; return 60; } });
        window.eval(`${source}\nwindow.setupVisualizer = setupVisualizer;`);
        const app = {
            particles: [], PARTICLE_COUNT: 4, easingFactor: 0.2,
            visualizerCanvas: { width: 320, height: 60 },
            visualizerCtx: { clearRect: noop }, visualizerColor: { r: 10, g: 20, b: 30 },
            targetVisualizerData: [], currentVisualizerData: new Array(128).fill(0.25),
            isPlaying: false, isTrackLoading: false, bassScale: 1.0
        };
        window.setupVisualizer(app);
        roCb([{ contentRect: { width: 420, height: 72 } }]);
        app.drawVocalVisualizer();
        assert.equal(clientReads, 0, 'ResizeObserver contentRect avoids clientWidth/clientHeight reads');
        assert.equal(canvas.width, 420);
        assert.equal(canvas.height, 72);

        roCb([{ contentRect: { width: 512, height: 84 } }]);
        app.drawVocalVisualizer();
        assert.equal(clientReads, 0, 'subsequent ResizeObserver updates avoid clientWidth/clientHeight reads');
        assert.equal(canvas.width, 512);
        assert.equal(canvas.height, 84);
        app.destroyVisualizer();
    } finally {
        dom.window.close();
    }
});

test('Batch 82: drawVocalVisualizer recurrence matches Math.sin curve accurately and cover pulse respects music-reduce-motion', () => {
    const dom = new JSDOM('<!doctype html><body><canvas id="vocal-visualizer"></canvas></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    try {
        const { window } = dom;
        const canvas = window.document.getElementById('vocal-visualizer');
        const points = [];
        let curWave = null;
        canvas.getContext = () => ({
            clearRect() {},
            beginPath() { curWave = []; points.push(curWave); },
            moveTo(x, y) { curWave.push([x, y]); },
            lineTo(x, y) { curWave.push([x, y]); },
            stroke() {}
        });
        Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => 200 });
        Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => 60 });
        const fixedNow = 1700000000000;
        window.Date.now = () => fixedNow;
        window.eval(`${source}\nwindow.setupVisualizer = setupVisualizer;`);
        const app = {
            particles: [], PARTICLE_COUNT: 4, easingFactor: 0.2,
            visualizerCanvas: { width: 200, height: 60 },
            visualizerCtx: { clearRect() {} }, visualizerColor: { r: 20, g: 140, b: 220 },
            targetVisualizerData: new Array(64).fill(0.5),
            currentVisualizerData: new Array(64).fill(0.5),
            isPlaying: true, isTrackLoading: false, bassScale: 1.0,
            COVER_MID_START_RATIO: 0.1, COVER_MID_END_RATIO: 0.5,
            COVER_PULSE_FLOOR: 0.2, COVER_PULSE_SMOOTHING: 0.5, COVER_PULSE_INTENSITY: 0.1
        };
        window.setupVisualizer(app);
        app.drawVocalVisualizer();
        assert.equal(points.length, app.vocalWaves.length);
        const w = 200;
        const centerY = 30;
        const energyBoost = app.smoothedVocalEnergy * 35;
        let maxErr = 0;
        for (let wi = 0; wi < app.vocalWaves.length; wi += 1) {
            const wave = app.vocalWaves[wi];
            const amp = wave.amplitude + energyBoost;
            const phaseOffset = fixedNow * wave.speed * 0.01 + wave.phase;
            for (const [x, y] of points[wi]) {
                const s = Math.sin((x / w) * Math.PI);
                const expected = centerY + Math.sin(x * wave.frequency + phaseOffset) * amp * Math.fround(s * s);
                maxErr = Math.max(maxErr, Math.abs(y - expected));
            }
        }
        assert.ok(maxErr < 1e-4, `recurrence matches Math.sin within 1e-4 px at epoch timestamps (maxErr=${maxErr})`);
        app.destroyVisualizer();
    } finally {
        dom.window.close();
    }

    // Cover pulse disabled under body.music-reduce-motion
    const { window: w2, app: app2, run } = setup();
    try {
        w2.document.body.classList.add('music-reduce-motion');
        const styleObj = { transform: '' };
        app2.albumArtWrapper = { style: styleObj };
        app2.COVER_MID_START_RATIO = 0.1;
        app2.COVER_MID_END_RATIO = 0.5;
        app2.COVER_PULSE_FLOOR = 0.1;
        app2.COVER_PULSE_SMOOTHING = 0.8;
        app2.COVER_PULSE_INTENSITY = 0.12;
        app2.isPlaying = true;
        app2.targetVisualizerData = new Array(32).fill(0.9);
        app2.currentVisualizerData = new Array(32).fill(0.9);
        app2.startVisualizerAnimation();
        run(120);
        assert.equal(app2.bassScale, 1.0, 'reduce-motion suppresses cover pulse scaling');
        assert.equal(styleObj.transform, '', 'reduce-motion skips cover pulse transform writes');
        app2.destroyVisualizer();
    } finally {
        w2.close();
    }
});

test('Batch 86: drawVisualizer rolling-window Catmull-Rom Bezier matches exact reference control points', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    try {
        const { window } = dom;
        const curves = [];
        let firstLine = null;
        const ctx = {
            clearRect() {},
            createLinearGradient() { return { addColorStop() {} }; },
            beginPath() {},
            moveTo() {},
            lineTo(x, y) { if (!firstLine) firstLine = [x, y]; },
            bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2) { curves.push([cp1x, cp1y, cp2x, cp2y, x2, y2]); },
            closePath() {},
            fill() {}
        };
        window.eval(`${source}\nwindow.setupVisualizer = setupVisualizer;`);
        const w = 360, h = 90;
        const app = {
            particles: [], PARTICLE_COUNT: 4, easingFactor: 0.2,
            visualizerCanvas: { width: w, height: h },
            visualizerCtx: ctx,
            visualizerColor: { r: 20, g: 140, b: 220 },
            targetVisualizerData: [], currentVisualizerData: [],
            isPlaying: false, isTrackLoading: false, bassScale: 1.0
        };
        window.setupVisualizer(app);
        const data = [0.1, 0.45, 0.8, 0.35, 0.6, 0.2, 0.9, 0.15];
        app.drawVisualizer(data);
        const n = data.length;
        const sliceWidth = w / (n - 1);
        const scaleY = h * 1.2;
        const t6 = 0.5 / 6;
        assert.equal(curves.length, n - 1);
        assert.ok(Math.abs(firstLine[0] - 0) < 1e-9 && Math.abs(firstLine[1] - (h - data[0] * scaleY)) < 1e-9);
        for (let i = 0; i < n - 1; i += 1) {
            const x1 = i * sliceWidth, y1 = h - data[i] * scaleY;
            const x2 = (i + 1) * sliceWidth, y2 = h - data[i + 1] * scaleY;
            const prevX = i > 0 ? (i - 1) * sliceWidth : x1;
            const prevY = i > 0 ? h - data[i - 1] * scaleY : y1;
            const nextX = i < n - 2 ? (i + 2) * sliceWidth : x2;
            const nextY = i < n - 2 ? h - data[i + 2] * scaleY : y2;
            const ref = [
                x1 + (x2 - prevX) * t6, y1 + (y2 - prevY) * t6,
                x2 - (nextX - x1) * t6, y2 - (nextY - y1) * t6,
                x2, y2
            ];
            for (let k = 0; k < 6; k += 1) {
                assert.ok(Math.abs(curves[i][k] - ref[k]) < 1e-9, `segment ${i} coord ${k} matches reference`);
            }
        }
        app.destroyVisualizer();
    } finally {
        dom.window.close();
    }
});

test('Batch 104: drawVisualizer caches gradient by integer height/RGB and resets on destroyVisualizer', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    try {
        const { window } = dom;
        let gradCreations = 0;
        const ctx = {
            clearRect() {},
            createLinearGradient() { gradCreations += 1; return { addColorStop() {} }; },
            beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, closePath() {}, fill() {}
        };
        window.eval(`${source}\nwindow.setupVisualizer = setupVisualizer;`);
        const app = {
            particles: [], PARTICLE_COUNT: 4, easingFactor: 0.2,
            visualizerCanvas: { width: 240, height: 80 },
            visualizerCtx: ctx,
            visualizerColor: { r: 20, g: 140, b: 220 },
            targetVisualizerData: [], currentVisualizerData: [],
            isPlaying: false, isTrackLoading: false, bassScale: 1.0
        };
        window.setupVisualizer(app);
        const data = [0.2, 0.5, 0.7, 0.3];
        app.drawVisualizer(data);
        app.drawVisualizer(data);
        app.drawVisualizer(data);
        assert.equal(gradCreations, 1, 'steady height and RGB reuses gradient once');
        app.visualizerColor = { r: 30, g: 140, b: 220 };
        app.drawVisualizer(data);
        assert.equal(gradCreations, 2, 'RGB change rebuilds gradient');
        app.visualizerCanvas.height = 96;
        app.drawVisualizer(data);
        assert.equal(gradCreations, 3, 'height change rebuilds gradient');
        app.destroyVisualizer();
        assert.equal(app._visualizerGradient, null, 'destroyVisualizer clears cached gradient');
    } finally {
        dom.window.close();
    }
});

test('Batch 113: hidden idle visualizer defers WebSocket reconnect until visible, throttles error logs, and cleans up on destroy', () => {
    const { window, app, setHidden } = setup();
    const timers = [];
    const origSetTimeout = window.setTimeout;
    const origClearTimeout = window.clearTimeout;
    const origErr = console.error;
    let errLogs = 0;
    const sockets = [];
    try {
        console.error = () => { errLogs += 1; };
        window.setTimeout = (fn) => { const id = timers.length + 1; timers.push({ id, fn, cleared: false }); return id; };
        window.clearTimeout = (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; };
        window.WebSocket = class FakeSocket {
            constructor() { this.readyState = 0; sockets.push(this); }
            close() { this.readyState = 3; }
        };
        window.WebSocket.OPEN = 1;
        window.WebSocket.CONNECTING = 0;

        app.isPlaying = false;
        setHidden(true);
        app.connectWebSocket();
        assert.equal(sockets.length, 1);
        sockets[0].onerror(new Error('offline'));
        assert.equal(errLogs, 1, 'logs first WebSocket error');
        sockets[0].onclose();
        assert.equal(timers.length, 1, 'schedules backoff reconnect timer');

        // Firing reconnect timer while hidden + paused defers reconnect until visibilitychange
        timers[0].fn();
        assert.equal(sockets.length, 1, 'hidden idle window does not open background WebSocket');
        assert.equal(typeof app._visualizerReconnectOnVisible, 'function');

        // Becoming visible immediately resumes reconnect
        setHidden(false);
        window.document.dispatchEvent(new window.Event('visibilitychange'));
        assert.equal(sockets.length, 2, 'returning visible immediately reconnects WebSocket');
        assert.equal(app._visualizerReconnectOnVisible, null);

        // Subsequent errors between attempt 1..11 throttle console.error spam
        sockets[1].onerror(new Error('offline again'));
        assert.equal(errLogs, 1, 'throttles repeated WebSocket error logs');

        // destroyVisualizer detaches deferred visibility reconnect listener
        setHidden(true);
        sockets[1].onclose();
        timers[timers.length - 1].fn();
        assert.equal(typeof app._visualizerReconnectOnVisible, 'function');
        app.destroyVisualizer();
        assert.equal(app._visualizerReconnectOnVisible, null, 'destroyVisualizer clears deferred visibility reconnect');
        setHidden(false);
        window.document.dispatchEvent(new window.Event('visibilitychange'));
        assert.equal(sockets.length, 2, 'destroyed visualizer does not reconnect on visibilitychange');
    } finally {
        console.error = origErr;
        window.setTimeout = origSetTimeout;
        window.clearTimeout = origClearTimeout;
        window.close();
    }
});
