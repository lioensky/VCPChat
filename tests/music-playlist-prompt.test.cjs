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

test('Batch 90: playlist prompt caps shown list while preserving total count, and M3U/library-watch helpers match exact output', async () => {
    const m3u = require('../modules/ipc/musicM3u');
    const { changedSince, createLibraryWatch } = require('../modules/musicLibraryWatch');

    // formatPlaylistPrompt skips building full titles array beyond cap while still reporting deduplicated total
    const bulk = Array.from({ length: 120 }, (_, i) => ({ title: `  Song   ${i % 40}.mp3` }));
    const out = formatPlaylistPrompt(bulk, 3);
    assert.equal(out, '[播放列表——\nSong 0\nSong 1\nSong 2\n（曲库共 40 首，这里只列出前 3 首；不在列表里的歌也可以直接按歌名点）\n]');

    // M3U build / parse / safeFileName preserve formatting & Windows path normalization
    const text = m3u.buildM3u('  Night\nMix  ', [
        { path: 'C:\\Music\\a.flac', artist: 'Artist', title: 'Track', duration: 205.6 },
        { path: 'C:\\Music\\b.mp3', artist: '', title: 'Solo', duration: 0 },
        { path: 'C:\\Music\\c.mp3', artist: 'OnlyArtist', title: '', duration: -1 }
    ]);
    assert.match(text, /#PLAYLIST:Night Mix\r\n/);
    assert.match(text, /#EXTINF:206,Artist - Track\r\nC:\\Music\\a\.flac\r\n/);
    assert.match(text, /#EXTINF:-1,Solo\r\nC:\\Music\\b\.mp3\r\n/);
    assert.match(text, /#EXTINF:-1,OnlyArtist\r\nC:\\Music\\c\.mp3\r\n/);
    const parsed = m3u.parseM3u('file:///C:/My%20Songs/a.flac\n', { platform: 'win32' });
    assert.deepEqual(parsed.entries, [{ path: 'C:\\My Songs\\a.flac', title: '', duration: 0 }]);
    assert.equal(m3u.safeFileName('..con:bad/name.  '), 'con_bad_name');
    assert.equal(m3u.safeFileName('..con.txt  '), '_con.txt');

    // LibraryWatch changedSince & update-only Map/Set scan path
    assert.equal(changedSince(
        [{ path: 'C:\\Lib\\a.mp3', size: 10, mtimeMs: 100 }],
        [{ path: 'C:\\Lib\\a.mp3', size: 10, mtimeMs: 100.5 }],
        'C:\\Lib\\'
    ), false);
    assert.equal(changedSince(
        [{ path: 'C:\\Lib\\a.mp3', size: 10, mtimeMs: 100 }],
        [{ path: 'C:\\Lib\\a.mp3', size: 10, mtimeMs: 100, albumArt: 'C:\\Lib\\cover.jpg' }],
        'C:\\Lib\\'
    ), true);

    const sent = [];
    const timers = [];
    let known = [{ path: 'C:\\Loose\\x.mp3', size: 10, mtimeMs: 100 }];
    const watcher = createLibraryWatch({
        scan: async () => ({ tracks: [{ path: 'C:\\Loose\\x.mp3', size: 20, mtimeMs: 200 }, { path: 'C:\\Loose\\new.mp3', size: 5, mtimeMs: 5 }], stats: { total: 2, failed: 0 } }),
        readKnown: async () => known,
        readFolders: async () => [],
        writeFolders: async () => {},
        send: (ch, payload) => sent.push({ ch, payload }),
        exists: async () => true,
        watch: () => ({ close() {} }),
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        log: {}
    });
    watcher.start();
    await timers[0]();
    await new Promise((r) => setTimeout(r, 15));
    watcher.stop();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.folderPath, null);
    assert.deepEqual(sent[0].payload.tracks.map((t) => t.path), ['C:\\Loose\\x.mp3']);
});

test('Batch 114: playlistPrompt fast tail-dot/ws normalization & libraryWatch AUDIO_EXTS filter', async () => {
    const { createLibraryWatch } = require('../modules/musicLibraryWatch');
    const text = formatPlaylistPrompt([
        { title: 'Symphony No.5.aiff' },
        { title: 'Symphony  No.5' },
        { title: 'Clean Title.opus' },
        { title: 'Tab\tName\u3000Here.flac' },
        { title: 'Version 1.2' }
    ]);
    assert.equal(text, '[播放列表——\nSymphony No.5\nClean Title\nTab Name Here\nVersion 1.2\n]');

    // fs.watch callback ignores non-audio files (.jpg/.lrc) and triggers debounce for audio (.flac) and directory events
    let watchCb = null;
    const debounced = [];
    let scanCalls = 0;
    const watcher = createLibraryWatch({
        scan: async () => { scanCalls += 1; return { tracks: [], stats: { total: 0, failed: 0 } }; },
        readKnown: async () => [],
        readFolders: async () => ['C:\\Watched'],
        writeFolders: async () => {},
        send: () => {},
        exists: async () => true,
        watch: (_dir, cb) => { watchCb = cb; return { close() {} }; },
        setTimer: (fn, ms) => { debounced.push({ fn, ms }); return debounced.length; },
        clearTimer: () => {},
        log: {}
    });
    watcher.start();
    await debounced[0].fn();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(typeof watchCb, 'function');
    const beforeWatch = debounced.length;
    watchCb('change', 'cover.jpg');
    watchCb('change', 'song.lrc');
    assert.equal(debounced.length, beforeWatch, 'non-audio watcher events do not schedule rescan timer');
    watchCb('rename', 'new_track.FLAC');
    assert.equal(debounced.length, beforeWatch + 1, 'audio file watcher event schedules rescan timer');
    watchCb('rename', 'NewAlbumFolder');
    assert.equal(debounced.length, beforeWatch + 2, 'directory watcher event (no ext) schedules rescan timer');
    watcher.stop();
    assert.ok(scanCalls >= 1);
});
