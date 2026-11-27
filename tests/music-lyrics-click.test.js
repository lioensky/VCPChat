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

test('animateLyrics caches word state across line changes and resetLyrics clears layout & seek rAF', () => {
    const dom = new JSDOM('<ul id="l"></ul><div id="c"></div>');
    const { window } = dom;
    const cancelled = [];
    let rafSeq = 0;
    window.requestAnimationFrame = () => ++rafSeq;
    window.cancelAnimationFrame = (id) => cancelled.push(id);
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
        requestAnimationFrame: window.requestAnimationFrame,
        cancelAnimationFrame: window.cancelAnimationFrame,
        window, document: window.document
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'), context);
    const app = {
        lyricSpeedFactor: 1, lyricOffset: 0, currentLyrics: [],
        lyricsList: window.document.getElementById('l'),
        lyricsContainer: window.document.getElementById('c'),
        isPlaying: true, isTrackLoading: false, lastKnownDuration: 60,
        lastKnownCurrentTime: 1, lastStateUpdateTime: Date.now(),
        api: { seekMusic: () => {} },
        seekTo: () => {}, playTrack: () => {}, formatTime: (t) => String(t)
    };
    context.setupLyrics(app);
    app.currentLyrics = [
        { time: 0, endTime: 5, text: '第一句', isWordByWord: true, words: [{ text: '第', startTime: 0, endTime: 2 }, { text: '一句', startTime: 2, endTime: 5 }] },
        { time: 5, endTime: 10, text: '第二句', isWordByWord: true, words: [{ text: '第', startTime: 5, endTime: 7 }, { text: '二句', startTime: 7, endTime: 10 }] },
        { time: 10, endTime: 15, text: '第三句', isWordByWord: true, words: [{ text: '第', startTime: 10, endTime: 12 }, { text: '三句', startTime: 12, endTime: 15 }] }
    ];
    app.renderLyrics();
    const items = [...app.lyricsList.querySelectorAll('li')];
    let qsaOnThird = 0;
    const origQsa = items[2].querySelectorAll.bind(items[2]);
    items[2].querySelectorAll = (...args) => { qsaOnThird++; return origQsa(...args); };

    app.lastKnownCurrentTime = 1;
    app.animateLyrics();
    assert.equal(app.currentLyricIndex, 0);
    const afterFirst = qsaOnThird;

    // 切到第 2 句时，未触及的第 3 句处于已结算的 future 状态，不应再次全量扫描 .lyric-word
    app.lastKnownCurrentTime = 6;
    app.animateLyrics();
    assert.equal(app.currentLyricIndex, 1);
    assert.equal(qsaOnThird, afterFirst, 'settled future line should not run querySelectorAll again');

    app.isPlaying = false;
    Object.defineProperty(items[1], 'offsetTop', { value: 180, configurable: true });
    Object.defineProperty(items[2], 'offsetTop', { value: 260, configurable: true });
    app.lastKnownCurrentTime = 7;
    app.syncLyricsAfterSeek();
    assert.ok(rafSeq > 0);
    app.resetLyrics();
    assert.equal(app._lyricLayout, null);
    assert.ok(cancelled.includes(rafSeq), 'resetLyrics cancels pending seek rAF');
    window.close();
});
