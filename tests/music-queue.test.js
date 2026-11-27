const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const titles = (list) => Array.from(list, (t) => t.title);

// 播放器的「下一首」和自动预载：先把现有行为锁住，再测手动队列。
function setup({ mode = 'repeat', count = 5, nav = {} } = {}) {
    const events = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        document: { body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, dispatchEvent: (e) => events.push(e.type) },
        navigator: nav,
        localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })()
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-app-hooks.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-player.js'), 'utf8'), context);
    const playlist = Array.from({ length: count }, (_, i) => ({ path: `C:/m/${i}.flac`, title: `t${i}` }));
    const preloads = [];
    const loads = [];
    const app = {
        playlist,
        currentTrackIndex: 0,
        currentFilteredTracks: null,
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: ['repeat', 'repeat-one', 'shuffle'].indexOf(mode),
        shuffleQueue: [],
        pendingLoadRequestId: 0,
        normalizePathForCompare: (p) => (p || '').toLowerCase(),
        api: { queueNextMusicTrack: async (t) => { preloads.push(t.path); return { status: 'success' }; } }
    };
    context.setupPlayer(app);
    // 只看选了哪一首，不真的加载。
    app.loadTrack = (i) => { loads.push(i); app.currentTrackIndex = i; };
    const preload = async () => { app.isPreloadingNext = false; await app.handleNeedsPreload(); return preloads[preloads.length - 1]; };
    return { app, playlist, preloads, loads, preload, events, context };
}

test('repeat: next and preload both pick the following track in the active list and wrap', async () => {
    const { app, loads, preload } = setup();
    assert.equal(await preload(), 'C:/m/1.flac');
    app.nextTrack();
    assert.deepEqual(loads, [1]);
    app.currentTrackIndex = 4;
    assert.equal(await preload(), 'C:/m/0.flac');
    app.nextTrack();
    assert.equal(loads.pop(), 0);
});

test('repeat with a filtered list stays inside that list', async () => {
    const { app, playlist, loads, preload } = setup();
    app.currentFilteredTracks = [playlist[3], playlist[1]];
    app.currentTrackIndex = 3;
    assert.equal(await preload(), 'C:/m/1.flac');
    app.nextTrack();
    assert.equal(loads.pop(), 1);
    app.currentTrackIndex = 2; // 不在列表里：从列表头开始
    app.nextTrack();
    assert.equal(loads.pop(), 3);
});

test('repeat-one preloads the same track for a gapless loop', async () => {
    const { app, preload } = setup({ mode: 'repeat-one' });
    app.currentTrackIndex = 2;
    assert.equal(await preload(), 'C:/m/2.flac');
});

test('a single-track list does not preload unless repeating one', async () => {
    const { app, playlist, preloads, preload } = setup();
    app.currentFilteredTracks = [playlist[0]];
    await preload();
    assert.equal(preloads.length, 0);
});

test('shuffle: preload and next agree, never pick the current track, no repeats within a round', async () => {
    const { app, loads, preload } = setup({ mode: 'shuffle', count: 6 });
    const picks = new Set();
    for (let k = 0; k < 5; k++) {
        const before = app.currentTrackIndex;
        const preloaded = await preload();
        app.nextTrack();
        const picked = loads[loads.length - 1];
        assert.equal(`C:/m/${picked}.flac`, preloaded, 'next plays what was preloaded');
        assert.notEqual(picked, before);
        assert.ok(!picks.has(picked), 'no repeats within one round');
        picks.add(picked);
    }
});

// ───────── 手动队列 ─────────

test('play-next goes before add-to-queue, both before the context, and context resumes where it left off', async () => {
    const { app, playlist, loads, preload } = setup();
    app.queueAdd(playlist[4]);
    app.queuePlayNext(playlist[3]);
    assert.deepEqual(titles(app.manualQueue), ['t3', 't4']);
    assert.equal(await preload(), 'C:/m/3.flac', 'preload reads the queue');
    app.nextTrack();
    app.nextTrack();
    assert.deepEqual(loads, [3, 4]);
    assert.equal(app.manualQueue.length, 0);
    app.nextTrack();
    assert.equal(loads.pop(), 1, 'back to the context after track 0, not after track 4');
});

test('queueing a track that is already queued moves it instead of duplicating', () => {
    const { app, playlist } = setup();
    app.queueAdd(playlist[1]);
    app.queueAdd(playlist[2]);
    app.queueAdd(playlist[1]);
    assert.deepEqual(titles(app.manualQueue), ['t2', 't1']);
    app.queuePlayNext('C:/m/1.flac');
    assert.deepEqual(titles(app.manualQueue), ['t1', 't2']);
    app.queueMove(0, 1);
    assert.deepEqual(titles(app.manualQueue), ['t2', 't1']);
    app.queueRemove(0);
    assert.deepEqual(titles(app.manualQueue), ['t1']);
    app.queueClear();
    assert.equal(app.manualQueue.length, 0);
});

test('queue changes after a preload re-issue the preload so the engine slot is not stale', async () => {
    const { app, playlist, preloads, preload } = setup();
    await preload();
    assert.equal(preloads.pop(), 'C:/m/1.flac');
    app.isPreloadingNext = false;
    app.queuePlayNext(playlist[3]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(preloads.pop(), 'C:/m/3.flac');
    app.isPreloadingNext = false;
    app.queueRemove(0);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(preloads.pop(), 'C:/m/1.flac', 'removing the head puts the context track back');
});

test('gapless switch into a queued track consumes it', async () => {
    const { app, playlist, preload } = setup();
    app.queuePlayNext(playlist[3]);
    await preload();
    app.renderPlaylist = () => {};
    app.trackTitle = {}; app.trackArtist = {}; app.trackBitrate = {}; app.albumArt = { style: {} };
    app.progress = { style: {} }; app.currentTimeEl = {}; app.durationEl = {}; app.formatTime = s => String(s);
    app.stripAudioExtension = (t) => t; app.updateBlurredBackground = () => {}; app.fetchAndDisplayLyrics = () => {};
    app.updateMediaSessionMetadata = () => {}; app.rememberPlayed = () => {}; app.publishCapsuleState = () => {};
    app.syncTrackIndexByPath('C:/m/3.flac');
    assert.equal(app.currentTrackIndex, 3);
    assert.equal(app.manualQueue.length, 0);
    app.loadTrack = (i) => { app.currentTrackIndex = i; app.lastLoad = i; };
    app.nextTrack();
    assert.equal(app.lastLoad, 1, 'context continues after the track that was playing before the queue');
});

test('repeat-one ignores the manual queue for the automatic loop', async () => {
    const { app, playlist, preload } = setup({ mode: 'repeat-one' });
    app.queueAdd(playlist[2]);
    assert.equal(await preload(), 'C:/m/0.flac');
});

test('up next shows the manual layer then the real context order (shuffle included)', async () => {
    const { app, playlist, loads, preload } = setup({ mode: 'shuffle', count: 6 });
    app.queueAdd(playlist[5]);
    const up = app.getUpNext();
    assert.deepEqual(titles(up.manual), ['t5']);
    assert.equal(up.context.length, 5, 'every other track, in the order shuffle will play them');
    await preload(); app.nextTrack(); // 先放手动的那首
    assert.equal(loads.pop(), 5);
    const order = app.getUpNext().context.map((t) => t.path);
    await preload();
    app.nextTrack();
    assert.equal(`C:/m/${loads.pop()}.flac`, order[0]);

    const r = setup();
    r.app.currentTrackIndex = 3;
    assert.deepEqual(titles(r.app.getUpNext().context), ['t4', 't0', 't1', 't2']);
});

test('peekPrevious names what prev will play without touching history', () => {
    const { app, playlist } = setup();
    app.currentTrackIndex = 2;
    assert.equal(app.peekPrevious(), playlist[1], 'no history: previous in the list');
    app.rememberPlayed(playlist[4]);
    app.rememberPlayed(playlist[2]);
    assert.equal(app.peekPrevious(), playlist[4], 'history wins, skipping the current track');
    assert.equal(app.peekPrevious(), playlist[4], 'peeking twice gives the same answer');
    const loads = [];
    app.loadTrack = (i) => loads.push(i);
    app.prevTrack();
    assert.deepEqual(loads, [4]);
});

test('session: saves track, time, context and manual queue, and restores them by path without autoplay', () => {
    const { app, playlist, context } = setup();
    app.currentTrackIndex = 2;
    app.lastKnownCurrentTime = 83.46;
    app.currentFilteredTracks = [playlist[2], playlist[4], playlist[0]];
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1', name: '通勤' };
    app.queueAdd(playlist[3]);
    app.saveSession();
    const saved = JSON.parse(context.localStorage.getItem('musicSession'));
    assert.equal(saved.track, 'C:/m/2.flac');
    assert.equal(saved.time, 83.5);
    assert.deepEqual(Array.from(saved.context), ['C:/m/2.flac', 'C:/m/4.flac', 'C:/m/0.flac']);
    assert.deepEqual(Array.from(saved.manual), ['C:/m/3.flac']);

    // 「重启」：新的播放器，曲库是重新扫描出来的新对象，还少了一首
    const next = setup();
    next.context.localStorage.setItem('musicSession', JSON.stringify(saved));
    next.app.playlist.splice(4, 1);
    next.app.renderPlaylist = () => {};
    const start = next.app.sessionStartPoint();
    assert.deepEqual({ ...start }, { index: 2, time: 83.5 });
    next.app.applySessionQueue();
    assert.deepEqual(titles(next.app.currentFilteredTracks), ['t2', 't0'], 'missing tracks are skipped');
    assert.equal(next.app.filteredPlaylistSource.id, 'p1');
    assert.deepEqual(titles(next.app.manualQueue), ['t3']);
    assert.equal(next.loads.length, 0, 'restoring does not start playback');
});

// 重启后恢复（#14）：照 music.js 启动时的顺序走一遍——先定位到上次那首和进度（不播放），
// 侧栏初始化完再恢复上下文和手动队列。
function restart(prev, { mode = 'repeat', drop = null } = {}) {
    const next = setup({ mode, count: prev.playlist.length });
    for (const key of ['musicSession', 'musicSessionTime']) {
        const value = prev.context.localStorage.getItem(key);
        if (value != null) next.context.localStorage.setItem(key, value);
    }
    if (drop != null) next.app.playlist.splice(drop, 1);
    const calls = [];
    next.app.renderPlaylist = () => {};
    next.app.loadTrack = (index, andPlay) => { calls.push(['load', index, andPlay]); next.app.currentTrackIndex = index; next.app.playIntent = andPlay === true; };
    next.app.seekTo = (time) => { calls.push(['seek', time]); next.app.lastKnownCurrentTime = time; };
    next.app.playTrack = () => calls.push(['play']);
    const resume = next.app.sessionStartPoint();
    if (resume) {
        next.app.loadTrack(resume.index, false);
        if (resume.time > 1 && !next.app.playIntent) next.app.seekTo(resume.time);
    }
    next.app.currentFilteredTracks = null; // 侧栏初始化会清掉当前列表
    next.app.applySessionQueue();
    return { ...next, calls, resume };
}
const upNext = (app) => { const up = app.getUpNext(); return { manual: titles(up.manual), context: titles(up.context) }; };

test('session restart: three queued tracks plus a context come back in the same order, paused, within a second of the old position', () => {
    const first = setup({ count: 8 });
    const { app, playlist } = first;
    app.currentFilteredTracks = [playlist[1], playlist[3], playlist[5], playlist[7], playlist[0]];
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1', name: '通勤' };
    app.currentTrackIndex = 3;
    app.queueAdd(playlist[2]);
    app.queueAdd(playlist[6]);
    app.queueAdd(playlist[4]);
    app.lastKnownCurrentTime = 127.3;
    app.saveSession();                 // 每 5 秒一次的整份会话
    app.lastKnownCurrentTime = 131.84; // 又放了几秒，只有每秒的进度记录跟上了
    app.saveSessionTime();
    const before = upNext(app);
    assert.deepEqual(before, { manual: ['t2', 't6', 't4'], context: ['t5', 't7', 't0', 't1'] });

    const next = restart(first);
    assert.deepEqual(upNext(next.app), before, 'manual queue and context order are identical');
    assert.equal(next.app.playlist[next.app.currentTrackIndex].title, 't3');
    assert.equal(next.app.filteredPlaylistSource.id, 'p1');
    assert.deepEqual(next.calls.filter(c => c[0] !== 'seek'), [['load', 3, false]], 'the track is loaded without playing, and nothing else starts playback');
    assert.ok(!next.app.playIntent && !next.app.isPlaying, 'restoring never autoplays');
    const seek = next.calls.find(c => c[0] === 'seek');
    assert.ok(seek && Math.abs(seek[1] - 131.84) <= 1, `position ${seek && seek[1]} is within a second of 131.84`);

    // 进度记录是别的歌的（刚切歌还没存整份会话）：不拿来用
    first.context.localStorage.setItem('musicSessionTime', JSON.stringify({ track: 'C:/m/6.flac', time: 9, at: Date.now() + 1000 }));
    assert.equal(restart(first).resume.time, 127.3);
});

test('session restart: shuffle keeps its dealt order, and reshuffles only when the context changed size', () => {
    const first = setup({ mode: 'shuffle', count: 8 });
    const { app, playlist } = first;
    app.currentFilteredTracks = [playlist[1], playlist[3], playlist[5], playlist[7], playlist[0], playlist[2]];
    app.currentTrackIndex = 3;
    app.queueAdd(playlist[6]);
    const before = upNext(app); // 这一步洗牌
    assert.equal(before.context.length, 5);
    app.saveSession();

    const next = restart(first, { mode: 'shuffle' });
    assert.deepEqual(upNext(next.app), before, 'the shuffled order survives the restart');

    // 曲库里少了一首上下文里的歌：存的下标对不上了，重洗，但每首还是恰好出现一次
    const smaller = restart(first, { mode: 'shuffle', drop: 7 });
    const after = upNext(smaller.app);
    assert.deepEqual(after.manual, ['t6']);
    assert.deepEqual([...after.context].sort(), ['t0', 't1', 't2', 't5']);
});

test('session: a whole-library context is stored as null and a missing track gives no start point', () => {
    const { app, context } = setup();
    app.currentTrackIndex = 1;
    app.saveSession();
    assert.equal(JSON.parse(context.localStorage.getItem('musicSession')).context, null);
    const next = setup();
    next.context.localStorage.setItem('musicSession', JSON.stringify({ v: 1, track: 'C:/gone.flac', time: 9 }));
    assert.equal(next.app.sessionStartPoint(), null);
});

test('playFromContext: the shown order becomes the context; library order is stored as the whole library', () => {
    const { app, playlist, loads } = setup();
    let rendered = 0;
    app.renderPlaylist = () => { rendered += 1; };
    const shown = [playlist[3], playlist[1], playlist[4]];
    app.playFromContext(shown, 1, { origin: 'classic', render: false });
    assert.deepEqual(titles(app.currentFilteredTracks), ['t3', 't1', 't4']);
    assert.equal(rendered, 0, 'render: false leaves the list alone');
    assert.deepEqual(loads, [1]);
    assert.equal(app.getUpNext(3).context.map(t => t.title).join(), 't4,t3');

    app.playFromContext(playlist.slice(), 0, { origin: 'classic' });
    assert.equal(app.currentFilteredTracks, null, 'same as the library order means the whole library');
    assert.equal(rendered, 1);
});

test('reorderContext: follows a new sort of the same group, only while that origin still owns the context', () => {
    const { app, playlist, events } = setup();
    app.playFromContext([playlist[0], playlist[1], playlist[2]], 1, { origin: 'classic', render: false });
    const before = events.filter(e => e === 'music-queue-change').length;

    assert.equal(app.reorderContext([playlist[2], playlist[1], playlist[0]], 'classic'), true);
    assert.deepEqual(titles(app.currentFilteredTracks), ['t2', 't1', 't0']);
    assert.equal(app.getUpNext(1).context[0].title, 't0', 'next follows the new order');
    assert.ok(events.filter(e => e === 'music-queue-change').length > before, 'the queue page is told');
    assert.equal(app.contextFrom('classic'), true, 'still owned after reordering');

    assert.equal(app.reorderContext([playlist[2], playlist[3], playlist[0]], 'classic'), false, 'different members are ignored');
    assert.equal(app.reorderContext([playlist[0], playlist[1], playlist[2]], 'archive'), false, 'another origin does not own it');

    // 档案页换了上下文：经典列表再怎么排序都不碰
    app.playFromContext([playlist[0], playlist[1], playlist[2]], 0, { origin: 'archive', render: false });
    assert.equal(app.contextFrom('classic'), false);
    assert.equal(app.reorderContext([playlist[1], playlist[0], playlist[2]], 'classic'), false);
    // 直接改上下文（旧代码路径）也让记录失效
    app.currentFilteredTracks = [playlist[4]];
    assert.equal(app.contextFrom('archive'), false);
});

test('lyrics offset: shifts the parsed timeline in place, is remembered per track, and is picked up on the next load', () => {
    const { app, playlist, context } = setup();
    let renders = 0;
    app.renderLyrics = () => { renders += 1; };
    const fetched = [];
    // 换歌时播放器会调用 fetchAndDisplayLyrics；这里只看它被调用时的偏移
    app.currentTrackIndex = 1;
    app.lastKnownCurrentTime = 10;
    app.lyricOffset = 0;
    app.currentLyrics = [
        { time: 5, startTime: 5, endTime: 9, words: [{ startTime: 5, endTime: 6 }] },
        { time: 9.8, startTime: 9.8, endTime: 12 }
    ];
    app.currentLyricIndex = 1;
    assert.equal(app.shiftLyrics(0.5), 0.5);
    assert.equal(app.currentLyrics[0].time, 5.5);
    assert.equal(app.currentLyrics[0].words[0].endTime, 6.5);
    assert.equal(app.currentLyricIndex, 0, 'the current line moves with the timeline');
    assert.ok(renders > 0);
    app.shiftLyrics(-1.5);
    assert.equal(app.lyricOffset, -1);
    assert.equal(app.currentLyrics[1].time, 8.8);
    assert.equal(JSON.parse(context.localStorage.getItem('musicLyricOffsets'))['C:/m/1.flac'], -1);
    assert.equal(app.lyricOffsetFor(playlist[2].path), 0);
    assert.equal(app.setLyricOffset(99), 30, 'clamped');
    app.setLyricOffset(0);
    assert.equal(context.localStorage.getItem('musicLyricOffsets'), '{}', 'zero is not stored');
    assert.equal(app.currentLyrics[0].time, 5);
});

test('lyrics offset is applied before the next track parses its lyrics; translation toggle persists', () => {
    const { app, context } = setup();
    context.localStorage.setItem('musicLyricOffsets', JSON.stringify({ 'C:/m/3.flac': 1.5 }));
    // 播放器会把已有的取歌词函数包一层：调用时先换成这首歌的偏移
    const seen = [];
    const fresh = { ...app, fetchAndDisplayLyrics() { seen.push(fresh.lyricOffset); } };
    context.setupPlayer(fresh);
    fresh.fetchAndDisplayLyrics('a', 't', { path: 'C:/m/3.flac' });
    fresh.fetchAndDisplayLyrics('a', 't', { path: 'C:/m/0.flac' });
    assert.deepEqual(seen, [1.5, 0]);

    assert.equal(fresh.lyricsTranslation, true, 'translation is shown by default');
    let renders = 0;
    fresh.renderLyrics = () => { renders += 1; };
    fresh.setLyricsTranslation(false);
    assert.equal(context.localStorage.getItem('musicLyricsTranslation'), 'false');
    assert.equal(renders, 1);
});

test('media session: seekto seeks the engine, position is reported on jumps and drift only', async () => {
    const handlers = {};
    const positions = [];
    const nav = { mediaSession: { setActionHandler: (name, fn) => { handlers[name] = fn; }, setPositionState: (p) => positions.push(p ? { ...p } : null) } };
    const { app } = setup({ nav });
    const seeks = [];
    app.api.seekMusic = async (t) => { seeks.push(t); return { status: 'success' }; };
    app.startStatePolling = () => {};
    app.lastKnownDuration = 200;
    app.isPlaying = true;
    app.lastKnownCurrentTime = 10;
    app.lastStateUpdateTime = Date.now();

    assert.equal(typeof handlers.seekto, 'function');
    handlers.seekto({ seekTime: 63.2 });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seeks, [63.2]);
    assert.equal(positions.at(-1).position, 63.2);
    assert.equal(positions.at(-1).duration, 200);
    assert.equal(positions.at(-1).playbackRate, 1);
    handlers.seekto({ seekTime: 999 });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seeks.at(-1), 199.5, 'clamped short of the end');

    // 引擎按时报进度，和推算的一致：不重复报
    const count = positions.length;
    app.lastKnownCurrentTime = 199.5; app.lastStateUpdateTime = Date.now();
    assert.equal(app.syncMediaPosition(), false);
    assert.equal(positions.length, count);
    // 差了 1 秒以上（比如引擎自己跳了）才报
    app.lastKnownCurrentTime = 120; app.lastStateUpdateTime = Date.now();
    assert.equal(app.syncMediaPosition(), true);
    // 时长未知时清掉系统进度条
    app.lastKnownDuration = 0;
    app.syncMediaPosition(true);
    assert.equal(positions.at(-1), null);
});

test('undoing a queue add puts back tracks that were already queued instead of dropping them', () => {
    const { app, playlist } = setup({ count: 8 });
    const names = () => JSON.parse(JSON.stringify(app.manualQueue.map(t => t.title)));
    app.queueAdd(playlist[1]); app.queueAdd(playlist[2]); app.queueAdd(playlist[3]);

    // 批量「下一首播放」：2 本来排第二，这次被挪到最前；5、6 是新加的
    let before = app.queueSnapshot();
    const added = [playlist[6], playlist[5], playlist[2]].map(t => app.queuePlayNext(t));
    assert.deepEqual(names(), ['t2', 't5', 't6', 't1', 't3']);
    app.queueRevert(added, before);
    assert.deepEqual(names(), ['t1', 't2', 't3'], 'new ones go, the moved one returns to its old place');

    // 批量「加入队列」：1 本来在最前，被挪到最后
    before = app.queueSnapshot();
    const tail = [playlist[1], playlist[7]].map(t => app.queueAdd(t));
    assert.deepEqual(names(), ['t2', 't3', 't1', 't7']);
    // 撤销前用户自己又排了一首，撤销不动它
    app.queueAdd(playlist[4]);
    app.queueRevert(tail, before);
    assert.deepEqual(names(), ['t1', 't2', 't3', 't4']);

    // 撤销前那首已经放掉了：不会被加回来
    before = app.queueSnapshot();
    const one = [app.queuePlayNext(playlist[0])];
    app.manualQueue.shift();
    app.queueRevert(one, before);
    assert.deepEqual(names(), ['t1', 't2', 't3', 't4']);
});

test('session restart: the context keeps the origin it was played from, so a later re-sort there still applies', () => {
    const prev = setup();
    prev.app.renderPlaylist = () => {};
    prev.app.playFromContext([prev.playlist[0], prev.playlist[1], prev.playlist[2]], 1, { origin: 'classic', render: false });
    prev.app.saveSession();
    assert.equal(JSON.parse(prev.context.localStorage.getItem('musicSession')).origin, 'classic');

    const next = restart(prev);
    assert.equal(next.app.contextFrom('classic'), true);
    const [a, b, c] = next.app.currentFilteredTracks;
    assert.equal(next.app.reorderContext([c, b, a], 'classic'), true);
    assert.deepEqual(titles(next.app.currentFilteredTracks), ['t2', 't1', 't0']);
    assert.equal(next.app.reorderContext([a, b, c], 'archive'), false, 'another origin still does not own it');
});

test('the playing list is named after the playlist as it is now: renamed follows, deleted keeps the old name', () => {
    const { app } = setup();
    app.customPlaylists = [{ id: '7', name: '通勤', tracks: [] }];
    app.filteredPlaylistSource = { type: 'playlist', id: '7', name: '通勤' };
    app.customPlaylists[0].name = '早上通勤';
    assert.equal(app.playbackSourceName(), '早上通勤');
    app.customPlaylists = [];
    assert.equal(app.playbackSourceName(), '通勤');
    assert.equal(app.playbackSourceName({ type: 'album', name: 'Demo' }), 'Demo');
    app.filteredPlaylistSource = null;
    assert.equal(app.playbackSourceName(), '');
});

test('switching play mode after a preload re-fills the engine slot for the new mode', async () => {
    const { app, preloads, preload } = setup({ count: 6 });
    let cancels = 0;
    app.api.cancelMusicPreload = async () => { cancels++; };
    app.currentTrackIndex = 2;
    assert.equal(await preload(), 'C:/m/3.flac');
    app.isPreloadingNext = false;
    app.currentPlayMode = 1; // 单曲循环
    app.refreshPreload();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cancels, 1);
    assert.equal(preloads.pop(), 'C:/m/2.flac', 'repeat-one loops the playing track');
    app.isPreloadingNext = false;
    app.currentPlayMode = 2; // 随机
    app.refreshPreload();
    await new Promise((r) => setTimeout(r, 0));
    const picked = preloads.pop();
    assert.notEqual(picked, 'C:/m/2.flac');
    app.nextTrack();
    assert.equal(app.playlist[app.currentTrackIndex].path, picked, 'next plays what was preloaded');
});

test('session: a saved position in the last seconds, or past a now-shorter file, restarts the track from the top', () => {
    const next = setup();
    next.app.playlist[1].duration = 240;
    next.app.playlist[2].duration = 180;
    next.context.localStorage.setItem('musicSession', JSON.stringify({ v: 1, track: 'C:/m/1.flac', time: 238.5 }));
    assert.deepEqual({ ...next.app.sessionStartPoint() }, { index: 1, time: 0 }, 'last seconds start from 0');
    next.context.localStorage.setItem('musicSession', JSON.stringify({ v: 1, track: 'C:/m/2.flac', time: 300 }));
    assert.deepEqual({ ...next.app.sessionStartPoint() }, { index: 2, time: 0 }, 'past the end starts from 0');
    next.context.localStorage.setItem('musicSession', JSON.stringify({ v: 1, track: 'C:/m/2.flac', time: 90 }));
    assert.deepEqual({ ...next.app.sessionStartPoint() }, { index: 2, time: 90 }, 'a normal position is kept');
});

test('Batch 60: byPathMap memoizes across repeated resolutions and invalidates when playlist changes', () => {
    const { app, playlist } = setup({ count: 50 });
    let normCalls = 0;
    app.normalizePathForCompare = (p) => { normCalls += 1; return String(p || '').toLowerCase(); };
    // 首次解析字符串路径会构建一次 path->track 缓存表
    app.queueAdd('c:/m/12.flac');
    const callsAfterFirst = normCalls;
    assert.equal(app.manualQueue.length, 1);
    assert.equal(app.manualQueue[0].path, 'C:/m/12.flac');
    // 同一曲库下再次按路径解析不重建整张 50 项 Map（只归一化查询路径本身）
    app.queueAdd('c:/m/35.flac');
    app.queueAdd('c:/m/49.flac');
    assert.ok(normCalls - callsAfterFirst <= 4, `cached byPathMap avoids O(N) rebuilds (extra normCalls=${normCalls - callsAfterFirst})`);
    assert.equal(app.manualQueue.length, 3);

    // 曲库发生变更后缓存自动失效并识别新曲目
    const added = { path: 'C:/m/99.flac', title: 't99', artist: 'A', album: 'Alb' };
    app.playlist.push(added);
    app.queueAdd('c:/m/99.flac');
    assert.equal(app.manualQueue.at(-1), added, 'byPathMap invalidates after playlist length changes');

    // 从曲库移除曲目后 manualQueue / history 通过 O(1) Set 过滤掉孤立条目
    app.playlist.pop();
    const up = app.getUpNext();
    assert.equal(up.manual.includes(added), false, 'removed track excluded from manual up-next');
});

test('Batch 65: syncTrackIndexByPath resolves via O(1) byPathIndexMap, keeps first duplicate, and falls back to filename', () => {
    const { app, playlist } = setup({ count: 60 });
    // Add duplicate path at the end to verify first-index preference
    playlist.push({ path: 'C:/m/15.flac', title: 't15-dup' });
    app.renderPlaylist = () => {};
    app.trackTitle = {}; app.trackArtist = {}; app.trackBitrate = {}; app.albumArt = { style: {} };
    app.progress = { style: {} }; app.currentTimeEl = {}; app.durationEl = {}; app.formatTime = s => String(s);
    app.stripAudioExtension = (t) => t; app.updateBlurredBackground = () => {}; app.fetchAndDisplayLyrics = () => {};
    app.updateMediaSessionMetadata = () => {}; app.rememberPlayed = () => {}; app.publishCapsuleState = () => {};

    let normCalls = 0;
    app.normalizePathForCompare = (p) => { normCalls += 1; return String(p || '').toLowerCase(); };

    // First call builds byPathIndexMap once across playlist
    app.syncTrackIndexByPath('c:/m/15.flac');
    assert.equal(app.currentTrackIndex, 15, 'resolves first matching index when duplicate paths exist');
    const callsAfterWarm = normCalls;

    // Subsequent exact path matches are O(1) — only normalizing the query path, never scanning all 61 tracks
    app.syncTrackIndexByPath('c:/m/42.flac');
    assert.equal(app.currentTrackIndex, 42);
    app.syncTrackIndexByPath('c:/m/59.flac');
    assert.equal(app.currentTrackIndex, 59);
    assert.ok(normCalls - callsAfterWarm <= 6, `O(1) byPathIndexMap avoids O(N) playlist scans (extra normCalls=${normCalls - callsAfterWarm})`);

    // Filename fallback still works when directory prefix differs
    app.syncTrackIndexByPath('D:/moved/dir/7.flac');
    assert.equal(app.currentTrackIndex, 7, 'filename fallback locates moved track');
});
