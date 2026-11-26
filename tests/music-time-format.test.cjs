// 时长写法：一小时以上的歌（现场、DJ 混音、有声书）各处都写 1:52:40，不能这里 112:40、那里 1:52:40；
// 引擎还没报时长时不写 NaN:NaN。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = (f) => fs.readFileSync(f, 'utf8');

test('the player clock (classic view, lyrics) writes hours and never NaN', () => {
    const context = { window: {}, console, setTimeout, clearTimeout, navigator: {} };
    vm.createContext(context);
    vm.runInContext(read('Musicmodules/music-utils.js'), context);
    const app = {};
    context.setupUtils(app);
    assert.equal(app.formatTime(0), '0:00');
    assert.equal(app.formatTime(200), '3:20');
    assert.equal(app.formatTime(6760), '1:52:40');
    assert.equal(app.formatTime(3605.7), '1:00:05');
    assert.equal(app.formatTime(undefined), '0:00');
    assert.equal(app.formatTime(NaN), '0:00');
});

test('the dock clock keeps two-digit minutes and adds hours past one hour', async () => {
    const dom = new JSDOM(`<!doctype html><body><div class="main-content"></div>
        <div class="track-title"></div><div class="track-artist"></div><div class="album-art"></div>
        <span class="current-time"></span><span class="duration"></span><button id="mode-btn"></button>
        <input id="volume-slider" type="range" min="0" max="1" step="0.01" value="0.5"><ul id="playlist"></ul>
        <div id="music-dock-root"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const { window } = dom;
    window.MusicStageConfig = { modes: [] };
    for (const f of ['music-dock-icons.js', 'music-dock-palette.js', 'music-dock-fluid.js', 'music-dock-queue.js', 'music-dock-stage-settings.js', 'music-dock.js']) window.eval(read('Musicmodules/music-dock/' + f));
    const doc = window.document;
    const app = {
        playlist: [{ path: 'C:/live.flac', title: 'Live.flac', artist: 'A' }], currentTrackIndex: 0, isPlaying: false,
        lastKnownCurrentTime: 3725, lastKnownDuration: 6760, lastStateUpdateTime: Date.now(),
        playModes: ['repeat'], currentPlayMode: 0, currentLyrics: [], currentLyricIndex: -1,
        trackTitle: doc.querySelector('.track-title'), trackArtist: doc.querySelector('.track-artist'), albumArt: doc.querySelector('.album-art'),
        currentTimeEl: doc.querySelector('.current-time'), durationEl: doc.querySelector('.duration'), modeBtn: doc.getElementById('mode-btn'),
        volumeSlider: doc.getElementById('volume-slider'), playlistEl: doc.getElementById('playlist'),
        stripAudioExtension: (t) => t, playTrack() {}, pauseTrack() {}, prevTrack() {}, nextTrack() {}, seekTo() {}, loadTrack() {}, setPlayMode() {}
    };
    window.initMusicDock(app);
    await new Promise((r) => window.setTimeout(r, 50));
    assert.equal(doc.querySelector('[data-md="t1"]').textContent, '1:02:05');
    assert.equal(doc.querySelector('[data-md="t2"]').textContent, '1:52:40');
    dom.window.close();
});
