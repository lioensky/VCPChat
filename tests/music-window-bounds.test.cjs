// 音乐窗口回到上次的位置和大小；那块屏拔掉了、分辨率变小了，窗口不能落在看不见的地方。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { restoreBounds } = require('../modules/musicWindowBounds');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };
const limits = { minWidth: 420, minHeight: 600 };

test('bounds on a screen that is still there come back unchanged', () => {
    assert.deepEqual(restoreBounds({ x: 2100, y: 80, width: 1400, height: 900, maximized: false }, [primary, right], limits),
        { x: 2100, y: 80, width: 1400, height: 900, maximized: false });
    assert.equal(restoreBounds({ x: 100, y: 50, width: 1280, height: 700, maximized: true }, [primary], limits).maximized, true);
});

test('a window that was on an unplugged monitor falls back to the default position', () => {
    assert.equal(restoreBounds({ x: 2100, y: 80, width: 1400, height: 900 }, [primary], limits), null);
    assert.equal(restoreBounds({ x: -5000, y: -5000, width: 800, height: 600 }, [primary, right], limits), null);
});

test('a window hanging off the edge or bigger than the screen is moved and shrunk to fit', () => {
    const r = restoreBounds({ x: 1700, y: -300, width: 1400, height: 900 }, [primary], limits);
    assert.deepEqual(r, { x: 520, y: 0, width: 1400, height: 900, maximized: false });
    const small = { x: 0, y: 0, width: 1366, height: 728 };
    assert.deepEqual(restoreBounds({ x: 200, y: 100, width: 1800, height: 1000 }, [small], limits),
        { x: 0, y: 0, width: 1366, height: 728, maximized: false });
});

test('garbage in the saved file is ignored', () => {
    for (const bad of [null, 'x', {}, { x: 'a', y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: -1, height: 100 }]) {
        assert.equal(restoreBounds(bad, [primary], limits), null);
    }
    assert.equal(restoreBounds({ x: 0, y: 0, width: 1000, height: 700 }, [], limits), null);
});

test('the music window saves its bounds on close and opens there next time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bounds-'));
    const created = [];
    class FakeWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.maximized = false;
            this.webContents = new EventEmitter();
            this.webContents.send = () => {};
            created.push(this);
        }
        loadFile() {} setMenu() {} show() {} focus() {}
        isDestroyed() { return false; } isVisible() { return true; } isMaximized() { return this.maximized; }
        maximize() { this.maximized = true; }
        getNormalBounds() { return { x: 2200, y: 120, width: 1500, height: 950 }; }
    }
    const electron = {
        ipcMain: new EventEmitter(), BrowserWindow: FakeWindow, dialog: {}, shell: {}, nativeTheme: {},
        app: { getPath: () => dir, isPackaged: false, getAppPath: () => dir },
        screen: { getAllDisplays: () => [{ workArea: primary }, { workArea: right }] }
    };
    electron.ipcMain.handle = () => {};
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    let music;
    try {
        for (const f of Object.keys(require.cache)) if (/modules[\\/](ipc[\\/]musicHandlers|services[\\/]windowService)/.test(f)) delete require.cache[f];
        music = require('../modules/ipc/musicHandlers.js');
        music.initialize({ mainWindow: null, openChildWindows: [], startAudioEngine: async () => {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    } finally {
        Module._load = original;
    }
    const open = async () => { music.createOrFocusMusicWindow().catch(() => {}); await new Promise((r) => setTimeout(r, 30)); return created[created.length - 1]; };

    const first = await open();
    assert.equal(first.options.x, undefined, 'first open uses the default position');
    first.maximized = true;
    first.emit('close', { preventDefault() {} });
    first.emit('closed');

    const second = await open();
    assert.deepEqual([second.options.x, second.options.y, second.options.width, second.options.height], [2200, 120, 1500, 950]);
    second.emit('ready-to-show');
    assert.equal(second.maximized, true, 'reopens maximized');
    second.emit('closed');
});

test('writeSavedBounds ignores degenerate dimensions and musicThumbar retries when setThumbarButtons returns false', () => {
    const { writeSavedBounds, readSavedBounds } = require('../modules/musicWindowBounds');
    const { createMusicThumbar } = require('../modules/musicThumbar');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bounds-guard-'));
    const file = path.join(dir, 'bounds.json');

    writeSavedBounds(file, {
        isDestroyed: () => false,
        isMaximized: () => false,
        getNormalBounds: () => ({ x: 100, y: 120, width: 1200, height: 800 })
    });
    // 最小化/异常 0 宽高不能覆盖之前保存的有效坐标
    writeSavedBounds(file, {
        isDestroyed: () => false,
        isMaximized: () => false,
        getNormalBounds: () => ({ x: -32000, y: -32000, width: 0, height: 0 })
    });
    assert.deepEqual(readSavedBounds(file), { x: 100, y: 120, width: 1200, height: 800, maximized: false });

    let calls = 0;
    let shouldSucceed = false;
    const sent = [];
    const thumbar = createMusicThumbar({
        nativeImage: { createFromPath: (p) => p },
        platform: 'win32'
    });
    let lastButtons = null;
    const fakeWin = {
        id: 7,
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (_ch, cmd) => sent.push(cmd) },
        setThumbarButtons: (btns) => {
            calls += 1;
            lastButtons = btns;
            return shouldSucceed;
        }
    };
    assert.equal(thumbar.update(fakeWin, { playing: false }), false, 'returns false when taskbar button not ready');
    shouldSucceed = true;
    assert.equal(thumbar.update(fakeWin, { playing: false }), true, 'retries same state instead of caching failed call');
    assert.equal(thumbar.update(fakeWin, { playing: false }), false, 'dedupes after success');
    assert.equal(calls, 2);
    lastButtons[1].click();
    assert.deepEqual(sent, ['play']);
    fakeWin.webContents.isDestroyed = () => true;
    lastButtons[2].click();
    assert.deepEqual(sent, ['play'], 'click ignores destroyed webContents');
});

test('writeSavedBounds creates missing parent directories and writes atomically without stray tmp files', () => {
    const { writeSavedBounds, readSavedBounds } = require('../modules/musicWindowBounds');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'music-bounds-atomic-'));
    const nestedDir = path.join(base, 'nested', 'state');
    const file = path.join(nestedDir, 'bounds.json');
    writeSavedBounds(file, {
        isDestroyed: () => false,
        isMaximized: () => true,
        getNormalBounds: () => ({ x: 40, y: 60, width: 1280, height: 820 })
    });
    assert.deepEqual(readSavedBounds(file), { x: 40, y: 60, width: 1280, height: 820, maximized: true });
    const entries = fs.readdirSync(nestedDir);
    assert.deepEqual(entries, ['bounds.json'], 'atomic rename leaves no temporary files behind');
});
