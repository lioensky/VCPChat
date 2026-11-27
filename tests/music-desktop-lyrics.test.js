// 桌面歌词：音乐窗口送出去的内容，和主进程里歌词条的开关、转发、遥控、锁定。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { snapshot } = require('../Musicmodules/music-desktop-lyrics.js');
const { createDesktopLyrics } = require('../modules/ipc/musicDesktopLyrics.js');

const word = (text, s, e) => ({ text, startTime: s, endTime: e });

test('送出去的是正在唱的一行、下一行，逐字时间原样带上', () => {
    global.MusicArchiveLyrics = { wordsOf: (l) => (l.words && l.words.length > 1 ? l.words : null) };
    const app = {
        playlist: [{ path: 'a.flac', title: '晴天', artist: '周杰伦' }],
        currentTrackIndex: 0,
        isPlaying: true,
        currentLyrics: [
            { time: 2, text: '故事的小黄花', translation: '', words: [word('故事的', 2, 3), word('小黄花', 3, 4)] },
            { time: 5, text: '' },
            { time: 6, text: '从出生那年就飘着', translation: 'drifting since birth' },
            { time: 30, text: '童年的荡秋千' }
        ]
    };
    const a = snapshot(app, 3.5);
    assert.strictEqual(a.line.text, '故事的小黄花');
    assert.deepStrictEqual(a.line.words, [{ text: '故事的', s: 2, e: 3 }, { text: '小黄花', s: 3, e: 4 }]);
    assert.strictEqual(a.next.text, '从出生那年就飘着'); // 空行跳过
    assert.strictEqual(a.title, '晴天');
    const b = snapshot(app, 7);
    assert.strictEqual(b.line.text, '从出生那年就飘着');
    assert.strictEqual(b.line.tr, 'drifting since birth');
    assert.strictEqual(b.line.words, null);
    // 前奏：还没有在唱的行
    assert.strictEqual(snapshot(app, 1).line, null);
    assert.strictEqual(snapshot(app, 1).next.text, '故事的小黄花');
    // 没有歌词
    const none = snapshot({ ...app, currentLyrics: null }, 3);
    assert.strictEqual(none.hasLyrics, false);
    assert.strictEqual(none.line, null);
    delete global.MusicArchiveLyrics;
});

test('逐字的一行唱完、下一句还早（间奏）就不再亮着', () => {
    global.MusicArchiveLyrics = { wordsOf: (l) => l.words || null };
    const app = {
        playlist: [{ path: 'a.flac', title: 'x' }], currentTrackIndex: 0, isPlaying: true,
        currentLyrics: [
            { time: 2, text: 'ab', words: [word('a', 2, 3), word('b', 3, 4)] },
            { time: 30, text: 'cd' }
        ]
    };
    assert.ok(snapshot(app, 5).line, '刚唱完还留着');
    assert.strictEqual(snapshot(app, 10).line, null);
    assert.strictEqual(snapshot(app, 10).index, -1);
    assert.strictEqual(snapshot(app, 10).next.text, 'cd');
    delete global.MusicArchiveLyrics;
});

function harness() {
    const handles = new Map();
    const ons = new Map();
    const ipcMain = { handle: (n, f) => handles.set(n, f), on: (n, f) => ons.set(n, f) };
    const musicSent = [];
    const music = { isDestroyed: () => false, webContents: { send: (...a) => musicSent.push(a) }, isMinimized: () => false, show() {}, focus() {} };
    const windows = [];
    class FakeWin extends EventEmitter {
        constructor(opts) {
            super();
            this.opts = opts; this.destroyed = false; this.ignore = null; this.sent = [];
            this.webContents = Object.assign(new EventEmitter(), { send: (...a) => this.sent.push(a) });
            windows.push(this);
        }
        setAlwaysOnTop() {} setMenu() {} loadFile(f) { this.file = f; }
        showInactive() { this.shown = true; }
        setIgnoreMouseEvents(on, o) { this.ignore = [on, o]; }
        getBounds() { return { x: 10, y: 20, width: 800, height: 150 }; }
        isDestroyed() { return this.destroyed; }
        close() { this.destroyed = true; this.emit('closed'); }
    }
    const electronApi = {
        BrowserWindow: FakeWin,
        screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] }
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
    const stateFile = path.join(dir, 'music-desktop-lyrics.json');
    let musicWin = music;
    const dl = createDesktopLyrics({ ipcMain, getMusicWindow: () => musicWin, stateFile, projectRoot: path.join(__dirname, '..'), electronApi });
    return { dl, handles, ons, music, musicSent, windows, stateFile, setMusic: (w) => { musicWin = w; } };
}
const fromMusic = (h) => ({ sender: h.music.webContents });

test('只有音乐窗口能开关；打开后转发歌词，遥控指令回到音乐窗口', async () => {
    const h = harness();
    assert.throws(() => h.handles.get('music-desktop-lyrics-toggle')({ sender: {} }, true));
    assert.strictEqual(await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true), true);
    assert.strictEqual(h.windows.length, 1);
    const bar = h.windows[0];
    assert.ok(bar.opts.transparent && bar.opts.alwaysOnTop && bar.opts.skipTaskbar && bar.opts.frame === false);
    assert.match(bar.file.replace(/\\/g, '/'), /Musicmodules\/desktop-lyrics\/desktop-lyrics\.html$/);
    // 位置：默认在主屏下方居中
    assert.strictEqual(bar.opts.x, Math.round((1920 - bar.opts.width) / 2));

    // 别的窗口送的歌词不转发
    h.ons.get('music-desktop-lyrics-publish')({ sender: {} }, { line: { text: 'x' } });
    assert.strictEqual(bar.sent.length, 0);
    h.ons.get('music-desktop-lyrics-publish')(fromMusic(h), { line: { text: '故事的小黄花' } });
    assert.deepStrictEqual(bar.sent.at(-1), ['music-desktop-lyrics-state', { line: { text: '故事的小黄花' } }]);

    // 歌词条上的按钮
    h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, 'next');
    assert.deepStrictEqual(h.musicSent.at(-1), ['music-control', 'next']);
    h.ons.get('music-desktop-lyrics-command')({ sender: {} }, 'pause');
    assert.notDeepStrictEqual(h.musicSent.at(-1), ['music-control', 'pause']);
    h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, 'size', 999);
    assert.strictEqual(h.dl.prefs().size, 64);
});

test('锁定后鼠标穿透，只有悬停在锁上时接收点击；开关和锁定都记住', async () => {
    const h = harness();
    await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true);
    const bar = h.windows[0];
    const cmd = (c, v) => h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, c, v);
    cmd('lock', true);
    assert.deepStrictEqual(bar.ignore, [true, { forward: true }]);
    cmd('hover', true);
    assert.deepStrictEqual(bar.ignore, [false, { forward: true }]);
    cmd('hover', false);
    assert.deepStrictEqual(bar.ignore, [true, { forward: true }]);
    await new Promise((r) => setTimeout(r, 400));
    const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
    assert.strictEqual(saved.on, true);
    assert.strictEqual(saved.locked, true);
});

test('音乐窗口关了歌词条跟着关但开关不变；自己点关闭才算关', async () => {
    const h = harness();
    await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true);
    h.dl.musicClosed();
    assert.ok(h.windows[0].destroyed);
    assert.strictEqual(h.dl.prefs().on, true);
    h.dl.musicReady(); // 下次开音乐窗口
    assert.strictEqual(h.windows.length, 2);
    const bar = h.windows[1];
    h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, 'close');
    assert.ok(bar.destroyed);
    assert.strictEqual(h.dl.prefs().on, false);
    assert.deepStrictEqual(h.musicSent.at(-1), ['music-desktop-lyrics-changed', { on: false, locked: false, size: 34 }]);
    // 关着时音乐窗口就绪不会打开
    h.dl.musicReady();
    assert.strictEqual(h.windows.length, 2);
});

test('调字号或锁定后立刻关窗口，防抖未到也会同步落盘', async () => {
    const h = harness();
    await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true);
    const bar = h.windows[0];
    const cmd = (c, v) => h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, c, v);
    cmd('size', 48);
    cmd('lock', true);
    // 不等待 300ms 防抖，立刻关闭音乐窗口
    h.dl.musicClosed();
    const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
    assert.strictEqual(saved.on, true);
    assert.strictEqual(saved.size, 48);
    assert.strictEqual(saved.locked, true);
});

test('暂停且进度未变时跳过周期重发；译文到达时立即补发', async () => {
    const vm = require('vm');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    const { window } = dom;
    let tickFn = null;
    let fakeNow = 10000;
    const origNow = Date.now;
    Date.now = () => fakeNow;
    try {
        window.setInterval = (fn) => { tickFn = fn; return 1; };
        window.clearInterval = () => { tickFn = null; };
        const ctx = vm.createContext({
            window, document: window.document, CustomEvent: window.CustomEvent,
            MutationObserver: window.MutationObserver, Date, console
        });
        ctx.window = window;
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-desktop-lyrics.js'), 'utf8'), ctx);
        const published = [];
        const app = {
            playlist: [{ path: 'a.flac', title: '晴天', artist: '周杰伦' }],
            currentTrackIndex: 0,
            isPlaying: false,
            lastKnownCurrentTime: 3,
            lastStateUpdateTime: fakeNow,
            currentLyrics: [{ time: 2, text: '故事的小黄花', translation: '' }],
            api: {
                toggleDesktopLyrics: async (v) => v,
                publishDesktopLyrics: (snap) => published.push(snap),
                getDesktopLyrics: async () => ({ on: true }),
                onDesktopLyricsChanged: () => {}
            }
        };
        window.setupMusicDesktopLyrics(app);
        await Promise.resolve();
        await Promise.resolve();
        assert.strictEqual(published.length, 1);
        // 暂停且进度未动：即使过了 10 秒也不重复发送 IPC
        fakeNow += 10000;
        tickFn();
        assert.strictEqual(published.length, 1, 'paused unchanged position should skip periodic IPC');
        // 译文异步到达：派发 music-lyrics-translated 应立即补发包含译文的快照
        app.currentLyrics[0].translation = 'Little yellow flower';
        window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translated'));
        assert.strictEqual(published.length, 2);
        assert.strictEqual(published[1].line.tr, 'Little yellow flower');
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.strictEqual(tickFn, null, 'beforeunload clears poll timer');
    } finally {
        Date.now = origNow;
        window.close();
    }
});

test('desktop lyrics only observes body while active and unsubscribes IPC on beforeunload', async () => {
    const vm = require('vm');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    const { window } = dom;
    let observeCalls = 0;
    let disconnectCalls = 0;
    let unsubCalled = 0;
    let onChangedCb = null;
    class TrackingObserver {
        constructor(cb) { this.cb = cb; }
        observe() { observeCalls += 1; }
        disconnect() { disconnectCalls += 1; }
    }
    try {
        window.MutationObserver = TrackingObserver;
        window.setInterval = () => 1;
        window.clearInterval = () => {};
        const ctx = vm.createContext({
            window, document: window.document, CustomEvent: window.CustomEvent,
            MutationObserver: TrackingObserver, Date, console
        });
        ctx.window = window;
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-desktop-lyrics.js'), 'utf8'), ctx);
        const app = {
            playlist: [],
            currentTrackIndex: 0,
            isPlaying: false,
            api: {
                toggleDesktopLyrics: async (v) => v,
                publishDesktopLyrics: () => {},
                getDesktopLyrics: async () => ({ on: false }),
                onDesktopLyricsChanged: (cb) => { onChangedCb = cb; return () => { unsubCalled += 1; }; }
            }
        };
        window.setupMusicDesktopLyrics(app);
        await Promise.resolve();
        assert.strictEqual(observeCalls, 0, 'body observer is idle while desktop lyrics is off');
        onChangedCb({ on: true });
        assert.strictEqual(observeCalls, 1, 'body observer starts when enabled');
        onChangedCb({ on: false });
        assert.strictEqual(disconnectCalls, 1, 'body observer disconnects when disabled');
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.strictEqual(unsubCalled, 1, 'onDesktopLyricsChanged unsubscribes on beforeunload');
    } finally {
        window.close();
    }
});

test('lyricsTranslation 关闭时桌面歌词快照隐藏译文，切换事件立即同步且 beforeunload 解绑开关监听', async () => {
    const vm = require('vm');
    const { JSDOM } = require('jsdom');
    const appBase = {
        playlist: [{ path: 'a.flac', title: '晴天', artist: '周杰伦' }],
        currentTrackIndex: 0,
        isPlaying: false,
        lastKnownCurrentTime: 3,
        lastStateUpdateTime: 0,
        lyricsTranslation: false,
        currentLyrics: [
            { time: 2, text: '第一句', translation: 'line one' },
            { time: 6, text: '第二句', translation: 'line two' }
        ]
    };
    const hiddenSnap = snapshot(appBase, 3);
    assert.strictEqual(hiddenSnap.line.tr, '', 'current line translation hidden when lyricsTranslation is false');
    assert.strictEqual(hiddenSnap.next.tr, '', 'next line translation hidden when lyricsTranslation is false');

    const dom = new JSDOM('<!doctype html><body><div id="desktop-lyrics-item" hidden><input id="desktop-lyrics-switch" type="checkbox"></div></body>');
    const { window } = dom;
    try {
        window.setInterval = () => 1;
        window.clearInterval = () => {};
        const ctx = vm.createContext({
            window, document: window.document, CustomEvent: window.CustomEvent,
            MutationObserver: window.MutationObserver, Date, console
        });
        ctx.window = window;
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-desktop-lyrics.js'), 'utf8'), ctx);
        const published = [];
        const app = {
            ...appBase,
            lyricsTranslation: true,
            api: {
                toggleDesktopLyrics: async (v) => v,
                publishDesktopLyrics: (snap) => published.push(snap),
                getDesktopLyrics: async () => ({ on: true }),
                onDesktopLyricsChanged: () => () => {}
            }
        };
        window.setupMusicDesktopLyrics(app);
        await Promise.resolve();
        await Promise.resolve();
        assert.strictEqual(published.at(-1).line.tr, 'line one');

        app.lyricsTranslation = false;
        window.document.dispatchEvent(new window.CustomEvent('music-lyrics-translation'));
        assert.strictEqual(published.at(-1).line.tr, '', 'music-lyrics-translation event immediately republishes without translation');

        const sw = window.document.getElementById('desktop-lyrics-switch');
        sw.checked = false;
        window.document.dispatchEvent(new window.CustomEvent('music-desktop-lyrics-change'));
        assert.strictEqual(sw.checked, true, 'switch syncs while active');

        window.dispatchEvent(new window.Event('beforeunload'));
        sw.checked = false;
        window.document.dispatchEvent(new window.CustomEvent('music-desktop-lyrics-change'));
        assert.strictEqual(sw.checked, false, 'beforeunload removes desktop-lyrics-switch sync listener');
    } finally {
        window.close();
    }
});

test('flushSaveSync cancels in-flight async save so older prefs cannot clobber newer synced state', async () => {
    const h = harness();
    await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true);
    const bar = h.windows[0];
    const cmd = (c, v) => h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, c, v);
    const origWriteFile = fs.promises.writeFile;
    let releaseSlowWrite = null;
    let slowWriteStarted = null;
    const slowStartedP = new Promise((resolve) => { slowWriteStarted = resolve; });
    fs.promises.writeFile = async (file, data, ...rest) => {
        if (String(file).startsWith(h.stateFile)) {
            slowWriteStarted();
            await new Promise((resolve) => { releaseSlowWrite = resolve; });
        }
        return origWriteFile.call(fs.promises, file, data, ...rest);
    };
    try {
        cmd('size', 28);
        await slowStartedP;
        // 旧的异步写盘正在进行中，这时改字号并立即关窗口同步落盘
        cmd('size', 52);
        h.dl.musicClosed();
        assert.strictEqual(JSON.parse(fs.readFileSync(h.stateFile, 'utf8')).size, 52);
        releaseSlowWrite();
        await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(JSON.parse(fs.readFileSync(h.stateFile, 'utf8')).size, 52, 'stale async write must not overwrite newer sync flush');
    } finally {
        fs.promises.writeFile = origWriteFile;
    }
});

test('musicDesktopLyrics ignores sends when webContents is destroyed', async () => {
    const h = harness();
    await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true);
    const bar = h.windows[0];
    bar.webContents.isDestroyed = () => true;
    h.music.webContents.isDestroyed = () => true;
    const prevBar = bar.sent.length;
    const prevMusic = h.musicSent.length;
    h.ons.get('music-desktop-lyrics-publish')(fromMusic(h), { line: { text: 'ignored' } });
    h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, 'next');
    assert.strictEqual(bar.sent.length, prevBar);
    assert.strictEqual(h.musicSent.length, prevMusic);
});

test('music-desktop-lyrics resyncs switch and shows error toast when toggle IPC rejects, and tracks next line changes in key', async () => {
    const vm = require('vm');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="desktop-lyrics-item" hidden><input id="desktop-lyrics-switch" type="checkbox"></div></body>');
    const { window } = dom;
    const toasts = [];
    const published = [];
    try {
        window.MusicToast = { show: (o) => toasts.push(o) };
        window.setInterval = () => 1;
        window.clearInterval = () => {};
        const ctx = vm.createContext({
            window, document: window.document, CustomEvent: window.CustomEvent,
            MutationObserver: window.MutationObserver, Date, console
        });
        ctx.window = window;
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-desktop-lyrics.js'), 'utf8'), ctx);
        let failToggle = true;
        const app = {
            playlist: [{ path: 'a.flac', title: 'Intro', artist: 'A' }],
            currentTrackIndex: 0,
            isPlaying: false,
            lastKnownCurrentTime: 0.5,
            lastStateUpdateTime: 0,
            currentLyrics: [{ time: 10, text: 'First version' }],
            api: {
                toggleDesktopLyrics: async (v) => { if (failToggle) throw new Error('ipc failed'); return v; },
                publishDesktopLyrics: (snap) => published.push(snap),
                getDesktopLyrics: async () => ({ on: false }),
                onDesktopLyricsChanged: () => () => {}
            }
        };
        window.setupMusicDesktopLyrics(app);
        await Promise.resolve();
        const sw = window.document.getElementById('desktop-lyrics-switch');
        sw.checked = true;
        await app.desktopLyrics.toggle(true);
        assert.strictEqual(sw.checked, false, 'failed toggle restores checkbox state');
        assert.strictEqual(toasts.at(-1).kind, 'error', 'failed toggle reports error toast');

        failToggle = false;
        await app.desktopLyrics.toggle(true);
        assert.strictEqual(published.at(-1).next.text, 'First version');
        // 前奏期间换了一份歌词（line 仍是 null，只有 next.text 变化）应立即推送
        app.currentLyrics = [{ time: 10, text: 'Updated candidate' }];
        window.document.dispatchEvent(new window.CustomEvent('music-lyrics-change'));
        assert.strictEqual(published.at(-1).next.text, 'Updated candidate', 'intro next-line change triggers publish');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        window.close();
    }
});

test('Batch 56: desktop lyrics flushSaveSync is atomic, ignores degenerate bounds, and deduplicates unchanged lock/size commands', async () => {
    const h = harness();
    await h.handles.get('music-desktop-lyrics-toggle')(fromMusic(h), true);
    const bar = h.windows[0];
    const cmd = (c, v) => h.ons.get('music-desktop-lyrics-command')({ sender: bar.webContents }, c, v);

    // 边界已达上限后重复加大字号不触发重复广播
    cmd('size', 999);
    const sentAfterMax = bar.sent.length;
    cmd('size', 999);
    assert.strictEqual(bar.sent.length, sentAfterMax, 'clamped identical size skips redundant broadcast');

    // 相同锁定状态不重复广播
    cmd('lock', true);
    const sentAfterLock = bar.sent.length;
    const musicAfterLock = h.musicSent.length;
    cmd('lock', true);
    assert.strictEqual(bar.sent.length, sentAfterLock, 'unchanged lock skips redundant bar broadcast');
    assert.strictEqual(h.musicSent.length, musicAfterLock, 'unchanged lock skips redundant music broadcast');

    // 退化 0x0 窗口尺寸不覆盖已保存的正常尺寸
    let curBounds = { x: 120, y: 240, width: 640, height: 120 };
    bar.getBounds = () => ({ ...curBounds });
    bar.emit('moved');
    curBounds = { x: -32000, y: -32000, width: 0, height: 0 };
    bar.emit('moved');
    h.dl.musicClosed();
    const saved = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
    assert.deepStrictEqual(saved.bounds, { x: 120, y: 240, width: 640, height: 120 });
    const dirFiles = fs.readdirSync(path.dirname(h.stateFile));
    assert.deepStrictEqual(dirFiles, [path.basename(h.stateFile)], 'atomic sync save leaves no stray tmp files');
});

test('Batch 59: snapshot invalidates filtered cache when lines are appended in-place onto currentLyrics', () => {
    const lyrics = [{ time: 2, text: '第一句' }];
    const app = {
        playlist: [{ path: 'a.flac', title: 'T', artist: 'A' }],
        currentTrackIndex: 0,
        isPlaying: true,
        currentLyrics: lyrics
    };
    const first = snapshot(app, 3);
    assert.strictEqual(first.line.text, '第一句');
    assert.strictEqual(first.next, null);

    // Mutate the same array reference in place (e.g. streaming or lazy append)
    lyrics.push({ time: 6, text: '第二句' });
    const second = snapshot(app, 7);
    assert.strictEqual(second.line.text, '第二句', 'filteredLines cache must rebuild when all.length grows on same array');
});

test('Batch 62: desktop-lyrics bar deduplicates hover IPC commands while locked', () => {
    const { JSDOM } = require('jsdom');
    const html = fs.readFileSync(path.join(__dirname, '../Musicmodules/desktop-lyrics/desktop-lyrics.html'), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const { window } = dom;
    const doc = window.document;
    const sent = [];
    let onPrefs = null;
    window.requestAnimationFrame = () => 1;
    window.cancelAnimationFrame = () => {};
    window.utilityAPI = {
        sendDesktopLyricsCommand: (cmd, val) => sent.push([cmd, val]),
        onDesktopLyricsState: () => () => {},
        onDesktopLyricsPrefs: (cb) => { onPrefs = cb; return () => {}; }
    };
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/desktop-lyrics/desktop-lyrics.js'), 'utf8'));
    onPrefs({ locked: true, size: 34 });

    // Leaving the document while never having hovered #lock sends 0 redundant hover:false IPCs
    doc.dispatchEvent(new window.MouseEvent('mouseleave'));
    assert.deepStrictEqual(sent, []);

    const lockBtn = doc.getElementById('lock');
    lockBtn.dispatchEvent(new window.MouseEvent('mouseenter'));
    lockBtn.dispatchEvent(new window.MouseEvent('mouseenter'));
    assert.deepStrictEqual(sent, [['hover', true]], 'entering #lock sends hover:true once');

    lockBtn.dispatchEvent(new window.MouseEvent('mouseleave'));
    doc.dispatchEvent(new window.MouseEvent('mouseleave'));
    assert.deepStrictEqual(sent, [['hover', true], ['hover', false]], 'leaving #lock then document sends hover:false once');
    window.dispatchEvent(new window.Event('beforeunload'));
    window.close();
});

test('Batch 67: paused desktop-lyrics poll skips snapshot/wordsOf allocations and ignores unrelated body class mutations', async () => {
    const vm = require('vm');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    const { window } = dom;
    let tickFn = null;
    let moCb = null;
    let wordsCalls = 0;
    try {
        window.setInterval = (fn) => { tickFn = fn; return 1; };
        window.clearInterval = () => { tickFn = null; };
        window.MutationObserver = class {
            constructor(cb) { moCb = cb; }
            observe() {}
            disconnect() {}
        };
        window.MusicArchiveLyrics = {
            wordsOf: (line) => { wordsCalls += 1; return line.words || null; }
        };
        const ctx = vm.createContext({
            window, document: window.document, CustomEvent: window.CustomEvent,
            MutationObserver: window.MutationObserver, Date, console
        });
        ctx.window = window;
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-desktop-lyrics.js'), 'utf8'), ctx);
        const published = [];
        const app = {
            playlist: [{ path: 'a.flac', title: '晴天', artist: '周杰伦' }],
            currentTrackIndex: 0,
            isPlaying: false,
            lastKnownCurrentTime: 3,
            lastStateUpdateTime: 0,
            currentLyrics: [{ time: 2, text: '故事的小黄花', translation: '', words: [word('故事的', 2, 3), word('小黄花', 3, 4)] }],
            api: {
                toggleDesktopLyrics: async (v) => v,
                publishDesktopLyrics: (snap) => published.push(snap),
                getDesktopLyrics: async () => ({ on: true }),
                onDesktopLyricsChanged: () => () => {}
            }
        };
        window.setupMusicDesktopLyrics(app);
        await Promise.resolve();
        await Promise.resolve();
        assert.strictEqual(published.length, 1);
        const initialWordsCalls = wordsCalls;

        // 暂停且无任何变更时，连续轮询不应再调用 wordsOf 或构造快照
        tickFn();
        tickFn();
        tickFn();
        assert.strictEqual(wordsCalls, initialWordsCalls, 'paused unchanged poll skips snapshot and wordsOf allocations');

        // 无关的 body 类名变动（如开关抽屉）不触发 snapshot
        window.document.body.classList.add('music-drawer-open');
        moCb?.();
        assert.strictEqual(wordsCalls, initialWordsCalls, 'unrelated body class mutation skips snapshot');

        // 真正切到播放态时 bodyObserver 立即触发同步
        app.isPlaying = true;
        window.document.body.classList.add('music-playing');
        moCb?.();
        assert.strictEqual(published.length, 2, 'music-playing class transition triggers publish');
        assert.strictEqual(published[1].playing, true);
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        window.close();
    }
});

test('Batch 73: desktop-lyrics wordsOf WeakMap cache reuses packed words across polls and invalidates on mutation', () => {
    let calls = 0;
    global.MusicArchiveLyrics = {
        wordsOf: (line) => { calls += 1; return line.words || null; }
    };
    try {
        const line0 = { time: 2, text: 'ab', words: [word('a', 2, 3), word('b', 3, 4)] };
        const app = {
            playlist: [{ path: 'a.flac', title: 'T', artist: 'A' }],
            currentTrackIndex: 0,
            isPlaying: true,
            currentLyrics: [line0]
        };
        const s1 = snapshot(app, 2.2);
        const s2 = snapshot(app, 2.5);
        const s3 = snapshot(app, 2.8);
        assert.strictEqual(calls, 1, 'repeated snapshots on same lyric line hit WeakMap cache');
        assert.strictEqual(s1.line.words, s2.line.words);
        assert.strictEqual(s2.line.words, s3.line.words);

        line0.words.push(word('c', 4, 5));
        const s4 = snapshot(app, 4.1);
        assert.strictEqual(calls, 2, 'mutated line.words length invalidates cache');
        assert.strictEqual(s4.line.words.length, 3);
    } finally {
        delete global.MusicArchiveLyrics;
    }
});
