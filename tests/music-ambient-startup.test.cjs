// 音乐窗口启动时，默认的档案页会接管背景。旧的背景声纹（Pixi WebGL）不能先建好再被档案页立刻拆掉：
// 建一个 WebGL 上下文、编着色器再销毁，是启动时最大的一块白干的活（4 倍降速下约 1 秒）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const made = [];
    class Application {
        constructor() { made.push(this); this.destroyed = false; }
        async init() { this.canvas = { style: {} }; this.stage = { addChild() {} }; this.renderer = { resize() {} }; }
        stop() {}
        render() {}
        destroy() { this.destroyed = true; }
    }
    const container = { innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ width: 800, height: 600 }) };
    const window = {
        PIXI: { Application, Graphics: class { clear() { return this; } } },
        devicePixelRatio: 1,
        addEventListener() {}
    };
    const context = vm.createContext({
        window, queueMicrotask, setTimeout, clearTimeout, console,
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null) }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    return { setup: window.setupAmbientPixi, made };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opening on the archive view never builds the old ambient background', async () => {
    const { setup, made } = load();
    const app = {};
    setup(app);
    // 档案页在同一轮启动代码里接管（archive-view.js 的 init 就是这样做的）
    const original = app.createAmbientPixi;
    app.createAmbientPixi = (...args) => (app.isArchiveActive ? undefined : original(...args));
    app.isArchiveActive = true;
    app.destroyAmbientPixi();
    await settle();
    assert.equal(made.length, 0, 'no WebGL app is created just to be destroyed');
});

test('opening on the classic view still builds it once', async () => {
    const { setup, made } = load();
    const app = {};
    setup(app);
    await settle();
    assert.equal(made.length, 1);
    assert.equal(made[0].destroyed, false);
    assert.ok(app.ambientPixiController?.initialized);
});

test('switching from the archive to the classic view later builds it then', async () => {
    const { setup, made } = load();
    const app = {};
    setup(app);
    const original = app.createAmbientPixi;
    app.createAmbientPixi = (...args) => (app.isArchiveActive ? undefined : original(...args));
    app.isArchiveActive = true;
    await settle();
    app.isArchiveActive = false;
    await original();
    assert.equal(made.length, 1);
});

test('ambient pixi caps resolution in energy-saving mode and cleans up on beforeunload', async () => {
    const made = [];
    const listeners = new Map();
    let removedResize = 0;
    class Application {
        constructor() { made.push(this); this.destroyed = false; this.initOpts = null; }
        async init(opts) { this.initOpts = opts; this.canvas = { style: {} }; this.stage = { addChild() {} }; this.renderer = { resize() {} }; }
        stop() {}
        render() {}
        destroy() { this.destroyed = true; }
    }
    const container = { innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const win = {
        PIXI: { Application, Graphics: class { clear() { return this; } } },
        devicePixelRatio: 2,
        addEventListener: (ev, fn) => listeners.set(ev, fn),
        removeEventListener: (ev) => { if (ev === 'resize') removedResize += 1; },
        requestAnimationFrame: (fn) => { fn(); return 1; },
        cancelAnimationFrame() {}
    };
    const context = vm.createContext({
        window: win, queueMicrotask, setTimeout, clearTimeout, console,
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null), body: { classList: { contains: () => false } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = { currentStageQuality: 'energy-saving' };
    win.setupAmbientPixi(app);
    await settle();
    assert.equal(made.length, 1);
    assert.equal(made[0].initOpts.resolution, 1, 'energy-saving caps Pixi resolution to 1');
    assert.equal(made[0].initOpts.antialias, false, 'energy-saving disables Pixi antialias');
    listeners.get('beforeunload')?.();
    assert.equal(made[0].destroyed, true, 'beforeunload destroys Pixi controller');
    assert.equal(removedResize, 1, 'beforeunload removes window resize listener');
});

test('ambient pixi recovers cleanly after a transient init rejection and clamps large update dt spikes', async () => {
    let attempts = 0;
    const made = [];
    class Application {
        constructor() { made.push(this); this.destroyed = false; }
        async init() {
            attempts += 1;
            if (attempts === 1) throw new Error('transient webgl context failure');
            this.canvas = { style: {} };
            this.stage = { addChild() {} };
            this.renderer = { resize() {} };
        }
        stop() {}
        render() {}
        destroy() { this.destroyed = true; }
    }
    const container = { innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const win = {
        PIXI: {
            Application,
            Graphics: class {
                clear() { return this; }
                circle() { return this; }
                fill() { return this; }
                moveTo() { return this; }
                lineTo() { return this; }
                quadraticCurveTo() { return this; }
                stroke() { return this; }
            }
        },
        devicePixelRatio: 1,
        addEventListener() {},
        removeEventListener() {}
    };
    const context = vm.createContext({
        window: win, queueMicrotask, setTimeout, clearTimeout,
        console: { log() {}, warn() {}, error() {} },
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null), body: { classList: { contains: () => false } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = {};
    win.setupAmbientPixi(app);
    await settle();
    assert.equal(attempts, 1);
    assert.equal(app.ambientPixiController.initialized, false);
    assert.equal(app.ambientPixiController.initPromise, null, 'failed init resets initPromise for retry');
    await app.createAmbientPixi();
    assert.equal(attempts, 2);
    assert.equal(app.ambientPixiController.initialized, true, 'createAmbientPixi retries uninitialized controller and succeeds');
    const beforePhase = app.ambientPixiController.rippleRings[0].phase;
    app.updateAmbientPixi(99);
    const delta = app.ambientPixiController.rippleRings[0].phase - beforePhase;
    assert.ok(delta > 0 && delta < 0.02, `expected clamped dt <= 0.1 (phase delta ~0.01), got ${delta}`);
});

test('Batch 59: createAmbientPixi skips WebGL initialization when container is hidden by CSS or hidden attr', async () => {
    const made = [];
    class Application {
        constructor() { made.push(this); }
        async init() { this.canvas = { style: {} }; this.stage = { addChild() {} }; this.renderer = { resize() {} }; }
        stop() {}
        render() {}
        destroy() {}
    }
    let style = { visibility: 'hidden', display: 'block' };
    const container = { hidden: false, innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const win = {
        PIXI: { Application, Graphics: class { clear() { return this; } } },
        devicePixelRatio: 1,
        addEventListener() {},
        getComputedStyle: () => style
    };
    const context = vm.createContext({
        window: win, queueMicrotask, setTimeout, clearTimeout, console,
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null) }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = {};
    win.setupAmbientPixi(app);
    await settle();
    assert.equal(made.length, 0, 'visibility: hidden container must not spin up a hidden WebGL context');

    style = { visibility: 'visible', display: 'none' };
    await app.createAmbientPixi();
    assert.equal(made.length, 0, 'display: none container must not spin up a hidden WebGL context');

    style = { visibility: 'visible', display: 'block' };
    container.hidden = true;
    await app.createAmbientPixi();
    assert.equal(made.length, 0, 'hidden=true container must not spin up a hidden WebGL context');

    container.hidden = false;
    await app.createAmbientPixi();
    assert.equal(made.length, 1, 'visible container initializes PixiJS once');
});

test('Batch 68: AmbientPixi skips redundant WebGL redraws when paused under reduced motion and redraws on resize/color/play', async () => {
    let renders = 0;
    let clears = 0;
    class Graphics {
        clear() { clears += 1; return this; }
        circle() { return this; }
        fill() { return this; }
        moveTo() { return this; }
        quadraticCurveTo() { return this; }
        lineTo() { return this; }
        stroke() { return this; }
    }
    class Application {
        async init() {
            this.canvas = { style: {} };
            this.stage = { addChild() {} };
            this.renderer = { resize() {} };
        }
        stop() {}
        render() { renders += 1; }
        destroy() {}
    }
    const container = { hidden: false, innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const win = {
        PIXI: { Application, Graphics },
        MusicMotion: { reduced: () => true },
        devicePixelRatio: 1,
        addEventListener() {}
    };
    const context = vm.createContext({
        window: win, queueMicrotask, setTimeout, clearTimeout, console,
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null), body: { classList: { contains: () => true } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = { isPlaying: false, visualizerColor: { r: 0, g: 195, b: 255 }, currentVisualizerData: [] };
    win.setupAmbientPixi(app);
    await settle();

    // First static paused + reduced-motion update draws once; subsequent ticks skip clear & render
    app.updateAmbientPixi(0.016);
    assert.equal(renders, 1);
    const clearsAfterFirst = clears;
    app.updateAmbientPixi(0.016);
    app.updateAmbientPixi(0.016);
    assert.equal(renders, 1, 'settled paused reduced-motion ticks skip redundant WebGL render');
    assert.equal(clears, clearsAfterFirst, 'settled paused reduced-motion ticks skip Graphics.clear');

    // Theme color change wakes static cache and draws once
    app.visualizerColor = { r: 240, g: 80, b: 120 };
    app.updateAmbientPixi(0.016);
    assert.equal(renders, 2, 'accent color change redraws static frame once');
    app.updateAmbientPixi(0.016);
    assert.equal(renders, 2);

    // Resize invalidates static cache and draws once
    container.clientWidth = 1024;
    app.ambientPixiController.resize();
    app.updateAmbientPixi(0.016);
    assert.equal(renders, 3, 'resize invalidates static cache and redraws once');
});

test('Batch 78: AmbientPixi precomputes ring trig LUTs, skips idleBreath while playing, and skips getComputedStyle when archive is active', async () => {
    let trigCalls = 0;
    let dateNowCalls = 0;
    let computedStyleCalls = 0;
    const origSin = Math.sin;
    const origCos = Math.cos;
    const fakeMath = Object.create(Math);
    fakeMath.sin = (x) => { trigCalls += 1; return origSin(x); };
    fakeMath.cos = (x) => { trigCalls += 1; return origCos(x); };
    const FakeDate = class extends Date {
        static now() { dateNowCalls += 1; return Date.now(); }
    };
    class Graphics {
        clear() { return this; }
        circle() { return this; }
        fill() { return this; }
        moveTo() { return this; }
        quadraticCurveTo() { return this; }
        lineTo() { return this; }
        stroke() { return this; }
    }
    class Application {
        async init() {
            this.canvas = { style: {} };
            this.stage = { addChild() {} };
            this.renderer = { resize() {} };
        }
        stop() {}
        render() {}
        destroy() {}
    }
    const container = { hidden: false, innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const win = {
        PIXI: { Application, Graphics },
        devicePixelRatio: 1,
        addEventListener() {},
        getComputedStyle: () => { computedStyleCalls += 1; return { visibility: 'visible', display: 'block' }; }
    };
    const context = vm.createContext({
        window: win, Math: fakeMath, Date: FakeDate, queueMicrotask, setTimeout, clearTimeout, console,
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null), body: { classList: { contains: () => false } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);

    const app = { isArchiveActive: true, isPlaying: true, visualizerColor: { r: 20, g: 180, b: 240 }, currentVisualizerData: new Float32Array(64).fill(0.4) };
    win.setupAmbientPixi(app);
    await app.createAmbientPixi();
    assert.equal(computedStyleCalls, 0, 'isArchiveActive short-circuits before getComputedStyle');
    assert.equal(app.ambientPixiController, null);

    app.isArchiveActive = false;
    await app.createAmbientPixi();
    assert.ok(app.ambientPixiController?.initialized);

    trigCalls = 0;
    dateNowCalls = 0;
    app.updateAmbientPixi(0.016);
    assert.equal(dateNowCalls, 0, 'playing frame skips Date.now() / idleBreath calculation');
    assert.ok(trigCalls <= 24, `expected <= 24 trig calls per playing frame via LUTs, got ${trigCalls}`);

    // Verify angle-addition LUT geometry matches exact polar formula
    const ring = app.ambientPixiController.rippleRings[0];
    const rot = ring.getCurrentRotation();
    const baseR = 600 * 0.26 * (1 + app.ambientPixiController.smoothBass * 0.22);
    const scale = ring.getCurrentScale();
    const ringRadius = baseR * scale;
    const waveAmp = 600 * (0.02 + app.ambientPixiController.smoothBass * 0.09) * Math.sqrt(scale);
    const i = 17;
    const ratio = i / ring.segments;
    const sway = origSin(ratio * Math.PI * 2 * 3 + ring.phase * Math.PI * 2) * 0.12;
    const expectedR = ringRadius + (0.4 * 1.1 + sway) * waveAmp;
    const expectedX = 400 + origCos(ratio * Math.PI * 2 + rot) * expectedR;
    const expectedY = 300 + origSin(ratio * Math.PI * 2 + rot) * expectedR;
    assert.ok(Math.abs(ring.xs[i] - expectedX) < 1e-3, `xs[${i}] matches exact polar formula`);
    assert.ok(Math.abs(ring.ys[i] - expectedY) < 1e-3, `ys[${i}] matches exact polar formula`);
});

test('Batch 86: AmbientPixi fast-paths inline hidden style before getComputedStyle and reuses Graphics style descriptors', async () => {
    let csCalls = 0;
    const fillObjs = new Set();
    const strokeObjs = new Set();
    class Graphics {
        clear() { return this; }
        circle() { return this; }
        fill(o) { fillObjs.add(o); return this; }
        moveTo() { return this; }
        quadraticCurveTo() { return this; }
        lineTo() { return this; }
        stroke(o) { strokeObjs.add(o); return this; }
    }
    class Application {
        async init() { this.canvas = { style: {} }; this.stage = { addChild() {} }; this.renderer = { resize() {} }; }
        stop() {}
        render() {}
        destroy() {}
    }
    const container = { hidden: false, style: { display: 'none', visibility: '' }, innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const win = {
        PIXI: { Application, Graphics },
        devicePixelRatio: 1,
        addEventListener() {},
        getComputedStyle: () => { csCalls += 1; return { visibility: 'visible', display: 'block' }; }
    };
    const context = vm.createContext({
        window: win, queueMicrotask, setTimeout, clearTimeout, console,
        document: { getElementById: (id) => (id === 'ambient-wave-container' ? container : null), body: { classList: { contains: () => false } } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = { isPlaying: true, visualizerColor: { r: 10, g: 120, b: 220 }, currentVisualizerData: new Float32Array(32).fill(0.5) };
    win.setupAmbientPixi(app);
    await app.createAmbientPixi();
    assert.equal(csCalls, 0, 'inline display:none skips getComputedStyle');
    container.style.display = '';
    container.style.visibility = 'hidden';
    await app.createAmbientPixi();
    assert.equal(csCalls, 0, 'inline visibility:hidden skips getComputedStyle');

    container.style.visibility = '';
    await app.createAmbientPixi();
    assert.equal(csCalls, 1);
    app.ambientPixiController.spawnBubbles(400, 300, 100, 12, 0xffffff);
    app.updateAmbientPixi(0.016);
    app.updateAmbientPixi(0.016);
    app.updateAmbientPixi(0.016);
    assert.equal(fillObjs.size, 3, 'glow + bubble fill + bubble highlight reuse 3 descriptor objects across frames');
    assert.equal(strokeObjs.size, 2, 'ring stroke + bubble stroke reuse 2 descriptor objects across frames');
});

test('Batch 95: AmbientPixi isContainerHidden short-circuits on body.music-archive-on before getComputedStyle', async () => {
    let csCalls = 0;
    const container = { hidden: false, style: { display: '', visibility: '' }, innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const doc = {
        getElementById: (id) => (id === 'ambient-wave-container' ? container : null),
        body: { classList: { contains: (cls) => cls === 'music-archive-on' } }
    };
    const win = {
        document: doc,
        PIXI: { Application: class {}, Graphics: class {} },
        devicePixelRatio: 1,
        addEventListener() {},
        getComputedStyle: () => { csCalls += 1; return { visibility: 'visible', display: 'block' }; }
    };
    const context = vm.createContext({
        window: win, document: doc, queueMicrotask, setTimeout, clearTimeout, console
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = { isArchiveActive: false, isPlaying: false };
    win.setupAmbientPixi(app);
    await app.createAmbientPixi();
    assert.equal(csCalls, 0, 'body.music-archive-on skips getComputedStyle in isContainerHidden');
    assert.equal(app.ambientPixiController, null, 'does not create WebGL ambient controller while body.music-archive-on is set');
});

test('Batch 124: AmbientPixi update skips body.classList reduce-motion read when MusicMotion is present', async () => {
    class Graphics {
        clear() { return this; }
        circle() { return this; }
        fill() { return this; }
        moveTo() { return this; }
        quadraticCurveTo() { return this; }
        lineTo() { return this; }
        stroke() { return this; }
    }
    class Application {
        async init() {
            this.canvas = { style: {} };
            this.stage = { addChild() {} };
            this.renderer = { resize() {} };
        }
        stop() {}
        render() {}
        destroy() {}
    }
    let reduceReads = 0;
    const container = { hidden: false, style: { display: '', visibility: '' }, innerHTML: '', appendChild() {}, clientWidth: 800, clientHeight: 600 };
    const doc = {
        getElementById: (id) => (id === 'ambient-wave-container' ? container : null),
        body: {
            classList: {
                contains: (cls) => {
                    if (cls === 'music-reduce-motion') reduceReads += 1;
                    return false;
                }
            }
        }
    };
    const win = {
        document: doc,
        PIXI: { Application, Graphics },
        MusicMotion: { reduced: () => false },
        devicePixelRatio: 1,
        addEventListener() {}
    };
    const context = vm.createContext({
        window: win, document: doc, queueMicrotask, setTimeout, clearTimeout, console
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), context);
    const app = { isPlaying: true, visualizerColor: { r: 0, g: 195, b: 255 }, currentVisualizerData: new Float32Array(32).fill(0.4) };
    win.setupAmbientPixi(app);
    await app.createAmbientPixi();
    app.updateAmbientPixi(0.016);
    app.updateAmbientPixi(0.016);
    assert.equal(reduceReads, 0, 'AmbientPixi.update reads MusicMotion.reduced() without touching body.classList');
});

test('Batch 125: MusicStageRuntime.ensurePixi deduplicates lazy loads, recovers on error, and AmbientPixi awaits it on demand', async () => {
    const scripts = [];
    const doc = {
        querySelector: (sel) => (sel.includes('data-vmusic-pixi') ? scripts.find((s) => s.dataset?.vmusicPixi === '1') || null : null),
        createElement: (tag) => {
            const listeners = {};
            const el = {
                tagName: tag.toUpperCase(),
                dataset: {},
                src: '',
                async: false,
                addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
                emit(type) { for (const fn of (listeners[type] || []).splice(0)) fn(); },
                remove() { const idx = scripts.indexOf(el); if (idx >= 0) scripts.splice(idx, 1); }
            };
            return el;
        },
        body: {
            appendChild(el) { scripts.push(el); return el; },
            classList: { contains: () => false }
        }
    };
    const win = { document: doc, devicePixelRatio: 1, addEventListener() {} };
    const rtCtx = vm.createContext({ window: win, document: doc, Intl, console, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-stage/music-stage-runtime.js'), 'utf8'), rtCtx);

    // 1. Concurrent ensurePixi calls share one <script>, and error clears cached promise for retry
    const p1 = win.MusicStageRuntime.ensurePixi();
    const p2 = win.MusicStageRuntime.ensurePixi();
    assert.equal(p1, p2, 'concurrent ensurePixi calls share one promise');
    assert.equal(scripts.length, 1, 'only one script element is appended');
    assert.match(scripts[0].src, /pixi\.min\.js$/);
    scripts[0].emit('error');
    assert.equal(await p1, null, 'script error resolves null');
    assert.equal(scripts.length, 0, 'failed script element is removed');

    // 2. Retry succeeds and AmbientPixi.init awaits ensurePixi cleanly
    let initCalls = 0;
    class Graphics { clear() { return this; } circle() { return this; } fill() { return this; } }
    class Application {
        async init() {
            initCalls += 1;
            this.canvas = { style: {} };
            this.stage = { addChild() {} };
            this.renderer = { resize() {} };
        }
        stop() {}
        render() {}
        destroy() {}
    }
    const container = { hidden: false, style: { display: '', visibility: '' }, innerHTML: '', appendChild() {}, clientWidth: 640, clientHeight: 480 };
    doc.getElementById = (id) => (id === 'ambient-wave-container' ? container : null);
    const ambCtx = vm.createContext({ window: win, document: doc, queueMicrotask, setTimeout, clearTimeout, console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-ambient-pixi.js'), 'utf8'), ambCtx);
    const app = { isArchiveActive: false, isStageActive: false, isPlaying: false };
    win.setupAmbientPixi(app);
    const createPromise = app.createAmbientPixi();
    assert.equal(scripts.length, 1, 'AmbientPixi triggers lazy pixi script injection');
    win.PIXI = { Application, Graphics };
    scripts[0].emit('load');
    await createPromise;
    assert.equal(initCalls, 1, 'AmbientPixi initializes once ensurePixi finishes');
    assert.equal(await win.MusicStageRuntime.ensurePixi(), win.PIXI, 'subsequent ensurePixi resolves cached global PIXI');
});
