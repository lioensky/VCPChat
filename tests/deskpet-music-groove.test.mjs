import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMusicGroove, groovePose } from '../DeskPetmodules/musicGroove.js';
import { resolveDanceProfile, createDanceScheduler, createDanceParameterLayer } from '../DeskPetmodules/danceProfile.js';
import { createLifeMotion } from '../DeskPetmodules/lifeMotion.js';
import { createPetLife } from '../DeskPetmodules/petLife.js';
import { createPetMusic } from '../DeskPetmodules/petMusic.js';
const require = createRequire(import.meta.url);
const bus = require('../modules/services/musicGrooveBus.js');
const prefs = require('../modules/deskpet/petPrefs.js');

test('regular impulses produce stable tempo; pause, silence and stale samples stop dancing', () => {
    const analyzer = createMusicGroove();
    let state;
    for (let i = 0; i < 200; i++) {
        state = analyzer.push(Array(64).fill(i % 10 === 0 ? 0.8 : 0.1), { now: i * 0.05, trackKey: 'a' });
    }
    assert.ok(Math.abs(state.bpm - 120) < 3);
    assert.ok(state.confidence >= 0.75);
    assert.equal(state.playing, true);
    assert.equal(analyzer.snapshot(12).playing, false);
    state = analyzer.push([], { now: 12, playing: false });
    assert.equal(state.playing, false);
    assert.equal(state.energy, 0);
    for (let i = 0; i < 40; i++) state = analyzer.push(Array(64).fill(0), { now: 13 + i * 0.05 });
    assert.equal(state.playing, false);
    assert.ok(Object.values(groovePose(state).params).every(v => v === 0));
});

test('malformed spectrum stays finite; track changes reset tempo and history', () => {
    const analyzer = createMusicGroove();
    analyzer.push([NaN, Infinity, -4, 20], { now: 0 });
    const state = analyzer.push([0, 0], { now: 1, trackKey: 'new' });
    assert.ok(Object.values(state).filter(v => typeof v === 'number').every(Number.isFinite));
    assert.equal(state.confidence, 0);
    assert.equal(analyzer.push(null, { now: 2 }).playing, false);
});

test('Nova default selects only dance-like motion groups; missing capabilities degrade safely', () => {
    const profile = resolveDanceProfile(undefined, { motionGroups: ['Idle', 'Wave', 'Heart', 'Cheer', 'Tea', 'Typing'] });
    assert.deepEqual(profile.gestures.map(g => g.motion), ['Wave', 'Heart', 'Cheer']);
    assert.equal(resolveDanceProfile(undefined).gestures.length, 0);
    assert.equal(resolveDanceProfile(false).enabled, false);
});

test('third-party filenames, cleaned expression names and parameter mapping resolve from catalog', () => {
    const profile = resolveDanceProfile({
        map: { bounce: { id: 'WZY', scale: 0.35 } },
        gestures: [
            { motion: '手势3比心.motion3.json' },
            { expression: '按键 星星眼' },
            { params: { AJYSYC: 2, unknown: 1 } },
            { motion: '../evil.motion3.json' },
        ],
    }, {
        paramIds: new Set(['WZY', 'AJYSYC']),
        catalog: {
            items: [
                { id: 'm1', kind: 'motion', name: '双手比心', group: 'deskpet_m1', duration: 2 },
                { id: 'e1', kind: 'expression', name: '星星眼', parameters: [{ id: 'star', value: 1 }] },
            ],
            motions: { deskpet_m1: [{ File: '手势3比心.motion3.json' }] },
        },
    });
    assert.equal(profile.gestures.length, 3);
    assert.equal(profile.gestures[0].motion, 'deskpet_m1');
    assert.equal(profile.gestures[1].parameters[0].id, 'star');
    assert.deepEqual(profile.gestures[2].params, { AJYSYC: 2 });
    assert.deepEqual(profile.bounce, { id: 'WZY', scale: 0.35 });
});

test('scheduler waits several bars, expires, suppresses accents and clears on interruption', () => {
    const scheduler = createDanceScheduler({ random: () => 0 });
    const profile = resolveDanceProfile({ every: [2, 2], gestures: [{ params: { hand: 1 }, beats: 4 }] }, { paramIds: new Set(['hand']) });
    const frame = beat => ({ playing: true, beat, energy: 0.3, bpm: 120 });
    assert.equal(scheduler.step(frame(0), profile).started, null);
    assert.equal(scheduler.step(frame(7.9), profile).started, null);
    assert.ok(scheduler.step(frame(8), profile).started);
    assert.equal(scheduler.step(frame(12), profile).active, null);
    assert.equal(scheduler.step(frame(17), profile, false).active, null);
    assert.equal(scheduler.step(frame(18), profile).started, null);
});

test('temporary hard-cut parameter layer restores pose without changing outfit', () => {
    const values = { hand: 0.2, outfit: 1, star: 0 };
    const core = { getParameterValueById: id => values[id], setParameterValueById: (id, v) => { values[id] = v; } };
    const layer = createDanceParameterLayer(core, id => id, new Set(Object.keys(values)));
    layer.apply({ params: { hand: 2 } });
    assert.equal(values.hand, 2);
    layer.apply({ params: { hand: 2 } });
    layer.apply(null);
    assert.equal(values.hand, 0.2);
    assert.equal(values.outfit, 1);
});

test('life motion interpolates rhythm and ignores it while held or asleep', () => {
    const life = createLifeMotion();
    life.setGroove({ playing: true, energy: 0.8, beat: 0.2, bpm: 120 });
    let pose;
    for (let i = 0; i < 10; i++) pose = life.step(0.05);
    assert.ok(Math.abs(pose.params.ParamAngleZ) > 0.1);
    life.setHeld(true);
    for (let i = 0; i < 30; i++) pose = life.step(0.05);
    assert.equal(pose.bounce, 0);
    const pet = createPetLife();
    pet.force('asleep');
    pet.hold('music', true);
    assert.equal(pet.phase, 'asleep');
});

test('bus validates bounds, throttles playing frames, delivers stop immediately and unsubscribes', () => {
    const received = [];
    const off = bus.subscribe(v => received.push(v));
    assert.equal(bus.publish({ playing: true, data: [NaN] }, 0), false);
    assert.equal(bus.publish({ playing: true, data: [0.5] }, 1000), true);
    assert.equal(bus.publish({ playing: true, data: [0.6] }, 1010), false);
    assert.equal(bus.publish({ playing: false }, 1011), true);
    off();
    bus.publish({ playing: false }, 1012);
    assert.equal(received.length, 2);
    assert.equal(prefs.normalizeSettings({}).musicDance, true);
    assert.equal(prefs.normalizeSettings({ musicDance: false }).musicDance, false);
});

test('page bridge coordinates quiet, sleep, speech, stale data, visibility and disposal', () => {
    const oldWindow = globalThis.window;
    globalThis.window = new EventTarget();
    let time = 0, push, unsubscribed = false;
    const sent = [], holds = new Set();
    const ctx = {
        prefs: {}, isQuiet: () => ctx.prefs.doNotDisturb,
        life: { phase: 'awake', busy: false, get holds() { return [...holds]; }, hold: (key, on) => on ? holds.add(key) : holds.delete(key) },
        backend: { life: { groove: (frame, strength) => sent.push({ frame, strength }) }, setActive() {} },
        api: { onMusicGroove: fn => { push = fn; return () => { unsubscribed = true; }; } },
        speech: { active: () => false }, frame: {},
    };
    const bridge = createPetMusic(ctx, { now: () => time });
    try {
        push({ playing: true, data: Array(64).fill(0.6) });
        assert.equal(bridge.active, true);
        assert.equal(holds.has('music'), true);
        ctx.speech.active = () => true;
        bridge.update();
        assert.equal(sent.at(-1).strength, 0.35);
        ctx.prefs.doNotDisturb = true;
        bridge.update();
        assert.equal(bridge.active, false);
        ctx.prefs.doNotDisturb = false;
        time = 2;
        bridge.update();
        assert.equal(bridge.active, false);
        bridge.visibility(false);
        bridge.dispose();
        assert.equal(unsubscribed, true);
        assert.equal(holds.has('music'), false);
    } finally { globalThis.window = oldWindow; }
});

test('additive gesture expressions never accumulate across frames and restore on exit', () => {
    const values = { star: 0.1 };
    const core = { getParameterValueById: id => values[id], setParameterValueById: (id, v) => { values[id] = v; } };
    const layer = createDanceParameterLayer(core, id => id, new Set(['star']));
    const gesture = { parameters: [{ id: 'star', value: 0.5, blend: 'Add' }] };
    for (let i = 0; i < 100; i++) layer.apply(gesture);
    assert.equal(values.star, 0.6);
    layer.apply(null);
    assert.equal(values.star, 0.1);
});

test('stopping music releases smoothly instead of snapping the rhythmic pose', () => {
    const life = createLifeMotion();
    for (let i = 0; i < 20; i++) {
        life.setGroove({ playing: true, energy: 0.8, beat: 0.5, bpm: 120 });
        life.step(0.016);
    }
    life.setGroove(null);
    const pose = life.step(0.016);
    assert.ok(Math.abs(pose.params.ParamAngleZ) > 0.1);
    for (let i = 0; i < 120; i++) life.step(0.016);
    assert.equal(life.settled, true);
});

test('real bundled Nova catalogs retain valid default dance motions', async () => {
    const { readCapabilities } = require('../modules/deskpet/live2dCapabilities.js');
    const fs = await import('node:fs/promises');
    for (const [folder, model, count] of [['chibi', 'NovaChibi.model3.json', 3], ['maid', 'NovaMaid.model3.json', 0]]) {
        const base = new URL(`../assets/deskpet/nova/${folder}/`, import.meta.url);
        const { fileURLToPath } = await import('node:url');
        const catalog = await readCapabilities(fileURLToPath(new URL(model, base)));
        const definition = JSON.parse(await fs.readFile(new URL(model, base)));
        const profile = resolveDanceProfile(undefined, { catalog, motionGroups: Object.keys(definition.FileReferences.Motions) });
        assert.equal(profile.gestures.length, count);
    }
});

test('motion cleanup restores saved heart and effects before the engine saves its next baseline', async () => {
    const { createDanceMotionLease } = await import('../DeskPetmodules/danceProfile.js');
    const values = { heart: 0, hand: 0, effect: 0, outfit: 1 };
    let baseline = { ...values };
    const core = { getParameterValueById: id => values[id], setParameterValueById: (id, value) => { values[id] = value; } };
    const lease = createDanceMotionLease(core, id => id, new Set(Object.keys(values)));
    lease.begin(['heart', 'hand', 'effect']);
    lease.beforeMotionUpdate();
    Object.assign(values, { heart: 13, hand: 1, effect: 1 });
    baseline = { ...values }; // 引擎保存动作产生的姿态
    Object.assign(values, baseline);
    lease.release();
    lease.beforeMotionUpdate();
    baseline = { ...values };
    assert.deepEqual(baseline, { heart: 0, hand: 0, effect: 0, outfit: 1 });
    lease.begin(['heart']);
    lease.release(); // 异步加载前被取消也不能遗留待捕获状态
    lease.beforeMotionUpdate();
    assert.equal(values.heart, 0);
});

test('tempo changes after long playback cannot jump accumulated phase', () => {
    const analyzer = createMusicGroove();
    let previous = 0;
    for (let i = 0; i < 6000; i++) {
        const spacing = i < 3000 ? 10 : 12;
        const state = analyzer.push(Array(64).fill(i % spacing === 0 ? 0.8 : 0.1), { now: i * 0.05 });
        if (i > 1) {
            assert.ok(state.beat >= previous - 0.02);
            assert.ok(state.beat - previous < 0.2, `phase jumped at ${i}`);
        }
        previous = state.beat;
    }
});

test('noisy incoming phase and energy updates do not jerk the rendered pose', () => {
    const life = createLifeMotion();
    let previous = 0;
    for (let i = 0; i < 600; i++) {
        if (i % 3 === 0) life.setGroove({
            playing: true, energy: i % 6 === 0 ? 0.2 : 1,
            bpm: i % 6 === 0 ? 90 : 150, beat: i / 30 + (i % 6 === 0 ? -0.3 : 0.3),
        });
        const value = life.step(1 / 60).params.ParamAngleZ;
        assert.ok(Math.abs(value - previous) < 0.4, `pose jerk at ${i}`);
        previous = value;
    }
});