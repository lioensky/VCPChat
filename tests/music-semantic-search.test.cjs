// 语义搜索：失败时要说原因（以前只在控制台里），晚到的结果不能盖掉已经换掉的列表，
// 清空搜索框要回到整个曲库。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const utils = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-utils.js'), 'utf8');
const musicJs = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../modules/utils/vcpServerRoutes.js'), 'utf8');

const OUTPUT = '--- (来源: MusicDiary, 相关性: 70%)\n[路径: file:///MusicDiary/Song A-Singer.txt]\nSong A';

function setup({ settings = { vcpServerUrl: 'http://127.0.0.1:6005/v1/chat/completions', vcpApiKey: 'k' }, fetchImpl } = {}) {
    const toasts = [];
    const classList = () => ({ add() {}, remove() {}, toggle() {} });
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, URL,
        document: { getElementById: () => null, querySelector: () => null },
        MusicToast: { show: (o) => toasts.push(o) },
        fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ result: OUTPUT }) }))
    });
    context.window = context;
    vm.runInContext(routes, context);
    vm.runInContext(utils, context);
    const rendered = [];
    const app = {
        api: { loadSettings: async () => settings },
        playlist: [{ path: 'C:/m/a.flac', title: 'Song A', artist: 'Singer' }, { path: 'C:/m/b.flac', title: 'Other', artist: 'X' }],
        semanticSearchBtn: { classList: classList() },
        searchInput: { value: 'rainy night' },
        sidebarTabs: [],
        isSemanticSearchActive: true,
        currentFilteredTracks: null,
        renderPlaylist: (list) => rendered.push(list)
    };
    context.setupUtils(app);
    return { app, toasts, rendered };
}

test('a semantic search with no server configured says so instead of failing silently', async () => {
    const { app, toasts } = setup({ settings: {} });
    await app.performSemanticSearch('rainy night');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].message, /语义搜索没有完成：还没有设置 VCP 服务器地址/);
    assert.equal(app.isSemanticSearching, false);
});

test('a server that cannot be reached is reported in plain words', async () => {
    const { app, toasts } = setup({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await app.performSemanticSearch('rainy night');
    assert.match(toasts[0]?.message || '', /连不上 VCP 服务器/);
});

test('results that come back after semantic search was switched off do not replace the list', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { app, rendered, toasts } = setup({ fetchImpl: async () => { await gate; return { ok: true, json: async () => ({ result: OUTPUT }) }; } });
    const pending = app.performSemanticSearch('rainy night');
    app.isSemanticSearchActive = false; // 用户关掉了语义搜索
    release();
    await pending;
    assert.deepEqual(rendered, []);
    assert.equal(toasts.length, 0);
});

test('a finished semantic search shows the matches and is no longer tied to a playlist', async () => {
    const { app, rendered } = setup();
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1' };
    await app.performSemanticSearch('rainy night');
    assert.deepEqual([...rendered.at(-1).map((t) => t.title)], ['Song A']);
    assert.equal(app.filteredPlaylistSource, null);
});

test('clearing the search box in semantic mode goes back to the whole library', () => {
    const start = musicJs.indexOf('        app.searchInput.oninput = (e) => {');
    const end = musicJs.indexOf('\n        };\n', start);
    assert.ok(start > 0 && end > start);
    const rendered = [];
    const app = {
        isSemanticSearchActive: true, searchInput: { value: '' },
        currentFilteredTracks: [{ path: 'C:/m/a.flac' }], filteredPlaylistSource: null,
        renderPlaylist: (list) => rendered.push(list)
    };
    vm.runInNewContext(`${musicJs.slice(start, end + 11)}`, { app, setTimeout, clearTimeout });
    app.searchInput.oninput({});
    assert.equal(app.currentFilteredTracks, null);
    assert.deepEqual(rendered, [null]);
});

test('Batch 70: stripAudioExtension handles .aif/.aiff and semantic playlist lines recognize extended audio formats', () => {
    const { app, rendered } = setup();
    assert.equal(app.stripAudioExtension('Prelude.aif'), 'Prelude');
    assert.equal(app.stripAudioExtension('Prelude.AIFF'), 'Prelude');
    assert.equal(app.stripAudioExtension('Track.opus'), 'Track');
    app.playlist = [
        { path: 'C:/m/1.opus', title: 'Midnight Echo', artist: 'A' },
        { path: 'C:/m/2.aif', title: 'Dawn Breeze', artist: 'B' },
        { path: 'C:/m/3.wv', title: 'Rainy Window', artist: 'C' }
    ];
    const output = '--- (来源: MusicDiary, 相关性: 80%)\n[路径: file:///MusicDiary/playlist.txt]\nMidnight Echo.opus\nDawn Breeze.aif\nRainy Window.wv\n';
    app.processSemanticSearchResults(output);
    assert.deepEqual(Array.from(rendered.at(-1), (t) => t.title), ['Midnight Echo', 'Dawn Breeze', 'Rainy Window']);
});
