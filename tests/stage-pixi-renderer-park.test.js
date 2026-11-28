'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Parking a Pixi renderer between stages: the next stage with the same canvas
// settings gets it back with an empty, reset stage; others get a new one, and
// an unclaimed renderer is destroyed after a while.
const load = () => {
    const timers = [];
    const made = [];
    class Node {
        constructor() {
            this.children = [];
            this.destroyed = false;
            const point = (x, y) => ({ x, y, set(a, b) { this.x = a; this.y = b; } });
            this.position = point(0, 0);
            this.pivot = point(0, 0);
            this.scale = point(1, 1);
            this.alpha = 1;
            this.visible = true;
            this.rotation = 0;
        }
        removeChildren() { const out = this.children; this.children = []; return out; }
        destroy() { this.destroyed = true; }
    }
    class Application {
        constructor() { made.push(this); this.destroyed = false; this.renders = 0; }
        async init(options) {
            this.options = options;
            this.renderer = {};
            this.stage = new Node();
            this.canvas = { removed: 0, remove() { this.removed += 1; } };
        }
        stop() {}
        render() { this.renders += 1; }
        destroy() { this.destroyed = true; this.renderer = null; }
    }
    const PIXI = { Application };
    const context = vm.createContext({
        console, PIXI, document: { hidden: false },
        setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
    });
    context.window = context;
    for (const file of ['music-stage-runtime.js', 'modes/stage-pixi-effects.js']) {
        vm.runInContext(fs.readFileSync(`Musicmodules/music-stage/${file}`, 'utf8'), context);
    }
    return { Effects: context.MusicStagePixiEffects, PIXI, Node, made, timers, context };
};
const settings = { antialias: false, resolution: 1, preference: 'webgl', backgroundAlpha: 0 };

test('a released renderer is reused once, with a clean stage', async () => {
    const { Effects, PIXI, Node, made, timers } = load();
    const first = await Effects.createApplication(PIXI, settings);
    const child = new Node();
    first.stage.children.push(child);
    first.stage.filters = ['print'];
    first.stage.alpha = 0.4;
    first.stage.position.set(10, 20);
    assert.equal(Effects.releaseApplication(first), true);
    assert.equal(child.destroyed, true);
    assert.equal(first.stage.children.length, 0);
    assert.equal(first.stage.filters, null);
    assert.equal(first.stage.alpha, 1);
    assert.deepEqual([first.stage.position.x, first.stage.position.y], [0, 0]);
    assert.equal(first.renders, 1, 'cleared before it is detached');
    assert.equal(first.canvas.removed, 1);
    assert.equal(timers.length, 1);

    const second = await Effects.createApplication(PIXI, { ...settings });
    assert.equal(second, first);
    assert.equal(timers.length, 0, 'claimed renderer is no longer scheduled for disposal');
    const third = await Effects.createApplication(PIXI, settings);
    assert.notEqual(third, first);
    assert.equal(made.length, 2);
});

test('different canvas settings never share a renderer', async () => {
    const { Effects, PIXI } = load();
    const plain = await Effects.createApplication(PIXI, settings);
    Effects.releaseApplication(plain);
    const smoothed = await Effects.createApplication(PIXI, { ...settings, antialias: true });
    assert.notEqual(smoothed, plain);
    const sharper = await Effects.createApplication(PIXI, { ...settings, resolution: 2 });
    assert.notEqual(sharper, plain);
    assert.equal(await Effects.createApplication(PIXI, settings), plain);
});

test('unclaimed renderers are destroyed, and at most two are kept', async () => {
    const { Effects, PIXI, timers } = load();
    const apps = [];
    for (let i = 0; i < 3; i++) apps.push(await Effects.createApplication(PIXI, settings));
    assert.equal(Effects.releaseApplication(apps[0]), true);
    assert.equal(Effects.releaseApplication(apps[1]), true);
    assert.equal(Effects.releaseApplication(apps[2]), false);
    assert.equal(apps[2].destroyed, true);
    timers.splice(0).forEach(t => t.fn());
    assert.equal(apps[0].destroyed, true);
    assert.equal(apps[1].destroyed, true);
    const next = await Effects.createApplication(PIXI, settings);
    assert.ok(!apps.includes(next));
});

test('a hidden page destroys instead of parking', async () => {
    const { Effects, PIXI, context } = load();
    const app = await Effects.createApplication(PIXI, settings);
    context.document.hidden = true;
    assert.equal(Effects.releaseApplication(app), false);
    assert.equal(app.destroyed, true);
});
