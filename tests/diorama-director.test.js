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
test('long CJK lines split into balanced signs without stray tails', () => {
    const phrasesOf = text => D.compile({
        lines: R.normalizeLines([{ startTime: 2, endTime: 8, fullText: text }]), trackId: 'split', duration: 20
    }).phrases.map(phrase => phrase.text);
    // 13 characters used to become 12 + 1.
    assert.deepEqual(plain(phrasesOf('一二三四五六七八九十甲乙丙')), ['一二三四五六七八九十甲乙丙']);
    // 15 characters used to become 12 + 3.
    const halves = phrasesOf('一二三四五六七八九十甲乙丙丁戊');
    assert.deepEqual(plain(halves), ['一二三四五六七八', '九十甲乙丙丁戊']);
});

test('the outro keeps a slow glide instead of a frozen frame', () => {
    const timeline = D.compile({ lines, trackId: 'test', duration: 220 });
    assert.equal(timeline.acts.at(-1).kind, 'Terminus');
    assert.ok(timeline.distanceAt(215) - timeline.distanceAt(200) > 2);
});

test('break scenes are planned in long silences only, and the camera moves into them without a jump', () => {
    // A long introduction, two verses, a long break, a last verse.
    const starts = [16, 21, 26, 31, 36, 41, 80, 85, 90];
    const song = R.normalizeLines(starts.map((start, i) => ({
        startTime: start, endTime: start + 3.5, fullText: `第${i}句 车窗外的海`
    })));
    const timeline = D.compile({ lines: song, trackId: 'scenes', duration: 120 });
    const track = C.createTrack(timeline, 1, { aspect: 1.78 });
    assert.ok(track.scenes.length >= 2, 'the introduction and the break each get a scene');
    assert.equal(track.scenes[0].kind, 'SALOON');
    assert.equal(track.scenes[0].start, 0);
    assert.ok(track.scenes.some(scene => scene.kind === 'TRACKSIDE'));
    for (const scene of track.scenes) {
        assert.ok(scene.end - scene.start >= 7.5 && scene.end - scene.start <= 14.5);
        // Nobody sings during a scene, and the next line is at least five seconds off.
        for (const busy of timeline.protectedIntervals)
            assert.ok(busy.end <= scene.start || busy.start >= scene.end + 5 - 1e-6);
    }
    assert.deepEqual(plain(C.createTrack(timeline, 1, { aspect: 1.78, cameraCuts: false }).scenes), []);
    // Inside the saloon the camera stands in the leading car, clear of its walls.
    const saloon = track.scenes[0], middle = (saloon.start + saloon.end) / 2;
    const inside = C.pose(timeline, track, middle, { aspect: 1.78 });
    assert.equal(inside.rig, 'SALOON');
    assert.ok(inside.saloon > 0.99);
    // The lens is told when the picture is the lit saloon, and only then.
    assert.ok(inside.cabinView > 0.99);
    // The opening saloon is already thinning out, and keeps the low sun.
    assert.ok(inside.cabinEmpty >= 0.6 && inside.cabinEmpty <= 1);
    assert.ok(inside.cabinSunset > 0.5);
    const outside = track.scenes.find(scene => scene.kind === 'TRACKSIDE');
    assert.equal(C.pose(timeline, track, (outside.start + outside.end) / 2, { aspect: 1.78 }).cabinView, 0);
    const back = inside.trainFront - inside.distance;
    assert.ok(Math.abs(back + 0.4) < 1e-9, 'the train stays where the cab view left it');
    const car = track.at(inside.distance - 8);
    const lateral = (inside.position.x - car.position.x) * car.right.x + (inside.position.z - car.position.z) * car.right.z;
    assert.ok(Math.abs(lateral) < 0.6 && inside.position.y > 2.3 && inside.position.y < 3.1);
    // Beside the line the train is only let past once the camera is clear of it.
    const beside = track.scenes.find(scene => scene.kind === 'TRACKSIDE');
    let previous = null;
    for (let t = 0; t <= 120; t += 1 / 60) {
        const pose = C.pose(timeline, track, t, { aspect: 1.78 });
        const f = track.at(pose.distance);
        const offset = (pose.position.x - f.position.x) * f.right.x + (pose.position.z - f.position.z) * f.right.z;
        const lead = pose.trainFront - pose.distance;
        if (t > beside.start - 3 && t < beside.end + 3 && lead > 0.5 && lead < 53)
            assert.ok(Math.abs(offset) > 2, `the train would run through the camera at ${t.toFixed(2)}`);
        if (previous) {
            const step = Math.hypot(pose.position.x - previous.position.x, pose.position.y - previous.position.y,
                pose.position.z - previous.position.z);
            assert.ok(step < 0.25, `camera jumps ${step.toFixed(2)} m at ${t.toFixed(2)}`);
            // Neither the train nor the camera ever goes back down the line.
            assert.ok(pose.trainFront >= previous.trainFront - 1e-9, `the train runs backwards at ${t.toFixed(2)}`);
            assert.ok(pose.distance >= previous.distance - 0.02, `the camera flies backwards at ${t.toFixed(2)}`);
            const turn = Math.abs(Math.atan2(Math.sin(pose.yaw - previous.yaw), Math.cos(pose.yaw - previous.yaw)));
            assert.ok(turn < 0.03, `camera whips ${turn.toFixed(3)} rad at ${t.toFixed(2)}`);
        }
        previous = pose;
    }
});

test('each chorus is seen from somewhere else, and the train never runs through the camera', () => {
    // Three choruses of four lines, verses between them.
    const chorus = i => i >= 6 && i < 10 || i >= 16 && i < 20 || i >= 26 && i < 30;
    const song = R.normalizeLines(Array.from({ length: 32 }, (_, i) => ({
        startTime: 6 + i * 5, endTime: 6 + i * 5 + 4, fullText: `第${i}句 沿着海岸线`, isChorus: chorus(i)
    })));
    const timeline = D.compile({ lines: song, trackId: 'three-choruses', duration: 175 });
    const track = C.createTrack(timeline, 1, { aspect: 1.78 });
    const choruses = timeline.acts.filter(act => act.kind === 'Chorus');
    assert.equal(choruses.length, 3);
    // Held a little before the end: before a short act the way back starts early.
    const held = choruses.map(act => C.pose(timeline, track, act.end - 4, { aspect: 1.78 }));
    assert.deepEqual(plain(held.map(pose => pose.chaseRig)), ['QUARTER', 'BOW', 'ALONGSIDE']);
    const beside = pose => {
        const f = track.at(pose.distance);
        return (pose.position.x - f.position.x) * f.right.x + (pose.position.z - f.position.z) * f.right.z;
    };
    // High and to one side; out over the water ahead of the train, turned
    // to face it; low over the water alongside.
    assert.ok(beside(held[0]) > 6 && held[0].position.y > 6);
    assert.ok(beside(held[1]) < -4.5 && held[1].position.y < 3);
    // Half way through its chorus the bow rig is turned to face the train coming up behind it.
    const facing = C.pose(timeline, track, (choruses[1].start + choruses[1].end) / 2, { aspect: 1.78 });
    const heading = track.at(facing.distance).yaw;
    assert.ok(facing.direction.x * Math.sin(heading) - facing.direction.z * Math.cos(heading) < -0.8,
        'the bow rig looks back at the train');
    assert.ok(facing.trainFront < facing.distance - 8, 'the train is behind the bow rig');
    assert.ok(beside(held[2]) < -6 && held[2].position.y < 3);
    assert.ok(held[2].trainFront > held[2].distance + 30);
    // Beside the train the line on the sky is written above the gaze, clear of the windows.
    assert.ok(held[1].sky.y > held[1].direction.y + 0.1);
    // Even behind the train it sits a little above the gaze, over the far shore.
    assert.ok(held[0].sky.y > held[0].direction.y + 0.05 && held[0].sky.y < held[1].sky.y);
    let previous = null;
    for (let t = 0; t <= 175; t += 1 / 60) {
        const pose = C.pose(timeline, track, t, { aspect: 1.78 });
        const lead = pose.trainFront - pose.distance;
        // The train reaches from its nose 53 m back. Where that covers the
        // camera, the camera is out to one side of it or up over its roof,
        // and riding on the roof only clear of the pantograph 2.9 m back.
        const onRoof = pose.ride && pose.position.y > 4.4 && (lead > 4 || lead < 1.8);
        if (pose.chase > 0.01 && lead > 0.5 && lead < 53)
            assert.ok(Math.abs(beside(pose)) > 2 || pose.position.y > 5.2 || onRoof,
                `the train would run through the camera at ${t.toFixed(2)}`);
        if (previous) {
            const step = Math.hypot(pose.position.x - previous.position.x, pose.position.y - previous.position.y,
                pose.position.z - previous.position.z);
            assert.ok(step < 0.25, `camera jumps ${step.toFixed(2)} m at ${t.toFixed(2)}`);
            // Neither the train nor the camera ever goes back down the line.
            assert.ok(pose.trainFront >= previous.trainFront - 1e-9, `the train runs backwards at ${t.toFixed(2)}`);
            assert.ok(pose.distance >= previous.distance - 0.02, `the camera flies backwards at ${t.toFixed(2)}`);
            const turn = Math.abs(Math.atan2(Math.sin(pose.yaw - previous.yaw), Math.cos(pose.yaw - previous.yaw)));
            assert.ok(turn < 0.03, `camera whips ${turn.toFixed(3)} rad at ${t.toFixed(2)}`);
        }
        previous = pose;
    }
});

test('lyrics that stop long before the music do not end the journey early', () => {
    // A short version's words on a full-length track: sung for 90 s of 204.
    // Its file opens with the lyricist and the composer, which nobody sings.
    const song = R.normalizeLines([
        { startTime: 0, endTime: 1, fullText: '作词 : 某人' }, { startTime: 1, endTime: 7, fullText: '作曲 : 某人' },
        ...Array.from({ length: 18 }, (_, i) => ({
            startTime: 13 + i * 5, endTime: 13 + i * 5 + 4, fullText: `第${i}句 地图上没有的路口` }))]);
    const timeline = D.compile({ lines: song, trackId: 'short-words', duration: 204 });
    const terminus = timeline.acts.at(-1);
    assert.equal(terminus.kind, 'Terminus');
    assert.ok(terminus.start >= 204 - 40, `the arrival starts at ${terminus.start}`);
    const after = timeline.acts.filter(act => act.start >= 101 && act.kind !== 'Terminus');
    assert.ok(after.some(act => act.kind === 'Interlude') && after.some(act => act.kind === 'Open'));
    // So the camera is not turned up to the moon for the rest of the song.
    const track = C.createTrack(timeline, 1, { aspect: 1.78 });
    assert.equal(C.pose(timeline, track, 140, { aspect: 1.78 }).finale, 0);
    // The song still opens in the car, and goes back into it after the words run out.
    assert.equal(timeline.acts[0].kind, 'Departure');
    assert.equal(track.scenes[0].kind, 'SALOON');
    assert.equal(track.scenes[0].start, 0);
    assert.ok(track.scenes.some(scene => scene.start > 101 && scene.kind === 'SALOON'));
});

test('the ride drifts into a dream from the second chorus, or once the words run out', () => {
    const a = D.compile({ lines, trackId: 'test', duration: 160 });
    const second = a.acts.find(act => act.kind === 'Chorus' && act.visit === 2);
    assert.equal(a.sample(0).dream, 0);
    assert.equal(a.sample(160 * 0.3).dream, 0);
    assert.ok(Math.abs(a.dreamStart - Math.max(160 * 0.35, Math.min(second.start, 160 * 0.6))) < 1e-9);
    assert.equal(a.sample(160).dream, 1);
    let previous = 0;
    for (let t = 0; t <= 160; t += 0.25) {
        const dream = a.sample(t).dream;
        assert.ok(dream >= previous && dream - previous < 0.02, `dream jumps at ${t}`);
        previous = dream;
    }
    // A short version's words on the full track: the dream begins when they stop.
    const short = D.compile({ lines: R.normalizeLines(Array.from({ length: 18 }, (_, i) => ({
        startTime: 13 + i * 5, endTime: 13 + i * 5 + 4, fullText: `第${i}句 地图上没有的路口` }))), trackId: 'short', duration: 204 });
    assert.ok(Math.abs(short.dreamStart - 102) < 0.5, `dream starts at ${short.dreamStart}`);
    assert.ok(short.sample(150).dream > 0.99);
});

test('the ride sets out at dusk and the afterglow is gone by the first chorus', () => {
    const a = D.compile({ lines, trackId: 'test', duration: 160 });
    const first = a.acts.find(act => act.kind === 'Chorus');
    assert.equal(a.sample(0).dusk, 1);
    assert.equal(a.sample(Math.min(first.start, 160 * 0.4) + 0.01).dusk, 0);
    for (let t = 0.25; t <= 60; t += 0.25) assert.ok(a.sample(t).dusk <= a.sample(t - 0.25).dusk);
});
