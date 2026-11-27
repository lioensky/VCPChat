const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// AI 点歌/控制在音乐窗口「正在创建」时到达：页面脚本还没跑，直接发给窗口的消息会落空。
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/ipc/musicHandlers.js'), 'utf8');

function harness() {
    const ipcMain = new EventEmitter();
    const sent = [];
    const win = new EventEmitter();
    Object.assign(win, {
        isDestroyed: () => false, isVisible: () => true, show() {}, focus() {},
        webContents: { send: (channel, payload) => sent.push({ channel, payload }) }
    });
    const playlist = [{ path: 'D:\\m\\a.flac', title: '晴天', artist: '周杰伦' }, { path: 'D:\\m\\b.flac', title: '夜曲' }];
    const context = {
        module: { exports: {} }, console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout,
        __dirname: path.join(root, 'modules/ipc'),
        require(name) {
            if (name === 'electron') return { ipcMain };
            if (name === 'fs-extra') return { pathExists: async () => true, readJson: async () => playlist };
            if (name === '../musicTrackMatch') return require(path.join(root, 'modules/musicTrackMatch'));
            if (name === '../lyrics/lyricsMarkdown') return { formatCurrentLyrics: () => '当前未加载歌曲，没有歌词。' };
            if (['path', 'crypto', 'worker_threads'].includes(name)) return require(name);
            return {};
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    let finish;
    context.testWindow = win;
    context.creation = new Promise((resolve) => { finish = resolve; });
    // 模拟窗口已建出来、渲染端还没就绪：musicWindow 有了，创建 promise 未完成
    vm.runInContext('musicWindow = testWindow; musicWindowPromise = creation; creation.then(() => { musicWindowPromise = null; });', context);
    const pending = () => vm.runInContext('pendingPlaybackForNewWindow', context);
    const takePending = () => vm.runInContext('(() => { const p = pendingPlaybackForNewWindow; pendingPlaybackForNewWindow = null; return p; })()', context);
    return { control: context.module.exports.handleMusicControl, sent, ready: () => finish(win), pending, takePending };
}

test('play during window creation: the renderer picks it up as its pending request, nothing is sent to a page that is not listening', async () => {
    const h = harness();
    const result = h.control({ command: 'play', target: '晴天' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.sent.length, 0, 'sent to the window before it was ready');
    assert.equal(h.pending()?.track?.title, '晴天');
    h.takePending(); // 渲染端初始化时取走
    h.ready();
    assert.equal((await result).status, 'success');
    assert.equal(h.sent.length, 0, 'the renderer already took it; do not play it twice');
});

test('play arriving after the renderer already read its pending request is delivered once the window is ready', async () => {
    const h = harness();
    h.takePending(); // 渲染端在点歌到达之前就取过（那时是空的）
    const result = h.control({ command: 'play', target: '夜曲' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.sent.length, 0, 'sent to the window before it was ready');
    h.ready();
    assert.equal((await result).status, 'success');
    assert.deepEqual(h.sent.map((m) => [m.channel, m.payload.track.title]), [['music-set-track', '夜曲']]);
    assert.equal(h.pending(), null);
});

test('pause during window creation waits for the window instead of going nowhere', async () => {
    const h = harness();
    const result = h.control({ command: 'pause' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.sent.length, 0);
    h.ready();
    await result;
    assert.deepEqual(h.sent.map((m) => [m.channel, m.payload]), [['music-control', 'pause']]);
});

test('music-library-folders rescan runs without requiring a folder path', async () => {
    const handlers = new Map();
    const ipcMain = Object.assign(new EventEmitter(), { handle: (name, fn) => handlers.set(name, fn) });
    const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { send() {} } });
    let rescans = 0;
    const context = {
        module: { exports: {} }, console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout,
        __dirname: path.join(root, 'modules/ipc'),
        require(name) {
            if (name === 'electron') return { ipcMain, BrowserWindow: function () {}, app: { getPath: () => root }, dialog: {}, shell: {}, nativeTheme: {} };
            if (name === 'fs-extra') return { pathExists: async () => false, ensureDirSync() {}, stat: async () => null };
            if (name === '../musicLibraryWatch') return { createLibraryWatch: () => ({ folders: async () => [], rescanNow: async () => { rescans++; }, start() {}, stop() {}, rememberFolder: async () => {}, forgetFolder: async () => {}, noteLibrarySaved() {} }) };
            if (name === '../services/audioEngineEndpoint') return { onStatus() {}, getBaseUrl: () => 'http://127.0.0.1:43789', getStatus: () => ({ state: 'ready' }) };
            if (name === '../musicWindowBounds') return { readSavedBounds: () => null, writeSavedBounds() {} };
            if (name === '../musicThumbar') return { createMusicThumbar: () => ({ update() {}, reset() {} }) };
            if (name === '../services/musicGrooveBus') return { publish() {} };
            if (name === './musicDesktopLyrics') return { createDesktopLyrics: () => ({ musicClosed() {} }) };
            if (['path', 'crypto', 'worker_threads'].includes(name)) return require(name);
            return {};
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    context.module.exports.initialize({ mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: root });
    context.testWin = win;
    vm.runInContext('musicWindow = testWin;', context);
    const res = await handlers.get('music-library-folders')({ sender: win.webContents }, { op: 'rescan' });
    assert.equal(res.ok, true);
    assert.equal(rescans, 1);
});

test('Batch 69: handleMusicControl safely skips windows with destroyed webContents instead of throwing', async () => {
    const ipcMain = new EventEmitter();
    let sendCalls = 0;
    const win = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        webContents: {
            isDestroyed: () => true,
            send: () => { sendCalls += 1; throw new Error('Object has been destroyed'); }
        }
    });
    const context = {
        module: { exports: {} }, console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout,
        __dirname: path.join(root, 'modules/ipc'),
        require(name) {
            if (name === 'electron') return { ipcMain };
            if (name === 'fs-extra') return { pathExists: async () => false, readJson: async () => [] };
            if (name === '../musicTrackMatch') return require(path.join(root, 'modules/musicTrackMatch'));
            if (name === '../lyrics/lyricsMarkdown') return { formatCurrentLyrics: () => '当前未加载歌曲，没有歌词。' };
            if (['path', 'crypto', 'worker_threads'].includes(name)) return require(name);
            return {};
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    context.testWindow = win;
    vm.runInContext('musicWindow = testWindow;', context);

    const nextRes = await context.module.exports.handleMusicControl({ command: 'next' });
    assert.equal(nextRes.status, 'error');
    assert.equal(sendCalls, 0, 'never calls send() when webContents.isDestroyed() is true');

    const lyricsRes = await context.module.exports.handleMusicControl({ command: 'getCurrentLyrics' });
    assert.equal(lyricsRes.status, 'success');
    assert.equal(sendCalls, 0, 'getCurrentLyrics skips destroyed webContents cleanly');
});
