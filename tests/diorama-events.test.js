'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ console, Intl });
context.window = context;
for (const file of ['music-stage-runtime.js', 'modes/diorama-director.js',
    'modes/diorama-camera.js', 'modes/diorama-events.js']) {
    vm.runInContext(fs.readFileSync(`Musicmodules/music-stage/${file}`, 'utf8'), context);
}
const R = context.MusicStageRuntime;
const D = context.MusicStageDioramaDirector;
const C = context.MusicStageDioramaCamera;
const E = context.MusicStageDioramaEvents;
const plain = v => JSON.parse(JSON.stringify(v));
const build = (lines = [], duration = 180, options = {}) => {
    const timeline = D.compile({ lines: R.normalizeLines(lines), duration, trackId: 'events-test' });
    const track = C.createTrack(timeline);
    return { timeline, track, events: E.compile(timeline, track, options) };
};
test('events are deterministic, separated and whale appears at most once', () => {
    const { timeline, track, events } = build();
    assert.deepEqual(plain(events), plain(E.compile(timeline, track)));
    assert.equal(events.filter(e => e.kind === 'whale').length, 1);
    assert.ok(events.some(e => e.kind === 'rabbit'));
    for (let i = 0; i < events.length; i++) {
        assert.ok(events[i].end <= timeline.duration);
        if (i) assert.ok(events[i].start - events[i - 1].end >= 24);
        const e = events[i], t = e.start + e.duration * 0.5;
        const first = plain(E.sample(e, t));
        E.sample(e, e.end - 0.1);
        assert.deepEqual(plain(E.sample(e, t)), first);
        assert.equal(E.sample(e, e.end), null);
        assert.equal(E.sample(e, e.start - 0.1), null);
    }
});
test('dense vocals exclude major spectacles; station birds remain peripheral', () => {
    const { events } = build([
        { startTime: 0, endTime: 90, fullText: '持续的人声' },
        { startTime: 80, endTime: 180, fullText: '重叠的人声' }
    ], 181);
    assert.ok(events.every(e => e.kind === 'pigeons' && e.readingClearance === 'peripheral'));
});
test('rabbit ripples stay at contact positions and are absent before contact', () => {
    const rabbit = build().events.find(e => e.kind === 'rabbit');
    assert.equal(E.sample(rabbit, rabbit.start + 0.3).ripples.length, 0);
    const a = E.sample(rabbit, rabbit.start + 0.75);
    const b = E.sample(rabbit, rabbit.start + 1.1);
    assert.notEqual(a.body.z, b.body.z);
    assert.equal(a.ripples[0].x, b.ripples[0].x);
    assert.equal(a.ripples[0].z, b.ripples[0].z);
    assert.ok(b.ripples[0].radius > a.ripples[0].radius);
});
test('whale stages can be sought directly and leave a world-space afterglow', () => {
    const whale = build().events.find(e => e.kind === 'whale');
    for (const [age, stage] of [[1, 'omen'], [2.5, 'emerge'], [4, 'rise'],
        [5.5, 'cross'], [7, 'land'], [9, 'afterglow']]) {
        const state = E.sample(whale, whale.start + age);
        assert.equal(state.stage, stage);
        assert.ok(Number.isFinite(state.body.y));
    }
    const after = E.sample(whale, whale.start + 9);
    assert.ok(after.body.y < -12, 'The whole whale, not just its centre, must submerge');
    assert.ok(after.ripples.length > 0);
});
test('fireworks require explicit opt-in and a chorus aftermath', () => {
    const lines = [{ startTime: 0, endTime: 10, fullText: '副歌', isChorus: true },
        { startTime: 24, endTime: 30, fullText: '下一句' }];
    assert.ok(!build(lines, 32).events.some(e => e.kind === 'fireworks'));
    assert.ok(build(lines, 32, { fireworks: true }).events.some(e => e.kind === 'fireworks'));
    assert.ok(!build([], 180, { fireworks: true }).events.some(e => e.kind === 'fireworks'));
});
test('ordinary lyric breaths admit both meteors and rabbits without overlapping events', () => {
    const lines = Array.from({ length: 35 }, (_, i) => ({
        startTime: i * 6, endTime: i * 6 + 3, fullText: `第${i}句`
    }));
    const { events } = build(lines, 215);
    assert.ok(events.some(e => e.kind === 'meteor' && e.viewPlaced));
    assert.ok(events.some(e => e.kind === 'rabbit' && e.viewPlaced));
    for (let i = 1; i < events.length; i++) assert.ok(events[i].start >= events[i - 1].end);
});
test('station birds have physical addresses and respect the scenery toggle', () => {
    const lines = [{ startTime: 0, endTime: 90, fullText: '持续的人声' },
        { startTime: 80, endTime: 180, fullText: '重叠的人声' }];
    const birds = build(lines, 181).events.filter(e => e.kind === 'pigeons');
    assert.ok(birds.length > 0);
    birds.forEach(e => {
        assert.equal(e.address, e.stationId * 110 + 38);
        assert.equal(E.sample(e, e.start + 0.5).stage, 'perched');
        assert.equal(E.sample(e, e.start + 2).stage, 'flight');
    });
    assert.ok(!build(lines, 181, { narrativeStations: false }).events.some(e => e.kind === 'pigeons'));
});
test('whale camera follows the shared body trajectory and seeks exactly', () => {
    const { timeline, track, events } = build();
    track.events = events;
    const whale = events.find(e => e.kind === 'whale');
    for (const age of [2.5, 4, 5.5, 6.5]) {
        const time = whale.start + age;
        const pose = C.pose(timeline, track, time);
        const body = E.sample(whale, time).body;
        const delta = [body.x - pose.position.x, Math.max(0.8, body.y) - pose.position.y,
            body.z - pose.position.z];
        const dot = (delta[0] * pose.direction.x + delta[1] * pose.direction.y
            + delta[2] * pose.direction.z) / Math.hypot(...delta);
        assert.ok(dot > 0.999, `Whale missed at age ${age}`);
        C.pose(timeline, track, whale.end);
        assert.deepEqual(plain(C.pose(timeline, track, time)), plain(pose));
        assert.equal(C.pose(timeline, track, time, { journeyEvents: false }).eventFocus, null);
    }
    for (const boundary of [whale.start, whale.start + 8.2, whale.end]) {
        const a = C.pose(timeline, track, boundary - 0.0001);
        const b = C.pose(timeline, track, boundary + 0.0001);
        assert.ok(Math.abs(a.yaw - b.yaw) < 0.001);
        assert.ok(Math.abs(a.pitch - b.pitch) < 0.001);
    }
});

test('rabbit alternates landing sides and keeps position and heading continuous', () => {
    const rabbit = build().events.find(e => e.kind === 'rabbit');
    const landings = Array.from({ length: 8 }, (_, i) => E.rabbitAt(rabbit, 0.6 + i * 0.8));
    for (let i = 1; i < landings.length; i++) {
        assert.ok(Math.abs(landings[i].lateral - landings[i - 1].lateral) > 3);
        assert.ok(landings[i].ahead > landings[i - 1].ahead);
        if (i > 1) assert.ok((landings[i].lateral - landings[i - 1].lateral)
            * (landings[i - 1].lateral - landings[i - 2].lateral) < 0);
    }
    for (let i = 1; i < 7; i++) {
        const time = 0.6 + i * 0.8;
        const a = E.rabbitAt(rabbit, time - 0.00001);
        const b = E.rabbitAt(rabbit, time + 0.00001);
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.001);
        assert.ok(Math.abs(a.turn - b.turn) < 0.001);
    }
});