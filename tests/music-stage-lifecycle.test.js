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
    assert.match(css, /\.music-stage\s+\.music-stage-edge-spectrum-canvas\s*\{[^}]*filter:\s*grayscale\(1\)/, 'grayscale applied to narrow strip canvases');
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
});
