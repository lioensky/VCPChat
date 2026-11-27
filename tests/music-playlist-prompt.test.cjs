// 发给 AI 的播放列表：去重、去扩展名、过长截断并说明；曲库文件没变就不重读。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playlistPrompt, formatPlaylistPrompt } = require('../modules/musicPlaylistPrompt');

test('titles are deduped, extensions dropped, long lists cut with a note', () => {
    const text = formatPlaylistPrompt([{ title: '晴天.flac' }, { title: '晴天' }, { title: '  夜曲 ' }, {}, null, { title: 'Intro' }], 2);
    assert.equal(text, '[播放列表——\n晴天\n夜曲\n（曲库共 3 首，这里只列出前 2 首；不在列表里的歌也可以直接按歌名点）\n]');
    assert.equal(formatPlaylistPrompt([{ title: 'a' }]), '[播放列表——\na\n]');
    assert.equal(formatPlaylistPrompt([]), '');
    assert.equal(formatPlaylistPrompt({}), '');
});

test('5000 tracks: bounded size; the file is read again only after it changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-prompt-'));
    const file = path.join(dir, 'songlist.json');
    const tracks = Array.from({ length: 5000 }, (_, i) => ({ path: `D:\\m\\${i}.flac`, title: `第 ${i} 首歌的名字.flac`, artist: 'x', album: 'y' }));
    fs.writeFileSync(file, JSON.stringify(tracks));
    const first = await playlistPrompt(file);
    const allTitles = tracks.map((t) => t.title).join('\n').length;
    assert.ok(first.length < allTitles * 0.35, `prompt ${first.length} chars vs ${allTitles} for the full list`);
    assert.match(first, /曲库共 5000 首/);

    fs.writeFileSync(file, '{ not json');
    const t = new Date(Date.now() - 60000);
    fs.utimesSync(file, t, t);
    assert.equal(await playlistPrompt(file), first, 'a half-written file keeps the last good list');

    fs.writeFileSync(file, JSON.stringify([{ title: '新歌' }]));
    assert.equal(await playlistPrompt(file), '[播放列表——\n新歌\n]');
    assert.equal(await playlistPrompt(path.join(dir, 'missing.json')), '');

    // .aif 扩展名与非法 limit 均被规范处理；删除后重读不返回旧缓存
    assert.equal(formatPlaylistPrompt([{ title: 'A.aif' }, { title: 'B.aiff' }], 0), '[播放列表——\nA\nB\n]');
    fs.unlinkSync(file);
    assert.equal(await playlistPrompt(file), '');
});
