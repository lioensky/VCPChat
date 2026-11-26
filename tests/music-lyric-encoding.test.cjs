// 歌词目录里自己放的 .lrc：GBK、带 BOM 的 UTF-8、UTF-16（记事本「Unicode」）都要读成正确的文字。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function lyricHandler(dir) {
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
    return handlers.get('music-get-lyrics');
}

const LRC = '[00:01.00]你好世界\n[00:02.00]さよなら';
const gbk = Buffer.from([0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]); // [00:01.00]你好世界

test('local .lrc files in GBK, UTF-8 with BOM and UTF-16 are decoded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-lrc-'));
    const lyric = path.join(dir, 'lyric');
    fs.mkdirSync(lyric);
    fs.writeFileSync(path.join(lyric, '甲 - gbk.lrc'), gbk);
    fs.writeFileSync(path.join(lyric, '甲 - bom.lrc'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LRC)]));
    fs.writeFileSync(path.join(lyric, '甲 - u16.lrc'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LRC, 'utf16le')]));
    fs.writeFileSync(path.join(lyric, '甲 - plain.lrc'), LRC);
    const get = lyricHandler(dir);
    assert.equal(await get({}, { artist: '甲', title: 'gbk' }), '[00:01.00]你好世界');
    assert.equal(await get({}, { artist: '甲', title: 'bom' }), LRC);
    assert.equal(await get({}, { artist: '甲', title: 'u16' }), LRC);
    assert.equal(await get({}, { artist: '甲', title: 'plain' }), LRC);
});
