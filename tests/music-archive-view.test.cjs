/* 档案页的交互（没有 WebGL 时只剩文字层，交互仍然可用）：键盘、目录与检索、播放进舞台、经典视图。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const read = (p) => fs.readFileSync(p, 'utf8');
const SCRIPTS = [read('Musicmodules/music-app-hooks.js')].concat(['model', 'scene', 'index', 'list', 'lyrics', 'view'].map((n) => read(`Musicmodules/music-archive/archive-${n}.js`)));

const open = [];
test.afterEach(() => { while (open.length) open.pop()(); });
function fixture({ n = 30, playlists, tracks: given, setup } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="music-archive-view" hidden></div><button id="music-archive-return"></button></body>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} }; // jsdom 没有
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.console.warn = () => {};
    for (const s of SCRIPTS) w.eval(s);
    const tracks = given || Array.from({ length: n }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: i % 2 ? 'Aki' : 'Ren', album: 'A' + (i % 3) }));
    const calls = [];
    const app = {
        playlist: tracks,
        customPlaylists: playlists || [{ id: 'p', name: '夜间散步', tracks: ['/m/5', '/m/7', '/m/9'] }],
        currentTrackIndex: 0, isPlaying: false,
        loadTrack(i) { calls.push(['load', i, this.currentFilteredTracks ? this.currentFilteredTracks.length : null]); this.currentTrackIndex = i; },
        playTrack() { calls.push(['play']); }, pauseTrack() { calls.push(['pause']); },
        renderPlaylist() {}, showContextMenu() { calls.push(['ctx', this.contextMenuTrackIndex]); },
        stageHost: { active: false, enter() { calls.push(['stage']); this.active = true; } }
    };
    if (setup) setup(w, app);
    const view = w.MusicArchive.init(app);
    const key = (k, extra = {}) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    const text = (ref) => w.document.querySelector(`[data-ref="${ref}"]`).textContent;
    // 首页不再在 HUD 上写曲名：选中的是哪首看 debug().selected
    const selTitle = () => app.playlist[view.debug().selected]?.title;
    let closed = false;
    const close = () => { if (closed) return; closed = true; view.destroy(); w.close(); };
    open.push(close);
    return { w, app, view, calls, key, text, selTitle, close };
}

// 没有 WebGL 时没有 3D 场景；要测和场景打交道的部分（滚轮、封面），换成记录调用的假场景重新初始化。
// 画布是页面里真实的元素，事件才会落在它上面。
function withFakeScene(f, { log = [] } = {}) {
    f.view.destroy();
    f.app.archiveView = null;
    const w = f.w;
    const root = w.document.getElementById('music-archive-view');
    root.innerHTML = '';
    let canvas = null;
    const fake = {
        create: () => {
            canvas = w.document.createElement('canvas');
            root.appendChild(canvas);
            return {
                canvas, tier: { fps: 60, idleFps: 12 }, target: { lane: 0, row: 0 }, dirty: false,
                step: () => ({ moving: false, idle: false, animated: false }),
                select() {}, jump() {}, resize() {}, setTheme() {}, setPlaying() {}, setHover() {}, setPointer() {},
                touch() {}, raise() {}, setLabeler() {}, setLabelMask() {}, refreshLabels() {}, dispose() {}, pick: () => null, debug: () => ({}),
                setDetail() {}, setDetailRoom() {}, hold() {}, unhold() {}, turn() {}, detail: null, detailRect: () => null, dragAxes: () => null, camAt: () => null,
                setCover: (key, img, meta) => log.push({ img, title: meta.title })
            };
        }
    };
    const view = w.MusicArchive.init(f.app, { sceneLib: fake, pinyinSrc: false });
    const closeFixture = f.close;
    f.close = () => { view.destroy(); closeFixture(); };
    return { view, canvas: () => canvas, log };
}

test('默认显示档案页，选中正在播放的那首', () => {
    const f = fixture();
    assert.equal(f.view.mode, 'archive');
    assert.equal(f.w.document.getElementById('music-archive-view').hidden, false);
    assert.ok(f.w.document.body.classList.contains('music-archive-on'));
    assert.equal(f.selTitle(), 'Song 0');
    assert.equal(f.text('laneName'), '全部曲目');
    f.close();
});

test('方向键换曲目和歌单，底部计数跟着变', () => {
    const f = fixture();
    f.key('ArrowDown'); f.key('ArrowDown');
    assert.equal(f.selTitle(), 'Song 2');
    assert.equal(f.text('selT'), '30');
    f.key('ArrowRight');
    assert.equal(f.text('laneName'), '夜间散步');
    assert.equal(f.text('selT'), '03');
    assert.equal(f.view.debug().selected, 9); // 换列保持行号
    f.key('ArrowUp'); f.key('ArrowUp'); f.key('ArrowUp'); // 越过第一首，循环到这一列最后一首
    assert.equal(f.view.debug().selected, 9);
    f.close();
});

test('回车播放选中曲目、队列换成这一列，留在首页；Shift+回车播放并进舞台', () => {
    const f = fixture();
    f.key('ArrowRight'); f.key('ArrowDown');
    f.key('Enter');
    assert.deepEqual(f.calls.filter((c) => c[0] !== 'ctx'), [['load', 7, 3]]);
    assert.equal(f.app.filteredPlaylistSource.type, 'playlist');
    f.calls.length = 0;
    f.key('ArrowDown');
    f.key('Enter', { shiftKey: true });
    assert.deepEqual(f.calls.filter((c) => c[0] !== 'ctx'), [['load', 9, 3], ['stage']]);
    f.close();
});

test('已经在放的那首再按回车不重新加载；Shift+回车只进舞台', () => {
    const f = fixture();
    f.app.isPlaying = true;
    f.key('Enter');
    assert.deepEqual(f.calls, []);
    f.key('Enter', { shiftKey: true });
    assert.deepEqual(f.calls, [['stage']]);
    f.close();
});

const listEl = (f, name) => f.w.document.querySelector(`.archive-list [data-l="${name}"]`);
const listKey = (f, target, k, extra = {}) => target.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

test('「/」打开目录并聚焦检索框；输入即筛，第一条自动选中，阵列跟过去', () => {
    const f = fixture();
    f.view.setListOpen(false);
    f.key('/');
    const input = listEl(f, 'input');
    assert.equal(f.w.document.activeElement, input);
    assert.ok(f.w.document.querySelector('.archive-hud').classList.contains('list-open'));
    input.value = 'Song 1';
    listKey(f, input, 'Shift'); // 任意按键都会先把输入框里的词刷进去
    assert.equal(f.view.list.count, 17); // 每个词都要命中：Song 1、10–19，以及专辑 A1 里的
    assert.equal(f.view.debug().selected, 1);
    listKey(f, input, 'ArrowDown');
    assert.equal(f.view.debug().selected, 10);
    assert.equal(f.selTitle(), 'Song 10');
    f.close();
});

test('目录里回车只播放不进播放页；→ 进播放页；Esc 先清空再离开', () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.focusSearch();
    const input = listEl(f, 'input');
    input.value = 'Song 7';
    listKey(f, input, 'Enter');
    assert.deepEqual(f.calls, [['load', 7, 3]]); // 从检索结果点播：队列就是这 3 条结果
    assert.equal(f.app.filteredPlaylistSource.name, '检索结果');
    assert.equal(f.app.queueSourceName, '检索结果');
    f.calls.length = 0;
    f.app.isPlaying = true;
    input.setSelectionRange(input.value.length, input.value.length);
    listKey(f, input, 'ArrowRight');
    assert.deepEqual(f.calls, [['stage']]); // 已经在放这首了，只进播放页
    listKey(f, input, 'Escape');
    assert.equal(input.value, '');
    assert.equal(f.view.list.count, 30);
    listKey(f, input, 'Escape');
    assert.notEqual(f.w.document.activeElement, input);
    f.close();
});

test('LIST 按钮开关目录并记住；阵列里换选中，目录高亮跟着走', () => {
    const f = fixture();
    f.view.setListOpen(false);
    const btn = f.w.document.querySelector('[data-act="list"]');
    btn.click();
    assert.ok(!f.view.list.el.hidden);
    assert.equal(f.w.localStorage.getItem('musicArchiveList'), '1');
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown');
    const on = f.view.list.el.querySelector('.archive-list-row.on');
    assert.ok(on);
    assert.match(on.textContent, /Song 3/);
    btn.click();
    assert.ok(f.view.list.el.hidden);
    assert.equal(f.w.localStorage.getItem('musicArchiveList'), '0');
    f.close();
});

test('目录单击只选中，双击播放；歌单分类里的歌在阵列里落到那一列', () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.setKind('playlist');
    const rows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
    assert.equal(rows.length, 3);
    rows[1].dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
    assert.equal(f.text('laneName'), '夜间散步');
    assert.equal(f.view.debug().selected, 7);
    assert.deepEqual(f.calls, []);
    rows[1].dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
    assert.deepEqual(f.calls, [['load', 7, 3]]);
    f.close();
});

test('歌手分类按名字分组；切换分类会记住', async () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.setKind('artist');
    listEl(f, 'viewport').scrollTop = 0;
    f.view.list.render();
    await new Promise((r) => setTimeout(r, 60));
    const heads = [...f.view.list.el.querySelectorAll('.archive-list-group')].map((n) => n.querySelector('span').textContent);
    assert.deepEqual(heads.sort(), ['Aki', 'Ren']);
    assert.equal(f.w.localStorage.getItem('musicArchiveListKind'), 'artist');
    f.close();
});

test('没有时长就不显示时长；播放过的歌记下时长后显示', async () => {
    const f = fixture();
    f.view.setListOpen(true);
    const times = () => [...f.view.list.el.querySelectorAll('.archive-list-row .rt i')].map((n) => n.textContent).filter((t) => /:/.test(t));
    assert.deepEqual(times(), []);
    f.app.lastKnownDuration = 245.4;
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(times(), ['04:05']);
    assert.deepEqual(JSON.parse(f.w.localStorage.getItem('musicArchiveDurations')), { '/m/0': 245 });
    f.close();
});

test('输入框里打字不触发档案页快捷键', () => {
    const f = fixture();
    f.key('/');
    const input = listEl(f, 'input');
    listKey(f, input, 'l');
    listKey(f, input, ' ', { code: 'Space' });
    assert.deepEqual(f.calls, []);
    assert.ok(!f.view.list.el.hidden);
    f.close();
});

test('空格切换播放暂停；Home/End 到这一列第一首和最后一首，PageDown 走 10 首', () => {
    const f = fixture();
    f.key(' ', { code: 'Space' });
    assert.deepEqual(f.calls, [['play']]);
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown');
    f.key('Home');
    assert.equal(f.view.debug().selected, 0);
    f.key('End');
    assert.equal(f.view.debug().selected, 29);
    f.key('Home'); f.key('PageDown');
    assert.equal(f.view.debug().selected, 10);
    f.close();
});

test('经典视图隐藏档案页并记住；返回按钮回来', () => {
    const f = fixture();
    assert.equal(f.w.document.querySelector('.archive-footer [data-act="classic"]'), null, '页脚不再单独放「经典视图」');
    const sel = f.w.document.querySelector('.archive-layout-select');
    const before = sel.value;
    sel.value = 'classic';
    sel.dispatchEvent(new f.w.Event('change', { bubbles: true }));
    assert.equal(sel.value, before, '视图菜单仍然记着首页布局');
    assert.equal(f.view.mode, 'classic');
    assert.ok(f.w.document.body.classList.contains('music-archive-off'));
    assert.equal(f.w.localStorage.getItem('musicArchiveView'), 'classic');
    f.key('ArrowDown');
    assert.equal(f.selTitle(), 'Song 0'); // 经典视图里方向键不归档案页
    f.w.document.getElementById('music-archive-return').click();
    assert.equal(f.view.mode, 'archive');
    f.close();
});

test('空曲库显示空状态，回车什么也不做；刚打开的一小段先不说空（曲库可能还在读），曲库到了就直接是阵列', async () => {
    const f = fixture({ n: 0, playlists: [] });
    const root = f.w.document.getElementById('music-archive-view');
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    assert.equal(root.classList.contains('is-empty'), false, '刚打开不闪空状态');
    assert.ok(root.classList.contains('is-loading'));
    assert.equal(f.text('status'), '正在读取曲库');
    f.key('Enter');
    assert.deepEqual(f.calls, []);
    await wait(1650);
    assert.ok(root.classList.contains('is-empty'), '等过了还是没有歌才显示');
    assert.equal(f.text('emptyTitle'), '曲库是空的');
    assert.equal(root.classList.contains('is-loading'), false);
    assert.equal(f.text('status'), '');
    f.close();

    const g = fixture({ n: 0, playlists: [] });
    const groot = g.w.document.getElementById('music-archive-view');
    g.app.playlist = Array.from({ length: 12 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i }));
    g.view.refresh();
    assert.equal(groot.classList.contains('is-loading'), false);
    assert.equal(groot.classList.contains('is-empty'), false);
    assert.equal(g.text('status'), '');
    g.close();
});

test('过场期间继续画、开场动画期间不画；选中卡抬高的接口在', async () => {
    const f = fixture();
    const body = f.w.document.body.classList;
    const allowed = () => f.view.debug().allowed;
    assert.equal(typeof f.view.raise, 'function');
    assert.equal(typeof f.view.setThemeWave, 'function');
    assert.equal(allowed(), true);
    body.add('music-intro-playing');
    assert.equal(allowed(), false);
    body.remove('music-intro-playing');
    body.add('music-stage-active', 'music-stage-entering');
    await new Promise((r) => setTimeout(r, 0)); // 等 body 观察者
    assert.equal(allowed(), true);
    body.remove('music-stage-entering');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(allowed(), false);
    f.close();
});

const LIB = (() => {
    const words = ['Apple', 'Amber', 'Arc', 'Atlas', 'Blue', 'Bird', 'Bell', 'Bloom', 'Cloud', 'Coral', 'Delta', 'Echo',
        'Xeno', 'Yarn', 'Zest', 'あおぞら', 'あめ', 'いと', 'うみ', 'かぜ', '1999', '2046', '★Star'];
    return Array.from({ length: 46 }, (_, i) => ({ path: '/l/' + i, title: words[i % words.length] + ' ' + i, artist: 'A', album: 'X' + i }));
})();

test('曲库够大时全部曲目按首字母拆列，歌少的相邻字母合并', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    const ids = f.view.debug().columns.map((c) => c.id);
    assert.deepEqual([...ids], ['letter:A', 'letter:B', 'letter:C', 'letter:D-E', 'letter:S-X', 'letter:Y-Z', 'letter:あ-か', 'letter:0-9']);
    assert.equal(f.text('laneName'), 'A');
    // 每首歌只出现在一个字母列里
    const lettered = f.view.debug().columns.filter((c) => c.id.startsWith('letter:')).reduce((n, c) => n + c.n, 0);
    assert.equal(lettered, LIB.length);
    f.close();
});

test('字母列里回车播放，队列是整个曲库；目录里的行落到对应字母列', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    f.key('ArrowRight'); // B 列
    assert.equal(f.text('laneName'), 'B');
    f.key('Enter');
    assert.equal(f.calls[0][0], 'load');
    assert.equal(f.calls[0][2], LIB.length);
    f.view.setListOpen(true);
    f.view.list.focusSearch();
    const input = listEl(f, 'input');
    input.value = 'zest';
    listKey(f, input, 'Shift');
    assert.equal(f.text('laneName'), 'Y–Z');
    f.close();
});

test('有最近播放和收藏时排在最前面', () => {
    const f = fixture({
        tracks: LIB, playlists: [],
        setup: (w, app) => {
            w.localStorage.setItem('musicArchiveRecent', JSON.stringify(['/l/3', '/l/9']));
            app.favoriteTracks = ['/l/5'];
        }
    });
    const cols = f.view.debug().columns;
    assert.deepEqual(JSON.parse(JSON.stringify(cols.slice(0, 2).map((c) => [c.id, c.n]))), [['recent', 2], ['favorite', 1]]);
    f.close();
});

test('位置条：按下跳到对应位置，拖着走，悬停提示第几首和曲名', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    const bar = f.w.document.querySelector('[data-ref="rulerTrack"]');
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, width: 314, height: 40, right: 414, bottom: 40 });
    bar.setPointerCapture = () => {};
    const ev = (type, x) => {
        const e = new f.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        bar.dispatchEvent(e);
    };
    const n = f.view.debug().columns[0].n; // A 列
    ev('pointerdown', 100 + 313);           // 最右边
    assert.equal(bar.getAttribute('aria-valuenow'), String(n));
    assert.ok(bar.classList.contains('drag'));
    ev('pointermove', 100);                 // 拖回最左
    assert.equal(bar.getAttribute('aria-valuenow'), '1');
    assert.equal(f.view.debug().row, 0);
    const tip = f.w.document.querySelector('[data-ref="rulerTip"]');
    assert.ok(tip.classList.contains('on'));
    assert.match(tip.textContent, /^01 {2}\S/);
    ev('pointerup', 100);
    assert.ok(!bar.classList.contains('drag'));
    f.close();
});

test('滚轮停在位置条上逐首走、停在分组名上换组；场景里快速滚动松手后会再滑几格', async () => {
    const f = fixture({ n: 200 });
    const wheel = (target, deltaY) => target.dispatchEvent(new f.w.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    const ruler = f.w.document.querySelector('[data-ref="rulerTrack"]');
    wheel(ruler, 100); wheel(ruler, 100);
    assert.equal(f.view.debug().row, 2);
    const laneBefore = f.view.debug().lane;
    wheel(f.w.document.querySelector('[data-ref="laneName"]'), 100);
    assert.equal(f.view.debug().lane, laneBefore + 1);
    f.close();

    // 场景画布上的滚轮
    const g = fixture({ n: 200 });
    const { view, canvas } = withFakeScene(g);
    for (let k = 0; k < 6; k++) {
        wheel(canvas(), 60);
        await new Promise((r) => setTimeout(r, 15));
    }
    const afterWheel = view.debug().row;
    assert.equal(afterWheel, 6);
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(view.debug().row > afterWheel, `停在第 ${view.debug().row} 行`);
    g.close();
});

test('目录里按歌手点播，队列是这位歌手的歌；全部曲目里点播，队列是整个曲库', () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.setKind('artist');
    const rows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
    rows[0].dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(f.calls[0][2], 15);
    assert.equal(f.app.queueSourceName, '歌手：Aki');
    f.calls.length = 0;
    f.view.list.setKind('all');
    const row = [...f.view.list.el.querySelectorAll('.archive-list-row')][4];
    row.dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(f.calls[0][2], null);
    assert.equal(f.app.queueSourceName, '全部曲目');
    f.close();
});

test('全部曲目按全局顺序（首字母、数值自然序）排，和目录一致', () => {
    const f = fixture({ n: 12 });
    const order = [];
    for (let k = 0; k < 12; k++) { order.push(f.view.debug().selected); f.key('ArrowDown'); }
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    f.view.setListOpen(true);
    const shown = [...f.view.list.el.querySelectorAll('.archive-list-row b')].map((n) => n.textContent);
    assert.deepEqual(shown.slice(0, 3), ['Song 0', 'Song 1', 'Song 2']);
    f.close();
});

test('Ctrl+L 定位当前播放，目录切回全部并滚到那一行', () => {
    const f = fixture();
    f.app.currentTrackIndex = 20;
    f.view.setListOpen(true);
    f.view.list.setKind('artist');
    f.key('ArrowDown');
    f.key('l', { ctrlKey: true });
    assert.equal(f.view.debug().selected, 20);
    assert.equal(f.view.list.kind, 'all');
    const on = f.view.list.el.querySelector('.archive-list-row.on');
    assert.match(on.textContent, /Song 20/);
    f.close();
});

test('每一列记住上次停在第几首，换列回来回到那一首', () => {
    const f = fixture({ playlists: [{ id: 'p', name: '夜间散步', tracks: ['/m/5', '/m/7', '/m/9', '/m/11', '/m/13'] }] });
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); // 全部曲目第 6 首
    f.key('ArrowRight');                       // 第一次进歌单：保持行号（第 6 行在 5 首的歌单里回绕到第 1 首 /m/5）
    assert.equal(f.view.debug().selected, 5);
    f.key('ArrowUp'); f.key('ArrowUp');        // 歌单里往回两首
    const inPlaylist = f.view.debug().selected;
    f.key('ArrowLeft');                        // 回全部曲目：回到第 6 首
    assert.equal(f.view.debug().selected, 5);
    f.key('ArrowRight');                       // 再进歌单：回到刚才那首
    assert.equal(f.view.debug().selected, inPlaylist);
    f.close();
});

test('目录排序菜单：换成按歌手排，阵列按歌手首字母重排，选中的歌不变，并记住', () => {
    const f = fixture({ n: 60 });
    const doc = f.w.document;
    f.view.setListOpen(true);
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); // Song 3（Aki）
    const before = f.view.debug().selected;
    doc.querySelector('[data-l="sortBtn"]').click();
    const menu = doc.querySelector('[data-l="sortMenu"]');
    assert.equal(menu.hidden, false);
    menu.querySelector('[data-sort="artist"]').click();
    assert.equal(menu.hidden, true);
    assert.equal(f.view.sort, 'artist');
    assert.equal(doc.querySelector('[data-l="sortName"]').textContent, '歌手');
    const ids = f.view.debug().columns.map((c) => c.id);
    assert.ok(ids.includes('sort-artist:A') && ids.includes('sort-artist:R'), ids.join());
    assert.equal(f.view.debug().selected, before);
    assert.equal(f.text('laneName'), 'A');
    assert.equal(f.w.localStorage.getItem('musicArchiveSort'), 'artist');
    // 目录的首字母组也按歌手
    f.view.list.el.querySelector('[data-l="viewport"]').scrollTop = 0;
    f.view.list.rebuild();
    const letters = [...doc.querySelectorAll('.archive-list-letter span')].map((s) => s.textContent);
    assert.equal(letters[0], 'A');
    // 键盘：菜单里上下选、回车确定
    doc.querySelector('[data-l="sortBtn"]').click();
    const kd = (k) => doc.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    kd('ArrowDown'); kd('Enter');
    assert.equal(f.view.sort, 'duration');
    assert.equal(f.text('laneName'), '时长未知');
    f.close();
});

test('在档案页直接打字：打开目录、聚焦检索框并带入这个字；输入法组字时不抢', async () => {
    const f = fixture();
    f.view.setListOpen(false);
    const input = f.view.list.input;
    f.key('a', { isComposing: true });
    f.key('Process', { keyCode: 229 });
    assert.ok(f.view.list.el.hidden);
    assert.equal(input.value, '');
    f.key('2');
    assert.ok(!f.view.list.el.hidden);
    assert.equal(f.w.document.activeElement, input);
    assert.equal(input.value, '2');
    assert.equal(f.w.localStorage.getItem('musicArchiveList'), '0'); // 打字打开的不改用户「收起」的设置
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(f.view.list.query, '2');
    assert.equal(f.view.debug().selected, 2); // 第一条结果直接选中
    // 已有检索词时，回到阵列再打字是新的检索
    input.blur();
    f.key('9');
    assert.equal(input.value, '9');
    // 空格、修饰键、方向键不进检索框
    input.blur();
    f.key(' ', { code: 'Space' });
    f.key('k', { ctrlKey: true });
    f.key('ArrowDown');
    assert.equal(input.value, '9');
    assert.ok(f.calls.some((c) => c[0] === 'play'));
    f.close();
});

test('重启回到上次的列和那张卡，不自动播放；上次在播放页就回到播放页', async () => {
    const place = { mode: 'archive', stage: true, col: 'playlist:p', row: 2, path: '/m/9' };
    const f = fixture({ setup: (w) => w.localStorage.setItem('musicArchivePlace', JSON.stringify(place)) });
    assert.equal(f.text('laneName'), '夜间散步');
    assert.equal(f.view.debug().selected, 9);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.calls, [['stage']]); // 只进播放页，没有 load / play
    f.close();
});

test('曲库晚到：等曲库到了再落位；换了选中会记下来，下次打开回到这里', async () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: 'A', album: 'B' }));
    let store = null;
    const f = fixture({
        tracks: [],
        setup: (w) => w.localStorage.setItem('musicArchivePlace', JSON.stringify({ mode: 'archive', stage: false, col: 'all', row: 0, path: '/m/12' }))
    });
    f.app.playlist = tracks;
    f.view.refresh();
    assert.equal(f.view.debug().selected, 12);
    f.key('ArrowDown');
    assert.equal(f.view.debug().selected, 13);
    await new Promise((r) => setTimeout(r, 450));
    store = JSON.parse(f.w.localStorage.getItem('musicArchivePlace'));
    assert.equal(store.path, '/m/13');
    assert.equal(store.col, 'all');
    assert.equal(store.stage, false);
    assert.ok(!f.calls.length);
    f.close();
});

test('没有记录时：播放器晚一点恢复上次那首，选中直接落到那张卡', () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: 'A', album: 'B' }));
    const f = fixture({ tracks: [] });
    f.app.playlist = tracks;
    f.view.refresh();
    assert.equal(f.view.debug().selected, 0);
    f.app.currentTrackIndex = 21; // 播放器 loadTrack(上次那首, 不播放)
    f.view.refresh();
    assert.equal(f.view.debug().selected, 21);
    f.close();
});

test('帧率：操作时按档位上限画，播放中静止 2 秒后 12 帧，播放页盖住时一帧不画（暂停时静止不画见 music-archive-idle）', () => {
    // 假场景：记录 step 次数；idle 由「距上次操作」决定，和真场景一致
    let now = 0;
    let lastInput = 0;
    let steps = 0;
    const canvas = { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), style: {} };
    const fake = {
        create: () => ({
            canvas, tier: { fps: 60, idleFps: 12 }, target: { lane: 0, row: 0 }, dirty: false,
            step: () => { steps++; return { moving: false, idle: now - lastInput > 2000, animated: true }; },
            select: () => { lastInput = now; }, jump() {}, resize() {}, setTheme() {}, setPlaying() {}, setHover() {}, setPointer() {},
            touch: () => { lastInput = now; }, raise() {}, setLabeler() {}, setLabelMask() {}, refreshLabels() {}, dispose() {}, pick: () => null, debug: () => ({}),
            setDetail() {}, setDetailRoom() {}, setCover() {}, hold() {}, unhold() {}, turn() {}, detail: null, detailRect: () => null, dragAxes: () => null, camAt: () => null
        })
    };
    const queue = [];
    const f = fixture({
        setup: (w) => {
            w.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
            w.cancelAnimationFrame = () => {};
            w.HTMLElement.prototype.insertBefore = function (n) { return n; };
        }
    });
    // 换成假场景重新初始化
    f.view.destroy();
    f.app.archiveView = null;
    f.app.isPlaying = true;
    const w = f.w;
    w.document.getElementById('music-archive-view').innerHTML = '';
    // 待机时下一帧用定时器睡到点再要显示帧：定时器也走虚拟时钟
    let timers = [];
    let timerId = 0;
    w.setTimeout = (cb, ms = 0) => { timers.push({ id: ++timerId, at: now + ms, cb }); return timerId; };
    w.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
    const view = w.MusicArchive.init(f.app, { sceneLib: fake, pinyinSrc: false });
    const run = (ms) => {
        const start = steps;
        const end = now + ms;
        while (now < end) {
            now += 1000 / 60;
            const due = timers.filter((t) => t.at <= now);
            timers = timers.filter((t) => t.at > now);
            for (const t of due) t.cb();
            const cbs = queue.splice(0);
            for (const cb of cbs) cb(now);
        }
        return steps - start;
    };
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    lastInput = now;
    const active = run(1000);
    run(1500);
    const idle = run(2000) / 2;
    w.document.body.classList.add('music-stage-active');
    run(50);
    const covered = run(2000);
    assert.ok(active >= 55, 'active ' + active);
    assert.ok(idle >= 11 && idle <= 13, 'idle ' + idle);
    assert.equal(covered, 0);
    view.destroy();
    f.close();
});

test('降低动态读设置里的统一开关；开关不在时按系统设置挂 body 类', () => {
    // 系统开着减少动态，但用户在设置里选了「关」：档案页照常动
    let fire = null;
    const f = fixture({
        setup: (w) => {
            w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
            w.MusicMotion = { reduced: () => false, onChange: (fn) => { fire = fn; return () => { fire = null; }; } };
        }
    });
    assert.ok(!f.w.document.body.classList.contains('music-reduce-motion'));
    assert.equal(typeof fire, 'function');
    f.close();
    assert.equal(fire, null); // 关窗时取消订阅
    // 没有统一开关：跟随系统
    const g = fixture({ setup: (w) => { w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }); } });
    assert.ok(g.w.document.body.classList.contains('music-reduce-motion'));
    g.close();
});

test('有统一点播入口时走 playFromContext（按阵列顺序）；换排序时正在放的整库队列跟着换顺序', () => {
    const got = [];
    let owned = false;
    const f = fixture({
        n: 60,
        setup: (w, app) => {
            app.playFromContext = (list, index, opts) => { got.push(['ctx', list.length, index, opts.origin]); owned = true; app.currentTrackIndex = index; };
            app.contextFrom = (o) => owned && o === 'archive';
            app.reorderContext = (list, o) => { got.push(['reorder', list.length, o, list[0].path]); return true; };
        }
    });
    f.key('ArrowDown');
    f.key('Enter');
    assert.deepEqual(got[0], ['ctx', 60, f.view.debug().selected, 'archive']);
    f.view.setSort('added');
    assert.deepEqual(got[1], ['reorder', 60, 'archive', '/m/59']); // 新的在前
    f.close();
});

function withMenu(w, app, calls) {
    const doc = w.document;
    const menu = doc.createElement('div');
    menu.id = 'track-context-menu';
    menu.className = 'context-menu';
    menu.innerHTML = '<div class="context-menu-item" data-action="play">播放</div><div class="context-menu-item" data-action="play-next">下一首</div>'
        + '<div class="context-menu-item has-submenu" data-action="add-to-playlist">加入歌单<div class="context-submenu"><div class="submenu-item">夜间散步</div><div class="submenu-item">雨天</div></div></div>'
        + '<div class="context-menu-item danger" data-action="remove">移除</div>';
    doc.body.appendChild(menu);
    menu.querySelectorAll('.context-menu-item, .submenu-item').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); calls.push(['menu', el.dataset.action || el.textContent, app.contextMenuTrackIndex, app.contextMenuScopeHint === undefined ? 'none' : app.contextMenuScopeHint]); menu.classList.remove('visible'); }));
    app.contextMenu = menu;
    app.showContextMenu = (x, y) => { calls.push(['ctx', app.contextMenuTrackIndex]); menu.classList.add('visible'); };
    return menu;
}

test('目录行：Shift+F10 / 菜单键打开右键菜单，方向键移动，回车执行，Esc 关闭后焦点回到目录', () => {
    let menu;
    const f = fixture({ setup: (w, app) => { menu = withMenu(w, app, []); } });
    const calls = [];
    f.app.showContextMenu = (x, y) => { calls.push(['ctx', f.app.contextMenuTrackIndex]); menu.classList.add('visible'); };
    menu.querySelectorAll('.context-menu-item, .submenu-item').forEach((el) => el.addEventListener('click', () => calls.push(['menu', el.dataset.action || el.textContent, f.app.contextMenuTrackIndex])));
    const doc = f.w.document;
    f.view.setListOpen(true);
    const vp = f.view.list.el.querySelector('[data-l="viewport"]');
    vp.focus();
    const kd = (k, extra = {}) => doc.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    kd('ArrowDown'); kd('ArrowDown'); kd('ArrowDown');
    const sel = f.view.debug().selected;
    kd('F10', { shiftKey: true });
    assert.ok(menu.classList.contains('visible'));
    assert.deepEqual(calls[0], ['ctx', sel]);
    assert.equal(doc.activeElement.dataset.action, 'play');
    kd('ArrowDown');
    assert.equal(doc.activeElement.dataset.action, 'play-next');
    kd('ArrowUp'); kd('ArrowUp'); // 循环到最后一项
    assert.equal(doc.activeElement.dataset.action, 'remove');
    kd('ArrowUp');
    kd('ArrowRight'); // 打开子菜单
    assert.equal(doc.activeElement.textContent, '夜间散步');
    kd('ArrowDown');
    kd('Enter');
    assert.deepEqual(calls.at(-1), ['menu', '雨天', sel]);
    assert.ok(!menu.classList.contains('visible'));
    assert.equal(doc.activeElement, vp);
    // 菜单键也行；Esc 关闭，焦点回到目录
    kd('ContextMenu');
    assert.ok(menu.classList.contains('visible'));
    kd('Escape');
    assert.ok(!menu.classList.contains('visible'));
    assert.equal(doc.activeElement, vp);
    f.close();
});

test('阵列上 Shift+F10 打开选中卡的右键菜单；歌单分类里的行右键时只从这个歌单移除', () => {
    let menu;
    const calls = [];
    const f = fixture({ setup: (w, app) => { menu = withMenu(w, app, calls); } });
    f.key('ArrowDown');
    f.key('F10', { shiftKey: true });
    assert.ok(menu.classList.contains('visible'));
    assert.deepEqual(calls[0], ['ctx', 1]);
    f.key('Escape');
    assert.ok(!menu.classList.contains('visible'));
    // 歌单分类里的行
    f.view.setListOpen(true);
    f.view.list.setKind('playlist');
    const row = f.view.list.el.querySelector('.archive-list-row');
    row.dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.deepEqual(JSON.parse(JSON.stringify(f.app.contextMenuScopeHint)), { type: 'playlist', id: 'p', name: '夜间散步' });
    f.close();
});

test('右侧滚动歌词：播放器有歌词时显示，当前行跟着进度走，点一行跳过去；没有歌词就不显示', async () => {
    const seeks = [];
    const f = fixture({
        setup: (w, app) => {
            Object.defineProperty(w, 'innerWidth', { value: 1920 }); Object.defineProperty(w, 'innerHeight', { value: 1080 });
            app.currentLyrics = [{ time: 0, text: '第一句' }, { time: 5, text: '第二句', translation: 'second' }, { time: 10, text: '' }, { time: 12, text: '第三句' }];
            app.isPlaying = true;
            app.lastKnownCurrentTime = 6;
            app.lastStateUpdateTime = Date.now();
            app.seekTo = (t) => seeks.push(t);
        }
    });
    const el = f.w.document.querySelector('.archive-lyrics');
    f.w.document.querySelector('[data-act="lyrics"]').click(); // 歌词面板平时收着，这里手动打开
    assert.ok(el && !el.hidden);
    assert.ok(f.w.document.querySelector('.archive-hud').classList.contains('lyrics-open'));
    const d = f.view.debug().lyrics;
    assert.equal(d.lines, 3); // 空行不显示
    assert.equal(d.index, 1);
    assert.equal(el.querySelector('p.on b').textContent, '第二句');
    assert.equal(el.querySelector('p.on em').textContent, 'second');
    assert.ok(d.ticking);
    // 点第三句：跳到 12 秒，高亮跟过去
    el.querySelectorAll('p')[2].dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(seeks, [12]);
    assert.equal(el.querySelector('p.on b').textContent, '第三句');
    // 换了一首没有歌词的：收起
    f.app.currentLyrics = [];
    f.app.currentTrackIndex = 3;
    f.view.refresh();
    assert.ok(el.hidden);
    assert.ok(!f.view.debug().lyrics.ticking);
    f.close();
});

test('右侧歌词：经典视图和播放页里不显示，暂停时不走表', () => {
    const f = fixture({
        setup: (w, app) => {
            Object.defineProperty(w, 'innerWidth', { value: 1920 }); Object.defineProperty(w, 'innerHeight', { value: 1080 });
            app.currentLyrics = [{ time: 0, text: 'a' }, { time: 5, text: 'b' }];
            app.isPlaying = false;
            app.lastKnownCurrentTime = 1;
        }
    });
    const el = f.w.document.querySelector('.archive-lyrics');
    f.w.document.querySelector('[data-act="lyrics"]').click(); // 歌词面板平时收着，这里手动打开
    assert.ok(!el.hidden);
    assert.ok(!f.view.debug().lyrics.ticking);
    f.view.showClassic();
    assert.ok(el.hidden);
    f.view.show();
    assert.ok(!el.hidden);
    f.w.document.body.classList.add('music-stage-active');
    f.view.refresh();
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.ok(el.hidden);
    f.w.document.body.classList.remove('music-stage-active');
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.ok(!el.hidden);
    // 窄一些的窗口不收起，由版面让位（bento）
    Object.defineProperty(f.w, 'innerWidth', { value: 900 });
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.ok(!el.hidden);
    f.close();
});

test('onMotion：换选中时回调方向、速度和在这一列里的位置，可取消', () => {
    const f = fixture();
    const got = [];
    const off = f.view.onMotion((m) => got.push(m));
    f.key('ArrowDown'); f.key('ArrowDown');
    f.key('ArrowRight');
    assert.equal(got.length, 3);
    assert.equal(got[0].axis, 'row');
    assert.ok(got[1].velocity > 0);
    assert.equal(got[2].axis, 'lane');
    assert.ok(got[0].fraction > 0 && got[0].fraction <= 1);
    off();
    f.key('ArrowDown');
    assert.equal(got.length, 3);
    f.close();
});

test('封面：自带封面直接用，读不出来不留破图；没有封面时试同目录的图，每个目录只试一次', async () => {
    const asked = [];
    const f = fixture({
        tracks: [
            { path: '/a/0.flac', title: 'A0', albumArt: '/c/ok.jpg' },
            { path: '/a/1.flac', title: 'A1', albumArt: '/c/bad.jpg' },
            { path: '/b/2.flac', title: 'A2' },
            { path: '/b/3.flac', title: 'A3' },
            { path: 'https://x.test/dav/4.flac', title: 'A4' }
        ],
        playlists: [],
        setup: (w) => {
            w.Image = class {
                constructor() { this.l = {}; }
                addEventListener(type, fn) { (this.l[type] = this.l[type] || []).push(fn); }
                get src() { return this.url; }
                set src(v) {
                    this.url = v;
                    asked.push(v);
                    const ok = /ok\.jpg$|\/b\/folder\.jpg$/.test(v);
                    w.setTimeout(() => { const t = ok ? 'load' : 'error'; this['on' + t]?.(); (this.l[t] || []).forEach((fn) => fn()); }, 0);
                }
            };
        }
    });
    const { log } = withFakeScene(f);
    const wait = (ms = 200) => new Promise((r) => f.w.setTimeout(r, ms));
    const shown = () => log[log.length - 1];
    await wait();
    assert.equal(shown().title, 'A0');
    assert.match(shown().img.src, /ok\.jpg/);
    f.key('ArrowDown'); await wait();
    assert.equal(shown().title, 'A1');
    assert.equal(shown().img, null, '读不出来就保留写有曲名的卡面');
    f.key('ArrowDown'); await wait();
    assert.match(shown().img.src, /\/b\/folder\.jpg/);
    const probes = asked.filter((u) => /\/b\//.test(u)).length;
    f.key('ArrowDown'); await wait();
    assert.equal(shown().title, 'A3');
    assert.match(shown().img.src, /\/b\/folder\.jpg/, '同目录第二首直接用上次找到的图');
    assert.equal(asked.filter((u) => /\/b\//.test(u)).length, probes, '不再重新试');
    f.key('ArrowDown'); await wait();
    assert.equal(shown().img, null, '远程曲目不去试本地目录');
    assert.equal(asked.some((u) => /x\.test/.test(u)), false);
    f.close();
});

test('扫描曲库：空曲库时中间换成进度并收起入口，有歌时写在左下角状态里，扫完恢复', () => {
    const fns = {};
    const api = { onMusicScanStart: (fn) => { fns.start = fn; return () => { fns.start = null; }; }, onMusicScanProgress: (fn) => { fns.progress = fn; }, onMusicScanComplete: (fn) => { fns.complete = fn; } };
    const f = fixture({ n: 0, playlists: [], setup: (w, app) => { app.api = api; } });
    const root = f.w.document.getElementById('music-archive-view');
    assert.equal(f.text('emptyTitle'), '曲库是空的');
    assert.match(root.querySelector('[data-act="add-local"]').textContent, /添加本地文件夹/);
    fns.start();
    assert.ok(root.classList.contains('is-scanning'));
    assert.equal(f.text('emptyTitle'), '正在扫描曲库');
    fns.progress({ current: 437, total: 1280 });
    assert.match(f.text('emptyText'), / 437 \/ 1280/);
    assert.equal(f.text('status'), '扫描中 437 / 1280');
    assert.match(root.querySelector('[data-ref="scanBar"]').style.transform, /scaleX\(0\.34/);
    fns.complete({ tracks: new Array(1280) });
    assert.equal(root.classList.contains('is-scanning'), false);
    assert.equal(f.text('status'), '扫描完成，共 1280 首');
    assert.equal(f.text('emptyTitle'), '曲库是空的');
    f.close();
    assert.equal(fns.start, null, '关掉时取消订阅');
});

test('首页不再写「正在播放 全部曲目」：队列来源交给底栏面板（app.queueSourceName）', () => {
    const f = fixture();
    assert.equal(f.w.document.querySelector('.archive-queue'), null);
    let fired = 0;
    f.w.document.addEventListener('music-queue-source-change', () => { fired += 1; });
    f.key('ArrowDown');
    f.key('Enter');
    assert.equal(typeof f.app.queueSourceName, 'string');
    assert.ok(f.app.queueSourceName.length > 0);
    assert.ok(fired >= 1, '换了队列会通知底栏刷新');
    f.close();
});

test('空的原因各有说法：检索没结果、空歌单、还没有播放记录', () => {
    const f = fixture({ playlists: [{ id: 'e', name: '空歌单', tracks: [] }] });
    const empty = () => f.view.list.el.querySelector('[data-l="empty"]');
    f.view.setListOpen(true);
    f.view.list.input.value = 'zzqx';
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.match(empty().textContent, /没有找到「zzqx」.*Esc 清除检索/);
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(empty().style.display, 'none');
    f.view.list.el.querySelector('[data-kind="playlist"]').click();
    assert.match(empty().textContent, /歌单里还没有歌.*右键/);
    f.view.list.el.querySelector('[data-kind="recent"]').click();
    assert.match(empty().textContent, /还没有播放记录/);
    // 阵列走到空歌单那一列：分组名是这个歌单，计数为 0，没有选中的歌
    const cols = f.view.debug().columns;
    const lane = cols.findIndex((c) => c.id === 'playlist:e');
    // 目录换分类时阵列会跟着跳（见下面「目录换分类」），这里从当前位置走过去
    for (let k = 0; k < cols.length && ((f.view.debug().lane % cols.length) + cols.length) % cols.length !== lane; k++) f.key('ArrowRight');
    assert.equal(f.text('laneName'), '空歌单');
    assert.equal(Number(f.text('selT')), 0);
    assert.equal(f.view.debug().selected, -1);
    f.close();
});

test('右侧歌词：正在放的歌等一会儿还没有歌词，只留栏头和「获取歌词」；歌词到了换成歌词，不占大封面的版面', async () => {
    const f = fixture({ setup: (w, app) => { w.innerWidth = 1600; w.innerHeight = 900; app.isPlaying = true; app.currentLyrics = []; app.openLyricsFetchModal = (i) => { app.fetchAsked = i; }; } });
    const el = f.w.document.querySelector('.archive-lyrics');
    f.w.document.querySelector('[data-act="lyrics"]').click(); // 歌词面板平时收着，这里手动打开
    const hud = f.w.document.querySelector('.archive-hud');
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    f.view.refresh();
    assert.equal(el.hidden, true, '刚开始先不说没有（可能还在取）');
    await wait(2700);
    assert.equal(el.hidden, false);
    assert.ok(el.classList.contains('none'));
    el.querySelector('[data-y="fetch"]').click();
    assert.equal(f.app.fetchAsked, 0);
    f.app.currentLyrics = [{ time: 1, text: '第一句' }, { time: 5, text: '第二句' }];
    f.view.refresh();
    assert.equal(el.classList.contains('none'), false);
    f.close();
});

test('大曲库整体变化：分片重建，中途不改画面，做完后阵列、目录、检索都是新曲库；小曲库当场重建', async () => {
    const make = (n, tag = '') => Array.from({ length: n }, (_, i) => ({ path: '/big/' + tag + i, title: '清晨的站台 ' + tag + i, artist: i % 2 ? 'Aki' : '周杰伦', album: 'A' + (i % 9) }));
    const f = fixture({ tracks: make(2400), playlists: [] });
    const files = () => Number(f.text('files'));
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    f.view.setListOpen(true);
    assert.equal(files(), 2400);
    f.app.playlist = make(2600);
    f.view.refreshSoon();
    assert.equal(files(), 2400, '这一片只算了一部分条目，画面还没换');
    // 中途曲库又变了：按最新的那份重来
    f.app.playlist = make(2700, 'x');
    await wait(400);
    assert.equal(files(), 2700);
    assert.equal(f.view.list.count, 2700);
    assert.equal(f.view.debug().columns.reduce((a, c) => a + (/^letter:/.test(c.id) ? c.n : 0), 0), 2700);
    f.view.list.input.value = 'x2699';
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(f.view.list.count, 1);
    // 小曲库不分片
    f.app.playlist = make(30, 's');
    f.view.refreshSoon();
    assert.equal(files(), 30);
    f.close();
});

test('扫描途中一批批进来：阵列和目录跟着长，选中的还是那首歌，目录眼前的内容不被顶走，也不碰播放；扫完重排后仍是那首', async () => {
    const fns = {};
    const api = { onMusicScanStart: (fn) => { fns.start = fn; }, onMusicScanProgress: (fn) => { fns.progress = fn; }, onMusicScanComplete: (fn) => { fns.complete = fn; }, onMusicScanBatch: (fn) => { fns.batch = fn; } };
    const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ path: '/s/' + tag + i, title: tag + ' ' + String(i).padStart(3, '0'), artist: 'Ren' }));
    const f = fixture({ tracks: mk(80, 'M'), playlists: [], setup: (w, app) => { app.api = api; } });
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    const selPath = () => f.app.playlist[f.view.debug().selected].path;
    f.view.setListOpen(true);
    for (let k = 0; k < 7; k++) f.key('ArrowDown');
    const chosen = selPath();
    // 目录滚到别处看
    const vp = f.view.list.el.querySelector('[data-l="viewport"]');
    vp.scrollTop = 2000; vp.dispatchEvent(new f.w.Event('scroll'));
    await wait(40);
    const topTitle = () => {
        const rows = [...vp.querySelectorAll('.archive-list-row')].map((n) => ({ y: parseFloat((n.style.transform.match(/translateY\(([-\d.]+)px/) || [])[1]), t: n.querySelector('.tx').textContent }))   // 只比歌名：序号会因为前面多了歌而变
            .filter((x) => x.y >= vp.scrollTop).sort((a, b) => a.y - b.y);
        return rows[0] && rows[0].t;
    };
    const before = topTitle();
    assert.ok(before);
    fns.start({ total: 200, folderPath: '/s' });
    fns.progress({ current: 100, total: 200 });
    assert.equal(f.text('status'), '扫描中 100 / 200');
    // 新来的歌排在前面（标题 A 开头）
    f.app.playlist = f.app.playlist.concat(mk(40, 'A'));
    fns.batch({ tracks: [] });
    assert.equal(Number(f.text('files')), 80, '攒一会儿再排');
    await wait(650);
    assert.equal(Number(f.text('files')), 120);
    assert.equal(selPath(), chosen);
    assert.equal(topTitle(), before, '眼前最上面还是那首');
    assert.deepEqual(f.calls, [], '没有碰播放');
    // 扫完：曲库按磁盘顺序重排（下标全变）
    f.app.playlist = f.app.playlist.slice().reverse();
    fns.complete({ tracks: f.app.playlist });
    f.view.refreshSoon();
    assert.equal(selPath(), chosen);
    f.close();
});

test('歌单管理：目录的歌单分类里新建、重命名、删除（要确认，可撤销）；存盘走播放器的 saveCustomPlaylists，阵列跟着变', () => {
    let saved = 0;
    const toasts = [];
    const f = fixture({ setup: (w, app) => { app.saveCustomPlaylists = () => { saved++; }; w.MusicToast = { show: (t) => toasts.push(t) }; } });
    const el = f.view.list.el;
    const names = () => f.app.customPlaylists.map((p) => p.name);
    const cols = () => f.view.debug().columns.map((c) => c.id);
    const type = (input, value, key = 'Enter') => { input.value = value; input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); };
    f.view.setListOpen(true);
    assert.equal(el.querySelector('[data-l="newPl"]').hidden, true, '只在歌单分类里出现');
    el.querySelector('[data-kind="playlist"]').click();
    assert.equal(el.querySelector('[data-l="newPl"]').hidden, false);
    // 新建
    el.querySelector('[data-pl="new"]').click();
    type(el.querySelector('.archive-list-name'), '  雨天  ');
    assert.deepEqual(names(), ['夜间散步', '雨天']);
    assert.equal(saved, 1);
    assert.ok(cols().some((id) => id === 'playlist:' + f.app.customPlaylists[1].id), '阵列里多了一列');
    assert.ok(el.querySelector('[data-pl="new"]'), '输入框收回去了');
    // 空名字、Esc 都不建
    el.querySelector('[data-pl="new"]').click();
    type(el.querySelector('.archive-list-name'), '   ');
    el.querySelector('[data-pl="new"]').click();
    type(el.querySelector('.archive-list-name'), '不要了', 'Escape');
    assert.equal(names().length, 2);
    // 重命名
    const head = (name) => [...el.querySelectorAll('.archive-list-group')].find((n) => n.textContent.includes(name));
    head('夜间散步').querySelector('[data-pl="rename"]').click();
    type(el.querySelector('.archive-list-group .archive-list-name'), '夜里走走');
    assert.deepEqual(names(), ['夜里走走', '雨天']);
    assert.ok(head('夜里走走'));
    // 删除：先问，取消不删，确认才删，能撤销
    head('雨天').querySelector('[data-pl="delete"]').click();
    assert.match(head('雨天').textContent, /删除「雨天」？/);
    head('雨天').querySelector('[data-pl="delete-no"]').click();
    assert.equal(names().length, 2);
    head('雨天').querySelector('[data-pl="delete"]').click();
    head('雨天').querySelector('[data-pl="delete-yes"]').click();
    assert.deepEqual(names(), ['夜里走走']);
    assert.equal(head('雨天'), undefined);
    toasts[toasts.length - 1].action.run();
    assert.deepEqual(names(), ['夜里走走', '雨天']);
    assert.equal(saved, 4);
    f.close();
});

test('把歌拖到歌单上：拖起一行时目录下方出现歌单架，松在歌单上加入（已有的不重复），松在「新建歌单」上新建', () => {
    const toasts = [];
    const f = fixture({ setup: (w, app) => { app.saveCustomPlaylists = () => {}; w.MusicToast = { show: (t) => toasts.push(t) }; } });
    const el = f.view.list.el;
    // 拖：按住一行横着拖出去（上下拖是滚动），移到落点上，松手
    const pe = (type, target, x, y) => target.dispatchEvent(new f.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    const ev = (type, target) => {
        if (type === 'dragstart') { pe('pointerdown', target, 100, 100); pe('pointermove', target, 140, 102); }
        else if (type === 'dragover') { pe('pointermove', target, 200, 300); return { defaultPrevented: target.classList.contains('drop-over') }; }
        else if (type === 'drop') pe('pointerup', target, 200, 300);
        else if (type === 'dragend') pe('pointerup', target, 140, 102);
        return null;
    };
    f.view.setListOpen(true);
    const rowOf = (title) => [...el.querySelectorAll('.archive-list-row')].find((n) => n.querySelector('b').textContent === title);
    const shelf = el.querySelector('[data-l="shelf"]');
    ev('dragstart', rowOf('Song 3'));
    assert.equal(shelf.hidden, false);
    const chip = shelf.querySelector('[data-drop="p"]');
    assert.equal(chip.textContent, '夜间散步');
    assert.equal(ev('dragover', chip).defaultPrevented, true, '可以松手');
    assert.ok(chip.classList.contains('drop-over'));
    ev('drop', chip);
    assert.equal(shelf.hidden, true);
    assert.deepEqual(f.app.customPlaylists[0].tracks, ['/m/5', '/m/7', '/m/9', '/m/3']);
    assert.match(toasts[toasts.length - 1].message, /已加入歌单「夜间散步」：1 首/);
    // 再拖一次同一首：不重复
    ev('dragstart', rowOf('Song 3'));
    ev('drop', shelf.querySelector('[data-drop="p"]'));
    assert.equal(f.app.customPlaylists[0].tracks.length, 4);
    // 撤销第一次
    toasts.find((t) => /1 首/.test(t.message)).action.run();
    assert.deepEqual(f.app.customPlaylists[0].tracks, ['/m/5', '/m/7', '/m/9']);
    // 松在「新建歌单」上
    ev('dragstart', rowOf('Song 4'));
    ev('drop', shelf.querySelector('[data-drop-new]'));
    assert.equal(f.app.customPlaylists.length, 2);
    assert.equal(f.app.customPlaylists[1].tracks.join(), '/m/4');
    // 没松在歌单上：什么都不变
    ev('dragstart', rowOf('Song 4'));
    ev('dragend', rowOf('Song 4'));
    assert.equal(shelf.hidden, true);
    // 歌单分类里，歌单标题本身也能接
    el.querySelector('[data-kind="playlist"]').click();
    const head = [...el.querySelectorAll('.archive-list-group')].find((n) => n.textContent.includes('夜间散步'));
    ev('dragstart', el.querySelector('.archive-list-row'));
    assert.equal(ev('dragover', head).defaultPrevented, true);
    f.close();
});

test('目录多选：Ctrl 点选、Shift 选一段、Ctrl+A、Esc；多选时右键是批量菜单：加入队列、下一首播放、加入歌单', () => {
    const toasts = [];
    const queue = [];
    const f = fixture({ setup: (w, app) => {
        app.saveCustomPlaylists = () => {};
        app.manualQueue = queue;
        app.queueAdd = (t) => { queue.push(t); return t; };
        app.queuePlayNext = (t) => { queue.unshift(t); return t; };
        app.queueRemove = (i) => { queue.splice(i, 1); };
        w.MusicToast = { show: (t) => toasts.push(t) };
    } });
    const el = f.view.list.el;
    const doc = f.w.document;
    f.view.setListOpen(true);
    const rowOf = (title) => [...el.querySelectorAll('.archive-list-row')].find((n) => n.querySelector('b').textContent === title);
    const click = (title, mods = {}) => rowOf(title).dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, ...mods }));
    const picked = () => Array.from(f.view.list.picked, (i) => f.app.playlist[i].title);
    const menu = () => doc.querySelector('.archive-batch-menu');
    const rightClick = (title) => rowOf(title).dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));

    click('Song 2');
    const selectedBefore = f.view.debug().selected;
    click('Song 4', { ctrlKey: true });
    assert.deepEqual(picked(), ['Song 2', 'Song 4'], '原来单选的那行也算在内');
    assert.equal(f.view.debug().selected, selectedBefore, 'Ctrl 点选不带着阵列跑');
    assert.ok(rowOf('Song 4').classList.contains('picked'));
    click('Song 6', { shiftKey: true });
    assert.deepEqual(picked(), ['Song 4', 'Song 5', 'Song 6'], 'Shift 从上一次点的那行选到这一行');
    click('Song 2', { ctrlKey: true });
    assert.equal(picked().length, 4);
    assert.match(el.querySelector('[data-l="multiNote"]').textContent, /已选 4 首/);

    // 批量菜单
    rightClick('Song 5');
    assert.ok(menu(), '多选里的行右键是批量菜单');
    assert.equal(f.calls.some((c) => c[0] === 'ctx'), false, '不是播放器的单曲菜单');
    assert.match(menu().textContent, /已选 4 首/);
    menu().querySelector('[data-batch="queue"]').click();
    assert.equal(menu(), null);
    assert.deepEqual(queue.map((t) => t.title), ['Song 2', 'Song 4', 'Song 5', 'Song 6']);
    toasts[toasts.length - 1].action.run();
    assert.equal(queue.length, 0, '撤销');
    rightClick('Song 5');
    menu().querySelector('[data-batch="next"]').click();
    assert.deepEqual(queue.map((t) => t.title), ['Song 2', 'Song 4', 'Song 5', 'Song 6'], '下一首播放保持选中的顺序');
    // 加入歌单（Song 5 已经在里面，不重复）
    rightClick('Song 4');
    menu().querySelector('[data-batch="pl"][data-id="p"]').click();
    assert.equal(f.app.customPlaylists[0].tracks.join(), '/m/5,/m/7,/m/9,/m/2,/m/4,/m/6');
    assert.match(toasts[toasts.length - 1].message, /3 首/);
    // 新建歌单并加入
    assert.equal(picked().length, 4, '加完选择还在');
    rightClick('Song 4');
    menu().querySelector('[data-batch="pl-new"]').click();
    assert.equal(f.app.customPlaylists[1].tracks.length, 4);
    // 没选中的行右键：回到单曲菜单
    rightClick('Song 9');
    assert.equal(menu(), null);
    assert.ok(f.calls.some((c) => c[0] === 'ctx'));
    assert.equal(f.view.list.picked.length, 0);
    // Ctrl+A、Esc
    const vp = el.querySelector('[data-l="viewport"]');
    vp.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(f.view.list.picked.length, 30);
    vp.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(f.view.list.picked.length, 0);
    // 拖多选里的一行 = 拖这几首
    click('Song 10'); click('Song 12', { shiftKey: true });
    const pe = (type, target, x, y) => target.dispatchEvent(new f.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    pe('pointerdown', rowOf('Song 11'), 100, 100); pe('pointermove', rowOf('Song 11'), 140, 102);
    assert.match(doc.querySelector('.archive-drag-ghost').textContent, /3 首/);
    pe('pointerup', el.querySelector('[data-drop="p"]'), 200, 300);
    assert.equal(doc.querySelector('.archive-drag-ghost'), null);
    assert.ok(['/m/10', '/m/11', '/m/12'].every((p) => f.app.customPlaylists[0].tracks.includes(p)));
    f.close();
});

test('批量移除：歌单里只从这个歌单移除；曲库里要再点一次确认，正在放的那首留着，都能撤销', () => {
    const toasts = [];
    let savedLib = 0;
    const f = fixture({ setup: (w, app) => { app.saveCustomPlaylists = () => {}; app.api = { saveMusicPlaylist: () => { savedLib++; } }; w.MusicToast = { show: (t) => toasts.push(t) }; } });
    const el = f.view.list.el;
    const doc = f.w.document;
    f.view.setListOpen(true);
    const rowOf = (title) => [...el.querySelectorAll('.archive-list-row')].find((n) => n.querySelector('b').textContent === title);
    const click = (title, mods = {}) => rowOf(title).dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, ...mods }));
    const menu = () => doc.querySelector('.archive-batch-menu');
    const rightClick = (title) => rowOf(title).dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    // 歌单分类里
    el.querySelector('[data-kind="playlist"]').click();
    click('Song 5'); click('Song 7', { ctrlKey: true });
    rightClick('Song 7');
    assert.match(menu().querySelector('[data-batch="remove"]').textContent, /从歌单「夜间散步」移除/);
    menu().querySelector('[data-batch="remove"]').click();
    assert.equal(f.app.customPlaylists[0].tracks.join(), '/m/9');
    assert.equal(f.app.playlist.length, 30, '曲库不动');
    toasts[toasts.length - 1].action.run();
    assert.equal(f.app.customPlaylists[0].tracks.join(), '/m/5,/m/7,/m/9');
    // 曲库里：正在放的是第 0 首
    el.querySelector('[data-kind="all"]').click();
    const playing = f.app.playlist[0];
    click('Song 0'); click('Song 3', { ctrlKey: true }); click('Song 4', { ctrlKey: true });
    rightClick('Song 3');
    const rm = menu().querySelector('[data-batch="remove"]');
    assert.match(rm.textContent, /从曲库列表移除/);
    rm.click();
    assert.ok(menu(), '第一下只是问');
    assert.equal(f.app.playlist.length, 30);
    assert.match(rm.textContent, /再点一次/);
    rm.click();
    assert.equal(menu(), null);
    assert.equal(f.app.playlist.length, 28);
    assert.equal(f.app.playlist[f.app.currentTrackIndex], playing, '正在放的那首留着，下标跟着对上');
    assert.equal(f.app.playlist.some((t) => t.title === 'Song 3' || t.title === 'Song 4'), false);
    assert.equal(Number(f.text('files')), 28);
    assert.equal(savedLib, 1);
    assert.match(toasts[toasts.length - 1].message, /移除 2 首（正在播放的那首留着）/);
    toasts[toasts.length - 1].action.run();
    assert.equal(f.app.playlist.length, 30);
    assert.equal(f.app.playlist[3].title, 'Song 3');
    assert.equal(Number(f.text('files')), 30);
    f.close();
});

test('批量移除后撤销：只把移除的插回原位，期间新扫进来的歌留着；手动队列里拿掉的也回到原来的位置', () => {
    const toasts = [];
    const queue = [];
    const f = fixture({ setup: (w, app) => {
        app.saveCustomPlaylists = () => {}; app.api = { saveMusicPlaylist() {} };
        app.manualQueue = queue;
        app.queueAdd = (t) => { queue.push(t); return t; };
        app.queueRemove = (i) => { queue.splice(i, 1); };
        app.queueMove = (from, to) => { const [t] = queue.splice(from, 1); queue.splice(to, 0, t); };
        w.MusicToast = { show: (t) => toasts.push(t) };
    } });
    const el = f.view.list.el;
    f.view.setListOpen(true);
    const rowOf = (title) => [...el.querySelectorAll('.archive-list-row')].find((n) => n.querySelector('b').textContent === title);
    const click = (title, mods = {}) => rowOf(title).dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, ...mods }));
    const lib = f.app.playlist;
    queue.push(lib[8], lib[3], lib[9], lib[5]);
    click('Song 3'); click('Song 4', { ctrlKey: true }); click('Song 5', { ctrlKey: true });
    rowOf('Song 4').dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const rm = f.w.document.querySelector('.archive-batch-menu [data-batch="remove"]');
    rm.click(); rm.click();
    assert.equal(f.app.playlist.length, 27);
    assert.equal(queue.map((t) => t.title).join(), 'Song 8,Song 9');
    // 期间扫描追加了两首（播放器换了一个新数组），又少了一首
    f.app.playlist = f.app.playlist.filter((t) => t.title !== 'Song 2').concat([{ path: '/m/n1', title: 'New 1' }, { path: '/m/n2', title: 'New 2' }]);
    f.view.refresh();
    toasts[toasts.length - 1].action.run();
    const titles = f.app.playlist.map((t) => t.title);
    assert.equal(titles.length, 31);
    assert.deepEqual(titles.slice(0, 7), ['Song 0', 'Song 1', 'Song 3', 'Song 4', 'Song 5', 'Song 6', 'Song 7'], '前一首不在了就接在更前面还在的那首后面，三首相对顺序不变');
    assert.deepEqual(titles.slice(-2), ['New 1', 'New 2'], '新增的还在');
    assert.equal(f.app.playlist[f.app.currentTrackIndex].title, 'Song 0');
    assert.equal(queue.map((t) => t.title).join(), 'Song 8,Song 3,Song 9,Song 5', '队列回到原样');
    assert.equal(Number(f.text('files')), 31);
    f.close();
});

test('只用键盘：Shift+方向键选一段、回头收窄、不按 Shift 回到单选；菜单键开批量菜单并加入歌单；歌单的删除确认取消后焦点回到删除按钮', () => {
    const toasts = [];
    const f = fixture({ setup: (w, app) => { app.saveCustomPlaylists = () => {}; w.MusicToast = { show: (t) => toasts.push(t) }; } });
    const el = f.view.list.el;
    const doc = f.w.document;
    f.view.setListOpen(true);
    const vp = el.querySelector('[data-l="viewport"]');
    const kd = (key, mods = {}, target = vp) => target.dispatchEvent(new f.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
    const picked = () => Array.from(f.view.list.picked, (i) => f.app.playlist[i].title);
    const rowOf = (title) => [...el.querySelectorAll('.archive-list-row')].find((n) => n.querySelector('b').textContent === title);
    rowOf('Song 3').dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
    kd('ArrowDown', { shiftKey: true });
    kd('ArrowDown', { shiftKey: true });
    assert.deepEqual(picked(), ['Song 3', 'Song 4', 'Song 5']);
    kd('ArrowUp', { shiftKey: true });
    assert.deepEqual(picked(), ['Song 3', 'Song 4'], '往回走是收窄，不是另起一段');
    kd('ArrowUp', { shiftKey: true });
    assert.deepEqual(picked(), [], '回到起点就只剩单选');
    kd('ArrowUp', { shiftKey: true });
    assert.deepEqual(picked(), ['Song 2', 'Song 3'], '越过起点往另一边选');
    assert.match(el.querySelector('[data-l="multiNote"]').textContent, /已选 2 首.*菜单键/);
    // 菜单键：批量菜单，焦点在第一项；方向键走到「加入歌单」回车
    kd('ContextMenu');
    const menu = doc.querySelector('.archive-batch-menu');
    assert.ok(menu && doc.activeElement && menu.contains(doc.activeElement), '焦点进了菜单');
    const target = menu.querySelector('[data-batch="pl"]');
    target.focus();
    kd('Enter', {}, target);
    assert.ok(['/m/2', '/m/3'].every((p) => f.app.customPlaylists[0].tracks.includes(p)));
    assert.equal(doc.querySelector('.archive-batch-menu'), null);
    assert.equal(doc.activeElement, vp, '菜单关掉后焦点回目录');
    kd('ArrowDown');
    assert.deepEqual(picked(), [], '不按 Shift 移动就回到单选');
    // 歌单标题上的删除：取消后焦点回到删除按钮，不掉到页面上
    el.querySelector('[data-kind="playlist"]').click();
    el.querySelector('[data-pl="delete"]').click();
    assert.equal(doc.activeElement.dataset.pl, 'delete-no');
    doc.activeElement.click();
    assert.equal(doc.activeElement.dataset.pl, 'delete');
    f.close();
});

test('歌词面板只由「歌词」按钮开合：打开这一页时不弹，播放、浏览别的歌、定位当前播放都不替你开关', () => {
    const f = fixture({
        setup: (w, app) => {
            Object.defineProperty(w, 'innerWidth', { value: 1920 }); Object.defineProperty(w, 'innerHeight', { value: 1080 });
            app.currentLyrics = [{ time: 0, text: 'a' }, { time: 5, text: 'b' }];
            app.isPlaying = true;
            app.stageHost = { active: false, enter() {} };
        }
    });
    const doc = f.w.document;
    const el = doc.querySelector('.archive-lyrics');
    const hud = doc.querySelector('.archive-hud');
    const btn = doc.querySelector('[data-act="lyrics"]');
    assert.equal(el.hidden, true, '打开这一页时不弹');
    f.key('Enter');
    assert.equal(el.hidden, true, '回车播放不自动打开');
    btn.click();
    assert.equal(el.hidden, false);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.ok(hud.classList.contains('lyrics-open'));
    f.key('ArrowDown'); // 去看别的歌：歌词还是正在放的那首，面板留着
    assert.equal(el.hidden, false);
    f.key('l', { ctrlKey: true });
    assert.equal(el.hidden, false);
    btn.click();
    assert.equal(el.hidden, true, '按钮可以手动收起');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.ok(!hud.classList.contains('lyrics-open'));
    f.close();
});

test('CONTROL 入口：播放器给了 openMusicControls 就用它；没有就回经典视图并展开声学处理', () => {
    const calls = [];
    const f = fixture({ setup: (w, app) => { app.openMusicControls = (s) => calls.push(['open', s]); } });
    const doc = f.w.document;
    doc.querySelector('[data-act="controls"]').click();
    assert.equal(calls.length, 1);
    delete f.app.openMusicControls;
    const drawer = doc.createElement('div'); drawer.id = 'acoustic-drawer';
    drawer.innerHTML = '<button class="acoustic-drawer-toggle" aria-expanded="false"></button>';
    drawer.firstChild.addEventListener('click', () => calls.push(['toggle']));
    doc.body.appendChild(drawer);
    doc.querySelector('[data-act="controls"]').click();
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], 'toggle');
    assert.equal(f.view.debug().mode, 'classic');
    f.close();
});

test('目录可以按住上下拖着滚动：拖动时跟手，松手不算点击；横着拖一行才是拎歌', () => {
    const f = fixture({});
    const el = f.view.list.el;
    f.view.setListOpen(true);
    const vp = el.querySelector('[data-l="viewport"]');
    const pe = (type, target, x, y) => target.dispatchEvent(new f.w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    const row = el.querySelectorAll('.archive-list-row')[4];
    const before = f.view.debug().selected;
    assert.equal(row.draggable, false, '不用系统拖放');
    pe('pointerdown', row, 100, 400);
    pe('pointermove', row, 102, 396); // 还没过阈值
    assert.equal(vp.scrollTop, 0);
    pe('pointermove', row, 103, 300);
    assert.equal(vp.scrollTop, 100, '内容跟着手往上走');
    assert.ok(el.classList.contains('grabbing'));
    assert.equal(el.querySelector('[data-l="shelf"]').hidden, true, '上下拖不出歌单架');
    pe('pointermove', row, 103, 340);
    assert.equal(vp.scrollTop, 60);
    pe('pointerup', row, 103, 340);
    assert.ok(!el.classList.contains('grabbing'));
    row.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.equal(f.view.debug().selected, before, '拖完松手那一下不选中');
    f.close();
});

test('矮窗口不再整体缩到看不清：缩放不低于 0.9，改成挪位置（short）', () => {
    const f = fixture({ setup: (w) => { Object.defineProperty(w, 'innerWidth', { value: 760 }); Object.defineProperty(w, 'innerHeight', { value: 600 }); } });
    const hud = f.w.document.querySelector('.archive-hud');
    assert.match(hud.style.transform, /scale\(0\.9\)/);
    assert.ok(hud.classList.contains('narrow'));
    assert.ok(hud.classList.contains('short'));
    assert.equal(Math.round(parseFloat(hud.style.height)), 667);
    f.close();
});

test('音乐窗口最小宽度（420）走很窄的排版：导航挪到左边，目录收起品牌和列头', () => {
    const f = fixture({ setup: (w) => { Object.defineProperty(w, 'innerWidth', { value: 420 }); Object.defineProperty(w, 'innerHeight', { value: 600 }); } });
    const hud = f.w.document.querySelector('.archive-hud');
    assert.ok(hud.classList.contains('tiny'));
    f.close();
    const g = fixture({ setup: (w) => { Object.defineProperty(w, 'innerWidth', { value: 1024 }); Object.defineProperty(w, 'innerHeight', { value: 600 }); } });
    assert.ok(!g.w.document.querySelector('.archive-hud').classList.contains('tiny'), '1024 宽照常');
    g.close();
    const css = ['archive.css', 'archive-list.css', 'archive-lyrics.css', 'archive-tuning.css'].map((f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '../Musicmodules/music-archive', f), 'utf8')).join('');
    assert.match(css, /\.archive-hud\.tiny \.archive-nav \{[^}]*left:/);
    assert.match(css, /\.archive-hud\.tiny \.archive-list-cols \{ display: none; \}/);
    assert.match(css, /\.archive-hud\.tiny \.archive-list-brand \{ display: none; \}/);
});

test('笔记本尺寸（1280×800）走中等排版：目录默认开着，检索、歌词这些入口不藏', () => {
    const f = fixture({ setup: (w) => { Object.defineProperty(w, 'innerWidth', { value: 1280 }); Object.defineProperty(w, 'innerHeight', { value: 800 }); } });
    const hud = f.w.document.querySelector('.archive-hud');
    assert.ok(hud.classList.contains('mid'));
    assert.ok(!hud.classList.contains('narrow'));
    assert.ok(hud.classList.contains('list-open'), '目录默认开着');
    f.close();
});

test('跟着在听：选中停在正在放的那首时，播放器换到下一首，选中跟过去；在看别的歌时不动', async () => {
    const f = fixture({
        setup: (w, app) => {
            Object.defineProperty(w, 'innerWidth', { value: 1920 }); Object.defineProperty(w, 'innerHeight', { value: 1080 });
            app.currentLyrics = [{ time: 0, text: 'a' }, { time: 5, text: 'b' }];
            app.isPlaying = true;
            app.stageHost = { active: false, enter() {} };
        }
    });
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    const el = f.w.document.querySelector('.archive-lyrics');
    f.w.document.querySelector('[data-act="lyrics"]').click();
    f.key('Enter');
    const first = f.view.debug().selected;
    assert.equal(first, f.app.currentTrackIndex);
    assert.equal(el.hidden, false);
    // 播放器自己接到下一首
    const next = (first + 1) % f.app.playlist.length;
    f.app.currentTrackIndex = next;
    await wait(1150);
    assert.equal(f.view.debug().selected, next, '选中跟到新的这首');
    assert.equal(el.hidden, false, '歌词面板留着');
    // 去看别的歌：之后再换歌也不把选中拽回去（歌词面板只由按钮开合）
    f.key('ArrowDown'); f.key('ArrowDown');
    const browsing = f.view.debug().selected;
    assert.equal(el.hidden, false);
    f.app.currentTrackIndex = (next + 5) % f.app.playlist.length;
    await wait(1150);
    assert.equal(f.view.debug().selected, browsing);
    f.close();
});

test('键盘：检索框里 Tab 只在有字时换分类，到最后一类就放焦点出去', () => {
    const f = fixture();
    const doc = f.w.document;
    const input = doc.querySelector('.archive-list-search input');
    const tab = (shiftKey = false) => {
        const e = new f.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
        input.dispatchEvent(e);
        return e.defaultPrevented;
    };
    assert.equal(tab(), false, '空框里 Tab 是普通的下一个控件');
    assert.equal(f.view.list.kind, 'all');
    input.value = 'Song';
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    assert.equal(tab(true), false, '第一类再 Shift+Tab 就出去，不绕到最后一类');
    for (const k of ['artist', 'album', 'playlist', 'recent']) { assert.equal(tab(), true); assert.equal(f.view.list.kind, k); }
    assert.equal(tab(), false, '最后一类再 Tab 就出去，不绕回第一类');
    assert.equal(f.view.list.kind, 'recent');
    f.close();
});

test('每日推荐：有推荐时阵列最前面多一列「每日推荐」，在这一列里点播就放这 30 首', () => {
    const f = fixture({ n: 80, setup: (w, app) => { app.dailyMix = () => app.playlist.slice(10, 40); } });
    const cols = f.view.debug().columns;
    assert.equal(cols[0].id, 'daily');
    assert.equal(cols[0].n, 30);
    // 跳到这一列，分组名写「每日推荐」，在这一列里点播，队列就是这 30 首
    while (f.view.debug().lane !== 0) f.key('ArrowLeft');
    assert.equal(f.text('laneName'), '每日推荐');
    f.key('Home');
    f.key('Enter');
    const load = f.calls.find((c) => c[0] === 'load');
    assert.equal(f.app.playlist[load[1]].path, '/m/10');
    assert.equal(load[2], 30);
    f.close();
    const g = fixture({ n: 80 });
    assert.notEqual(g.view.debug().columns[0].id, 'daily', '没有 dailyMix 时不加这一列');
    g.close();
});

test('目录换分类：阵列跟过去（歌手没有对应的列时不动）；检索第一条结果带着阵列走', () => {
    const f = fixture({ n: 60, playlists: [{ id: 'p', name: '夜间散步', tracks: ['/m/5', '/m/7', '/m/9'] }] });
    f.view.setListOpen(true);
    const colKind = () => { const d = f.view.debug(); const n = d.columns.length; return d.columns[((d.lane % n) + n) % n].id; };
    f.view.list.el.querySelector('[data-kind="playlist"]').click();
    assert.equal(colKind(), 'playlist:p');
    assert.equal(f.text('laneName'), '夜间散步');
    // 歌手没有对应的列：阵列不动
    f.view.list.el.querySelector('[data-kind="artist"]').click();
    assert.equal(colKind(), 'playlist:p');
    // 专辑有列时阵列跳到专辑列，分组名就是那张专辑
    f.view.list.el.querySelector('[data-kind="album"]').click();
    assert.ok(/^album:/.test(colKind()), colKind());
    assert.equal(f.text('laneName'), colKind().slice(6));
    f.view.list.el.querySelector('[data-kind="all"]').click();
    assert.ok(/^letter:|^all$/.test(colKind()), colKind());
    // 检索：第一条结果带着阵列走
    f.view.list.input.value = 'Song 42';
    f.view.list.input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    assert.equal(f.selTitle(), 'Song 42');
    // 没有结果：目录底部计数归零，选中不动
    f.view.list.input.value = 'zzqx';
    f.view.list.input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    assert.ok(f.view.list.el.querySelector('.archive-list-foot').classList.contains('zero'));
    assert.equal(f.selTitle(), 'Song 42');
    f.close();
});

test('the toolbar has 进入舞台 where 正在播放 used to be; Ctrl+L still finds the playing track', () => {
    const f = fixture();
    const doc = f.w.document;
    assert.equal(doc.querySelector('.archive-nav [data-act="now"]'), null, '正在播放 button is gone');
    const stage = doc.querySelector('.archive-nav [data-act="stage"]');
    assert.ok(stage, '进入舞台 button is in the toolbar');
    assert.match(stage.textContent, /进入舞台/);
    stage.click();
    assert.equal(f.app.stageHost.active, true, 'clicking it enters the stage');
    f.close();
});

test('archive list render batches viewport reads before edge-class writes and destroy disconnects observers/listeners', async () => {
    const roInstances = [];
    const f = fixture({
        setup: (w) => {
            w.ResizeObserver = class TrackedRO {
                constructor(cb) { this.cb = cb; this.disconnected = false; roInstances.push(this); }
                observe() {}
                unobserve() {}
                disconnect() { this.disconnected = true; }
            };
        }
    });
    f.view.setListOpen(true);
    const vp = listEl(f, 'viewport');
    const ops = [];
    let scrollTopVal = 0;
    Object.defineProperty(vp, 'scrollTop', {
        configurable: true,
        get() { ops.push('read:scrollTop'); return scrollTopVal; },
        set(v) { scrollTopVal = v; }
    });
    Object.defineProperty(vp, 'clientHeight', {
        configurable: true,
        get() { ops.push('read:clientHeight'); return 480; }
    });
    const origToggle = vp.classList.toggle.bind(vp.classList);
    vp.classList.toggle = (name, force) => {
        if (name === 'at-top' || name === 'at-bottom') ops.push(`write:${name}`);
        return origToggle(name, force);
    };
    // 跨微任务后未发生真实滚动，持久缓存生效，reveal 跳过强制 scrollTop 读取
    await Promise.resolve();
    f.view.list.reveal(0, 'all', { quiet: true });
    assert.ok(!ops.includes('read:scrollTop'), `persistent scrollTop cache skips reflow across microtasks: ${ops.join(',')}`);
    assert.ok(ops.includes('read:clientHeight'), `viewport clientHeight measured once on first reveal: ${ops.join(',')}`);
    // 发生真实 scroll 事件后 scrollTop 标脏，验证常规 reveal 严格先读后写
    ops.length = 0;
    vp.dispatchEvent(new f.w.Event('scroll'));
    f.view.list.reveal(0, 'all', { quiet: true });
    const firstWrite = ops.findIndex((o) => o.startsWith('write:'));
    const lastReadBefore = ops.reduce((idx, o, i) => (i < firstWrite && o.startsWith('read:') ? i : idx), -1);
    assert.ok(firstWrite >= 1, `expected reads before writes, got ${ops.join(',')}`);
    assert.ok(ops.slice(0, firstWrite).includes('read:scrollTop'), `scrollTop read before class toggles: ${ops.join(',')}`);
    assert.ok(lastReadBefore >= 0);

    // 紧跟 rebuild() 的同帧 reveal(已选中行, quiet) 应复用刚同步的 scrollTop，不再触发重排或冗余写入
    f.view.list.rebuild();
    ops.length = 0;
    f.view.list.reveal(f.app.playlist.length ? 0 : -1, 'all', { quiet: true });
    assert.ok(!ops.includes('read:scrollTop'), `same-tick reveal after rebuild skips scrollTop reflow: ${ops.join(',')}`);

    assert.ok(roInstances.length > 0, 'ResizeObserver created');
    f.view.destroy();
    assert.ok(roInstances.every((ro) => ro.disconnected), 'all ResizeObservers disconnected on destroy');
    // 已销毁后派发全局目录事件不应报错或重新渲染
    ops.length = 0;
    f.w.document.dispatchEvent(new f.w.Event('music-like-change'));
    f.w.document.dispatchEvent(new f.w.Event('music-stats-change'));
    f.w.document.dispatchEvent(new f.w.Event('music-track-health'));
    assert.equal(ops.length, 0, 'destroyed list does not respond to global events');
    f.close();
});

test('archive grain tile encodes a valid PNG without 2D canvas and revokes object URL on destroy', () => {
    const zlib = require('node:zlib');
    const createdBlobs = [];
    const revokedUrls = [];
    let getContextCalls = 0;
    const f = fixture({
        setup: (w) => {
            w.HTMLCanvasElement.prototype.getContext = () => { getContextCalls += 1; return null; };
            w.Blob = class CapturedBlob {
                constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; }
            };
            w.URL.createObjectURL = (blob) => {
                const url = `blob:grain-${createdBlobs.length}`;
                createdBlobs.push({ url, blob });
                return url;
            };
            w.URL.revokeObjectURL = (url) => { revokedUrls.push(url); };
            w.requestIdleCallback = (fn) => { fn(); return 1; };
        }
    });
    assert.equal(getContextCalls, 0, 'grain PNG encoding must not touch 2D canvas');
    assert.equal(createdBlobs.length, 1, 'created one grain PNG blob');
    assert.equal(createdBlobs[0].blob.type, 'image/png');
    const buf = Buffer.from(createdBlobs[0].blob.parts[0]);
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(buf.readUInt32BE(16), 160);
    assert.equal(buf.readUInt32BE(20), 160);
    const idatOff = 33;
    const idatLen = buf.readUInt32BE(idatOff);
    const inflated = zlib.inflateSync(buf.subarray(idatOff + 8, idatOff + 8 + idatLen));
    assert.equal(inflated.length, 160 * 321);
    if (typeof zlib.crc32 === 'function') {
        assert.equal(zlib.crc32(buf.subarray(12, 29)), buf.readUInt32BE(29));
        assert.equal(zlib.crc32(buf.subarray(idatOff + 4, idatOff + 8 + idatLen)), buf.readUInt32BE(idatOff + 8 + idatLen));
    }
    f.view.destroy();
    assert.ok(revokedUrls.includes(createdBlobs[0].url), 'destroy revokes grain blob URL');
    f.close();
});

test('archive wall createThumbs ignores in-flight completions and skips callbacks after destroy', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const images = [];
    w.Image = class FakeImage {
        constructor() { images.push(this); }
        set src(v) { this._src = v; }
        get src() { return this._src; }
    };
    w.eval(read('Musicmodules/music-archive/archive-wall.js'));
    let readyCalls = 0;
    const thumbs = w.MusicArchiveWall.createThumbs(() => { readyCalls += 1; });
    assert.equal(thumbs.get('file:///cover.jpg', 180), '');
    assert.equal(images.length, 1);
    thumbs.destroy();
    // 销毁后在途图片完成加载，不应触发 onReady 或重新入队
    images[0].naturalWidth = 100;
    images[0].naturalHeight = 100;
    images[0].onload();
    assert.equal(readyCalls, 0, 'destroyed thumb cache suppresses late onReady callback');
    assert.equal(thumbs.get('file:///cover2.jpg', 180), '');
    assert.equal(images.length, 1, 'destroyed thumb cache does not enqueue new loads');
    w.close();
});

test('archive wall stops idle rAF during CSS entry and detaches pooled cover srcs on hide', () => {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const rafQueue = [];
    let nextRaf = 1;
    w.requestAnimationFrame = (cb) => { const id = nextRaf++; rafQueue.push({ id, cb }); return id; };
    w.cancelAnimationFrame = (id) => {
        const idx = rafQueue.findIndex((r) => r.id === id);
        if (idx !== -1) rafQueue.splice(idx, 1);
    };
    w.Image = class FakeImage {
        set src(v) {
            this._src = v;
            this.naturalWidth = 100;
            this.naturalHeight = 100;
            this.onload?.();
        }
    };
    w.eval(read('Musicmodules/music-archive/archive-wall.js'));
    const tracks = Array.from({ length: 16 }, (_, i) => ({ path: `/m/${i}.flac`, title: `Song ${i}`, artist: 'A', album: 'B', cover: `file:///c${i}.jpg` }));
    const wall = w.MusicArchiveWall.create({
        host: w.document.getElementById('host'),
        items: () => ({ key: 'all', ids: tracks.map((_, i) => i), name: '全部' }),
        track: (i) => tracks[i],
        cover: (t) => t.cover,
        selected: () => 0,
        playing: () => ({ index: -1, active: false }),
        meta: (t, i) => ({ title: t.title, artist: t.artist, album: t.album, code: String(i + 1).padStart(3, '0'), duration: '3:00' }),
        pick() {}, play() {}, menu() {},
        reducedMotion: () => false
    });
    wall.setRoom({ left: 0, top: 0, width: 900, height: 600 });
    wall.show(true);
    // 排完初始帧后静止在墙面上：CSS aw-entering 自行播放，tick 不应继续空转 rAF
    let steps = 0;
    while (rafQueue.length && steps < 5) {
        const job = rafQueue.shift();
        job.cb(100 + steps * 16);
        steps += 1;
    }
    assert.equal(rafQueue.length, 0, 'stationary wall schedules zero extra rAF frames during CSS entry window');
    assert.ok(wall.el.querySelectorAll('.aw-tile img[src]').length > 0, 'visible tiles loaded cover srcs');

    wall.show(false);
    // 隐藏后回收池中不应残留已解码的 img src
    assert.equal(wall.el.querySelectorAll('.aw-tile').length, 0);
    wall.destroy();
    w.close();
});

test('archive list skips viewport clientHeight read on initial empty rebuild and silent keepalive WAV stays compact', () => {
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.eval(read('Musicmodules/music-archive/archive-index.js'));
    w.eval(read('Musicmodules/music-archive/archive-list.js'));
    const idx = w.MusicArchiveIndex.createIndex([]);
    const list = w.MusicArchiveList.create({
        host: w.document.getElementById('host'),
        app: { playlist: [], customPlaylists: [] },
        Index: w.MusicArchiveIndex,
        getIndex: () => idx,
        getRecent: () => [],
        columnOfGroup: () => null,
        onPick() {}, onPlay() {},
        fileNumber: (_, i) => i + 1,
        isNarrow: () => false
    });
    const vp = list.el.querySelector('[data-l="viewport"]');
    let clientHeightReads = 0;
    Object.defineProperty(vp, 'clientHeight', { get() { clientHeightReads += 1; return 600; }, configurable: true });
    list.rebuild();
    assert.equal(clientHeightReads, 0, 'empty archive list rebuild/render avoids forced synchronous layout');
    list.destroy();

    // 验证 createSilentAudio 生成紧凑 8kHz 10s PCM WAV (~160KB) 并在重复调用时释放旧 URL
    const blobs = [];
    const revoked = [];
    w.Blob = class CapturedBlob { constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; } };
    w.URL.createObjectURL = (b) => { const u = `blob:silent-${blobs.length}`; blobs.push({ u, b }); return u; };
    w.URL.revokeObjectURL = (u) => revoked.push(u);
    w.eval(read('Musicmodules/music-ui.js'));
    const app = { api: {} };
    w.setupUI(app);
    const u1 = app.createSilentAudio();
    const u2 = app.createSilentAudio();
    assert.notEqual(u1, u2);
    assert.deepEqual(revoked, [u1], 'second createSilentAudio revokes previous ObjectURL');
    const wav = Buffer.from(blobs[0].b.parts[0]);
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 8000, 'sample rate is 8 kHz');
    assert.equal(wav.length, 44 + 8000 * 10 * 2, '10-second 8 kHz 16-bit mono WAV is 160044 bytes');
    w.close();
});

test('Batch 60: dragging archive index ruler reads getBoundingClientRect once per pointermove', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    const bar = f.w.document.querySelector('[data-ref="rulerTrack"]');
    let rectReads = 0;
    bar.getBoundingClientRect = () => {
        rectReads += 1;
        return { left: 100, top: 0, width: 314, height: 40, right: 414, bottom: 40 };
    };
    bar.setPointerCapture = () => {};
    const ev = (type, x) => {
        const e = new f.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        bar.dispatchEvent(e);
    };
    ev('pointerdown', 120);
    rectReads = 0;
    ev('pointermove', 180);
    ev('pointermove', 260);
    ev('pointermove', 340);
    assert.equal(rectReads, 3, '3 dragging pointermoves read rulerTrack bounding rect exactly once each');
    ev('pointerup', 340);
    f.close();
});

test('Batch 62: archive-list search highlights matched title, keeps unmatched meta plain, and updates brand title span in-place', () => {
    const f = fixture({ n: 20 });
    f.view.setListOpen(true);
    const input = f.view.list.input;
    const brand = f.view.list.el.querySelector('[data-l="brandTitle"]');
    input.value = 'Song 1';
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    const firstSpan = brand.lastElementChild;
    assert.ok(firstSpan && firstSpan.textContent.includes('Song 1'));

    input.value = 'Song 12';
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    assert.equal(brand.lastElementChild, firstSpan, 'consecutive typing updates brand title span in-place');
    assert.equal(firstSpan.textContent, '「Song 12」');

    const row = f.view.list.el.querySelector('.archive-list-row');
    assert.ok(row, 'matched row rendered');
    assert.ok(row.querySelector('.tx b mark'), 'matching title gets <mark> highlight');
    assert.equal(row.querySelector('.tx em mark'), null, 'non-matching meta stays plain text without <mark>');
    f.close();
});

test('Batch 64: showClassic defers ambient/visualizer init to cancellable rAF, and wall/grid cover callbacks update in-place', () => {
    // 1. showClassic defers originalCreateAmbient to next rAF and cancels if returning to archive before firing
    let ambientCalls = 0;
    const pendingRafs = [];
    let rafSeq = 1;
    const f = fixture({
        setup: (w, app) => {
            app.createAmbientPixi = () => { ambientCalls += 1; };
            w.requestAnimationFrame = (cb) => { const id = rafSeq++; pendingRafs.push({ id, cb }); return id; };
            w.cancelAnimationFrame = (id) => {
                const idx = pendingRafs.findIndex((r) => r.id === id);
                if (idx !== -1) pendingRafs.splice(idx, 1);
            };
        }
    });
    const flushRafs = () => { while (pendingRafs.length) { const batch = pendingRafs.splice(0); batch.forEach((r) => r.cb(16)); } };
    flushRafs();
    ambientCalls = 0;
    f.view.showClassic();
    assert.equal(ambientCalls, 0, 'showClassic does not synchronously invoke createAmbientPixi (avoids forced reflow)');
    // Returning to archive before rAF cancels the deferred ambient init
    f.view.show();
    flushRafs();
    assert.equal(ambientCalls, 0, 'returning to archive cancels pending classicInitRaf');
    // Entering classic and letting rAF run invokes createAmbientPixi once
    f.view.showClassic();
    assert.equal(ambientCalls, 0);
    flushRafs();
    assert.equal(ambientCalls, 1, 'deferred classicInitRaf invokes createAmbientPixi on next frame');
    f.close();

    // 2. archive-wall & archive-grid cover-ready callbacks update only matching mounted tiles + grid binds passive wheel
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.HTMLElement.prototype.scrollTo = function (opts) { if (opts && typeof opts.top === 'number') this.scrollTop = opts.top; };
    const rafs = [];
    let rid = 1;
    w.requestAnimationFrame = (cb) => { const id = rid++; rafs.push({ id, cb }); return id; };
    w.cancelAnimationFrame = (id) => { const i = rafs.findIndex((r) => r.id === id); if (i !== -1) rafs.splice(i, 1); };
    const imgs = [];
    w.Image = class DeferredImg {
        constructor() { imgs.push(this); }
        set src(v) { this._src = v; }
        get src() { return this._src; }
    };
    const origAdd = w.HTMLElement.prototype.addEventListener;
    const wheelOpts = [];
    w.HTMLElement.prototype.addEventListener = function (type, fn, opts) {
        if (type === 'wheel' && this.classList?.contains('archive-grid')) wheelOpts.push(opts);
        return origAdd.call(this, type, fn, opts);
    };
    w.eval(read('Musicmodules/music-archive/archive-wall.js'));
    w.eval(read('Musicmodules/music-archive/archive-grid.js'));
    const tracks = Array.from({ length: 8 }, (_, i) => ({ path: `/m/${i}.flac`, title: `Song ${i}`, artist: 'A', album: 'B', cover: `file:///c${i}.jpg` }));
    const grid = w.MusicArchiveGrid.create({
        host: w.document.getElementById('host'),
        sections: () => ({ key: 'all', list: [{ id: 's0', name: 'A', sub: '', ids: tracks.map((_, i) => i) }] }),
        track: (i) => tracks[i],
        cover: (t) => t.cover,
        selected: () => 0,
        playing: () => ({ index: -1, active: false }),
        meta: (t, i) => ({ title: t.title, artist: t.artist, album: t.album, code: String(i + 1).padStart(3, '0') }),
        pick() {}, play() {}, menu() {},
        reducedMotion: () => true
    });
    assert.ok(wheelOpts.some((o) => o && o.passive === true), 'archive-grid binds wheel stopPropagation listener as passive');
    grid.setRoom({ left: 0, top: 0, width: 800, height: 600 });
    grid.show(true);
    while (rafs.length) rafs.splice(0).forEach((r) => r.cb(16));
    const firstTile = grid.el.querySelector('.ag-cell');
    assert.ok(firstTile, 'grid mounted initial cards');
    assert.ok(imgs.length > 0, 'deferred cover thumbnail queued');
    // Complete first cover image -> applyCovers updates mounted img in-place without rebuilding tile DOM
    imgs[0].naturalWidth = 100;
    imgs[0].naturalHeight = 100;
    imgs[0].onload();
    while (rafs.length) rafs.splice(0).forEach((r) => r.cb(32));
    assert.equal(grid.el.querySelector('.ag-cell'), firstTile, 'cover-ready applyCovers preserves mounted card element');
    assert.ok(firstTile.querySelector('img').getAttribute('src'), 'cover-ready applyCovers populates tile img src');
    grid.destroy();
    w.close();
});

test('Batch 66: archive-list reuses mounted track rows in-place & updates likes in-place; archive-view coalesces syncSceneLayout & skips hidden work', () => {
    const rafs = [];
    let rafId = 1;
    let detailRooms = 0;
    let coverCalls = 0;
    const f = fixture({
        n: 30,
        setup: (w, app) => {
            w.requestAnimationFrame = (cb) => { const id = rafId++; rafs.push({ id, cb }); return id; };
            w.cancelAnimationFrame = (id) => { const i = rafs.findIndex((r) => r.id === id); if (i !== -1) rafs.splice(i, 1); };
            const liked = new Set();
            app.isLiked = (t) => Boolean(t && liked.has(t.path));
            app._liked = liked;
        }
    });
    f.view.destroy();
    f.app.archiveView = null;
    const root = f.w.document.getElementById('music-archive-view');
    root.innerHTML = '';
    const fakeSceneLib = {
        create() {
            const canvas = f.w.document.createElement('canvas');
            root.appendChild(canvas);
            return {
                canvas, target: { lane: 0, row: 0 }, dirty: false, detail: true, tier: { fps: 60, idleFps: 12 },
                setTheme() {}, resize() {}, setColumns() {}, jump() {}, select() {}, setPlaying() {}, setHover() {}, setPointer() {},
                setDetail(on) { this.detail = Boolean(on); },
                setCover() { coverCalls += 1; },
                setDetailRoom() { detailRooms += 1; },
                setLabelMask() {}, setLabeler() {}, refreshLabels() {}, touch() {}, raise() {},
                hold() {}, unhold() {}, turn() {}, pick: () => null, detailRect: () => null, dragAxes: () => null, camAt: () => null,
                step: () => ({ animated: false, idle: true, moving: false }),
                dispose() {}, debug: () => ({})
            };
        }
    };
    const view = f.w.MusicArchive.init(f.app, { sceneLib: fakeSceneLib, pinyinSrc: false });
    const origClose = f.close;
    f.close = () => { view.destroy(); origClose(); };
    f.view = view;
    const flushRafs = () => { while (rafs.length) rafs.splice(0).forEach((r) => r.cb(16)); };
    f.view.setListOpen(true);
    flushRafs();

    // 1. Archive-list in-place track row reuse across consecutive search rebuilds (preserves DOM order, clears stale title)
    const input = f.view.list.input;
    input.value = 'Song';
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    const initialRows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
    assert.ok(initialRows.length >= 10);
    initialRows[0].title = 'stale hover tooltip';

    let recentReads = 0;
    const origGetItem = f.w.localStorage.getItem.bind(f.w.localStorage);
    f.w.localStorage.getItem = (k) => { if (k === 'musicArchiveRecentQueries') recentReads += 1; return origGetItem(k); };

    input.value = 'Song 1';
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    assert.equal(recentReads, 0, 'paintRecentQ skips localStorage read while search query is non-empty');

    const nextRows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
    assert.ok(nextRows.length >= 2);
    assert.equal(nextRows[0], initialRows[0], 'first mounted track row reused in-place across search rebuild');
    assert.equal(nextRows[1], initialRows[1], 'second mounted track row reused in-place in ascending DOM order');
    assert.equal(nextRows[0].hasAttribute('title'), false, 'stale hover tooltip cleared on in-place reuse');

    // 2. music-like-change updates .lk.hidden in-place without tearing down rows
    const targetTrack = f.app.playlist.find((t) => t.title.startsWith(nextRows[0].querySelector('b').textContent));
    assert.ok(targetTrack);
    f.app._liked.add(targetTrack.path);
    f.w.document.dispatchEvent(new f.w.CustomEvent('music-like-change'));
    assert.equal(f.view.list.el.querySelector('.archive-list-row'), nextRows[0], 'music-like-change keeps mounted row node');
    assert.equal(nextRows[0].querySelector('.lk').hidden, false, 'music-like-change reveals heart in-place');

    // 3. archive-view resize coalesces syncSceneLayout to rAF & skips when hidden in classic mode
    detailRooms = 0;
    f.w.dispatchEvent(new f.w.Event('resize'));
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(detailRooms, 0, 'resize defers syncSceneLayout to rAF instead of forcing synchronous reflow');
    flushRafs();
    assert.equal(detailRooms, 1, 'multiple resizes coalesce into a single setDetailRoom call');

    detailRooms = 0;
    f.view.showClassic();
    flushRafs();
    assert.equal(detailRooms, 0, 'classic mode skips syncSceneLayout work');

    // 4. setCardExpanded(true) skips redundant setCover when already expanded
    f.view.show();
    flushRafs();
    coverCalls = 0;
    f.view.list.el.querySelector('.archive-list-row')?.click();
    const afterClick = coverCalls;
    f.view.list.el.querySelector('.archive-list-row')?.click();
    assert.equal(coverCalls, afterClick, 'repeated click on same expanded card avoids redundant setCover');
    f.close();
});

test('Batch 74: archive-list toggles .al-sq/.al-sq-f without :has() CSS and archive-view mirrors drawer-lyrics class onto body', () => {
    const f = fixture({ n: 24 });
    const listEl = f.view.list.el;
    const input = f.view.list.input;
    f.view.setListOpen(true);
    assert.equal(listEl.classList.contains('al-sq'), false, 'idle empty search has no .al-sq');
    assert.equal(listEl.classList.contains('al-sq-f'), false, 'idle unfocused search has no .al-sq-f');

    // Focusing search sets both .al-sq and .al-sq-f
    input.focus();
    input.dispatchEvent(new f.w.FocusEvent('focus'));
    assert.equal(listEl.classList.contains('al-sq'), true, 'focused search adds .al-sq');
    assert.equal(listEl.classList.contains('al-sq-f'), true, 'focused search adds .al-sq-f');

    // Typing query keeps .al-sq even after blur, while .al-sq-f clears on blur
    input.value = 'Song 1';
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    input.blur();
    input.dispatchEvent(new f.w.FocusEvent('blur'));
    assert.equal(listEl.classList.contains('al-sq'), true, 'non-empty query retains .al-sq after blur');
    assert.equal(listEl.classList.contains('al-sq-f'), false, 'blur clears .al-sq-f');

    // Clearing search removes .al-sq
    const clearBtn = listEl.querySelector('[data-l="clear"]');
    clearBtn.click();
    input.blur();
    input.dispatchEvent(new f.w.FocusEvent('blur'));
    assert.equal(listEl.classList.contains('al-sq'), false, 'clearing search removes .al-sq');

    // Drawer + lyrics mirrors body.music-archive-drawer-lyrics and cleans up on close/destroy
    f.app.currentLyrics = [{ time: 0, original: 'Line 1' }, { time: 5, original: 'Line 2' }];
    const lyricsBtn = f.w.document.querySelector('[data-ref="lyricsBtn"]');
    f.app.musicDock = { roomRight: 320 };
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(f.w.document.body.classList.contains('music-archive-drawer-lyrics'), false, 'lyrics closed keeps drawer-lyrics off');
    lyricsBtn.click();
    assert.equal(f.w.document.body.classList.contains('music-archive-drawer-lyrics'), true, 'lyrics open beside drawer sets body.music-archive-drawer-lyrics');
    f.app.musicDock.roomRight = 0;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(f.w.document.body.classList.contains('music-archive-drawer-lyrics'), false, 'drawer closed clears body.music-archive-drawer-lyrics');
    f.app.musicDock.roomRight = 320;
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(f.w.document.body.classList.contains('music-archive-drawer-lyrics'), true, 'reopening drawer with lyrics open restores body.music-archive-drawer-lyrics');
    f.view.destroy();
    assert.equal(f.w.document.body.classList.contains('music-archive-drawer-lyrics'), false, 'destroy cleans up body.music-archive-drawer-lyrics');

    const tuningCss = read('Musicmodules/music-archive/archive-tuning.css');
    const drawerCss = read('Musicmodules/music-dock/music-dock-drawer.css');
    assert.equal(tuningCss.includes('.archive-list:has('), false, 'archive-tuning.css drops all .archive-list:has(...) selectors');
    assert.match(tuningCss, /\.archive-list\.al-sq\b/);
    assert.match(tuningCss, /\.archive-list\.al-sq-f\b/);
    assert.doesNotMatch(drawerCss, /body[^{]*:has\(/, 'music-dock-drawer.css drops body :has(...) selector');
    assert.match(drawerCss, /body\.music-archive-on\.music-archive-drawer-lyrics/);
    f.close();
});

test('Batch 76: archive-view onKeyDown skips modalOpen DOM query on input typing and modifier shortcuts', () => {
    const f = fixture({ n: 12 });
    f.view.setListOpen(true);
    let modalQueries = 0;
    const origQS = f.w.document.querySelector.bind(f.w.document);
    f.w.document.querySelector = (sel) => {
        if (typeof sel === 'string' && sel.includes('.dialog-overlay')) modalQueries += 1;
        return origQS(sel);
    };
    try {
        // Typing inside the search input should short-circuit before calling modalOpen()
        const input = f.view.list.input;
        input.focus();
        for (const key of ['a', 'b', 'Backspace', 'Enter']) {
            input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        }
        assert.equal(modalQueries, 0, 'keys inside input skip modalOpen() querySelector');

        // Unhandled modifier shortcuts on document also skip modalOpen()
        f.w.document.body.focus();
        f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
        f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
        f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true, cancelable: true }));
        assert.equal(modalQueries, 0, 'modifier shortcuts skip modalOpen() querySelector');

        // Actual archive shortcut ('/') checks modalOpen() and focuses the search box
        f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
        assert.equal(modalQueries, 1, 'archive shortcut checks modalOpen() once');
        assert.equal(f.w.document.activeElement, input, '/ focuses archive search input');
    } finally {
        f.w.document.querySelector = origQS;
        f.close();
    }
});

test('Batch 84: archive-list paintRow bitmask skips unchanged writes and guards hidden background updates', async () => {
    const liked = new Set();
    const f = fixture({
        n: 40,
        setup: (w, app) => {
            app.isLiked = (t) => Boolean(t && liked.has(t.path));
            app.failedTracks = new w.Map();
        }
    });
    try {
        f.view.setListOpen(true);
        const rows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
        assert.ok(rows.length >= 6);
        const row0 = rows[0];
        const row1 = rows[1];

        let toggleCalls = 0;
        let ariaCalls = 0;
        for (const r of [row0, row1]) {
            const origToggle = r.classList.toggle.bind(r.classList);
            r.classList.toggle = (cls, force) => { toggleCalls += 1; return origToggle(cls, force); };
            const origSet = r.setAttribute.bind(r);
            r.setAttribute = (name, val) => {
                if (name === 'aria-selected') ariaCalls += 1;
                return origSet(name, val);
            };
        }

        // Unchanged health event does zero redundant classList.toggle / aria-selected writes
        f.w.document.dispatchEvent(new f.w.CustomEvent('music-track-health'));
        assert.equal(toggleCalls, 0, 'unchanged paintRow skips classList.toggle writes');
        assert.equal(ariaCalls, 0, 'unchanged paintRow skips aria-selected writes');

        // Marking a track bad toggles only the single 'bad' bit on that row
        const t1 = f.app.playlist.find((t) => t.title === row1.querySelector('b').textContent);
        assert.ok(t1);
        f.app.failedTracks.set(t1, 'decode error');
        f.w.document.dispatchEvent(new f.w.CustomEvent('music-track-health'));
        assert.equal(toggleCalls, 1, 'bad track toggles only the single changed bit');
        assert.equal(ariaCalls, 0, 'unchanged selection skips aria-selected write');
        assert.equal(row1.classList.contains('bad'), true);
        assert.equal(row1.dataset.tipBad, '1');

        // While hidden in classic mode, health / setPlaying / like events skip background DOM writes
        f.view.showClassic();
        assert.equal(f.app.isArchiveActive, false);
        toggleCalls = 0;
        f.app.failedTracks.delete(t1);
        f.w.document.dispatchEvent(new f.w.CustomEvent('music-track-health'));
        f.view.list.setPlaying(1);
        liked.add(t1.path);
        f.w.document.dispatchEvent(new f.w.CustomEvent('music-like-change'));
        assert.equal(toggleCalls, 0, 'hidden archive-list skips paintRow during classic mode');
        assert.equal(row1.querySelector('.lk').hidden, true, 'like update deferred while archive-list is hidden');

        // Returning to archive view catches up pending like/health/playing state cleanly
        f.view.show();
        f.view.list.setPlaying(1);
        f.view.list.render();
        await new Promise((r) => f.w.requestAnimationFrame(r));
        assert.equal(row1.classList.contains('bad'), false, 'cleared bad state synced when archive returns');
        assert.equal(row1.querySelector('.lk').hidden, false, 'deferred like state flushed on render');
    } finally {
        f.close();
    }
});

test('Batch 95: archive-view rebuild pre-captures list viewport before HUD writes and renderRuler reuses 32 tick nodes', async () => {
    const f = fixture({
        n: 80,
        playlists: [
            { id: 'p1', name: 'A大歌单', tracks: Array.from({ length: 35 }, (_, i) => `/m/${i}`) },
            { id: 'p2', name: 'B大歌单', tracks: Array.from({ length: 42 }, (_, i) => `/m/${i + 10}`) }
        ]
    });
    try {
        f.view.setListOpen(true);
        // 等同帧 scrollTop 快照过期，再验证 rebuild 会在写入 HUD 前主动预读 viewport scrollTop
        await Promise.resolve();
        const vp = listEl(f, 'viewport');
        const filesEl = f.w.document.querySelector('[data-ref="files"]');
        const ops = [];
        let st = 40;
        Object.defineProperty(vp, 'scrollTop', {
            configurable: true,
            get() { ops.push('read:scrollTop'); return st; },
            set(v) { st = v; }
        });
        const textDesc = Object.getOwnPropertyDescriptor(f.w.Node.prototype, 'textContent');
        let filesWrites = 0;
        Object.defineProperty(filesEl, 'textContent', {
            configurable: true,
            get() { return textDesc.get.call(this); },
            set(v) { ops.push('write:files'); filesWrites += 1; return textDesc.set.call(this, v); }
        });

        // Rebuilding without a scroll event reuses persistent scrollTop cache (zero forced scrollTop read)
        f.app.playlist.push({ path: '/m/80', title: 'Song 80', artist: 'Artist 80', album: 'Album 80', duration: 180 });
        f.view.refresh();
        assert.equal(ops.includes('read:scrollTop'), false, `persistent cache skips scrollTop read when clean: ${ops.join(',')}`);
        assert.ok(ops.includes('write:files'), 'HUD files count updates on track count change');

        // After a real scroll event dirties the cache, rebuild must pre-capture scrollTop BEFORE writing HUD files text
        ops.length = 0;
        vp.dispatchEvent(new f.w.Event('scroll'));
        f.app.playlist.push({ path: '/m/81', title: 'Song 81', artist: 'Artist 81', album: 'Album 81', duration: 180 });
        f.view.refresh();
        const firstRead = ops.indexOf('read:scrollTop');
        const firstWrite = ops.indexOf('write:files');
        assert.ok(firstRead !== -1 && firstWrite !== -1 && firstRead < firstWrite, `expected viewport read before HUD write, got ${ops.join(',')}`);

        // Refreshing again with unchanged track count skips redundant refs.files.textContent write
        filesWrites = 0;
        f.view.refresh();
        assert.equal(filesWrites, 0, 'unchanged track count skips redundant refs.files.textContent write');

        // Switching between two lanes with >= 32 tracks reuses the 32 <s> ruler tick DOM nodes and updates aria-valuemax
        const rulerTrack = f.w.document.querySelector('[data-ref="rulerTrack"]');
        const cols = f.view.debug().columns;
        const lane1 = cols.findIndex((c) => c.id === 'playlist:p1');
        const lane2 = cols.findIndex((c) => c.id === 'playlist:p2');
        assert.ok(lane1 >= 0 && lane2 >= 0);
        while (f.view.debug().lane !== lane1) f.key('ArrowRight');
        const initialTicks = [...rulerTrack.querySelectorAll('.archive-ruler-tick')];
        assert.equal(initialTicks.length, 32, '35-track lane renders 32 ruler ticks');
        assert.equal(rulerTrack.getAttribute('aria-valuemax'), '35');

        while (f.view.debug().lane !== lane2) f.key('ArrowRight');
        const nextTicks = [...rulerTrack.querySelectorAll('.archive-ruler-tick')];
        assert.equal(nextTicks.length, 32, '42-track lane keeps 32 ruler ticks');
        assert.equal(nextTicks[0], initialTicks[0], 'first ruler tick node reused in-place');
        assert.equal(nextTicks[31], initialTicks[31], 'last ruler tick node reused in-place');
        assert.equal(rulerTrack.getAttribute('aria-valuemax'), '42', 'aria-valuemax updated on lane change');
    } finally {
        f.close();
    }
});

test('Batch 100: archive-index artist-first short-circuit preserves exact ranking and caches identical-term queries safely', () => {
    const idxMod = require('../Musicmodules/music-archive/archive-index.js');
    // Build >64 tracks so useFieldCache is enabled and artistMap short-circuit runs
    const tracks = [
        { path: '/t0.flac', title: 'Alpha Dawn', artist: 'Alpha Band', album: 'Other' },       // title prefix (300) beats artist prefix (200)
        { path: '/t1.flac', title: 'Night Alpha', artist: 'Alpha Band', album: 'Other' },      // artist prefix (200) beats title substring (180)
        { path: '/t2.flac', title: 'Night Alpha', artist: 'Other Band', album: 'Other' },      // title substring (180)
        { path: '/t3.flac', title: 'Quiet Song', artist: 'Other Band', album: 'Alpha Vol' }    // album prefix (100)
    ];
    for (let i = 4; i < 80; i += 1) {
        tracks.push({ path: `/t${i}.flac`, title: `Filler ${i}`, artist: i % 2 === 0 ? 'Alpha Band' : 'Beta Band', album: `Album ${i % 10}` });
    }
    const index = idxMod.createIndex(tracks);
    const top4 = index.query('alpha', { limit: 4 });
    assert.equal(top4[0], 0, 'title prefix (300) still beats artist prefix (200) under artist-first short-circuit');
    assert.equal(top4[1], 1, 'artist prefix (200) beats title substring (180)');
    // Exact-same-terms hit (trailing space) returns isolated copy; mutating it must not corrupt cache
    const copy1 = index.query('alpha ', { limit: 4 });
    assert.deepEqual(copy1, top4);
    copy1.pop();
    const copy2 = index.query('alpha', { limit: 4 });
    assert.deepEqual(copy2, top4, 'exact-same-terms cache returns an isolated array copy');
    // Requesting a larger limit than previously cached expands cleanly beyond 4
    const allHits = index.query('alpha', { limit: 100 });
    assert.ok(allHits.length > 40, `larger limit returns full hit set (${allHits.length})`);
    assert.ok(allHits.includes(2) && allHits.includes(3), 'title substring and album prefix hits included in order');
    assert.ok(allHits.indexOf(1) < allHits.indexOf(2) && allHits.indexOf(2) < allHits.indexOf(3));
});

test('Batch 111: archive-view and dock palette prefer pinyinPro.polyphonic over pinyin() to bypass Trie build, with pinyin() fallback', () => {
    let polyCalls = 0;
    let pinyinCalls = 0;
    const f = fixture({
        tracks: [
            { path: '/p0.flac', title: '星光', artist: '歌手', album: '专辑' },
            { path: '/p1.flac', title: '夜曲', artist: '周杰伦', album: '十一月' }
        ],
        setup: (w) => {
            w.pinyinPro = {
                polyphonic: (ch) => {
                    polyCalls += 1;
                    const map = { '星': 'xing', '光': 'guang', '夜': 'ye', '曲': 'qu', '周': 'zhou', '杰': 'jie', '伦': 'lun' };
                    return [[map[ch] || '']];
                },
                pinyin: () => {
                    pinyinCalls += 1;
                    throw new Error('should not call pinyin() when polyphonic() is available');
                }
            };
        }
    });
    try {
        const idx = f.view.getSearchIndex();
        assert.ok(polyCalls > 0, 'archive-view uses pinyinPro.polyphonic');
        assert.equal(pinyinCalls, 0, 'archive-view never invokes pinyin() when polyphonic() exists');
        assert.deepEqual([...idx.query('xg')], [0], 'polyphonic initials match title');
        assert.deepEqual([...idx.query('zjl')], [1], 'polyphonic initials match artist');
    } finally {
        f.close();
    }
});

test('Batch 125: archive-list skips hidden reveal viewport reads and skips placeKindMark when in classic view', () => {
    let roCb = null;
    const rafs = [];
    const f = fixture({
        tracks: [],
        setup: (w) => {
            w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
            w.cancelAnimationFrame = () => {};
            w.ResizeObserver = class {
                constructor(cb) { this._cb = cb; }
                observe(el) { if (el?.dataset?.l === 'kinds') roCb = this._cb; }
                disconnect() {}
            };
            w.MusicFluid = { slide() { w.__slides = (w.__slides || 0) + 1; } };
        }
    });
    try {
        const vp = f.w.document.querySelector('.archive-list-viewport');
        let vpReads = 0;
        Object.defineProperty(vp, 'clientHeight', { configurable: true, get() { vpReads += 1; return 400; } });
        Object.defineProperty(vp, 'scrollTop', { configurable: true, get() { vpReads += 1; return 0; }, set() {} });
        f.view.list.reveal(0, null);
        assert.equal(vpReads, 0, 'empty archive-list reveal skips clientHeight and scrollTop layout reads');

        // Classic view hides archive: kindResizeObserver must not slide or trigger layout reads
        f.view.showClassic();
        rafs.length = 0;
        const slidesBefore = f.w.__slides || 0;
        if (roCb) roCb([{ contentRect: { width: 0, height: 0 } }]);
        if (roCb) roCb([{ contentRect: { width: 320, height: 24 } }]);
        while (rafs.length) rafs.shift()(16);
        assert.equal(f.w.__slides || 0, slidesBefore, 'kindResizeObserver skips placeKindMark while in classic view');
    } finally {
        f.close();
    }
});

test('Batch 126 / 127: flat views pre-size before show, scope layout-holding/revealing off root, mirror .has-focus without :has(), and isolate archive-list containment', () => {
    const listCss = read('Musicmodules/music-archive/archive-list.css');
    assert.match(listCss, /\.archive-list-viewport\s*\{[^}]*contain:\s*layout paint style;/, 'archive-list viewport applies layout paint style containment');
    assert.match(listCss, /\.archive-list-row\s*\{[^}]*contain:\s*layout style;/, 'archive-list rows apply layout style containment');

    const wallCss = read('Musicmodules/music-archive/archive-wall.css');
    assert.equal(wallCss.includes(':has(.is-focus)'), false, 'archive-wall.css drops :has(.is-focus) selector');
    assert.match(wallCss, /:not\(\.has-focus\)/, 'archive-wall.css uses mirrored .has-focus class');
    assert.match(wallCss, /\.archive-wall\.layout-holding\b/, 'layout-holding scoped to .archive-wall');
    assert.match(wallCss, /\.archive-grid\.layout-holding\b/, 'layout-holding scoped to .archive-grid');
    assert.match(wallCss, /\.archive-wall\.aw-table\.layout-revealing::after/, 'layout-revealing scoped to .archive-wall.aw-table');
    assert.equal(wallCss.includes('#music-archive-view.layout-holding'), false, 'root no longer carries layout-holding');
    assert.equal(wallCss.includes('#music-archive-view.layout-revealing'), false, 'root no longer carries layout-revealing');
    assert.match(wallCss, /\.ag-head,\s*\.ag-cell\s*\{[^}]*contain:\s*layout style;/, 'archive-grid cells apply layout style containment');

    const wallOps = [];
    const anims = [];
    const rafs = [];
    const f = fixture({
        n: 24,
        setup: (w) => {
            Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1400 });
            Object.defineProperty(w, 'innerHeight', { configurable: true, value: 900 });
            w.Element.prototype.scrollTo = w.Element.prototype.scrollTo || function () {};
            w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
            w.cancelAnimationFrame = () => {};
            w.Element.prototype.animate = function () {
                const a = { onfinish: null, oncancel: null, cancel() {} };
                anims.push(a);
                return a;
            };
            w.eval(read('Musicmodules/music-archive/archive-wall.js'));
            w.eval(read('Musicmodules/music-archive/archive-grid.js'));
            const origCreate = w.MusicArchiveWall.create;
            w.MusicArchiveWall = {
                ...w.MusicArchiveWall,
                create: (opts) => {
                    const inst = origCreate(opts);
                    if (!opts.tilt) {
                        const origSetRoom = inst.setRoom;
                        const origShow = inst.show;
                        inst.setRoom = (r) => { wallOps.push(['setRoom', Math.round(r.width)]); return origSetRoom(r); };
                        inst.show = (on) => { wallOps.push(['show', Boolean(on)]); return origShow(on); };
                    }
                    return inst;
                }
            };
        }
    });
    try {
        const root = f.w.document.getElementById('music-archive-view');
        const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
        root.getBoundingClientRect = () => rect(0, 0, 1400, 900);
        const hud = root.querySelector('.archive-hud');
        hud.getBoundingClientRect = () => rect(0, 0, 1400, 900);
        root.querySelector('.archive-nav').getBoundingClientRect = () => rect(0, 0, 1400, 56);
        root.querySelector('.archive-footer').getBoundingClientRect = () => rect(0, 840, 1400, 48);

        // Switch to wall via sweep: setRoom must precede show(true), and layout-holding must stay on .archive-wall
        wallOps.length = 0;
        f.view.setLayout('wall');
        assert.ok(anims.length >= 1, 'sweep creates cover animation');
        anims.pop().onfinish();
        const setRoomIdx = wallOps.findIndex(([op, w]) => op === 'setRoom' && w > 0);
        const showOnIdx = wallOps.findIndex(([op, on]) => op === 'show' && on === true);
        assert.ok(setRoomIdx >= 0 && showOnIdx > setRoomIdx, `setRoom runs before show(true): ${JSON.stringify(wallOps)}`);
        const wallEl = root.querySelector('.archive-wall:not(.aw-table)');
        const tableEl = root.querySelector('.archive-wall.aw-table');
        const gridEl = root.querySelector('.archive-grid');
        assert.equal(root.classList.contains('layout-holding'), false, 'root does not receive layout-holding');
        assert.equal(wallEl.classList.contains('layout-holding'), true, 'target wall receives layout-holding during swap');
        while (rafs.length) rafs.shift()(16);
        assert.equal(wallEl.classList.contains('layout-holding'), false, 'wall clears layout-holding on reveal');
        assert.equal(wallEl.classList.contains('has-focus'), true, 'wall mirrors .has-focus when selected tile is rendered');
        if (anims.length) anims.pop().onfinish();

        // Switch to grid: wall clears .has-focus and grid mirrors .has-focus on .ag-scroll
        f.view.setLayout('grid');
        anims.pop().onfinish();
        assert.equal(wallEl.classList.contains('has-focus'), false, 'hidden wall clears .has-focus');
        assert.equal(gridEl.classList.contains('layout-holding'), true, 'target grid receives layout-holding');
        assert.equal(root.classList.contains('layout-holding'), false);
        while (rafs.length) rafs.shift()(16);
        const scroller = gridEl.querySelector('.ag-scroll');
        assert.equal(scroller.classList.contains('has-focus'), true, 'grid scroller mirrors .has-focus when selected cell is visible');
        if (anims.length) anims.pop().onfinish();

        // Switch to table: layout-revealing lands on table.el only, never on #music-archive-view
        f.view.setLayout('table');
        anims.pop().onfinish();
        assert.equal(scroller.classList.contains('has-focus'), false, 'hidden grid clears .has-focus');
        while (rafs.length) rafs.shift()(16);
        assert.equal(root.classList.contains('layout-revealing'), false, 'root does not receive layout-revealing');
        assert.equal(tableEl.classList.contains('layout-revealing'), true, 'table receives layout-revealing during reveal sweep');
        if (anims.length) anims.pop().onfinish();
        assert.equal(tableEl.classList.contains('layout-revealing'), false, 'table clears layout-revealing after sweep');
    } finally {
        f.close();
    }
});

test('Batch 128: archive-list skips empty captureViewport, reuses track rows in-place on scroll, and archive-view resize prefers innerWidth/innerHeight', () => {
    // 1. Empty initial boot + resize() must not force root.clientWidth/clientHeight or viewport.clientHeight
    let rootClientReads = 0;
    const f0 = fixture({
        tracks: [],
        setup: (w) => {
            Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
            Object.defineProperty(w, 'innerHeight', { configurable: true, value: 900 });
            const root = w.document.getElementById('music-archive-view');
            Object.defineProperty(root, 'clientWidth', { configurable: true, get() { rootClientReads += 1; return 1440; } });
            Object.defineProperty(root, 'clientHeight', { configurable: true, get() { rootClientReads += 1; return 900; } });
        }
    });
    try {
        const vp0 = f0.w.document.querySelector('.archive-list-viewport');
        let vpReads = 0;
        Object.defineProperty(vp0, 'clientHeight', { configurable: true, get() { vpReads += 1; return 500; } });
        f0.view.list.captureViewport();
        assert.equal(vpReads, 0, 'captureViewport skips clientHeight when archive-list has no rows');
        assert.equal(rootClientReads, 0, 'archive-view resize prefers global.innerWidth/innerHeight over root.clientWidth/clientHeight');
    } finally {
        f0.close();
    }

    // 2. Virtual scrolling reuses off-screen .archive-list-row nodes in-place without remove() or appendChild()
    const rafs = [];
    const f = fixture({
        n: 200,
        playlists: [],
        setup: (w) => {
            Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
            Object.defineProperty(w, 'innerHeight', { configurable: true, value: 900 });
            w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
            w.cancelAnimationFrame = () => {};
        }
    });
    try {
        f.view.setListOpen(true);
        const vp = f.w.document.querySelector('.archive-list-viewport');
        const spacer = vp.querySelector('.archive-list-spacer');
        Object.defineProperty(vp, 'clientHeight', { configurable: true, value: 400 });
        // Prime top overscan at scrollTop = 480, then scroll further to 960 -> steady-state reuse has 0 removes & 0 appends
        vp.scrollTop = 480;
        vp.dispatchEvent(new f.w.Event('scroll'));
        while (rafs.length) rafs.shift()(16);
        const initialRows = [...spacer.querySelectorAll('.archive-list-row')];
        assert.ok(initialRows.length >= 16, `initial virtual scroll renders track rows (${initialRows.length})`);

        let trackRemoves = 0;
        let trackAppends = 0;
        for (const row of initialRows) {
            const origRemove = row.remove.bind(row);
            row.remove = () => { trackRemoves += 1; return origRemove(); };
        }
        const origAppend = spacer.appendChild.bind(spacer);
        spacer.appendChild = (node) => {
            if (node.nodeType === 11) {
                for (const c of node.children) if (c.classList?.contains('archive-list-row')) trackAppends += 1;
            } else if (node.classList?.contains('archive-list-row')) {
                trackAppends += 1;
            }
            return origAppend(node);
        };

        // Scroll down by another 480px so top track rows leave and bottom track rows enter
        vp.scrollTop = 960;
        vp.dispatchEvent(new f.w.Event('scroll'));
        while (rafs.length) rafs.shift()(16);
        assert.equal(trackRemoves, 0, 'scrolling reuses off-screen track rows in-place without node.remove()');
        assert.equal(trackAppends, 0, 'steady-state scrolling reuses all track rows without DOM re-insertion');
        const afterKs = new Set([...spacer.querySelectorAll('.archive-list-row')].map((n) => Number(n.dataset.k)));
        assert.ok([...afterKs].some((k) => k >= 20), 'reused track rows now display newly scrolled rows');
    } finally {
        f.close();
    }
});

test('Batch 129: archive-view hides classic container before readTheme, avoids getComputedStyle in resize, defers boot syncSceneLayout, and music.js prefetches boot IPCs', async () => {
    // 1. Verify setMode('archive') adds music-archive-on BEFORE readTheme while root.hidden is still true, and resize() does not call getComputedStyle(document.body)
    const themeSnapshots = [];
    let bodyCsCalls = 0;
    let detailRoomCalls = 0;
    const rafs = [];
    const f = fixture({
        n: 12,
        setup: (w) => {
            Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
            Object.defineProperty(w, 'innerHeight', { configurable: true, value: 900 });
            w.document.body.style.setProperty('--music-dock-safe-bottom', '96px');
            w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
            w.cancelAnimationFrame = () => {};
            const origCs = w.getComputedStyle.bind(w);
            w.getComputedStyle = (el, ...rest) => {
                if (el === w.document.body) {
                    bodyCsCalls += 1;
                    themeSnapshots.push({
                        archiveOn: w.document.body.classList.contains('music-archive-on'),
                        rootHidden: w.document.getElementById('music-archive-view').hidden
                    });
                }
                return origCs(el, ...rest);
            };
        }
    });
    try {
        // Initial init runs readTheme once during setMode (music-archive-on=true, root.hidden=true); resize() adds 0 body getComputedStyle calls
        assert.equal(bodyCsCalls, 1, 'archive init calls getComputedStyle(body) once for readTheme; resize() uses inline --music-dock-safe-bottom');
        assert.deepEqual(themeSnapshots[0], { archiveOn: true, rootHidden: true }, 'setMode hides classic container before readTheme while root stays hidden');
        // Calling resize explicitly must not invoke getComputedStyle(document.body)
        f.w.dispatchEvent(new f.w.Event('resize'));
        assert.equal(bodyCsCalls, 1, 'resize() reads inline --music-dock-safe-bottom without getComputedStyle(body)');
        // Verify lift was computed from inline --music-dock-safe-bottom = 96px
        const hud = f.w.document.querySelector('.archive-hud');
        assert.ok(parseInt(hud.style.getPropertyValue('--archive-dock-lift'), 10) > 0, 'inline --music-dock-safe-bottom sets --archive-dock-lift');

        // Verify music.js fires read-only boot IPCs before setupUtils(app)
        const musicSrc = read('Musicmodules/music.js');
        const ipcPos = musicSrc.indexOf('getMusicPlaylist()');
        const setupPos = musicSrc.indexOf('setupUtils(app)');
        assert.ok(ipcPos > 0 && setupPos > ipcPos, 'music.js initiates boot read-only IPCs before synchronous setupUtils/MusicArchive.init');

        // Verify music-sidebar loadCustomPlaylists accepts a prefetched promise
        const sidebarApp = { api: { getCustomPlaylists: async () => { throw new Error('should not call IPC when prefetched'); } } };
        f.w.eval(read('Musicmodules/music-sidebar.js'));
        f.w.setupSidebar(sidebarApp);
        await sidebarApp.loadCustomPlaylists(Promise.resolve([{ id: 'p1', name: 'P1', tracks: [] }]));
        assert.equal(sidebarApp.customPlaylists.length, 1, 'loadCustomPlaylists consumes prefetched promise');
        assert.equal(detailRoomCalls, 0);
    } finally {
        f.close();
    }
});

test('Batch 130: archive-grid reuses cells in-place on scroll without DOM detachment and archive-wall applies size containment', () => {
    const wallCss = read('Musicmodules/music-archive/archive-wall.css');
    assert.match(wallCss, /\.aw-tile\s*\{[^}]*contain:\s*size layout style;/, '.aw-tile applies size layout style containment');

    const rafs = [];
    const f = fixture({
        n: 240,
        playlists: [],
        setup: (w) => {
            Object.defineProperty(w, 'innerWidth', { configurable: true, value: 1440 });
            Object.defineProperty(w, 'innerHeight', { configurable: true, value: 900 });
            w.Element.prototype.scrollTo = w.Element.prototype.scrollTo || function () {};
            w.requestAnimationFrame = (cb) => { rafs.push(cb); return rafs.length; };
            w.cancelAnimationFrame = () => {};
            w.eval(read('Musicmodules/music-archive/archive-wall.js'));
            w.eval(read('Musicmodules/music-archive/archive-grid.js'));
        }
    });
    try {
        const root = f.w.document.getElementById('music-archive-view');
        const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
        root.getBoundingClientRect = () => rect(0, 0, 1440, 900);
        root.querySelector('.archive-hud').getBoundingClientRect = () => rect(0, 0, 1440, 900);
        root.querySelector('.archive-nav').getBoundingClientRect = () => rect(0, 0, 1440, 56);
        root.querySelector('.archive-footer').getBoundingClientRect = () => rect(0, 840, 1440, 48);

        f.view.setLayout('grid', { persist: false });
        while (rafs.length) rafs.shift()(16);
        const scroller = root.querySelector('.ag-scroll');
        const content = scroller.querySelector('.ag-content');
        // Prime top overscan at scrollTop = 600 so top+bottom rows are filled
        scroller.scrollTop = 600;
        scroller.dispatchEvent(new f.w.Event('scroll'));
        while (rafs.length) rafs.shift()(16);
        const cells = [...content.querySelectorAll('.ag-cell')];
        assert.ok(cells.length >= 12, `grid renders cells (${cells.length})`);

        let cellRemoves = 0;
        for (const c of cells) {
            const origRemove = c.remove.bind(c);
            c.remove = () => { cellRemoves += 1; return origRemove(); };
        }
        // Scroll further down by 600px: off-screen cells must be reused in-place with zero remove()
        scroller.scrollTop = 1200;
        scroller.dispatchEvent(new f.w.Event('scroll'));
        while (rafs.length) rafs.shift()(16);
        assert.equal(cellRemoves, 0, 'grid scrolling reuses off-screen .ag-cell nodes in-place without remove()');
        assert.ok([...content.querySelectorAll('.ag-cell')].some((c) => Number(c.dataset.id?.split(':')[1]) >= 20), 'reused cells display newly scrolled tracks');
    } finally {
        f.close();
    }
});
