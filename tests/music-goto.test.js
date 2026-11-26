const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 右键「转到歌手 / 转到专辑」：只在档案页可用，曲目缺这项信息时不给跳。
const { setupMusicGoto } = require(path.join(__dirname, '../Musicmodules/music-goto.js'));

function setup({ mode = 'archive', stage = false } = {}) {
    const calls = [];
    globalThis.document = { body: { classList: { contains: (c) => stage && c === 'music-stage-active' } } };
    const app = {
        playlist: [{ path: 'a', title: 'a', artist: 'Ren', album: '窗边' }, { path: 'b', title: 'b', artist: '', album: 'X' }],
        archiveView: {
            mode,
            setListOpen: (open) => calls.push('open:' + open),
            list: { goToGroup: (i, kind) => { calls.push(`go:${i}:${kind}`); return true; } }
        }
    };
    setupMusicGoto(app);
    return { app, calls };
}

test('goes to the artist group in the archive directory', () => {
    const { app, calls } = setup();
    assert.equal(app.goToGroup(0, 'artist'), true);
    assert.deepEqual(calls, ['open:true', 'go:0:artist']);
});

test('refuses when the track has no artist, or the archive page is not showing', () => {
    assert.equal(setup().app.goToGroup(1, 'artist'), false);
    assert.equal(setup().app.goToGroup(1, 'album'), true);
    assert.equal(setup({ mode: 'classic' }).app.goToGroup(0, 'artist'), false);
    assert.equal(setup({ stage: true }).app.goToGroup(0, 'album'), false);
});

test('copy text is "title - artist" without the file extension', () => {
    const { copyText } = require(path.join(__dirname, '../Musicmodules/music-goto.js'));
    const app = { stripAudioExtension: (s) => s.replace(/\.flac$/, '') };
    assert.equal(copyText(app, { title: '晴天.flac', artist: 'Ren' }), '晴天 - Ren');
    assert.equal(copyText({}, { title: 'Night Train.mp3', artist: '' }), 'Night Train');
    assert.equal(copyText(app, null), '');
});
