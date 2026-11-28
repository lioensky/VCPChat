const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { parseLRC } = require('../modules/lyrics/parserCore');

const workspace = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(workspace, relativePath), 'utf8');

const createStageDom = () => new JSDOM(`<!doctype html>
<html>
<body>
    <div id="custom-title-bar">
        <button id="stage-toggle-btn"></button>
        <button id="sidebar-toggle-btn"></button>
    </div>
    <main id="music-stage" tabindex="-1" hidden>
        <div class="music-stage-backdrop-current"></div>
        <div class="music-stage-backdrop-next"></div>
        <div class="music-stage-shade"></div>
        <div class="music-stage-edge-spectrum">
            <canvas class="music-stage-edge-spectrum-canvas"></canvas>
        </div>
        <div class="music-stage-mode-root"></div>
        <nav class="music-stage-mode-switcher"></nav>
        <div class="music-stage-cover"></div>
        <div class="music-stage-track-title"></div>
        <div class="music-stage-track-artist"></div>
        <div class="music-stage-track-album"></div>
        <div class="music-stage-current-time"></div>
        <div class="music-stage-duration"></div>
        <div class="music-stage-progress-track">
            <div class="music-stage-progress-glow"></div>
            <div class="music-stage-progress-fill"></div>
        </div>
        <button data-stage-action="play-mode"></button>
        <button data-stage-action="previous"></button>
        <button data-stage-action="toggle-play"></button>
        <button data-stage-action="next"></button>
        <div class="music-stage-volume">
            <button data-stage-action="toggle-mute"></button>
            <input class="music-stage-volume-slider" type="range" min="0" max="1" step="0.01" value="1">
        </div>
        <div class="music-stage-chrome"></div>
        <div class="music-stage-empty-notice"></div>
    </main>
</body>
</html>`, {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});

const installCanvasStub = (window) => {
    const gradient = { addColorStop() {} };
    const context = {
        font: '',
        clearRect() {},
        setTransform() {},
        createRadialGradient() { return gradient; },
        fillRect() {},
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        arc() {},
        rect() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        closePath() {},
        fill() {},
        stroke() {},
        measureText(text) { return { width: String(text).length * 20 }; },
        set fillStyle(value) {},
        set strokeStyle(value) {},
        set lineWidth(value) {},
        set shadowColor(value) {},
        set shadowBlur(value) {}
    };
    window.HTMLCanvasElement.prototype.getContext = () => context;
};

const runScript = (dom, relativePath) => {
    vm.runInContext(read(relativePath), dom.getInternalVMContext(), {
        filename: relativePath
    });
};

const wait = (window, delay) => new Promise((resolve) => window.setTimeout(resolve, delay));

const createApp = () => {
    const calls = {
        play: 0,
        pause: 0,
        previous: 0,
        next: 0,
        sidebarScrolls: 0,
        volumes: []
    };

    const app = {
        playlist: [{
            path: 'C:\\Music\\demo.flac',
            title: '舞台测试.flac',
            artist: 'VCP',
            album: 'Folia Adaptation',
            albumArt: '',
            duration: 120
        }],
        currentTrackIndex: 0,
        currentLyrics: [{
            time: 0,
            endTime: 6,
            original: '流光照亮云阶',
            translation: 'Light illuminates the steps',
            words: [
                { text: '流光', startTime: 0, endTime: 2 },
                { text: '照亮', startTime: 2, endTime: 4 },
                { text: '云阶', startTime: 4, endTime: 6 }
            ]
        }],
        currentLyricIndex: -1,
        lastKnownCurrentTime: 2.5,
        lastKnownDuration: 120,
        lastStateUpdateTime: Date.now(),
        currentVisualizerData: Array.from({ length: 64 }, (_, index) => index / 64),
        isPlaying: true,
        currentTheme: 'dark',
        visualizerColor: { r: 242, g: 169, b: 0 },
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: 0,
        volumeSlider: { value: '0.8' },
        isStageActive: false,
        stripAudioExtension: (value) => String(value).replace(/\.[^.]+$/, ''),
        formatTime: (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`,
        updateVolumeSliderBackground() {},
        updateModeButton() {},
        saveSettings() {},
        scrollCurrentTrackToSidebarTop() { calls.sidebarScrolls += 1; },
        playTrack() { calls.play += 1; },
        pauseTrack() { calls.pause += 1; },
        prevTrack() { calls.previous += 1; },
        nextTrack() { calls.next += 1; },
        api: {
            setMusicVolume(value) { calls.volumes.push(value); },
            seekMusic() {}
        }
    };

    return { app, calls };
};

test('music stage runtime resolves lyric and audio snapshots', () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');

    const { app } = createApp();
    const frame = dom.window.MusicStageRuntime.createFrame(app, 100);

    assert.equal(frame.currentLineIndex, 0);
    assert.equal(frame.activeLine.fullText, '流光照亮云阶');
    assert.equal(frame.activeWordIndex, 1);
    assert.equal(frame.wordStates[0].status, 'passed');
    assert.equal(frame.wordStates[1].status, 'active');
    assert.ok(frame.audio.power > 0);
    assert.equal(frame.audio.spectrum.length, 64);
});

test('music stage caches normalized lyrics and fallback word timelines by source array', () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');

    const { app } = createApp();
    app.currentLyrics = [{
        time: 0,
        endTime: 4,
        original: '缓存歌词'
    }];
    app.lastKnownCurrentTime = 1;

    const firstFrame = dom.window.MusicStageRuntime.createFrame(app, 100);
    const secondFrame = dom.window.MusicStageRuntime.createFrame(app, 116);

    assert.strictEqual(secondFrame.lines, firstFrame.lines);
    assert.strictEqual(secondFrame.activeLine, firstFrame.activeLine);
    assert.strictEqual(secondFrame.words, firstFrame.words);
    assert.equal(firstFrame.words.map((word) => word.text).join(''), '缓存歌词');

    app.currentLyrics = [{
        time: 0,
        endTime: 4,
        original: '新歌词'
    }];
    const replacedFrame = dom.window.MusicStageRuntime.createFrame(app, 132);

    assert.notStrictEqual(replacedFrame.lines, firstFrame.lines);
    assert.notStrictEqual(replacedFrame.words, firstFrame.words);
    assert.equal(replacedFrame.words.map((word) => word.text).join(''), '新歌词');
    dom.window.close();
});

test('music stage normalizes advanced JSON syllables, numeric strings and dual subtitles', () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');

    const app = createApp().app;
    app.isPlaying = false;
    app.lastKnownCurrentTime = 1.25;
    app.currentLyrics = [{
        startTime: '1',
        endTime: '3',
        fullText: 'Hello',
        translation: '你好',
        romanization: 'Nǐ hǎo',
        chorus: true,
        words: [{
            text: 'Hello',
            startTime: '1',
            endTime: '3',
            syllables: [
                { text: 'Hel', startTime: '1', endTime: '1.6' },
                { text: 'lo', startTime: '1.6', endTime: '3.2' }
            ]
        }]
    }];

    const frame = dom.window.MusicStageRuntime.createFrame(app, 100);
    const glyphs = dom.window.MusicStageRuntime.buildGlyphTimeline(frame.activeLine);

    assert.equal(frame.activeLine.startTime, 1);
    assert.equal(frame.activeLine.isChorus, true);
    assert.equal(frame.activeLine.vocalEndTime, 3.2);
    assert.equal(glyphs.map(glyph => glyph.text).join(''), 'Hello');
    assert.equal(glyphs[0].syllableIndex, 0);
    assert.equal(glyphs.at(-1).syllableIndex, 1);
    assert.equal(
        dom.window.MusicStageRuntime.resolveSupplementalText(frame.activeLine),
        'Nǐ hǎo\n你好'
    );
    dom.window.close();
});

test('plain LRC keeps fallback timing and untouched display spaces', () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');

    const parsed = parseLRC('[00:01.00]Hello world\n[00:05.00]下一句');
    const app = createApp().app;
    app.isPlaying = false;
    app.lastKnownCurrentTime = 2;
    app.currentLyrics = parsed.lines.map(line => ({
        ...line,
        time: line.startTime,
        original: line.fullText,
        isWordByWord: parsed.isWordByWord
    }));

    const frame = dom.window.MusicStageRuntime.createFrame(app, 100);
    const glyphs = dom.window.MusicStageRuntime.buildGlyphTimeline(frame.activeLine);

    assert.equal(parsed.isWordByWord, false);
    assert.equal(frame.activeLine.fullText, 'Hello world');
    assert.equal(glyphs.map(glyph => glyph.text).join(''), 'Hello world');
    assert.equal(glyphs.some(glyph => glyph.text === ' '), true);
    assert.equal(frame.wordStates.length, 2);
    dom.window.close();
});

test('music UI positions the current visible track at one quarter of the sidebar without changing filtered context', () => {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
        runScripts: 'outside-only'
    });
    runScript(dom, 'Musicmodules/music-ui.js');

    const playlistEl = dom.window.document.getElementById('playlist');
    const playlist = [
        { title: '第一首.flac' },
        { title: '当前歌曲.flac' },
        { title: '第三首.flac' }
    ];
    const app = {
        playlist,
        playlistEl,
        currentTrackIndex: 1,
        stripAudioExtension: (value) => String(value).replace(/\.[^.]+$/, ''),
        updateAllCount() {}
    };
    dom.window.setupUI(app);
    app.renderPlaylist([playlist[2], playlist[1]]);

    Object.defineProperty(playlistEl, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(playlistEl, 'scrollHeight', { configurable: true, value: 500 });
    playlistEl.scrollTop = 35;
    playlistEl.getBoundingClientRect = () => ({ top: 100, height: 200 });
    const activeItem = playlistEl.querySelector('[data-index="1"]');
    activeItem.getBoundingClientRect = () => ({ top: 220 });

    assert.equal(app.scrollCurrentTrackToSidebarTop(), true);
    assert.equal(playlistEl.scrollTop, 105);
    assert.equal(playlistEl.firstElementChild.dataset.index, '2');

    app.renderPlaylist([playlist[2]]);
    playlistEl.scrollTop = 48;
    assert.equal(app.scrollCurrentTrackToSidebarTop(), false);
    assert.equal(playlistEl.scrollTop, 48);
    dom.window.close();
});

test('music player repositions the sidebar after normal and gapless track changes', () => {
    const source = read('Musicmodules/music-player.js');
    const renderThenPosition = /app\.renderPlaylist\(app\.currentFilteredTracks\);\s*app\.scrollCurrentTrackToSidebarTop\?\.\(\);/g;
    assert.equal(
        Array.from(source.matchAll(renderThenPosition)).length,
        1,
        'normal load and the gapless switch share one showTrack, which repositions the current track'
    );
});

test('music stage keeps one mode instance and releases canvases across switches', async () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-config.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-mode-utils.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-lyric-layout.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-lyric-performance.js');
    runScript(dom, 'Musicmodules/music-stage/modes/luminous-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/partita-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/cadenza-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/tempera-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/sonnet-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/diorama-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/fume-manager.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-advanced-modes.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-modes.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-host.js');

    const { app, calls } = createApp();
    dom.window.setupMusicStage(app);
    app.stageHost.enter();
    await wait(dom.window, 20);

    assert.equal(app.stageHost.active, true);
    assert.equal(app.isStageActive, true);
    assert.equal(app.stageHost.getDebugSnapshot().modeRootChildren, 1);

    // A switch builds the new mode behind the old one and keeps both for one
    // soft-focus crossfade; drive frames until only the new one is left.
    // 宿主按帧时间限帧：同一个时间戳只画一次，所以每轮往前走一步
    let clock = 1000;
    const settleSwitch = async () => {
        for (let i = 0; i < 40; i++) {
            clock += 100;
            app.stageHost.updateFrame(clock);
            if (!app.stageHost.getDebugSnapshot().switching) return;
            await wait(dom.window, 100);
        }
        assert.fail('mode switch never finished');
    };

    for (const mode of ['tempera', 'sonnet', 'diorama', 'fume', 'partita', 'cadenza', 'luminous', 'fume']) {
        app.stageHost.setMode(mode);
        const during = app.stageHost.getDebugSnapshot();
        assert.ok(during.modeRootChildren <= 2, 'at most the old and the new mode at once');
        await settleSwitch();
        const snapshot = app.stageHost.getDebugSnapshot();
        assert.equal(snapshot.modeId, mode);
        assert.equal(snapshot.modeRootChildren, 1);
        // The jsdom lifecycle harness does not load Pixi directors or WebGL;
        // Fume is the only manager that synchronously owns a canvas here.
        const expectedCanvases = mode === 'fume' ? 1 : 0;
        assert.equal(snapshot.canvasCount, expectedCanvases);
        if (mode === 'diorama') {
            assert.ok(dom.window.document.querySelector('.diorama-fallback'));
        }
    }

    app.stageHost.setMode('starborn');
    await settleSwitch();
    const starborn = app.stageHost.getDebugSnapshot();
    assert.equal(starborn.modeId, 'starborn');
    assert.equal(starborn.mode.excludesWebGLModes, true);
    assert.equal(starborn.mode.candidateModes.includes('diorama'), false);
    assert.equal(starborn.mode.candidateModes.includes('tempera'), true);
    assert.equal(starborn.mode.candidateModes.includes('sonnet'), true);

    app.stageHost.setMode('luminous');
    await settleSwitch();
    const afterFume = app.stageHost.getDebugSnapshot();
    assert.equal(afterFume.canvasCount, 0);
    assert.equal(afterFume.modeRootChildren, 1);
    assert.ok(afterFume.modeDestroys >= 8);

    app.stageHost.exit();
    await wait(dom.window, 410);
    const exited = app.stageHost.getDebugSnapshot();
    assert.equal(exited.active, false);
    assert.equal(calls.sidebarScrolls, 1);
    assert.equal(exited.hasModeInstance, false);
    assert.equal(exited.modeRootChildren, 0);
    assert.equal(app.isStageActive, false);

    app.stageHost.destroy();
    dom.window.close();
});

test('stage transport synchronizes play mode, mute and volume with the existing player', async () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-config.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-mode-utils.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-lyric-layout.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-lyric-performance.js');
    runScript(dom, 'Musicmodules/music-stage/modes/luminous-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/partita-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/cadenza-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/tempera-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/sonnet-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/diorama-manager.js');
    runScript(dom, 'Musicmodules/music-stage/modes/fume-manager.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-advanced-modes.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-modes.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
    runScript(dom, 'Musicmodules/music-stage/music-stage-host.js');

    const { app, calls } = createApp();
    dom.window.setupMusicStage(app);
    app.stageHost.enter();
    await wait(dom.window, 20);

    const document = dom.window.document;
    const playMode = document.querySelector('[data-stage-action="play-mode"]');
    const mute = document.querySelector('[data-stage-action="toggle-mute"]');
    const volume = document.querySelector('.music-stage-volume-slider');

    playMode.click();
    assert.equal(app.currentPlayMode, 1);
    assert.equal(playMode.getAttribute('aria-label'), '单曲循环');

    playMode.click();
    assert.equal(app.currentPlayMode, 2);
    assert.equal(playMode.getAttribute('aria-label'), '随机播放');

    mute.click();
    assert.equal(app.volumeSlider.value, '0');
    assert.equal(calls.volumes.at(-1), 0);
    assert.equal(mute.classList.contains('is-muted'), true);

    mute.click();
    assert.equal(Number(app.volumeSlider.value), 0.8);
    assert.equal(calls.volumes.at(-1), 0.8);

    volume.value = '0.36';
    volume.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(Number(app.volumeSlider.value), 0.36);
    assert.equal(calls.volumes.at(-1), 0.36);

    app.stageHost.destroy();
    dom.window.close();
});
test('3D stage waits for the new song\'s lyrics behind a fade instead of building twice', async () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    for (const file of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
        'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js', 'modes/luminous-manager.js',
        'modes/partita-manager.js', 'modes/cadenza-manager.js', 'modes/diorama-manager.js',
        'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js']) {
        runScript(dom, `Musicmodules/music-stage/${file}`);
    }
    dom.window.localStorage.setItem('musicStageMode', 'diorama');
    const { app } = createApp();
    dom.window.setupMusicStage(app);
    app.stageHost.enter();
    await wait(dom.window, 20);
    app.stageHost.updateFrame(1000);
    const modeRoot = () => dom.window.document.querySelector('.music-stage-mode-root > .music-stage-mode');
    assert.equal(app.stageHost.getDebugSnapshot().songHandover, null);

    // The player switches songs: lyrics are emptied first and filled in later.
    const lyrics = app.currentLyrics;
    app.playlist.push({ ...app.playlist[0], path: 'C:\\Music\\next.flac', title: '下一首.flac' });
    app.currentTrackIndex = 1;
    app.currentLyrics = [];
    app.stageHost.updateFrame(1100);
    assert.equal(app.stageHost.getDebugSnapshot().songHandover, 'new-song');
    assert.ok(modeRoot().classList.contains('is-song-leaving'));

    await wait(dom.window, 400);
    app.stageHost.updateFrame(1500);
    // Faded out, but still no words: keep waiting rather than building a wordless journey.
    assert.equal(app.stageHost.getDebugSnapshot().songHandover, 'new-song');

    app.currentLyrics = lyrics.map((line) => ({ ...line }));
    app.stageHost.updateFrame(1600);
    assert.equal(app.stageHost.getDebugSnapshot().songHandover, null);
    await wait(dom.window, 40);
    assert.equal(modeRoot().classList.contains('is-song-leaving'), false);
    app.stageHost.destroy();
});

test('lyric stages draw at most 60 frames a second unless the ultimate tier is chosen', async () => {
    const frames = async (quality) => {
        const dom = createStageDom();
        installCanvasStub(dom.window);
        for (const file of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js', 'modes/luminous-manager.js',
            'modes/partita-manager.js', 'modes/cadenza-manager.js', 'modes/diorama-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js']) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }
        dom.window.localStorage.setItem('musicStageMode', 'luminous');
        if (quality) dom.window.MusicStageConfig.update({ quality });
        const { app } = createApp();
        dom.window.setupMusicStage(app);
        app.stageHost.enter();
        await wait(dom.window, 20);
        const before = app.stageHost.getDebugSnapshot().frameUpdates;
        // One second of a 120 Hz display.
        for (let i = 0; i < 120; i++) app.stageHost.updateFrame(10000 + i * (1000 / 120));
        const drawn = app.stageHost.getDebugSnapshot().frameUpdates - before;
        app.stageHost.destroy();
        return drawn;
    };
    const standard = await frames(null);
    assert.ok(standard >= 58 && standard <= 62, `standard tier drew ${standard} of 120`);
    assert.equal(await frames('ultimate'), 120);
});

test('MusicStageConfig preserves distinct cameraMode enums for kowloon and fume without cross-overwriting', () => {
    const dom = createStageDom();
    runScript(dom, 'Musicmodules/music-stage/music-stage-config.js');
    const cfg = dom.window.MusicStageConfig;

    assert.equal(cfg.update({ modes: { kowloon: { cameraMode: 'sandbox' } } }).modes.kowloon.cameraMode, 'sandbox');
    assert.equal(cfg.update({ modes: { kowloon: { cameraMode: 'diorama' } } }).modes.kowloon.cameraMode, 'diorama');
    assert.equal(cfg.update({ modes: { kowloon: { cameraMode: 'auto' } } }).modes.kowloon.cameraMode, 'auto');
    assert.equal(cfg.update({ modes: { kowloon: { cameraMode: 'stepped' } } }).modes.kowloon.cameraMode, 'sandbox');

    assert.equal(cfg.update({ modes: { fume: { cameraMode: 'smooth' } } }).modes.fume.cameraMode, 'smooth');
    assert.equal(cfg.update({ modes: { fume: { cameraMode: 'stepped' } } }).modes.fume.cameraMode, 'stepped');
    assert.equal(cfg.update({ modes: { fume: { cameraMode: 'sandbox' } } }).modes.fume.cameraMode, 'smooth');
    dom.window.close();
});

test('MusicStageRuntime.isReducedMotion honors MusicMotion override ahead of matchMedia', () => {
    const dom = createStageDom();
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
    const rt = dom.window.MusicStageRuntime;

    assert.equal(rt.isReducedMotion({ matches: true }), true);
    assert.equal(rt.isReducedMotion({ matches: false }), false);

    dom.window.MusicMotion = { reduced: () => true };
    assert.equal(rt.isReducedMotion({ matches: false }), true);

    dom.window.MusicMotion = { reduced: () => false };
    assert.equal(rt.isReducedMotion({ matches: true }), false);
    dom.window.close();
});

test('interlude visualizer performs zero style writes on settled paused frames', () => {
    const dom = createStageDom();
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
    const interlude = dom.window.MusicStageRuntime.createInterludeVisualizer({ barCount: 12 });
    dom.window.document.body.appendChild(interlude.root);

    const frame = {
        isPlaying: false,
        playbackTime: 12.5,
        audio: { power: 0, spectrum: new Array(64).fill(0) }
    };
    interlude.update(frame, { visible: true, intensity: 1 });

    let writes = 0;
    const origSet = interlude.root.style.setProperty.bind(interlude.root.style);
    interlude.root.style.setProperty = (...args) => { writes += 1; return origSet(...args); };

    interlude.update(frame, { visible: true, intensity: 1 });
    interlude.update(frame, { visible: true, intensity: 1 });
    assert.equal(writes, 0, 'settled paused frames do not rewrite CSS custom properties');
    interlude.destroy();
    dom.window.close();
});

test('stage host skips hidden backdrop audio writes in opaque modes and skips disabled edgeSpectrum', async () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    const stageRoot = dom.window.document.getElementById('music-stage');
    stageRoot.querySelector('.music-stage-backdrop-current').classList.add('music-stage-backdrop-layer');
    for (const file of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
        'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js', 'modes/luminous-manager.js',
        'modes/partita-manager.js', 'modes/cadenza-manager.js', 'modes/diorama-manager.js',
        'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js']) {
        runScript(dom, `Musicmodules/music-stage/${file}`);
    }
    dom.window.localStorage.setItem('musicStageMode', 'luminous');
    const { app } = createApp();
    app.currentVisualizerData = new Array(64).fill(0.5);
    dom.window.setupMusicStage(app);
    app.stageHost.enter();
    await wait(dom.window, 25);

    const backdrop = stageRoot.querySelector('.music-stage-backdrop-current');
    const edge = stageRoot.querySelector('.music-stage-edge-spectrum');
    app.stageHost.updateFrame(1000);
    const initialPower = backdrop.style.getPropertyValue('--stage-audio-power');
    assert.ok(Number(initialPower) > 0, 'non-opaque mode writes backdrop audio power');
    assert.equal(edge.style.getPropertyValue('--stage-audio-power'), initialPower);

    // Mark stage opaque and disable edgeSpectrum, then feed different audio level
    stageRoot.classList.add('stage-opaque');
    dom.window.MusicStageConfig.update({ edgeSpectrum: false });
    app.currentVisualizerData = new Array(64).fill(0.95);
    app.stageHost.updateFrame(2000);
    assert.equal(backdrop.style.getPropertyValue('--stage-audio-power'), initialPower, 'opaque mode skips hidden backdrop audio writes');
    assert.equal(edge.style.getPropertyValue('--stage-audio-power'), initialPower, 'disabled edgeSpectrum skips audio writes');

    app.stageHost.destroy();
    dom.window.close();
});

const createMockWebGL2 = () => {
    let nextId = 1;
    const stats = {
        created: { tex: 0, fbo: 0, buf: 0, prog: 0, vao: 0 },
        deleted: { tex: 0, fbo: 0, buf: 0, prog: 0, vao: 0 },
        draws: 0
    };
    const gl = {
        stats,
        VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
        COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82, ACTIVE_UNIFORMS: 0x8B86,
        TEXTURE_2D: 0x0DE1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
        TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
        LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, NEAREST: 0x2600,
        CLAMP_TO_EDGE: 0x812F, REPEAT: 0x2901,
        RGBA: 0x1908, RGBA8: 0x8058, RGBA16F: 0x881A, RED: 0x1903, R8: 0x8229, RG: 0x8227, RG8: 0x822B,
        UNSIGNED_BYTE: 0x1401, HALF_FLOAT: 0x140B, FLOAT: 0x1406,
        FRAMEBUFFER: 0x8D40, COLOR_ATTACHMENT0: 0x8CE0, COLOR_ATTACHMENT1: 0x8CE1, COLOR_ATTACHMENT2: 0x8CE2,
        ARRAY_BUFFER: 0x8892, DYNAMIC_DRAW: 0x88E8, STATIC_DRAW: 0x88E4,
        TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, POINTS: 0x0000,
        BLEND: 0x0BE2, ONE: 1, ZERO: 0, SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
        COLOR_BUFFER_BIT: 0x4000, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_FLIP_Y_WEBGL: 0x9240,
        MAX_TEXTURE_SIZE: 0x0D33,
        TEXTURE0: 0x84C0, TEXTURE1: 0x84C1, TEXTURE2: 0x84C2, TEXTURE3: 0x84C3,
        TEXTURE4: 0x84C4, TEXTURE5: 0x84C5, TEXTURE6: 0x84C6, TEXTURE15: 0x84CF,
        getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext() {} } : {}),
        getParameter: (p) => (p === 0x0D33 ? 4096 : 0),
        createShader: () => ({ id: nextId++ }),
        shaderSource() {},
        compileShader() {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        deleteShader() {},
        createProgram: () => { stats.created.prog += 1; return { id: nextId++ }; },
        attachShader() {},
        linkProgram() {},
        getProgramParameter: (_p, pname) => (pname === 0x8B86 ? 0 : true),
        getProgramInfoLog: () => '',
        getActiveUniform: () => null,
        getUniformLocation: () => ({ id: nextId++ }),
        deleteProgram: (p) => { if (p) stats.deleted.prog += 1; },
        useProgram() {},
        createTexture: () => { stats.created.tex += 1; return { id: nextId++ }; },
        bindTexture() {},
        texParameteri() {},
        texImage2D() {},
        texSubImage2D() {},
        generateMipmap() {},
        pixelStorei() {},
        activeTexture() {},
        deleteTexture: (t) => { if (t) stats.deleted.tex += 1; },
        createFramebuffer: () => { stats.created.fbo += 1; return { id: nextId++ }; },
        bindFramebuffer() {},
        framebufferTexture2D() {},
        drawBuffers() {},
        deleteFramebuffer: (f) => { if (f) stats.deleted.fbo += 1; },
        createVertexArray: () => { stats.created.vao += 1; return { id: nextId++ }; },
        bindVertexArray() {},
        deleteVertexArray: (v) => { if (v) stats.deleted.vao += 1; },
        createBuffer: () => { stats.created.buf += 1; return { id: nextId++ }; },
        bindBuffer() {},
        bufferData() {},
        bufferSubData() {},
        enableVertexAttribArray() {},
        vertexAttribPointer() {},
        vertexAttribDivisor() {},
        deleteBuffer: (b) => { if (b) stats.deleted.buf += 1; },
        viewport() {},
        clearColor() {},
        clear() {},
        enable() {},
        disable() {},
        blendFunc() {},
        blendFuncSeparate() {},
        drawArrays() { stats.draws += 1; },
        drawArraysInstanced() { stats.draws += 1; },
        uniform1f() {}, uniform1i() {}, uniform1iv() {}, uniform2f() {}, uniform3f() {}, uniform4f() {},
        uniform1fv() {}, uniform2fv() {}, uniform3fv() {}, uniform4fv() {},
        uniformMatrix2fv() {}, uniformMatrix3fv() {}, uniformMatrix4fv() {}
    };
    return new Proxy(gl, {
        get(target, prop) {
            if (prop in target) return target[prop];
            return typeof prop === 'string' && prop === prop.toUpperCase() ? 0 : () => {};
        }
    });
};

test('stage-mode-utils WebGL2 helpers dispose every created GL resource idempotently', () => {
    const dom = createStageDom();
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
    runScript(dom, 'Musicmodules/music-stage/modes/stage-mode-utils.js');
    const U = dom.window.MusicStageModeUtils;
    const gl = createMockWebGL2();

    const target = U.createTarget(gl);
    target.bind(64, 64);
    const bloom = U.createBloom(gl, { label: 'test' });
    const glowTex = bloom.run(target, null);
    bloom.add(glowTex, 64, 64, 1);
    const sharp = U.createSharpText(gl, { coverage: 'vec4 coverage(vec2 uv) { return vec4(0.0); }', label: 'test' });
    sharp.begin(64, 64);
    sharp.finish(128, 128, { bloom: 0.5 });
    const glyphs = U.createGlyphLayer(gl, { home: 'vec2 home(vec2 t) { return t; }', label: 'test' });

    target.dispose();
    target.dispose();
    bloom.dispose();
    bloom.dispose();
    sharp.dispose();
    sharp.dispose();
    glyphs.dispose();
    glyphs.dispose();

    assert.equal(gl.stats.deleted.prog, gl.stats.created.prog, 'all programs deleted once');
    assert.equal(gl.stats.deleted.tex, gl.stats.created.tex, 'all textures deleted once');
    assert.equal(gl.stats.deleted.fbo, gl.stats.created.fbo, 'all framebuffers deleted once');
    assert.equal(gl.stats.deleted.buf, gl.stats.created.buf, 'all buffers deleted once');
    assert.equal(gl.stats.deleted.vao, gl.stats.created.vao, 'all VAOs deleted once');
    assert.ok(gl.stats.created.vao >= 3 && gl.stats.created.prog >= 8, 'helpers actually allocated GL resources');
    dom.window.close();
});

test('2D WebGL2 stages honor 24/30/60fps quality tiers and delete VAOs on destroy', () => {
    const stages = [
        { file: 'modes/clockwork-manager.js', globalName: 'MusicStageClockworkManager' },
        { file: 'modes/orbit-manager.js', globalName: 'MusicStageOrbitManager' },
        { file: 'modes/lumiere-manager.js', globalName: 'MusicStageLumiereManager' },
        { file: 'modes/hanabi-manager.js', globalName: 'MusicStageHanabiManager' },
        { file: 'modes/signal-manager.js', globalName: 'MusicStageSignalManager' }
    ];
    for (const { file, globalName } of stages) {
        const dom = createStageDom();
        installCanvasStub(dom.window);
        let mockNow = 1000;
        dom.window.performance.now = () => mockNow;
        const gl = createMockWebGL2();
        const stub2d = new Proxy({
            font: '', fillStyle: '', strokeStyle: '', textAlign: 'left', textBaseline: 'alphabetic',
            globalAlpha: 1, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalCompositeOperation: 'source-over',
            createLinearGradient: () => ({ addColorStop() {} }),
            createRadialGradient: () => ({ addColorStop() {} }),
            getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
            measureText: (text) => ({ width: Math.max(12, String(text || '').length * 24), actualBoundingBoxAscent: 18, actualBoundingBoxDescent: 6 }),
            getImageData: () => ({ data: new Uint8ClampedArray(4) })
        }, {
            get(target, prop) {
                if (prop in target) return target[prop];
                return () => {};
            }
        });
        dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
            if (type === 'webgl2') return gl;
            if (type === '2d') return stub2d;
            return null;
        };
        for (const dep of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js', file]) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const host = dom.window.document.createElement('div');
        Object.defineProperty(host, 'clientWidth', { value: 960 });
        Object.defineProperty(host, 'clientHeight', { value: 540 });
        dom.window.document.body.appendChild(host);
        const { app } = createApp();
        const mode = dom.window[globalName].create(host, { app });
        const lines = dom.window.MusicStageRuntime.normalizeLines(app.currentLyrics);
        const runWindow = (quality) => {
            mode.updateConfig({ quality });
            mockNow += 200;
            let drawn = 0;
            for (let i = 0; i < 60; i += 1) {
                mockNow += 1000 / 60;
                const before = gl.stats.draws;
                const t = 1 + i * (1 / 60);
                mode.updateFrame({
                    isPlaying: true,
                    playbackTime: t,
                    duration: 180,
                    lines,
                    currentLineIndex: 0,
                    activeLine: lines[0],
                    lineProgress: 0.3,
                    wordStates: [],
                    track: app.playlist[0],
                    audio: { power: 0.4, bass: 0.3, lowMid: 0.3, mid: 0.3, vocal: 0.4, treble: 0.2, spectrum: new Array(64).fill(0.3) }
                });
                if (gl.stats.draws > before) drawn += 1;
            }
            return drawn;
        };
        const ultimateFrames = runWindow('ultimate');
        const standardFrames = runWindow('standard');
        const savingFrames = runWindow('energy-saving');
        assert.ok(ultimateFrames >= 55, `${globalName} ultimate drew ${ultimateFrames} of 60`);
        assert.ok(standardFrames >= 25 && standardFrames <= 35, `${globalName} standard drew ${standardFrames} of 60`);
        assert.ok(savingFrames >= 20 && savingFrames <= 27, `${globalName} energy-saving drew ${savingFrames} of 60`);
        assert.ok(ultimateFrames > standardFrames && standardFrames > savingFrames, `${globalName} tiers strictly ordered (${ultimateFrames} > ${standardFrames} > ${savingFrames})`);

        mode.destroy();
        assert.equal(gl.stats.deleted.vao, gl.stats.created.vao, `${globalName} deleted every VAO`);
        assert.equal(gl.stats.deleted.prog, gl.stats.created.prog, `${globalName} deleted every program`);
        assert.equal(gl.stats.deleted.fbo, gl.stats.created.fbo, `${globalName} deleted every framebuffer`);
        assert.equal(gl.stats.deleted.buf, gl.stats.created.buf, `${globalName} deleted every buffer`);
        dom.window.close();
    }
});

test('fume skips redundant clearRect when background disabled and groupchat uses WAAPI on onset', () => {
    const dom = createStageDom();
    installCanvasStub(dom.window);
    let clearCount = 0;
    const origGetCtx = dom.window.HTMLCanvasElement.prototype.getContext;
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
        const ctx = origGetCtx.call(this, type, ...args);
        if (type === '2d' && ctx) {
            return new Proxy(ctx, {
                get(target, prop) {
                    if (prop === 'clearRect') return () => { clearCount += 1; };
                    return prop in target ? target[prop] : () => {};
                }
            });
        }
        return ctx;
    };
    for (const dep of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js', 'modes/fume-manager.js', 'modes/groupchat-manager.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const { app } = createApp();
    const lines = dom.window.MusicStageRuntime.normalizeLines(app.currentLyrics);
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const fume = dom.window.MusicStageFumeManager.create(host, { app });
    fume.updateConfig({ modes: { fume: { geometricBackground: false } } });
    clearCount = 0;
    const mkFrame = (t, onset = 0) => ({
        now: 1000 + t * 1000,
        isPlaying: true,
        playbackTime: t,
        duration: 180,
        lines,
        currentLineIndex: 0,
        activeLine: lines[0],
        lineProgress: 0.2,
        wordStates: [],
        track: app.playlist[0],
        audio: { power: 0.5, bass: 0.4, lowMid: 0.3, mid: 0.3, vocal: 0.4, treble: 0.2, onsets: onset, spectrum: new Array(64).fill(0.3) }
    });
    fume.updateFrame(mkFrame(1.1));
    fume.updateFrame(mkFrame(1.2));
    fume.updateFrame(mkFrame(1.3));
    assert.equal(clearCount, 1, 'fume clears disabled background canvas once instead of every frame');
    fume.destroy();

    let animated = 0;
    let offsetReads = 0;
    dom.window.HTMLElement.prototype.animate = () => { animated += 1; return { cancel() {} }; };
    const gcHost = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(gcHost);
    const gc = dom.window.MusicStageGroupchatManager.create(gcHost, { app });
    gc.updateFrame(mkFrame(1.1, 1));
    const bubble = gcHost.querySelector('.gc-bubble');
    assert.ok(bubble, 'groupchat rendered lyric bubble');
    animated = 0;
    Object.defineProperty(bubble, 'offsetWidth', { get() { offsetReads += 1; return 200; }, configurable: true });
    gc.updateFrame(mkFrame(1.5, 2));
    assert.equal(animated, 1, 'onset pulse uses Web Animations API');
    assert.equal(offsetReads, 0, 'onset pulse avoids forced offsetWidth reflow');
    gc.destroy();
    dom.window.close();
});

test('sonnet and tempera respond immediately to music-motion-change while paused', () => {
    for (const { file, globalName, dirName } of [
        { file: 'modes/sonnet-manager.js', globalName: 'MusicStageSonnetManager', dirName: 'SonnetPixiDirector' },
        { file: 'modes/tempera-manager.js', globalName: 'MusicStageTemperaManager', dirName: 'TemperaPixiDirector' }
    ]) {
        const dom = createStageDom();
        let reduced = false;
        let updates = 0;
        let lastReduced = null;
        dom.window.MusicMotion = { reduced: () => reduced };
        dom.window.MusicStagePixiEffects = { lensOn: () => false };
        dom.window[dirName] = class {
            constructor() { this.initialized = true; this.width = 800; this.height = 600; }
            init() { return Promise.resolve(); }
            resize() {}
            buildShot() {}
            update(_f, t) { updates += 1; lastReduced = t.reducedMotion; }
            destroy() {}
        };
        for (const dep of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js', file]) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const { app } = createApp();
        const lines = dom.window.MusicStageRuntime.normalizeLines(app.currentLyrics);
        const host = dom.window.document.createElement('div');
        dom.window.document.body.appendChild(host);
        const mode = dom.window[globalName].create(host, { app });
        mode.updateFrame({
            isPlaying: false, playbackTime: 1.2, duration: 180, lines, currentLineIndex: 0,
            activeLine: lines[0], lineProgress: 0.2, wordStates: [], track: app.playlist[0], audio: {}
        });
        assert.equal(updates, 1);
        assert.equal(lastReduced, false);
        reduced = true;
        dom.window.dispatchEvent(new dom.window.Event('music-motion-change'));
        assert.equal(updates, 2, `${globalName} repaints on music-motion-change while paused`);
        assert.equal(lastReduced, true);
        mode.destroy();
        dom.window.close();
    }
});

test('edge spectrum paces by quality tier, caps energy-saving DPR to 1, and clears once when disabled', () => {
    const dom = createStageDom();
    const strokes = [];
    const clears = [];
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
        if (type !== '2d') return null;
        return new Proxy({
            setTransform() {},
            clearRect() { clears.push(this); },
            stroke() { strokes.push(this); }
        }, {
            get(target, prop) { return prop in target ? target[prop] : () => {}; }
        });
    };
    for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const root = dom.window.document.getElementById('music-stage');
    Object.defineProperty(root, 'clientWidth', { value: 1200 });
    Object.defineProperty(root, 'clientHeight', { value: 700 });
    const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
    const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
    const state = { config: { quality: 'energy-saving', edgeSpectrum: true } };
    const edge = dom.window.MusicStageEdge.create({
        app: {},
        root,
        elements: { edgeSpectrum, edgeCanvas },
        state,
        scope: { add() {} },
        clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
    });
    const mkFrame = (now) => ({
        now,
        isPlaying: true,
        viewport: { dpr: 2 },
        audio: { power: 0.6, spectrum: new Array(64).fill(0.5) }
    });
    const runSecond = (quality, base) => {
        state.config.quality = quality;
        let drawn = 0;
        for (let i = 0; i < 60; i += 1) {
            const before = strokes.length;
            edge.draw(mkFrame(base + i * (1000 / 60)));
            if (strokes.length > before) drawn += 1;
        }
        return drawn;
    };
    const savingDraws = runSecond('energy-saving', 1000);
    assert.equal(edgeCanvas.width, 1200, 'energy-saving caps edge strip DPR to 1');
    const standardDraws = runSecond('standard', 3000);
    assert.equal(edgeCanvas.width, 1800, 'standard allows edge strip DPR up to 1.5');
    const ultimateDraws = runSecond('ultimate', 5000);
    assert.ok(ultimateDraws > standardDraws && standardDraws > savingDraws, `edge tiers ordered (${ultimateDraws} > ${standardDraws} > ${savingDraws})`);

    clears.length = 0;
    state.config.edgeSpectrum = false;
    edge.draw(mkFrame(7000));
    edge.draw(mkFrame(7100));
    assert.equal(clears.length, 4, 'disabling edgeSpectrum clears the 4 strips once');
    edge.release();
    dom.window.close();
});

test('stage-lyric-performance caches font assignments in measure() and reacts to paused card box shift', () => {
    const dom = createStageDom();
    let fontSets = 0;
    let curFont = '';
    const roCallbacks = [];
    dom.window.ResizeObserver = class {
        constructor(cb) { this.cb = cb; roCallbacks.push(cb); }
        observe() {}
        disconnect() {}
    };
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
        if (type !== '2d') return null;
        return new Proxy({
            get font() { return curFont; },
            set font(v) { fontSets += 1; curFont = v; },
            measureText: (t) => ({ width: Math.max(8, String(t || '').length * 16) })
        }, {
            get(target, prop) { return prop in target ? target[prop] : () => {}; },
            set(target, prop, value) { target[prop] = value; return true; }
        });
    };
    for (const dep of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js', 'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js', 'modes/luminous-manager.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const { app } = createApp();
    const lines = dom.window.MusicStageRuntime.normalizeLines(app.currentLyrics);
    const stageRoot = dom.window.document.getElementById('music-stage');
    stageRoot.classList.add('music-stage');
    const host = dom.window.document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 960 });
    Object.defineProperty(host, 'clientHeight', { value: 540 });
    stageRoot.appendChild(host);
    let cardRight = 100;
    const card = dom.window.document.createElement('div');
    card.className = 'music-stage-id3';
    card.getBoundingClientRect = () => ({ left: 20, top: 20, right: cardRight, bottom: 320, width: cardRight - 20, height: 300 });
    stageRoot.appendChild(card);
    const mode = dom.window.MusicStageLuminousManager.create(host, { app });
    const viewport = host.querySelector('.lyric-performance-viewport');
    Object.defineProperty(viewport, 'clientWidth', { value: 960 });
    Object.defineProperty(viewport, 'clientHeight', { value: 540 });
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540 });
    roCallbacks.forEach((cb) => cb());
    const pausedFrame = {
        isPlaying: false,
        playbackTime: 1.2,
        duration: 180,
        lines,
        currentLineIndex: 0,
        activeLine: lines[0],
        nextLines: lines.slice(1),
        lineProgress: 0.25,
        wordStates: [],
        track: app.playlist[0],
        audio: { power: 0.3, bass: 0.2, lowMid: 0.2, mid: 0.2, vocal: 0.3, treble: 0.1 }
    };
    mode.updateFrame(pausedFrame);
    const fieldEl = viewport.firstElementChild?.firstElementChild;
    assert.ok(fieldEl, 'luminous mounted lyric scene field');
    assert.ok(fontSets > 0 && fontSets <= 3, `measure() cached repeated fonts (${fontSets} sets)`);
    const firstTransform = fieldEl.style.transform;
    cardRight = 560;
    roCallbacks.forEach((cb) => cb());
    mode.updateFrame(pausedFrame);
    assert.notEqual(fieldEl.style.transform, firstTransform, 'paused frame re-evaluates dodgeCard when card box shifts');
    mode.destroy();
    dom.window.close();
});

test('music-stage-skin avoids full-window edge-spectrum offscreen pass and trims energy-saving blur', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-stage-skin.css'), 'utf8');
    const edgeBlock = css.match(/\.music-stage\s+\.music-stage-edge-spectrum\s*\{([^}]*)\}/);
    assert.ok(edgeBlock, 'edge-spectrum container rule exists');
    assert.match(edgeBlock[1], /filter:\s*none;/, 'no full-window grayscale filter on container');
    assert.match(edgeBlock[1], /opacity:\s*1;/, 'no full-window group opacity on container');
    assert.match(css, /\.music-stage\s+\.music-stage-edge-spectrum-canvas\s*\{[^}]*--stage-edge-mono:\s*1;[^}]*filter:\s*none;/, 'skin switches edge canvases to JS mono without per-frame CSS grayscale filter');
    assert.match(css, /body\.music-fl-low\s+\.music-stage-id3\s*\{[^}]*backdrop-filter:\s*none/, 'energy-saving disables backdrop-filter on stage track card');

    const dom = createStageDom();
    const blurs = [];
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
        if (type !== '2d') return null;
        let sb = 0;
        return new Proxy({
            get shadowBlur() { return sb; },
            set shadowBlur(v) { sb = v; },
            stroke() { blurs.push(sb); }
        }, {
            get(target, prop) { return prop in target ? target[prop] : () => {}; },
            set(target, prop, value) { target[prop] = value; return true; }
        });
    };
    for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const root = dom.window.document.getElementById('music-stage');
    Object.defineProperty(root, 'clientWidth', { value: 960 });
    Object.defineProperty(root, 'clientHeight', { value: 540 });
    const state = { config: { quality: 'energy-saving', edgeSpectrum: true } };
    const edge = dom.window.MusicStageEdge.create({
        app: {},
        root,
        elements: {
            edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'),
            edgeCanvas: root.querySelector('.music-stage-edge-spectrum-canvas')
        },
        state,
        scope: { add() {} },
        clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
    });
    edge.draw({ now: 1000, isPlaying: true, viewport: { dpr: 2 }, audio: { power: 0.6, spectrum: new Array(64).fill(0.5) } });
    assert.ok(blurs.length === 8 && Math.max(...blurs) === 8 && blurs.includes(0), 'energy-saving halves outer blur and skips secondary blur');
    blurs.length = 0;
    state.config.quality = 'standard';
    edge.draw({ now: 2000, isPlaying: true, viewport: { dpr: 2 }, audio: { power: 0.6, spectrum: new Array(64).fill(0.5) } });
    assert.ok(blurs.length === 8 && Math.max(...blurs) === 18 && blurs.includes(3.5), 'standard keeps full 18/3.5 shadowBlur');
    edge.release();
    dom.window.close();
});

test('edge spectrum skips allocating canvases during reduced motion or silence and shrinks strips to 1x1 when disabled', () => {
    const dom = createStageDom();
    const clears = [];
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
        if (type !== '2d') return null;
        return new Proxy({
            clearRect: (...args) => clears.push(args)
        }, {
            get(target, prop) { return prop in target ? target[prop] : () => {}; },
            set(target, prop, value) { target[prop] = value; return true; }
        });
    };
    for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const root = dom.window.document.getElementById('music-stage');
    let widthReads = 0;
    Object.defineProperty(root, 'clientWidth', { get() { widthReads += 1; return 1200; } });
    Object.defineProperty(root, 'clientHeight', { get() { return 700; } });
    const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
    const state = { config: { quality: 'standard', edgeSpectrum: true } };
    const edge = dom.window.MusicStageEdge.create({
        app: {},
        root,
        elements: { edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'), edgeCanvas },
        state,
        scope: { add() {} },
        clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
    });

    // 静音/无频谱时不读取布局也不分配全分辨率边条画布
    edge.draw({ now: 1000, isPlaying: false, viewport: { dpr: 2 }, audio: { power: 0, spectrum: [] } });
    assert.equal(widthReads, 0, 'silent empty spectrum skips resizeEdgeCanvas layout reads');
    assert.equal(edgeCanvas.width, 300, 'canvas remains unallocated default size while silent');

    // 正常绘制后禁用边条频谱：清理 4 条边一次并立即缩回 1x1 释放显存
    edge.draw({ now: 2000, isPlaying: true, viewport: { dpr: 2 }, audio: { power: 0.7, spectrum: new Array(64).fill(0.6) } });
    assert.equal(edgeCanvas.width, 1800);
    clears.length = 0;
    state.config.edgeSpectrum = false;
    edge.draw({ now: 2100, isPlaying: true, viewport: { dpr: 2 }, audio: { power: 0.7, spectrum: new Array(64).fill(0.6) } });
    assert.equal(clears.length, 4, 'disabling edgeSpectrum clears all 4 strips once');
    assert.equal(edgeCanvas.width, 1, 'disabling edgeSpectrum shrinks strip canvas to 1x1');
    assert.equal(edgeCanvas.height, 1);
    dom.window.close();
});

test('energy-saving mode disables backdrop-filter across dock drawer, stage switcher, intro transit, and stage settings', () => {
    const drawerCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-dock/music-dock-drawer.css'), 'utf8');
    assert.match(drawerCss, /#music-dock-root\.md-fl-low \.md-cmd-box/);
    assert.match(drawerCss, /#music-dock-root\.md-fl-low \.md-keys-scrim/);
    assert.match(drawerCss, /#music-dock-root\.md-fl-low \.md-hdl button/);

    const skinCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-stage-skin.css'), 'utf8');
    assert.match(skinCss, /body\.music-fl-low\s+\.music-stage-mode-switcher[\s\S]*?backdrop-filter:\s*none/);

    const introCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-intro/music-intro.css'), 'utf8');
    assert.match(introCss, /body\.music-fl-low\s+\.music-intro\.is-transit\[data-intro="enter"\]:not\(\[data-still\]\)::before\s*\{[^}]*backdrop-filter:\s*none/);

    const settingsCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-settings.css'), 'utf8');
    assert.match(settingsCss, /body\.music-fl-low\s+\.music-stage-settings-card[\s\S]*?backdrop-filter:\s*none/);

    const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-host.js'), 'utf8');
    assert.match(hostSrc, /event\.key === 'Escape' && !event\.defaultPrevented && !event\.isComposing/);
    assert.match(hostSrc, /global\.cancelIdleCallback\?\.\(prepareIdleId\)/);

    const stageCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage.css'), 'utf8');
    const modeRootBlock = stageCss.match(/\.music-stage-mode-root\s*\{([^}]*)\}/);
    assert.ok(modeRootBlock && /filter:\s*none;/.test(modeRootBlock[1]), 'idle .music-stage-mode-root uses filter: none (no permanent blur(0) offscreen pass)');
    assert.match(stageCss, /body\.music-stage-active\.music-stage-scene-3d #custom-title-bar[\s\S]*?backdrop-filter:\s*none/);

    const pixi3dCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-pixi-3d.css'), 'utf8');
    assert.match(pixi3dCss, /body\.music-fl-low \.music-stage\.is-playing \.music-stage-edge-flow-light\s*\{\s*animation-timing-function:\s*steps\(135\);/);
    assert.match(pixi3dCss, /\.music-stage-backdrop-layer\.is-empty\s*\{[^}]*will-change:\s*auto;/);
    assert.match(skinCss, /\.music-stage \.music-stage-edge-corners i\s*\{[^}]*filter:\s*none;/);

    const coreModesCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-core-modes.css'), 'utf8');
    assert.doesNotMatch(coreModesCss, /\.starborn-performance-layer\s*\{[^}]*filter:\s*blur\(0\)/);
    assert.match(coreModesCss, /\.starborn-performance-layer\s*\{[^}]*filter:\s*none;/);
    assert.match(coreModesCss, /body\.music-fl-low \.fume-paper\s*\{[^}]*backdrop-filter:\s*none;/);
    assert.match(coreModesCss, /body\.music-reduce-motion \.starborn-director-cue\s*\{[^}]*animation:\s*none;/);

    const musicCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music.css'), 'utf8');
    assert.match(musicCss, /body\.music-fl-low \.help-tip-box,[\s\S]*?body\.music-fl-low \.audio-engine-notice,[\s\S]*?backdrop-filter:\s*none;/);

    const wallCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-archive/archive-wall.css'), 'utf8');
    assert.match(wallCss, /body\.music-fl-low #music-archive-view \.aw-panel-acts button\s*\{[^}]*backdrop-filter:\s*none;/);
});

test('edge spectrum releases strip VRAM on reduced-motion toggle and resolveAccent reuses frozen palette object', () => {
    const dom = createStageDom();
    let saveCalls = 0;
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
        if (type !== '2d') return null;
        return new Proxy({
            save: () => { saveCalls += 1; },
            restore: () => { saveCalls += 1; }
        }, {
            get(target, prop) { return prop in target ? target[prop] : () => {}; },
            set(target, prop, value) { target[prop] = value; return true; }
        });
    };
    let reduceOn = false;
    dom.window.MusicMotion = { reduced: () => reduceOn };
    for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const accentRgb = Object.freeze({ r: 10, g: 20, b: 30 });
    const app = { stagePalette: { accentRgb } };
    assert.equal(dom.window.MusicStageModeUtils.resolveAccent(app), accentRgb, 'resolveAccent reuses frozen palette RGB without allocating');

    const root = dom.window.document.getElementById('music-stage');
    Object.defineProperty(root, 'clientWidth', { value: 1000 });
    Object.defineProperty(root, 'clientHeight', { value: 600 });
    const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
    const edge = dom.window.MusicStageEdge.create({
        app,
        root,
        elements: { edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'), edgeCanvas },
        state: { config: { quality: 'standard', edgeSpectrum: true } },
        scope: { add() {} },
        clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
    });
    edge.draw({ now: 1000, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.5, spectrum: new Float32Array(64).fill(0.5) } });
    assert.equal(edgeCanvas.width, 1000);
    assert.equal(saveCalls, 0, 'strokeEdgePair draws without per-frame save/restore stack churn');

    reduceOn = true;
    edge.draw({ now: 1100, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.5, spectrum: new Float32Array(64).fill(0.5) } });
    assert.equal(edgeCanvas.width, 1, 'toggling reduced motion shrinks allocated edge strips back to 1x1');
    assert.equal(edgeCanvas.height, 1);
    dom.window.close();
});

test('stageHost.updateTheme skips refreshTheme while stage is closed and runs it on enter; stage config validates per-mode keys cleanly', () => {
    const dom = createStageDom();
    const { app } = createApp();
    for (const file of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
        'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
        'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
        'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js']) {
        runScript(dom, `Musicmodules/music-stage/${file}`);
    }
    // Table-driven config validation checks
    const cfg = dom.window.MusicStageConfig;
    const updated = cfg.update({
        modes: {
            tempera: { phraseLength: 99, trackMinSegment: 1, glow: 5 },
            luminous: { wordSpacing: -2, glow: 1.5 },
            kowloon: { cameraMode: 'diorama', fog: 2.5 },
            fume: { cameraMode: 'stepped' }
        }
    });
    assert.equal(updated.modes.tempera.phraseLength, 24);
    assert.equal(updated.modes.tempera.trackMinSegment, 2);
    assert.equal(updated.modes.tempera.glow, 2);
    assert.equal(updated.modes.luminous.wordSpacing, 0);
    assert.equal(updated.modes.luminous.glow, 1.5);
    assert.equal(updated.modes.luminous.phraseLength, undefined, 'modes without phraseLength default do not gain extraneous keys');
    assert.equal(updated.modes.kowloon.cameraMode, 'diorama');
    assert.equal(updated.modes.kowloon.fog, 1.5);
    assert.equal(updated.modes.fume.cameraMode, 'stepped');

    // Closed stage skips refreshTheme during updateTheme, then computes stagePalette on enter
    dom.window.setupMusicStage(app);
    delete app.stagePalette;
    app.stageHost.updateTheme();
    assert.equal(app.stagePalette, undefined, 'closed stage skips refreshTheme probe/canvas readback');
    app.stageHost.enter();
    assert.ok(app.stagePalette && typeof app.stagePalette.accent === 'string', 'entering stage computes fresh stagePalette immediately');
    app.stageHost.destroy();
    dom.window.close();
});

test('edge spectrum uses flat-line fast path on silence, wakes paused border on accent change, and removes cloned canvases on scope destroy', () => {
    const dom = createStageDom();
    let quadCalls = 0;
    let strokeCalls = 0;
    const strokeColors = [];
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
        if (type !== '2d') return null;
        let lastStyle = '';
        return new Proxy({
            quadraticCurveTo() { quadCalls += 1; },
            set strokeStyle(v) { lastStyle = v; },
            get strokeStyle() { return lastStyle; },
            stroke() { strokeCalls += 1; strokeColors.push(lastStyle); }
        }, {
            get(target, prop) { return prop in target ? target[prop] : () => {}; },
            set(target, prop, value) { target[prop] = value; return true; }
        });
    };
    for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
        runScript(dom, `Musicmodules/music-stage/${dep}`);
    }
    const root = dom.window.document.getElementById('music-stage');
    Object.defineProperty(root, 'clientWidth', { value: 960 });
    Object.defineProperty(root, 'clientHeight', { value: 540 });
    const app = { stagePalette: { accentRgb: { r: 10, g: 20, b: 30 } } };
    const scope = new dom.window.MusicStageRuntime.DisposableScope();
    const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
    const edge = dom.window.MusicStageEdge.create({
        app,
        root,
        elements: { edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'), edgeCanvas },
        state: { config: { quality: 'standard', edgeSpectrum: true } },
        scope,
        clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
    });
    assert.equal(root.querySelectorAll('.music-stage-edge-spectrum-canvas').length, 4, '4 strip canvases mounted');

    // Silent spectrum takes flat-line fast path (0 quadraticCurveTo calls)
    edge.draw({ now: 1000, isPlaying: false, viewport: { dpr: 1 }, audio: { power: 0, spectrum: new Float32Array(64) } });
    assert.equal(quadCalls, 0, 'silent spectrum skips Bezier subdivision');
    assert.equal(strokeCalls, 8);

    // After 1500ms paused settle window, same accent stays idle
    edge.draw({ now: 3000, isPlaying: false, viewport: { dpr: 1 }, audio: { power: 0, spectrum: new Float32Array(64) } });
    assert.equal(strokeCalls, 8, 'settled paused border skips redundant redraw');

    // Changing accent color while paused immediately wakes and redraws in new accent
    app.stagePalette = { accentRgb: { r: 200, g: 100, b: 50 } };
    edge.draw({ now: 3100, isPlaying: false, viewport: { dpr: 1 }, audio: { power: 0, spectrum: new Float32Array(64) } });
    assert.equal(strokeCalls, 16, 'accent change wakes settled paused border');
    assert.ok(strokeColors.at(-1).includes('200, 100, 50'), 'redrawn stroke uses updated accent');

    scope.destroy();
    assert.equal(root.querySelectorAll('.music-stage-edge-spectrum-canvas').length, 1, 'scope destroy removes the 3 cloned strip canvases');
    dom.window.close();
});

test('interlude visualizer caches per-bar transform and opacity strings on identical playing frames', () => {
    const dom = createStageDom();
    runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
    const interlude = dom.window.MusicStageRuntime.createInterludeVisualizer({ barCount: 20 });
    dom.window.document.body.appendChild(interlude.root);
    const frame = { isPlaying: true, playbackTime: 5, audio: { power: 0, spectrum: new Float32Array(64) } };
    interlude.update(frame, { visible: true, intensity: 1 });
    const bar0 = interlude.root.querySelector('.stage-interlude-bars i');
    let transformWrites = 0;
    const origStyle = bar0.style;
    const origDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(origStyle), 'transform');
    Object.defineProperty(origStyle, 'transform', {
        configurable: true,
        get() { return origDesc?.get ? origDesc.get.call(this) : ''; },
        set(v) { transformWrites += 1; if (origDesc?.set) origDesc.set.call(this, v); }
    });
    interlude.update({ isPlaying: true, playbackTime: 5.5, audio: { power: 0, spectrum: new Float32Array(64) } }, { visible: true, intensity: 1 });
    assert.equal(transformWrites, 0, 'identical silent spectrum skips redundant bar transform writes');
    interlude.destroy();
    dom.window.close();
});

test('Batch 56: MusicStageConfig debounces slider setModePatch writes, Starborn skips energy-saving blur, and low-power stage CSS disables blur filters', () => {
    const dom = createStageDom();
    try {
        const store = new Map();
        let storageWrites = 0;
        Object.defineProperty(dom.window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => { if (k === 'musicStageConfig') storageWrites += 1; store.set(k, String(v)); }
            }
        });
        runScript(dom, 'Musicmodules/music-stage/music-stage-config.js');
        const cfg = dom.window.MusicStageConfig;
        storageWrites = 0;
        for (let g = 0.2; g <= 1.2; g += 0.2) cfg.setModePatch('luminous', { glow: g });
        assert.equal(storageWrites, 0, 'rapid slider setModePatch calls coalesce via trailing debounce instead of writing 60Hz');
        assert.equal(cfg.get().modes.luminous.glow, 1.2, 'in-memory config reflects latest slider value synchronously');
        cfg.flush();
        assert.equal(storageWrites, 1, 'flush persists latest slider value once');
        const persisted = JSON.parse(dom.window.localStorage.getItem('musicStageConfig'));
        assert.equal(persisted.modes.luminous.glow, 1.2);
        // update() and reset() persist immediately
        cfg.update({ quality: 'energy-saving' });
        assert.equal(storageWrites, 2, 'update persists immediately');

        const stageCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage.css'), 'utf8');
        assert.match(stageCss, /body\.music-fl-low\s+\.music-stage-mode-switcher\s*\{[^}]*backdrop-filter:\s*none/);
        assert.match(stageCss, /body\.music-fl-low\s+\.music-stage-backdrop-noise\s*\{\s*display:\s*none;/);
        assert.match(stageCss, /body\.music-fl-low\s+\.music-stage-edge-spectrum-canvas[\s\S]*?filter:\s*none;/);
        const settingsCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-settings.css'), 'utf8');
        assert.match(settingsCss, /body\.music-fl-low\s+\.music-stage-settings-card\s*\{[^}]*animation:\s*none;/);
        assert.match(settingsCss, /body\.music-fl-low\s+\.music-stage-settings-card::before\s*\{\s*display:\s*none;/);
    } finally {
        dom.window.close();
    }
});

test('Batch 57: edge spectrum clamps narrow viewports, skips resolveAccent on throttled frames, interlude quantizes CSS vars, and CSS fixes reduced-motion/low-power', () => {
    const dom = createStageDom();
    try {
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
        const root = dom.window.document.getElementById('music-stage');
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        if (!edgeSpectrum.querySelector('.music-stage-edge-flow')) {
            const flow = dom.window.document.createElement('div');
            flow.className = 'music-stage-edge-flow';
            edgeSpectrum.appendChild(flow);
        }
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 30 });
        Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 30 });

        let accentReads = 0;
        dom.window.MusicStageModeUtils = {
            resolveAccent: () => { accentReads += 1; return { r: 100, g: 180, b: 255 }; }
        };
        const fakeCtx = () => ({
            setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
            quadraticCurveTo() {}, stroke() {}, lineCap: '', lineJoin: '', lineWidth: 1,
            strokeStyle: '', shadowColor: '', shadowBlur: 0
        });
        dom.window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };

        const scope = new dom.window.MusicStageRuntime.DisposableScope();
        const edge = dom.window.MusicStageEdge.create({
            app: {}, root,
            elements: { edgeSpectrum, edgeCanvas },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope, clamp: dom.window.MusicStageRuntime.clamp
        });
        const spectrum = new Float32Array(32).fill(0.5);
        const track = { path: '/a.flac' };
        edge.draw({ now: 100, isPlaying: true, audio: { spectrum, power: 0.4 }, viewport: { dpr: 1 }, track });
        const strips = [...edgeSpectrum.querySelectorAll('.music-stage-edge-spectrum-canvas')];
        assert.equal(strips.length, 4);
        for (const c of strips) {
            assert.ok(parseFloat(c.style.left) >= 0, 'clamped strip left >= 0 on narrow viewport');
            assert.ok(parseFloat(c.style.top) >= 0, 'clamped strip top >= 0 on narrow viewport');
            assert.ok(parseFloat(c.style.width) <= 30 && parseFloat(c.style.height) <= 30, 'clamped strip stays within viewport');
        }
        const readsAfterFirst = accentReads;
        // 10ms later in standard (30fps => 33.3ms): throttled BEFORE resolveAccent
        edge.draw({ now: 110, isPlaying: true, audio: { spectrum, power: 0.4 }, viewport: { dpr: 1 }, track });
        assert.equal(accentReads, readsAfterFirst, 'throttled playing frame skips resolveAccent');
        scope.destroy();

        // Interlude visualizer quantizes phase & power CSS vars
        const vis = dom.window.MusicStageRuntime.createInterludeVisualizer({ barCount: 20 });
        vis.update({ isPlaying: true, playbackTime: 1.23456789, audio: { spectrum, power: 0.456789 } }, { visible: true, intensity: 1 });
        assert.equal(vis.root.style.getPropertyValue('--interlude-phase'), '3.70deg');
        assert.equal(vis.root.style.getPropertyValue('--interlude-power'), '0.457');
        vis.destroy();

        // CSS reduced-motion & low-power rules
        const coreCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-core-modes.css'), 'utf8');
        assert.match(coreCss, /body\.music-fl-low\s+\.luminous-aura[\s\S]*?filter:\s*none;/);
        assert.match(coreCss, /body\.music-fl-low\s+\.luminous-line\.is-entering[\s\S]*?animation:\s*none;/);
        const pixiCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-pixi-3d.css'), 'utf8');
        assert.match(pixiCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.diorama-hud-circle-dashed[\s\S]*?animation:\s*none;/);
        assert.match(pixiCss, /body\.music-reduce-motion\s+\.music-stage-mode-diorama\s+\.diorama-hud-circle-dashed[\s\S]*?animation:\s*none;/);
        assert.match(pixiCss, /body\.music-fl-low\s+\.music-stage\.stage-theme-light\s+\.music-stage-settings-card[\s\S]*?backdrop-filter:\s*none;/);
    } finally {
        dom.window.close();
    }
});

test('Batch 60: stage slider input skips theme/mode-button rebuilds, debounces animationIntensity, and edge spectrum fast-paths settled paused frames', () => {
    const dom = createStageDom();
    try {
        const store = new Map();
        let storageWrites = 0;
        Object.defineProperty(dom.window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => { if (k === 'musicStageConfig') storageWrites += 1; store.set(k, String(v)); }
            }
        });
        for (const file of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }
        const { app } = createApp();
        const doc = dom.window.document;
        const settingsWrap = doc.createElement('div');
        settingsWrap.className = 'music-stage-settings';
        settingsWrap.innerHTML = `<button class="music-stage-settings-toggle" type="button"></button>
            <div class="music-stage-settings-card" hidden>
                <button class="music-stage-settings-close" type="button"></button>
                <p class="music-stage-current-mode-hint"></p>
                <div class="music-stage-mode-options"></div>
                <div class="music-stage-tuning-controls"></div>
                <div class="music-stage-common-controls"></div>
                <button class="music-stage-settings-reset" type="button"></button>
                <span class="music-stage-settings-status"></span>
            </div>`;
        doc.getElementById('music-stage').appendChild(settingsWrap);
        dom.window.setupMusicStage(app);
        app.stageHost.enter();
        const settingsBtn = doc.querySelector('.music-stage-settings-toggle');
        assert.ok(settingsBtn, 'settings toggle button mounted');
        settingsBtn.click();

        const firstModeBtn = doc.querySelector('.music-stage-mode-switcher button');
        assert.ok(firstModeBtn, 'mode switcher button mounted');
        const paletteBefore = app.stagePalette;
        assert.ok(paletteBefore, 'stagePalette computed on enter');

        // 拖动模式调优滑块不应重算主题，也不应重建模式切换按钮 DOM
        const tuningRange = doc.querySelector('[data-stage-config-type="range"]');
        assert.ok(tuningRange, 'mode tuning range slider rendered');
        tuningRange.value = String(Number(tuningRange.max));
        tuningRange.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.equal(app.stagePalette, paletteBefore, 'slider input does not recompute stagePalette');
        assert.equal(doc.querySelector('.music-stage-mode-switcher button'), firstModeBtn, 'slider input does not rebuild mode switcher DOM');

        // checkbox / select 控件仅监听 change，不因 input+change 双重触发
        const cfg = dom.window.MusicStageConfig;
        let patchCalls = 0;
        const unsubCfg = cfg.subscribe(() => { patchCalls += 1; });
        const tuningCheck = doc.querySelector('[data-stage-config-type="toggle"]');
        assert.ok(tuningCheck, 'mode tuning checkbox rendered');
        tuningCheck.checked = !tuningCheck.checked;
        tuningCheck.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        tuningCheck.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        assert.equal(patchCalls, 1, 'checkbox fires config update once on change, not twice on input+change');
        unsubCfg();

        // 动效强度滑块 input 走防抖持久化，change 立即落盘
        const intensitySlider = doc.querySelector('.music-stage-common-range');
        assert.ok(intensitySlider, 'animationIntensity slider rendered');
        storageWrites = 0;
        intensitySlider.value = '1.3';
        intensitySlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.equal(storageWrites, 0, 'animationIntensity input coalesces persistence via debounce');
        assert.equal(cfg.get().animationIntensity, 1.3);
        intensitySlider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        assert.equal(storageWrites, 1, 'animationIntensity change flushes to localStorage once');
        app.stageHost.destroy();
    } finally {
        dom.window.close();
    }

    // Edge spectrum: settled paused frame fast-paths unchanged accentRgb ref, release() skips already-1x1 strips
    const dom2 = createStageDom();
    try {
        runScript(dom2, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom2, 'Musicmodules/music-stage/music-stage-edge.js');
        const root = dom2.window.document.getElementById('music-stage');
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 800 });
        Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 500 });
        let accentCalls = 0;
        const accentRef = Object.freeze({ r: 40, g: 120, b: 220 });
        dom2.window.MusicStageModeUtils = {
            resolveAccent: () => { accentCalls += 1; return accentRef; }
        };
        dom2.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
            get(t, p) { return p in t ? t[p] : () => {}; },
            set(t, p, v) { t[p] = v; return true; }
        });
        const scope = new dom2.window.MusicStageRuntime.DisposableScope();
        const app2 = { stagePalette: { accentRgb: accentRef } };
        const edge = dom2.window.MusicStageEdge.create({
            app: app2, root, elements: { edgeSpectrum, edgeCanvas },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope, clamp: dom2.window.MusicStageRuntime.clamp
        });
        const silent = new Float32Array(32);
        edge.draw({ now: 1000, isPlaying: false, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        edge.draw({ now: 2600, isPlaying: false, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        const callsAtSettle = accentCalls;
        edge.draw({ now: 3000, isPlaying: false, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        edge.draw({ now: 3500, isPlaying: false, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(accentCalls, callsAtSettle, 'settled paused frames with unchanged accentRgb ref skip resolveAccent');

        // release() 后若再次 release()，已是 1x1 的画布不应重复赋值 width
        edge.release();
        let widthSets = 0;
        const wDesc = Object.getOwnPropertyDescriptor(dom2.window.HTMLCanvasElement.prototype, 'width');
        Object.defineProperty(edgeCanvas, 'width', {
            configurable: true,
            get() { return wDesc.get.call(this); },
            set(v) { widthSets += 1; wDesc.set.call(this, v); }
        });
        edge.release();
        assert.equal(widthSets, 0, 'release() skips reassigning width/height on already-1x1 strip canvas');
        scope.destroy();
    } finally {
        dom2.window.close();
    }
});

test('Batch 64: stage runtime monotonic line lookup & audio bands, host progress drag rect cache, sendLatest volume, slider flush, and canvas release', () => {
    const dom = createStageDom();
    try {
        const store = new Map();
        let storageWrites = 0;
        Object.defineProperty(dom.window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => { if (k === 'musicStageConfig') storageWrites += 1; store.set(k, String(v)); }
            }
        });
        for (const file of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }

        // 1. findActiveLineIndex monotonic fast path + seek backward/forward parity
        const R = dom.window.MusicStageRuntime;
        const lines = Array.from({ length: 10 }, (_, i) => ({ startTime: i * 5 + 2, text: `L${i}` }));
        assert.equal(R.findActiveLineIndex(lines, 1.0, -1), -1);
        assert.equal(R.findActiveLineIndex(lines, 2.5, -1), 0);
        assert.equal(R.findActiveLineIndex(lines, 4.9, 0), 0, 'same-line fast path');
        assert.equal(R.findActiveLineIndex(lines, 7.1, 0), 1, 'next-line fast path');
        assert.equal(R.findActiveLineIndex(lines, 49.0, 8), 9, 'last-line fast path');
        assert.equal(R.findActiveLineIndex(lines, 55.0, 9), 9, 'past-end stays on last line');
        assert.equal(R.findActiveLineIndex(lines, 13.0, 9), 2, 'backward seek falls back to binary search');
        assert.equal(R.findActiveLineIndex(lines, 0.5, 5), -1, 'seek before first line returns -1');

        // 2. resolveAudioBands tight slice loops (verify exact parity with averageRange slices)
        const spec = new Float32Array(100);
        for (let i = 0; i < 100; i += 1) spec[i] = i < 10 ? 1 : (i < 24 ? 0.5 : (i < 57 ? 0.25 : 0.1));
        const bands = R.resolveAudioBands(spec);
        assert.ok(Math.abs(bands.bass - 1) < 1e-6, `bass=${bands.bass}`);
        assert.ok(Math.abs(bands.lowMid - 0.5) < 1e-6, `lowMid=${bands.lowMid}`);
        assert.ok(Math.abs(bands.mid - 0.25) < 1e-6, `mid=${bands.mid}`);
        assert.ok(Math.abs(bands.treble - 0.1) < 1e-6, `treble=${bands.treble}`);
        assert.ok(bands.power > 0.3 && bands.power < 0.7);

        // 3. Stage host: progress drag caches rect, setVolume uses sendLatest, mode slider change flushes Config, destroy zeroes soft canvases
        const { app } = createApp();
        const sendLatestKeys = [];
        const volumeCalls = [];
        app.api.setMusicVolume = (v) => volumeCalls.push(v);
        app.sendLatest = (key, fn) => { sendLatestKeys.push(key); return fn(); };
        const doc = dom.window.document;
        const settingsWrap = doc.createElement('div');
        settingsWrap.className = 'music-stage-settings';
        settingsWrap.innerHTML = `<button class="music-stage-settings-toggle" type="button"></button>
            <div class="music-stage-settings-card" hidden>
                <button class="music-stage-settings-close" type="button"></button>
                <p class="music-stage-current-mode-hint"></p>
                <div class="music-stage-mode-options"></div>
                <div class="music-stage-tuning-controls"></div>
                <div class="music-stage-common-controls"></div>
                <button class="music-stage-settings-reset" type="button"></button>
                <span class="music-stage-settings-status"></span>
            </div>`;
        doc.getElementById('music-stage').appendChild(settingsWrap);
        dom.window.setupMusicStage(app);
        app.stageHost.enter();

        const track = doc.querySelector('.music-stage-progress-track');
        let rectReads = 0;
        track.getBoundingClientRect = () => { rectReads += 1; return { left: 0, right: 200, top: 0, bottom: 10, width: 200, height: 10 }; };
        track.setPointerCapture = () => {};
        const ptr = (type, x) => {
            const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
            Object.defineProperty(e, 'pointerId', { value: 3 });
            track.dispatchEvent(e);
        };
        ptr('pointerdown', 40);
        assert.equal(rectReads, 1, 'progress pointerdown reads bounding rect once');
        ptr('pointermove', 80);
        ptr('pointermove', 120);
        ptr('pointerup', 140);
        assert.equal(rectReads, 1, 'progress drag pointermove/pointerup reuse cached bounding rect');

        const volSlider = doc.querySelector('.music-stage-volume-slider');
        volSlider.value = '0.42';
        volSlider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.deepEqual(sendLatestKeys, ['volume'], 'stage volume routes through app.sendLatest');
        assert.equal(volumeCalls.length, 1);

        doc.querySelector('.music-stage-settings-toggle').click();
        const tuningRange = doc.querySelector('[data-stage-config-type="range"]');
        storageWrites = 0;
        tuningRange.value = String(Number(tuningRange.max));
        tuningRange.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        assert.equal(storageWrites, 0, 'mode range slider input debounces localStorage');
        tuningRange.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        assert.equal(storageWrites, 1, 'mode range slider change immediately flushes localStorage');

        const softCanvases = [...doc.querySelectorAll('.music-stage-backdrop-soft')];
        for (const c of softCanvases) { c.width = 64; c.height = 64; }
        app.stageHost.destroy();
        for (const c of softCanvases) {
            assert.equal(c.width, 0, 'destroy releases soft backdrop canvas width');
            assert.equal(c.height, 0, 'destroy releases soft backdrop canvas height');
        }
    } finally {
        dom.window.close();
    }
});

test('Batch 67: edge spectrum uses ResizeObserver contentRect without layout reads, skips duplicate static flat-line glow strokes, and pauses flow light when inactive', () => {
    const dom = createStageDom();
    try {
        let roCb = null;
        dom.window.ResizeObserver = class {
            constructor(cb) { roCb = cb; }
            observe() {}
            disconnect() {}
        };
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
        const root = dom.window.document.getElementById('music-stage');
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        if (!edgeSpectrum.querySelector('.music-stage-edge-flow')) {
            const flow = dom.window.document.createElement('div');
            flow.className = 'music-stage-edge-flow';
            edgeSpectrum.appendChild(flow);
        }
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        let clientReads = 0;
        Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => { clientReads += 1; return 800; } });
        Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => { clientReads += 1; return 500; } });
        let accent = Object.freeze({ r: 40, g: 120, b: 220 });
        dom.window.MusicStageModeUtils = { resolveAccent: () => accent };
        let strokes = 0;
        let clears = 0;
        dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
            get(t, p) {
                if (p === 'stroke') return () => { strokes += 1; };
                if (p === 'clearRect') return () => { clears += 1; };
                return p in t ? t[p] : () => {};
            },
            set(t, p, v) { t[p] = v; return true; }
        });
        const scope = new dom.window.MusicStageRuntime.DisposableScope();
        const app = { stagePalette: { accentRgb: accent } };
        const edge = dom.window.MusicStageEdge.create({
            app, root, elements: { edgeSpectrum, edgeCanvas },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope, clamp: dom.window.MusicStageRuntime.clamp
        });

        // Feed ResizeObserver contentRect directly -> 0 clientWidth/clientHeight reads
        roCb([{ contentRect: { width: 1000, height: 600 } }]);
        const silent = new Float32Array(32);
        edge.draw({ now: 1000, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(clientReads, 0, 'ResizeObserver contentRect avoids clientWidth/Height reflow');
        assert.equal(strokes, 8, 'initial flat frame draws 4 edges x 2 glow passes');
        assert.equal(clears, 4);

        // Subsequent identical silent frames while playing skip clearRect & stroke entirely
        edge.draw({ now: 1060, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        edge.draw({ now: 1120, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(strokes, 8, 'identical static flat frames skip redundant glow strokes');
        assert.equal(clears, 4, 'identical static flat frames skip redundant clearRect');

        // Resize via ResizeObserver updates canvas dimensions without reading clientWidth/Height and redraws once
        roCb([{ contentRect: { width: 1200, height: 700 } }]);
        edge.draw({ now: 1140, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(clientReads, 0, 'subsequent resize uses contentRect without DOM reflow');
        assert.equal(strokes, 16, 'resize invalidates lastFlatKey and redraws flat border');

        // Active motion draws normally, then returning to silence draws flat once and settles again
        const active = new Float32Array(32).fill(0.6);
        edge.draw({ now: 1200, isPlaying: true, audio: { spectrum: active, power: 0.5 }, viewport: { dpr: 1 } });
        assert.equal(strokes, 24, 'active spectrum frame strokes normally');
        edge.draw({ now: 1260, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(strokes, 32, 'returning to silence draws clean flat line once');
        edge.draw({ now: 1320, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(strokes, 32, 'subsequent flat frame settles again');

        // CSS rule pauses orbiting conic light whenever stage is not active
        const stageCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-pixi-3d.css'), 'utf8');
        assert.match(stageCss, /\.music-stage:not\(\.is-active\)\s+\.music-stage-edge-flow-light\s*\{[^}]*animation-play-state:\s*paused/);

        scope.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 71: edge spectrum skips clearRect/stroke per quiet strip when another strip moves and recovers immediately after empty spectrum', () => {
    const dom = createStageDom();
    try {
        let roCb = null;
        dom.window.ResizeObserver = class {
            constructor(cb) { roCb = cb; }
            observe() {}
            disconnect() {}
        };
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
        const root = dom.window.document.getElementById('music-stage');
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        if (!edgeSpectrum.querySelector('.music-stage-edge-flow')) {
            const flow = dom.window.document.createElement('div');
            flow.className = 'music-stage-edge-flow';
            edgeSpectrum.appendChild(flow);
        }
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        const accent = Object.freeze({ r: 40, g: 120, b: 220 });
        dom.window.MusicStageModeUtils = { resolveAccent: () => accent };
        let strokes = 0;
        let clears = 0;
        dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
            get(t, p) {
                if (p === 'stroke') return () => { strokes += 1; };
                if (p === 'clearRect') return () => { clears += 1; };
                return p in t ? t[p] : () => {};
            },
            set(t, p, v) { t[p] = v; return true; }
        });
        const scope = new dom.window.MusicStageRuntime.DisposableScope();
        const app = { stagePalette: { accentRgb: accent } };
        const edge = dom.window.MusicStageEdge.create({
            app, root, elements: { edgeSpectrum, edgeCanvas },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope, clamp: dom.window.MusicStageRuntime.clamp
        });

        roCb([{ contentRect: { width: 1000, height: 600 } }]);
        const silent = new Float32Array(64);
        // Frame 1: draw initial flat borders on all 4 edges (4 clears, 8 strokes)
        edge.draw({ now: 1000, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(clears, 4);
        assert.equal(strokes, 8);

        // Frame 2: energize only bin 0 so only the top strip (offset 0) moves while right/bottom/left stay flat at same power=0
        const partial = new Float32Array(64);
        partial[0] = 0.8;
        edge.draw({ now: 1060, isPlaying: true, audio: { spectrum: partial, power: 0 }, viewport: { dpr: 1 } });
        assert.ok(clears < 8, `quiet strips skip clearRect when only a subset moves (clears=${clears})`);
        assert.ok(strokes < 16, `quiet strips skip glow strokes when only a subset moves (strokes=${strokes})`);

        // Empty spectrum blanks strips; immediate next frame (within throttle window) must redraw without waiting 33ms
        edge.draw({ now: 1070, isPlaying: true, audio: { spectrum: [], power: 0 }, viewport: { dpr: 1 } });
        const clearsAfterBlank = clears;
        const strokesAfterBlank = strokes;
        edge.draw({ now: 1075, isPlaying: true, audio: { spectrum: silent, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(clears - clearsAfterBlank, 4, 'recovering from blank bypasses playing throttle and redraws all 4 edges');
        assert.equal(strokes - strokesAfterBlank, 8);

        scope.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 75: stageHost mirrors data-stage-mode without :has() CSS, runtime caches nextLines/wordState, and config skips no-op setModePatch', () => {
    const dom = createStageDom();
    try {
        let storageWrites = 0;
        const store = new Map();
        Object.defineProperty(dom.window, 'localStorage', {
            configurable: true,
            value: {
                getItem: (k) => (store.has(k) ? store.get(k) : null),
                setItem: (k, v) => { if (k === 'musicStageConfig') storageWrites += 1; store.set(k, String(v)); }
            }
        });
        for (const file of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }
        // 1. Runtime caches frozen nextLines & resolveWordState across identical frames
        const Runtime = dom.window.MusicStageRuntime;
        const { app } = createApp();
        app.isPlaying = false;
        app.lastKnownCurrentTime = 1.5;
        const f1 = Runtime.createFrame(app, 100);
        const f2 = Runtime.createFrame(app, 116);
        assert.equal(f1.nextLines, f2.nextLines, 'unchanged line index reuses cached nextLines array ref');
        assert.equal(Object.isFrozen(f1.nextLines), true);
        assert.equal(f1.wordStates, f2.wordStates, 'paused frame with identical line & playbackTime reuses cached wordStates');
        const emptyApp = { ...app, currentLyrics: [] };
        const e1 = Runtime.createFrame(emptyApp, 100);
        const e2 = Runtime.createFrame(emptyApp, 116);
        assert.equal(e1.wordStates, e2.wordStates, 'no-lyrics frames share frozen EMPTY_WORD_STATE');

        // 2. MusicStageConfig skips no-op setModePatch without notifying subscribers or scheduling storage writes
        const cfg = dom.window.MusicStageConfig;
        let notifies = 0;
        const unsub = cfg.subscribe(() => { notifies += 1; });
        const curGlow = cfg.get().modes.luminous.glow;
        storageWrites = 0;
        cfg.setModePatch('luminous', { glow: curGlow });
        assert.equal(notifies, 0, 'identical setModePatch skips subscriber notification');
        cfg.flush();
        assert.equal(storageWrites, 0, 'identical setModePatch skips localStorage persistence');
        unsub();

        // 3. Stage host mirrors data-stage-mode and stage-skin CSS drops .music-stage:has(...)
        const root = dom.window.document.getElementById('music-stage');
        dom.window.setupMusicStage(app);
        app.stageHost.enter();
        assert.equal(root.dataset.stageMode, app.stageHost.modeId, 'createMode sets root.dataset.stageMode');
        app.stageHost.destroy();
        assert.equal(root.dataset.stageMode, undefined, 'destroyMode clears root.dataset.stageMode');

        const stageSkinCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-stage-skin.css'), 'utf8');
        assert.equal(stageSkinCss.includes('.music-stage:has('), false, 'music-stage-skin.css drops .music-stage:has(...) selectors');
        assert.match(stageSkinCss, /\.music-stage\[data-stage-mode="diorama"\]/);
        assert.match(stageSkinCss, /\.music-stage\[data-stage-mode="tunnel"\]/);
    } finally {
        dom.window.close();
    }
});

test('Batch 76: Starborn updateFrame defers resolveSegment and nextLines reads until initial mount or cut', () => {
    const dom = createStageDom();
    try {
        for (const file of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }
        const host = dom.window.document.createElement('div');
        dom.window.document.body.appendChild(host);
        const starbornEntry = dom.window.MusicStageModes.get('starborn');
        assert.ok(starbornEntry, 'starborn mode registered');
        const cfg = dom.window.MusicStageConfig.get();
        const mode = starbornEntry.create(host, {
            config: cfg,
            app: { stagePalette: { accentRgb: { r: 200, g: 120, b: 80 } } }
        });
        let nextLinesReads = 0;
        const lines = [
            { startTime: 1, endTime: 5, fullText: 'First line', text: 'First line' },
            { startTime: 6, endTime: 10, fullText: 'Second line', text: 'Second line' }
        ];
        const mkFrame = (t, lineIdx) => {
            const f = {
                track: { path: 'a.flac', title: 'A' },
                lines,
                activeLine: lines[lineIdx],
                activeLineIndex: lineIdx,
                playbackTime: t,
                isPlaying: true,
                audio: { bass: 0.2, power: 0.3, onset: false, beat: false, spectrum: [] },
                viewport: { width: 800, height: 600, dpr: 1 }
            };
            Object.defineProperty(f, 'nextLines', {
                get() {
                    if ((new Error().stack || '').includes('resolveSegment')) nextLinesReads += 1;
                    return lines.slice(lineIdx + 1);
                }
            });
            return f;
        };
        // Initial mount reads nextLines via resolveSegment
        mode.updateFrame(mkFrame(1.05, 0));
        const readsAfterMount = nextLinesReads;
        assert.ok(readsAfterMount >= 1, 'initial mount resolves segment');
        // Steady frames within same line should NOT call resolveSegment or read nextLines
        mode.updateFrame(mkFrame(1.2, 0));
        mode.updateFrame(mkFrame(1.4, 0));
        mode.updateFrame(mkFrame(1.6, 0));
        assert.equal(nextLinesReads, readsAfterMount, 'steady frames skip resolveSegment and nextLines allocation');
        // Advance smoothly past transition lock without tripping jumpedForward (>0.5s), then cut at fresh line boundary
        for (let t = 2.0; t <= 5.8; t += 0.4) mode.updateFrame(mkFrame(t, 0));
        assert.equal(nextLinesReads, readsAfterMount, 'continuous playback within same line still skips resolveSegment');
        mode.updateFrame(mkFrame(6.05, 1));
        assert.ok(nextLinesReads > readsAfterMount, 'fresh line boundary cut invokes resolveSegment');
        mode.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 81: runtime caches frozen waiting/passed word templates & EMPTY_AUDIO_BANDS, stage-host fast-paths steady frame updates, and edge draws via hoisted drawSide', async () => {
    const dom = createStageDom();
    try {
        installCanvasStub(dom.window);
        for (const file of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }

        // 1. Runtime frozen word-state templates + shared EMPTY_AUDIO_BANDS
        const Runtime = dom.window.MusicStageRuntime;
        const line = Runtime.normalizeLines([{
            time: 0,
            endTime: 4,
            text: 'abcd',
            words: [
                { text: 'a', startTime: 0, endTime: 1 },
                { text: 'b', startTime: 1, endTime: 2 },
                { text: 'c', startTime: 2, endTime: 3 },
                { text: 'd', startTime: 3, endTime: 4 }
            ]
        }])[0];
        const s1 = Runtime.resolveWordState(line, 0.5);
        const s2 = Runtime.resolveWordState(line, 1.5);
        const s3 = Runtime.resolveWordState(line, 2.5);
        assert.equal(s1.wordStates[0].status, 'active');
        assert.equal(s1.wordStates[2].status, 'waiting');
        assert.equal(Object.isFrozen(s1.wordStates[2]), true, 'waiting word template is frozen');
        assert.equal(s1.wordStates[2], s2.wordStates[2], 'unchanged waiting word reuses cached template across frames');
        assert.equal(s1.wordStates[3], s2.wordStates[3], 'later waiting word reuses cached template');
        assert.equal(s2.wordStates[0].status, 'passed');
        assert.equal(Object.isFrozen(s2.wordStates[0]), true, 'passed word template is frozen');
        assert.equal(s2.wordStates[0], s3.wordStates[0], 'passed word reuses cached template on later frames');
        assert.equal(s1.wordStates[0].status, 'active', 'earlier active word snapshot remains unmutated');

        const bands1 = Runtime.resolveAudioBands(null);
        const bands2 = Runtime.resolveAudioBands(undefined);
        assert.equal(bands1, bands2, 'empty audio resolves to shared EMPTY_AUDIO_BANDS');
        assert.equal(Object.isFrozen(bands1), true, 'EMPTY_AUDIO_BANDS is frozen');

        // 2. Stage-host fast-paths steady progress/transport/audio/2D handover updates
        const root = dom.window.document.getElementById('music-stage');
        root.querySelector('.music-stage-backdrop-current').classList.add('music-stage-backdrop-layer');
        dom.window.localStorage.setItem('musicStageMode', 'luminous');
        const { app } = createApp();
        app.isPlaying = false;
        app.lastKnownCurrentTime = 1.5;
        app.lastKnownDuration = 180;
        app.currentVisualizerData = new Array(64).fill(0.4);
        dom.window.setupMusicStage(app);
        app.stageHost.enter();
        await wait(dom.window, 25);

        const backdrop = root.querySelector('.music-stage-backdrop-current');
        const progressFill = root.querySelector('.music-stage-progress-fill');
        const volumeSlider = root.querySelector('.music-stage-volume-slider');

        // First frame warms caches
        app.stageHost.updateFrame(1000);

        let backdropSetProps = 0;
        const origBackdropSet = backdrop.style.setProperty.bind(backdrop.style);
        backdrop.style.setProperty = (...args) => { backdropSetProps += 1; return origBackdropSet(...args); };

        let volumeSetProps = 0;
        const origVolSet = volumeSlider.style.setProperty.bind(volumeSlider.style);
        volumeSlider.style.setProperty = (...args) => { volumeSetProps += 1; return origVolSet(...args); };

        let progressWidthReadsOrWrites = 0;
        const fillStyleProxy = progressFill.style;
        const origSetProp = fillStyleProxy.setProperty.bind(fillStyleProxy);
        fillStyleProxy.setProperty = (...args) => { progressWidthReadsOrWrites += 1; return origSetProp(...args); };

        // Steady frames with unchanged playbackTime/duration/mode/volume/audio skip all redundant writes
        app.stageHost.updateFrame(1050);
        app.stageHost.updateFrame(1100);
        assert.equal(backdropSetProps, 0, 'unchanged audio levels skip writeAudioLevels CSS variable formatting & writes');
        assert.equal(volumeSetProps, 0, 'unchanged mode/volume skips updateTransportControls style writes');
        assert.equal(progressWidthReadsOrWrites, 0, 'unchanged playbackTime/duration skips updateProgress');

        // Changing audio level writes immediately again
        app.currentVisualizerData = new Array(64).fill(0.8);
        app.stageHost.updateFrame(1150);
        assert.ok(backdropSetProps > 0, 'changed audio level updates backdrop CSS variables');

        // Changing volume updates transport controls immediately
        app.volumeSlider.value = '0.5';
        app.stageHost.updateFrame(1200);
        assert.ok(volumeSetProps > 0, 'changed volume updates stage volume slider');

        app.stageHost.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 83: edge spectrum prefix-sum matches sliding average with zero-spectrum fast path and runtime caches all-waiting/all-passed word states + interlude LUT', () => {
    const dom = createStageDom();
    try {
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
        const accent = Object.freeze({ r: 60, g: 140, b: 220 });
        dom.window.MusicStageModeUtils = { resolveAccent: () => accent };
        const root = dom.window.document.getElementById('music-stage');
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        if (!edgeSpectrum.querySelector('.music-stage-edge-flow')) {
            const flow = dom.window.document.createElement('div');
            flow.className = 'music-stage-edge-flow';
            edgeSpectrum.appendChild(flow);
        }
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => 800 });
        Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 600 });

        let strokeCount = 0;
        let curvePoints = [];
        let clearCount = 0;
        const stubCtx = () => ({
            setTransform() {},
            clearRect() { clearCount += 1; },
            beginPath() {},
            moveTo() {},
            lineTo() {},
            quadraticCurveTo(cx, cy) { curvePoints.push([cx, cy]); },
            stroke() { strokeCount += 1; }
        });
        edgeCanvas.getContext = stubCtx;
        const origClone = edgeCanvas.cloneNode.bind(edgeCanvas);
        edgeCanvas.cloneNode = (deep) => {
            const c = origClone(deep);
            c.getContext = stubCtx;
            return c;
        };

        const scope = new dom.window.MusicStageRuntime.DisposableScope();
        const app = { stagePalette: { accentRgb: { r: 60, g: 140, b: 220 } } };
        const edge = dom.window.MusicStageEdge.create({
            app, root,
            elements: { edgeSpectrum, edgeCanvas },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope,
            clamp: dom.window.MusicStageRuntime.clamp
        });

        // 1. edge-flow-light carries aria-hidden="true"
        const flowLight = edgeSpectrum.querySelector('.music-stage-edge-flow-light');
        assert.ok(flowLight, 'edge-flow-light created');
        assert.equal(flowLight.getAttribute('aria-hidden'), 'true');

        // 2. Zero-spectrum fast path draws baseline once, skips repeated zero-spectrum frames
        const zeroSpec = new Float32Array(256);
        edge.draw({ now: 1000, isPlaying: true, track: { path: 'a' }, audio: { spectrum: zeroSpec, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(clearCount, 4, 'initial zero-spectrum draws flat baseline on all 4 strips');
        assert.equal(curvePoints.length, 0, 'zero-spectrum skips quadratic curves');
        edge.draw({ now: 1100, isPlaying: true, track: { path: 'a' }, audio: { spectrum: zeroSpec, power: 0 }, viewport: { dpr: 1 } });
        edge.draw({ now: 1200, isPlaying: true, track: { path: 'a' }, audio: { spectrum: zeroSpec, power: 0 }, viewport: { dpr: 1 } });
        assert.equal(clearCount, 4, 'subsequent unchanged zero-spectrum frames skip redundant strip redraws');

        // 3. Active spectrum draws curved edge points via prefix-sum lookup
        const activeSpec = new Float32Array(256).fill(0.6);
        edge.draw({ now: 1300, isPlaying: true, track: { path: 'a' }, audio: { spectrum: activeSpec, power: 0.6 }, viewport: { dpr: 1 } });
        assert.equal(clearCount, 8, 'active spectrum redraws all 4 strips');
        assert.ok(curvePoints.length > 50, 'active spectrum emits curved points');
        edge.release();
        scope.destroy();

        // 4. Runtime resolveWordState reuses frozen all-waiting and all-passed results with 0 new allocations
        const Runtime = dom.window.MusicStageRuntime;
        const line = Runtime.normalizeLines([{
            time: 10, endTime: 14, text: 'xy',
            words: [
                { text: 'x', startTime: 10.5, endTime: 11.5 },
                { text: 'y', startTime: 11.5, endTime: 13.0 }
            ]
        }])[0];
        const w1 = Runtime.resolveWordState(line, 10.0);
        const w2 = Runtime.resolveWordState(line, 10.2);
        assert.equal(w1, w2, 'all-waiting frames reuse identical frozen result object');
        assert.equal(Object.isFrozen(w1), true);
        assert.equal(w1.activeWordIndex, -1);
        assert.equal(w1.wordStates.every((w) => w.status === 'waiting'), true);

        const p1 = Runtime.resolveWordState(line, 13.1);
        const p2 = Runtime.resolveWordState(line, 13.8);
        assert.equal(p1, p2, 'all-passed frames reuse identical frozen result object');
        assert.equal(Object.isFrozen(p1), true);
        assert.equal(p1.wordStates.every((w) => w.status === 'passed'), true);

        // 5. createInterludeVisualizer prefix-sum + LUT updates bar scales accurately and handles silent spectrum
        const interlude = Runtime.createInterludeVisualizer({ barCount: 24 });
        dom.window.document.body.appendChild(interlude.root);
        interlude.update({ playbackTime: 1, isPlaying: true, audio: { spectrum: new Float32Array(128).fill(0.5), power: 0.5 } }, { visible: true });
        const bars = [...interlude.root.querySelectorAll('.stage-interlude-bars i')];
        assert.equal(bars.length, 24);
        const expectedScale = (0.28 + Math.pow(0.5, 0.72) * 0.72).toFixed(3);
        assert.match(bars[0].style.transform, new RegExp(`scaleY\\(${expectedScale.replace('.', '\\.')}\\)`));
        interlude.update({ playbackTime: 2, isPlaying: true, audio: { spectrum: new Float32Array(128), power: 0 } }, { visible: true });
        assert.match(bars[0].style.transform, /scaleY\(0\.280\)/, 'silent spectrum collapses bars to rest scale');
        interlude.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 87: refreshTheme batches probes & parses rgb() without canvas, stage-host avoids title offsetWidth reflow & playMode SVG thrash on volume drag', () => {
    const dom = createStageDom();
    try {
        let rafId = 1;
        const rafs = new Map();
        const cancelled = [];
        dom.window.requestAnimationFrame = (cb) => { const id = rafId++; rafs.set(id, cb); return id; };
        dom.window.cancelAnimationFrame = (id) => { cancelled.push(id); rafs.delete(id); };
        const flush = () => {
            const entries = [...rafs.entries()];
            rafs.clear();
            for (const [, cb] of entries) cb(dom.window.performance.now());
        };
        for (const file of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${file}`);
        }
        const doc = dom.window.document;
        const root = doc.getElementById('music-stage');

        // 1. refreshTheme attaches all 11 probes before any getComputedStyle read and fast-paths rgb() with 0 canvas creations
        let canvasCreates = 0;
        const origCreate = doc.createElement.bind(doc);
        doc.createElement = (tag, ...rest) => {
            if (String(tag).toLowerCase() === 'canvas') canvasCreates += 1;
            return origCreate(tag, ...rest);
        };
        const ops = [];
        const origAppend = root.appendChild.bind(root);
        root.appendChild = (node) => { ops.push(`append:${node.childNodes?.length || 0}`); return origAppend(node); };
        const origGcs = dom.window.getComputedStyle.bind(dom.window);
        dom.window.getComputedStyle = (el) => {
            if (el.tagName === 'SPAN' && el.style.color) {
                ops.push('gcs');
                return { color: el.style.color.includes('--highlight-text') ? 'rgb(10, 20, 30)' : 'rgba(40, 50, 60, 1)' };
            }
            return origGcs(el);
        };
        const probeApp = { currentTheme: 'dark' };
        const pal = dom.window.MusicStageModeUtils.refreshTheme(probeApp, root);
        doc.createElement = origCreate;
        root.appendChild = origAppend;
        dom.window.getComputedStyle = origGcs;

        assert.equal(canvasCreates, 0, 'opaque rgb()/rgba(...,1) computed colors skip canvas allocation entirely');
        assert.equal(ops[0], 'append:11', 'all 11 probe spans are appended together before any getComputedStyle read');
        assert.equal(ops.filter((o) => o === 'gcs').length, 11);
        assert.equal(pal.accent, '#0a141e');
        assert.deepEqual({ ...pal.accentRgb }, { r: 10, g: 20, b: 30 });
        assert.equal(pal.background, '#28323c');

        // 2. stageHost updateTrack uses cancellable rAF (0 offsetWidth reflows) & volume drag skips playMode.innerHTML rewrite
        const { app } = createApp();
        app.api.setMusicVolume = () => {};
        dom.window.setupMusicStage(app);
        app.stageHost.enter();
        flush();

        const titleEl = doc.querySelector('.music-stage-track-title');
        assert.equal(titleEl.classList.contains('is-changing'), true, 'enter sets initial is-changing class');
        let titleReflows = 0;
        Object.defineProperty(titleEl, 'offsetWidth', { configurable: true, get() { titleReflows += 1; return 120; } });
        app.stageHost.updateTrack({ path: '/t1.flac', title: 'Track 1', artist: 'A' });
        assert.equal(titleReflows, 0, 'consecutive track change avoids synchronous title.offsetWidth reflow');
        assert.equal(titleEl.classList.contains('is-changing'), false, 'consecutive track change clears class until next frame');
        flush();
        assert.equal(titleEl.classList.contains('is-changing'), true, 'next animation frame re-applies is-changing');

        // Cancelling on exit drops pending title rAF
        app.stageHost.updateTrack({ path: '/t2.flac', title: 'Track 2', artist: 'B' });
        const pendingBeforeExit = [...rafs.keys()];
        app.stageHost.exit();
        assert.ok(pendingBeforeExit.some((id) => cancelled.includes(id)), 'exiting stage cancels pending title animation rAF');

        // Re-enter to verify volume drag does not rewrite playMode.innerHTML
        app.stageHost.destroy();
        const dom2 = createStageDom();
        try {
            for (const file of [
                'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
                'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
                'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
                'music-stage-advanced-modes.js', 'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
            ]) {
                runScript(dom2, `Musicmodules/music-stage/${file}`);
            }
            const { app: app2 } = createApp();
            app2.api.setMusicVolume = () => {};
            dom2.window.setupMusicStage(app2);
            const playModeBtn = dom2.window.document.querySelector('[data-stage-action="play-mode"]');
            const volSlider = dom2.window.document.querySelector('.music-stage-volume-slider');
            let modeHtmlWrites = 0;
            const htmlDesc = Object.getOwnPropertyDescriptor(dom2.window.Element.prototype, 'innerHTML');
            Object.defineProperty(playModeBtn, 'innerHTML', {
                configurable: true,
                get() { return htmlDesc.get.call(this); },
                set(v) { modeHtmlWrites += 1; return htmlDesc.set.call(this, v); }
            });
            for (const v of ['0.8', '0.6', '0.4', '0.2']) {
                volSlider.value = v;
                volSlider.dispatchEvent(new dom2.window.Event('input', { bubbles: true }));
            }
            assert.equal(modeHtmlWrites, 0, 'volume slider drag does not rewrite playMode SVG innerHTML');

            // Cached band plan handles repeated calls and NaN entries safely
            const R = dom2.window.MusicStageRuntime;
            const noisy = [NaN, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
            const b1 = R.resolveAudioBands(noisy);
            const b2 = R.resolveAudioBands(noisy);
            assert.equal(b1.bass, b2.bass);
            assert.ok(Number.isFinite(b1.power) && b1.power > 0);
            app2.stageHost.destroy();
        } finally {
            dom2.window.close();
        }
    } finally {
        dom.window.close();
    }
});

test('Batch 89: edge spectrum skips sub-threshold work, reuses accentRef, releases even when blank, and interlude settles under reduced motion', () => {
    const dom = createStageDom();
    try {
        let strokeCalls = 0;
        dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
            if (type !== '2d') return null;
            return new Proxy({ stroke() { strokeCalls += 1; } }, {
                get(target, prop) { return prop in target ? target[prop] : () => {}; },
                set(target, prop, value) { target[prop] = value; return true; }
            });
        };
        for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const root = dom.window.document.getElementById('music-stage');
        Object.defineProperty(root, 'clientWidth', { value: 960 });
        Object.defineProperty(root, 'clientHeight', { value: 540 });
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        const accentRef = { r: 210, g: 120, b: 60 };
        const app = { stagePalette: { accentRgb: accentRef } };
        let resolveAccentCalls = 0;
        const origUtils = dom.window.MusicStageModeUtils;
        dom.window.MusicStageModeUtils = {
            ...origUtils,
            resolveAccent: (...args) => { resolveAccentCalls += 1; return origUtils.resolveAccent(...args); }
        };

        const state = { config: { quality: 'standard', edgeSpectrum: true } };
        const edge = dom.window.MusicStageEdge.create({
            app,
            root,
            elements: { edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'), edgeCanvas },
            state,
            scope: { add() {} },
            clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
        });

        // 1. Sub-threshold spectrum (all <= 0.025) draws flat once and skips subsequent unchanged frames
        const quiet = new Array(64).fill(0.01);
        edge.draw({ now: 1000, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0, spectrum: quiet } });
        assert.equal(strokeCalls, 8, 'initial quiet frame draws 4 flat strips');
        assert.equal(resolveAccentCalls, 1, 'initial frame resolves accent once');
        strokeCalls = 0;
        edge.draw({ now: 1100, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0, spectrum: quiet } });
        assert.equal(strokeCalls, 0, 'subsequent sub-threshold frame skips redrawing flat strips');
        assert.equal(resolveAccentCalls, 1, 'unchanged accentRgb reference skips resolveAccent on playing frames');

        // 2. Active frame followed by empty spectrum (blank=true) then edgeSpectrum=false STILL releases canvases to 1x1
        edge.draw({ now: 1200, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.5, spectrum: new Array(64).fill(0.5) } });
        assert.equal(edgeCanvas.width, 960);
        edge.draw({ now: 1300, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0, spectrum: [] } });
        state.config.edgeSpectrum = false;
        edge.draw({ now: 1400, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0, spectrum: [] } });
        assert.equal(edgeCanvas.width, 1, 'disabling edgeSpectrum while already blank still releases canvas backing store');
        assert.equal(edgeCanvas.height, 1);

        // 3. Interlude visualizer settles once under reduced motion while playing
        dom.window.matchMedia = () => ({ matches: true });
        const interlude = dom.window.MusicStageRuntime.createInterludeVisualizer({ barCount: 20 });
        const bars = interlude.root.querySelectorAll('.stage-interlude-bars i');
        let tfWrites = 0;
        const origSet = Object.getOwnPropertyDescriptor(dom.window.CSSStyleDeclaration.prototype, 'transform');
        bars.forEach((b) => {
            Object.defineProperty(b.style, 'transform', {
                configurable: true,
                get() { return origSet ? origSet.get.call(this) : ''; },
                set(v) { tfWrites += 1; if (origSet) origSet.set.call(this, v); }
            });
        });
        const playFrame = { playbackTime: 1, isPlaying: true, audio: { power: 0.5, spectrum: new Array(64).fill(0.5) } };
        interlude.update(playFrame, { visible: true, intensity: 1 });
        const afterFirst = tfWrites;
        assert.ok(afterFirst > 0);
        interlude.update({ ...playFrame, playbackTime: 2 }, { visible: true, intensity: 1 });
        assert.equal(tfWrites, afterFirst, 'reduced-motion playing interlude skips redundant bar loop after settling');
        interlude.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 90: paused stage CSS halts Starborn cue pulse and Diorama HUD spin animations', () => {
    const coreCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-core-modes.css'), 'utf8');
    const pixi3dCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stage/music-stage-pixi-3d.css'), 'utf8');
    assert.match(
        coreCss,
        /\.music-stage:not\(\.is-playing\)\s+\.starborn-director-cue:not\(\.is-switching\)\s*\{[^}]*animation-play-state:\s*paused/,
        'paused stage halts Starborn cue pulse without blocking switching cue'
    );
    assert.match(
        pixi3dCss,
        /\.music-stage:not\(\.is-playing\)\s+\.diorama-hud-circle-dashed\s*\{[^}]*animation-play-state:\s*paused/,
        'paused stage halts Diorama HUD ring spin'
    );
    assert.match(
        pixi3dCss,
        /body\.music-reduce-motion\s+\.music-stage-mode-diorama\s+\.diorama-hud-circle-dashed\s*\{[^}]*animation:\s*none/,
        'reduce-motion disables Diorama HUD ring spin'
    );
});

test('Batch 93: edge spectrum quantizes alpha to 8-bit precision and redraws cleanly after release()', () => {
    const dom = createStageDom();
    try {
        const strokeColors = [];
        dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
            if (type !== '2d') return null;
            let lastStyle = '';
            return new Proxy({
                set strokeStyle(v) { lastStyle = v; },
                get strokeStyle() { return lastStyle; },
                stroke() { strokeColors.push(lastStyle); }
            }, {
                get(target, prop) { return prop in target ? target[prop] : () => {}; },
                set(target, prop, value) { target[prop] = value; return true; }
            });
        };
        for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const root = dom.window.document.getElementById('music-stage');
        Object.defineProperty(root, 'clientWidth', { value: 960 });
        Object.defineProperty(root, 'clientHeight', { value: 540 });
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        const edge = dom.window.MusicStageEdge.create({
            app: { stagePalette: { accentRgb: { r: 20, g: 40, b: 60 } } },
            root,
            elements: { edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'), edgeCanvas },
            state: { config: { quality: 'standard', edgeSpectrum: true } },
            scope: { add() {} },
            clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
        });

        const spec = new Float32Array(64).fill(0.5);
        edge.draw({ now: 1000, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.51, spectrum: spec } });
        assert.equal(strokeColors.length, 8);
        const firstOuter = strokeColors[0];
        // Tiny power delta within the same 8-bit alpha bucket (both quantize to 152/255) reuses the cached rgba string
        edge.draw({ now: 1050, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.512, spectrum: spec } });
        assert.equal(strokeColors[8], firstOuter, '8-bit quantized alpha reuses cached rgba string');
        // Larger power jump crosses an 8-bit step and updates stroke color
        edge.draw({ now: 1100, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.95, spectrum: spec } });
        assert.notEqual(strokeColors[16], firstOuter, 'significant power shift updates edge stroke alpha');

        // release() drops cached buffers & shrinks strips to 1x1, then subsequent draw reallocates cleanly
        edge.release();
        assert.equal(edgeCanvas.width, 1);
        strokeColors.length = 0;
        edge.draw({ now: 2000, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.6, spectrum: spec } });
        assert.equal(edgeCanvas.width, 960, 'edge reallocates cleanly after release()');
        assert.equal(strokeColors.length, 8);
    } finally {
        dom.window.close();
    }
});

test('Batch 100: edge spectrum uses integer flat signatures, detects DPR change & caches visualizerColor; runtime quantizes interlude bars; config skips no-op mode patch', () => {
    const dom = createStageDom();
    try {
        let strokeCalls = 0;
        dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
            if (type !== '2d') return null;
            return new Proxy({ stroke() { strokeCalls += 1; } }, {
                get(target, prop) { return prop in target ? target[prop] : () => {}; },
                set(target, prop, value) { target[prop] = value; return true; }
            });
        };
        for (const dep of ['music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const root = dom.window.document.getElementById('music-stage');
        Object.defineProperty(root, 'clientWidth', { value: 960 });
        Object.defineProperty(root, 'clientHeight', { value: 540 });
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        const visColor = { r: 80, g: 160, b: 240 };
        const app = { visualizerColor: visColor };
        let resolveAccentCalls = 0;
        const origUtils = dom.window.MusicStageModeUtils;
        dom.window.MusicStageModeUtils = {
            ...origUtils,
            resolveAccent: (...args) => { resolveAccentCalls += 1; return origUtils.resolveAccent(...args); }
        };
        const state = { config: { quality: 'standard', edgeSpectrum: true } };
        const edge = dom.window.MusicStageEdge.create({
            app,
            root,
            elements: { edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'), edgeCanvas },
            state,
            scope: { add() {} },
            clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
        });

        const quiet = new Float32Array(64);
        edge.draw({ now: 1000, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0, spectrum: quiet } });
        assert.equal(resolveAccentCalls, 1);
        assert.equal(edgeCanvas.width, 960);
        assert.equal(strokeCalls, 8);

        // Unchanged visualizerColor + quiet spectrum skips resolveAccent and flat redraw
        strokeCalls = 0;
        edge.draw({ now: 1100, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0, spectrum: quiet } });
        assert.equal(resolveAccentCalls, 1, 'unchanged visualizerColor skips resolveAccent');
        assert.equal(strokeCalls, 0, 'integer flat signature skips redundant quiet redraw');

        // DPR change triggers resize even within throttle window
        edge.draw({ now: 1110, isPlaying: true, viewport: { dpr: 1.5 }, audio: { power: 0, spectrum: quiet } });
        assert.equal(edgeCanvas.width, 1440, 'viewport DPR change triggers immediate strip resize');
        assert.equal(strokeCalls, 8, 'resize redraws flat strips at new DPR');

        // In-place mutation of visualizerColor invalidates accent cache and redraws flat strips
        visColor.r = 250;
        strokeCalls = 0;
        edge.draw({ now: 1200, isPlaying: true, viewport: { dpr: 1.5 }, audio: { power: 0, spectrum: quiet } });
        assert.equal(resolveAccentCalls, 2, 'mutated visualizerColor triggers resolveAccent');
        assert.equal(strokeCalls, 8, 'color change invalidates flat signature and redraws');

        // Runtime: normalizeLines fallback words + vocalEndTime, and interlude quantized bar updates
        const R = dom.window.MusicStageRuntime;
        const norm = R.normalizeLines([{ time: 1, endTime: 4, fullText: 'A B' }]);
        assert.equal(norm[0].resolvedWords.length, 3);
        assert.ok(norm[0].vocalEndTime >= 4);
        const interlude = R.createInterludeVisualizer({ barCount: 20 });
        const bar0 = interlude.root.querySelector('.stage-interlude-bars i');
        let tfWrites = 0;
        const origTf = Object.getOwnPropertyDescriptor(dom.window.CSSStyleDeclaration.prototype, 'transform');
        Object.defineProperty(bar0.style, 'transform', {
            configurable: true,
            get() { return origTf ? origTf.get.call(this) : ''; },
            set(v) { tfWrites += 1; if (origTf) origTf.set.call(this, v); }
        });
        const spec = new Float32Array(64).fill(0.5);
        interlude.update({ playbackTime: 1, isPlaying: true, audio: { power: 0.5, spectrum: spec } }, { visible: true, intensity: 1 });
        assert.equal(tfWrites, 1);
        interlude.update({ playbackTime: 1.001, isPlaying: true, audio: { power: 0.5, spectrum: spec } }, { visible: true, intensity: 1 });
        assert.equal(tfWrites, 1, 'quantized interlude bar skips redundant transform write on identical spectrum');
        interlude.destroy();

        // Config: setModePatch skips no-op listener notify & toggleMode preserves order
        const cfg = dom.window.MusicStageConfig;
        let notifies = 0;
        const unsub = cfg.subscribe(() => { notifies += 1; });
        const curGlow = cfg.get().modes.luminous.glow;
        cfg.setModePatch('luminous', { glow: curGlow });
        assert.equal(notifies, 0, 'no-op setModePatch skips notify');
        cfg.setModePatch('luminous', { glow: curGlow === 1 ? 1.5 : 1 });
        assert.equal(notifies, 1, 'changed setModePatch notifies subscribers once');
        cfg.toggleMode('fume', false);
        assert.equal(cfg.get().enabledModes.includes('fume'), false);
        cfg.toggleMode('fume', true);
        assert.equal(cfg.get().enabledModes.includes('fume'), true);
        unsub();
        edge.release();
    } finally {
        dom.window.close();
    }
});

test('Batch 101: stage host quantizes 4-decimal audio CSS vars and avoids body.focus() on settings close', async () => {
    const dom = createStageDom();
    try {
        installCanvasStub(dom.window);
        // Add settings DOM nodes matching music.html
        const root = dom.window.document.getElementById('music-stage');
        const settingsWrap = dom.window.document.createElement('div');
        settingsWrap.className = 'music-stage-settings';
        settingsWrap.innerHTML = '<button class="music-stage-settings-toggle" type="button">调参</button>'
            + '<div class="music-stage-settings-card" hidden><button class="music-stage-settings-close" type="button">关</button>'
            + '<div class="music-stage-tuning-controls"></div><div class="music-stage-common-controls"></div>'
            + '<div class="music-stage-mode-options"></div><button class="music-stage-settings-reset" type="button">重置</button>'
            + '<span class="music-stage-settings-status"></span></div>';
        root.appendChild(settingsWrap);

        for (const dep of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'modes/tempera-manager.js', 'modes/sonnet-manager.js', 'modes/diorama-manager.js',
            'modes/fume-manager.js', 'music-stage-advanced-modes.js',
            'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const { app } = createApp();
        app.currentVisualizerData = new Array(64).fill(0.5);
        dom.window.setupMusicStage(app);
        app.stageHost.enter();
        await wait(dom.window, 20);

        const cover = root.querySelector('.music-stage-cover');
        const powerWrites = [];
        const origSetProp = cover.style.setProperty.bind(cover.style);
        cover.style.setProperty = (k, v, ...rest) => {
            if (k === '--stage-audio-power') powerWrites.push(v);
            return origSetProp(k, v, ...rest);
        };

        // Change audio to 0.6 -> writes once; tiny delta (< 0.00004) in same 4-decimal bucket skips; 0.95 updates
        app.currentVisualizerData = new Array(64).fill(0.6);
        app.stageHost.updateFrame(1000);
        const afterFirst = powerWrites.length;
        assert.ok(afterFirst >= 1, 'initial frame writes --stage-audio-power');
        app.currentVisualizerData = new Array(64).fill(0.60001);
        app.stageHost.updateFrame(1100);
        assert.equal(powerWrites.length, afterFirst, 'sub-0.0001 audio delta skips redundant CSS var setProperty');
        app.currentVisualizerData = new Array(64).fill(0.95);
        app.stageHost.updateFrame(1200);
        assert.ok(powerWrites.length > afterFirst, 'significant audio delta updates --stage-audio-power');

        // Opening settings from document.body and closing never calls body.focus()
        const doc = dom.window.document;
        let bodyFocused = 0;
        const origBodyFocus = doc.body.focus.bind(doc.body);
        doc.body.focus = (...args) => { bodyFocused += 1; return origBodyFocus(...args); };
        doc.activeElement?.blur?.();
        root.querySelector('.music-stage-settings-toggle').click();
        assert.equal(root.querySelector('.music-stage-settings-card').hidden, false);
        root.querySelector('.music-stage-settings-close').click();
        assert.equal(root.querySelector('.music-stage-settings-card').hidden, true);
        assert.equal(bodyFocused, 0, 'closing stage settings never calls body.focus()');

        app.stageHost.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 103: stage host marks non-range tuning rows with .is-value-hidden without :has(), and player playFromContext/reorderContext single-pass works', async () => {
    const skinCss = read('Musicmodules/music-theme/music-stage-skin.css');
    assert.doesNotMatch(skinCss, /\.music-stage-tuning-row:has\(/, 'stage-skin drops tuning-row :has() selectors');
    assert.match(skinCss, /\.music-stage-tuning-row\.is-value-hidden\s+\.music-stage-tuning-value\s*\{\s*display:\s*none;\s*\}/);

    const dom = createStageDom();
    try {
        installCanvasStub(dom.window);
        const root = dom.window.document.getElementById('music-stage');
        const settingsWrap = dom.window.document.createElement('div');
        settingsWrap.className = 'music-stage-settings';
        settingsWrap.innerHTML = '<button class="music-stage-settings-toggle" type="button">调参</button>'
            + '<div class="music-stage-settings-card" hidden><button class="music-stage-settings-close" type="button">关</button>'
            + '<div class="music-stage-tuning-controls"></div><div class="music-stage-common-controls"></div>'
            + '<div class="music-stage-mode-options"></div><button class="music-stage-settings-reset" type="button">重置</button>'
            + '<span class="music-stage-settings-status"></span></div>';
        root.appendChild(settingsWrap);
        for (const dep of [
            'music-stage-runtime.js', 'music-stage-config.js', 'modes/stage-mode-utils.js',
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'modes/tempera-manager.js', 'modes/sonnet-manager.js', 'modes/diorama-manager.js',
            'modes/fume-manager.js', 'music-stage-advanced-modes.js',
            'music-stage-modes.js', 'music-stage-edge.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const { app } = createApp();
        dom.window.setupMusicStage(app);
        const toggleRows = [...root.querySelectorAll('.music-stage-tuning-controls .music-stage-tuning-row')].filter((r) => r.querySelector('input[type="checkbox"], select'));
        const rangeRows = [...root.querySelectorAll('.music-stage-tuning-controls .music-stage-tuning-row')].filter((r) => r.querySelector('input[type="range"]'));
        assert.ok(toggleRows.length > 0 && rangeRows.length > 0);
        assert.ok(toggleRows.every((r) => r.classList.contains('is-value-hidden')), 'toggle/select tuning rows get .is-value-hidden');
        assert.ok(rangeRows.every((r) => !r.classList.contains('is-value-hidden')), 'range tuning rows keep value visible');

        runScript(dom, 'Musicmodules/music-app-hooks.js');
        runScript(dom, 'Musicmodules/music-player.js');
        const t1 = { path: '/1.flac', title: '1' };
        const t2 = { path: '/2.flac', title: '2' };
        const t3 = { path: '/3.flac', title: '3' };
        const pApp = {
            playlist: [t1, t2, t3], currentTrackIndex: 0, playModes: ['repeat', 'repeat-one', 'shuffle'], currentPlayMode: 0,
            api: {}
        };
        dom.window.setupPlayer(pApp);
        pApp.loadTrack = async () => true;
        await pApp.playFromContext([t1, t2, t3], 0, { origin: 'classic', render: false, play: false });
        assert.equal(pApp.currentFilteredTracks, null, 'full-library order stores null filtered context');
        assert.equal(pApp.reorderContext([t1, t2, t3], 'classic'), false, 'unchanged order returns false');
        assert.equal(pApp.reorderContext([t3, t2, t1], 'classic'), true, 'valid permutation updates context');
        assert.deepEqual(pApp.currentFilteredTracks, [t3, t2, t1]);
        assert.equal(pApp.reorderContext([t1, t2, t3], 'classic'), true, 'restoring library order clears filtered context back to null');
        assert.equal(pApp.currentFilteredTracks, null);
        assert.equal(pApp.reorderContext([t1, t2, { path: '/x.flac' }], 'classic'), false, 'foreign track rejected');

        app.stageHost.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 108: stage-edge strips cloned canvas id & caches default accent, and stage-runtime buildGlyphTimeline aligns syllables/punctuation', () => {
    const dom = createStageDom();
    try {
        installCanvasStub(dom.window);
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/modes/stage-mode-utils.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');

        const root = dom.window.document.getElementById('music-stage');
        Object.defineProperty(root, 'clientWidth', { value: 1200, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        edgeCanvas.id = 'edge-strip-main';

        let resolveAccentCalls = 0;
        const origUtils = dom.window.MusicStageModeUtils;
        dom.window.MusicStageModeUtils = { ...origUtils, resolveAccent: (a) => { resolveAccentCalls += 1; return origUtils.resolveAccent(a); } };

        const app = {}; // neither stagePalette nor visualizerColor -> default accent
        const state = { config: { edgeSpectrum: true, quality: 'energy-saving' } };
        const scope = new dom.window.MusicStageRuntime.DisposableScope();
        const edge = dom.window.MusicStageEdge.create({
            app, root, elements: { edgeSpectrum, edgeCanvas }, state, scope,
            clamp: dom.window.MusicStageRuntime.clamp
        });
        const canvases = [...edgeSpectrum.querySelectorAll('canvas')];
        assert.equal(canvases.length, 4);
        assert.equal(edgeSpectrum.querySelectorAll('#edge-strip-main').length, 1, 'cloned edge canvases strip duplicate id');

        const activeSpec = new Float32Array(64).fill(0.5);
        edge.draw({ now: 1000, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.5, spectrum: activeSpec } });
        assert.equal(resolveAccentCalls, 1, 'initial frame resolves default accent once');
        edge.draw({ now: 1200, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.6, spectrum: activeSpec } });
        edge.draw({ now: 1400, isPlaying: true, viewport: { dpr: 1 }, audio: { power: 0.4, spectrum: activeSpec } });
        assert.equal(resolveAccentCalls, 1, 'subsequent frames without stagePalette/visualizerColor reuse cached default accent');
        edge.release();
        scope.destroy();

        // Runtime: normalizeLines + buildGlyphTimeline with syllables and untimed spaces/punctuation
        const R = dom.window.MusicStageRuntime;
        const lines = R.normalizeLines([{
            time: 10,
            endTime: 14,
            fullText: 'Hi, world!',
            words: [
                { text: 'Hi', startTime: 10, endTime: 11, syllables: [{ text: 'H', startTime: 10, endTime: 10.4 }, { text: 'i', startTime: 10.4, endTime: 11 }] },
                { text: 'world', startTime: 12, endTime: 13.5 }
            ]
        }]);
        const glyphs = R.buildGlyphTimeline(lines[0]);
        assert.equal(glyphs.map((g) => g.text).join(''), 'Hi, world!');
        assert.equal(glyphs[0].syllableIndex, 0);
        assert.equal(glyphs[1].syllableIndex, 1);
        assert.equal(glyphs[2].text, ',');
        assert.equal(glyphs[2].startTime, 12, 'punctuation between words aligns to next word startTime');
        assert.equal(glyphs[glyphs.length - 1].text, '!');
        assert.equal(glyphs[glyphs.length - 1].startTime, 13.5, 'trailing punctuation aligns to last glyph endTime');

        // Batch 109: Starborn director precomputed candidate IDs, single-pass chooseMode, and clean Set teardown
        const stubMode = (id) => ({
            create(container) {
                let destroyed = false;
                return {
                    updateFrame() {},
                    updateConfig() {},
                    resize() {},
                    updateTheme() {},
                    suspend() {},
                    resume() {},
                    getDebugSnapshot() { return { id, destroyed }; },
                    destroy() { destroyed = true; container.dataset.destroyed = '1'; }
                };
            }
        });
        dom.window.MusicStageLuminousManager = stubMode('luminous');
        dom.window.MusicStagePartitaManager = stubMode('partita');
        dom.window.MusicStageCadenzaManager = stubMode('cadenza');
        runScript(dom, 'Musicmodules/music-stage/music-stage-modes.js');
        const starHost = dom.window.document.createElement('div');
        dom.window.document.body.appendChild(starHost);
        const star = dom.window.MusicStageModes.create('starborn', starHost, { config: { quality: 'standard', modes: { starborn: { transitionLock: 1, avoidRepeat: true } } } });
        const mkLine = (t, text) => ({ time: t, startTime: t, endTime: t + 2, vocalEndTime: t + 2, fullText: text, words: [{ text, startTime: t, endTime: t + 2, syllables: [] }], isChorus: true });
        const l1 = mkLine(1, 'First line!');
        const l2 = mkLine(5, 'Second line? Yes!');
        const starLines = [l1, l2];
        star.updateFrame({ playbackTime: 1.02, isPlaying: true, track: { path: '/s.flac' }, lines: starLines, activeLine: l1, nextLines: [l2], audio: { vocal: 0.7, bass: 0.6, power: 0.5 } });
        const snap1 = star.getDebugSnapshot();
        assert.equal(snap1.children, 1);
        assert.ok(['luminous', 'partita', 'cadenza'].includes(snap1.directedMode));
        for (let pt = 1.4; pt < 5.0; pt += 0.4) {
            star.updateFrame({ playbackTime: pt, isPlaying: true, track: { path: '/s.flac' }, lines: starLines, activeLine: pt < 3 ? l1 : null, nextLines: [l2], audio: { vocal: 0.3, bass: 0.2, power: 0.2 } });
        }
        star.updateFrame({ playbackTime: 5.02, isPlaying: true, track: { path: '/s.flac' }, lines: starLines, activeLine: l2, nextLines: [], audio: { vocal: 0.3, bass: 0.2, power: 0.2 } });
        const snap2 = star.getDebugSnapshot();
        assert.notEqual(snap2.directedMode, snap1.directedMode, 'avoidRepeat picks a different mode on fresh line cut');
        assert.equal(snap2.transitionCount, 2);
        star.destroy();
        assert.equal(star.getDebugSnapshot().children, 0, 'destroy releases all active and retiring Starborn children');
    } finally {
        dom.window.close();
    }
});

test('Batch 111: stage edge renders Rec.709 mono luma when --stage-edge-mono: 1 is set and preserves corner endpoints across fixed-axis cache frames', () => {
    const dom = createStageDom();
    try {
        const strokes = [];
        const pointsLog = [];
        dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
            if (type !== '2d') return null;
            let strokeStyle = '';
            return new Proxy({
                get strokeStyle() { return strokeStyle; },
                set strokeStyle(v) { strokeStyle = v; },
                moveTo(x, y) { pointsLog.push(['M', x, y]); },
                lineTo(x, y) { pointsLog.push(['L', x, y]); },
                stroke() { strokes.push(strokeStyle); }
            }, {
                get(target, prop) { return prop in target ? target[prop] : () => {}; },
                set(target, prop, value) { target[prop] = value; return true; }
            });
        };
        const origCS = dom.window.getComputedStyle.bind(dom.window);
        dom.window.getComputedStyle = (el) => {
            const st = origCS(el);
            return new Proxy(st, {
                get(target, prop) {
                    if (prop === 'getPropertyValue') {
                        return (name) => (name === '--stage-edge-mono' ? '1' : target.getPropertyValue(name));
                    }
                    const v = target[prop];
                    return typeof v === 'function' ? v.bind(target) : v;
                }
            });
        };
        for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const root = dom.window.document.getElementById('music-stage');
        Object.defineProperty(root, 'clientWidth', { value: 1200, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        const scope = new dom.window.MusicStageRuntime.DisposableScope();
        const edge = dom.window.MusicStageEdge.create({
            app: { stagePalette: { accentRgb: { r: 200, g: 100, b: 50 } } },
            root,
            elements: {
                edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'),
                edgeCanvas: root.querySelector('.music-stage-edge-spectrum-canvas')
            },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope,
            clamp: dom.window.MusicStageRuntime.clamp
        });
        const spec = new Float32Array(64).fill(0.5);
        edge.draw({ now: 100, isPlaying: true, track: { path: '/a.flac' }, viewport: { dpr: 1 }, audio: { spectrum: spec, power: 0.6 } });
        // Rec.709: round(0.2126*200 + 0.7152*100 + 0.0722*50) = round(117.65) = 118
        assert.ok(strokes.some((s) => s.startsWith('rgba(118, 118, 118,')), `mono mode draws Rec.709 luma rgba(118,118,118,...), got: ${strokes[0]}`);
        // Second active frame reuses cached fixed-axis coordinates without losing endpoints
        const firstFrameMoves = pointsLog.slice(0, 2);
        pointsLog.length = 0;
        edge.draw({ now: 160, isPlaying: true, track: { path: '/a.flac' }, viewport: { dpr: 1 }, audio: { spectrum: spec, power: 0.7 } });
        assert.deepEqual(pointsLog.slice(0, 2), firstFrameMoves, 'second active frame preserves exact top-edge corner coordinates via cached fixed axis');
        edge.release();
        scope.destroy();
    } finally {
        dom.window.close();
    }
});

test('Batch 115: stage edge preserves fixed-axis endpoints across active->silent->active transitions and tolerates missing scope with ResizeObserver', () => {
    const dom = createStageDom();
    try {
        const pointsLog = [];
        dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
            if (type !== '2d') return null;
            return new Proxy({
                moveTo(x, y) { pointsLog.push(['M', Math.round(x * 100) / 100, Math.round(y * 100) / 100]); },
                lineTo(x, y) { pointsLog.push(['L', Math.round(x * 100) / 100, Math.round(y * 100) / 100]); }
            }, {
                get(target, prop) { return prop in target ? target[prop] : () => {}; },
                set(target, prop, value) { target[prop] = value; return true; }
            });
        };
        let roCallback = null;
        dom.window.ResizeObserver = class {
            constructor(cb) { roCallback = cb; }
            observe() {}
            disconnect() {}
        };
        for (const dep of ['music-stage-runtime.js', 'modes/stage-mode-utils.js', 'music-stage-edge.js']) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const root = dom.window.document.getElementById('music-stage');
        Object.defineProperty(root, 'clientWidth', { value: 1200, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        // Pass scope: null while ResizeObserver exists -> must not throw
        const edge = dom.window.MusicStageEdge.create({
            app: { stagePalette: { accentRgb: { r: 120, g: 180, b: 220 } } },
            root,
            elements: {
                edgeSpectrum: root.querySelector('.music-stage-edge-spectrum'),
                edgeCanvas: root.querySelector('.music-stage-edge-spectrum-canvas')
            },
            state: { config: { edgeSpectrum: true, quality: 'standard' } },
            scope: null,
            clamp: dom.window.MusicStageRuntime.clamp
        });
        assert.equal(typeof roCallback, 'function');
        roCallback([{ contentRect: { width: 1200, height: 800 } }]);
        const activeSpec = new Float32Array(64).fill(0.5);
        const quietSpec = new Float32Array(64);
        edge.draw({ now: 100, isPlaying: true, track: { path: '/a.flac' }, viewport: { dpr: 1 }, audio: { spectrum: activeSpec, power: 0.6 } });
        const activeEnds = pointsLog.slice(0, 8);
        assert.equal(activeEnds.length, 8);
        // Transition to silent flat line
        pointsLog.length = 0;
        edge.draw({ now: 160, isPlaying: true, track: { path: '/a.flac' }, viewport: { dpr: 1 }, audio: { spectrum: quietSpec, power: 0 } });
        assert.equal(pointsLog.length, 8, 'flat frame draws 4 straight segments');
        // Resume active audio -> fixed-axis coordinates remain intact without repopulating errors
        pointsLog.length = 0;
        edge.draw({ now: 220, isPlaying: true, track: { path: '/a.flac' }, viewport: { dpr: 1 }, audio: { spectrum: activeSpec, power: 0.6 } });
        assert.deepEqual(pointsLog.slice(0, 8), activeEnds, 'resumed active frame preserves exact endpoints after flat frame');
        edge.release();
    } finally {
        dom.window.close();
    }
});

test('Batch 119: stage runtime splitGraphemes ASCII/emoji, clamp01 Infinity/NaN, frozen viewport cache, and lyrics parseLrc scriptOf & pctQ reset on seek', () => {
    const dom = createStageDom();
    try {
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-config.js');
        const rt = dom.window.MusicStageRuntime;
        // 1. splitGraphemes ASCII fast path & Unicode grapheme clusters
        assert.deepEqual(Array.from(rt.splitGraphemes('Hello!')), ['H', 'e', 'l', 'l', 'o', '!']);
        assert.deepEqual(Array.from(rt.splitGraphemes('')), []);
        assert.deepEqual(Array.from(rt.splitGraphemes('A\r\nB')), ['A', '\r\n', 'B']);
        // 2. resolveAudioBands & createAudioOnset treat NaN/Infinity as 0 (matching clamp)
        const bands = rt.resolveAudioBands([0.5, NaN, Infinity, -0.2, 1.5, 0.4, 0.3, 0.2, 0.1, 0.5]);
        assert.ok(bands.bass >= 0 && bands.bass <= 1 && Number.isFinite(bands.power));
        const onset = rt.createAudioOnset();
        const st = onset.update({ playbackTime: 0.1, isPlaying: true, lines: [], audio: { power: 0.5, spectrum: [Infinity, NaN, -1, 0.8, 2] } });
        assert.ok(Number.isFinite(st.energy) && Number.isFinite(st.impact));
        // 3. createFrame reuses frozen viewport reference across unchanged frames
        const f1 = rt.createFrame({ currentLyrics: [], playlist: [], currentTrackIndex: -1 }, 100);
        const f2 = rt.createFrame({ currentLyrics: [], playlist: [], currentTrackIndex: -1 }, 116);
        assert.equal(f1.viewport, f2.viewport, 'unchanged viewport object is reused across frames');
        assert.equal(Object.isFrozen(f1.viewport), true);

        // 4. music-lyrics parseLrc scriptOf single-pass priority & word pctQ reset on seek-back
        runScript(dom, 'Musicmodules/music-lyrics.js');
        const ul = dom.window.document.createElement('ul');
        const box = dom.window.document.createElement('div');
        box.appendChild(ul);
        dom.window.document.body.appendChild(box);
        const lApp = {
            lyricsList: ul,
            lyricsContainer: box,
            lyricSpeedFactor: 1,
            lyricOffset: 0,
            playlist: [],
            currentTrackIndex: -1,
            currentLyrics: [],
            isPlaying: true,
            isTrackLoading: false,
            lastKnownCurrentTime: 0,
            lastStateUpdateTime: Date.now()
        };
        dom.window.setupLyrics(lApp);
        // Japanese line containing both Han and Kana pairs with Chinese translation within 0.3s
        const parsed = lApp.parseLrc('[00:01.00]星空の夜\n[00:01.30]星空的夜晚\n[00:05.00]Hello\n[00:05.20]World');
        assert.equal(parsed.length, 3, 'kana+han merges with han translation, latin+latin stays separate');
        assert.equal(parsed[0].original, '星空の夜');
        assert.equal(parsed[0].translation, '星空的夜晚');
        // Word-by-word pctQ resets after finished -> seek back to exact same 50% progress rewrites --word-progress
        lApp.currentLyrics = [{
            time: 0, startTime: 0, endTime: 4, original: 'AB', isWordByWord: true,
            words: [{ text: 'A', startTime: 0, endTime: 2 }, { text: 'B', startTime: 2, endTime: 4 }]
        }];
        lApp.renderLyrics();
        const w0 = ul.querySelector('.lyric-word');
        lApp.lastKnownCurrentTime = 1.0; lApp.lastStateUpdateTime = Date.now(); lApp.animateLyrics(true);
        assert.equal(w0.style.getPropertyValue('--word-progress'), '50.0%');
        lApp.lastKnownCurrentTime = 2.5; lApp.lastStateUpdateTime = Date.now(); lApp.animateLyrics(true);
        assert.equal(w0.style.getPropertyValue('--word-progress'), '100%');
        lApp.lastKnownCurrentTime = 1.0; lApp.lastStateUpdateTime = Date.now(); lApp.animateLyrics(true);
        assert.equal(w0.style.getPropertyValue('--word-progress'), '50.0%', 'seeking back to prior 50.0% progress rewrites --word-progress after finished state');
    } finally {
        dom.window.close();
    }
});

test('Batch 121: stage-edge reads --stage-edge-mono before canvas writes, stage-host skips idle window resize, and core/pixi CSS disables enter animations under reduced motion', () => {
    const dom = createStageDom();
    try {
        // 1. Verify stage-edge calls getComputedStyle BEFORE mutating strip canvas width/style
        const root = dom.window.document.getElementById('music-stage');
        const edgeSpectrum = root.querySelector('.music-stage-edge-spectrum');
        const edgeCanvas = root.querySelector('.music-stage-edge-spectrum-canvas');
        const ops = [];
        const origGetCS = dom.window.getComputedStyle.bind(dom.window);
        dom.window.getComputedStyle = (el, ...rest) => {
            if (el === edgeCanvas) ops.push('read:mono');
            return origGetCS(el, ...rest);
        };
        const widthDesc = Object.getOwnPropertyDescriptor(dom.window.HTMLCanvasElement.prototype, 'width');
        Object.defineProperty(edgeCanvas, 'width', {
            configurable: true,
            get() { return widthDesc ? widthDesc.get.call(this) : (this._w || 0); },
            set(v) {
                if (v > 1) ops.push('write:width');
                if (widthDesc) widthDesc.set.call(this, v); else this._w = v;
            }
        });
        installCanvasStub(dom.window);
        runScript(dom, 'Musicmodules/music-stage/music-stage-runtime.js');
        runScript(dom, 'Musicmodules/music-stage/modes/stage-mode-utils.js');
        runScript(dom, 'Musicmodules/music-stage/music-stage-edge.js');
        Object.defineProperty(root, 'clientWidth', { configurable: true, value: 800 });
        Object.defineProperty(root, 'clientHeight', { configurable: true, value: 600 });
        const edge = dom.window.MusicStageEdge.create({
            app: {},
            root,
            elements: { edgeSpectrum, edgeCanvas },
            state: { config: { quality: 'standard', edgeSpectrum: true } },
            scope: { add() {} },
            clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
        });
        edge.draw({ now: 100, isPlaying: true, track: { path: '/a.flac' }, viewport: { dpr: 1 }, audio: { power: 0.4, spectrum: new Array(64).fill(0.5) } });
        const rIdx = ops.indexOf('read:mono');
        const wIdx = ops.indexOf('write:width');
        assert.ok(rIdx !== -1 && wIdx !== -1 && rIdx < wIdx, `getComputedStyle(--stage-edge-mono) runs before canvas resize writes (${ops.join(',')})`);
        edge.release();

        // 2. Inactive stageHost skips scheduling rAF on window resize
        runScript(dom, 'Musicmodules/music-stage/music-stage-config.js');
        for (const dep of [
            'modes/stage-lyric-layout.js', 'modes/stage-lyric-performance.js',
            'modes/luminous-manager.js', 'modes/partita-manager.js', 'modes/cadenza-manager.js',
            'modes/tempera-manager.js', 'modes/sonnet-manager.js', 'modes/diorama-manager.js',
            'modes/fume-manager.js', 'music-stage-advanced-modes.js',
            'music-stage-modes.js', 'music-stage-host.js'
        ]) {
            runScript(dom, `Musicmodules/music-stage/${dep}`);
        }
        const { app } = createApp();
        dom.window.setupMusicStage(app);
        let resizeRafs = 0;
        const origRaf = dom.window.requestAnimationFrame;
        dom.window.requestAnimationFrame = (fn) => { resizeRafs += 1; return origRaf ? origRaf(fn) : 1; };
        dom.window.dispatchEvent(new dom.window.Event('resize'));
        assert.equal(resizeRafs, 0, 'inactive stage host skips rAF on window resize');
        app.stageHost.destroy();

        // 3. Reduced-motion CSS coverage in core-modes and pixi-3d stylesheets
        const coreCss = read('Musicmodules/music-stage/music-stage-core-modes.css');
        const pixiCss = read('Musicmodules/music-stage/music-stage-pixi-3d.css');
        assert.match(coreCss, /body\.music-reduce-motion \.luminous-line\.is-entering[\s\S]*?animation:\s*none;/);
        assert.match(coreCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.starborn-transition-burst\.is-active/);
        assert.match(pixiCss, /body\.music-reduce-motion \.tempera-shot\.is-entering[\s\S]*?animation:\s*none;/);
    } finally {
        dom.window.close();
    }
});
