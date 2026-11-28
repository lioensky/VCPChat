/* 档案目录的检索索引：拼音、假名、首字母分组、各分类的行。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Index = require('../Musicmodules/music-archive/archive-index.js');

// 测试里用一张带声调的小拼音表代替真正的拼音库（声调要能去掉）
const PY = { 晴: 'qíng', 天: 'tiān', 海: 'hǎi', 风: 'fēng', 周: 'zhōu', 杰: 'jié', 伦: 'lún', 夜: 'yè', 曲: 'qǔ' };
const pinyin = (c) => PY[c] || '';

const TRACKS = [
    { path: '/a', title: '晴天.flac', artist: '周杰伦', album: '叶惠美' },
    { path: '/b', title: '海风', artist: 'Aimer', album: 'Dawn' },
    { path: '/c', title: 'アイドル', artist: 'YOASOBI', album: 'THE BOOK 3' },
    { path: '/d', title: 'Blue Bird', artist: 'いきものがかり', album: '' },
    { path: '/e', title: '1989', artist: 'Taylor', album: '1989' },
    { path: '/f', title: '「夜曲」', artist: '周杰伦', album: '十一月的萧邦' }
];

test('romanize 给出全拼和首字母，拉丁词取词首', () => {
    assert.deepEqual(Index.romanize('晴天', pinyin), { py: 'qingtian', ini: 'qt' });
    assert.deepEqual(Index.romanize('Blue Bird', pinyin), { py: 'bluebird', ini: 'bb' });
    assert.deepEqual(Index.romanize('晴天', null), { py: '晴天', ini: '晴天' });
});

test('拼音全拼、首字母都能找到汉字标题和歌手', () => {
    const idx = Index.createIndex(TRACKS, { pinyin });
    assert.equal(idx.query('qt')[0], 0);
    assert.equal(idx.query('qingt')[0], 0);
    assert.equal(idx.query('haif')[0], 1);
    assert.deepEqual(idx.query('zjl').sort(), [0, 5]);
    assert.deepEqual(idx.query('zjl yq'), [5]); // 多个词都要命中
});

test('平假名和片假名互通，全角半角不分', () => {
    const idx = Index.createIndex(TRACKS, { pinyin });
    assert.deepEqual(idx.query('あいど'), [2]);
    assert.deepEqual(idx.query('イキモノ'), [3]);
    assert.deepEqual(idx.query('ＹＯＡ'), [2]);
});

test('标题前缀最靠前，其次歌手前缀，再是标题中间命中', () => {
    const idx = Index.createIndex([
        { title: 'Night Walk', artist: 'Blue' },
        { title: 'Blue Night', artist: 'X' },
        { title: 'Deep Blue', artist: 'Y' }
    ]);
    assert.deepEqual(idx.query('blue'), [1, 0, 2]);
});

test('首字母分组：字母、假名行、汉字按拼音、数字、其他；跳过开头的符号', () => {
    const g = (t, p = pinyin) => Index.groupOf(t, p);
    assert.equal(g('Blue Bird'), 'B');
    assert.equal(g('アイドル'), 'あ');
    assert.equal(g('ぎんいろ'), 'か');
    assert.equal(g('晴天'), 'Q');
    assert.equal(g('晴天', null), '#');
    assert.equal(g('「夜曲」'), 'Y');
    assert.equal(g('1989'), '0-9');
    assert.equal(g('★'), '#');
    assert.equal(Index.groupName('あ'), 'あ行');
});

test('groupColumns 按固定顺序排组，组内按拼音排', () => {
    const idx = Index.createIndex(TRACKS, { pinyin });
    const cols = Index.groupColumns(idx, TRACKS.map((_, i) => i));
    assert.deepEqual(cols.map((c) => c.group), ['B', 'H', 'Q', 'Y', 'あ', '0-9']);
    assert.equal(cols[0].id, 'letter:B');
    assert.equal(cols[4].name, 'あ行');
});

test('listRows：全部按字母分组；有检索词时只有一组结果', () => {
    const index = Index.createIndex(TRACKS, { pinyin });
    const all = Index.listRows({ tracks: TRACKS, index });
    assert.equal(all.count, 6);
    assert.deepEqual(all.rows.filter((r) => r.type === 'head').map((r) => r.label), ['B', 'H', 'Q', 'Y', 'あ行', '0–9']);
    const hit = Index.listRows({ tracks: TRACKS, index, query: 'zjl' });
    assert.equal(hit.rows[0].label, '检索结果');
    assert.equal(hit.count, 2);
});

test('listRows：歌手、专辑、歌单、最近', () => {
    const index = Index.createIndex(TRACKS, { pinyin });
    const artist = Index.listRows({ tracks: TRACKS, index, kind: 'artist' });
    assert.equal(artist.rows.find((r) => r.type === 'head' && r.label === '周杰伦').n, 2);
    const album = Index.listRows({ tracks: TRACKS, index, kind: 'album' });
    assert.ok(album.rows.some((r) => r.type === 'head' && r.label === '未知专辑'));
    assert.equal(album.rows.find((r) => r.type === 'track' && r.i === 4).ctx, 'album:1989');
    const playlists = [{ id: 7, name: '通勤', tracks: ['\\B', '/x', '/C'] }];
    const pl = Index.listRows({ tracks: TRACKS, index, kind: 'playlist', playlists });
    assert.deepEqual(pl.rows.filter((r) => r.type === 'track').map((r) => [r.i, r.ctx]), [[1, 'playlist:7'], [2, 'playlist:7']]);
    assert.equal(Index.listRows({ tracks: TRACKS, index, kind: 'playlist', playlists, query: '通勤' }).count, 2); // 歌单名命中保留整张
    const recent = Index.listRows({ tracks: TRACKS, index, kind: 'recent', recent: [5, 99, 0] });
    assert.deepEqual(recent.rows.filter((r) => r.type === 'track').map((r) => r.i), [5, 0]);
});

test('几千首也能即时检索', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ title: (i % 2 ? '晴天' : 'Song ') + i, artist: '周杰伦', album: 'A' + (i % 40) }));
    const index = Index.createIndex(many, { pinyin });
    // 全量并行跑测试时机器负载高：取 20 次里最快的一次，阈值留出 3 倍余量
    let ms = Infinity;
    for (let k = 0; k < 20; k++) {
        const t0 = process.hrtime.bigint();
        index.query('qt 12');
        ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    assert.ok(ms < 90, `一次检索 ${ms.toFixed(1)} ms`);
});

test('groupColumns 合并歌少的相邻字母，只在同一类里合并', () => {
    const titles = ['Apple', 'Avocado', 'Banana', 'Xylo', 'Zeta', 'Yak', 'あい', 'かき', '1999', '★'];
    const t = titles.map((title) => ({ title }));
    const idx = Index.createIndex(t);
    const cols = Index.groupColumns(idx, t.map((_, i) => i), { minSize: 2 });
    assert.deepEqual(cols.map((c) => [c.id, c.name]), [
        ['letter:A', 'A'], ['letter:B-X', 'B–X'], ['letter:Y-Z', 'Y–Z'], ['letter:あ-か', 'あ–か行'], ['letter:0-9', '0–9'], ['letter:#', '其他']
    ]);
    assert.deepEqual(cols[1].groups, ['B', 'X']);
});

test('组内按数值自然排序', () => {
    const t = ['Song 10', 'Song 2', 'Song 1'].map((title) => ({ title }));
    const idx = Index.createIndex(t);
    assert.deepEqual(Index.groupColumns(idx, [0, 1, 2])[0].items, [2, 1, 0]);
});

test('排序方式：歌手按歌手首字母分组、时长按时长段、添加时间新的在前', () => {
    const tracks = TRACKS.map((t, i) => ({ ...t, duration: [200, 0, 260, 150, 500, 230][i] }));
    const idx = Index.createIndex(tracks, { pinyin });
    const all = tracks.map((_, i) => i);
    const byArtist = Index.groupColumns(idx, all, { spec: Index.sortSpec(idx, { mode: 'artist', tracks }) });
    assert.deepEqual(byArtist.map((c) => c.id), ['sort-artist:A', 'sort-artist:T', 'sort-artist:Y', 'sort-artist:Z', 'sort-artist:あ']);
    assert.deepEqual(byArtist.find((c) => c.id === 'sort-artist:Z').items, [0, 5]); // 同一歌手内按标题拼音：qingtian 在 yequ 前
    const byLen = Index.sortSpec(idx, { mode: 'duration', tracks, durationOf: () => 0 });
    const cols = Index.groupColumns(idx, all, { spec: byLen });
    assert.deepEqual(cols.map((c) => c.name), ['3 分钟以内', '3–4 分钟', '4–5 分钟', '7 分钟以上', '时长未知']);
    assert.deepEqual(Index.sortedIndices(idx, all, byLen), [3, 0, 5, 2, 4, 1]);
    const added = Index.sortedIndices(idx, all, Index.sortSpec(idx, { mode: 'added', tracks }));
    assert.deepEqual(added, [5, 4, 3, 2, 1, 0]);
    const rows = Index.listRows({ tracks, index: idx, spec: byLen });
    assert.deepEqual(rows.rows.filter((r) => r.type === 'head').map((r) => r.key), ['sort:d0', 'sort:d3', 'sort:d4', 'sort:d7', 'sort:d?']);
    assert.deepEqual(Index.SORTS, ['title', 'artist', 'duration', 'added']);
});

test('分片排名次和一次排完结果一样；曲库多了几首时沿用上次的顺序，结果也一样', () => {
    const mk = (n, extra = []) => Array.from({ length: n }, (_, i) => ({ path: '/r/' + i, title: ['潮汐', 'Blue', '夏日', 'アイドル', '10 号', '2 号'][i % 6] + ' ' + ((i * 7919) % 1000), artist: ['Ren', '周杰伦', '', 'YOASOBI'][i % 4] })).concat(extra);
    const order = (index, mode) => Index.sortedIndices(index, Array.from({ length: index.size }, (_, i) => i), Index.sortSpec(index, { mode }));
    const tracks = mk(3000);
    const whole = Index.createIndex(tracks);
    const cache = new Map();
    let at = 0, slices = 0;
    while (at !== -1) { at = Index.warm(tracks, { cache, from: at, budgetMs: 1 }); slices++; }
    assert.ok(slices > 1, '预热分了多片');
    const sliced = Index.createIndex(tracks, { cache });
    for (const mode of ['title', 'artist']) {
        const step = Index.prepareSort(sliced, mode);
        let steps = 0;
        while (!step(0.2)) { steps++; assert.ok(steps < 5000); }
        assert.deepEqual(order(sliced, mode), order(whole, mode), mode);
    }
    // 多了几首：新索引里的旧条目是同一批对象，名次靠归并得到
    const more = mk(3000, [{ path: '/r/new1', title: 'Blue 0', artist: 'Aki' }, { path: '/r/new2', title: '阿', artist: '' }]);
    const next = Index.createIndex(more, { cache });
    const fresh = Index.createIndex(more);
    for (const mode of ['title', 'artist']) assert.deepEqual(order(next, mode), order(fresh, mode), mode);
    assert.equal(cache.size, 3002);
});

test('ASCII 快路径与单字拼音缓存保持结果一致并避免重复计算', () => {
    let calls = 0;
    const countingPinyin = (c) => { calls += 1; return PY[c] || ''; };
    const repeated = Array.from({ length: 40 }, (_, i) => ({
        path: '/p/' + i,
        title: i % 2 ? '晴天 - Remix (2024)' : 'Blue_Bird! 0' + i,
        artist: i % 2 ? '周杰伦' : 'Aimer'
    }));
    const idx = Index.createIndex(repeated, { pinyin: countingPinyin });
    assert.equal(idx.query('qt').length, 20);
    assert.equal(idx.query('bb').length, 20);
    assert.equal(idx.query('zjl').length, 20);
    assert.equal(Index.groupOf('Blue_Bird! 01', countingPinyin), 'B');
    assert.equal(Index.groupOf('晴天 - Remix (2024)', countingPinyin), 'Q');
    // 只有 5 个不重复汉字（晴天周杰伦），缓存应使 pinyin 调用次数远低于 20 * 5 = 100
    assert.ok(calls <= 10, `expected <= 10 pinyin calls with cache, got ${calls}`);
});

test('CJK 快路径与重复歌手/专辑缓存保留全角、片假名与代理对的检索准确性', () => {
    const tracks = [
        { path: '/1', title: '晴天 🎵', artist: '周杰伦', album: '叶惠美' },
        { path: '/2', title: '夜曲', artist: '周杰伦', album: '叶惠美' },
        { path: '/3', title: 'ＦＵＬＬＷＩＤＴＨ カタカナ', artist: 'ＡＲＴＩＳＴ', album: 'ＡＬＢＵＭ' },
        { path: '/4', title: 'ひらがな曲', artist: '周杰伦', album: '叶惠美' }
    ];
    const idx = Index.createIndex(tracks, { pinyin });
    assert.deepEqual(idx.query('qt'), [0]);
    assert.deepEqual(idx.query('zjl').sort(), [0, 1, 3]);
    assert.deepEqual(idx.query('fullwidth'), [2]);
    assert.deepEqual(idx.query('かたかな'), [2]);
    assert.deepEqual(idx.query('artist'), [2]);
    assert.deepEqual(idx.query('album'), [2]);
    assert.deepEqual(idx.query('ひらがな'), [3]);
    assert.equal(idx.entry(0).artistGroup, 'Z');
    assert.equal(idx.entry(1).artistGroup, 'Z');
    assert.equal(idx.entry(0).album, idx.entry(1).album);
});

test('Batch 55: listRows hoists albumCompare across albums, handles empty fields, and prunes stale cache entries', () => {
    const TrackOrder = require('../Musicmodules/music-track-order.js');
    const origOrder = globalThis.MusicTrackOrder;
    let compareBuilds = 0;
    globalThis.MusicTrackOrder = {
        ...TrackOrder,
        albumCompare(tracks, fallback) {
            compareBuilds += 1;
            return TrackOrder.albumCompare(tracks, fallback);
        }
    };
    try {
        const tracks = [
            { path: '/a/02.flac', title: 'B', artist: '', album: 'Alb1', trackNo: 2 },
            { path: '/a/01.flac', title: 'A', artist: 'X', album: 'Alb1', trackNo: 1 },
            { path: '/b/02.flac', title: 'D', artist: 'Y', album: 'Alb2', trackNo: 2 },
            { path: '/b/01.flac', title: 'C', artist: 'Y', album: 'Alb2', trackNo: 1 },
            { path: '/c/01.flac', title: 'E', artist: '', album: 'Alb3', trackNo: 1 }
        ];
        const cache = new Map();
        for (let i = 0; i < 80; i++) cache.set('/stale/' + i, { pinyin, title: 'x', artist: '', album: '', e: {} });
        const idx = Index.createIndex(tracks, { pinyin, cache });
        assert.equal(cache.size, tracks.length, 'stale cache entries removed when cache exceeds list.length + 64');
        assert.deepEqual(idx.query('x', { kind: 'artist' }), [1], 'empty artist fields short-circuit without false matches');

        const { rows } = Index.listRows({ tracks, index: idx, kind: 'album' });
        assert.equal(compareBuilds, 1, 'albumCompare constructed once for all albums instead of once per album');
        const trackOrder = rows.filter((r) => r.type === 'track').map((r) => r.i);
        assert.deepEqual(trackOrder, [1, 0, 3, 2, 4], 'multi-album disc/track ordering preserved');

        // Also verify albumCompare handles out-of-range indices gracefully
        const cmp = TrackOrder.albumCompare(tracks, (a, b) => a - b);
        assert.equal(typeof cmp(0, 99), 'number');
    } finally {
        globalThis.MusicTrackOrder = origOrder;
    }
});

test('Batch 59: artist pre-ranked sort preserves Collator numeric tie order and empty-artist placement', () => {
    const tracks = [
        { path: '/1', title: 'Zeta', artist: 'Artist 01' },
        { path: '/2', title: 'Alpha', artist: 'Artist 1' },
        { path: '/3', title: 'Beta', artist: '' },
        { path: '/4', title: 'Gamma', artist: 'Artist 2' },
        { path: '/5', title: 'Delta', artist: 'Artist 10' },
        { path: '/6', title: 'Aa', artist: '' },
        { path: '/7', title: 'Mid', artist: 'Artist 001' }
    ];
    const idx = Index.createIndex(tracks, { pinyin });
    const all = tracks.map((_, i) => i);
    const sorted = Index.sortedIndices(idx, all, Index.sortSpec(idx, { mode: 'artist' }));
    const collate = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }).compare;
    const titleRank = new Int32Array(tracks.length);
    const byTitle = Index.sortedIndices(idx, all, Index.sortSpec(idx, { mode: 'title' }));
    for (let p = 0; p < byTitle.length; p++) titleRank[byTitle[p]] = p;
    const expected = all.slice().sort((a, b) => {
        const ea = idx.entry(a).artistSort;
        const eb = idx.entry(b).artistSort;
        if (!ea && eb) return 1;
        if (ea && !eb) return -1;
        return collate(ea, eb) || (titleRank[a] - titleRank[b]);
    });
    assert.deepEqual(sorted, expected, 'pre-ranked artist sort must match reference Collator exact total order including numeric ties');
    assert.deepEqual(sorted.slice(-2), [5, 2], 'empty artist tracks sort last ordered by title');
});

test('Batch 61: bucketed 1-4 term query preserves exact score & order with limit/only, 5-term fallback works, and archive.css hides classic layout', () => {
    const tracks = [
        { path: '/0', title: 'Alpha Beta Gamma Delta Echo', artist: 'Band X', album: 'Disk 1' },
        { path: '/1', title: 'X Alpha', artist: 'Alpha Singer', album: 'Alpha Album' },
        { path: '/2', title: 'Alpha One', artist: 'Band Y', album: 'Disk 2' },
        { path: '/3', title: 'Alpha Two', artist: 'Band Z', album: 'Disk 3' },
        { path: '/4', title: 'Other', artist: 'Alpha Prefix', album: 'Disk 4' },
        { path: '/5', title: 'Alpha Beta Gamma Delta Echo Foxtrot', artist: 'Band W', album: 'Disk 5' }
    ];
    const idx = Index.createIndex(tracks);

    // 1-term query: title startsWith (300) > artist startsWith (200) > title includes (180), stable tie order
    assert.deepEqual(idx.query('alpha'), [0, 2, 3, 5, 1, 4]);
    assert.deepEqual(idx.query('alpha', { limit: 3 }), [0, 2, 3]);
    assert.deepEqual(idx.query('alpha', { limit: 0 }), []);
    assert.deepEqual(idx.query('alpha', { only: [4, 3, 1, 2], limit: 3 }), [3, 2, 4]);

    // 5-term fallback (> 4 terms)
    assert.deepEqual(idx.query('alpha beta gamma delta echo'), [0, 5]);
    assert.deepEqual(idx.query('alpha beta gamma delta echo', { limit: 1 }), [0]);

    // archive.css hides .music-player-container from layout via content-visibility: hidden
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'Musicmodules/music-archive/archive.css'), 'utf8');
    assert.match(css, /body\.music-archive-on\s+\.music-player-container[\s\S]*?content-visibility:\s*hidden/);
});

test('Batch 65: monomorphic scorer parity, incremental narrowing cache, and MusicTrackOrder fast paths', () => {
    const TrackOrder = require('../Musicmodules/music-track-order.js');
    // 1. Score precedence: ini.startsWith (40*w) beats py.includes (30*w), title prefix beats artist/album, multi-term incremental narrowing matches fresh index
    const pyMap = {
        晴: 'qíng', 天: 'tiān', 海: 'hǎi', 风: 'fēng', 周: 'zhōu', 杰: 'jié', 伦: 'lún',
        夜: 'yè', 曲: 'qǔ', 爱: 'ài', 情: 'qíng', 歌: 'gē', 青: 'qīng', 春: 'chūn'
    };
    const pyFn = (c) => pyMap[c] || '';
    const tracks = [
        { path: '/0', title: '爱情歌', artist: 'Artist 10', album: 'Album A' },   // py='aiqingge', ini='aqg' -> 'qg' matches py.includes (30*3=90) vs ini.includes (22*3=66)
        { path: '/1', title: '晴天', artist: 'Artist 1', album: 'Album B' },      // py='qingtian', ini='qt'
        { path: '/2', title: '青春歌', artist: 'Artist 12', album: 'Album C' },   // py='qingchunge', ini='qcg'
        { path: '/3', title: '海风', artist: '周杰伦', album: '晴天集' },
        { path: '/4', title: 'Blue Sky', artist: 'Artist 1', album: 'Live 2024' },
        { path: '/5', title: 'Blue Rain', artist: 'Artist 2', album: 'Studio' },
        { path: '/6', title: 'Artist 1 Theme', artist: 'Composer', album: 'OST' }
    ];
    const idx = Index.createIndex(tracks, { pinyin: pyFn });
    const fresh = () => Index.createIndex(tracks, { pinyin: pyFn });

    // 'qt' hits title ini.startsWith (40*3=120) on track 1 ahead of album ini.startsWith (40*1=40) on track 3
    assert.deepEqual(idx.query('qt'), [1, 3]);
    // Sequential incremental typing + backspacing + kind switch + empty narrowing must match fresh index 100%
    const seq = [
        ['a', 'all'],
        ['ar', 'all'],
        ['artist', 'all'],
        ['artist 1', 'all'],
        ['artist 12', 'all'],
        ['artist 1', 'all'],
        ['artist', 'artist'],
        ['artist 1', 'artist'],
        ['artist 1', 'album'],
        ['zzz', 'all'],
        ['zzzz', 'all'],
        ['b', 'all'],
        ['bl', 'all'],
        ['blue s', 'all']
    ];
    for (const [q, kind] of seq) {
        assert.deepEqual(idx.query(q, { kind }), fresh().query(q, { kind }), `query("${q}", ${kind}) matches fresh index`);
    }
    // limit on narrowed query still caches full match list for further narrowing
    const idxLim = Index.createIndex(tracks, { pinyin: pyFn });
    assert.deepEqual(idxLim.query('artist', { limit: 2 }), fresh().query('artist', { limit: 2 }));
    assert.deepEqual(idxLim.query('artist 12'), fresh().query('artist 12'), 'narrowing after limited query does not lose matches beyond prior limit');

    // 2. MusicTrackOrder: shared frozen EMPTY_ORDER, fast-skip non-numbered names, URL-encoded/prefix names, CD parent disc, >64 sparse cache
    const emptyA = TrackOrder.numberOf({ path: '/music/Artist/Album/Blue Sky.flac' });
    const emptyB = TrackOrder.numberOf({ path: '/music/Artist/Album/Zeta Song.mp3' });
    assert.equal(emptyA, emptyB, 'unnumbered tracks share frozen EMPTY_ORDER singleton');
    assert.equal(Object.isFrozen(emptyA), true);
    assert.deepEqual(emptyA, { disc: 0, no: 0 });
    assert.deepEqual(TrackOrder.numberOf({ path: '/alb/CD2/Track%2007.flac' }), { disc: 2, no: 7 });
    assert.deepEqual(TrackOrder.numberOf({ path: '/alb/Disc 3/曲目 05.wav' }), { disc: 3, no: 5 });
    assert.deepEqual(TrackOrder.numberOf({ path: '/alb/トラック 11.flac' }), { disc: 0, no: 11 });
    assert.deepEqual(TrackOrder.numberOf({ path: '/alb/2024 Live.flac' }), { disc: 0, no: 0 }, '4-digit year is not a track number');
    assert.deepEqual(TrackOrder.numberOf({ path: '/alb/2-04 Finale.flac' }), { disc: 2, no: 4 });

    // >64 tracks uses sparse Map in albumCompare and sorts disc/track numbers accurately
    const big = Array.from({ length: 80 }, (_, i) => ({
        path: i < 40 ? `/m/CD1/${String(40 - i).padStart(2, '0')} Song.flac` : `/m/Album/NoNum ${i}.flac`,
        title: `T${i}`
    }));
    const cmp = TrackOrder.albumCompare(big, (a, b) => a - b);
    const ordered = big.map((_, i) => i).sort(cmp);
    assert.equal(ordered[0], 39, '01 Song comes first');
    assert.equal(ordered[39], 0, '40 Song comes 40th');
    assert.deepEqual(ordered.slice(40), Array.from({ length: 40 }, (_, i) => 40 + i), 'unnumbered tracks stay after numbered in fallback order');
});

test('Batch 68: sortSpec caches Uint32Array order for title/artist and groupColumns/listRows preserve exact order without re-sorting single-group buckets', () => {
    const tracks = [
        { path: '/0', title: 'Zebra 10', artist: 'Singer B' },
        { path: '/1', title: 'Zebra 2', artist: 'Singer A' },
        { path: '/2', title: 'Alpha 12', artist: 'Singer B' },
        { path: '/3', title: 'Alpha 2', artist: 'Singer A' },
        { path: '/4', title: 'Alpha 1', artist: '' },
        { path: '/5', title: 'Beta', artist: 'Singer A' },
        { path: '/6', title: 'Gamma', artist: 'Singer C' }
    ];
    const all = tracks.map((_, i) => i);

    // 1. Direct sortSpec path populates order Uint32Array and matches reference comparator order
    const idx1 = Index.createIndex(tracks);
    for (const mode of ['title', 'artist']) {
        const sp = Index.sortSpec(idx1, { mode, tracks });
        assert.ok(sp.order instanceof Uint32Array && sp.order.length === tracks.length, `${mode} sortSpec caches packed order`);
        const colsSingle = Index.groupColumns(idx1, all, { minSize: 1, spec: sp });
        const colsMerged = Index.groupColumns(idx1, all, { minSize: 3, spec: sp });
        const rowsAll = Index.listRows({ tracks, index: idx1, kind: 'all', spec: sp });
        const rowsArtist = Index.listRows({ tracks, index: idx1, kind: 'artist', spec: sp });

        // Compare against manual spec without order fast-path
        const noOrderSp = { ...sp, order: null };
        assert.deepEqual(colsSingle, Index.groupColumns(idx1, all, { minSize: 1, spec: noOrderSp }), `${mode} minSize=1 matches reference`);
        assert.deepEqual(colsMerged, Index.groupColumns(idx1, all, { minSize: 3, spec: noOrderSp }), `${mode} minSize=3 merged matches reference`);
        assert.deepEqual(rowsAll, Index.listRows({ tracks, index: idx1, kind: 'all', spec: noOrderSp }), `${mode} listRows(all) matches reference`);
        assert.deepEqual(rowsArtist, Index.listRows({ tracks, index: idx1, kind: 'artist', spec: noOrderSp }), `${mode} listRows(artist) matches reference`);
    }

    // 2. Chunked prepareSort path also populates cached order identically
    const idx2 = Index.createIndex(tracks);
    const step = Index.prepareSort(idx2, 'artist');
    while (!step(50)) { /* drain */ }
    const spArtist2 = Index.sortSpec(idx2, { mode: 'artist', tracks });
    assert.ok(spArtist2.order instanceof Uint32Array && spArtist2.order.length === tracks.length, 'prepareSort populates artistOrder');
    assert.deepEqual([...spArtist2.order], [...Index.sortSpec(idx1, { mode: 'artist', tracks }).order]);
});

test('Batch 82: sortSpec lazily builds title/artist comparators so cached calls skip buildArtistKeyRanks', () => {
    const tracks = Array.from({ length: 120 }, (_, i) => ({
        path: `/m/${i}.flac`,
        title: `Track ${120 - i}`,
        artist: `Artist ${i % 20}`
    }));
    const idx = Index.createIndex(tracks);
    let artistKeyReads = 0;
    const origArtistKey = idx.artistKey;
    idx.artistKey = (i) => { artistKeyReads += 1; return origArtistKey(i); };

    const sp1 = Index.sortSpec(idx, { mode: 'artist', tracks });
    assert.equal(artistKeyReads, tracks.length, 'first artist sortSpec scans artistKey once');

    artistKeyReads = 0;
    const sp2 = Index.sortSpec(idx, { mode: 'artist', tracks });
    const sp3 = Index.sortSpec(idx, { mode: 'artist', tracks });
    assert.equal(artistKeyReads, 0, 'cached artist sortSpec skips buildArtistKeyRanks completely');
    assert.equal(sp2.order, sp1.order);
    assert.equal(sp3.order, sp1.order);
});

test('Batch 91: >64-track query artist/album score cache matches reference, packed albumCompare handles all disc/no cases, and listRows skips unnumbered album sorts', () => {
    const TrackOrder = require('../Musicmodules/music-track-order.js');
    // 1. >64 tracks with repeated artists/albums: cached artist/album scoring matches small-pool reference
    const tracks = Array.from({ length: 180 }, (_, i) => ({
        path: `/m/a${i % 15}/t${i}.flac`,
        title: `曲目 ${i + 1}${i % 9 === 0 ? ' Live' : ''}`,
        artist: `Artist ${i % 12}`,
        album: `Album ${i % 20}`
    }));
    const idxBig = Index.createIndex(tracks);
    for (const [q, kind] of [
        ['artist 1', 'artist'],
        ['artist 1', 'all'],
        ['album 1 live', 'all'],
        ['album 12', 'album'],
        ['a', 'all'],
        ['artist 10 1', 'all']
    ]) {
        const cached = idxBig.query(q, { kind });
        // Compare against small-slice reference by querying with only<=64 chunks or direct scoring check
        const refAll = idxBig.query(q, { kind, only: tracks.map((_, i) => i) });
        assert.ok(cached.length > 0 || q === 'artist 10 1');
        // Verify exact match against a fresh index queried on 60-item subsets merged? Simpler: check every returned id matches!
        assert.deepEqual(cached, refAll, `query("${q}", ${kind}) with cache matches only-list scan`);
    }

    // 2. Packed Int32Array albumCompare handles numbered vs unnumbered, disc-only unnumbered, and fallback tie-break
    const ordTracks = [
        { path: '/alb/CD2/Zeta.flac', title: 'Zeta' },           // disc=2, no=0
        { path: '/alb/CD1/Beta.flac', title: 'Beta' },           // disc=1, no=0
        { path: '/alb/CD1/Alpha.flac', title: 'Alpha' },         // disc=1, no=0
        { path: '/alb/CD2/01 Intro.flac', title: 'Intro' },      // disc=2, no=1
        { path: '/alb/CD1/02 Second.flac', title: 'Second' },    // disc=1, no=2
        { path: '/alb/CD1/01 First.flac', title: 'First' }       // disc=1, no=1
    ];
    const cmp = TrackOrder.albumCompare(ordTracks, (a, b) => ordTracks[a].title.localeCompare(ordTracks[b].title));
    const sortedIds = ordTracks.map((_, i) => i).sort(cmp);
    assert.deepEqual(sortedIds, [5, 4, 3, 2, 1, 0], 'numbered (disc then track) precede unnumbered (disc then fallback)');

    // 3. listRows(album) with sp.order skips albumCompare entirely when no album has disc/track numbers,
    //    and accurately sorts albums that have disc-only or track-numbered entries
    const plainTracks = Array.from({ length: 40 }, (_, i) => ({
        path: `/plain/a${i % 4}/song_${40 - i}.flac`,
        title: `Song ${40 - i}`,
        artist: 'Art',
        album: `Plain ${i % 4}`
    }));
    const idxPlain = Index.createIndex(plainTracks);
    const spPlain = Index.sortSpec(idxPlain, { mode: 'title', tracks: plainTracks });
    const origAlbumCmp = global.MusicTrackOrder.albumCompare;
    let albumCmpCalls = 0;
    global.MusicTrackOrder.albumCompare = (...args) => { albumCmpCalls += 1; return origAlbumCmp(...args); };
    try {
        const resPlain = Index.listRows({ tracks: plainTracks, index: idxPlain, kind: 'album', spec: spPlain });
        assert.equal(albumCmpCalls, 0, 'unnumbered albums skip albumCompare when sp.order is present');
        const refPlain = Index.listRows({ tracks: plainTracks, index: idxPlain, kind: 'album', spec: { ...spPlain, order: null } });
        assert.deepEqual(resPlain, refPlain, 'unnumbered album rows match reference exactly');
    } finally {
        global.MusicTrackOrder.albumCompare = origAlbumCmp;
    }

    const mixedTracks = ordTracks.map((t) => ({ ...t, artist: 'Art', album: 'Mixed' }));
    const idxMixed = Index.createIndex(mixedTracks);
    const spMixed = Index.sortSpec(idxMixed, { mode: 'title', tracks: mixedTracks });
    const resMixed = Index.listRows({ tracks: mixedTracks, index: idxMixed, kind: 'album', spec: spMixed });
    const refMixed = Index.listRows({ tracks: mixedTracks, index: idxMixed, kind: 'album', spec: { ...spMixed, order: null } });
    assert.deepEqual(resMixed, refMixed, 'mixed disc/track album rows match reference exactly');
});

test('Batch 106: O(N) counting-sort artistRankOf matches exact Collator+titleRank order including numeric ties and empty artists', () => {
    const tracks = [
        { path: '/0', title: 'Track 10', artist: 'Singer 2' },
        { path: '/1', title: 'Track 2', artist: 'Singer 10' },
        { path: '/2', title: 'Track 1', artist: '' },
        { path: '/3', title: 'Track 3', artist: 'singer 2' },
        { path: '/4', title: 'Track 2', artist: 'Singer 2' },
        { path: '/5', title: 'Alpha', artist: '' },
        { path: '/6', title: 'Beta', artist: 'Singer 1' }
    ];
    const idx = Index.createIndex(tracks);
    const spTitle = Index.sortSpec(idx, { mode: 'title', tracks });
    const spArtist = Index.sortSpec(idx, { mode: 'artist', tracks });
    // Expected: Singer 1 (6), then Singer 2 / singer 2 ties ordered by titleRank (4: Track 2, 3: Track 3, 0: Track 10),
    // then Singer 10 (1), then empty artists ordered by titleRank (5: Alpha, 2: Track 1).
    assert.deepEqual([...spArtist.order], [6, 4, 3, 0, 1, 5, 2], 'artist counting sort matches exact Collator + titleRank tie-break');
    for (let k = 0; k < spArtist.order.length - 1; k += 1) {
        assert.ok(spArtist.cmp(spArtist.order[k], spArtist.order[k + 1]) < 0, 'artist cmp strictly agrees with packed order');
    }
    // prepareSort('artist') produces identical order
    const idx2 = Index.createIndex(tracks);
    const step = Index.prepareSort(idx2, 'artist');
    while (!step(50)) { /* drain */ }
    assert.deepEqual([...Index.sortSpec(idx2, { mode: 'artist', tracks }).order], [...spArtist.order]);
    // familyOf Latin / Kana / other
    assert.equal(spTitle.family('A'), 'latin');
    assert.equal(spTitle.family('Z'), 'latin');
    assert.equal(spTitle.family('あ'), 'kana');
    assert.equal(spTitle.family('#'), '#');
});
