// 音乐窗口没有系统边框，页面进程崩了以后标题栏和关闭按钮都没了，引擎还在放：
// 主进程要把页面重新载入；反复崩溃时关掉窗口，不无限重来。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

async function openWindow(openChildWindows = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-crash-'));
    const created = [];
    class FakeWindow extends EventEmitter {
        constructor() {
            super();
            this.destroyed = false;
            this.reloads = 0;
            this.closes = 0;
            this.webContents = new EventEmitter();
            this.webContents.send = () => {};
            this.webContents.getURL = () => '';
            created.push(this);
        }
        loadFile() {} setMenu() {} show() {} focus() {}
        isDestroyed() { return this.destroyed; } isVisible() { return true; }
        reload() { this.reloads++; }
        close() { this.closes++; this.destroyed = true; this.emit('closed'); }
    }
    const electron = {
        ipcMain: new EventEmitter(), BrowserWindow: FakeWindow, app: { getPath: () => dir, isPackaged: false, getAppPath: () => dir },
        dialog: {}, shell: {}, nativeTheme: {}
    };
    electron.ipcMain.handle = () => {};
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    try {
        for (const f of Object.keys(require.cache)) if (/modules[\\/](ipc[\\/]musicHandlers|services[\\/]windowService)/.test(f)) delete require.cache[f];
        const music = require('../modules/ipc/musicHandlers.js');
        music.initialize({ mainWindow: null, openChildWindows, startAudioEngine: async () => {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
        music.createOrFocusMusicWindow?.().catch(() => {});
    } finally {
        Module._load = original;
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(created[0], 'window created');
    return created[0];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const crash = (win, reason = 'crashed') => win.webContents.emit('render-process-gone', {}, { reason, exitCode: 1 });

test('a crashed music page is reloaded instead of leaving a window that cannot be closed', async () => {
    const win = await openWindow();
    crash(win);
    await wait(400);
    assert.equal(win.reloads, 1);
    assert.equal(win.closes, 0);
    crash(win, 'oom');
    await wait(400);
    assert.equal(win.reloads, 2);
    win.close();
});

test('a clean exit is not treated as a crash', async () => {
    const win = await openWindow();
    crash(win, 'clean-exit');
    await wait(400);
    assert.equal(win.reloads, 0);
    win.close();
});

test('crashing again and again closes the window instead of reloading forever', async () => {
    const win = await openWindow();
    for (let i = 0; i < 4; i++) crash(win);
    await wait(400);
    assert.equal(win.closes, 1);
    assert.equal(win.reloads, 0, 'the pending reloads must not touch a closed window');
});

test('closing musicWindow mutates shared openChildWindows in place without detaching array reference', async () => {
    const shared = [{ id: 'other' }];
    const win = await openWindow(shared);
    assert.equal(shared.length, 2);
    assert.equal(shared[1], win);
    win.close();
    assert.equal(shared.length, 1);
    assert.deepEqual(shared, [{ id: 'other' }]);
});
