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
