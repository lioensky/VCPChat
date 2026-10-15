'use strict';
// 繁星如盛 · determinism, seek safety, bounded pool and lazy release.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Point {
    constructor(x = 0, y = x) { this.set(x, y); }
    set(x, y = x) { this.x = x; this.y = y; }
    copyFrom(p) { this.set(p.x, p.y); }
}
class Container {
    constructor() {
        this.children = [];
        this.position = new Point();
        this.pivot = new Point();
        this.scale = new Point(1);
        this.skew = new Point();
        this.anchor = new Point();
        this.rotation = 0;
        this.alpha = 1;
        this.visible = true;
        this.tint = 0xffffff;
    }
    get x() { return this.position.x; }
    get y() { return this.position.y; }
    addChild(...nodes) {
        nodes.forEach(node => { node.removeFromParent(); node.parent = this; this.children.push(node); });
        return nodes[0];
    }
    addChildAt(node, index) { this.addChild(node); this.children.pop(); this.children.splice(index, 0, node); return node; }
    removeFromParent() {
        if (!this.parent) return;
        const index = this.parent.children.indexOf(this);
        if (index >= 0) this.parent.children.splice(index, 1);
        this.parent = null;
    }
    removeChildren() { const nodes = this.children.splice(0); nodes.forEach(n => { n.parent = null; }); return nodes; }
    destroy() { this.removeFromParent(); this.removeChildren().forEach(n => n.destroy()); this.destroyed = true; }
}
const chain = ['rect', 'roundRect', 'poly', 'fill', 'stroke', 'moveTo', 'lineTo', 'circle', 'ellipse', 'arc', 'quadraticCurveTo'];
class Graphics extends Container {
    constructor(sharedContext) { super(); this.context = sharedContext || null; this.commands = []; }
    clear() { this.commands = []; return this; }
}
class GraphicsContext {
    constructor() { this.commands = []; }
    destroy() { this.destroyed = true; }
}
for (const name of chain) {
    Graphics.prototype[name] = function (...args) { this.commands.push([name, ...args]); return this; };
    GraphicsContext.prototype[name] = function (...args) { this.commands.push([name, ...args]); return this; };
}
class Text extends Container {
    constructor(options) { super(); this.text = options.text; this.style = options.style; this.width = options.style.fontSize * 0.8; }
}
const PIXI = { Container, Graphics, GraphicsContext, Text, Color: { shared: {
    setValue() { return this; }, toNumber() { return 0x79d8ff; }
} } };
const document = { createElement: () => ({ getContext: () => ({ font: '', measureText: t => ({ width: t.length * 18 }) }) }) };
const context = vm.createContext({ console, Intl, PIXI, document });
context.window = context;
for (const file of ['music-stage-runtime.js', 'modes/stage-pixi-effects.js', 'modes/stage-starbloom.js',
    'modes/tempera-pixi-core.js', 'modes/sonnet-pixi-core.js']) {
    vm.runInContext(fs.readFileSync(`Musicmodules/music-stage/${file}`, 'utf8'), context);
}
const R = context.MusicStageRuntime;
const S = context.MusicStageStarbloom;

// Relay pairs (gap < 3s), one long interlude (deep-space fall) and a Latin line.
const lines = R.normalizeLines([
    { startTime: 1, endTime: 3.6, fullText: '星光落在你的眼睛' },
    { startTime: 3.8, endTime: 6.2, fullText: '繁花追逐着流星' },
    { startTime: 6.4, endTime: 8.8, fullText: '在夜色里绽放' },
    { startTime: 13, endTime: 15.5, fullText: 'stars bloom tonight' },
    { startTime: 15.7, endTime: 18, fullText: '最后落入新的位置' }
]);
const indexAt = time => { let found = -1; lines.forEach((l, i) => { if (l.startTime <= time) found = i; }); return found; };
const frame = time => {
    const currentLineIndex = indexAt(time);
    return { playbackTime: time, lines, currentLineIndex, activeLine: lines[currentLineIndex] || null,
        lineProgress: 0, isPlaying: true, audio: {}, track: { path: 'starbloom-test' } };
};
const W = 1000, H = 650;
const make = mode => { const parent = new Container(); return { parent, bloom: S.create(PIXI, parent, mode) }; };
const root = parent => parent.children[0];
const layers = parent => { const [trails, petals, glyphs, stars] = root(parent).children; return { trails, petals, glyphs, stars }; };
// Hidden nodes are not part of the rendered frame: their leftover transforms are irrelevant.
const pose = n => n.visible
    ? [n.text ?? '', n.x, n.y, n.scale.x, n.rotation, n.alpha, n.tint]
    : [n.text ?? '', 'hidden'];
const capture = parent => {
    const l = layers(parent);
    return {
        glyphs: l.glyphs.children.map(pose), petals: l.petals.children.map(pose),
        stars: l.stars.children.map(pose), trails: JSON.stringify(l.trails.commands)
    };
};
const checkpoints = [0.5, 1.2, 3.75, 3.95, 4.3, 6.5, 9.5, 12.2, 12.7, 13.4, 15.8, 19.5, 22];

for (const mode of ['sonnet', 'tempera']) {
    test(`${mode}: same time evaluates to identical frame (no hidden state)`, () => {
        const { parent, bloom } = make(mode);
        for (const t of checkpoints) {
            bloom.update(frame(t), {}, 0x79d8ff, 'seed', W, H);
            const a = capture(parent);
            bloom.update(frame(t), {}, 0x79d8ff, 'seed', W, H);
            assert.deepEqual(capture(parent), a, `t=${t}`);
            a.glyphs.filter(p => p[1] !== 'hidden')
                .forEach(p => assert.ok(p.slice(1, 6).every(Number.isFinite), `finite pose t=${t}`));
        }
        bloom.destroy();
    });

    test(`${mode}: sequential playback equals direct seek, trails included`, () => {
        const played = make(mode);
        const pending = [...checkpoints];
        for (let t = 0; t <= 22.0001 && pending.length; t += 1 / 30) {
            const time = Math.abs(t - pending[0]) < 1 / 60 ? pending.shift() : t;
            played.bloom.update(frame(time), {}, 0x79d8ff, 'seed', W, H);
            if (time !== t || checkpoints.includes(time)) {
                const fresh = make(mode);
                fresh.bloom.update(frame(time), {}, 0x79d8ff, 'seed', W, H);
                assert.deepEqual(capture(played.parent), capture(fresh.parent), `seek mismatch t=${time}`);
                assert.deepEqual(played.bloom.snapshot(), fresh.bloom.snapshot());
                fresh.bloom.destroy();
            }
            assert.ok(played.bloom.snapshot().bloomLines <= 6, 'display pool must stay bounded');
        }
        // Backward seek reproduces the earlier frame as well.
        played.bloom.update(frame(4.3), {}, 0x79d8ff, 'seed', W, H);
        const fresh = make(mode);
        fresh.bloom.update(frame(4.3), {}, 0x79d8ff, 'seed', W, H);
        assert.deepEqual(capture(played.parent), capture(fresh.parent));
        played.bloom.destroy();
        fresh.bloom.destroy();
    });
}

test('relay flights carry trails and petals; reduced motion stays static', () => {
    const { parent, bloom } = make('sonnet');
    bloom.update(frame(3.75), {}, 0x79d8ff, 'seed', W, H);
    const s = bloom.snapshot();
    assert.ok(s.bloomFlying > 0, 'second line should be in relay flight');
    assert.ok(layers(parent).trails.commands.length > 0, 'meteor trails drawn');
    assert.ok(layers(parent).petals.children.some(p => p.visible), 'petals chase the meteor');

    bloom.update(frame(3.75), { reducedMotion: true }, 0x79d8ff, 'seed', W, H);
    assert.equal(bloom.snapshot().bloomFlying, 0);
    assert.equal(layers(parent).trails.commands.length, 0);
    assert.ok(layers(parent).petals.children.every(p => !p.visible));
    assert.ok(layers(parent).stars.children.every(p => !p.visible));

    bloom.update(frame(3.75), { quality: 'energy-saving' }, 0x79d8ff, 'seed', W, H);
    assert.ok(layers(parent).petals.children.every(p => !p.visible), 'energy-saving drops petals');
    bloom.destroy();
    assert.equal(parent.children.length, 0, 'destroy detaches the overlay root');
});

test('long interlude falls from deep space instead of relaying', () => {
    const { parent, bloom } = make('tempera');
    bloom.update(frame(12.7), {}, 0x79d8ff, 'seed', W, H);
    const visible = layers(parent).glyphs.children.filter(n => n.visible);
    assert.ok(visible.length > 0, 'line 4 is falling in');
    bloom.destroy();
});

for (const mode of ['tempera', 'sonnet']) {
    test(`${mode}: director creates starbloom lazily and releases it on layout change`, () => {
        const D = mode === 'tempera' ? context.TemperaPixiDirector : context.SonnetPixiDirector;
        const d = new D({});
        d.initialized = true;
        d.width = W; d.height = H;
        for (const key of ['sceneContainer', 'blocksContainer', 'hatchContainer', 'decorContainer', 'textContainer',
            'trackContainer', 'bloomContainer', 'frameDecorContainer', 'hudContainer', 'geoContainer']) d[key] = new Container();
        d.retirement = { capture() {}, update() {}, snapshot: () => ({}) };
        d.postProcess = { update() {} };
        d.app = { renderer: { resolution: 1, resize() {} }, render() {} };
        d.buildShot(lines[1], 'shot', null, {});
        d.update(frame(3), { lyricLayout: 'phrases' });
        assert.equal(d.starbloom, null, 'not allocated until selected');
        d.update(frame(4), { lyricLayout: 'starbloom' });
        assert.ok(d.starbloom, 'allocated on selection');
        assert.equal(d.bloomContainer.visible, true);
        assert.equal(d.textContainer.visible, false);
        assert.equal(d.sceneContainer.alpha, 1, 'relay glyphs bypass per-line scene fade');
        assert.ok(d.getDebugSnapshot().bloomGlyphs > 0);
        d.update(frame(4), { lyricLayout: 'phrases' });
        assert.equal(d.starbloom, null, 'released on layout change');
        assert.equal(d.bloomContainer.children.length, 0);
        assert.equal(d.textContainer.visible, true);
    });
}
// Editorial track regression (sibling layout): long Latin lines must wrap by word, not collapse into a thin rail.
test('editorial track flows long Latin lines by word and sets vertical Latin as a spine', () => {
    const E = context.MusicStagePixiEffects;
    const parent = new Container();
    const track = E.createEditorialTrack(PIXI, parent, 'sonnet');
    const source = R.normalizeLines([
        { startTime: 0, endTime: 4, fullText: 'I will follow the falling stars across the endless midnight sky tonight' },
        { startTime: 4, endTime: 8, fullText: 'Every little light becomes a flower when the morning finally arrives' },
        { startTime: 8, endTime: 12, fullText: 'We keep on running through the silver rain until the city sleeps' },
        { startTime: 12, endTime: 16, fullText: 'And I remember every word you whispered underneath the summer moon' },
        { startTime: 16, endTime: 20, fullText: '星光落在你的眼睛' }
    ]);
    const rotations = new Set();
    const minimum = Math.min(W, H) * 0.022;
    source.forEach((line, index) => {
        const f = { playbackTime: line.startTime + 1, lines: source, currentLineIndex: index, activeLine: line,
            lineProgress: 0.25, isPlaying: true, audio: {}, track: { path: 'latin' } };
        const { glyphs } = track.update(f, { trackVerticalChance: 0.9 }, 0x79d8ff, 'latin-seed', W, H);
        glyphs.filter(n => n.visible && n.dataset.startTime >= line.startTime && n.dataset.endTime <= line.endTime + 1e-6)
            .forEach(n => {
                const d = n.dataset;
                if (index < 4) {
                    assert.ok(d.fontSize > minimum * 1.6, `Latin type must stay readable (line ${index}: ${d.fontSize})`);
                    assert.ok(Math.abs(d.baseX) < W * 0.5 && Math.abs(d.baseY) < H * 0.5, 'wrapped block stays compact');
                } else {
                    assert.equal(d.baseRotation, 0, 'CJK path untouched');
                }
                rotations.add(d.baseRotation);
            });
    });
    assert.ok(rotations.has(0) && rotations.has(Math.PI / 2), 'both horizontal rows and vertical spines occur');
    track.destroy();
});