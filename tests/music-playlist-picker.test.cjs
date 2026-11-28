/* 「加入歌单」选择器：只给歌单、最近用过的在前、打勾已含、筛选、就地新建、撤销；首页顶栏按钮和批量菜单都用它。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const read = (p) => fs.readFileSync(p, 'utf8');
const PICKER = read('Musicmodules/music-dock/music-playlist-picker.js');

function setup({ playlists } = {}) {
    const dom = new JSDOM('<!doctype html><body><button id="anchor">＋ 加入歌单</button></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    w.eval(PICKER);
    const toasts = [];
    w.MusicToast = { show: (t) => toasts.push(t) };
    let saved = 0, changed = 0;
    const app = {
        customPlaylists: playlists || [
            { id: 'a', name: '海边线路', tracks: ['/1', '/2'] },
            { id: 'b', name: '夜间散步', tracks: ['/3'] },
            { id: 'c', name: '通勤', tracks: [] }
        ],
        saveCustomPlaylists: () => { saved++; }
    };
    const doc = w.document;
    const anchor = doc.getElementById('anchor');
    const open = (paths, extra = {}) => w.MusicPlaylistPicker.open({ app, paths, anchor, label: '歌', onChange: () => { changed++; }, ...extra });
    const names = () => [...doc.querySelectorAll('.mpp-pl .mpp-name')].map((e) => e.textContent);
    const rowOf = (name) => [...doc.querySelectorAll('.mpp-pl')].find((e) => e.querySelector('.mpp-name').textContent === name);
    const key = (k, target = doc.activeElement || doc.body) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    return { w, doc, app, toasts, open, names, rowOf, key, anchor, saved: () => saved, changed: () => changed };
}

test('只列歌单，已含的打勾，点一个就加进去并收起，可撤销', () => {
    const f = setup();
    f.open(['/2']);
    assert.ok(f.doc.querySelector('.mpp'), '弹出了选择器');
    assert.equal(f.doc.querySelector('.context-menu'), null, '不是整张右键菜单');
    assert.deepEqual(f.names(), ['海边线路', '夜间散步', '通勤']);
    assert.equal(f.rowOf('海边线路').dataset.state, 'all');
    assert.equal(f.rowOf('夜间散步').dataset.state, 'none');
    assert.equal(f.doc.querySelector('.mpp-search'), null, '歌单少时不出筛选框');
    f.rowOf('夜间散步').click();
    assert.equal(f.doc.querySelector('.mpp'), null, '加完收起');
    assert.deepEqual(f.app.customPlaylists[1].tracks, ['/3', '/2']);
    assert.equal(f.saved(), 1);
    assert.equal(f.changed(), 1);
    assert.match(f.toasts.at(-1).message, /已加入「夜间散步」/);
    f.toasts.at(-1).action.run();
    assert.deepEqual(f.app.customPlaylists[1].tracks, ['/3'], '撤销');
    // 最近用过的排到最前
    f.open(['/9']);
    assert.deepEqual(f.names(), ['夜间散步', '海边线路', '通勤']);
});

test('点已经打勾的歌单是移出，可撤销', () => {
    const f = setup();
    f.open(['/1']);
    f.rowOf('海边线路').click();
    assert.deepEqual(f.app.customPlaylists[0].tracks, ['/2']);
    assert.match(f.toasts.at(-1).message, /移出/);
    f.toasts.at(-1).action.run();
    assert.deepEqual(f.app.customPlaylists[0].tracks, ['/1', '/2']);
});

test('多首：部分已含显示短横，只加缺的', () => {
    const f = setup();
    f.open(['/1', '/5']);
    assert.equal(f.rowOf('海边线路').dataset.state, 'some');
    f.rowOf('海边线路').click();
    assert.deepEqual(f.app.customPlaylists[0].tracks, ['/1', '/2', '/5']);
    assert.match(f.toasts.at(-1).message, /1 首/);
});

test('新建歌单：就地输入，回车建好并加进去', () => {
    const f = setup();
    f.open(['/7']);
    f.doc.querySelector('.mpp-new').click();
    const input = f.doc.querySelector('.mpp-name-input');
    assert.ok(input && f.doc.activeElement === input);
    input.value = '雨天';
    f.key('Enter', input);
    assert.equal(f.doc.querySelector('.mpp'), null);
    const pl = f.app.customPlaylists.at(-1);
    assert.equal(pl.name, '雨天');
    assert.deepEqual([...pl.tracks], ['/7']);
    f.toasts.at(-1).action.run();
    assert.equal(f.app.customPlaylists.length, 3, '撤销新建');
});

test('歌单多时有筛选框：打字筛，回车加第一个，筛不到回车就用这个名字新建', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, name: ['通勤', '写代码', '睡前', '周末', '雨天', '跑步', '老歌', '日语'][i], tracks: [] }));
    const f = setup({ playlists: many });
    f.open(['/1']);
    const search = f.doc.querySelector('.mpp-search');
    assert.ok(search && f.doc.activeElement === search, '焦点在筛选框');
    search.value = '雨';
    search.dispatchEvent(new f.w.Event('input'));
    assert.deepEqual(f.names(), ['雨天']);
    f.key('Enter', search);
    assert.deepEqual(many[4].tracks, ['/1']);
    f.open(['/2']);
    const s2 = f.doc.querySelector('.mpp-search');
    s2.value = '健身';
    s2.dispatchEvent(new f.w.Event('input'));
    assert.match(f.doc.querySelector('.mpp-empty').textContent, /回车新建/);
    f.key('Enter', s2);
    assert.equal(f.app.customPlaylists.at(-1).name, '健身');
    assert.deepEqual([...f.app.customPlaylists.at(-1).tracks], ['/2']);
});

test('键盘：方向键走、Esc 收起并把焦点还给按钮；再点按钮收起', () => {
    const f = setup();
    f.open(['/9']);
    const first = f.doc.querySelector('.mpp-pl');
    assert.equal(f.doc.activeElement, first);
    f.key('ArrowDown');
    assert.equal(f.doc.activeElement.querySelector('.mpp-name').textContent, '夜间散步');
    f.key('Escape');
    assert.equal(f.doc.querySelector('.mpp'), null);
    assert.equal(f.doc.activeElement, f.anchor);
    assert.equal(f.anchor.getAttribute('aria-expanded'), 'false');
    f.open(['/9']);
    f.anchor.dispatchEvent(new f.w.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    assert.equal(f.doc.querySelector('.mpp'), null, '点按钮收起');
});

// ───────── 首页接入 ─────────
const ARCHIVE = [read('Musicmodules/music-app-hooks.js')].concat(['model', 'scene', 'index', 'list', 'lyrics', 'view'].map((n) => read(`Musicmodules/music-archive/archive-${n}.js`)));
function archive() {
    const dom = new JSDOM('<!doctype html><body><div id="music-archive-view" hidden></div><button id="music-archive-return"></button></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.console.warn = () => {};
    w.eval(PICKER);
    for (const s of ARCHIVE) w.eval(s);
    const calls = [];
    const tracks = Array.from({ length: 12 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: 'A', album: 'B' }));
    const app = {
        playlist: tracks, customPlaylists: [{ id: 'p', name: '夜间散步', tracks: ['/m/5'] }],
        currentTrackIndex: 0, isPlaying: false, saveCustomPlaylists() {},
        loadTrack() {}, playTrack() {}, pauseTrack() {}, renderPlaylist() {},
        showContextMenu() { calls.push('ctx'); }, stageHost: { active: false, enter() {} }
    };
    const view = w.MusicArchive.init(app);
    return { w, app, view, calls, close: () => { view.destroy(); w.close(); } };
}

test('首页顶栏「⋯ 操作」打开整张曲目操作菜单（加入歌单在里面），不是歌单选择器', () => {
    const f = archive();
    try {
        const btn = f.w.document.querySelector('[data-act="save"]');
        assert.match(btn.textContent, /操作/);
        btn.click();
        assert.deepEqual(f.calls, ['ctx'], '打开了曲目右键菜单');
        assert.equal(f.w.document.querySelector('.mpp'), null);
    } finally { f.close(); }
});
