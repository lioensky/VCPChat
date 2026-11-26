// 曲库、歌单存盘失败（磁盘满、文件被占用、没有权限）时，以前没人看主进程回的结果：
// 界面上改好了，重开播放器就没了，用户完全不知道。现在要弹提示。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(api) {
    const toasts = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, Promise,
        MusicToast: { show: (o) => { toasts.push(o); return {}; } },
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }) },
        window: {}
    });
    context.window = context;
    for (const name of ['music-error-text.js', 'music-sidebar.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules', name), 'utf8'), context);
    }
    const app = { api, playlist: [{ path: 'a' }], customPlaylists: [{ id: '1', name: 'P', tracks: [] }] };
    context.setupSidebar(app);
    return { app, toasts };
}

test('a playlist save the main process could not write shows why', async () => {
    const { app, toasts } = setup({ saveCustomPlaylists: async () => ({ success: false, error: 'ENOSPC: no space left on device, write' }) });
    await app.saveCustomPlaylists();
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].kind, 'error');
    assert.match(toasts[0].message, /歌单没能存盘（磁盘空间不够）/);
});

test('a library save that throws shows a message too', async () => {
    const { app, toasts } = setup({ saveMusicPlaylist: async () => { throw new Error("Error invoking remote method 'save-music-playlist': Error: EBUSY: resource busy or locked"); } });
    const result = await app.saveLibrary();
    assert.equal(result.success, false);
    assert.match(toasts[0].message, /曲库没能存盘（文件被别的程序占用）/);
});

test('a successful save stays quiet', async () => {
    const { app, toasts } = setup({ saveMusicPlaylist: async () => ({ success: true }), saveCustomPlaylists: async () => ({ success: true }) });
    await app.saveLibrary();
    await app.saveCustomPlaylists();
    assert.equal(toasts.length, 0);
});

test('every library save in the window goes through the checked save', () => {
    const dir = path.join(__dirname, '../Musicmodules');
    for (const file of ['music.js', 'music-webdav.js']) {
        assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /api\??\.saveMusicPlaylist/, file);
    }
});
