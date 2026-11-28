const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
window.matchMedia = () => ({ matches: false });
const stage = path.resolve(__dirname, '..', 'Musicmodules', 'music-stage');
require(path.join(stage, 'music-stage-runtime.js'));
require(path.join(stage, 'modes', 'stage-mode-utils.js'));
require(path.join(stage, 'modes', 'inkdraft-figures.js'));
require(path.join(stage, 'modes', 'inkdraft-manager.js'));
const { buildCues, findCue, glyphUnits, viewAt, blobsAt } = window.MusicStageInkdraftManager._test;
const lines = window.MusicStageRuntime.normalizeLines([
    { time: 10, original: '清晨的站台还没有人' },
    { time: 14, original: 'I will follow the light' },
    { time: 18, original: '……' },
    { time: 40, original: '长间奏之后' }
]);

test('cues tile the song without gaps: lines, interludes, a long break split up', () => {
    const cues = buildCues(lines, 120);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].kind, 'rest');
    assert.ok(cues[0].title, 'the first interlude carries the title');
    for (let i = 1; i < cues.length; i += 1) assert.ok(Math.abs(cues[i].start - cues[i - 1].end) < 1e-9, `gap before cue ${i}`);
    assert.ok(!cues.some(c => c.kind === 'line' && c.line.fullText === '……'), 'punctuation-only lines are interlude');
    assert.ok(cues.at(-1).end >= 120);
    assert.equal(cues[findCue(cues, 15)].line.fullText, 'I will follow the light');
    assert.equal(findCue(cues, 0), 0);
});

test('no lyrics: the whole song is interlude parts of about twenty seconds', () => {
    const cues = buildCues([], 200);
    assert.ok(cues.length >= 9 && cues.every(c => c.kind === 'rest'));
    assert.ok(cues.at(-1).end >= 720);
});

test('words become units; spaces separate latin words', () => {
    const cue = buildCues(lines, 120).find(c => c.kind === 'line' && c.line.fullText.startsWith('I will'));
    const units = glyphUnits(cue, '');
    assert.deepEqual(units.map(u => u.glyphs.map(g => g.text).join('')), ['I', 'will', 'follow', 'the', 'light']);
    assert.ok(units.every(u => u.end >= u.start));
});

test('the camera and the ink are pure functions of time', () => {
    const plan = { shots: [{ start: 0, end: 4, type: 'wide', drift: [0.2, -0.1], roll: 0, neg: false }], closeH: 300, close: [], macro: [], wideH: 900, wideC: [1000, 600], W: 2048, H: 1152 };
    assert.deepEqual(viewAt(plan, 1.5), viewAt(plan, 1.5));
    const cue = { cue: { start: 0 }, mass: null, accents: [], collisions: [{ t: 2, x: 500, y: 500, angle: 0.3, dist: 120, r: 20, spin: 1.7, fragments: 7 }] };
    const out = new Float32Array(96), rings = new Float32Array(8), acc = new Float32Array(12);
    const before = blobsAt(cue, 1, out, rings, acc, 0);
    assert.equal(before.blobs, 2, 'two balls approach');
    const after = blobsAt(cue, 2.4, out, rings, acc, 0);
    assert.ok(after.blobs > 7 && rings[3] > 0, 'fragments and a shock ring after the hit');
    assert.equal(blobsAt(cue, 6, out, rings, acc, 0).blobs, 0, 'gone afterwards');
});

require(path.join(stage, 'modes', 'fogpane-manager.js'));
test('fogpane: every sung line gets a place on the window, and fogs over before the third line after it', () => {
    const { planSong } = window.MusicStageFogpaneManager._test;
    const many = window.MusicStageRuntime.normalizeLines(Array.from({ length: 12 }, (_, i) => ({ time: 5 + i * 4, original: `第${i}句歌词写在车窗上` })));
    const plan = planSong(many, 960, 540, 1, (text, size) => size * text.length, 'k');
    assert.equal(plan.length, 12);
    plan.forEach((p, i) => {
        assert.ok(p.items.length > 0);
        assert.ok(p.box[0] >= 0 && p.box[2] <= 960 * 1.05 && p.box[1] >= 0 && p.box[3] <= 540, `line ${i} stays on the window`);
        assert.ok(p.fogBack >= p.end + 0.3 - 1e-9);
        if (plan[i + 3]) assert.ok(p.fogBack <= plan[i + 3].start, 'at most three lines on the glass');
    });
    assert.deepEqual(planSong(many, 960, 540, 1, (t, s) => s * t.length, 'k').map(p => p.box), plan.map(p => p.box), 'deterministic');
});

require(path.join(stage, 'modes', 'lumiere-manager.js'));
test('lumiere: cues tile the song, every four sung lines share one light rig, beams stay bounded', () => {
    const L = window.MusicStageLumiereManager._test;
    const many = window.MusicStageRuntime.normalizeLines(Array.from({ length: 10 }, (_, i) => ({ time: 5 + i * 3, original: `第${i + 1}句歌词` })));
    const cues = L.buildCues(many, 60, 'k');
    assert.equal(cues[0].start, 0);
    for (let i = 1; i < cues.length; i += 1) assert.ok(Math.abs(cues[i].start - cues[i - 1].end) < 1e-9, `gap before cue ${i}`);
    const sung = cues.filter(c => c.kind === 'line');
    assert.equal(sung.length, 10);
    assert.equal(sung[0].rig, sung[3].rig);
    assert.ok(sung[4].sectionStart && sung[4].rig !== sung[3].rig, 'a new section picks a different rig');
    assert.deepEqual(L.buildCues(many, 60, 'k').map(c => c.rig), cues.map(c => c.rig), 'deterministic');
    const colours = { warm: [1, 0.9, 0.7], cool: [0.6, 0.8, 1], accent: [1, 0.4, 0.5] };
    for (const rig of ['zenith', 'lattice', 'prism', 'stage', 'caustic', 'motes']) {
        const n = L.beamsAt(rig, 12.3, 40, colours, new Float32Array(20), new Float32Array(20));
        assert.ok(n >= 1 && n <= 5, rig);
    }
});

require(path.join(stage, 'modes', 'hanabi-manager.js'));
test('hanabi: every sung line launches a shell at its start, the show is deterministic and the active list stays bounded', () => {
    const H = window.MusicStageHanabiManager._test;
    const many = window.MusicStageRuntime.normalizeLines(Array.from({ length: 12 }, (_, i) => ({ time: 6 + i * 3, original: `第${i + 1}句歌词慢慢唱` })));
    const cues = H.buildCues(many, 90);
    const show = H.planShow(cues, 'k', 1);
    for (let i = 1; i < show.length; i += 1) assert.ok(show[i].t >= show[i - 1].t, 'sorted');
    cues.filter(c => c.kind === 'line').forEach((cue) => {
        assert.ok(show.some(b => Math.abs(b.t - cue.line.startTime) < 0.05 && b.launch > 0), `shell for line at ${cue.line.startTime}`);
    });
    assert.ok(show.some(b => b.t > 45), 'the closing interlude has a barrage');
    assert.deepEqual(H.planShow(cues, 'k', 1), show, 'deterministic');
    assert.ok(H.planShow(cues, 'k', 0.4).length < show.length, 'density thins the show');
    const out = new Int32Array(24);
    for (let t = 0; t < 90; t += 0.25) {
        const n = H.activeAt(show, t, out);
        assert.ok(n <= 24);
        for (let i = 0; i < n; i += 1) {
            const b = show[out[i]];
            assert.ok(t >= b.t - b.launch - 0.06 && t <= b.t + H.LIFE[b.kind], `burst ${out[i]} active at ${t}`);
        }
    }
});

require(path.join(stage, 'modes', 'clockwork-manager.js'));
test('clockwork: the wheel turns one step per sung line, settles with a small overshoot, and escapement ticks once a second', () => {
    const C = window.MusicStageClockworkManager._test;
    const sung = window.MusicStageRuntime.normalizeLines([{ time: 5, original: '一' }, { time: 9, original: '二' }, { time: 14, original: '三' }]);
    assert.equal(C.wheelAt(sung, 2).index, -1);
    assert.equal(C.wheelAt(sung, 9.0).turned, 0);
    assert.equal(C.wheelAt(sung, 12).turned, 1);
    const mid = C.wheelAt(sung, 9.35).turned;
    assert.ok(mid > 0.5 && mid <= 1.2, `turning ${mid}`);
    let peak = 0;
    for (let x = 0; x <= 1; x += 0.01) peak = Math.max(peak, C.settle(x));
    assert.ok(peak > 1 && peak < 1.15, 'overshoots a little');
    assert.equal(C.escapement(3.5), 4);
    assert.ok(C.escapement(3.02) > 3 && C.escapement(3.02) < 4.15);
});

require(path.join(stage, 'modes', 'orbit-manager.js'));
test('orbit: glyphs keep reading order round the ring, the sung glyph turns to the front, the back half is farther', () => {
    const O = window.MusicStageOrbitManager._test;
    const { centres } = O.arcLayout([90, 90, 40, 90, 90]);
    for (let i = 1; i < centres.length; i += 1) assert.ok(centres[i] > centres[i - 1]);
    const table = new Float32Array(O.TABLE + 1);
    const perimeter = O.ellipseTable(0.5, 0.15, table);
    assert.ok(Math.abs(O.thetaAlong(table, perimeter, 0) + Math.PI / 2) < 1e-6, 'zero is the front');
    assert.ok(Math.abs(O.thetaAlong(table, perimeter, perimeter / 2) - Math.PI / 2) < 0.02, 'half way round is the back');
    assert.ok(O.thetaAlong(table, perimeter, 0.05) > -Math.PI / 2, 'forward is to the right of the front');
    const glyphs = [{ start: 1, end: 1.4 }, { start: 1.4, end: 1.8 }, { start: 2, end: 2.5 }];
    assert.ok(O.singingPosition(glyphs, 0.8) < 0);
    assert.equal(O.singingPosition(glyphs, 1.2), 0.5);
    assert.equal(O.singingPosition(glyphs, 1.9), 2);
    assert.equal(O.singingPosition(glyphs, 9), 3);
    assert.equal(O.arcAt(centres, 2), centres[2]);
    const front = O.project(-Math.PI / 2, 0.5, 0.15, 0);
    const back = O.project(Math.PI / 2, 0.5, 0.15, 0);
    assert.ok(front.s > back.s && front.z < back.z && front.y < back.y);
});

require(path.join(stage, 'modes', 'signal-manager.js'));
test('signal: the figure-eight centreline is one closed, unbroken loop through the crossing, and the spectrum bands stay in range', () => {
    const S = window.MusicStageSignalManager._test;
    const steps = 2000;
    const ds = S.LOOP / steps;
    let crossings = 0;
    for (let i = 0; i < steps; i += 1) {
        const [x0, y0] = S.pointAt(i * ds);
        const [x1, y1] = S.pointAt((i + 1) * ds);
        assert.ok(Math.hypot(x1 - x0, y1 - y0) <= ds * 1.001, `jump at step ${i}`);
        if (Math.hypot(x0, y0) < ds / 2) crossings += 1;
    }
    assert.equal(crossings, 2, 'passes the centre twice');
    const [ex, ey] = S.pointAt(S.LOOP);
    assert.ok(Math.hypot(ex, ey) < 1e-9, 'closes on itself');
    const onRight = S.pointAt(S.HALF + S.ARC / 2);
    assert.ok(Math.abs(Math.hypot(onRight[0] - S.D, onRight[1]) - S.R) < 1e-9 && onRight[0] > S.D, 'right loop is a circle, outer side');
    const onLeft = S.pointAt(3 * S.HALF + S.ARC + S.ARC / 2);
    assert.ok(Math.abs(Math.hypot(onLeft[0] + S.D, onLeft[1]) - S.R) < 1e-9 && onLeft[0] < -S.D, 'left loop is a circle, outer side');
    const m = S.planeMatrix(0, 0, new Float32Array(9));
    const [px, py] = S.applyPlane(m, 0.7, -0.4);
    assert.ok(Math.abs(px - 0.7) < 1e-6 && Math.abs(py + 0.4) < 1e-6, 'no tilt maps the screen straight onto the ring');
    const tilted = S.planeMatrix(0, 0.3, new Float32Array(9));
    const [lx] = S.applyPlane(tilted, -1, 0), [rx] = S.applyPlane(tilted, 1, 0);
    assert.ok(Math.abs(Math.abs(lx) - Math.abs(rx)) > 0.01, 'turning about y makes one side nearer');
    const chorus = S.chorusSet([{ fullText: '再见，夏天' }, { fullText: '别的话' }, { fullText: '再见 夏天！' }]);
    assert.ok(chorus.has(S.normLine({ fullText: '再见夏天' })) && chorus.size === 1);
    let last = -1;
    for (let i = 0; i < 48; i += 1) {
        const b = S.bandIndex(i, 512);
        assert.ok(b >= last && b < 512);
        last = b;
    }
});

require(path.join(stage, 'modes', 'groupchat-manager.js'));
test('groupchat: a deterministic thread with typing lead, voice notes in long breaks, and choruses sung by several', () => {
    const G = window.MusicStageGroupchatManager._test;
    const song = window.MusicStageRuntime.normalizeLines([
        { time: 5, original: '我们走到海边' },
        { time: 9, original: '再见夏天' },
        { time: 13, original: '风把信吹远' },
        { time: 30, original: '再见夏天' },
        { time: 34, original: '最后一句' }
    ]);
    const a = G.buildThread(song, '夏', 60);
    const b = G.buildThread(song, '夏', 60);
    assert.deepEqual(a.map(m => [m.kind, m.start, m.sender?.name]), b.map(m => [m.kind, m.start, m.sender?.name]));
    assert.equal(a[0].kind, 'system');
    for (let i = 1; i < a.length; i += 1) assert.ok(a[i].start >= a[i - 1].start);
    const lines = a.filter(m => m.kind === 'line');
    assert.equal(lines.length, 5);
    assert.ok(lines.filter(m => m.chorus).length === 2 && lines.filter(m => m.chorus).every(m => m.echoes.length >= 2 && !m.echoes.includes(m.sender)));
    const voice = a.find(m => m.kind === 'voice' && m.start > 13);
    assert.ok(voice && voice.start > 13 && voice.end < 30 - G.TYPING_LEAD, 'the long break holds a voice note');
    const before = lines[1].start - 0.5;
    assert.equal(G.typingAt(a, before), lines[1], 'someone is typing just before the line');
    assert.equal(G.typingAt(a, lines[1].start - 3), null);
    assert.equal(a[G.messageIndexAt(a, lines[2].start + 0.1)], lines[2]);
    assert.equal(G.messageIndexAt(a, -1), -1);
});

test('groupchat: a long interlude gets a sticker after the voice note; no lyrics is one long voice note', () => {
    const G = window.MusicStageGroupchatManager._test;
    const song = window.MusicStageRuntime.normalizeLines([
        { time: 5, original: '我们走到海边' }, { time: 9, original: '再见夏天' }, { time: 40, original: '最后一句' }
    ]);
    const thread = G.buildThread(song, '夏', 60);
    const voice = thread.find(m => m.kind === 'voice' && m.start > 9);
    const sticker = thread.find(m => m.kind === 'sticker');
    assert.ok(voice && sticker && sticker.start > voice.start && sticker.start < voice.end && sticker.sender !== voice.sender);
    assert.equal(G.typingAt(thread, sticker.start + 0.1), null, 'nobody types during the interlude');
    const silent = G.buildThread([], '夏', 120);
    const whole = silent.find(m => m.kind === 'voice');
    assert.ok(whole && whole.whole && whole.start < 2 && whole.end > 115);
});

test('plain lyrics without timing are spread over the song by length, marked as estimated', () => {
    const U = window.MusicStageModeUtils;
    const R = window.MusicStageRuntime;
    const plain = Object.freeze(['清晨的站台还没有人', '短句', '我把车票折成纸船放进口袋慢慢地等']);
    const base = { lines: [], plainLines: plain, duration: 200, playbackTime: 100, isPlaying: true };
    const f = U.withPlainLyrics(base);
    assert.ok(f.lyricsEstimated && f.lines.length === 3);
    assert.ok(f.lines[0].startTime >= 8 && f.lines[2].endTime <= 200);
    for (let i = 1; i < 3; i += 1) assert.ok(f.lines[i].startTime > f.lines[i - 1].startTime);
    assert.ok(f.lines[2].startTime - f.lines[1].startTime < f.lines[1].startTime - f.lines[0].startTime, 'a short line gets a shorter slot');
    assert.ok(f.activeLine && f.currentLineIndex >= 0);
    assert.equal(U.withPlainLyrics({ ...base, playbackTime: 101 }).lines, f.lines, 'the spread lines are cached');
    assert.match(U.lineCounter(f), /未对时/);
    const timed = { ...base, lines: R.normalizeLines([{ time: 1, original: 'x' }]) };
    assert.equal(U.withPlainLyrics(timed), timed, 'timed lyrics win');
    assert.equal(U.withPlainLyrics({ ...base, plainLines: [] }).lyricsEstimated, undefined);
});

require(path.join(stage, 'modes', 'impression-manager.js'));
test('impression: sections turn at long breaks and chorus entries, and never closer than eight seconds', () => {
    const I = window.MusicStageImpressionManager._test;
    const song = window.MusicStageRuntime.normalizeLines([
        { time: 10, original: '第一段第一句' }, { time: 14, original: '第一段第二句' },
        { time: 18, original: '副歌来了' }, { time: 22, original: '副歌第二句' },
        { time: 40, original: '第二段开头' }, { time: 44, original: '副歌来了' }, { time: 46, original: '副歌第二句' }
    ]);
    const { starts, isChorus } = I.buildSections(song);
    assert.deepEqual(starts, [10, 18, 40, 48].filter(x => x !== 48));
    assert.ok(isChorus(song[2]) && !isChorus(song[0]));
    assert.equal(I.sectionAt(starts, 5), 0);
    assert.equal(I.sectionAt(starts, 19), 1);
    assert.equal(I.sectionAt(starts, 41), 2);
    assert.equal(I.PHASES.length, 4);
    assert.equal(I.fileUrl('C:\\a b\\c#.jpg'), 'file:///C:/a%20b/c%23.jpg');
});

test('createStillGate invalidates cached frame when MusicMotion.reduced() flips while paused', () => {
    const U = window.MusicStageModeUtils;
    let isReduced = false;
    const prevMotion = window.MusicMotion;
    window.MusicMotion = { reduced: () => isReduced };
    try {
        const gate = U.createStillGate({ matches: false });
        const frame = {
            isPlaying: false,
            trackKey: 'k',
            theme: 'dark',
            currentLineIndex: 0,
            playbackTime: 10.0,
            lyricCount: 2,
            activeLine: { fullText: 'hello' }
        };
        assert.equal(gate.same(frame, 800, 600, 's'), false);
        assert.equal(gate.same(frame, 800, 600, 's'), true);
        isReduced = true;
        assert.equal(gate.same(frame, 800, 600, 's'), false, 'reduced motion toggle must force a redraw while paused');
        assert.equal(gate.same(frame, 800, 600, 's'), true);
    } finally {
        if (prevMotion === undefined) delete window.MusicMotion;
        else window.MusicMotion = prevMotion;
    }
});

test('MusicStageRuntime parallel shader compiler avoids sync blocking and cleans up on cancel', () => {
    const R = window.MusicStageRuntime;
    const KHR = 0x91B1;
    let complete = false;
    let syncLinkChecks = 0;
    let deletedShaders = 0;
    let createdShaders = 0;
    const rafQueue = [];
    const prevRaf = window.requestAnimationFrame;
    const prevCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
    window.cancelAnimationFrame = () => {};

    const makeMockGl = (withKhr) => ({
        VERTEX_SHADER: 0x8B31,
        FRAGMENT_SHADER: 0x8B30,
        COMPILE_STATUS: 0x8B81,
        LINK_STATUS: 0x8B82,
        ACTIVE_UNIFORMS: 0x8B86,
        isContextLost: () => false,
        getExtension: (name) => (withKhr && name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: KHR } : null),
        createShader: (type) => ({ id: ++createdShaders, type }),
        shaderSource: () => {},
        compileShader: () => {},
        createProgram: () => ({ id: Math.random() }),
        attachShader: () => {},
        linkProgram: () => {},
        deleteShader: () => { deletedShaders += 1; },
        deleteProgram: () => {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        getProgramInfoLog: () => '',
        getProgramParameter: (_p, pname) => {
            if (pname === KHR) return complete;
            if (pname === 0x8B82) { syncLinkChecks += 1; return true; }
            if (pname === 0x8B86) return 1;
            return 0;
        },
        getActiveUniform: () => ({ name: 'uTime[0]' }),
        getUniformLocation: (_p, name) => `loc:${name}`
    });

    try {
        // 1. With KHR_parallel_shader_compile: compileProgram returns immediately without blocking LINK_STATUS
        const gl = makeMockGl(true);
        const entry = R.compileProgram(gl, 'vs', 'fs', 'test');
        assert.equal(syncLinkChecks, 0, 'compileProgram must not query LINK_STATUS synchronously when KHR is present');
        assert.equal(deletedShaders, 0);

        let readyCalls = 0;
        assert.equal(R.programsReady(gl, () => { readyCalls += 1; }), false);
        assert.equal(syncLinkChecks, 0, 'programsReady must not block while COMPLETION_STATUS_KHR is false');
        assert.equal(rafQueue.length, 1, 'schedules non-blocking poll');

        complete = true;
        rafQueue.shift()();
        assert.equal(readyCalls, 1, 'invokes onReady once shaders finish compiling');
        assert.equal(entry.uniforms.uTime, 'loc:uTime[0]', 'populates uniforms in-place on the returned entry');
        assert.equal(deletedShaders, createdShaders, 'deletes vertex and fragment shaders after linking');
        assert.equal(R.programsReady(gl), true, 'subsequent checks return true immediately');

        // 2. cancelPrograms cleans up pending shaders if destroyed mid-compile
        complete = false;
        const gl2 = makeMockGl(true);
        R.compileProgram(gl2, 'vs', 'fs', 'cancel-test');
        const beforeCancelDel = deletedShaders;
        R.cancelPrograms(gl2);
        assert.equal(deletedShaders, beforeCancelDel + 2, 'cancelPrograms deletes un-finalized shaders');

        // 3. Without KHR_parallel_shader_compile: synchronous fallback still populates uniforms
        const glSync = makeMockGl(false);
        const syncEntry = R.compileProgram(glSync, 'vs', 'fs', 'sync-test');
        assert.equal(syncEntry.uniforms.uTime, 'loc:uTime[0]');
        assert.equal(R.programsReady(glSync), true);
    } finally {
        if (prevRaf === undefined) delete window.requestAnimationFrame; else window.requestAnimationFrame = prevRaf;
        if (prevCancelRaf === undefined) delete window.cancelAnimationFrame; else window.cancelAnimationFrame = prevCancelRaf;
    }
});

test('MusicStageModeUtils.noiseTexture avoids per-frame gl.isTexture IPC and rebuilds after context loss', () => {
    const U = window.MusicStageModeUtils;
    let isTextureCalls = 0;
    let createCalls = 0;
    let lost = false;
    const listeners = {};
    const gl = {
        TEXTURE_2D: 0x0DE1, UNPACK_ALIGNMENT: 0x0CF5, R16F: 0x822D, RED: 0x1903, FLOAT: 0x1406,
        TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, LINEAR: 0x2601,
        TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, REPEAT: 0x2901,
        canvas: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
        isContextLost: () => lost,
        isTexture: () => { isTextureCalls += 1; return true; },
        createTexture: () => ({ id: ++createCalls }),
        bindTexture: () => {},
        pixelStorei: () => {},
        texImage2D: () => {},
        texParameteri: () => {}
    };
    const t1 = U.noiseTexture(gl);
    const t2 = U.noiseTexture(gl);
    assert.strictEqual(t1, t2, 'reuses cached noise texture');
    assert.equal(isTextureCalls, 0, 'never calls synchronous gl.isTexture IPC');
    assert.equal(createCalls, 1);

    // Context lost invalidates cached texture; restored context creates a fresh texture
    lost = true;
    listeners.webglcontextlost?.();
    lost = false;
    const t3 = U.noiseTexture(gl);
    assert.notStrictEqual(t3, t1, 'rebuilds noise texture after webglcontextlost');
    assert.equal(createCalls, 2);
});

test('MusicStageRuntime.warmPrograms compiles in parallel, deduplicates per context, and cleans up on abort', async () => {
    const R = window.MusicStageRuntime;
    const KHR = 0x91B1;
    let complete = false;
    let linked = 0, deletedShaders = 0, deletedPrograms = 0, linkStatusReads = 0;
    const rafQueue = [];
    const prevRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
    const makeGl = (withKhr) => ({
        VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30, LINK_STATUS: 0x8B82,
        isContextLost: () => false,
        getExtension: (n) => (withKhr && n === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: KHR } : null),
        createShader: () => ({}),
        shaderSource: () => {},
        compileShader: () => {},
        createProgram: () => ({}),
        attachShader: () => {},
        linkProgram: () => { linked += 1; },
        deleteShader: () => { deletedShaders += 1; },
        deleteProgram: () => { deletedPrograms += 1; },
        getProgramParameter: (_p, pname) => {
            if (pname === KHR) return complete;
            if (pname === 0x8B82) { linkStatusReads += 1; return true; }
            return 0;
        }
    });
    try {
        const specA = { vertex: 'va', fragment: 'fa' };
        const specB = { vertex: 'vb', fragment: 'fb' };

        // 1. Without KHR extension: returns false immediately with zero GL calls
        assert.equal(await R.warmPrograms(makeGl(false), [specA]), false);
        assert.equal(linked, 0);

        // 2. With KHR: links all programs in parallel, polls non-blocking, commits LINK_STATUS and cleans up
        const gl = makeGl(true);
        const p1 = R.warmPrograms(gl, [specA, specB]);
        assert.equal(linked, 2, 'kicks off both programs in parallel');
        assert.equal(linkStatusReads, 0, 'does not block on LINK_STATUS while pending');
        assert.equal(rafQueue.length, 1);

        complete = true;
        rafQueue.shift()();
        assert.equal(await p1, true);
        assert.equal(linkStatusReads, 2);
        assert.equal(deletedShaders, 4);
        assert.equal(deletedPrograms, 2);

        // 3. Per-context dedup skips already-warmed specs
        assert.equal(await R.warmPrograms(gl, [specA, specB]), true);
        assert.equal(linked, 2, 'reused context skips duplicate pre-warm');

        // 4. Abort via isAlive() cleans up temp shaders and programs without blocking
        complete = false;
        let alive = true;
        const gl2 = makeGl(true);
        const p2 = R.warmPrograms(gl2, [specA], () => alive);
        alive = false;
        rafQueue.shift()();
        assert.equal(await p2, false);
        assert.equal(deletedShaders, 6);
        assert.equal(deletedPrograms, 3);
    } finally {
        if (prevRaf === undefined) delete window.requestAnimationFrame; else window.requestAnimationFrame = prevRaf;
    }
});
