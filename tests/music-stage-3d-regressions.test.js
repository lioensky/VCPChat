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
    assert.ok(run(33.3, 200) >= 1, 'thirty frames a second steps down');
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
