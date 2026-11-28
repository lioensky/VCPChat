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

test('Batch 60: lyric clicks use single delegated listener, ignore non-collapsed text selections, and detach on beforeunload', () => {
    const dom = new JSDOM('<ul id="l"></ul><div id="c"></div>');
    const { window } = dom;
    let selectionCollapsed = true;
    let selectionAnchor = null;
    window.getSelection = () => ({ isCollapsed: selectionCollapsed, anchorNode: selectionAnchor, toString: () => (selectionCollapsed ? '' : '第一句') });
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, window, document: window.document });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'), context);
    const seeks = [];
    const app = {
        lyricSpeedFactor: 1, lyricOffset: 0, currentLyrics: [],
        lyricsList: window.document.getElementById('l'),
        lyricsContainer: window.document.getElementById('c'),
        isPlaying: true, isTrackLoading: false, lastKnownDuration: 60,
        api: { seekMusic: () => {} },
        seekTo: (t) => seeks.push(t),
        playTrack: () => {},
        formatTime: (t) => `0:${String(Math.floor(t)).padStart(2, '0')}`
    };
    context.setupLyrics(app);
    app.currentLyrics = app.parseLrc('[00:08.00]第一句\n[00:12.00]第二句');
    app.renderLyrics();
    const items = app.lyricsList.querySelectorAll('li');
    assert.equal(items[0].onclick, null, 'individual lyric <li> does not allocate per-line onclick closure');

    // 正在选中歌词文本时不触发跳转
    selectionCollapsed = false;
    selectionAnchor = items[1].firstChild;
    items[1].click();
    assert.deepEqual(seeks, [], 'non-collapsed text selection suppresses lyric seek');

    // 折叠选区时点击内部子元素也可委托跳转
    selectionCollapsed = true;
    items[1].querySelector('.lyric-original').click();
    assert.deepEqual(seeks, [12]);

    // beforeunload 卸载委托监听
    window.dispatchEvent(new window.Event('beforeunload'));
    items[0].click();
    assert.deepEqual(seeks, [12], 'delegated click listener detaches on beforeunload');
    window.close();
});

test('Batch 65: animateLyrics caches viewport via ResizeObserver, reads geometry before DOM writes, and disconnects on beforeunload', () => {
    const dom = new JSDOM('<ul id="l"></ul><div id="c"></div>');
    const { window } = dom;
    let roCallback = null;
    let roDisconnected = false;
    class FakeResizeObserver {
        constructor(cb) { roCallback = cb; }
        observe() {}
        disconnect() { roDisconnected = true; }
    }
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout,
        ResizeObserver: FakeResizeObserver,
        window, document: window.document
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'), context);
    const container = window.document.getElementById('c');
    let vpReads = 0;
    Object.defineProperty(container, 'clientWidth', { get() { vpReads += 1; return 480; }, configurable: true });
    Object.defineProperty(container, 'clientHeight', { get() { vpReads += 1; return 320; }, configurable: true });
    const app = {
        lyricSpeedFactor: 1, lyricOffset: 0, currentLyrics: [],
        lyricsList: window.document.getElementById('l'),
        lyricsContainer: container,
        isPlaying: true, isTrackLoading: false, lastKnownDuration: 60,
        lastKnownCurrentTime: 9, lastStateUpdateTime: Date.now(),
        api: { seekMusic: () => {} },
        seekTo: () => {}, playTrack: () => {}, formatTime: (t) => String(t)
    };
    context.setupLyrics(app);
    app.currentLyrics = app.parseLrc('[00:08.00]第一句\n[00:12.00]第二句');
    app.renderLyrics();
    const items = [...app.lyricsList.querySelectorAll('li')];

    // Record exact read vs write order when active line changes: offsetTop must be read BEFORE active class is added
    const trace = [];
    Object.defineProperty(items[0], 'offsetTop', { get() { trace.push('read:offsetTop'); return 100; }, configurable: true });
    Object.defineProperty(items[0], 'clientHeight', { get() { trace.push('read:clientHeight'); return 32; }, configurable: true });
    const origAdd = items[0].classList.add.bind(items[0].classList);
    items[0].classList.add = (...cls) => { if (cls.includes('active')) trace.push('write:active'); return origAdd(...cls); };

    // ResizeObserver provides viewport dimensions -> 0 clientWidth/clientHeight reads
    roCallback([{ contentRect: { width: 520, height: 340 } }]);
    app.animateLyrics();
    assert.equal(vpReads, 0, 'ResizeObserver cache eliminates clientWidth/clientHeight reads');
    assert.equal(trace[0], 'read:offsetTop', 'geometry read happens before .active DOM write');
    assert.ok(trace.indexOf('read:clientHeight') < trace.indexOf('write:active'), 'clientHeight read precedes .active mutation');

    // Steady-state frames make 0 viewport reads
    app.animateLyrics();
    app.animateLyrics();
    assert.equal(vpReads, 0);

    // ResizeObserver invalidates cache when contentRect reports 0 -> falls back once to clientWidth/Height
    roCallback([{ contentRect: { width: 0, height: 0 } }]);
    app.animateLyrics();
    assert.equal(vpReads, 2, 'single fallback read when observer reports zero rect');
    app.animateLyrics();
    assert.equal(vpReads, 2, 'cached again after single fallback read');

    // beforeunload disconnects ResizeObserver
    window.dispatchEvent(new window.Event('beforeunload'));
    assert.equal(roDisconnected, true, 'ResizeObserver disconnects on beforeunload');
    window.close();
});

test('Batch 82: lyricIndexAt uses monotonic hint fast path, lyricInterlude accepts knownAt, opacity LUT matches formula, and transition layout reads throttle to 64ms', () => {
    const dom = new JSDOM('<ul id="l"></ul><div id="c"></div>');
    const { window } = dom;
    let fakeNow = 10000;
    const FakeDate = { now: () => fakeNow };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        Date: FakeDate,
        setTimeout, clearTimeout,
        window, document: window.document
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-lyrics.js'), 'utf8'), context);
    const container = window.document.getElementById('c');
    Object.defineProperty(container, 'clientWidth', { get: () => 480, configurable: true });
    Object.defineProperty(container, 'clientHeight', { get: () => 320, configurable: true });
    const app = {
        lyricSpeedFactor: 1, lyricOffset: 0, currentLyrics: [],
        lyricsList: window.document.getElementById('l'),
        lyricsContainer: container,
        isPlaying: true, isTrackLoading: false, lastKnownDuration: 120,
        lastKnownCurrentTime: 1, lastStateUpdateTime: fakeNow,
        api: { seekMusic: () => {} },
        seekTo: () => {}, playTrack: () => {}, formatTime: (t) => String(t)
    };
    context.setupLyrics(app);
    app.currentLyrics = Array.from({ length: 12 }, (_, i) => ({
        time: i * 10,
        endTime: i * 10 + 4,
        original: `第 ${i} 句`,
        text: `第 ${i} 句`
    }));
    app.renderLyrics();
    const items = [...app.lyricsList.querySelectorAll('li')];

    // 1. lyricIndexAt monotonic hint matches full binary search
    assert.equal(app.lyricIndexAt(1, app.currentLyrics, -1), 0);
    assert.equal(app.lyricIndexAt(5, app.currentLyrics, 0), 0);
    assert.equal(app.lyricIndexAt(12, app.currentLyrics, 0), 1);
    assert.equal(app.lyricIndexAt(55, app.currentLyrics, 1), 5);
    assert.equal(app.lyricIndexAt(2, app.currentLyrics, 5), 0);

    // 2. lyricInterlude with knownAt avoids calling lyricIndexAt again
    let indexAtCalls = 0;
    const origIndexAt = app.lyricIndexAt;
    app.lyricIndexAt = (...a) => { indexAtCalls += 1; return origIndexAt(...a); };
    const gap = app.lyricInterlude(7, app.currentLyrics, 0);
    assert.ok(gap && gap.index === 1 && Math.abs(gap.progress - 0.5) < 1e-6);
    assert.equal(indexAtCalls, 0, 'lyricInterlude uses knownAt without redundant binary search');
    app.lyricIndexAt = origIndexAt;

    // 3. Opacity LUT matches exact distance formula + 64ms transition measurement throttle
    let offsetReads = 0;
    for (let i = 0; i < items.length; i += 1) {
        Object.defineProperty(items[i], 'offsetTop', { get() { offsetReads += 1; return i * 40; }, configurable: true });
        Object.defineProperty(items[i], 'clientHeight', { get: () => 36, configurable: true });
    }
    app.lastKnownCurrentTime = 2;
    app.lastStateUpdateTime = fakeNow;
    app.animateLyrics();
    assert.equal(app.currentLyricIndex, 0);
    assert.equal(items[0].style.opacity, '1');
    assert.equal(items[1].style.opacity, '0.78');
    assert.equal(items[2].style.opacity, '0.56');
    assert.equal(items[3].style.opacity, '0.34');
    assert.equal(items[4].style.opacity, '0.12');
    assert.equal(items[5].style.opacity, '0.1');
    assert.equal(items[5]._lyricOpacity, '0.10');
    assert.equal(items[10].style.opacity, '0.1');
    assert.equal(items[10]._lyricOpacity, '0.10');

    const readsAfterChange = offsetReads;
    // 16ms and 32ms inside 600ms transition window skip re-measure
    fakeNow += 16;
    app.animateLyrics();
    fakeNow += 16;
    app.animateLyrics();
    assert.equal(offsetReads, readsAfterChange, 'frames under 64ms throttle skip transition re-measure');

    // >=64ms inside transition window takes one sample
    fakeNow += 40;
    app.animateLyrics();
    assert.ok(offsetReads > readsAfterChange, 'frame after 64ms throttle re-measures transition geometry');

    // Past 600ms transition window stops measuring on steady frames
    const readsBeforeSteady = offsetReads;
    fakeNow += 600;
    app.animateLyrics();
    fakeNow += 100;
    app.animateLyrics();
    assert.equal(offsetReads, readsBeforeSteady, 'steady frames past 600ms make zero layout reads');
    window.close();
});
