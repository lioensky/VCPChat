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
    t.app.playlist.forEach((tr) => { tr.title += '.flac'; });
    let stripCalls = 0;
    t.app.stripAudioExtension = (s) => { stripCalls += 1; return String(s || ''); };
    t.doc.querySelector('.music-list-sort.is-title').click();
    const callsAfterSort = stripCalls;
    assert.ok(callsAfterSort >= 50, 'initial title sort extracts keys once per track');
    // Re-rendering the unchanged 50-track list hits sortedCache instead of re-sorting
    t.app.renderPlaylist();
    t.app.renderPlaylist();
    assert.equal(stripCalls, callsAfterSort, 'repeated renderPlaylist reuses cached sorted list without re-sorting');
    // Clicking the sort header again flips direction via O(N) rank-reversal without re-calling stripAudioExtension
    const firstAsc = t.list.children[0].dataset.index;
    t.doc.querySelector('.music-list-sort.is-title').click();
    assert.equal(stripCalls, callsAfterSort, 'sort header toggle reverses cached asc order without re-extracting title keys');
    assert.notEqual(t.list.children[0].dataset.index, firstAsc, 'toggled title sort visibly reverses displayed order');
    // Replacing playlist invalidates sortCache and re-extracts keys
    t.app.playlist = t.app.playlist.slice().concat({ path: '/extra.flac', title: 'Zzz Extra.flac', artist: 'Extra', duration: 200 });
    t.app.renderPlaylist();
    assert.ok(stripCalls > callsAfterSort, 'mutating playlist invalidates sortCache and re-sorts');
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

test('Batch 62: music-ui + classic-list pool and update decorated <li> nodes in-place across scroll jumps', async () => {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const list = doc.getElementById('playlist');
    const frames = [];
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    Object.defineProperty(list, 'clientHeight', { get: () => 360 });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
        get() { return this.parentNode === list ? Array.prototype.indexOf.call(list.children, this) * ROW : 0; }
    });
    const playlist = Array.from({ length: 300 }, (_, i) => ({
        path: `/m/${i}.flac`,
        title: `Song ${i}.flac`,
        artist: `Artist ${i}`,
        duration: 120 + i
    }));
    const liked = new Set(['/m/180.flac']);
    const app = {
        playlist,
        playlistEl: list,
        currentTrackIndex: 180,
        stripAudioExtension: (s) => String(s || '').replace(/\.flac$/i, ''),
        updateAllCount() {},
        isLiked: (tr) => Boolean(tr && liked.has(tr.path))
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-ui.js'), 'utf8'));
    window.eval(source);
    window.setupUI(app);
    window.setupMusicClassicList(app);
    app.renderPlaylist();

    const initialLis = new Set([...list.children]);
    const initialTitles = new Set([...list.children].map((li) => li.querySelector('.cl-title')));
    assert.ok(initialLis.size > 0, 'initial virtual window rendered');

    // Jump straight to track 180 (disjoint window) — existing <li> and child spans should be reused in-place
    let liCreates = 0;
    const origCreate = doc.createElement.bind(doc);
    doc.createElement = (tag, ...rest) => {
        if (String(tag).toLowerCase() === 'li') liCreates += 1;
        return origCreate(tag, ...rest);
    };
    list.scrollTop = 180 * ROW;
    list.dispatchEvent(new window.Event('scroll'));
    while (frames.length) frames.splice(0).forEach((fn) => fn(0));

    const jumpedLis = [...list.children];
    const reusedCount = jumpedLis.filter((li) => initialLis.has(li)).length;
    const reusedTitleSpans = jumpedLis.filter((li) => initialTitles.has(li.querySelector('.cl-title'))).length;
    assert.ok(reusedCount >= Math.min(initialLis.size, jumpedLis.length), `expected pooled <li> reuse, got ${reusedCount}/${jumpedLis.length}`);
    assert.equal(reusedTitleSpans, reusedCount, 'reused <li> elements update child .cl-title spans in-place without rebuilding children');
    assert.ok(liCreates <= Math.max(0, jumpedLis.length - initialLis.size), `pool reduces new <li> allocations (got ${liCreates})`);

    const row180 = jumpedLis.find((li) => li.dataset.index === '180');
    assert.ok(row180, 'target row 180 rendered in jumped window');
    assert.equal(row180.querySelector('.cl-title').textContent, 'Song 180');
    assert.equal(row180.querySelector('.cl-artist').textContent, 'Artist 180');
    assert.equal(row180.classList.contains('active'), true);
    assert.equal(row180.classList.contains('is-liked'), true);

    // Second disjoint jump (to track 80) is 100% satisfied from existing nodes with 0 new <li> allocations
    liCreates = 0;
    list.scrollTop = 80 * ROW;
    list.dispatchEvent(new window.Event('scroll'));
    while (frames.length) frames.splice(0).forEach((fn) => fn(0));
    assert.equal(liCreates, 0, 'subsequent disjoint scroll jump allocates zero new <li> nodes');
    const row80 = [...list.children].find((li) => li.dataset.index === '80');
    assert.ok(row80 && row80.querySelector('.cl-title').textContent === 'Song 80');
    window.dispatchEvent(new window.Event('beforeunload'));
    window.close();
});

test('Batch 64: classic-list multi-key sortCache reverses ties/empties in O(N) and cleans up on beforeunload without throwing', () => {
    const t = setup({ count: 0 });
    const artists = ['Artist 10', 'Artist 2', 'Artist 01', 'Artist 1', '', 'Beta', 'Alpha'];
    const tracks = Array.from({ length: 42 }, (_, i) => ({
        path: `/m/${i}.flac`,
        title: i % 7 === 0 ? '' : `Song ${String(i % 10).padStart(2, '0')}.flac`,
        artist: artists[i % artists.length],
        duration: i % 5 === 0 ? 0 : 120 + (i % 6) * 15
    }));
    t.app.playlist.push(...tracks);
    let stripCalls = 0;
    t.app.stripAudioExtension = (s) => { if (s) stripCalls += 1; return String(s || '').replace(/\.flac$/i, ''); };
    t.app.renderPlaylist();

    // 1. Sort by title asc -> title desc: 0 extra stripAudioExtension calls, empties remain at bottom, ties preserve original order
    const titleBtn = t.doc.querySelector('.music-list-sort.is-title');
    titleBtn.click();
    const callsAfterTitle = stripCalls;
    assert.ok(callsAfterTitle >= 36);
    const titleAsc = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.ok(titleAsc.slice(-6).every((tr) => tr.title === ''), 'empty titles at bottom in asc');

    titleBtn.click();
    assert.equal(stripCalls, callsAfterTitle, 'title asc -> desc uses O(N) reverseByRanks with zero stripAudioExtension calls');
    const titleDesc = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.ok(titleDesc.slice(-6).every((tr) => tr.title === ''), 'empty titles stay at bottom in desc');
    assert.equal(titleDesc[0].title, 'Song 09.flac');
    // Verify ties for 'Song 09.flac' preserve ascending original index even in desc mode
    const tie09 = titleDesc.filter((tr) => tr.title === 'Song 09.flac').map((tr) => tracks.indexOf(tr));
    for (let i = 1; i < tie09.length; i += 1) assert.ok(tie09[i] > tie09[i - 1], 'tied titles preserve original order in desc');

    // 2. Switch to artist asc -> artist desc -> back to title asc: returning to cached title asc makes 0 extra strip calls
    const artistBtn = t.doc.querySelector('.music-list-sort.is-artist');
    artistBtn.click();
    artistBtn.click();
    const artistDesc = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.equal(artistDesc[0].artist, 'Beta');
    assert.ok(artistDesc.slice(-6).every((tr) => tr.artist === ''), 'empty artists stay at bottom in desc');
    const tieArtDesc = artistDesc.filter((tr) => tr.artist === 'Artist 01' || tr.artist === 'Artist 1').map((tr) => tracks.indexOf(tr));
    for (let i = 1; i < tieArtDesc.length; i += 1) assert.ok(tieArtDesc[i] > tieArtDesc[i - 1], 'Collator numeric ties preserve original order in desc');

    titleBtn.click(); // returns to title asc from sortCache.byKey
    assert.equal(stripCalls, callsAfterTitle, 'switching back to cached title column reuses sortCache.byKey without re-sorting');
    assert.deepEqual([...t.list.children].map((li) => Number(li.dataset.index)), titleAsc.map((tr) => tracks.indexOf(tr)));

    // 3. beforeunload cleans up without throwing ReferenceError
    assert.doesNotThrow(() => t.window.dispatchEvent(new t.window.Event('beforeunload')));
    t.close();
});

test('Batch 65: music-ui renderWindow calibrates pitch in-place with single clientHeight read and guards hidden scroll', () => {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const list = doc.getElementById('playlist');
    let clientHeightReads = 0;
    let replaceChildrenCalls = 0;
    let insertCalls = 0;
    Object.defineProperty(list, 'clientHeight', { get() { clientHeightReads += 1; return 360; }, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
        get() { return this.parentNode === list ? Array.prototype.indexOf.call(list.children, this) * ROW : 0; },
        configurable: true
    });
    const origReplace = list.replaceChildren.bind(list);
    list.replaceChildren = (...args) => { replaceChildrenCalls += 1; return origReplace(...args); };
    const origInsert = list.insertBefore.bind(list);
    list.insertBefore = (...args) => { insertCalls += 1; return origInsert(...args); };

    const playlist = Array.from({ length: 200 }, (_, i) => ({ path: `/m/${i}.flac`, title: `Song ${i}.flac`, artist: `A${i}` }));
    const app = {
        playlist,
        playlistEl: list,
        currentTrackIndex: 10,
        stripAudioExtension: (s) => String(s || '').replace(/\.flac$/i, ''),
        updateAllCount() {}
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-ui.js'), 'utf8'));
    window.setupUI(app);
    app.renderPlaylist();

    // 360px / 36px = 10 visible + 40 buffer = 50 rows trimmed in-place from 80 fallback rows -> only 1 clientHeight read, 0 replaceChildren, single insert pass
    assert.equal(clientHeightReads, 1, 'initial renderWindow + pitch calibration reads clientHeight only once');
    assert.equal(replaceChildrenCalls, 0, 'in-place patching avoids list.replaceChildren teardown');
    assert.equal(insertCalls, 80, 'prefix trim avoids recursive renderWindow rebuild');
    assert.equal(list.children.length, 50, 'trimmed in-place to visible + buffer rows');
    assert.equal(list.lastElementChild.style.marginBottom, `${(200 - 50) * ROW}px`);

    // When archive covers classic view, scrollCurrentTrackToSidebarTop returns false without touching layout
    doc.body.classList.add('music-archive-on');
    clientHeightReads = 0;
    assert.equal(app.scrollCurrentTrackToSidebarTop(), false);
    assert.equal(clientHeightReads, 0, 'hidden classic view skips clientHeight reads in scrollCurrentTrackToSidebarTop');
    window.dispatchEvent(new window.Event('beforeunload'));
    window.close();
});

test('Batch 66: classic-list decorateRow clones template with pre-baked unliked state to skip redundant setAttribute calls', () => {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const list = doc.getElementById('playlist');
    const playlist = Array.from({ length: 10 }, (_, i) => ({ path: `/m/${i}.flac`, title: `Song ${i}`, artist: `A${i}`, duration: 100 + i }));
    const liked = new Set(['/m/3.flac']);
    const app = {
        playlist,
        playlistEl: list,
        isLiked: (t) => Boolean(t && liked.has(t.path)),
        renderPlaylist() {
            list.replaceChildren(...playlist.map((t, i) => {
                const li = doc.createElement('li');
                li.dataset.index = String(i);
                li.textContent = t.title;
                return li;
            }));
        }
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(source);
    window.setupMusicClassicList(app);

    let setAttrOnClonedBtns = 0;
    const origSetAttr = window.HTMLButtonElement.prototype.setAttribute;
    window.HTMLButtonElement.prototype.setAttribute = function (name, val) {
        if (this.className === 'cl-like' && this._likeState !== undefined) setAttrOnClonedBtns += 1;
        return origSetAttr.call(this, name, val);
    };
    try {
        app.renderPlaylist();
    } finally {
        window.HTMLButtonElement.prototype.setAttribute = origSetAttr;
    }
    // Only the 1 liked track (/m/3.flac) updates aria-pressed + aria-label (2 writes); all 9 unliked tracks make 0 writes!
    assert.equal(setAttrOnClonedBtns, 2, '9 unliked cloned rows skip paintLike setAttribute writes; 1 liked row updates');
    assert.equal(list.children[0].querySelector('.cl-like').getAttribute('aria-pressed'), 'false');
    assert.equal(list.children[3].classList.contains('is-liked'), true);
    assert.equal(list.children[3].querySelector('.cl-like').getAttribute('aria-pressed'), 'true');
    assert.equal(list.children[3].querySelector('.cl-like').getAttribute('aria-label'), '取消喜欢');
    window.dispatchEvent(new window.Event('beforeunload'));
    window.close();
});

test('Batch 68: music-ui patches sorted rows in-place with zero DOM moves, visibilityWatch renders sorted in one pass, and classic-list lazily ranks ties', async () => {
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    const list = doc.getElementById('playlist');
    Object.defineProperty(list, 'clientHeight', { get: () => 360, configurable: true });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
        get() { return this.parentNode === list ? Array.prototype.indexOf.call(list.children, this) * ROW : 0; },
        configurable: true
    });
    let stripCalls = 0;
    const playlist = Array.from({ length: 120 }, (_, i) => ({
        path: `/m/${i}.flac`,
        title: i % 20 === 0 ? '' : `Track ${String(120 - i).padStart(3, '0')}.flac`,
        artist: i % 15 === 0 ? '' : `Artist ${i % 10}`,
        duration: 100 + i
    }));
    const app = {
        playlist,
        playlistEl: list,
        currentTrackIndex: 0,
        stripAudioExtension: (s) => { stripCalls += 1; return String(s || '').replace(/\.flac$/i, ''); },
        updateAllCount() {}
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-ui.js'), 'utf8'));
    window.eval(source);
    window.setupUI(app);
    window.setupMusicClassicList(app);

    app.renderPlaylist();
    const initialNodes = [...list.children];
    assert.equal(initialNodes.length, 50);

    // Clicking title sort (asc) reuses the exact 50 mounted <li> elements in-place with 0 insertBefore/remove calls
    let inserts = 0;
    let removes = 0;
    const origInsert = list.insertBefore.bind(list);
    list.insertBefore = (...args) => { inserts += 1; return origInsert(...args); };
    const origRemove = window.Element.prototype.remove;
    window.Element.prototype.remove = function () { if (this.parentNode === list) removes += 1; return origRemove.call(this); };

    const titleBtn = doc.querySelector('.music-list-sort.is-title');
    titleBtn.click(); // asc
    const ascNodes = [...list.children];
    assert.equal(ascNodes.length, 50);
    assert.equal(ascNodes[0], initialNodes[0], 'first <li> node stays mounted in-place on sort');
    assert.equal(ascNodes[49], initialNodes[49], 'last <li> node stays mounted in-place on sort');
    assert.equal(inserts, 0, 'FIFO in-place patching performs 0 insertBefore on disjoint sort');
    assert.equal(removes, 0, 'FIFO in-place patching performs 0 remove on equal-window sort');
    assert.equal(ascNodes[0].querySelector('.cl-title').textContent, 'Track 001');

    // Clicking title sort again (desc) lazily builds ranks and reverses accurately while keeping empty titles at end
    titleBtn.click(); // desc
    assert.equal(list.children[0].querySelector('.cl-title').textContent, 'Track 119');
    const stripBeforeCacheHit = stripCalls;
    titleBtn.click(); // asc (sortCache hit: only music-ui renders 50 visible rows, 0 sorting stripAudioExtension)
    assert.equal(stripCalls - stripBeforeCacheHit, 50, 'sortCache avoids sorting stripAudioExtension calls (only 50 visible rows rendered)');
    // Passing a new array copy bypasses sortCache; WeakMap title cache + music-ui row reuse yield 0 stripAudioExtension calls
    const stripBeforeCopy = stripCalls;
    app.renderPlaylist(playlist.slice());
    assert.equal(stripCalls - stripBeforeCopy, 0, 'WeakMap title cache avoids re-stripping 120 tracks on sortCache miss');

    // Archive -> classic transition with active sort renders sorted in a single pass via app.renderPlaylist
    window.Element.prototype.remove = origRemove;
    list.insertBefore = origInsert;
    doc.body.classList.add('music-archive-on');
    app.renderPlaylist();
    let renderCalls = 0;
    const prevRender = app.renderPlaylist;
    app.renderPlaylist = (...args) => { renderCalls += 1; return prevRender(...args); };
    doc.body.classList.remove('music-archive-on');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(renderCalls, 1, 'visibilityWatch delegates deferred flush to app.renderPlaylist so sorted classic list renders once');
    assert.equal(list.children[0].querySelector('.cl-title').textContent, 'Track 001');

    window.dispatchEvent(new window.Event('beforeunload'));
    window.close();
});

test('Batch 71: music-skin deduplicates music-has-track/is-spec class toggles and supports keyboard nav on segmented controls', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="track-title">Song A</div>
        <div class="track-bitrate">320 kbps</div>
        <div id="music-stage"></div>
        <div id="music-stage-settings-card"><div class="music-stage-settings-body">
            <label><span class="music-stage-tuning-label">画质</span>
                <select id="s71">
                    <option value="low">节能</option>
                    <option value="mid" disabled>中档</option>
                    <option value="std">标准</option>
                    <option value="max">极致</option>
                </select>
            </label>
        </div></div></body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const doc = w.document;
    const titleEl = doc.querySelector('.track-title');
    const bitrateEl = doc.querySelector('.track-bitrate');
    const app = {
        playlist: [
            { path: '/a.flac', title: 'Song A', codec: 'FLAC' },
            { path: '/b.flac', title: 'Song B', codec: 'FLAC' }
        ],
        currentTrackIndex: 0,
        trackTitle: titleEl,
        trackBitrate: bitrateEl
    };
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    w.setupMusicSkin(app);
    assert.equal(doc.body.classList.contains('music-has-track'), true);
    assert.equal(bitrateEl.classList.contains('is-spec'), true);

    let bodyToggleCalls = 0;
    const origBodyToggle = doc.body.classList.toggle.bind(doc.body.classList);
    doc.body.classList.toggle = (cls, force) => { if (cls === 'music-has-track') bodyToggleCalls += 1; return origBodyToggle(cls, force); };
    let specToggleCalls = 0;
    const origSpecToggle = bitrateEl.classList.toggle.bind(bitrateEl.classList);
    bitrateEl.classList.toggle = (cls, force) => { if (cls === 'is-spec') specToggleCalls += 1; return origSpecToggle(cls, force); };

    // Switching to another valid track & another kbps value must NOT call classList.toggle redundantly
    app.currentTrackIndex = 1;
    titleEl.textContent = 'Song B';
    bitrateEl.textContent = '960 kbps';
    await new Promise((r) => setImmediate(r));
    assert.equal(bodyToggleCalls, 0, 'unchanged hasTrack skips redundant body.classList.toggle');
    assert.equal(specToggleCalls, 0, 'unchanged isSpec skips redundant trackBitrate.classList.toggle');

    // Clearing to non-kbps updates is-spec once
    bitrateEl.textContent = 'FLAC 24/96';
    await new Promise((r) => setImmediate(r));
    assert.equal(specToggleCalls, 1);
    assert.equal(bitrateEl.classList.contains('is-spec'), false);

    // Keyboard navigation on .music-skin-segmented skips disabled option and wraps cleanly
    const sel = doc.getElementById('s71');
    const group = doc.querySelector('.music-skin-segmented');
    const btns = [...group.querySelectorAll('button')];
    const key = (k) => group.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    btns[0].focus();
    key('ArrowRight');
    assert.equal(sel.value, 'std', 'ArrowRight skips disabled mid option to std');
    assert.equal(doc.activeElement, btns[2]);
    key('End');
    assert.equal(sel.value, 'max', 'End jumps to last enabled option');
    assert.equal(doc.activeElement, btns[3]);
    key('ArrowRight');
    assert.equal(sel.value, 'low', 'ArrowRight wraps from last to first enabled option');
    key('Home');
    assert.equal(sel.value, 'low');
    key('ArrowLeft');
    assert.equal(sel.value, 'max', 'ArrowLeft wraps from first to last enabled option');

    w.dispatchEvent(new w.Event('beforeunload'));
    w.close();
});

test('Batch 75: music-skin drops container :has() rules via .acoustic-drawer-open and classic-list hides .music-list-head via hidden property', async () => {
    const skinCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.css'), 'utf8');
    assert.equal(skinCss.includes(':has('), false, 'music-skin.css has zero :has(...) container invalidation selectors');
    assert.match(skinCss, /\.main-content\.acoustic-drawer-open\s+#visualizer/);
    assert.match(skinCss, /\.music-list-head\[hidden\]/);

    // 1. Acoustic drawer toggles .main-content.acoustic-drawer-open in sync with .acoustic-drawer.is-open
    const dom = new JSDOM(`<!doctype html><body>
        <div class="main-content">
            <canvas id="visualizer"></canvas>
            <div id="acoustic-drawer" class="acoustic-drawer">
                <button class="acoustic-drawer-toggle" type="button"></button>
                <span data-acoustic-summary></span>
            </div>
        </div></body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const doc = w.document;
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    w.setupMusicSkin({ playlist: [], currentTrackIndex: -1 });
    const main = doc.querySelector('.main-content');
    const toggle = doc.querySelector('.acoustic-drawer-toggle');
    assert.equal(main.classList.contains('acoustic-drawer-open'), false);
    toggle.click();
    assert.equal(main.classList.contains('acoustic-drawer-open'), true, 'opening acoustic drawer adds .acoustic-drawer-open on .main-content');
    toggle.click();
    assert.equal(main.classList.contains('acoustic-drawer-open'), false, 'closing acoustic drawer clears .acoustic-drawer-open on .main-content');
    w.close();

    // 2. Classic list syncs .music-list-head.hidden when #playlist style.display changes
    const t = setup({ count: 5 });
    const head = t.doc.querySelector('.music-list-head');
    assert.equal(head.hidden, false);
    t.list.style.display = 'none';
    await new Promise((r) => setImmediate(r));
    assert.equal(head.hidden, true, 'hiding #playlist hides .music-list-head via hidden attribute');
    t.list.style.display = '';
    await new Promise((r) => setImmediate(r));
    assert.equal(head.hidden, false, 'restoring #playlist restores .music-list-head');
    t.close();
});

test('Batch 77: music-ui caches playlist viewport height via ResizeObserver, header click renders before syncHead, and flat sort preserves order/ties/empties', () => {
    let roCb = null;
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul><div id="all-count"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const doc = w.document;
    w.ResizeObserver = class {
        constructor(cb) { roCb = cb; }
        observe() {}
        disconnect() {}
    };
    w.requestAnimationFrame = (fn) => { fn(0); return 1; };
    w.cancelAnimationFrame = () => {};
    const list = doc.getElementById('playlist');
    let clientHeightReads = 0;
    Object.defineProperty(list, 'clientHeight', {
        configurable: true,
        get() { clientHeightReads += 1; return 400; }
    });
    const tracks = [];
    // 80 tracks (>64 sample threshold): unique titles (high-cardinality), repeating artists (low-cardinality), plus empties & ties
    for (let i = 0; i < 76; i += 1) {
        tracks.push({
            path: `/m/${i}.flac`,
            title: `Song ${String(76 - i).padStart(2, '0')}.flac`,
            artist: `Artist ${i % 5}`,
            duration: 120 + (i % 7) * 10
        });
    }
    tracks.push({ path: '/m/tie1.flac', title: 'Song 10.flac', artist: 'Artist 0', duration: 120 });
    tracks.push({ path: '/m/tie2.flac', title: '', artist: '', duration: 0 });
    tracks.push({ path: '/m/empty1.flac', title: 'Alpha.flac', artist: '', duration: 0 });
    tracks.push({ path: '/m/empty2.flac', title: 'Zulu.flac', artist: 'Artist 1', duration: 999 });

    const app = {
        playlist: tracks,
        playlistEl: list,
        currentTrackIndex: 0,
        stripAudioExtension: (s) => String(s || '').replace(/\.flac$/i, ''),
        updateAllCount() {}
    };
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-ui.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-classic-list.js'), 'utf8'));
    w.setupUI(app);
    w.setupMusicClassicList(app);

    // 1. ResizeObserver caches list height -> subsequent renders perform 0 clientHeight reads
    roCb([{ contentRect: { width: 320, height: 420 } }]);
    app.renderPlaylist();
    const readsAfterRO = clientHeightReads;
    const titleBtn = doc.querySelector('.music-list-sort.is-title');
    const artistBtn = doc.querySelector('.music-list-sort.is-artist');
    const durBtn = doc.querySelector('.music-list-sort.is-duration');

    // 2. Sort button click invokes app.renderPlaylist BEFORE mutating .is-on in syncHead
    const order = [];
    const origRender = app.renderPlaylist;
    app.renderPlaylist = (...args) => { order.push('render'); return origRender(...args); };
    const origToggle = titleBtn.classList.toggle.bind(titleBtn.classList);
    titleBtn.classList.toggle = (cls, force) => { if (cls === 'is-on') order.push('syncHead'); return origToggle(cls, force); };

    titleBtn.click(); // title asc (high-cardinality >64 skips wasted full Set)
    assert.deepEqual(order.slice(0, 2), ['render', 'syncHead'], 'header click runs renderPlaylist before syncHead DOM write');
    assert.equal(clientHeightReads, readsAfterRO, 'ResizeObserver cached height avoids clientHeight reads on sort');
    const ascTitles = app.classicShownSongs();
    assert.equal(ascTitles[0].title, 'Alpha.flac');
    assert.equal(ascTitles[ascTitles.length - 1].title, '', 'empty title stays at end in asc');

    titleBtn.click(); // title desc
    const descTitles = app.classicShownSongs();
    assert.equal(descTitles[0].title, 'Zulu.flac');
    assert.equal(descTitles[descTitles.length - 1].title, '', 'empty title stays at end in desc');
    // Tied "Song 10.flac" tracks preserve original order even in desc
    const tie1Idx = descTitles.findIndex((x) => x.path === '/m/66.flac');
    const tie2Idx = descTitles.findIndex((x) => x.path === '/m/tie1.flac');
    assert.ok(tie1Idx >= 0 && tie2Idx === tie1Idx + 1, 'tied titles preserve original relative order in desc');

    // 3. Low-cardinality artist sort uses rank path & keeps empty artist last in asc and desc
    artistBtn.click();
    const ascArtists = app.classicShownSongs();
    assert.equal(ascArtists[0].artist, 'Artist 0');
    assert.equal(ascArtists[ascArtists.length - 1].artist, '');
    artistBtn.click();
    const descArtists = app.classicShownSongs();
    assert.equal(descArtists[0].artist, 'Artist 4');
    assert.equal(descArtists[descArtists.length - 1].artist, '');

    // 4. Numeric duration sort keeps 0-duration tracks last in asc and desc
    durBtn.click();
    const ascDur = app.classicShownSongs();
    assert.equal(ascDur[0].duration, 120);
    assert.equal(ascDur[ascDur.length - 1].duration, 0);
    durBtn.click();
    const descDur = app.classicShownSongs();
    assert.equal(descDur[0].duration, 999);
    assert.equal(descDur[descDur.length - 1].duration, 0);

    w.dispatchEvent(new w.Event('beforeunload'));
    w.close();
});

test('classic list syncHead deduplicates aria-pressed and classList writes on active column reversal', () => {
    const t = setup({ count: 3, layout: false });
    const titleBtn = t.doc.querySelector('.music-list-sort.is-title');
    assert.ok(titleBtn);
    titleBtn.click(); // title asc -> becomes active
    assert.equal(titleBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(titleBtn.classList.contains('is-on'), true);

    let ariaWrites = 0;
    const origSetAttr = titleBtn.setAttribute.bind(titleBtn);
    titleBtn.setAttribute = (k, v) => {
        if (k === 'aria-pressed') ariaWrites += 1;
        return origSetAttr(k, v);
    };
    let toggleCalls = 0;
    const origToggle = titleBtn.classList.toggle.bind(titleBtn.classList);
    titleBtn.classList.toggle = (cls, force) => {
        if (cls === 'is-on') toggleCalls += 1;
        return origToggle(cls, force);
    };

    titleBtn.click(); // title desc -> still active, only arrow changes
    assert.equal(ariaWrites, 0, 'reversing the active sort column does not rewrite aria-pressed');
    assert.equal(toggleCalls, 0, 'reversing the active sort column does not re-toggle is-on');

    t.window.dispatchEvent(new t.window.Event('beforeunload'));
    t.close();
});

test('Batch 82: classic list artist sort uses rank path even when first 64 tracks have distinct artists', () => {
    const t = setup({ count: 0 });
    // 400 tracks across 80 artists where the first 64 tracks all have distinct artists (used to trip the 64-item sample check)
    const tracks = Array.from({ length: 400 }, (_, i) => ({
        path: `/m/${i}.flac`,
        title: `Song ${i}.flac`,
        artist: i % 80 === 79 ? '' : `Artist ${i % 80}`,
        duration: 180
    }));
    t.app.playlist.push(...tracks);
    t.app.renderPlaylist();

    const artistBtn = t.doc.querySelector('.music-list-sort.is-artist');
    artistBtn.click(); // artist asc
    const asc = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.equal(asc[0].artist, 'Artist 0');
    assert.equal(asc[5].artist, 'Artist 1', 'numeric Collator puts Artist 1 before Artist 10');
    assert.ok(asc.slice(-5).every((tr) => tr.artist === ''), 'empty artists stay at bottom in asc');

    artistBtn.click(); // artist desc
    const desc = [...t.list.children].map((li) => tracks[Number(li.dataset.index)]);
    assert.equal(desc[0].artist, 'Artist 78', 'highest numeric artist leads in desc');
    const tie78 = desc.slice(0, 5).map((tr) => tracks.indexOf(tr));
    for (let i = 1; i < tie78.length; i += 1) assert.ok(tie78[i] > tie78[i - 1], 'tied artists keep original relative order in desc');
    assert.ok(desc.slice(-5).every((tr) => tr.artist === ''), 'empty artists stay at bottom in desc');

    t.window.dispatchEvent(new t.window.Event('beforeunload'));
    t.close();
});

test('Batch 83: music-skin deduplicates renderTrack, restarts roller across rAF with zero offsetWidth reflow, filters settingsObs, and stage-skin stops menu animation under reduce-motion', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <div id="track-title">Song A</div>
        <div id="track-bitrate">320 kbps</div>
        <div class="track-file-number" data-track-field="file-number"></div>
        <div class="track-specs">
            <div><span data-track-field="format"></span></div>
            <div><span data-track-field="sample-rate"></span></div>
            <div><span data-track-field="bit-depth"></span></div>
            <div><span data-track-field="bitrate"></span></div>
            <div><span data-track-field="specs"></span></div>
        </div>
        <div id="music-stage-settings-card"><div class="music-stage-settings-body"></div></div>
    </body>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const doc = w.document;
    const rafQueue = [];
    w.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    w.cancelAnimationFrame = () => {};
    let reflowReads = 0;
    const roller = doc.querySelector('.track-file-number');
    Object.defineProperty(roller, 'offsetWidth', { configurable: true, get() { reflowReads += 1; return 100; } });
    const fmtEl = doc.querySelector('[data-track-field="format"]');
    const settingsBody = doc.querySelector('.music-stage-settings-body');

    const app = {
        playlist: [
            { path: '/m/a.flac', title: 'Song A', album: 'Alb', codec: 'FLAC', sampleRate: 44100, bitsPerSample: 16, bitrate: 900000, lossless: true },
            { path: '/m/b.flac', title: 'Song B', album: 'Alb2', codec: 'FLAC', sampleRate: 96000, bitsPerSample: 24, bitrate: 2400000, lossless: true }
        ],
        currentTrackIndex: 0,
        trackTitle: doc.getElementById('track-title'),
        trackBitrate: doc.getElementById('track-bitrate')
    };
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    w.setupMusicSkin(app);
    assert.equal(reflowReads, 0, 'initial visible classic track render performs zero offsetWidth reflows');
    assert.equal(roller.classList.contains('is-rolling'), false, 'roller waits for rAF frame before adding is-rolling');
    rafQueue.splice(0).forEach((cb) => cb());
    assert.equal(roller.classList.contains('is-rolling'), true, 'roller gains is-rolling on next animation frame');

    // 1. Unchanged track mutation skips format/spec writes
    let fmtWrites = 0;
    const textDesc = Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent');
    Object.defineProperty(fmtEl, 'textContent', {
        configurable: true,
        get() { return textDesc.get.call(this); },
        set(v) { fmtWrites += 1; return textDesc.set.call(this, v); }
    });
    app.trackTitle.textContent = 'Song A';
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fmtWrites, 0, 'identical track metadata short-circuits renderTrack without touching spec DOM');

    // 2. Track change restarts roller via rAF with zero offsetWidth reflows
    app.currentTrackIndex = 1;
    app.trackTitle.textContent = 'Song B';
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(reflowReads, 0, 'track change in visible classic view triggers zero offsetWidth reflows');
    assert.equal(roller.classList.contains('is-rolling'), false);
    rafQueue.splice(0).forEach((cb) => cb());
    assert.equal(roller.classList.contains('is-rolling'), true);

    // 3. settingsObs ignores non-select DOM additions without scanning settingsBody
    let qsaCalls = 0;
    const origQsa = settingsBody.querySelectorAll.bind(settingsBody);
    settingsBody.querySelectorAll = (...args) => { qsaCalls += 1; return origQsa(...args); };
    const plainDiv = doc.createElement('div');
    plainDiv.textContent = 'label update';
    settingsBody.appendChild(plainDiv);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(qsaCalls, 0, 'adding plain non-select element skips settingsBody querySelectorAll scan');

    const sel = doc.createElement('select');
    sel.innerHTML = '<option value="a">开</option><option value="b">关</option>';
    settingsBody.appendChild(sel);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(qsaCalls, 1, 'adding an unsegmented select triggers scan once');
    assert.equal(sel.dataset.segmented, '1');

    // 4. music-stage-skin.css disables mode-menu animation under body.music-reduce-motion
    const stageSkinCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-stage-skin.css'), 'utf8');
    assert.match(stageSkinCss, /body\.music-reduce-motion \.music-stage-mode-menu\s*\{[^}]*animation:\s*none/);

    w.dispatchEvent(new w.Event('beforeunload'));
    w.close();
});

test('Batch 88: classic-list skips scroll rAF when all rows decorated, skin preserves non-segmentable select for fluid-select, and utility/IPC hot paths behave identically', async () => {
    // 1. Classic list: fully decorated list skips scroll rAF; single-track like-change fast path works
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    const doc = w.document;
    const list = doc.getElementById('playlist');
    let rafCalls = 0;
    w.requestAnimationFrame = (fn) => { rafCalls += 1; fn(0); return rafCalls; };
    w.cancelAnimationFrame = () => {};
    const liked = new Set(['/m/0.flac']);
    const tracks = [
        { path: '/m/0.flac', title: 'Alpha.flac', artist: 'A', duration: 120 },
        { path: '/m/1.flac', title: 'Beta.flac', artist: 'B', duration: 180 }
    ];
    const app = {
        playlist: tracks,
        playlistEl: list,
        isLiked: (t) => Boolean(t && liked.has(t.path)),
        toggleLike: () => {},
        renderPlaylist(songs = tracks) {
            list.replaceChildren();
            songs.forEach((tr) => {
                const li = doc.createElement('li');
                li.dataset.index = String(tracks.indexOf(tr));
                li.textContent = tr.title;
                list.appendChild(li);
            });
        }
    };
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-app-hooks.js'), 'utf8'));
    w.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-classic-list.js'), 'utf8'));
    w.setupMusicClassicList(app);
    app.renderPlaylist();
    assert.equal(list.children[0].dataset.cols, '1');
    assert.equal(list.children[1].dataset.cols, '1');
    const rafBeforeScroll = rafCalls;
    list.dispatchEvent(new w.Event('scroll'));
    assert.equal(rafCalls, rafBeforeScroll, 'fully decorated classic list skips scheduling scroll rAF');

    // Single-track like change updates only the target row; empty-path track array touches nothing
    liked.add('/m/1.flac');
    doc.dispatchEvent(new w.CustomEvent('music-like-change', { detail: { tracks: [{}] } }));
    assert.equal(list.children[1].classList.contains('is-liked'), false, 'empty-path like event updates nothing');
    doc.dispatchEvent(new w.CustomEvent('music-like-change', { detail: { tracks: [tracks[1]] } }));
    assert.equal(list.children[1].classList.contains('is-liked'), true, 'single-track like event updates target row');
    w.dispatchEvent(new w.Event('beforeunload'));
    w.close();

    // 2. music-skin: non-segmentable <select> keeps dataset.segmented unset (so music-fluid-select still dresses it) and is not re-scanned on later DOM adds
    const skinDom = new JSDOM('<!doctype html><body><div id="music-stage-settings-card"><div class="music-stage-settings-body"></div></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const sw = skinDom.window;
    const sdoc = sw.document;
    const body = sdoc.querySelector('.music-stage-settings-body');
    const bigSel = sdoc.createElement('select');
    bigSel.innerHTML = '<option value="1">选项一</option><option value="2">选项二</option><option value="3">选项三</option><option value="4">选项四</option><option value="5">选项五</option>';
    body.appendChild(bigSel);
    sw.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
    sw.setupMusicSkin({ playlist: [], currentTrackIndex: -1 });
    assert.equal(bigSel.dataset.segmented, undefined, 'non-segmentable select must NOT set dataset.segmented');
    let scanCalls = 0;
    const origQsa = body.querySelectorAll.bind(body);
    body.querySelectorAll = (...args) => { scanCalls += 1; return origQsa(...args); };
    const wrap = sdoc.createElement('div');
    wrap.appendChild(bigSel); // re-attaching already-checked non-segmentable select
    body.appendChild(wrap);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(scanCalls, 0, 'already-checked non-segmentable select does not trigger repeated scan()');
    sw.dispatchEvent(new sw.Event('beforeunload'));
    sw.close();

    // 3. music-smart evaluate without ctx.now handles 很久没听 + text
    const smart = require('../Musicmodules/music-smart.js');
    const oldTs = Date.now() - 40 * 86400000;
    const recentTs = Date.now() - 2 * 86400000;
    const statsMap = new Map([
        [tracks[0], { plays: 3, last: oldTs }],
        [tracks[1], { plays: 3, last: recentTs }]
    ]);
    const matched = smart.evaluate(tracks, '很久没听 alpha', { stats: statsMap });
    assert.deepEqual(matched.map((t) => t.path), ['/m/0.flac']);

    // 4. lyricsMarkdown escapes HTML, markdown metacharacters, and newlines cleanly
    const { formatCurrentLyrics } = require('../modules/lyrics/lyricsMarkdown.js');
    const md = formatCurrentLyrics({
        track: { title: '<A & B> *test*', artist: 'X_Y' },
        lines: [{ original: 'Line 1\n<tag> & [1]', translation: '译文' }]
    });
    assert.ok(md.includes('&lt;A &amp; B&gt; \\*test\\*'));
    assert.ok(md.includes('Line 1 &lt;tag&gt; &amp; \\[1\\]'));

    // 5. musicLyricsHandlers caches ensureDir per lyricDir and invalidates on error
    const fsExtra = require('fs-extra');
    const { registerMusicLyricsHandlers } = require('../modules/ipc/musicLyricsHandlers.js');
    const handlers = new Map();
    let ensureCalls = 0;
    const origEnsureDir = fsExtra.ensureDir;
    fsExtra.ensureDir = async () => { ensureCalls += 1; };
    try {
        let shouldFail = false;
        registerMusicLyricsHandlers({
            ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
            getLyricDir: () => '/tmp/lyrics-cache-r88',
            lyricFetcher: {
                fetchAndSaveLyrics: async () => {
                    if (shouldFail) throw new Error('boom');
                    return { lines: [] };
                }
            }
        });
        const fetchHandler = handlers.get('music-fetch-lyrics');
        await fetchHandler({}, { title: 'T1', artist: 'A1' });
        await fetchHandler({}, { title: 'T2', artist: 'A2' });
        assert.equal(ensureCalls, 1, 'ensureDir runs once per lyricDir across successful fetches');
        shouldFail = true;
        await fetchHandler({}, { title: 'T3', artist: 'A3' });
        shouldFail = false;
        await fetchHandler({}, { title: 'T4', artist: 'A4' });
        assert.equal(ensureCalls, 2, 'error invalidates cached lyricDir so next fetch re-ensures directory');
    } finally {
        fsExtra.ensureDir = origEnsureDir;
    }
});

test('Batch 94: classic list caches clientHeight & reads viewport before emptyText write, lyrics-ai memoizes needsTranslation, and folders/stats-view helpers match', () => {
    const ROOT = path.join(__dirname, '..');
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul><span id="all-count"></span></body>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const doc = window.document;
    try {
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-utils.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-ui.js'), 'utf8'));
        const list = doc.getElementById('playlist');
        let clientHeightReads = 0;
        let emptyTextDuringRead = 'unset';
        Object.defineProperty(list, 'clientHeight', {
            configurable: true,
            get() { clientHeightReads += 1; emptyTextDuringRead = list.dataset.emptyText; return 480; }
        });
        Object.defineProperty(list, 'scrollTop', {
            configurable: true,
            get() { return 0; },
            set() {}
        });
        const app = {
            playlist: [{ path: '/a.flac', title: 'Alpha', artist: 'X' }, { path: '/b.flac', title: 'Beta', artist: 'Y' }],
            currentTrackIndex: 0,
            playlistEl: list,
            allCount: doc.getElementById('all-count'),
            updateAllCount() {}
        };
        window.setupUtils(app);
        window.setupUI(app);

        app.renderPlaylist([]);
        assert.equal(clientHeightReads, 1, 'initial render reads clientHeight once');
        assert.equal(emptyTextDuringRead, undefined, 'renderNow reads clientHeight before mutating dataset.emptyText');
        assert.equal(list.dataset.emptyText, '这里还没有歌曲');

        // Subsequent renders reuse cachedListHeight without re-reading clientHeight
        app.renderPlaylist(app.playlist);
        app.renderPlaylist([app.playlist[0]]);
        assert.equal(clientHeightReads, 1, 'subsequent renders reuse cachedListHeight with 0 extra clientHeight reads');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }

    // music-lyrics-ai memoizes needsTranslation on unchanged lyrics array and refreshes on translation mutation
    const lyricsAi = require(path.join(ROOT, 'Musicmodules/music-lyrics-ai.js'));
    const hooks = require(path.join(ROOT, 'Musicmodules/music-app-hooks.js'));
    globalThis.MusicAppHooks = hooks;
    const aiApp = {
        currentLyrics: [{ text: 'Hello world today' }, { text: 'Another English line' }, { text: 'Final line here' }],
        fetchAndDisplayLyrics: async () => {}
    };
    lyricsAi.setupMusicLyricsAi(aiApp, { storage: null });
    assert.equal(aiApp.lyricsAi.needsTranslation(), true);
    assert.equal(aiApp.lyricsAi.needsTranslation(), true);
    aiApp.currentLyrics[0].translation = '你好世界';
    aiApp.currentLyrics[1].translation = '另一行英文';
    assert.equal(aiApp.lyricsAi.needsTranslation(), false, 'in-place translation fill invalidates memoized needsTranslation');
    aiApp.currentLyrics = [{ text: '纯中文歌词第一行' }, { text: '纯中文歌词第二行' }];
    assert.equal(aiApp.lyricsAi.needsTranslation(), false);

    // music-folders folderRows & music-stats-view longestStreak
    const folders = require(path.join(ROOT, 'Musicmodules/music-folders.js'));
    const rows = folders.folderRows(
        [{ path: 'D:\\Music\\Lib', exists: true }],
        [
            { path: 'D:\\Music\\Lib\\A\\1.flac' },
            { path: 'D:\\Music\\Lib\\A\\2.flac' },
            { path: 'D:\\Other\\Sub\\3.flac' },
            { path: 'D:\\Other\\Sub\\4.flac' }
        ]
    );
    assert.equal(rows[0].count, 2);
    assert.equal(rows[1].path, 'D:\\Other\\Sub');
    assert.equal(rows[1].count, 2);

    const statsView = require(path.join(ROOT, 'Musicmodules/music-stats-view.js'));
    assert.equal(statsView.longestStreak({ '2026-11-20': 120, '2026-11-21': 90, '2026-11-22': 180, '2026-11-24': 60, '2026-11-25': 30 }), 3);
});

test('Batch 97: searchTracks narrows incremental queries safely, stripAudioExtension fast-paths long dots, and decorateRow caches text fields', () => {
    const ROOT = path.join(__dirname, '..');
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul><span id="all-count"></span></body>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const doc = window.document;
    try {
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-app-hooks.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-utils.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-ui.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-theme/music-classic-list.js'), 'utf8'));

        const tracks = [
            { path: '/1.flac', title: 'Vol. 2 Live Session.flac', artist: 'Artist A', album: 'Album 1', duration: 200 },
            { path: '/2.mp3', title: 'Calm Night.mp3', artist: 'Artist A', album: 'Album 1', duration: 200 },
            { path: '/3.opus', title: 'Live Encore.opus', artist: 'Artist B', album: 'Album 2', duration: 185 }
        ];
        const list = doc.getElementById('playlist');
        Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 480 });
        Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => 0, set() {} });
        const app = {
            playlist: tracks,
            currentTrackIndex: 0,
            playlistEl: list,
            allCount: doc.getElementById('all-count'),
            isLiked: () => false,
            toggleLike() {},
            updateAllCount() {}
        };
        window.setupUtils(app);
        window.setupUI(app);
        window.setupMusicClassicList(app);

        assert.equal(app.stripAudioExtension('Vol. 2 Live Session'), 'Vol. 2 Live Session');
        assert.equal(app.stripAudioExtension('Vol. 2 Live Session.flac'), 'Vol. 2 Live Session');
        assert.equal(app.stripAudioExtension('Encore.opus'), 'Encore');

        const r1 = app.searchTracks(tracks, 'li');
        assert.deepEqual(Array.from(r1, (t) => t.path), ['/1.flac', '/3.opus']);
        // Mutating caller's returned array must not corrupt the narrowing cache
        r1.pop();
        const r2 = app.searchTracks(tracks, 'live');
        assert.deepEqual(Array.from(r2, (t) => t.path), ['/1.flac', '/3.opus'], 'narrowed search uses isolated cached hit snapshot');
        const r3 = app.searchTracks(tracks, 'live encore');
        assert.deepEqual(Array.from(r3, (t) => t.path), ['/3.opus'], 'multi-word narrowing filters down cleanly');
        const r4 = app.searchTracks(tracks, 'calm');
        assert.deepEqual(Array.from(r4, (t) => t.path), ['/2.mp3'], 'non-narrowing query falls back to full scan');

        // Reusing a decorated classic row skips DOM textContent getter reads on unchanged duration/artist
        app.renderPlaylist(tracks);
        const row0 = list.children[0];
        assert.ok(row0 && row0._cl);
        const durEl = row0._cl.duration;
        let durReads = 0;
        let durWrites = 0;
        const textDesc = Object.getOwnPropertyDescriptor(window.Node.prototype, 'textContent');
        Object.defineProperty(durEl, 'textContent', {
            configurable: true,
            get() { durReads += 1; return textDesc.get.call(this); },
            set(v) { durWrites += 1; return textDesc.set.call(this, v); }
        });
        // Render [tracks[1]] into row0 (same 200s duration -> 0 reads, 0 writes on duration span)
        app.renderPlaylist([tracks[1]]);
        assert.equal(durReads, 0, 'cached lastDurRaw avoids reading duration.textContent');
        assert.equal(durWrites, 0, 'unchanged duration skips duration.textContent write');
        // Render [tracks[2]] (185s -> updates duration once)
        app.renderPlaylist([tracks[2]]);
        assert.equal(durWrites, 1, 'changed duration updates duration.textContent once');
        assert.equal(durEl.textContent, '3:05');

        // Batch 98: searchTracks preserves caller realm Array constructor; MusicTrackSpecs.summary formats cleanly
        assert.equal(r1 instanceof tracks.constructor, true, 'searchTracks result inherits caller realm Array');
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-theme/music-skin.js'), 'utf8'));
        assert.equal(
            window.MusicTrackSpecs.summary({ path: '/x.flac', codec: 'FLAC', sampleRate: 96000, bitsPerSample: 24, bitrate: 2800000, lossless: true }),
            'FLAC · 96 kHz · 24 bit · 2800 kbps'
        );
        assert.equal(
            window.MusicTrackSpecs.summary({ path: '/y.mp3', sampleRate: 44100, bitrate: 320000 }),
            'MP3 · 44.1 kHz · 320 kbps'
        );
        assert.equal(window.MusicTrackSpecs.summary(null), '');

        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});

test('Batch 103: music-ui reuses same-tick scrollTop snapshot & builds positionOf lazily, and music-skin scopes counter-increment to :not([data-n])', async () => {
    const ROOT = path.join(__dirname, '..');
    const skinCss = fs.readFileSync(path.join(ROOT, 'Musicmodules/music-theme/music-skin.css'), 'utf8');
    assert.match(skinCss, /\.sidebar-playlist li:not\(\[data-n\]\)\s*\{\s*counter-increment:\s*track;\s*\}/, 'counter-increment scoped away from data-n virtualized rows');

    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul><span id="all-count"></span></body>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const doc = window.document;
    try {
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-utils.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-ui.js'), 'utf8'));
        const list = doc.getElementById('playlist');
        let scrollReads = 0;
        let scrollVal = 0;
        Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 400 });
        Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 4000 });
        Object.defineProperty(list, 'scrollTop', {
            configurable: true,
            get() { scrollReads += 1; return scrollVal; },
            set(v) { scrollVal = v; }
        });
        const tracks = Array.from({ length: 120 }, (_, i) => ({ path: `/t${i}.flac`, title: `T${i}.flac`, artist: 'A', duration: 180 }));
        const app = { playlist: tracks, currentTrackIndex: 110, playlistEl: list, updateAllCount() {} };
        window.setupUtils(app);
        window.setupUI(app);

        // Back-to-back and cross-tick renders without scroll event reuse cached scrollTop (0 extra reflows)
        const rev = tracks.slice().reverse();
        scrollReads = 0;
        app.renderPlaylist(tracks);
        app.renderPlaylist(rev);
        assert.equal(scrollReads, 1, 'back-to-back synchronous renderPlaylist calls read scrollTop only once');

        await Promise.resolve();
        app.renderPlaylist(tracks);
        assert.equal(scrollReads, 1, 'subsequent tick without scroll event keeps cached scrollTop without forced reflow');

        // A real scroll event marks cache dirty so the next render reads fresh scrollTop
        scrollVal = 240;
        list.dispatchEvent(new window.Event('scroll'));
        app.renderPlaylist(rev);
        assert.equal(scrollReads, 2, 'scroll event invalidates cache and reads fresh scrollTop');

        // Batch 106: searchTracks single-word fast path and multi-word query parity
        assert.equal(app.searchTracks(tracks, '  t10  ').length, 11);
        assert.equal(app.searchTracks(tracks, 't10   a').length, 11);
        assert.equal(app.searchTracks(tracks, 't10 missing').length, 0);
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});

test('Batch 109: classic-list dotless titleOf fast-path, O(N) counting rank sort, definitelyDistinct ties, and virtualized content-visibility override', () => {
    const skinCss = fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-skin.css'), 'utf8');
    assert.match(skinCss, /#playlist\.sidebar-playlist li\s*\{[^}]*content-visibility:\s*visible;/, 'virtualized classic list opts out of content-visibility: auto');

    // 1. Dotless titles skip stripAudioExtension completely while .flac titles still invoke it
    const t = setup({ count: 40 });
    try {
        let stripCalls = 0;
        t.app.stripAudioExtension = (s) => { stripCalls += 1; return String(s || '').replace(/\.flac$/i, ''); };
        t.doc.querySelector('.music-list-sort.is-title').click();
        assert.equal(stripCalls, 0, 'dotless track titles bypass stripAudioExtension during title sort');

        // 2. Dense counting sort on low-cardinality artist column preserves stable tie order & exact reverse
        const artists = ['陈奕迅', '周杰伦', 'Adele', 'adele', '', '周杰伦', '陈奕迅', 'Adele'];
        const tracks = Array.from({ length: 48 }, (_, i) => ({
            title: i % 3 === 0 ? `曲目 ${i + 1}` : (i % 3 === 1 ? `Track 0${(i % 9) + 1}` : `Track ${(i % 9) + 1}`),
            artist: artists[i % artists.length],
            duration: 100 + i
        }));
        t.app.playlist.splice(0, t.app.playlist.length, ...tracks);
        t.doc.querySelector('.music-list-sort.is-artist').click();
        const ascIndices = [...t.list.children].map((li) => Number(li.dataset.index));
        const coll = new Intl.Collator(['zh-Hans-CN', 'ja', 'en'], { numeric: true, sensitivity: 'base' });
        const expectedAsc = tracks.map((_, i) => i).sort((a, b) => {
            const va = tracks[a].artist || '', vb = tracks[b].artist || '';
            if (!va && !vb) return a - b;
            if (!va) return 1;
            if (!vb) return -1;
            return coll.compare(va, vb) || (a - b);
        });
        assert.deepEqual(ascIndices, expectedAsc, 'O(N) counting sort matches Collator + stable index tie-break');

        // Reverse artist sort keeps empty artists last & preserves tie order within identical/case-folded artist groups
        t.doc.querySelector('.music-list-sort.is-artist').click();
        const descIndices = [...t.list.children].map((li) => Number(li.dataset.index));
        const expectedDesc = tracks.map((_, i) => i).sort((a, b) => {
            const va = tracks[a].artist || '', vb = tracks[b].artist || '';
            if (!va && !vb) return a - b;
            if (!va) return 1;
            if (!vb) return -1;
            return -coll.compare(va, vb) || (a - b);
        });
        assert.deepEqual(descIndices, expectedDesc, 'reversed artist sort preserves tie stability and empty-last order');

        // 3. Title desc with leading-zero ties ('Track 01' vs 'Track 1') keeps exact Collator tie groups
        t.doc.querySelector('.music-list-sort.is-title').click();
        t.doc.querySelector('.music-list-sort.is-title').click();
        const titleDesc = [...t.list.children].map((li) => Number(li.dataset.index));
        const expectedTitleDesc = tracks.map((_, i) => i).sort((a, b) => -coll.compare(tracks[a].title, tracks[b].title) || (a - b));
        assert.deepEqual(titleDesc, expectedTitleDesc, 'definitelyDistinct never splits numeric/case-equivalent tie groups on title reversal');
    } finally {
        t.close();
    }
});

test('Batch 113: classic-list tail-dot/zero-digit ties & _cols fast path, music-ui spacer tracking, utils tail-dot/NFKC/formatTime, and fluid-select #playlist skip', async () => {
    const ROOT = path.join(__dirname, '..');
    const dom = new JSDOM('<!doctype html><body><ul id="playlist"></ul><span id="all-count"></span></body>', {
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const doc = window.document;
    try {
        window.CSS = window.CSS || { escape: (s) => String(s) };
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-app-hooks.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-utils.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-ui.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-theme/music-classic-list.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-select.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-theme/music-skin.js'), 'utf8'));

        const list = doc.getElementById('playlist');
        Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 360 });
        Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => 0, set() {} });
        Object.defineProperty(window.HTMLElement.prototype, 'offsetTop', {
            configurable: true,
            get() { return this.parentNode === list ? Array.prototype.indexOf.call(list.children, this) * 36 : 0; }
        });
        const tracks = [
            { path: '/0.flac', title: 'Track 0.flac', artist: 'Art A', album: 'Alb 1', duration: 65 },
            { path: '/1.flac', title: 'Track 01.flac', artist: 'Art A', album: 'Alb 1', duration: 3661 },
            { path: '/2.flac', title: 'Track 1.flac', artist: 'Art A', album: 'Alb 1', duration: 120 },
            { path: '/3.flac', title: 'Track 100.flac', artist: 'Art B', album: 'Alb 2', duration: 120 },
            { path: '/4.flac', title: 'Track 101.flac', artist: 'Art B', album: 'Alb 2', duration: 120 },
            { path: '/5.flac', title: 'Track 10 (Live).flac', artist: 'Art B', album: 'Alb 2', duration: 120 },
            { path: '/6.flac', title: 'Track 10.flac', artist: 'Art B', album: 'Alb 2', duration: 120 },
            { path: '/7.flac', title: 'Vol. 2 Plain', artist: 'ＬＥＭＯＮ', album: 'Alb 3', duration: 185 }
        ];
        const app = {
            playlist: tracks,
            currentTrackIndex: 0,
            playlistEl: list,
            allCount: doc.getElementById('all-count'),
            isLiked: () => false,
            toggleLike() {},
            updateAllCount() {}
        };
        window.setupUtils(app);
        window.setupUI(app);
        window.setupMusicClassicList(app);

        // 1. formatDuration & formatTime integer fast paths (<1h and >=1h)
        assert.equal(window.MusicClassicList.formatDuration(65), '1:05');
        assert.equal(window.MusicClassicList.formatDuration(3661), '1:01:01');
        assert.equal(app.formatTime(59), '0:59');
        assert.equal(app.formatTime(3661), '1:01:01');
        // 2. stripAudioExtension tail-dot Set lookup + searchTracks needsNfkc
        assert.equal(app.stripAudioExtension('Vol. 2 Plain'), 'Vol. 2 Plain');
        assert.equal(app.stripAudioExtension('Demo.aiff'), 'Demo');
        assert.equal(app.stripAudioExtension('Demo.unknown'), 'Demo.unknown');
        assert.deepEqual(Array.from(app.searchTracks(tracks, 'lemon'), (t) => t.path), ['/7.flac']);
        assert.deepEqual(Array.from(app.searchTracks(tracks, 'live'), (t) => t.path), ['/5.flac']);
        assert.deepEqual(Array.from(app.searchTracks(tracks, 'alb 3'), (t) => t.path), ['/7.flac']);

        // 3. Title desc preserves exact Collator ties ('Track 01' vs 'Track 1') and distinct '0'/'1', '100'/'101', '10'/'10 (Live)'
        app.renderPlaylist(tracks);
        let closestCalls = 0;
        const origClosest = list.closest.bind(list);
        list.closest = (...args) => { closestCalls += 1; return origClosest(...args); };
        const titleBtn = doc.querySelector('.music-list-sort.is-title');
        titleBtn.click();
        titleBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(closestCalls, 0, 'fluid-select bodyObs skips #playlist mutations without calling closest()');
        const descTitles = [...list.children].map((li) => app.stripAudioExtension(tracks[li._idx].title));
        const coll = new Intl.Collator(['zh-Hans-CN', 'ja', 'en'], { numeric: true, sensitivity: 'base' });
        const expectedDesc = tracks.map((_, i) => i)
            .sort((a, b) => -coll.compare(app.stripAudioExtension(tracks[a].title), app.stripAudioExtension(tracks[b].title)) || (a - b))
            .map((i) => app.stripAudioExtension(tracks[i].title));
        assert.deepEqual(descTitles, expectedDesc, 'title desc matches Collator tie groups across 0/1, 01/1, 100/101, and (Live)');
        assert.ok([...list.children].every((li) => li._cols === true && typeof li._idx === 'number'));
        assert.equal(window.MusicTrackSpecs.format({ path: '/noext/track' }), '');
        assert.equal(window.MusicTrackSpecs.format({ path: '/a/b.flac' }), 'FLAC');

        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});
