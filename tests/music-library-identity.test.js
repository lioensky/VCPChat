const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 曲库被整体换成新对象（重新扫描文件夹、删歌之后）时，播放上下文、手动队列和播放历史
// 里留着的旧对象不能让「下一首 / 上一首 / 预载」去加载第 -1 首。
function setup({ mode = 'repeat', count = 6 } = {}) {
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        document: { body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, dispatchEvent() {} },
        navigator: {},
        localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })()
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-player.js'), 'utf8'), context);
    const make = (i) => ({ path: `C:/m/${i}.flac`, title: `t${i}` });
    const playlist = Array.from({ length: count }, (_, i) => make(i));
    const preloads = [];
    const loads = [];
    const app = {
        playlist,
        currentTrackIndex: 0,
        currentFilteredTracks: null,
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: ['repeat', 'repeat-one', 'shuffle'].indexOf(mode),
        shuffleQueue: [],
        pendingLoadRequestId: 0,
        normalizePathForCompare: (p) => (p || '').toLowerCase(),
        api: { queueNextMusicTrack: async (t) => { preloads.push(t.path); return { status: 'success' }; } }
    };
    context.setupPlayer(app);
    app.loadTrack = (i) => { loads.push(i); if (i >= 0) { app.rememberPlayed(app.playlist[i]); app.currentTrackIndex = i; } };
    const rescan = (drop = []) => { app.playlist = app.playlist.filter((t) => !drop.includes(t.path)).map((t) => ({ ...t })); };
    return { app, loads, preloads, rescan, make };
}

test('next in a playlist context after the library was reloaded stays inside the context', () => {
    const { app, loads, rescan } = setup();
    app.playFromContext([app.playlist[4], app.playlist[2], app.playlist[5]], 4, { render: false });
    app.currentTrackIndex = 4;
    rescan();
    app.currentTrackIndex = app.playlist.findIndex((t) => t.path === 'C:/m/4.flac');
    app.nextTrack();
    assert.equal(loads.at(-1), 2, 'goes on to the next track of the same playlist');
    app.nextTrack();
    assert.equal(loads.at(-1), 5);
});

test('tracks deleted from the library are skipped, not loaded as index -1', () => {
    const { app, loads, rescan } = setup();
    app.playFromContext([app.playlist[1], app.playlist[3], app.playlist[5]], 1, { render: false });
    app.currentTrackIndex = 1;
    rescan(['C:/m/3.flac']);
    app.currentTrackIndex = app.playlist.findIndex((t) => t.path === 'C:/m/1.flac');
    app.nextTrack();
    assert.ok(loads.every((i) => i >= 0), `loaded ${JSON.stringify(loads)}`);
    assert.equal(app.playlist[loads.at(-1)].path, 'C:/m/5.flac');
});

test('the manual queue survives a library reload', () => {
    const { app, loads, rescan } = setup();
    app.queueAdd(app.playlist[3]);
    rescan();
    app.nextTrack();
    assert.equal(app.playlist[loads.at(-1)].path, 'C:/m/3.flac');
});

test('previous after a library reload goes back to the track heard before', () => {
    const { app, loads, rescan } = setup();
    app.loadTrack(2);
    app.loadTrack(4);
    rescan();
    app.currentTrackIndex = 4;
    app.prevTrack();
    assert.equal(loads.at(-1), 2);
});

test('preload after a library reload picks a real track of the context', async () => {
    const { app, preloads, rescan } = setup();
    app.playFromContext([app.playlist[0], app.playlist[3]], 0, { render: false });
    app.currentTrackIndex = 0;
    rescan();
    app.isPreloadingNext = false;
    await app.handleNeedsPreload();
    assert.equal(preloads.at(-1), 'C:/m/3.flac');
});

test('shuffle after a library reload never loads index -1', () => {
    const { app, loads, rescan } = setup({ mode: 'shuffle' });
    app.playFromContext([app.playlist[0], app.playlist[2], app.playlist[4]], 0, { render: false });
    app.currentTrackIndex = 0;
    app.nextTrack();
    rescan(['C:/m/2.flac']);
    for (let i = 0; i < 6; i++) app.nextTrack();
    assert.ok(loads.every((i) => i >= 0), `loaded ${JSON.stringify(loads)}`);
});

test('shuffle over the whole library after a track was removed in place never loads index -1', () => {
    const { app, loads } = setup({ mode: 'shuffle', count: 4 });
    app.nextTrack();
    app.playlist.splice(0, 2); // 右键「从曲库移除」是原地删
    app.currentTrackIndex = 0;
    for (let i = 0; i < 6; i++) app.nextTrack();
    assert.ok(loads.every((i) => i >= 0 && i < app.playlist.length + 2), `loaded ${JSON.stringify(loads)}`);
    assert.ok(loads.slice(1).every((i) => i >= 0 && i < 2), `after the removal only the 2 remaining tracks: ${JSON.stringify(loads)}`);
});
