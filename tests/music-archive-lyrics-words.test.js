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

test('destroy removes document desktop-lyrics listener and cancels pending init timer', () => {
    const dom = new JSDOM('<div id="h"></div>', { pretendToBeVisual: true });
    const { window } = dom;
    const active = new Set();
    const origAdd = window.document.addEventListener.bind(window.document);
    const origRemove = window.document.removeEventListener.bind(window.document);
    window.document.addEventListener = (type, fn, opts) => {
        if (type === 'music-desktop-lyrics-change') active.add(fn);
        return origAdd(type, fn, opts);
    };
    window.document.removeEventListener = (type, fn, opts) => {
        if (type === 'music-desktop-lyrics-change') active.delete(fn);
        return origRemove(type, fn, opts);
    };
    const cleared = [];
    let tid = 0;
    const context = vm.createContext({
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        window, document: window.document, console,
        setInterval: () => 1, clearInterval() {},
        setTimeout: () => ++tid, clearTimeout: (id) => { if (id) cleared.push(id); },
        requestAnimationFrame: () => 0, cancelAnimationFrame() {}, Date
    });
    context.globalThis = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-archive/archive-lyrics.js'), 'utf8'), context);
    const ly = window.MusicArchiveLyrics.create({
        host: window.document.getElementById('h'),
        app: { playlist: [], currentTrackIndex: -1, isPlaying: false, currentLyrics: [] }
    });
    assert.equal(active.size, 1, 'listener registered on document');
    ly.destroy();
    assert.equal(active.size, 0, 'listener removed on destroy');
    assert.ok(cleared.length >= 1, 'pending init timer cleared on destroy');
});

test('dragging to select lyric text does not trigger click-to-seek', () => {
    const { window, ly, at, calls } = setup({ playing: true });
    at(1.5);
    const p = ly.el.querySelectorAll('p[data-k]')[1];
    window.getSelection = () => ({ isCollapsed: false, anchorNode: p.firstChild });
    p.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls, [], 'non-collapsed selection inside lyric line blocks seek');
    window.getSelection = () => ({ isCollapsed: true, anchorNode: p.firstChild });
    p.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(calls, ['seek:4'], 'collapsed click still seeks');
    ly.destroy();
});

test('archive lyrics refresh immediately on translation/offset events and remove listeners on destroy', () => {
    const { window, app, ly, at } = setup({ playing: true });
    at(1.5);
    assert.equal(ly.el.querySelectorAll('p em').length, 0);
    // In-place mutation of app.currentLyrics (as done by music-lyrics-ai) + custom event
    app.currentLyrics[0].translation = '你好世界';
    window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translated'));
    assert.equal(ly.el.querySelector('p[data-k="0"] em')?.textContent, '你好世界', 'translation appears immediately without track change');
    // In-place offset shift (as done by app.setLyricOffset) + music-lyrics-offset event
    app.currentLyrics[1].time = 1.2;
    window.document.dispatchEvent(new window.CustomEvent('music-lyrics-offset'));
    assert.equal(ly.el.querySelector('p.on')?.dataset.k, '1', 'offset mutation immediately re-anchors active line');
    ly.destroy();
    // After destroy, dispatching mutation events must not throw or recreate content
    app.currentLyrics[0].translation = '不会重建';
    window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translated'));
    assert.equal(ly.el.isConnected, false);
});

test('archive lyrics respects app.lyricsTranslation toggle and recalculates row offsets', () => {
    const { window, app, ly, at } = setup({ playing: true });
    const track = ly.el.querySelector('.archive-lyrics-track');
    const vp = ly.el.querySelector('.archive-lyrics-viewport');
    Object.defineProperty(track, 'offsetHeight', { get: () => 400 });
    Object.defineProperty(vp, 'clientHeight', { get: () => 100 });
    app.currentLyrics[0].translation = '你好世界';
    app.lyricsTranslation = true;
    window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translated'));
    at(4.5);
    assert.equal(ly.el.querySelectorAll('p em').length, 1);
    const transformWithTr = track.style.transform;

    app.lyricsTranslation = false;
    window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translation'));
    at(4.5);
    assert.equal(ly.el.querySelectorAll('p em').length, 0, 'disabling lyricsTranslation hides em translations');
    assert.notEqual(track.style.transform, transformWithTr, 'scroll offset updates from LINE_H_TR to LINE_H');

    app.lyricsTranslation = true;
    window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translation'));
    assert.equal(ly.el.querySelector('p[data-k="0"] em')?.textContent, '你好世界', 're-enabling restores em translations');
    ly.destroy();
});

test('archive lyrics skips 200ms timer for untimed plain lyrics while playing', () => {
    const { app, ly } = setup({ playing: true });
    assert.equal(ly.debug().ticking, true, 'timed lyrics run interval while playing');
    app.currentLyrics = [];
    app.currentLyricsPlainLines = ['第一行纯文本', '第二行纯文本'];
    ly.sync();
    assert.equal(ly.debug().shown, true, 'plain lyrics stay visible');
    assert.equal(ly.debug().ticking, false, 'untimed plain lyrics do not spin 200ms tick interval');
    ly.destroy();
});

test('Batch 52: archive lyrics caches track offsetHeight across wheel events, caches b.ww, and dedupes --lp writes', () => {
    const { window, ly, at } = setup({ playing: true });
    const track = ly.el.querySelector('.archive-lyrics-track');
    const vp = ly.el.querySelector('.archive-lyrics-viewport');
    let heightReads = 0;
    Object.defineProperty(track, 'offsetHeight', { get: () => { heightReads += 1; return 400; }, configurable: true });
    Object.defineProperty(vp, 'clientHeight', { get: () => 120, configurable: true });

    at(1.2);
    const readsAfterInitial = heightReads;
    for (let i = 0; i < 6; i += 1) {
        vp.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    }
    assert.equal(heightReads, readsAfterInitial, 'wheel ticks reuse cached trackHeight without forced offsetHeight reflow');

    // Same-line word ticks reuse cached b.ww without querying DOM again
    let qsCalls = 0;
    const line0 = track.children[0];
    const origQs = line0.querySelector.bind(line0);
    line0.querySelector = (...args) => { qsCalls += 1; return origQs(...args); };
    at(1.4);
    at(1.6);
    at(1.8);
    assert.equal(qsCalls, 0, 'subsequent ticks on active word line reuse cached b.ww element');

    // Non-word line deduplicates identical --lp writes
    at(4.5);
    const line1 = track.children[1];
    let lpWrites = 0;
    const origSetProp = line1.style.setProperty.bind(line1.style);
    line1.style.setProperty = (prop, val) => {
        if (prop === '--lp') lpWrites += 1;
        return origSetProp(prop, val);
    };
    at(4.5);
    at(4.5);
    assert.equal(lpWrites, 0, 'unchanged --lp percentage skips redundant style writes');
    at(5.2);
    assert.equal(lpWrites, 1, 'changed --lp percentage updates once');
    ly.destroy();
});
