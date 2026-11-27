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

test('get-music-playlist reuses mtime+size cache after save and invalidates when modified on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-cache-'));
    const fse = require('fs-extra');
    let readJsonCalls = 0;
    const origReadJson = fse.readJson;
    fse.readJson = async function (...args) {
        if (String(args[0]).endsWith('songlist.json')) readJsonCalls += 1;
        return origReadJson.apply(this, args);
    };
    try {
        const h = loadHandlers(dir);
        const tracks = [{ path: 'D:\\cached.flac', title: 'Cached' }];
        assert.deepEqual(await h.get('save-music-playlist')({}, tracks), { success: true });
        assert.equal(readJsonCalls, 0, 'saving into an empty dir warms cache without reading songlist.json');
        const first = await h.get('get-music-playlist')({});
        const second = await h.get('get-music-playlist')({});
        assert.deepEqual(first, tracks);
        assert.deepEqual(second, tracks);
        assert.equal(readJsonCalls, 0, 'subsequent get-music-playlist hits mtime+size memory cache');

        const songlist = path.join(dir, 'songlist.json');
        const updated = [{ path: 'D:\\external.flac', title: 'External Update' }];
        fs.writeFileSync(songlist, JSON.stringify(updated));
        const third = await h.get('get-music-playlist')({});
        assert.deepEqual(third, updated, 'external disk edit invalidates cache via size/mtime');
        assert.equal(readJsonCalls, 1);
    } finally {
        fse.readJson = origReadJson;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
