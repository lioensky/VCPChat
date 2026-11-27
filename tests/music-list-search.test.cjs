// 列表搜索框/歌单编辑框：全角半角和大小写统一，歌手专辑也能搜，几个词都要命中。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function utils() {
    const app = { api: {} };
    const context = { app, window: {}, console };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules', 'music-utils.js'), 'utf8') + '\nsetupUtils(app);', context);
    return app;
}

test('list search: full-width, case, album, several words', () => {
    const app = utils();
    const tracks = [
        { title: '晴天.flac', artist: '周杰伦', album: '叶惠美' },
        { title: 'ＡＢＣ Song', artist: 'Ｘ', album: '' },
        { title: 'Intro', artist: 'Band', album: 'First Album' },
        null
    ];
    const titles = (q) => app.searchTracks(tracks, q).map((t) => t.title);
    assert.deepEqual(titles('abc'), ['ＡＢＣ Song']);
    assert.deepEqual(titles('ＡＢＣ'), ['ＡＢＣ Song']);
    assert.deepEqual(titles('叶惠美'), ['晴天.flac']);
    assert.deepEqual(titles('周杰伦 晴天'), ['晴天.flac']);
    assert.deepEqual(titles('晴天 周杰伦'), ['晴天.flac']);
    assert.deepEqual(titles('first album'), ['Intro']);
    assert.deepEqual(titles('flac'), [], 'the file extension is not part of the title');
    assert.equal(app.searchTracks(tracks, '   ').length, tracks.length);
});

test('Batch 53: searchTracks caches per-track haystack and invalidates when metadata changes', () => {
    const app = utils();
    let stripCalls = 0;
    const origStrip = app.stripAudioExtension;
    app.stripAudioExtension = (title) => { stripCalls += 1; return origStrip(title); };
    const track = { title: '夜曲.flac', artist: '周杰伦', album: '十一月的萧邦' };
    const tracks = [track];
    assert.equal(app.searchTracks(tracks, '夜曲').length, 1);
    const firstCalls = stripCalls;
    assert.equal(app.searchTracks(tracks, '周杰伦').length, 1);
    assert.equal(app.searchTracks(tracks, '萧邦').length, 1);
    assert.equal(stripCalls, firstCalls, 'cached haystack avoids recomputing stripAudioExtension/NFKC across queries');

    track.title = '七里香.flac';
    assert.equal(app.searchTracks(tracks, '夜曲').length, 0, 'mutated track title invalidates cached haystack');
    assert.equal(app.searchTracks(tracks, '七里香').length, 1);
});
