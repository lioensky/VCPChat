const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const workspace = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(workspace, relativePath), 'utf8');
const createDom = () => new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});
const runScript = (dom, relativePath) => {
    vm.runInContext(read(relativePath), dom.getInternalVMContext(), { filename: relativePath });
};
const loadStage = (dom, ...extra) => {
    [
        'Musicmodules/music-stage/music-stage-config.js',
        'Musicmodules/music-stage/music-stage-runtime.js',
        'Musicmodules/music-stage/modes/stage-mode-utils.js',
        ...extra
    ].forEach((file) => runScript(dom, file));
    return dom.window;
};

test('timestamp-only lyric lines end after a reading estimate instead of spanning the break', () => {
    const dom = createDom();
    const { MusicStageRuntime: Runtime } = loadStage(dom);
    const lines = Runtime.normalizeLines([
        { time: 10, original: '短短的一句歌词' },
        { time: 14, original: '紧接着的下一句' },
        { time: 60, original: '间奏之后' }
    ]);

    // A normal gap is still owned by the line in full.
    assert.equal(lines[0].endTime, 14);
    // 7 graphemes * 0.45 s + 2 s, not the 46 s until the next line.
    assert.ok(Math.abs(lines[1].endTime - (14 + 7 * 0.45 + 2)) < 1e-9);
    assert.ok(lines[1].vocalEndTime <= lines[1].endTime + 1e-9);
    assert.equal(Runtime.buildGlyphTimeline(lines[1]).at(-1).endTime <= lines[1].endTime + 1e-9, true);
    dom.window.close();
});

test('declared end times and word timings are never shortened', () => {
    const dom = createDom();
    const { MusicStageRuntime: Runtime } = loadStage(dom);
    const lines = Runtime.normalizeLines([
        { time: 0, endTime: 40, original: '声明了结束时间' },
        { time: 50, original: '逐字', words: [{ text: '逐字', startTime: 50, endTime: 51 }] },
        { time: 120, original: '结尾' }
    ]);
    assert.equal(lines[0].endTime, 40);
    assert.equal(lines[1].endTime, 120);
    dom.window.close();
});

test('stage clock filters poll jitter, stays monotonic and snaps on seeks', () => {
    const dom = createDom();
    const { MusicStageRuntime: Runtime } = loadStage(dom);
    const app = { isPlaying: true, lastKnownCurrentTime: 30, lastStateUpdateTime: 1_000_000 };
    const jitter = [0.031, -0.024, 0.04, -0.038, 0.012, -0.03, 0.036, -0.019];
    let previous = Runtime.resolveSteadyPlaybackTime(app, 1_000_000);
    let worstStep = 0;
    let worstError = 0;
    for (let frame = 1; frame <= 480; frame += 1) {
        const now = 1_000_000 + frame * (1000 / 60);
        if (frame % 15 === 0) {
            // A poll lands: true position plus a few tens of milliseconds of noise.
            app.lastKnownCurrentTime = 30 + (now - 1_000_000) / 1000 + jitter[(frame / 15) % jitter.length];
            app.lastStateUpdateTime = now;
        }
        const time = Runtime.resolveSteadyPlaybackTime(app, now);
        assert.ok(time >= previous, 'clock must not run backwards');
        worstStep = Math.max(worstStep, Math.abs(time - previous - 1 / 60));
        worstError = Math.max(worstError, Math.abs(time - (30 + (now - 1_000_000) / 1000)));
        previous = time;
    }
    assert.ok(worstStep < 0.004, `frame steps stay even, saw ${worstStep}`);
    assert.ok(worstError < 0.045, `clock stays near the engine, saw ${worstError}`);

    const seekAt = 1_000_000 + 9000;
    app.lastKnownCurrentTime = 95;
    app.lastStateUpdateTime = seekAt;
    assert.equal(Runtime.resolveSteadyPlaybackTime(app, seekAt), 95);
    app.isPlaying = false;
    assert.equal(Runtime.resolveSteadyPlaybackTime(app, seekAt + 5000), 95);
    dom.window.close();
});

test('tunnel journey covers the whole song, with or without lyrics', () => {
    const dom = createDom();
    const { MusicStageTunnelManager: Tunnel } = loadStage(dom, 'Musicmodules/music-stage/modes/tunnel-manager.js');
    const lines = dom.window.MusicStageRuntime.normalizeLines([
        { time: 10, original: '第一句歌词' },
        { time: 100, original: '最后一句歌词' }
    ]);

    const full = Tunnel.compileTimeline(lines, 'song', 200);
    assert.equal(full.duration, 200);
    assert.ok(full.distanceAt(190) > full.distanceAt(150));
    assert.ok(full.distanceAt(150) > full.distanceAt(115));

    const instrumental = Tunnel.compileTimeline([], 'instrumental', 180);
    assert.ok(instrumental.distanceAt(170) > instrumental.distanceAt(60));
    assert.ok(instrumental.distanceAt(60) > instrumental.distanceAt(25));

    // Unknown length: the camera still keeps moving past the compiled end.
    const unknown = Tunnel.compileTimeline([], 'unknown', 0);
    assert.ok(unknown.distanceAt(90) > unknown.distanceAt(30));
    dom.window.close();
});

test('mode settings keep their own ranges', () => {
    const dom = createDom();
    const { MusicStageConfig: Config } = loadStage(dom);
    Config.setModePatch('fume', { textHoldRatio: 1 });
    assert.equal(Config.get().modes.fume.textHoldRatio, 1);
    dom.window.close();
});

test('the sung-word hop and the lyric face are settings of the two 3D stages only', () => {
    const dom = createDom();
    const { MusicStageConfig: Config } = loadStage(dom);
    assert.equal(Config.get().modes.diorama.lyricHop, 1);
    assert.equal(Config.get().modes.tunnel.lyricHop, 1);
    Config.setModePatch('diorama', { lyricHop: 5 });
    assert.equal(Config.get().modes.diorama.lyricHop, 2);
    Config.setModePatch('tunnel', { lyricHop: 0 });
    assert.equal(Config.get().modes.tunnel.lyricHop, 0);
    assert.equal(Config.get().modes.luminous.lyricHop, undefined);
    assert.equal(Config.get().modes.diorama.lyricFont, 'sans');
    Config.setModePatch('diorama', { lyricFont: 'serif' });
    assert.equal(Config.get().modes.diorama.lyricFont, 'serif');
    Config.setModePatch('tunnel', { lyricFont: 'comic' });
    assert.equal(Config.get().modes.tunnel.lyricFont, 'sans');
    assert.equal(Config.get().modes.luminous.lyricFont, undefined);
    dom.window.close();
});

test('the 3D stages take the cover\'s most vivid hue into their sky, and a grey cover gives none', () => {
    const dom = createDom();
    const { MusicStageConfig: Config, MusicStageModeUtils: U } = loadStage(dom);
    assert.equal(Config.get().modes.diorama.coverTint, 0.5);
    Config.setModePatch('diorama', { coverTint: 3 });
    assert.equal(Config.get().modes.diorama.coverTint, 1);
    assert.equal(Config.get().modes.tunnel.coverTint, 0.5);
    assert.equal(Config.get().modes.luminous.coverTint, undefined);
    const pixels = (list) => Uint8ClampedArray.from(list.flatMap(([r, g, b]) => [r, g, b, 255]));
    // A red square on black: black has no hue, so red is the colour.
    const red = pixels([...Array(30).fill([200, 40, 60]), ...Array(70).fill([0, 0, 0])]);
    assert.equal(U.dominantHue(red), '#c8283c');
    // Mostly sky blue with a sand strip: the larger vivid area wins.
    const sky = pixels([...Array(60).fill([90, 160, 230]), ...Array(40).fill([232, 216, 176])]);
    assert.equal(U.dominantHue(sky), '#5aa0e6');
    // Greys, black and white only.
    const grey = pixels(Array.from({ length: 100 }, (_, i) => [i * 2.5, i * 2.5, i * 2.5]));
    assert.equal(U.dominantHue(grey), null);
    dom.window.close();
});

test('marker lines and placeholder translations never reach a 3D stage', () => {
    const dom = createDom();
    const { MusicStageRuntime: R, MusicStageDioramaDirector: Director } = loadStage(dom, 'Musicmodules/music-stage/modes/diorama-director.js');
    assert.equal(R.readableText('●●●'), false);
    assert.equal(R.readableText(' // '), false);
    assert.equal(R.readableText('——'), false);
    assert.equal(R.readableText('海'), true);
    assert.equal(R.readableText('Love 2'), true);
    assert.equal(R.resolveSupplementalText({ translation: '//' }), '');
    assert.equal(R.resolveSupplementalText({ translation: ' Sea ' }), 'Sea');
    const lines = R.normalizeLines([
        { time: 10, original: '清晨的站台' }, { time: 14, original: '●●●' },
        { time: 30, original: '//' }, { time: 34, original: '列车带走昨夜的梦' }
    ]);
    const timeline = Director.compile({ lines, trackId: 't', duration: 60 });
    assert.deepEqual(timeline.lines.map(line => line.fullText), ['清晨的站台', '列车带走昨夜的梦']);
    dom.window.close();
});

test('diorama rain is off unless chosen, and only takes its three settings', () => {
    const dom = createDom();
    const { MusicStageConfig: Config } = loadStage(dom);
    assert.equal(Config.get().modes.diorama.rain, 'off');
    Config.setModePatch('diorama', { rain: 'heavy' });
    assert.equal(Config.get().modes.diorama.rain, 'heavy');
    Config.setModePatch('diorama', { rain: 'monsoon' });
    assert.equal(Config.get().modes.diorama.rain, 'off');
    dom.window.close();
});

test('diorama scenery knows when it would stand between the train and a lyric screen', () => {
    const dom = createDom();
    const { MusicStageDioramaWorld: World } = loadStage(dom, 'Musicmodules/music-stage/modes/diorama-world.js');
    // The train reads this screen between 100 m and 130 m; it stands 18 m to the right at 140 m.
    const track = { encounters: [{ side: 1, address: 140, lateral: 18, startDistance: 100, endDistance: 130 }] };
    // A pole 3.4 m from the track, anywhere the sight line sweeps, is in the way.
    assert.equal(World.inSight(track, 120, 3.4, 1), true);
    assert.equal(World.inSight(track, 135, 3.4, 1), true);
    // The other side of the track, behind the reader, or beyond the screen is not.
    assert.equal(World.inSight(track, 120, 3.4, -1), false);
    assert.equal(World.inSight(track, 80, 3.4, 1), false);
    assert.equal(World.inSight(track, 170, 3.4, 1), false);
    // Poles prefer the side away from the next screen and fall back when none is near.
    assert.equal(World.poleSide({ encounters: [{ side: 1, address: 140 }] }, 100), -1);
    assert.equal(World.poleSide({ encounters: [{ side: -1, address: 140 }] }, 100), 1);
    assert.equal(World.poleSide({ encounters: [] }, 100, 1), 1);
    dom.window.close();
});

test('3D modes draw to a pixel budget and step down while frames are slow', () => {
    const dom = createDom();
    const { MusicStageModeUtils: Utils } = loadStage(dom);
    dom.window.devicePixelRatio = 1.5;
    const scale = Utils.createRenderScale();
    // A small window keeps the device pixel ratio; a maximised 4K one is held to the budget.
    assert.equal(scale.ratio('standard', 1280, 700), 1.5);
    const large = scale.ratio('standard', 2560, 1440);
    assert.ok(large * large * 2560 * 1440 <= 2.4e6 * 1.001, `budget exceeded: ${large}`);
    assert.ok(scale.ratio('ultimate', 2560, 1440) > large);
    assert.ok(scale.ratio('energy-saving', 2560, 1440) < large);

    let now = 1000;
    const run = (interval, count) => {
        let changed = 0;
        for (let i = 0; i < count; i += 1) { now += interval; if (scale.tick(now)) changed += 1; }
        return changed;
    };
    scale.tick(now);
    assert.equal(run(16.7, 600), 0, 'a held frame rate changes nothing');
    assert.equal(run(4000, 3), 0, 'a hidden window is not a slow renderer');
    assert.ok(run(33.3, 100) >= 1, 'thirty frames a second steps down');
    assert.ok(scale.factor < 1 && scale.factor >= 0.55);
    assert.ok(scale.ratio('standard', 2560, 1440) < large);
    const low = scale.factor;
    run(16.7, 2000);
    assert.ok(scale.factor > low, 'a long steady stretch tries the larger size again');
    dom.window.close();
});

test('a wobbling duration does not rebuild the diorama song', () => {
    const dom = createDom();
    const { MusicStageModeUtils: Utils } = loadStage(dom);
    assert.equal(Utils.durationChanged(null, 215), true, 'nothing compiled yet');
    assert.equal(Utils.durationChanged(0, 215), true, 'the real duration arriving after a placeholder');
    assert.equal(Utils.durationChanged(215, 215.01), false);
    assert.equal(Utils.durationChanged(215.01, 215), false);
    assert.equal(Utils.durationChanged(215, 216), true);
    assert.equal(Utils.durationChanged(undefined, undefined), false, 'an unknown duration stays unknown');
    // The manager goes through this check rather than comparing the raw numbers.
    const manager = read('Musicmodules/music-stage/modes/diorama-manager.js');
    assert.match(manager, /U\.durationChanged\(compiledDuration, nextDuration\)/);
    assert.doesNotMatch(manager, /compiledDuration !== nextDuration/);
    dom.window.close();
});

test('3D stages step down pixels, then a tier, and only get pixels back on their own', () => {
    const dom = createDom();
    const { MusicStageModeUtils: U } = loadStage(dom);
    const scale = U.createRenderScale();
    const config = { quality: 'standard', modes: {} };
    let now = 1000;
    // Feed frames at a steady interval until the ladder moves (or give up).
    const run = (interval, aim, limit = 400) => {
        for (let i = 0; i < limit; i++) {
            now += interval;
            if (scale.tick(now, aim)) return true;
        }
        return false;
    };
    assert.equal(scale.config(config), config, 'nothing dropped: the same settings object');
    // 30 fps against a 60 fps cap: fewer pixels first, twice, before any effect goes.
    assert.ok(run(33, 16.7)); assert.ok(run(33, 16.7));
    assert.equal(scale.steps, 2);
    assert.equal(scale.quality('standard'), 'standard');
    assert.ok(scale.factor < 0.75);
    // One slow judgement more is not enough to give up an effect tier: a song
    // change or another busy app can do that for a second.
    for (let i = 0; i < 50; i++) { now += 33; assert.equal(scale.tick(now, 16.7), false); }
    assert.equal(scale.quality('standard'), 'standard');
    // Still slow: the tier below (no lens, 30 fps cap).
    assert.ok(run(33, 16.7));
    assert.equal(scale.quality('standard'), 'energy-saving');
    assert.equal(scale.config(config).quality, 'energy-saving');
    assert.equal(scale.config(config), scale.config(config), 'derived settings are stable between frames');
    // Holding 30 fps under the 30 fps cap is fine: no further drop, and the tier is not retried.
    assert.equal(run(33, 33.3, 3000), false);
    assert.equal(scale.steps, 3);
    // Picking a tier again starts from the top.
    scale.reset();
    assert.equal(scale.steps, 0);
    assert.equal(scale.quality('ultimate'), 'ultimate');
});

test('the canvas shaders for a lens-less tier are compiled in the background before the drop', () => {
    const dom = createDom();
    const { MusicStageModeUtils: U } = loadStage(dom);
    const compiled = [];
    const renderer = (parallel) => ({
        extensions: { has: (name) => parallel && name === 'KHR_parallel_shader_compile' },
        getRenderTarget: () => null,
        setRenderTarget(target) { this.target = target; },
        compileAsync() { throw new Error('the renderer\'s own wait is not used'); },
        compile(scene) { compiled.push([scene, this.target]); return new Set([{}]); },
        properties: { get: () => ({ currentProgram: { isReady: () => true } }) },
        getContext: () => null,
        info: { programs: [] }
    });
    const T = { WebGLRenderTarget: class { dispose() {} }, HalfFloatType: 1 };
    const scene = {}, camera = {};
    // Not on the way down yet: nothing to do.
    assert.equal(U.warmLensless(T, renderer(true), scene, camera, { steps: 0 }, 'standard'), false);
    // Standard keeps its lens until the drop to the saving tier, which draws to the canvas.
    assert.equal(U.warmLensless(T, renderer(true), scene, camera, { steps: 1 }, 'standard'), true);
    assert.deepEqual(compiled, [[scene, null]]);
    // The top tier drops to standard, which still has its lens: wait for the next rung.
    assert.equal(U.warmLensless(T, renderer(true), scene, camera, { steps: 1 }, 'ultimate'), false);
    // Without background compiling it would only move the stall, so it is skipped (and marked done).
    assert.equal(U.warmLensless(T, renderer(false), scene, camera, { steps: 1 }, 'standard'), true);
    assert.equal(compiled.length, 1);
});


test('the track card box is handed to 3D modes in picture units, and only when it is shown', () => {
    const dom = createDom();
    const { MusicStageModeUtils: U } = loadStage(dom);
    const doc = dom.window.document;
    const stage = doc.createElement('div'); stage.className = 'music-stage';
    const root = doc.createElement('section');
    const card = doc.createElement('aside'); card.className = 'music-stage-id3';
    stage.append(root, card); doc.body.append(stage);
    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 500 });
    card.getBoundingClientRect = () => ({ left: 16, right: 216, top: 50, bottom: 175, width: 200, height: 125 });
    let observed = 0;
    dom.window.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() { observed += 1; } disconnect() {} };
    const overlay = U.watchOverlay(root);
    assert.equal(observed, 2, 'card and stage are watched, nothing is read per frame');
    assert.equal(overlay.box, null);
    overlay.measure();
    const box = overlay.box;
    assert.ok(Math.abs(box.left - -0.96) < 1e-9 && Math.abs(box.right - -0.46) < 1e-9);
    assert.ok(Math.abs(box.top - 0.8) < 1e-9 && Math.abs(box.bottom - 0.3) < 1e-9);
    card.style.display = 'none';
    overlay.measure();
    assert.equal(overlay.box, null, 'a hidden card is not avoided');
    overlay.destroy();
    assert.equal(U.watchOverlay(doc.createElement('div')).box, null, 'a mode outside the stage has no card');
});

test('the handover veil reads the 3D picture back at most four times a second while waiting', () => {
    const dom = createDom();
    const { MusicStageModeUtils: U } = loadStage(dom);
    const root = dom.window.document.createElement('div');
    const veil = U.createHandoverVeil(root);
    const canvas = root.querySelector('canvas');
    let reads = 0;
    canvas.getContext = () => ({ drawImage() { reads += 1; } });
    let now = 1000;
    dom.window.performance.now = () => now;
    const source = { width: 640, height: 360 };
    for (let i = 0; i < 60; i++) { veil.capture(source); now += 16.7; }
    assert.ok(veil.captured);
    assert.equal(reads, 4, 'one second at 60 fps: four reads');
    // A theme switch needs exactly the picture on screen now.
    veil.capture(source, { every: 0 });
    assert.equal(reads, 5);
    // A new size is read at once.
    veil.capture({ width: 800, height: 450 });
    assert.equal(reads, 6);
    veil.destroy();
});

test('diorama-optics skips all 7 bloom passes when glow is 0 and runs full pyramid when glow > 0', () => {
    const dom = createDom();
    const win = loadStage(dom, 'Musicmodules/music-stage/modes/diorama-optics.js');
    const createdTargets = [];
    const createdMaterials = [];
    class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; return this; } }
    class WebGLRenderTarget {
        constructor(w, h, opts = {}) { this.width = w; this.height = h; this.samples = opts.samples || 0; this.texture = {}; this.disposed = 0; createdTargets.push(this); }
        setSize(w, h) { this.width = w; this.height = h; }
        dispose() { this.disposed += 1; }
    }
    class ShaderMaterial {
        constructor(opts) { Object.assign(this, opts); this.disposed = 0; createdMaterials.push(this); }
        dispose() { this.disposed += 1; }
    }
    const T = {
        HalfFloatType: 1, LinearFilter: 2, AdditiveBlending: 3, Vector2, WebGLRenderTarget, ShaderMaterial,
        Scene: class { add() {} },
        OrthographicCamera: class {},
        PlaneGeometry: class { dispose() {} },
        Mesh: class { constructor(g, m) { this.geometry = g; this.material = m; } }
    };
    const optics = win.MusicStageDioramaOptics.create(T);
    let renderCalls = 0;
    let currentTarget = null;
    const renderer = {
        autoClear: true,
        getDrawingBufferSize: (v) => v.set(640, 360),
        getRenderTarget: () => currentTarget,
        setRenderTarget: (t) => { currentTarget = t; },
        clear() {},
        render() { renderCalls += 1; }
    };
    optics.render(renderer, {}, {}, 1.0, { quality: 'standard' }, { glow: 0 });
    assert.equal(renderCalls, 2, 'glow=0 renders only world target + final composite (skips 7 bloom passes)');

    renderCalls = 0;
    optics.render(renderer, {}, {}, 1.0, { quality: 'standard' }, { glow: 1 });
    assert.equal(renderCalls, 9, 'glow>0 runs world + prefilter + 3 down + 3 up + final composite');

    const composite = createdMaterials.find((m) => m.uniforms?.glowMap);
    assert.match(composite.fragmentShader, /if\(bloom>0\.0\)/);
    assert.match(composite.fragmentShader, /if\(cabin>0\.001\)/);

    optics.destroy();
    assert.ok(createdTargets.every((t) => t.disposed >= 1), 'all render targets disposed');
    assert.ok(createdMaterials.every((m) => m.disposed >= 1), 'all shader materials disposed');
    dom.window.close();
});

test('kowloon manager exposes getDegrade, debug scale fields and precompiles optics', () => {
    const dom = createDom();
    const win = loadStage(dom, 'Musicmodules/music-stage/modes/kowloon-manager.js');
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const mode = win.MusicStageKowloonManager.create(host, { app: { stagePalette: {} } });
    assert.equal(typeof mode.getDegrade, 'function');
    assert.deepEqual({ ...mode.getDegrade() }, { steps: 0, quality: 'standard' });

    mode.updateConfig({ quality: 'energy-saving' });
    assert.deepEqual({ ...mode.getDegrade() }, { steps: 0, quality: 'energy-saving' });

    const snap = mode.getDebugSnapshot();
    assert.equal(snap.degradeSteps, 0);
    assert.equal(snap.drawnQuality, 'energy-saving');
    assert.equal(typeof snap.canvasSmoothing, 'boolean');

    const src = read('Musicmodules/music-stage/modes/kowloon-manager.js');
    assert.match(src, /optics\?\.precompile\?\.\(renderer\)/);
    assert.match(src, /U\.settlePrograms\(/);
    mode.destroy();
    dom.window.close();
});

test('diorama-lyrics uses per-vertex glyphSpan without 64-step fragment loop and tunnel disposes glyphScrim', () => {
    const lyricsSrc = read('Musicmodules/music-stage/modes/diorama-lyrics.js');
    assert.match(lyricsSrc, /attribute vec2 glyphSpan;/);
    assert.doesNotMatch(lyricsSrc, /for\(int i=0;i<64;i\+\+\)/);

    const tunnelSrc = read('Musicmodules/music-stage/modes/tunnel-manager.js');
    assert.match(tunnelSrc, /glyphScrim\.geometry/);
    assert.match(tunnelSrc, /glyphScrim\.material/);
});

test('Batch 131: releaseWebGLContext defers loseContext until GPU fence signals and flushes on beforeunload', () => {
    const dom = createDom();
    const win = loadStage(dom);
    const timers = [];
    win.setTimeout = (fn) => { timers.push({ fn, cleared: false }); return timers.length; };
    win.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };

    let signaled = false;
    let flushed = 0;
    let deletedSync = 0;
    let lost = 0;
    const canvas = { width: 1440, height: 900, isConnected: false };
    const syncToken = { id: 1 };
    const gl = {
        SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
        SYNC_STATUS: 0x9114,
        SIGNALED: 0x9119,
        UNSIGNALED: 0x9118,
        canvas,
        isContextLost: () => lost > 0,
        fenceSync: () => syncToken,
        flush: () => { flushed += 1; },
        getSyncParameter: () => (signaled ? 0x9119 : 0x9118),
        deleteSync: (s) => { if (s === syncToken) deletedSync += 1; },
        getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => { lost += 1; } } : null)
    };
    const renderer = { getContext: () => gl, forceContextLoss: () => { lost += 100; } };

    assert.equal(win.MusicStageRuntime.releaseWebGLContext(renderer), true);
    assert.equal(flushed, 1, 'fenceSync immediately flushes GPU command queue');
    assert.equal(lost, 0, 'loseContext is deferred while GPU fence is unsignaled');
    assert.equal(timers.length, 1);

    // First poll: still unsignaled -> reschedules without stalling
    timers[0].fn();
    assert.equal(lost, 0);
    assert.equal(timers.length, 2);

    // Second poll: fence signaled -> deletes sync, shrinks detached canvas, loses context
    signaled = true;
    timers[1].fn();
    assert.equal(deletedSync, 1);
    assert.equal(canvas.width, 1);
    assert.equal(canvas.height, 1);
    assert.equal(lost, 1);

    // Pending release flushes synchronously on beforeunload
    signaled = false;
    let unloadLost = 0;
    const gl2 = {
        ...gl,
        isContextLost: () => unloadLost > 0,
        getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => { unloadLost += 1; } } : null)
    };
    win.MusicStageRuntime.releaseWebGLContext({ getContext: () => gl2 });
    assert.equal(unloadLost, 0);
    win.dispatchEvent(new win.Event('beforeunload'));
    assert.equal(unloadLost, 1, 'beforeunload flushes pending WebGL context release');

    // Immediate flag falls back to synchronous forceContextLoss
    let syncForced = 0;
    win.MusicStageRuntime.releaseWebGLContext({ forceContextLoss: () => { syncForced += 1; } }, { immediate: true });
    assert.equal(syncForced, 1);

    // Verify 3D stages wire releaseWebGLContext and Kowloon prepares haze before precompile
    const kowloonSrc = read('Musicmodules/music-stage/modes/kowloon-manager.js');
    const prepareIdx = kowloonSrc.indexOf('alley?.prepareHaze?.()');
    const precompileIdx = kowloonSrc.indexOf('await U.precompile(');
    assert.ok(prepareIdx > 0 && precompileIdx > prepareIdx, 'kowloon patches layered haze before shader precompile');
    assert.match(kowloonSrc, /R\.releaseWebGLContext/);
    assert.match(read('Musicmodules/music-stage/modes/diorama-manager.js'), /R\.releaseWebGLContext/);
    const tunnelSrc = read('Musicmodules/music-stage/modes/tunnel-manager.js');
    assert.match(tunnelSrc, /R\.releaseWebGLContext/);
    assert.match(tunnelSrc, /await U\.settlePrograms\(renderer/);
    const signsSrc = read('Musicmodules/music-stage/modes/kowloon-signs.js');
    assert.match(signsSrc, /willReadFrequently:\s*true/);
    assert.doesNotMatch(signsSrc, /shadowBlur/);

    dom.window.close();
});