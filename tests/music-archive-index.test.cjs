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
