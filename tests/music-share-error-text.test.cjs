// 从音乐窗口「分享到聊天」失败时的提示文字：原来是一串乱码（「未知错误」被按 GBK 解码后存进了源码）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the shared-file failure message is readable', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'inputEnhancer.js'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('results[0].error ? results[0].error :'));
    assert.ok(line, 'fallback message line found');
    assert.match(line, /'未知错误'/);
});

test('sharing refuses remote tracks and files that are gone, forwards local ones', async () => {
    const os = require('node:os');
    const Module = require('node:module');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-share-'));
    const song = path.join(dir, 'a.mp3');
    fs.writeFileSync(song, 'x');
    const handlers = new Map();
    const electron = {
        ipcMain: { on() {}, handle: (n, fn) => handlers.set(n, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const forwarded = [];
    const mainWindow = { isDestroyed: () => false, isMinimized: () => false, focus() {}, restore() {}, webContents: { send: (c, p) => forwarded.push([c, p]) } };
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    try {
        const file = require.resolve('../modules/ipc/musicHandlers.js');
        delete require.cache[file];
        require(file).initialize({ mainWindow, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    } finally {
        Module._load = original;
    }
    const share = handlers.get('music-share-track');
    assert.equal((await share({}, 'https://nas/dav/a.flac'))?.success, false);
    assert.equal((await share({}, path.join(dir, 'gone.mp3')))?.success, false);
    assert.equal(forwarded.length, 0);
    assert.equal((await share({}, song))?.success, true);
    assert.deepEqual(forwarded, [['add-file-to-input', song]]);
});
