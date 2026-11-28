// 拖进窗口的路径：文件夹整个扫（可按文件夹清理），单曲只读这几首（只加不删），其余路径忽略。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { scanFolder } = require('../modules/musicLibraryScanner');

function mp3(title) {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(title, 'latin1')]);
    const head = Buffer.alloc(10); head.write('TIT2', 0, 'latin1'); head.writeUInt32BE(body.length, 4);
    const frames = Buffer.concat([head, body]);
    const n = frames.length;
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
    const f = Buffer.alloc(417); f.set([0xff, 0xfb, 0x90, 0x00]);
    return Buffer.concat([header, frames, f, f, f]);
}

test('scanFolder with filePaths reads only those audio files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-files-'));
    for (const n of ['a.mp3', 'b.mp3', 'c.txt']) fs.writeFileSync(path.join(root, n), mp3(n));
    const result = await scanFolder({
        filePaths: [path.join(root, 'a.mp3'), path.join(root, 'c.txt'), path.join(root, 'a.mp3')],
        coverCachePath: path.join(root, 'covers')
    });
    assert.deepEqual(result.tracks.map((t) => path.basename(t.path)), ['a.mp3']);
});

test('music-add-paths scans dropped folders and files and ignores anything else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-drop-'));
    const album = path.join(dir, 'album');
    fs.mkdirSync(album);
    fs.writeFileSync(path.join(album, '1.mp3'), mp3('one'));
    fs.writeFileSync(path.join(dir, 'single.mp3'), mp3('single'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const handlers = new Map();
    const electron = {
        ipcMain: { on() {}, handle: (n, fn) => handlers.set(n, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    try {
        const file = require.resolve('../modules/ipc/musicHandlers.js');
        delete require.cache[file];
        require(file).initialize({ mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    } finally {
        Module._load = original;
    }
    const sent = [];
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    sender.send = (channel, payload) => sent.push({ channel, payload });
    const result = await handlers.get('music-add-paths')({ sender }, [
        album, path.join(dir, 'single.mp3'), path.join(dir, 'notes.txt'), 'relative.mp3', path.join(dir, 'missing.mp3'), 42
    ]);
    assert.deepEqual(result, { folders: 1, files: 1 });
    const completes = sent.filter((m) => m.channel === 'music-scan-complete').map((m) => m.payload);
    assert.equal(completes.length, 2);
    assert.equal(completes[0].folderPath, album);
    assert.deepEqual(completes[0].tracks.map((t) => path.basename(t.path)), ['1.mp3']);
    assert.equal(completes[1].folderPath, null, 'single files never prune the library');
    assert.deepEqual(completes[1].tracks.map((t) => path.basename(t.path)), ['single.mp3']);
    assert.deepEqual(await handlers.get('music-add-paths')({ sender }, 'nope'), { added: 0 });
});

test('dropping the same folder again while it is still being scanned does not read it a second time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-twice-'));
    const album = path.join(dir, 'album');
    fs.mkdirSync(album);
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(album, `${i}.mp3`), mp3(`t${i}`));
    const handlers = new Map();
    const electron = {
        ipcMain: { on() {}, handle: (n, fn) => handlers.set(n, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    try {
        const file = require.resolve('../modules/ipc/musicHandlers.js');
        delete require.cache[file];
        require(file).initialize({ mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    } finally {
        Module._load = original;
    }
    const sent = [];
    const sender = new EventEmitter();
    sender.id = 7;
    sender.isDestroyed = () => false;
    sender.send = (channel, payload) => sent.push({ channel, payload });
    const add = handlers.get('music-add-paths');
    await Promise.all([add({ sender }, [album]), add({ sender }, [album + path.sep])]);
    assert.equal(sent.filter((m) => m.channel === 'music-scan-start').length, 1, 'one scan for the folder');
    assert.equal(sent.filter((m) => m.channel === 'music-scan-complete').length, 1);
    // 扫完以后再拖一次是新的一次扫描（比如加了新歌）
    await add({ sender }, [album]);
    assert.equal(sent.filter((m) => m.channel === 'music-scan-start').length, 2);
});
