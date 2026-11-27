// 经典列表的分列：只在列表显示时做，而且只做视口附近的行。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-classic-list.js'), 'utf8');
const ROW = 36;

function setup({ count = 500, archive = false, layout = true } = {}) {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const list = doc.getElementById('playlist');
    if (archive) doc.body.classList.add('music-archive-on');
    let frames = [];
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    const flush = async () => {
        await new Promise((resolve) => setImmediate(resolve)); // MutationObserver
        const batch = frames; frames = [];
        batch.forEach((fn) => fn(0));
    };
    if (layout) {
        // jsdom 不排版：给一个 360 高的视口，每行 36
        Object.defineProperty(list, 'clientHeight', { get: () => 360 });
        Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
            get() { return this.parentNode === list ? Array.prototype.indexOf.call(list.children, this) * ROW : 0; }
        });
    }
    const playlist = Array.from({ length: count }, (_, i) => ({ title: `歌 ${i}`, artist: `人 ${i}`, duration: 60 + i }));
    const app = {
        playlist,
        playlistEl: list,
        renderPlaylist(filtered) {
            list.replaceChildren(...(filtered || playlist).map((t) => {
                const li = doc.createElement('li');
                li.dataset.index = String(playlist.indexOf(t));
                li.textContent = t.title;
                return li;
            }));
        }
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(source);
    window.setupMusicClassicList(app);
    app.renderPlaylist();
    const done = () => list.querySelectorAll('li[data-cols="1"]').length;
    return { window, doc, list, app, flush, done, close: () => window.close() };
}

test('显示时只拆视口附近的行，滚动后补上新露出来的', async () => {
    const t = setup();
    assert.equal(t.done(), 40, '10 行可见 + 下方 30 行');
    assert.equal(t.list.children[0].querySelector('.cl-artist').textContent, '人 0');
    assert.equal(t.list.children[0].querySelector('.cl-duration').textContent, '1:00');
    assert.equal(t.list.children[100].dataset.cols, undefined);
    t.list.scrollTop = 200 * ROW;
    t.list.dispatchEvent(new t.window.Event('scroll'));
    await t.flush();
    assert.equal(t.list.children[205].dataset.cols, '1');
    assert.equal(t.list.children[170].dataset.cols, '1');
    assert.equal(t.list.children[400].dataset.cols, undefined);
    t.close();
});

test('在档案页时一行都不拆，切到经典视图才做', async () => {
    const t = setup({ archive: true });
    assert.equal(t.done(), 0);
    t.doc.body.classList.remove('music-archive-on');
    await t.flush();
    assert.equal(t.done(), 40);
    t.close();
});

test('切到专辑分页（列表被隐藏）时不拆，切回来补上', async () => {
    const t = setup();
    t.list.style.display = 'none';
    t.app.renderPlaylist();
    assert.equal(t.done(), 0);
    t.list.style.display = '';
    await t.flush();
    assert.equal(t.done(), 40);
    t.close();
});

test('量不到行高时整列处理', () => {
    const t = setup({ count: 50, layout: false });
    assert.equal(t.done(), 50);
    t.close();
});

test('排序后重建的行同样只拆视口附近', async () => {
    const t = setup();
    t.doc.querySelector('.music-list-sort.is-title').click();
    assert.equal(t.done(), 40);
    assert.ok(t.list.children[0].querySelector('.cl-title'));
    t.close();
});

test('档案页激活时推迟排序，切回经典视图后再应用当前排序', async () => {
    const t = setup({ count: 5 });
    ['Zebra', 'Alpha', 'Delta', 'Charlie', 'Bravo'].forEach((name, idx) => { t.app.playlist[idx].title = name; });
    t.doc.querySelector('.music-list-sort.is-title').click();
    assert.equal(t.list.children[0].dataset.index, '1', 'visible classic list sorts immediately');
    t.doc.body.classList.add('music-archive-on');
    t.app.renderPlaylist();
    assert.equal(t.list.children[0].dataset.index, '0', 'hidden classic list skips sort work while archive is active');
    t.doc.body.classList.remove('music-archive-on');
    await t.flush();
    assert.equal(t.list.children[0].dataset.index, '1', 'deferred sort runs once classic view becomes visible');
    t.close();
});

test('经典列表已显示时无关的 body class 变动不触发补拆 rAF', async () => {
    const t = setup();
    let rafCalls = 0;
    const origRaf = t.window.requestAnimationFrame;
    t.window.requestAnimationFrame = (fn) => { rafCalls += 1; return origRaf(fn); };
    t.doc.body.classList.add('music-playing');
    t.doc.body.classList.toggle('music-dock-open');
    await t.flush();
    assert.equal(rafCalls, 0, 'unrelated body classes should not trigger layout-measuring decorateSoon rAF');
    t.close();
});

test('music-like-change 仅更新受影响曲目行，且 beforeunload 清理监听', () => {
    const t = setup({ count: 60 });
    t.app.playlist.forEach((tr, i) => { tr.path = `/track-${i}.flac`; });
    const liked = new Set();
    let isLikedCalls = 0;
    t.app.isLiked = (tr) => { isLikedCalls += 1; return Boolean(tr && liked.has(tr.path)); };

    // 局部刷新：detail.tracks 只有第 0 首，不应扫描全部 40 个已装饰行
    liked.add('/track-0.flac');
    t.doc.dispatchEvent(new t.window.CustomEvent('music-like-change', { detail: { tracks: [t.app.playlist[0]], liked: true } }));
    assert.equal(isLikedCalls, 1, 'scoped music-like-change only checks the changed track row');
    assert.equal(t.list.children[0].classList.contains('is-liked'), true);
    assert.equal(t.list.children[1].classList.contains('is-liked'), false);

    // 未带 detail.tracks 时兜底刷新全部已装饰行
    isLikedCalls = 0;
    t.doc.dispatchEvent(new t.window.CustomEvent('music-like-change'));
    assert.equal(isLikedCalls, 40, 'unscoped music-like-change refreshes all decorated rows');

    // beforeunload 后不再响应 music-like-change
    t.window.dispatchEvent(new t.window.Event('beforeunload'));
    isLikedCalls = 0;
    t.doc.dispatchEvent(new t.window.CustomEvent('music-like-change', { detail: { tracks: [t.app.playlist[0]], liked: false } }));
    assert.equal(isLikedCalls, 0, 'beforeunload detaches music-like-change listener');
    t.close();
});

test('经典列表全行已拆列时滚动跳过 clientHeight 布局读取，且 skin 分段控件同步 disabled 不自触发重扫', async () => {
    const t = setup({ count: 20, layout: false });
    // 20 行在首屏已经全拆完，再滚动不应触发任何 clientHeight 同步布局读取
    let clientHeightReads = 0;
    Object.defineProperty(t.list, 'clientHeight', { get() { clientHeightReads += 1; return 400; }, configurable: true });
    t.list.scrollTop = 100;
    t.list.dispatchEvent(new t.window.Event('scroll'));
    await t.flush();
    assert.equal(clientHeightReads, 0, 'fully decorated classic list skips layout reads on scroll');
    t.close();

    // 验证 music-skin 分段控件：同步 option.disabled 且插入分段 DOM 不自触发二次 querySelectorAll
    const { JSDOM } = require('jsdom');
    const fs = require('node:fs');
    const path = require('node:path');
    const dom = new JSDOM(`<!doctype html><body>
        <div id="music-stage"></div>
        <div id="music-stage-settings-card"><div class="music-stage-settings-body">
            <label><span class="music-stage-tuning-label">档位</span>
                <select id="s1"><option value="a">甲</option><option value="b">乙</option></select>
            </label>
        </div></div></body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const body = w.document.querySelector('.music-stage-settings-body');
    let qsaCount = 0;
    const origQsa = body.querySelectorAll.bind(body);
    body.querySelectorAll = (sel) => { if (sel.includes('select')) qsaCount += 1; return origQsa(sel); };
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    w.setupMusicSkin({ playlist: [], currentTrackIndex: -1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(qsaCount, 1, 'inserting .music-skin-segmented does not re-trigger settings MutationObserver scan');
    const sel = w.document.getElementById('s1');
    const btns = w.document.querySelectorAll('.music-skin-segmented button');
    assert.equal(btns.length, 2);
    sel.options[1].disabled = true;
    sel.dispatchEvent(new w.Event('change'));
    assert.equal(btns[1].disabled, true, 'sync reflects dynamic option.disabled changes');
    w.close();
});

test('Batch 53: classic-list caches like button & skips redundant attrs; skin caches spec cells & rollers', () => {
    const t = setup({ count: 5, layout: false });
    t.app.playlist.forEach((tr, i) => { tr.path = `/t-${i}.flac`; });
    t.app.isLiked = () => false;
    const row0 = t.list.children[0];
    const btn0 = row0.querySelector('.cl-like');
    let qsCalls = 0;
    let attrWrites = 0;
    const origQs = row0.querySelector.bind(row0);
    row0.querySelector = (...args) => { qsCalls += 1; return origQs(...args); };
    const origSetAttr = btn0.setAttribute.bind(btn0);
    btn0.setAttribute = (...args) => { attrWrites += 1; return origSetAttr(...args); };

    // Re-firing music-like-change with unchanged state skips both querySelector and setAttribute
    t.doc.dispatchEvent(new t.window.CustomEvent('music-like-change', { detail: { tracks: [t.app.playlist[0]] } }));
    assert.equal(qsCalls, 0, 'paintLike uses cached li._likeBtn without querySelector');
    assert.equal(attrWrites, 0, 'unchanged like state skips redundant setAttribute writes');

    t.app.isLiked = (tr) => tr?.path === '/t-0.flac';
    t.doc.dispatchEvent(new t.window.CustomEvent('music-like-change', { detail: { tracks: [t.app.playlist[0]] } }));
    assert.equal(qsCalls, 0, 'state toggle still uses cached li._likeBtn');
    assert.ok(attrWrites > 0, 'changed like state updates aria attributes');
    assert.equal(row0.classList.contains('is-liked'), true);
    t.close();

    // Verify music-skin caches .track-specs > div cell lookups across track changes
    const dom = new JSDOM(`<!doctype html><body>
        <div class="track-title">Song A</div>
        <div class="track-file-number" data-track-field="file-number"></div>
        <dl class="track-specs"><div><dd id="fmt" data-track-field="format"></dd></div></dl>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    const fmtEl = w.document.getElementById('fmt');
    const titleEl = w.document.querySelector('.track-title');
    const app = {
        playlist: [
            { path: '/a.flac', title: 'Song A', codec: 'FLAC' },
            { path: '/b.mp3', title: 'Song B', codec: 'MP3' }
        ],
        currentTrackIndex: 0,
        trackTitle: titleEl
    };
    w.setupMusicSkin(app);
    let closestCalls = 0;
    const origClosest = fmtEl.closest.bind(fmtEl);
    fmtEl.closest = (...args) => { closestCalls += 1; return origClosest(...args); };
    app.currentTrackIndex = 1;
    titleEl.textContent = 'Song B';
    return new Promise((resolve) => setImmediate(() => {
        assert.equal(fmtEl.textContent, 'MP3');
        assert.equal(closestCalls, 0, 'setText reuses cached spec cell without repeated closest() calls');
        w.close();
        resolve();
    }));
});

test('Batch 57: classic-list caches sorted output for >32 tracks and music-skin syncs segmented buttons on programmatic select.value write', () => {
    const t = setup({ count: 50 });
    let stripCalls = 0;
    t.app.stripAudioExtension = (s) => { stripCalls += 1; return String(s || ''); };
    t.doc.querySelector('.music-list-sort.is-title').click();
    const callsAfterSort = stripCalls;
    assert.ok(callsAfterSort >= 50, 'initial title sort extracts keys once per track');
    // Re-rendering the unchanged 50-track list hits sortedCache instead of re-sorting
    t.app.renderPlaylist();
    t.app.renderPlaylist();
    assert.equal(stripCalls, callsAfterSort, 'repeated renderPlaylist reuses cached sorted list without re-sorting');
    // Clicking the sort header again flips direction and invalidates cache
    t.doc.querySelector('.music-list-sort.is-title').click();
    assert.ok(stripCalls > callsAfterSort, 'sort header toggle invalidates sortedCache and re-sorts');
    t.close();

    // Verify music-skin segmented control tracks programmatic select.value / selectedIndex updates
    const dom = new JSDOM(`<!doctype html><body>
        <div id="music-stage"></div>
        <div id="music-stage-settings-card"><div class="music-stage-settings-body">
            <label><span class="music-stage-tuning-label">画质</span>
                <select id="s2"><option value="low">节能</option><option value="std">标准</option><option value="max">极致</option></select>
            </label>
        </div></div></body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    w.setupMusicSkin({ playlist: [], currentTrackIndex: -1 });
    const sel = w.document.getElementById('s2');
    const btns = [...w.document.querySelectorAll('.music-skin-segmented button')];
    assert.equal(btns[0].getAttribute('aria-pressed'), 'true');
    sel.value = 'max';
    assert.equal(btns[2].getAttribute('aria-pressed'), 'true', 'programmatic select.value updates segmented button aria-pressed');
    assert.equal(btns[0].getAttribute('aria-pressed'), 'false');
    sel.selectedIndex = 1;
    assert.equal(btns[1].getAttribute('aria-pressed'), 'true', 'programmatic select.selectedIndex updates segmented button aria-pressed');
    w.close();
});

test('Batch 60: classic-list pre-ranked artist sort preserves Collator numeric ties, empty-last order, and caches reversed added sort', () => {
    const t = setup({ count: 0 });
    const tracks = [];
    // 构造 >32 首曲目且唯一歌手数 < 曲目数/2，触发 unique-key Collator pre-rank 路径
    const artists = ['Artist 10', 'Artist 2', 'Artist 01', 'Artist 1', '', 'Beta', 'Alpha'];
    for (let i = 0; i < 42; i += 1) {
        const artist = artists[i % artists.length];
        tracks.push({
            path: `/m/${i}.flac`,
            title: `Track ${String(i).padStart(2, '0')}.flac`,
            artist,
            duration: 180
        });
    }
    t.app.playlist.push(...tracks);
    t.app.renderPlaylist();

    // 按歌手升序：Alpha -> Artist 01/1 (平局保留原序) -> Artist 2 -> Artist 10 -> Beta -> 空歌手置后
    t.doc.querySelector('.music-list-sort.is-artist').click();
    const ascRows = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.equal(ascRows.length, 42);
    const nonEmptyAsc = ascRows.filter((tr) => tr.artist);
    const emptyAsc = ascRows.filter((tr) => !tr.artist);
    assert.equal(emptyAsc.length, 6);
    assert.ok(ascRows.slice(-6).every((tr) => tr.artist === ''), 'empty artists stay at bottom in asc order');
    assert.equal(nonEmptyAsc[0].artist, 'Alpha');
    // Artist 01 与 Artist 1 在 numeric Collator 下平局，应保留它们在原数组中的相对先后（先 01 后 1）
    const tieGroupAsc = nonEmptyAsc.filter((tr) => tr.artist === 'Artist 01' || tr.artist === 'Artist 1');
    for (let i = 1; i < tieGroupAsc.length; i += 1) {
        const prevIdx = tracks.indexOf(tieGroupAsc[i - 1]);
        const curIdx = tracks.indexOf(tieGroupAsc[i]);
        assert.ok(prevIdx < curIdx, 'Collator numeric tie preserves original track order in asc');
    }
    assert.ok(nonEmptyAsc.findIndex((tr) => tr.artist === 'Artist 2') < nonEmptyAsc.findIndex((tr) => tr.artist === 'Artist 10'), 'numeric ordering puts Artist 2 before Artist 10');

    // 按歌手降序：Beta -> Artist 10 -> Artist 2 -> Artist 01/1 -> Alpha -> 空歌手仍置后
    t.doc.querySelector('.music-list-sort.is-artist').click();
    const descRows = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.ok(descRows.slice(-6).every((tr) => tr.artist === ''), 'empty artists stay at bottom in desc order');
    assert.equal(descRows[0].artist, 'Beta');
    assert.ok(descRows.findIndex((tr) => tr.artist === 'Artist 10') < descRows.findIndex((tr) => tr.artist === 'Artist 2'), 'desc puts Artist 10 before Artist 2');

    // 按「添加时间」降序（dir = -1）：先切回 added 升序再点一次切到降序，第二次 renderPlaylist 应命中 sortedCache
    const addedBtn = t.doc.querySelector('.music-list-sort.is-added');
    addedBtn.click(); // dir = 1
    addedBtn.click(); // dir = -1
    const firstDescOrder = [...t.list.children].map((li) => Number(li.dataset.index));
    assert.equal(firstDescOrder[0], 41);
    assert.equal(firstDescOrder[41], 0);
    t.app.renderPlaylist();
    const secondDescOrder = [...t.list.children].map((li) => Number(li.dataset.index));
    assert.deepEqual(secondDescOrder, firstDescOrder, 'reversed added order remains consistent on cached render');
    t.close();
});
