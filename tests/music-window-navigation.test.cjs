// 音乐窗口只停在自己的页面上：拖进文件等导致的跳转被拦下。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

test('the music window refuses to navigate away from its own page', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-nav-'));
    const created = [];
    class FakeWindow extends EventEmitter {
        constructor() {
            super();
            this.webContents = new EventEmitter();
            this.webContents.send = () => {};
            this.webContents.getURL = () => '';
            this.webContents.setWindowOpenHandler = (fn) => { this.windowOpenHandler = fn; };
            created.push(this);
        }
        loadFile() {} setMenu() {} show() {} focus() {} isDestroyed() { return false; } isVisible() { return true; }
    }
    const electron = {
        ipcMain: new EventEmitter(), BrowserWindow: FakeWindow, app: { getPath: () => dir, isPackaged: false, getAppPath: () => dir },
        dialog: {}, shell: {}, nativeTheme: {}
    };
    electron.ipcMain.handle = () => {};
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    let music;
    try {
        for (const f of Object.keys(require.cache)) if (/modules[\\/](ipc[\\/]musicHandlers|services[\\/]windowService)/.test(f)) delete require.cache[f];
        music = require('../modules/ipc/musicHandlers.js');
        music.initialize({ mainWindow: null, openChildWindows: [], startAudioEngine: async () => {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
        music.createOrFocusMusicWindow?.().catch(() => {});
    } finally {
        Module._load = original;
    }
    await new Promise((r) => setTimeout(r, 30));
    const win = created[0];
    assert.ok(win, 'window created');
    const navigate = (url) => {
        let prevented = false;
        win.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
        return prevented;
    };
    assert.equal(navigate('file:///C:/Users/me/Music/song.mp3'), true);
    assert.equal(navigate('file:///C:/Users/me/Pictures/cover.png'), true);
    assert.equal(navigate('https://example.com/'), true);
    assert.equal(navigate('file:///C:/VCPChat/Musicmodules/music.html'), false);
    assert.equal(typeof win.windowOpenHandler, 'function', 'registers setWindowOpenHandler');
    assert.deepEqual(win.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
    win.emit('closed');
});
