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
