/* 档案阵列数据层：歌单映射成列、循环取格、检索、键盘和滚轮步进。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../Musicmodules/music-archive/archive-model.js');

const tracks = [
    { path: 'D:\\M\\a.flac', title: 'Alpha.flac', artist: 'Aki', album: 'Low Tide' },
    { path: 'D:\\M\\b.mp3', title: '站台', artist: 'Ren', album: 'Low Tide' },
    { path: 'D:\\M\\c.flac', title: 'Gamma', artist: 'Lumi', album: '窗边' },
    { path: 'D:\\M\\d.flac', title: 'Delta', artist: 'Aki', album: '' }
];
const playlists = [
    { id: 'p1', name: '海边线路', tracks: ['d:/m/c.flac', 'D:\\M\\a.flac', 'D:\\M\\missing.flac'] },
    { id: 'p2', name: 'Night Walk', tracks: [] }
];

test('第一列是全部曲目，之后是歌单，再之后是两首以上的专辑', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.deepEqual(cols.map((c) => c.kind), ['all', 'playlist', 'playlist', 'album']);
    assert.deepEqual(cols[0].items, [0, 1, 2, 3]);
    assert.equal(cols[3].name, 'Low Tide');
    assert.deepEqual(cols[3].items, [0, 1]);
});

test('歌单按路径对上曲库下标，不分大小写和斜杠方向，找不到的跳过', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.deepEqual(cols[1].items, [2, 0]);
    assert.equal(cols[1].playlistId, 'p1');
    assert.equal(cols[2].ref, 'NIGHT WALK');
    assert.equal(cols[1].ref, 'PLAYLIST 01');
});

test('阵列两个方向都循环；空列返回 -1', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.equal(M.cellTrack(cols, 0, 5), 1);
    assert.equal(M.cellTrack(cols, 0, -1), 3);
    assert.equal(M.cellTrack(cols, -3, 1), 0);   // -3 → 第 1 列（海边线路）
    assert.equal(M.cellTrack(cols, 2, 0), -1);
    assert.equal(M.cellTrack([], 0, 0), -1);
});

test('locate 优先在指定列里找', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.deepEqual(M.locate(cols, 0, 1), { lane: 1, row: 1 });
    assert.deepEqual(M.locate(cols, 3, 1), { lane: 0, row: 3 });
    assert.equal(M.locate(cols, -1, 0), null);
    let scans = 0;
    const origIndexOf = cols[0].items.indexOf;
    cols[0].items.indexOf = function (...args) { scans += 1; return origIndexOf.apply(this, args); };
    assert.deepEqual(M.locate(cols, 2, 0), { lane: 0, row: 2 });
    assert.equal(scans, 0, 'all column uses O(1) direct index fast path');
});

test('检索标题（去掉扩展名）、歌手、专辑', () => {
    assert.deepEqual(M.search(tracks, 'flac'), []);
    assert.deepEqual(M.search(tracks, 'aki'), [0, 3]);
    assert.deepEqual(M.search(tracks, '窗'), [2]);
    assert.deepEqual(M.search(tracks, '  '), []);
    const col = M.searchColumn(tracks, ' 站台 ');
    assert.equal(col.kind, 'search');
    assert.deepEqual(col.items, [1]);
});

test('方向键和翻页键的步进', () => {
    const s = { lane: 2, row: 5 };
    assert.deepEqual(M.step(s, 'ArrowUp'), { lane: 2, row: 4 });
    assert.deepEqual(M.step(s, 'ArrowLeft'), { lane: 1, row: 5 });
    assert.deepEqual(M.step(s, 'PageDown'), { lane: 2, row: 15 });
    assert.equal(M.step(s, 'a'), null);
});

test('滚轮累计到阈值才走一格，停顿后清零，一次最多 6 格', () => {
    const w = M.createWheel(60);
    assert.equal(w(40, 0), 0);
    assert.equal(w(40, 10), 1);
    assert.equal(w(30, 1000), 0);    // 停顿超过 400ms，余量清掉
    assert.equal(w(-130, 1010), -1);
    assert.equal(w(5000, 1020), 6);
});

test('认得出鼠标滚轮的一格：系统缩放 125%/150% 下的小数像素也算一格，触控板的小增量不算', () => {
    const ev = (deltaY, deltaX = 0, deltaMode = 0) => ({ deltaY, deltaX, deltaMode });
    assert.equal(M.isWheelNotch(ev(100), 1), true);
    assert.equal(M.isWheelNotch(ev(-100 / 1.5), 1.5), true);     // 150% 缩放：66.67
    assert.equal(M.isWheelNotch(ev(100 / 1.25), 1.25), true);    // 125% 缩放：80
    assert.equal(M.isWheelNotch(ev(3, 0, 1), 1), true);          // 按行
    assert.equal(M.isWheelNotch(ev(12.5), 1.5), false);          // 触控板小增量
    assert.equal(M.isWheelNotch(ev(57.31), 1.5), false);         // 触控板快速一划，乘回缩放也不是整数
    assert.equal(M.isWheelNotch(ev(100, 4), 1), false);          // 斜着划（有横向分量）
});

test('几千首歌建列也很快', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: '/m/' + i, title: 't' + i, album: 'al' + (i % 300) }));
    const pls = Array.from({ length: 30 }, (_, k) => ({ id: k, name: 'p' + k, tracks: many.slice(k * 100, k * 100 + 200).map((t) => t.path) }));
    // 全量并行跑测试时机器负载高：跑 3 次取最快的一次，阈值也留出 3 倍余量
    let best = Infinity, cols = null;
    for (let k = 0; k < 3; k++) {
        const t0 = process.hrtime.bigint();
        cols = M.buildColumns(many, pls);
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.equal(cols.length, 1 + 30 + 24);
    assert.ok(best < 600, `buildColumns took ${best}ms`);
});

test('档案号至少三位', () => {
    assert.equal(M.fileCode(0), '001');
    assert.equal(M.fileCode(1233), '1234');
});

test('滚轮惯性：快速滚动松手后再滑一段，慢慢滚不滑', () => {
    const fast = M.createInertia();
    for (let k = 0; k < 6; k++) fast.push(1, k * 0.02);   // 0.1 秒走 6 格
    assert.equal(fast.release(0.12), true);
    let extra = 0;
    for (let t = 0.13; t < 2; t += 1 / 60) extra += fast.tick(t);
    assert.ok(extra >= 6 && extra <= 30, `滑了 ${extra} 格`);
    assert.equal(fast.active, false);
    const slow = M.createInertia();
    slow.push(1, 0); slow.push(1, 0.15);
    assert.equal(slow.release(0.3), false);
    assert.equal(slow.tick(0.31), 0);
    const back = M.createInertia();
    for (let k = 0; k < 6; k++) back.push(-1, k * 0.02);
    back.release(0.12);
    let neg = 0;
    for (let t = 0.13; t < 2; t += 1 / 60) neg += back.tick(t);
    assert.ok(neg < 0);
});

test('位置条：比例换算成列里的第几首', () => {
    assert.equal(M.rowAtFraction(0, 300), 0);
    assert.equal(M.rowAtFraction(1, 300), 299);
    assert.equal(M.rowAtFraction(0.5, 3), 1);
    assert.equal(M.rowAtFraction(-1, 10), 0);
    assert.equal(M.rowAtFraction(0.3, 0), 0);
});

test('画质档位：静止后三档都降到 12 帧，像素比最高 1.5', () => {
    const vm = require('node:vm');
    const ctx = { window: {} };
    vm.runInNewContext(require('node:fs').readFileSync('Musicmodules/music-archive/archive-scene.js', 'utf8'), ctx);
    const S = ctx.window.MusicArchiveScene;
    assert.equal(S.IDLE_AFTER, 2000);
    for (const tier of Object.values(S.TIERS)) {
        assert.equal(tier.idleFps, 12);
        assert.ok(tier.maxDpr <= 1.5);
    }
    const src = require('node:fs').readFileSync('Musicmodules/music-archive/archive-scene.js', 'utf8');
    assert.match(src, /if\s*\(disposed\)\s*return;/, 'archive-scene guards dispose and async compile completion');
    assert.match(src, /for\s*\(const c of \[captionCanvas, etchCanvas, stickerCanvas, fallbackCoverCanvas\]\)/, 'dispose zeroes all offscreen canvases');
    assert.match(src, /L\.canvas\.width\s*=\s*0;\s*L\.canvas\.height\s*=\s*0;/, 'dispose zeroes label canvases');
});

test('Batch 52: archive-grid resets sticky header on dataset switch and archive-wall clears drag state on hide', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.Element.prototype.scrollTo = function (opts) { if (opts && typeof opts.top === 'number') this.scrollTop = opts.top; };
    w.eval(fs.readFileSync('Musicmodules/music-archive/archive-wall.js', 'utf8'));
    w.eval(fs.readFileSync('Musicmodules/music-archive/archive-grid.js', 'utf8'));
    const host = w.document.getElementById('host');
    const tracks = Array.from({ length: 12 }, (_, i) => ({ path: `/m/${i}.flac`, title: `S${i}`, artist: i < 6 ? 'Alpha' : 'Beta', album: 'Alb' }));

    let dataset = 0;
    const datasets = [
        { key: 'd0', list: [{ id: 'a', name: 'Old Section A', ids: [0, 1, 2, 3, 4, 5] }, { id: 'b', name: 'Old Section B', ids: [6, 7, 8, 9, 10, 11] }] },
        { key: 'd1', list: [{ id: 'x', name: 'New Section X', ids: [0, 1, 2, 3, 4, 5] }, { id: 'y', name: 'New Section Y', ids: [6, 7, 8, 9, 10, 11] }] }
    ];
    let rafCb = null;
    w.requestAnimationFrame = (fn) => { rafCb = fn; return 1; };
    w.cancelAnimationFrame = () => { rafCb = null; };
    const grid = w.MusicArchiveGrid.create({
        host,
        sections: () => datasets[dataset],
        track: (i) => tracks[i],
        cover: () => '',
        selected: () => 0,
        playing: () => ({ index: -1, active: false }),
        meta: (t, i) => ({ title: t.title, artist: t.artist, album: t.album, code: String(i + 1).padStart(3, '0') }),
        pick() {}, play() {}, menu() {}
    });
    grid.setRoom({ left: 0, top: 0, width: 800, height: 400 });
    grid.show(true);
    const scroller = grid.el.querySelector('.ag-scroll');
    scroller.scrollTop = 120;
    if (rafCb) rafCb();
    const sticky = grid.el.querySelector('.ag-sticky');
    assert.equal(sticky.hidden, false);
    assert.equal(sticky.children[0].textContent, 'Old Section A');

    // Switch dataset while still scrolled into section 0: sticky header must update to New Section X
    dataset = 1;
    grid.sync();
    scroller.scrollTop = 120;
    if (rafCb) rafCb();
    assert.equal(sticky.children[0].textContent, 'New Section X', 'syncData resets stickySec so section 0 sticky header never stays stale');
    grid.destroy();

    // archive-wall clears active drag state on show(false)
    const wall = w.MusicArchiveWall.create({
        host,
        items: () => ({ key: 'w', name: 'All', ids: [0, 1, 2, 3] }),
        track: (i) => tracks[i],
        cover: () => '',
        selected: () => 0,
        playing: () => ({ index: -1, active: false }),
        meta: (t, i) => ({ title: t.title, artist: t.artist, album: t.album, code: String(i + 1) }),
        pick() {}, play() {}, menu() {}
    });
    wall.setRoom({ left: 0, top: 0, width: 800, height: 600 });
    wall.show(true);
    const pd = new w.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 });
    Object.defineProperty(pd, 'pointerId', { value: 1 });
    wall.el.dispatchEvent(pd);
    const pm = new w.MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 140 });
    Object.defineProperty(pm, 'pointerId', { value: 1 });
    wall.el.dispatchEvent(pm);
    assert.ok(wall.el.classList.contains('is-grabbing'));
    wall.show(false);
    assert.ok(!wall.el.classList.contains('is-grabbing'), 'hiding wall clears stuck is-grabbing drag state');
    wall.destroy();
    w.close();
});

test('Batch 55: archive-list setKind suppresses duplicate reveal render and search skips no-op scrollTop writes', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-index.js', 'utf8'));
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-list.js', 'utf8'));
        const host = w.document.getElementById('host');
        const tracks = Array.from({ length: 40 }, (_, i) => ({
            path: `/m/${i}.flac`,
            title: `Song ${i}${i % 4 === 0 ? ' Live' : ''}`,
            artist: `Artist ${i % 5}`,
            album: `Album ${i % 6}`,
            duration: 180
        }));
        const index = w.MusicArchiveIndex.createIndex(tracks);
        const app = { playlist: tracks, customPlaylists: [] };
        let list;
        list = w.MusicArchiveList.create({
            host, app, Index: w.MusicArchiveIndex,
            getIndex: () => index,
            getRecent: () => [],
            onKind: () => {
                // Simulate archive-view followListKind calling reveal synchronously inside onKind
                list.reveal(12, null);
            },
            onPick() {}, onPlay() {}
        });
        const vp = list.el.querySelector('[data-l="viewport"]');
        Object.defineProperty(vp, 'clientHeight', { value: 400, configurable: true });
        let scrollTopVal = 0;
        let scrollWrites = 0;
        Object.defineProperty(vp, 'scrollTop', {
            get: () => scrollTopVal,
            set: (v) => { scrollWrites += 1; scrollTopVal = Number(v) || 0; },
            configurable: true
        });
        list.rebuild();

        // Search while already at scrollTop = 0: must not issue redundant scrollTop = 0 writes
        scrollWrites = 0;
        list.typeInto('Live');
        await new Promise((r) => w.setTimeout(r, 50));
        assert.equal(scrollWrites, 0, 'search starting at scrollTop=0 performs zero no-op scrollTop writes');
        assert.equal(list.el.querySelectorAll('.archive-list-row').length > 0, true);

        // Clear search, then switch kind to album: onKind calls reveal(12) synchronously;
        // setKind should perform at most 1 scrollTop write instead of 3.
        list.typeInto('');
        await new Promise((r) => w.setTimeout(r, 50));
        scrollWrites = 0;
        list.setKind('album');
        assert.ok(scrollWrites <= 1, `expected <= 1 scrollTop write during setKind with nested reveal, got ${scrollWrites}`);
        assert.equal(list.el.dataset.kind, 'album');
        list.destroy();
    } finally {
        w.close();
    }
});
