const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// 首页右侧歌词：逐字填色、滚轮翻看时先不跟随、暂停时点一句会接着播。
function setup({ playing = true } = {}) {
    const dom = new JSDOM('<div id="h"></div>', { pretendToBeVisual: true });
    const { window } = dom;
    const timers = [];
    const context = vm.createContext({ ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, window, document: window.document, console, setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, Date });
    context.globalThis = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-archive/archive-lyrics.js'), 'utf8'), context);
    const calls = [];
    const app = {
        playlist: [{ path: '/a.flac', title: 'A' }], currentTrackIndex: 0, isPlaying: playing, isTrackLoading: false,
        lastKnownCurrentTime: 0, lastStateUpdateTime: 0,
        currentLyrics: [
            { time: 1, text: 'hello world', words: [{ text: 'hello ', startTime: 1, endTime: 2 }, { text: 'world', startTime: 2, endTime: 3 }] },
            { time: 4, text: 'plain line' }
        ],
        seekTo: (t) => calls.push('seek:' + t), playTrack: () => calls.push('play')
    };
    const ly = window.MusicArchiveLyrics.create({ host: window.document.getElementById('h'), app });
    ly.setAllowed(true);
    const at = (t) => { app.lastKnownCurrentTime = t; app.lastStateUpdateTime = 0; ly.tick(); };
    return { window, app, ly, at, calls, timers };
}

test('the sung line fills word by word', () => {
    const { ly, at } = setup();
    at(1.5);
    const spans = [...ly.el.querySelectorAll('p.on b.ww .w')];
    assert.deepEqual(spans.map((n) => n.className), ['w singing', 'w']);
    assert.match(spans[0].style.getPropertyValue('--d'), /^0\.50s$/);
    at(2.2);
    assert.deepEqual(spans.map((n) => n.className), ['w sung', 'w singing']);
    at(4.5);
    assert.equal(ly.el.querySelector('p.on b').textContent, 'plain line');
    assert.equal(ly.el.querySelectorAll('.w.sung, .w.singing').length, 0);
});

test('clicking a line while paused seeks there and starts playback', () => {
    const { window, ly, at, calls } = setup({ playing: false });
    at(1.25);
    assert.equal(ly.el.querySelector('p.on .w').className, 'w held');
    assert.equal(ly.el.querySelector('p.on .w').style.getPropertyValue('--p'), '25%');
    ly.el.querySelectorAll('p[data-k]')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls, ['seek:4', 'play']);
});

test('wheel pauses following, then it comes back', () => {
    const { window, ly, at, timers } = setup();
    at(1.5);
    const vp = ly.el.querySelector('.archive-lyrics-viewport');
    vp.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    assert.ok(ly.el.classList.contains('browsing'));
    timers.at(-1)();
    assert.ok(!ly.el.classList.contains('browsing'));
});
