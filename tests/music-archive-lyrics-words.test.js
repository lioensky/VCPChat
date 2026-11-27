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

test('Batch 64: archive lyrics reads row geometry before active-class writes, clears words without querySelectorAll, and dedupes index hover', () => {
    const { window, app, ly, at } = setup({ playing: true });
    // Expand lyrics to >=4 lines so the index ruler is built
    app.currentLyrics = [
        { time: 1, text: 'hello world', words: [{ text: 'hello ', startTime: 1, endTime: 2 }, { text: 'world', startTime: 2, endTime: 3 }] },
        { time: 4, text: 'second line' },
        { time: 8, text: 'third line' },
        { time: 12, text: 'fourth line' }
    ];
    ly.sync();
    const track = ly.el.querySelector('.archive-lyrics-track');
    const vp = ly.el.querySelector('.archive-lyrics-viewport');
    Object.defineProperty(vp, 'clientHeight', { get: () => 200, configurable: true });
    Object.defineProperty(track, 'offsetHeight', { get: () => 400, configurable: true });

    // Start on word-by-word line 0
    at(1.5);
    const line0 = track.children[0];
    const line1 = track.children[1];
    assert.ok(line0.classList.contains('on'));
    assert.ok(line0.querySelector('.w.singing'));

    // Instrument line1.offsetTop read vs line0/line1 classList mutations, and line0.querySelectorAll
    const ops = [];
    Object.defineProperty(line1, 'offsetTop', { get: () => { ops.push('read:offsetTop'); return 60; }, configurable: true });
    Object.defineProperty(line1, 'offsetHeight', { get: () => { ops.push('read:offsetHeight'); return 32; }, configurable: true });
    const origAdd = line1.classList.add.bind(line1.classList);
    line1.classList.add = (...a) => { if (a.includes('on')) ops.push('write:add-on'); return origAdd(...a); };
    const origRem = line0.classList.remove.bind(line0.classList);
    line0.classList.remove = (...a) => { if (a.includes('on')) ops.push('write:rem-on'); return origRem(...a); };
    let prevQsaCalls = 0;
    const origQsa = line0.querySelectorAll.bind(line0);
    line0.querySelectorAll = (...a) => { prevQsaCalls += 1; return origQsa(...a); };

    at(4.5);
    const firstWrite = ops.findIndex((o) => o.startsWith('write:'));
    const lastRead = ops.reduce((acc, o, i) => (o.startsWith('read:') ? i : acc), -1);
    assert.ok(firstWrite > 0 && lastRead < firstWrite, `updateShift reads precede active-class writes (${ops.join(',')})`);
    assert.equal(prevQsaCalls, 0, 'leaving a word line clears spans via state.words.children without querySelectorAll');
    assert.equal(line0.querySelectorAll('.w.sung, .w.singing').length, 0);

    // Index ruler pointermove deduplicates repeated moves on the same lyric line index
    const indexEl = ly.el.querySelector('.archive-lyrics-index');
    indexEl.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 20, width: 20, height: 100 });
    let hvWrites = 0;
    const origSetProp = indexEl.style.setProperty.bind(indexEl.style);
    indexEl.style.setProperty = (prop, val) => {
        if (prop === '--hv') hvWrites += 1;
        return origSetProp(prop, val);
    };
    indexEl.dispatchEvent(new window.MouseEvent('pointerenter', { bubbles: true, clientY: 35 }));
    indexEl.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientY: 35 }));
    indexEl.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientY: 36 }));
    assert.equal(hvWrites, 1, 'repeated pointermove on same lyric index writes --hv once');
    indexEl.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientY: 95 }));
    assert.equal(hvWrites, 2, 'moving to a different lyric index updates --hv');
    indexEl.dispatchEvent(new window.MouseEvent('pointerleave', { bubbles: true }));
    indexEl.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientY: 95 }));
    assert.equal(hvWrites, 3, 'pointerleave resets lastHoverK so re-entry paints again');
    ly.destroy();
});

test('Batch 73: archive lyrics defers fitLines layout reads while hidden and runs once shown', () => {
    const dom = new JSDOM('<div id="h"></div>', { pretendToBeVisual: true });
    const { window } = dom;
    const rafs = [];
    const context = vm.createContext({
        ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
        window, document: window.document, console,
        setInterval: () => 1, clearInterval() {},
        setTimeout: () => 1, clearTimeout() {},
        requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
        cancelAnimationFrame() {},
        Date
    });
    context.globalThis = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-archive/archive-lyrics.js'), 'utf8'), context);
    const app = {
        playlist: [{ path: '/a.flac', title: 'A' }],
        currentTrackIndex: 0,
        isPlaying: false,
        lastKnownCurrentTime: 0,
        lastStateUpdateTime: 0,
        currentLyrics: [{ time: 1, text: 'a very long line that needs measuring' }]
    };
    const ly = window.MusicArchiveLyrics.create({ host: window.document.getElementById('h'), app });
    ly.setAllowed(false);
    const b = ly.el.querySelector('.archive-lyrics-track p b');
    let widthReads = 0;
    Object.defineProperty(b, 'clientWidth', { get: () => { widthReads += 1; return 100; }, configurable: true });
    Object.defineProperty(b, 'scrollWidth', { get: () => { widthReads += 1; return 200; }, configurable: true });

    // Running queued rAF while hidden skips forced clientWidth/scrollWidth reads
    while (rafs.length) rafs.shift()();
    assert.equal(widthReads, 0, 'fitLines skips DOM width reads while lyrics pane is hidden');
    assert.equal(b.style.getPropertyValue('--fit'), '');

    // Showing the pane schedules deferred fitLines and applies --fit
    ly.setAllowed(true);
    while (rafs.length) rafs.shift()();
    assert.ok(widthReads >= 2, 'fitLines measures once pane becomes visible');
    assert.notEqual(b.style.getPropertyValue('--fit'), '', 'long line receives --fit scale');
    ly.destroy();
    window.close();
});
