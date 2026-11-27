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

test('Batch 69: archive-list placeKindMark reads layout before creating .archive-kind-mark and skips zero-width boxes', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        const slides = [];
        const pendingRafs = [];
        const flushRafs = () => { while (pendingRafs.length) pendingRafs.shift()(0); };
        w.MusicFluid = { slide: (el, pos) => slides.push({ el, pos }) };
        w.requestAnimationFrame = (fn) => { pendingRafs.push(fn); return pendingRafs.length; };
        w.cancelAnimationFrame = () => {};
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-index.js', 'utf8'));
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-list.js', 'utf8'));
        const host = w.document.getElementById('host');
        const tracks = [{ path: '/m/0.flac', title: 'Song 0', artist: 'A', album: 'B', duration: 120 }];
        const index = w.MusicArchiveIndex.createIndex(tracks);
        const list = w.MusicArchiveList.create({
            host, app: { playlist: tracks, customPlaylists: [] }, Index: w.MusicArchiveIndex,
            getIndex: () => index, getRecent: () => [], onPick() {}, onPlay() {}
        });
        const kindsBox = list.el.querySelector('[data-l="kinds"]');
        // Zero-width hidden box: must NOT create/append .archive-kind-mark
        w.Range.prototype.getBoundingClientRect = () => ({ left: 0, width: 0 });
        list.rebuild();
        flushRafs();
        assert.equal(kindsBox.querySelector('.archive-kind-mark'), null, 'zero-width kinds box does not append .archive-kind-mark');

        // Non-zero geometry: getBoundingClientRect must occur BEFORE appendChild creates .archive-kind-mark
        const order = [];
        const origAppend = kindsBox.appendChild.bind(kindsBox);
        kindsBox.appendChild = (child) => {
            if (child?.classList?.contains('archive-kind-mark')) order.push('append-mark');
            return origAppend(child);
        };
        kindsBox.getBoundingClientRect = () => { order.push('read-box'); return { left: 10, width: 200 }; };
        Object.defineProperty(kindsBox, 'offsetWidth', { get: () => 200, configurable: true });
        w.Range.prototype.getBoundingClientRect = function () { order.push('read-range'); return { left: 20, width: 40 }; };

        list.setKind('artist');
        flushRafs();
        assert.ok(kindsBox.querySelector('.archive-kind-mark'), '.archive-kind-mark created when geometry is valid');
        assert.deepEqual(order.slice(0, 3), ['read-range', 'read-box', 'append-mark'], 'reads geometry before mutating DOM');
        assert.equal(slides.length > 0, true);
        list.destroy();
    } finally {
        w.close();
    }
});

test('Batch 72: archive-list search skips duplicate onResults/rAF/scrollTop reads and archive-tuning drops body :has()', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        let rafCount = 0;
        w.requestAnimationFrame = (fn) => { rafCount += 1; return rafCount; };
        w.cancelAnimationFrame = () => {};
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-index.js', 'utf8'));
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-list.js', 'utf8'));
        const host = w.document.getElementById('host');
        const tracks = Array.from({ length: 40 }, (_, i) => ({
            path: `/m/${i}.flac`,
            title: i % 4 === 0 ? `Live Song ${i}.flac` : `Track ${i}.flac`,
            artist: `Artist ${i % 5}`,
            album: `Album ${i % 3}`,
            duration: 200
        }));
        const index = w.MusicArchiveIndex.createIndex(tracks);
        let onResultsCalls = 0;
        let onPickCalls = 0;
        const list = w.MusicArchiveList.create({
            host, app: { playlist: tracks, customPlaylists: [] }, Index: w.MusicArchiveIndex,
            getIndex: () => index, getRecent: () => [],
            onResults: () => { onResultsCalls += 1; },
            onPick: () => { onPickCalls += 1; },
            onPlay() {}
        });
        const vp = list.el.querySelector('[data-l="viewport"]');
        let scrollReads = 0;
        let scrollTopVal = 0;
        Object.defineProperty(vp, 'clientHeight', { get: () => 400, configurable: true });
        Object.defineProperty(vp, 'scrollTop', {
            get: () => { scrollReads += 1; return scrollTopVal; },
            set: (v) => { scrollTopVal = Number(v) || 0; },
            configurable: true
        });
        list.rebuild();

        // Typing a matching query at top skips scrollTop read, avoids duplicate onResults, and queues 0 redundant rAF in pickRow
        onResultsCalls = 0;
        onPickCalls = 0;
        scrollReads = 0;
        rafCount = 0;
        list.typeInto('Live');
        await new Promise((r) => w.setTimeout(r, 50));
        assert.equal(onPickCalls, 1, 'matching search calls onPick once for first hit');
        assert.equal(onResultsCalls, 0, 'matching search skips duplicate onResults when edgeRow/onPick handles selection');
        assert.equal(scrollReads, 0, 'search starting from lastRenderTop=0 skips forced scrollTop layout read');
        assert.equal(rafCount, 0, 'pickRow renders synchronously without queueing duplicate scrollToRow rAF');

        // Unmatched query still fires onResults with count 0
        list.typeInto('NoSuchSongXYZ');
        await new Promise((r) => w.setTimeout(r, 50));
        assert.equal(onResultsCalls, 1, 'empty search result still notifies onResults');

        // archive-tuning.css replaces body:has(#music-dock-root.md-fl-low) with body.music-fl-low
        const tuningCss = fs.readFileSync('Musicmodules/music-archive/archive-tuning.css', 'utf8');
        assert.equal(tuningCss.includes(':has(#music-dock-root.md-fl-low)'), false, 'no global body:has(#music-dock-root.md-fl-low) invalidation rule');
        assert.match(tuningCss, /body\.music-dock-beside-lyrics\.music-fl-low/);
        list.destroy();
    } finally {
        w.close();
    }
});

test('Batch 75: archive-list applyQuery reads scrollTop before toggling .al-sq and readViewportOnce reuses cached offsetTop', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        w.requestAnimationFrame = (fn) => { fn(0); return 1; };
        w.cancelAnimationFrame = () => {};
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-index.js', 'utf8'));
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-list.js', 'utf8'));
        const host = w.document.getElementById('host');
        const tracks = Array.from({ length: 60 }, (_, i) => ({
            path: `/m/${i}.flac`,
            title: i % 3 === 0 ? `Live ${i}.flac` : `Track ${i}.flac`,
            artist: `Artist ${i % 4}`,
            album: `Album ${i % 2}`,
            duration: 180
        }));
        const index = w.MusicArchiveIndex.createIndex(tracks);
        const list = w.MusicArchiveList.create({
            host, app: { playlist: tracks, customPlaylists: [] }, Index: w.MusicArchiveIndex,
            getIndex: () => index, getRecent: () => [],
            onResults() {}, onPick() {}, onPlay() {}
        });
        const vp = list.el.querySelector('[data-l="viewport"]');
        let scrollTopVal = 240;
        let offsetTopReads = 0;
        const events = [];
        Object.defineProperty(vp, 'clientHeight', { get: () => 400, configurable: true });
        Object.defineProperty(vp, 'offsetTop', { get: () => { offsetTopReads += 1; return 48; }, configurable: true });
        Object.defineProperty(vp, 'scrollTop', {
            get: () => { events.push('read-scroll'); return scrollTopVal; },
            set: (v) => { events.push('write-scroll'); scrollTopVal = Number(v) || 0; },
            configurable: true
        });
        list.rebuild();
        const readsAfterFirstRebuild = offsetTopReads;
        list.rebuild();
        assert.equal(offsetTopReads, readsAfterFirstRebuild, 'subsequent rebuild reuses cached viewport offsetTop');

        // Let microtask expire syncedTopFresh so applyQuery actually reads vp.scrollTop
        await Promise.resolve();
        // Spy on .al-sq classList.toggle to verify scrollTop is read BEFORE .al-sq mutates style
        const origToggle = list.el.classList.toggle.bind(list.el.classList);
        list.el.classList.toggle = (cls, force) => {
            if (cls === 'al-sq') events.push('toggle-al-sq');
            return origToggle(cls, force);
        };
        events.length = 0;
        list.input.value = 'Live';
        list.input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
        const firstRead = events.indexOf('read-scroll');
        const firstToggle = events.indexOf('toggle-al-sq');
        assert.ok(firstRead >= 0 && firstToggle > firstRead, `expected read-scroll before toggle-al-sq, got ${JSON.stringify(events)}`);
        list.destroy();
    } finally {
        w.close();
    }
});

test('Batch 77: archive-list applyQuery resets scrollTop before .al-sq and typeInto skips redundant focus with preventScroll', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        w.requestAnimationFrame = (fn) => { fn(0); return 1; };
        w.cancelAnimationFrame = () => {};
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-index.js', 'utf8'));
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-list.js', 'utf8'));
        const host = w.document.getElementById('host');
        const tracks = Array.from({ length: 60 }, (_, i) => ({
            path: `/m/${i}.flac`,
            title: i % 3 === 0 ? `Live ${i}.flac` : `Track ${i}.flac`,
            artist: `Artist ${i % 4}`,
            album: `Album ${i % 2}`,
            duration: 180
        }));
        const index = w.MusicArchiveIndex.createIndex(tracks);
        const list = w.MusicArchiveList.create({
            host, app: { playlist: tracks, customPlaylists: [] }, Index: w.MusicArchiveIndex,
            getIndex: () => index, getRecent: () => [],
            onResults() {}, onPick() {}, onPlay() {}
        });
        const vp = list.el.querySelector('[data-l="viewport"]');
        let scrollTopVal = 300;
        const events = [];
        Object.defineProperty(vp, 'clientHeight', { get: () => 400, configurable: true });
        Object.defineProperty(vp, 'scrollTop', {
            get: () => scrollTopVal,
            set: (v) => { events.push('write-scroll'); scrollTopVal = Number(v) || 0; },
            configurable: true
        });
        list.rebuild();
        scrollTopVal = 300;
        await Promise.resolve();

        const origToggle = list.el.classList.toggle.bind(list.el.classList);
        list.el.classList.toggle = (cls, force) => {
            if (cls === 'al-sq') events.push('toggle-al-sq');
            return origToggle(cls, force);
        };
        const focusCalls = [];
        const origFocus = list.input.focus.bind(list.input);
        list.input.focus = (opts) => { focusCalls.push(opts || null); return origFocus(opts); };

        // 1. typeInto focuses once with { preventScroll: true } and skips focus while already focused
        list.typeInto('l');
        list.typeInto('li');
        list.typeInto('liv');
        assert.equal(focusCalls.length, 1, 'consecutive typeInto calls only focus input once');
        assert.equal(focusCalls[0]?.preventScroll, true, 'typeInto focuses with preventScroll: true');

        // 2. applyQuery(true) writes scrollTop=0 BEFORE syncSq() toggles .al-sq
        await new Promise((r) => setTimeout(r, 45));
        list.input.blur();
        list.input.dispatchEvent(new w.FocusEvent('blur'));
        list.input.value = 'Live';
        list.input.dispatchEvent(new w.Event('input', { bubbles: true }));
        // Clear value before the 30ms debounce fires so applyQuery(true) itself must flip .al-sq
        list.input.value = '';
        scrollTopVal = 300;
        vp.dispatchEvent(new w.Event('scroll'));
        await Promise.resolve();
        events.length = 0;
        await new Promise((r) => setTimeout(r, 50));
        const writeIdx = events.indexOf('write-scroll');
        const toggleIdx = events.indexOf('toggle-al-sq');
        assert.ok(writeIdx >= 0 && toggleIdx > writeIdx, `expected write-scroll before toggle-al-sq, got ${JSON.stringify(events)}`);
        list.destroy();
    } finally {
        w.close();
    }
});

test('Batch 78: archive-grid recycles section headers across dataset switch/resize and deduplicates locate is-away toggles', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        let rafCb = null;
        w.requestAnimationFrame = (fn) => { rafCb = fn; return 1; };
        w.cancelAnimationFrame = () => { rafCb = null; };
        w.HTMLElement.prototype.scrollTo = function (o) { this.scrollTop = o?.top || 0; };
        const flush = () => { while (rafCb) { const fn = rafCb; rafCb = null; fn(16); } };
        w.eval(fs.readFileSync('Musicmodules/music-archive/archive-grid.js', 'utf8'));
        const host = w.document.getElementById('host');
        const tracks = Array.from({ length: 40 }, (_, i) => ({ path: `/m/${i}.flac`, title: `Song ${i}`, artist: 'A', album: 'B' }));
        let ds = 0;
        let sel = 0;
        let playing = { index: 39, active: true };
        const grid = w.MusicArchiveGrid.create({
            host,
            sections: () => ({
                key: String(ds),
                list: [
                    { id: 's1', name: ds === 0 ? 'A' : 'C', ids: tracks.slice(0, 20).map((_, i) => i) },
                    { id: 's2', name: ds === 0 ? 'B' : 'D', ids: tracks.slice(20).map((_, i) => i + 20) }
                ]
            }),
            track: (i) => tracks[i],
            cover: () => '',
            selected: () => sel,
            playing: () => playing,
            meta: (t, i) => ({ title: t.title, artist: t.artist, album: t.album, code: String(i + 1).padStart(3, '0') }),
            pick() {},
            play() {},
            menu() {},
            reducedMotion: () => true
        });
        grid.setRoom({ left: 0, top: 0, width: 800, height: 400 });
        grid.show(true);
        flush();

        const firstHead = grid.el.querySelector('.ag-head');
        assert.ok(firstHead, 'initial section header rendered');
        const firstCell = grid.el.querySelector('.ag-cell[data-id="0:0"]');
        assert.ok(firstCell.classList.contains('is-focus'));
        assert.equal(firstCell.getAttribute('aria-selected'), 'true');

        // Dataset switch recycles existing header node from headPool instead of dropping it
        ds = 1;
        grid.sync();
        flush();
        const afterSwitchHeads = [...grid.el.querySelectorAll('.ag-head')];
        assert.ok(afterSwitchHeads.includes(firstHead), 'syncData recycles header DOM node via headPool');

        // Width resize also recycles header node
        grid.setRoom({ left: 0, top: 0, width: 1000, height: 400 });
        flush();
        const afterResizeHeads = [...grid.el.querySelectorAll('.ag-head')];
        assert.ok(afterResizeHeads.includes(firstHead), 'setRoom width change recycles header DOM node via headPool');

        // Steady scrolling with playing track still offscreen does not repeatedly call locateBtn.classList.toggle('is-away')
        const locateBtn = grid.el.querySelector('.ag-locate');
        const scroller = grid.el.querySelector('.ag-scroll');
        let awayToggles = 0;
        const origToggle = locateBtn.classList.toggle.bind(locateBtn.classList);
        locateBtn.classList.toggle = (cls, force) => {
            if (cls === 'is-away') awayToggles += 1;
            return origToggle(cls, force);
        };
        scroller.scrollTop = 10;
        scroller.dispatchEvent(new w.Event('scroll'));
        flush();
        scroller.scrollTop = 20;
        scroller.dispatchEvent(new w.Event('scroll'));
        flush();
        assert.equal(awayToggles, 0, 'locateBtn skips redundant is-away classList toggles while state is unchanged');
        grid.destroy();
    } finally {
        w.close();
    }
});

test('Batch 79: archive-wall uses bitmask class sync and dedupes locateBtn, aw-has-open, and camera transform writes', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        const rafs = [];
        w.requestAnimationFrame = (fn) => { rafs.push(fn); return rafs.length; };
        w.cancelAnimationFrame = () => {};
        w.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-archive/archive-wall.js'), 'utf8'));
        const tracks = Array.from({ length: 16 }, (_, i) => ({ path: `/t${i}.flac`, title: `Track ${i}`, artist: `Art ${i}`, duration: 180 }));
        let sel = 0;
        let playing = { index: 0, active: true };
        const wall = w.MusicArchiveWall.create({
            host: w.document.getElementById('host'),
            items: () => ({ key: 'all', name: '全部', ids: tracks.map((_, i) => i) }),
            track: (i) => tracks[i],
            meta: (t, i) => ({ title: t.title, artist: t.artist, code: String(i + 1).padStart(2, '0'), duration: '3:00' }),
            cover: () => '',
            selected: () => sel,
            playing: () => playing,
            pick: (i) => { sel = i; },
            play() {},
            menu() {},
            reducedMotion: () => true
        });
        const flush = () => {
            let guard = 0;
            while (rafs.length && guard++ < 8) rafs.shift()(w.performance.now());
        };
        wall.setRoom({ left: 0, top: 0, width: 800, height: 600 });
        wall.show(true);
        flush();

        const tiles = [...wall.el.querySelectorAll('.aw-tile')];
        assert.ok(tiles.length > 0, 'wall rendered tiles');
        const focused = tiles.find((t) => t.classList.contains('is-focus'));
        assert.ok(focused, 'focused tile has is-focus');
        assert.equal(focused.getAttribute('aria-selected'), 'true');
        const unfocused = tiles.find((t) => !t.classList.contains('is-focus'));
        assert.ok(unfocused && unfocused.getAttribute('aria-selected') === 'false', 'unfocused tile carries aria-selected="false"');
        assert.ok(tiles.some((t) => t.classList.contains('is-playing')), 'active playing tile has is-playing');

        // Repeated refresh with unchanged camera and state skips world transform & aw-has-open writes
        const world = wall.el.querySelector('.aw-world');
        let tfWrites = 0;
        let openToggles = 0;
        const tfDesc = Object.getOwnPropertyDescriptor(w.CSSStyleDeclaration.prototype, 'transform');
        Object.defineProperty(world.style, 'transform', {
            configurable: true,
            get() { return tfDesc.get.call(this); },
            set(v) { tfWrites += 1; return tfDesc.set.call(this, v); }
        });
        const origWorldToggle = world.classList.toggle.bind(world.classList);
        world.classList.toggle = (cls, force) => {
            if (cls === 'aw-has-open') openToggles += 1;
            return origWorldToggle(cls, force);
        };
        wall.refresh();
        flush();
        wall.refresh();
        flush();
        assert.equal(tfWrites, 0, 'unchanged camera skips redundant world.style.transform writes');
        assert.equal(openToggles, 0, 'unchanged expanded state skips redundant aw-has-open toggles');

        // Switching playing to paused swaps is-playing -> is-current cleanly via bitmask diff
        playing = { index: 0, active: false };
        wall.sync();
        flush();
        assert.equal(wall.el.querySelectorAll('.aw-tile.is-playing').length, 0, 'paused clears is-playing');
        assert.ok(wall.el.querySelectorAll('.aw-tile.is-current').length > 0, 'paused sets is-current');
        wall.destroy();
    } finally {
        w.close();
    }
});

test('Batch 85: archive-grid restarts sticky roll and locate ping via cancellable rAF without offsetWidth reflow', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    try {
        let rafId = 1;
        const rafs = new Map();
        const cancelled = [];
        w.requestAnimationFrame = (cb) => { const id = rafId++; rafs.set(id, cb); return id; };
        w.cancelAnimationFrame = (id) => { cancelled.push(id); rafs.delete(id); };
        w.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-archive/archive-grid.js'), 'utf8'));
        const tracks = Array.from({ length: 48 }, (_, i) => ({ path: `/g${i}.flac`, title: `G ${i}`, artist: 'A', duration: 180 }));
        const sections = [
            { id: 's0', name: 'A', sub: '', ids: tracks.slice(0, 16).map((_, i) => i) },
            { id: 's1', name: 'B', sub: '', ids: tracks.slice(16, 32).map((_, i) => i + 16) },
            { id: 's2', name: 'C', sub: '', ids: tracks.slice(32, 48).map((_, i) => i + 32) }
        ];
        const grid = w.MusicArchiveGrid.create({
            host: w.document.getElementById('host'),
            sections: () => ({ key: 'abc', list: sections }),
            track: (i) => tracks[i],
            meta: (t, i) => ({ title: t.title, artist: t.artist, code: String(i + 1).padStart(2, '0') }),
            cover: () => '',
            selected: () => 0,
            playing: () => ({ index: 0, active: true }),
            pick() {},
            play() {},
            menu() {},
            reducedMotion: () => false
        });
        const flush = () => {
            const entries = [...rafs.entries()];
            rafs.clear();
            for (const [, cb] of entries) cb(w.performance.now());
        };
        const sticky = grid.el.querySelector('.ag-sticky');
        const locate = grid.el.querySelector('.ag-locate');
        const scroller = grid.el.querySelector('.ag-scroll');
        scroller.scrollTo = (arg) => {
            if (arg && typeof arg === 'object' && Number.isFinite(arg.top)) scroller.scrollTop = arg.top;
        };
        let reflowReads = 0;
        for (const el of [sticky, locate]) {
            Object.defineProperty(el, 'offsetWidth', { configurable: true, get() { reflowReads += 1; return 100; } });
        }
        grid.setRoom({ left: 0, top: 0, width: 800, height: 400 });
        grid.show(true);
        flush();

        // Scroll across section A -> B -> C to trigger consecutive ag-roll-up transitions
        scroller.scrollTop = 200;
        scroller.dispatchEvent(new w.Event('scroll'));
        flush();
        scroller.scrollTop = 1000;
        scroller.dispatchEvent(new w.Event('scroll'));
        flush();
        assert.equal(sticky.classList.contains('ag-roll-up'), true, 'first forward section transition applies ag-roll-up');

        scroller.scrollTop = 2000;
        scroller.dispatchEvent(new w.Event('scroll'));
        flush();
        assert.equal(reflowReads, 0, 'consecutive sticky section roll skips synchronous offsetWidth forced reflow');
        assert.equal(sticky.classList.contains('ag-roll-up'), false, 'same-direction roll removes class first and schedules rAF');
        flush();
        assert.equal(sticky.classList.contains('ag-roll-up'), true, 'cross-frame rAF re-adds ag-roll-up cleanly');

        // Clicking locate button uses cancellable rAF instead of offsetWidth reflow
        locate.click();
        assert.equal(reflowReads, 0, 'locate button ping skips synchronous offsetWidth forced reflow');
        assert.equal(rafs.size > 0, true, 'locate button queues ping rAF');
        const pendingIds = [...rafs.keys()];
        grid.show(false);
        assert.ok(pendingIds.some((id) => cancelled.includes(id)), 'hiding grid cancels pending ping/roll rAFs');
        grid.destroy();
    } finally {
        w.close();
    }
});
