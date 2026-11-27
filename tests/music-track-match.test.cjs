const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findTrack } = require('../modules/musicTrackMatch');

const lib = [
    { path: 'D:\\M\\lemon tree.mp3', title: 'Lemon Tree', artist: 'Fools Garden' },
    { path: 'D:\\M\\a.flac', title: 'Intro', artist: 'Lemon Lovers' },
    { path: 'D:\\M\\lemon.flac', title: 'Lemon', artist: '米津玄師', album: 'STRAY SHEEP' },
    { path: 'D:\\M\\qt.flac', title: '晴天', artist: '周杰伦' },
    { path: 'D:\\M\\qt2.flac', title: '晴天', artist: '翻唱者' },
    { path: 'D:\\M\\星の余韻.flac', title: '星の余韻.flac', artist: 'X' },
    { path: 'D:\\M\\untitled.mp3', artist: 'Nobody' },
    { path: 'D:\\M\\my.mp3', title: '我的歌声里', artist: '曲婉婷' }
];
const pick = (q) => findTrack(lib, q)?.path;

test('an exact title beats an earlier partial match', () => {
    assert.equal(pick('Lemon'), 'D:\\M\\lemon.flac');
    assert.equal(pick('lemon tree'), 'D:\\M\\lemon tree.mp3');
});
test('"title - artist" and "artist 的 title" pick that artist', () => {
    assert.equal(pick('晴天 - 翻唱者'), 'D:\\M\\qt2.flac');
    assert.equal(pick('翻唱者的晴天'), 'D:\\M\\qt2.flac');
    assert.equal(pick('Lemon by 米津玄師'), 'D:\\M\\lemon.flac');
});
test('file extensions, width and spacing do not matter', () => {
    assert.equal(pick('星の余韻'), 'D:\\M\\星の余韻.flac');
    assert.equal(pick('ＬＥＭＯＮ'), 'D:\\M\\lemon.flac');
    assert.equal(pick('untitled'), 'D:\\M\\untitled.mp3');
});
test('titles containing 的 still match exactly', () => {
    assert.equal(pick('我的歌声里'), 'D:\\M\\my.mp3');
});
test('artist and album are fallbacks; nothing found is null', () => {
    assert.equal(pick('fools garden'), 'D:\\M\\lemon tree.mp3');
    assert.equal(pick('stray sheep'), 'D:\\M\\lemon.flac');
    assert.equal(pick('不存在的歌'), undefined);
    assert.equal(findTrack(lib, ''), null);
    assert.equal(findTrack(lib, { not: 'a string' }), null);
    assert.equal(findTrack(null, 'x'), null);
});

test('lazy scoring preserves tie-breaking when higher-scored track precedes artist/album matches', () => {
    const tracks = [
        { path: 'D:\\M\\1.mp3', title: 'Moonlight Sonata', artist: 'Beethoven', album: 'Moon' },
        { path: 'D:\\M\\2.mp3', title: 'Star', artist: 'Moon', album: 'X' },
        { path: 'D:\\M\\3.mp3', title: 'Moon', artist: 'Other', album: 'Y' }
    ];
    assert.equal(findTrack(tracks, 'Moon')?.path, 'D:\\M\\3.mp3');
    assert.equal(findTrack(tracks.slice(0, 2), 'Moon')?.path, 'D:\\M\\1.mp3');
    assert.equal(findTrack([{ path: '', title: '', artist: 'Solo Artist' }], 'Solo Artist')?.artist, 'Solo Artist');
});

test('per-track normalization cache refreshes when track metadata is mutated in place', () => {
    const track = { path: 'D:\\M\\old.flac', title: 'Old Song.flac', artist: 'Alpha', album: 'First' };
    const list = [track];
    assert.equal(findTrack(list, 'Old Song'), track);
    assert.equal(findTrack(list, 'alpha'), track);
    assert.equal(findTrack(list, 'first'), track);

    track.title = 'Ｎｅｗ　Ｔｒａｃｋ.flac';
    track.artist = 'Beta';
    track.album = 'Second';
    assert.equal(findTrack(list, 'Old Song'), null);
    assert.equal(findTrack(list, 'new track'), track);
    assert.equal(findTrack(list, 'beta'), track);
    assert.equal(findTrack(list, 'second'), track);
});

test('Batch 69: splitQuery handles en-dash separator consistently with hyphen and em-dash', () => {
    assert.equal(pick('晴天 – 翻唱者'), 'D:\\M\\qt2.flac');
    assert.equal(pick('晴天 — 翻唱者'), 'D:\\M\\qt2.flac');
});
