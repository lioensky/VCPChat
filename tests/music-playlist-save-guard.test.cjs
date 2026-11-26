// 曲库和歌单存盘的输入校验：不是数组不写；把非空列表写成空的时先留 .bak。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadHandlers(dir) {
    const handlers = new Map();
    const electron = {
        ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn), removeListener() {} },
        BrowserWindow: function () {}, app: { getPath: () => dir }, dialog: {}, shell: {}, nativeTheme: {}
    };
    const original = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
    try {
        const file = require.resolve('../modules/ipc/musicHandlers.js');
        delete require.cache[file];
        const music = require(file);
        music.initialize({ mainWindow: null, openChildWindows: [], startAudioEngine() {}, stopAudioEngine() {}, APP_DATA_ROOT_IN_PROJECT: dir });
    } finally {
        Module._load = original;
    }
    return handlers;
}

test('playlist saves reject non-arrays and back up before emptying', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-save-'));
    const h = loadHandlers(dir);
    const songlist = path.join(dir, 'songlist.json');
    const custom = path.join(dir, 'custom_playlists.json');
    const tracks = [{ path: 'D:\\a.flac', title: 'A' }];

    assert.deepEqual(await h.get('save-music-playlist')({}, tracks), { success: true });
    const bad = await h.get('save-music-playlist')({}, { not: 'an array' });
    assert.equal(bad.success, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(songlist, 'utf8')), tracks);

    assert.deepEqual(await h.get('save-music-playlist')({}, []), { success: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(songlist, 'utf8')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(songlist + '.bak', 'utf8')), tracks);
    // 已经是空的再存空：备份不被空列表覆盖
    await h.get('save-music-playlist')({}, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(songlist + '.bak', 'utf8')), tracks);

    const lists = [{ id: '1', name: 'L', tracks: ['D:\\a.flac'] }];
    await h.get('save-custom-playlists')({}, lists);
    assert.equal((await h.get('save-custom-playlists')({}, 'x')).success, false);
    await h.get('save-custom-playlists')({}, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(custom + '.bak', 'utf8')), lists);

    fs.writeFileSync(custom, '{"broken": true}');
    assert.deepEqual(await h.get('get-custom-playlists')({}), []);
    fs.rmSync(dir, { recursive: true, force: true });
});
