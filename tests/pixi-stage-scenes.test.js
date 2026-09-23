'use strict';
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
    }
    get x() { return this.position.x; }
    get y() { return this.position.y; }
    addChild(...nodes) {
        nodes.forEach(node => {
            node.removeFromParent();
            node.parent = this;
            this.children.push(node);
        });
        return nodes[0];
    }
    addChildAt(node, index) {
        this.addChild(node);
        this.children.pop();
        this.children.splice(index, 0, node);
        return node;
    }
    removeFromParent() {
        if (this.parent) {
            const index = this.parent.children.indexOf(this);
            if (index >= 0) this.parent.children.splice(index, 1);
            this.parent = null;
        }
    }
    removeChildren() {
        const nodes = this.children.splice(0);
        nodes.forEach(node => { node.parent = null; });
        return nodes;
    }
    destroy() { this.removeChildren().forEach(node => node.destroy()); this.destroyed = true; }
}
class Graphics extends Container {
    constructor() { super(); this.commands = []; }
}
for (const name of ['rect', 'roundRect', 'poly', 'fill', 'stroke', 'moveTo', 'lineTo', 'circle', 'ellipse', 'arc', 'quadraticCurveTo']) {
    Graphics.prototype[name] = function (...args) {
        this.commands.push([name, ...args]);
        return this;
    };
}
class Text extends Container {
    constructor(options) {
        super();
        this.text = options.text;
        this.style = options.style;
        this.width = options.style.fontSize * 0.8;
    }
}
const PIXI = { Container, Graphics, Text, Color: { shared: {
    setValue() { return this; }, toNumber() { return 0x79d8ff; }
} } };
const context = vm.createContext({ console, Intl, PIXI });
context.window = context;
for (const file of ['music-stage-runtime.js', 'modes/stage-pixi-effects.js',
    'modes/tempera-pixi-core.js', 'modes/sonnet-pixi-core.js']) {
    vm.runInContext(fs.readFileSync(`Musicmodules/music-stage/${file}`, 'utf8'), context);
}
const R = context.MusicStageRuntime;
const E = context.MusicStagePixiEffects;
const lines = R.normalizeLines([{ startTime: 2, endTime: 8, fullText: '星光落在你的眼睛' }]);
const frame = time => ({
    playbackTime: time, activeLine: lines[0], lines, currentLineIndex: 0,
    lineProgress: (time - 2) / 6, isPlaying: false, audio: {}, track: { path: 'test' }
});
function director(mode) {
    const D = mode === 'tempera' ? context.TemperaPixiDirector : context.SonnetPixiDirector;
    const d = new D({});
    d.initialized = true;
    d.width = 1000; d.height = 650;
    for (const key of ['sceneContainer', 'blocksContainer', 'hatchContainer', 'decorContainer',
        'textContainer', 'trackContainer', 'frameDecorContainer', 'hudContainer', 'geoContainer']) {
        d[key] = new Container();
    }
    d.retirement = { capture() {}, update() {} };
    d.postProcess = { update() {} };
    d.app = { renderer: { resolution: 1, resize() {} }, render() {} };
    return d;
}
function pose(node) {
    return [node.x, node.y, node.scale.x, node.scale.y, node.rotation, node.alpha, node.visible];
}
for (const mode of ['tempera', 'sonnet']) {
    test(`${mode}: scene coverage, bounded rebuilds and deterministic poses`, () => {
        const d = director(mode);
        const kinds = new Set();
        for (let i = 0; i < 180; i++) {
            d.buildShot(lines[0], `track:${i}`, null, {});
            kinds.add(mode === 'tempera' ? d.activeKind : d.backgroundKind);
            d.update(frame(3), {});
            const layer = mode === 'tempera' ? d.blocksContainer : d.hudContainer;
            assert.ok(layer.children.length <= 8);
            const before = layer.children.map(pose);
            d.update(frame(6), {});
            d.update(frame(3), {});
            assert.deepEqual(layer.children.map(pose), before);
            for (const child of layer.children) {
                assert.ok(pose(child).slice(0, 6).every(Number.isFinite));
            }
        }
        assert.equal(kinds.size, mode === 'tempera' ? 12 : 6);
        d.buildShot(null, 'empty', null, {});
        d.update({ ...frame(0), activeLine: null }, { reducedMotion: true });
        assert.equal(d.words.length, 0);
    });
}
test('phrase flourishes respect quality, decor, motion and accent switches', () => {
    const parent = new Container();
    const nodes = E.buildLyrics(PIXI, parent, lines[0], 1000, 650, {}, 'lyrics');
    const groups = E.buildPhraseStage(PIXI, parent, nodes, 0xffffff);
    const tuning = { performanceMode: 'sonnet' };
    E.animatePhraseStage(groups, frame(2.3), tuning, 'mask-reveal');
    assert.ok(groups[0].echoes.every(node => node.visible && node.alpha > 0));
    assert.equal(groups[0].root.mask, null, 'Singing text must not remain masked');
    const initial = groups[0].echoes.map(pose);
    const count = parent.children.length;
    for (const patch of [{ quality: 'energy-saving' }, { reducedMotion: true },
        { animationIntensity: 0 }, { accentEffects: false }, { accentMotion: 0 }, { showDecor: false }]) {
        E.animatePhraseStage(groups, frame(2.3), { ...tuning, ...patch }, 'mask-reveal');
        assert.ok(groups[0].echoes.every(node => !node.visible));
        assert.equal(groups[0].rays.visible, false);
    }
    E.animatePhraseStage(groups, frame(7), tuning, 'mask-reveal');
    E.animatePhraseStage(groups, frame(2.3), tuning, 'mask-reveal');
    assert.deepEqual(groups[0].echoes.map(pose), initial);
    assert.equal(parent.children.length, count);
    E.clear(parent);
    assert.equal(parent.children.length, 0);
});

test('sonnet background dissolve keeps lyrics and frame steady and releases on seek', () => {
    const d = director('sonnet');
    const stage = new Container();
    d.retirement = E.createRetirement(PIXI, stage, { dissolve: true });
    const source = R.normalizeLines([
        { startTime: 0, endTime: 4, fullText: '前一幕' },
        { startTime: 4, endTime: 8, fullText: '下一幕' }
    ]);
    const f = (time, index) => ({
        ...frame(time), lines: source, activeLine: source[index],
        currentLineIndex: index, lineProgress: (time - source[index].startTime) / 4, isPlaying: true
    });
    d.buildShot(source[0], 'first', null, {});
    d.update(f(3.98, 0), {});
    d.buildShot(source[1], 'second', null, {});
    d.update(f(4, 1), {});
    assert.equal(stage.children.length, 1);
    assert.equal(stage.children[0].children.length, 2, 'Only backgrounds retire');
    assert.equal(stage.children[0].alpha, 1);
    assert.equal(d.hudContainer.alpha, 0);
    assert.equal(d.sceneContainer.alpha, 1);
    assert.equal(d.textContainer.alpha, 1);
    assert.equal(d.frameDecorContainer.alpha, 1);
    d.update(f(4.4, 1), {});
    assert.ok(Math.abs(d.hudContainer.alpha - 0.5) < 1e-10);
    assert.ok(Math.abs(stage.children[0].alpha + d.hudContainer.alpha - 1) < 1e-10);
    assert.equal(stage.children[0].skew.x, 0);
    const paused = { ...f(4.4, 1), isPlaying: false };
    d.update(paused, {});
    assert.ok(Math.abs(d.hudContainer.alpha - 0.5) < 1e-10);
    d.update(f(6, 1), {});
    assert.equal(stage.children.length, 0);
    assert.equal(d.hudContainer.alpha, 1);
    d.retirement.destroy();
});

test('dissolve bypasses disabled motion and respects fast and none hints', () => {
    for (const tuning of [{ reducedMotion: true }, { sceneTransitions: false }, { quality: 'energy-saving' }]) {
        const stage = new Container();
        const retirement = E.createRetirement(PIXI, stage, { dissolve: true });
        const scene = new Container();
        const background = new Container();
        background.addChild(new Graphics());
        retirement.update({ ...frame(7.99), isPlaying: true }, tuning);
        const next = { startTime: 8, endTime: 12 };
        retirement.capture([background], scene, next);
        assert.equal(retirement.update({ ...frame(8), activeLine: next }, tuning), 1);
        assert.equal(stage.children.length, 0);
        retirement.destroy();
    }
    for (const hint of ['fast', 'none']) {
        const stage = new Container();
        const retirement = E.createRetirement(PIXI, stage, { dissolve: true });
        const scene = new Container();
        const background = new Container();
        background.addChild(new Graphics());
        retirement.update({ ...frame(7.99), isPlaying: true }, {});
        const next = { startTime: 8, endTime: 12, renderHints: { lineTransitionMode: hint } };
        retirement.capture([background], scene, next);
        retirement.update({ ...frame(8.13), activeLine: next }, {});
        assert.equal(stage.children.length, 0);
        retirement.destroy();
    }
});