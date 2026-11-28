const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 智能歌单：检索框里的条件词（喜欢、没听过、常听、次数>N、>N分钟）和普通检索词混用；存下来的歌单跟着听歌记录变。
const Smart = require(path.join(__dirname, '../Musicmodules/music-smart.js'));

const lib = [
    { path: '/a', title: 'Lemon', artist: 'Aki', album: 'X', duration: 200 },
    { path: '/b', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 },
    { path: '/c', title: '稻香', artist: '周杰伦', album: '魔杰座', duration: 223 },
    { path: '/d', title: 'Long', artist: 'Ren', album: 'Y', duration: 420 }
];
const plays = { '/a': 12, '/b': 1 };
const ctx = { stats: { get: (t) => (plays[t.path] ? { plays: plays[t.path], last: Date.now() } : null) }, isLiked: (t) => t.path === '/c' || t.path === '/a' };

test('parse splits rule words from text', () => {
    const p = Smart.parse('喜欢 周杰伦 >5分钟 次数＞3');
    assert.deepEqual(p.preds.map((x) => x.word), ['喜欢', '>5分钟', '次数>3']);
    assert.equal(p.text, '周杰伦');
});

test('evaluate combines rules and text', () => {
    const paths = (q) => Smart.evaluate(lib, q, ctx).map((t) => t.path);
    assert.deepEqual(paths('喜欢 周杰伦'), ['/c']);
    assert.deepEqual(paths('没听过'), ['/c', '/d']);
    assert.deepEqual(paths('常听'), ['/a']);
    assert.deepEqual(paths('>5分钟'), ['/d']);
    assert.deepEqual(paths('<4分钟 喜欢'), ['/a', '/c']);
});

test('smart playlists refresh when play counts change', async () => {
    globalThis.document = { addEventListener() {} };
    const app = { playlist: lib, customPlaylists: [], musicStats: ctx.stats, isLiked: ctx.isLiked, saveCustomPlaylists() {} };
    const timers = [];
    const realSet = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { timers.push(fn); return 1; };
    try {
        Smart.setupMusicSmart(app);
        const pl = app.createSmartPlaylist('常听');
        assert.deepEqual(pl.tracks, ['/a']);
        assert.equal(pl.smart.query, '常听');
        plays['/d'] = 7;
        assert.equal(app.refreshSmartPlaylists(), true);
        assert.deepEqual(pl.tracks, ['/a', '/d']);
        assert.equal(app.refreshSmartPlaylists(), false);
    } finally { globalThis.setTimeout = realSet; delete plays['/d']; }
});

test('Batch 67: fast-path parse handles single-word plain text, single-word rules, case-insensitive aliases and full-width comparisons', () => {
    const plain = Smart.parse('  Live  ');
    assert.deepEqual(plain, { preds: [], text: 'Live' });
    assert.equal(Smart.hasRules('Live'), false);

    const liked = Smart.parse('LIKED');
    assert.equal(liked.text, '');
    assert.deepEqual(liked.preds.map((p) => p.word), ['喜欢']);
    assert.equal(Smart.hasRules('LIKED'), true);

    const cmpSingle = Smart.parse('次数＞=10');
    assert.equal(cmpSingle.text, '');
    assert.deepEqual(cmpSingle.preds.map((p) => p.word), ['次数>=10']);
    assert.deepEqual(Smart.evaluate(lib, 'PLAYS>=12', ctx).map((t) => t.path), ['/a']);

    const mixed = Smart.parse('UNPLAYED  <4.5min   周杰伦  FORGOTTEN');
    assert.equal(mixed.text, '周杰伦');
    assert.deepEqual(mixed.preds.map((p) => p.word), ['没听过', '<4.5分钟', '很久没听']);
});

test('Batch 94: smart evaluate skips NFKC on ASCII/CJK/hiragana tracks while normalizing full-width chars and keeps pl.tracks stable when unchanged', () => {
    let normCalls = 0;
    const origNorm = String.prototype.normalize;
    String.prototype.normalize = function trackedNormalize(...args) {
        normCalls += 1;
        return origNorm.apply(this, args);
    };
    try {
        const plainLib = [
            { path: '/1', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269 },
            { path: '/2', title: 'あいう', artist: 'Aki', album: 'Album', duration: 200 }
        ];
        assert.deepEqual(Smart.evaluate(plainLib, '周杰伦', {}).map((t) => t.path), ['/1']);
        assert.deepEqual(Smart.evaluate(plainLib, 'あいう', {}).map((t) => t.path), ['/2']);
        assert.equal(normCalls, 0, 'ASCII/CJK/hiragana tracks bypass ICU normalize(NFKC)');

        const fwLib = [{ path: '/3', title: 'ＬＥＭＯＮ', artist: 'Test', album: '', duration: 200 }];
        assert.deepEqual(Smart.evaluate(fwLib, 'lemon', {}).map((t) => t.path), ['/3']);
        assert.ok(normCalls > 0, 'full-width compatibility characters still normalize via NFKC');
    } finally {
        String.prototype.normalize = origNorm;
    }

    globalThis.document = { addEventListener() {} };
    const app = { playlist: lib, customPlaylists: [], musicStats: ctx.stats, isLiked: ctx.isLiked, saveCustomPlaylists() {} };
    Smart.setupMusicSmart(app);
    const pl = app.createSmartPlaylist('常听');
    const firstTracksRef = pl.tracks;
    assert.equal(app.refreshSmartPlaylists(), false);
    assert.equal(pl.tracks, firstTracksRef, 'unchanged smart playlist keeps existing tracks array reference');
});
