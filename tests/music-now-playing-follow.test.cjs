// 「当前播放」注入：无缝切到下一首（不走 music-load）后要跟上，新旧渲染端都要。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.resolve(__dirname, '..');
function load(dir) {
    const handlers = new Map();
    const listeners = new Map();
    const electron = {
        ipcMain: { on: (n, fn) => listeners.set(n, fn), handle: (n, fn) => handlers.set(n, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const base = path.join(root, 'modules/ipc');
    const context = {
        module: { exports: {} }, console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, process, URL,
        __dirname: base,
        require: (name) => (name === 'electron' ? electron : require(name.startsWith('.') ? path.join(base, name) : name))
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(base, 'musicHandlers.js'), 'utf8'), context);
    context.module.exports.initialize({ mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    return { music: context.module.exports, handlers, listeners, setWindow: (w) => { context.w = w; vm.runInContext('musicWindow = w;', context); } };
}

test('the injected "now playing" follows a gapless track change', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-now-'));
    const playlist = [
        { path: 'D:\\m\\1.flac', title: '第一首', artist: '甲', album: 'A' },
        { path: 'D:\\m\\2.flac', title: '第二首', artist: '乙', album: 'B' },
        { path: 'D:\\m\\3.flac', title: '第三首', artist: '丙', album: 'C' }
    ];
    fs.writeFileSync(path.join(dir, 'songlist.json'), JSON.stringify(playlist));
    const { music, handlers, listeners, setWindow } = load(dir);
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    win.webContents = { send() {} };
    setWindow(win);
    await handlers.get('music-load')({}, playlist[0]).catch(() => {});
    assert.equal(music.getMusicState().currentSongInfo.title, '第一首');

    const publish = listeners.get('music-capsule-publish');
    // 新渲染端：直接带歌手专辑
    publish({ sender: win.webContents }, { title: '第二首', artist: '乙', album: 'B', trackKey: 'D:\\m\\2.flac', playing: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual({ ...music.getMusicState().currentSongInfo }, { title: '第二首', artist: '乙', album: 'B', path: 'D:\\m\\2.flac' });

    // 旧渲染端：只有标题和路径，从曲库里查
    publish({ sender: win.webContents }, { title: '第三首', trackKey: 'D:\\m\\3.flac', playing: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(music.getMusicState().currentSongInfo.artist, '丙');

    // 别的发送者不算
    publish({ sender: {} }, { title: 'x', artist: 'x', trackKey: 'D:\\m\\1.flac', playing: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(music.getMusicState().currentSongInfo.title, '第三首');
});
