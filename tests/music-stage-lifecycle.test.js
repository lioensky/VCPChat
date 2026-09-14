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
        3,
        'normal load plus exact and fuzzy gapless synchronization must reposition the current track'
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
    runScript(dom, 'Musicmodules/music-stage/music-stage-host.js');

    const { app, calls } = createApp();
    dom.window.setupMusicStage(app);
    app.stageHost.enter();
    await wait(dom.window, 20);

    assert.equal(app.stageHost.active, true);
    assert.equal(app.isStageActive, true);
    assert.equal(app.stageHost.getDebugSnapshot().modeRootChildren, 1);

    for (const mode of ['tempera', 'sonnet', 'diorama', 'fume', 'partita', 'cadenza', 'luminous', 'fume']) {
        app.stageHost.setMode(mode);
        await wait(dom.window, 210);
        app.stageHost.updateFrame(1000);
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
    await wait(dom.window, 210);
    app.stageHost.updateFrame(1200);
    const starborn = app.stageHost.getDebugSnapshot();
    assert.equal(starborn.modeId, 'starborn');
    assert.equal(starborn.mode.excludesWebGLModes, true);
    assert.equal(starborn.mode.candidateModes.includes('diorama'), false);
    assert.equal(starborn.mode.candidateModes.includes('tempera'), true);
    assert.equal(starborn.mode.candidateModes.includes('sonnet'), true);

    app.stageHost.setMode('luminous');
    await wait(dom.window, 210);
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