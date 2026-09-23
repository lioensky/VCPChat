'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ console, Intl });
context.window = context;
for (const file of [
    'music-stage-runtime.js', 'modes/stage-pixi-effects.js',
    'modes/diorama-director.js', 'modes/diorama-camera.js'
]) vm.runInContext(fs.readFileSync(`Musicmodules/music-stage/${file}`, 'utf8'), context);
const R = context.MusicStageRuntime;
const D = context.MusicStageDioramaDirector;
const C = context.MusicStageDioramaCamera;
const plain = value => JSON.parse(JSON.stringify(value));
const lines = R.normalizeLines(Array.from({ length: 24 }, (_, i) => ({
    startTime: 4 + i * 6, endTime: 7 + i * 6,
    fullText: `第${i}站 等待星光`, isChorus: i >= 8 && i < 12 || i >= 18 && i < 22
})));

test('director produces stable contiguous chapters and upgraded chorus returns', () => {
    const a = D.compile({ lines, trackId: 'test', duration: 160 });
    const b = D.compile({ lines, trackId: 'test', duration: 160 });
    assert.deepEqual(plain(a.acts), plain(b.acts));
    assert.equal(a.acts[0].kind, 'Departure');
    assert.equal(a.acts.at(-1).kind, 'Terminus');
    for (let i = 1; i < a.acts.length; i++) assert.equal(a.acts[i - 1].end, a.acts[i].start);
    const choruses = a.acts.filter(act => act.kind === 'Chorus');
    assert.equal(choruses.length, 2);
    assert.ok(choruses[1].params.speed > choruses[0].params.speed);
    let previous = 0;
    for (let t = 0; t <= 160; t += 0.13) {
        const s = a.distanceAt(t);
        assert.ok(Number.isFinite(s) && s >= previous);
        previous = s;
    }
    assert.equal(a.rhythmSource, 'travel-rhythm');
});

test('cuts avoid all singing intervals including overlapping voices', () => {
    const overlap = R.normalizeLines([
        { startTime: 0, endTime: 20, fullText: '持续的人声' },
        { startTime: 8, endTime: 10, fullText: '第二个人', isChorus: true },
        { startTime: 30, endTime: 32, fullText: '最后一站' }
    ]);
    const timeline = D.compile({ lines: overlap, duration: 40 });
    timeline.cuts.forEach((cut, i) => {
        assert.equal(timeline.isSinging(cut.time), false);
        if (i) assert.ok(cut.time - timeline.cuts[i - 1].time >= 8);
    });
    assert.equal(timeline.isSinging(15), true);
});

test('horizontal track and camera are independent of update history', () => {
    const timeline = D.compile({ lines, duration: 160 });
    const track = C.createTrack(timeline);
    for (const s of [-20, 0, 10, 100, 400]) {
        const frame = track.at(s);
        assert.equal(frame.position.y, 0);
        assert.equal(frame.forward.y, 0);
        assert.ok(Math.abs(Math.hypot(frame.forward.x, frame.forward.z) - 1) < 1e-12);
    }
    const first = C.pose(timeline, track, 25);
    C.pose(timeline, track, 100);
    assert.deepEqual(plain(C.pose(timeline, track, 25)), plain(first));
    const calm = C.pose(timeline, track, 25, { reducedMotion: true });
    assert.equal(calm.roll, 0);
    assert.equal(calm.rig, 'CAB');
    assert.ok(C.pose(timeline, track, 27).distance > first.distance);
});

test('instrumental, short tracks and supplied beat grids remain valid', () => {
    for (const duration of [1, 4, 30, 3600]) {
        const timeline = D.compile({ lines: [], duration });
        assert.ok(Number.isFinite(timeline.distanceAt(duration)));
        assert.equal(timeline.acts[0].start, 0);
        assert.equal(timeline.acts.at(-1).end, duration);
        assert.ok(timeline.distanceAt(duration) > 0);
    }
    const timeline = D.compile({ lines, beatTimes: [2, 1, 1, NaN, -1, 4] });
    assert.equal(timeline.rhythmSource, 'provided-beats');
    assert.deepEqual(plain(timeline.beats), [1, 2, 4]);
});

test('phrase splitting preserves every source glyph and timestamp', () => {
    const phrases = D.compilePhrases(lines);
    lines.forEach((line, index) => {
        const glyphs = phrases.filter(p => p.lineIndex === index).flatMap(p => p.glyphs);
        assert.equal(glyphs.map(g => g.text).join(''), line.fullText);
        assert.deepEqual(plain(glyphs), plain(R.buildGlyphTimeline(line)));
        assert.ok(phrases.filter(p => p.lineIndex === index).every(p => p.glyphs.length <= 24));
    });
});

test('shared spectral flux freezes on pause and retains Pixi response', () => {
    const shared = R.createAudioOnset();
    const pixi = context.MusicStagePixiEffects.createPerformance();
    const frame = (time, value, playing = true) => ({
        playbackTime: time, isPlaying: playing, lines, track: { path: 'audio' },
        audio: { spectrum: Array(48).fill(value), power: 0.5 }
    });
    let last;
    for (let i = 0; i < 120; i++) {
        const f = frame(i / 60, i >= 35 && i < 45 ? 0.9 : 0.1);
        last = { ...shared.update(f) };
        const result = pixi.update(f, { performanceIntensity: 1, beatImpact: 1 }, []);
        assert.equal(result.impact, last.impact);
        assert.equal(result.energy, last.energy);
    }
    assert.ok(shared.snapshot().onsets > 0);
    const paused = { ...shared.update(frame(119 / 60, 1, false)) };
    assert.equal(paused.impact, last.impact);
    assert.equal(paused.energy, last.energy);
    assert.deepEqual(plain(shared.update(frame(119 / 60, 0, false))), plain(paused));
    assert.equal(shared.update(frame(0.2, 0.9)).impact, 0);
});

test('roadside screens group pages by travel and retain fixed world anchors', () => {
    const timeline = D.compile({ lines, duration: 160 });
    const options = { cameraSpeed: 1, aspect: 1.6, lyricCarrier: 'sign' };
    const plan = D.planEncounters(timeline, options);
    assert.ok(plan.encounters.length > 1);
    assert.ok(plan.encounters.length < timeline.phrases.length / 2,
        'Screens must be much less frequent than lyric pages');
    assert.ok(plan.encounters.some(encounter => encounter.pages.length >= 3));
    const assigned = plan.encounters.flatMap(encounter => encounter.pages);
    assert.equal(assigned.length, timeline.phrases.length);
    assert.equal(new Set(assigned).size, assigned.length);
    for (const encounter of plan.encounters) {
        assert.ok(encounter.address > encounter.endDistance);
        assert.ok(encounter.end >= encounter.start);
        assert.ok(encounter.previewStart <= encounter.start);
        for (const id of encounter.pages) assert.equal(plan.pageEncounter.get(id), encounter.id);
    }
    const slow = D.planEncounters(timeline, { ...options, cameraSpeed: 0.55 });
    const fast = D.planEncounters(timeline, { ...options, cameraSpeed: 1.85 });
    assert.ok(fast.encounters.length >= slow.encounters.length,
        'Faster travel must not demand a longer residence on each fixed screen');
    const track = C.createTrack(timeline, 1, options);
    const first = track.encounters[0];
    const anchor = plain(first.position);
    for (let time = first.start; time <= first.end; time += 0.1) {
        const pose = C.pose(timeline, track, time, options);
        assert.ok(Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch));
    }
    assert.deepEqual(plain(first.position), anchor, 'Reading must never drag a screen with the train');
    const stars = C.createTrack(timeline, 1, { ...options, lyricCarrier: 'constellation' });
    assert.equal(stars.encounters.length, 0);
    assert.equal(stars.pageEncounter.size, 0);
});

test('phrase camera choreography changes position and lens without boundary jumps', () => {
    const timeline = D.compile({ lines, duration: 160 });
    const options = { lyricCarrier: 'constellation', motionAmount: 1, animationIntensity: 1 };
    const track = C.createTrack(timeline, 1, options);
    const line = timeline.lines[9];
    const midpoint = (line.startTime + line.vocalEndTime) / 2;
    const moving = C.pose(timeline, track, midpoint, options);
    const calm = C.pose(timeline, track, midpoint, { ...options, motionAmount: 0 });
    assert.ok(moving.position.y > calm.position.y);
    assert.ok(moving.fov < timeline.sample(midpoint).fov);
    assert.equal(calm.roll, 0);
    assert.equal(calm.fov, 48);
    for (const boundary of [line.startTime, line.vocalEndTime]) {
        const before = C.pose(timeline, track, boundary - 0.0001, options);
        const after = C.pose(timeline, track, boundary + 0.0001, options);
        const displacement = Math.hypot(
            after.position.x - before.position.x,
            after.position.y - before.position.y,
            after.position.z - before.position.z
        );
        assert.ok(displacement < 0.01, `Camera jump at ${boundary}: ${displacement}`);
        assert.ok(Math.abs(after.fov - before.fov) < 0.01);
    }
    const signs = C.createTrack(timeline, 1, { lyricCarrier: 'sign' });
    signs.encounters.forEach((encounter, index) => {
        assert.equal(encounter.side, index % 2 ? -1 : 1);
        const f = signs.at(encounter.address);
        const lateral = (encounter.position.x - f.position.x) * f.right.x
            + (encounter.position.z - f.position.z) * f.right.z;
        assert.ok(lateral * encounter.side > 0, 'Side must match the actual world position');
    });
});

test('English phrases retain multiple words and all original glyph clocks', () => {
    const source = R.normalizeLines([{ startTime: 0, endTime: 8,
        fullText: 'Walking through the night we find our way home together' }]);
    const phrases = D.compilePhrases(source);
    assert.ok(phrases.length <= 2);
    assert.ok(phrases.every(p => p.text.trim().split(/\s+/).length >= 2));
    assert.ok(phrases.every(p => p.glyphs.length <= 64));
    assert.deepEqual(plain(phrases.flatMap(p => p.glyphs)), plain(R.buildGlyphTimeline(source[0])));
});

test('rapid opening credits share a sign without full-amplitude camera oscillation', () => {
    const source = R.normalizeLines([
        ...Array.from({ length: 8 }, (_, i) => ({
            startTime: i * 0.25, endTime: (i + 1) * 0.25, fullText: `Credit ${i}`
        })),
        { startTime: 3, endTime: 8, fullText: 'Here begins the song' }
    ]);
    const timeline = D.compile({ lines: source, duration: 20 });
    const track = C.createTrack(timeline);
    const ids = timeline.phrases.filter(p => p.start < 2).map(p => track.pageEncounter.get(p.id));
    assert.equal(new Set(ids).size, 1);
    let previous = C.pose(timeline, track, 0);
    for (let t = 1 / 120; t < 2; t += 1 / 120) {
        const current = C.pose(timeline, track, t);
        assert.ok(Math.abs(current.yaw - previous.yaw) < 0.005);
        assert.ok(Math.abs(current.pitch - previous.pitch) < 0.005);
        assert.ok(Math.abs(current.fov - previous.fov) < 0.01);
        previous = current;
    }
});

test('finale progress is monotonic, seekable and ends facing the moon', () => {
    const timeline = D.compile({ lines: R.normalizeLines([
        { startTime: 0, endTime: 10, fullText: 'The last song' }
    ]), duration: 22 });
    const track = C.createTrack(timeline);
    let progress = 0;
    for (let t = 10; t <= 22; t += 0.1) {
        const pose = C.pose(timeline, track, t);
        assert.ok(pose.finale >= progress);
        progress = pose.finale;
    }
    const final = C.pose(timeline, track, 22);
    const target = [-210, 300 - final.position.y, -420];
    const dot = (target[0] * final.direction.x + target[1] * final.direction.y
        + target[2] * final.direction.z) / Math.hypot(...target);
    assert.ok(dot > 0.99999);
    C.pose(timeline, track, 0);
    assert.deepEqual(plain(C.pose(timeline, track, 22)), plain(final));
    assert.equal(C.pose(timeline, track, 22, { reducedMotion: true }).finale, 0);
});