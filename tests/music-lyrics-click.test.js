const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// 点一句歌词：跳到这句；暂停时还会接着播，播放中不重复发播放。
function setup({ playing }) {
    const dom = new JSDOM('<ul id="l"></ul><div id="c"></div>');
    const { window } = dom;
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, window, document: window.document });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'), context);
    const calls = [];
    const app = {
        lyricSpeedFactor: 1, lyricOffset: 0, currentLyrics: [],
        lyricsList: window.document.getElementById('l'),
        lyricsContainer: window.document.getElementById('c'),
        isPlaying: playing, isTrackLoading: false, lastKnownDuration: 0,
        api: { seekMusic: () => {} },
        seekTo: (t) => calls.push('seek:' + t),
        playTrack: () => calls.push('play'),
        formatTime: (t) => `0:${String(Math.floor(t)).padStart(2, '0')}`
    };
    context.setupLyrics(app);
    app.currentLyrics = app.parseLrc('[00:08.00]第一句\n[00:12.00]第二句');
    app.renderLyrics();
    return { app, calls, items: app.lyricsList.querySelectorAll('li') };
}

test('clicking a line while paused seeks there and resumes', () => {
    const { calls, items } = setup({ playing: false });
    items[1].click();
    assert.deepEqual(calls, ['seek:12', 'play']);
    assert.match(items[1].title, /0:12/);
});

test('clicking a line while playing only seeks', () => {
    const { calls, items } = setup({ playing: true });
    items[0].click();
    assert.deepEqual(calls, ['seek:8']);
});

test('animateLyrics updates currentLyricIndex without touching classic DOM when archive or stage hides it', () => {
    const { app, items } = setup({ playing: true });
    app.lastKnownCurrentTime = 13;
    app.lastStateUpdateTime = 0;
    const body = items[0].ownerDocument.body;
    body.classList.add('music-archive-on');
    app.animateLyrics();
    assert.equal(app.currentLyricIndex, 1);
    assert.equal(items[1].classList.contains('active'), false, 'no DOM write while archive covers classic lyrics');
    body.classList.remove('music-archive-on');
    app.currentLyricIndex = -1;
    app.animateLyrics();
    assert.equal(app.currentLyricIndex, 1);
    assert.equal(items[1].classList.contains('active'), true, 'updates classic DOM once visible');
});
