const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 听歌记录：听到一半（或满 4 分钟）算一次，30 秒内换歌算跳过，单曲循环每遍单独算。
const { setupMusicStats, playedEnough } = require(path.join(__dirname, '../Musicmodules/music-stats.js'));

function setup(saved) {
    let t = 1_000_000_000;
    const store = new Map(saved ? [['musicPlayStats', saved]] : []);
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    globalThis.document = { dispatchEvent() {} };
    globalThis.CustomEvent = class { constructor(type, init) { this.detail = init?.detail; } };
    const app = {
        playlist: [{ path: 'C:\\Music\\A.flac', duration: 200 }, { path: 'C:\\Music\\B.flac', duration: 180 }],
        currentTrackIndex: 0, isPlaying: true, isTrackLoading: false, lastKnownDuration: 200, pos: 0,
        playedSeconds: () => app.pos
    };
    const stats = setupMusicStats(app, { now: () => t, storage, setTimer: () => 1, clearTimer() {}, observe: false });
    const play = (sec) => { for (let i = 0; i < sec; i++) { t += 1000; app.pos += 1; stats.tick(); } };
    return { app, stats, play, store, advanceDays: (d) => { t += d * 86400000; } };
}

test('a play counts at half the track; switching within 30 s counts a skip', () => {
    const { app, stats, play } = setup();
    play(99);
    assert.equal(stats.get(app.playlist[0]), null);
    play(2);
    assert.equal(stats.get('c:/music/a.flac').plays, 1);
    app.currentTrackIndex = 1; app.lastKnownDuration = 180; app.pos = 0;
    play(10);
    app.currentTrackIndex = 0; app.lastKnownDuration = 200; app.pos = 0;
    stats.tick();
    assert.equal(stats.get(app.playlist[1]).skips, 1);
    assert.equal(stats.get(app.playlist[1]).plays, 0);
});

test('repeat-one counts each pass, paused time does not count', () => {
    const { app, stats, play } = setup();
    play(150);
    app.pos = 0; stats.tick();
    app.isPlaying = false;
    play(200);
    assert.equal(stats.get(app.playlist[0]).plays, 1);
    app.isPlaying = true;
    play(101);
    assert.equal(stats.get(app.playlist[0]).plays, 2);
});

test('top and forgotten lists, and it survives a reload', () => {
    const first = setup();
    for (let k = 0; k < 3; k++) { first.app.pos = 0; first.stats.tick(); first.play(120); }
    first.app.currentTrackIndex = 1; first.app.lastKnownDuration = 180; first.app.pos = 0; first.play(95);
    assert.deepEqual(first.stats.top(5, { minPlays: 1 }), ['C:\\Music\\A.flac', 'C:\\Music\\B.flac']);
    first.stats.flush();
    const again = setup(first.store.get('musicPlayStats'));
    assert.equal(again.stats.get('C:\\Music\\A.flac').plays, 3);
    assert.deepEqual(again.stats.forgotten(), []);
    again.advanceDays(40);
    assert.deepEqual(again.stats.forgotten(), ['C:\\Music\\A.flac']);
    assert.equal(playedEnough(30, 0), false);
    assert.equal(playedEnough(240, 900), true);
});

test('resume remembers the unfinished track and clears once it ends', () => {
    const { app, stats, play, store } = setup();
    assert.equal(stats.resume(), null);
    play(40);
    stats.flush();
    const r = stats.resume();
    assert.equal(r.track, app.playlist[0]);
    assert.equal(r.position, 40);
    assert.match(store.get('musicPlayResume'), /"position":40/);
    app.pos = 199; stats.tick();
    assert.equal(stats.resume(), null);
});

test('MusicTrackOrder.numberOf WeakMap cache invalidates when path/discNo/trackNo mutates', () => {
    const Order = require(path.join(__dirname, '../Musicmodules/music-track-order.js'));
    const track = { path: 'C:\\Music\\CD1\\03 - Song.flac' };
    assert.deepEqual(Order.numberOf(track), { disc: 1, no: 3 });
    assert.deepEqual(Order.numberOf(track), { disc: 1, no: 3 });
    track.path = 'C:\\Music\\Disc 2\\07 - Song.flac';
    assert.deepEqual(Order.numberOf(track), { disc: 2, no: 7 });
    track.discNo = 3;
    track.trackNo = 11;
    assert.deepEqual(Order.numberOf(track), { disc: 3, no: 11 });
});

test('MusicDupes excludes currently-playing duplicate from toast count and traps Tab focus', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const toasts = [];
    window.MusicToast = { show: (opts) => toasts.push(opts) };
    window.requestAnimationFrame = (fn) => { fn(0); return 0; };
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-radio.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-dupes.js'), 'utf8'));
    const keepFlac = { path: 'C:\\Music\\Song.flac', title: 'Song', artist: 'A', duration: 200 };
    const playingMp3 = { path: 'C:\\Music\\Song.mp3', title: 'Song', artist: 'A', duration: 200 };
    const extraMp3 = { path: 'C:\\Music\\Song (2).mp3', title: 'Song', artist: 'A', duration: 200 };
    const app = {
        playlist: [keepFlac, playingMp3, extraMp3],
        currentTrackIndex: 1,
        customPlaylists: [],
        saveLibrary() {},
        renderPlaylist() {}
    };
    window.MusicDupes.open(app);
    const focusables = [...window.document.querySelectorAll('.music-dupes-dialog button:not([disabled]):not([hidden])')];
    assert.ok(focusables.length >= 2);
    focusables[focusables.length - 1].focus();
    const tabEv = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(tabEv);
    assert.equal(tabEv.defaultPrevented, true);
    assert.equal(window.document.activeElement, focusables[0]);
    const removeBtn = window.document.querySelector('.mdupes-remove');
    removeBtn.click();
    assert.equal(app.playlist.length, 2, 'playing duplicate is kept while extra duplicate is removed');
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].message, /1 个重复文件/, 'toast reports actual removed count (1), not total extra (2)');
    window.close();
});

test('MusicStatsView traps Tab focus inside dialog and restores on Escape', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const opener = window.document.getElementById('opener');
    opener.focus();
    window.requestAnimationFrame = (fn) => { fn(0); return 0; };
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-stats-view.js'), 'utf8'));
    const app = {
        playlist: [],
        musicStats: {
            summary: () => ({ plays: 0, seconds: 0, days: 0, hours: new Array(24).fill(0), tracks: [], artists: [], albums: [], daily: {} })
        }
    };
    window.MusicStatsView.open(app);
    const focusables = [...window.document.querySelectorAll('.music-stats-dialog button:not([disabled]):not([hidden])')];
    assert.ok(focusables.length >= 2);
    focusables[0].focus();
    const shiftTab = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(shiftTab);
    assert.equal(shiftTab.defaultPrevented, true);
    assert.equal(window.document.activeElement, focusables[focusables.length - 1]);
    const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    assert.equal(window.document.activeElement, opener);
    window.close();
});

test('music-sidebar getAlbumGroups and getArtistGroups handle Object.prototype property names safely', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><div id="all-count"></div><ul id="playlist"></ul><div id="sidebar-category-view"></div></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-sidebar.js'), 'utf8'));
    const app = {
        playlist: [
            { title: 'A', album: 'constructor', artist: 'toString' },
            { title: 'B', album: 'constructor', artist: 'valueOf' },
            { title: 'C', album: '__proto__', artist: 'toString' }
        ],
        playlistEl: window.document.getElementById('playlist'),
        sidebarFooter: window.document.createElement('div'),
        renderPlaylist() {}
    };
    window.setupSidebar(app);
    const albums = app.getAlbumGroups();
    const artists = app.getArtistGroups();
    assert.equal(albums.length, 2);
    assert.equal(albums[0].name, 'constructor');
    assert.equal(albums[0].tracks.length, 2);
    assert.equal(albums[1].name, '__proto__');
    assert.equal(artists.length, 2);
    assert.equal(artists[0].name, 'toString');
    assert.equal(artists[0].tracks.length, 2);
    assert.equal(artists[1].name, 'valueOf');
    window.close();
});

test('music-spectrum reopens after mid-read close without stale overwrites and computes 1ch/2ch columns', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    window.requestAnimationFrame = (fn) => { fn(0); return 0; };
    window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-spectrum.js'), 'utf8'));

    // Pure FFT/columns fast paths (mono & stereo)
    const sampleRate = 44100;
    const len = 4096 * 4;
    const chL = new Float32Array(len);
    const chR = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        const v = Math.sin(2 * Math.PI * 1000 * i / sampleRate) * 0.5;
        chL[i] = v;
        chR[i] = v;
    }
    const mono = window.MusicSpectrum.spectrumColumns([chL], { columns: 4 });
    const stereo = window.MusicSpectrum.spectrumColumns([chL, chR], { columns: 4 });
    assert.equal(mono.columns.length, 4);
    assert.equal(stereo.columns.length, 4);
    assert.equal(mono.loud, 4);
    assert.ok(Math.abs(mono.average[93] - stereo.average[93]) < 1e-4, 'identical stereo matches mono spectrum');

    // Reopen race: close while Track A read is pending, reopen on Track B, then resolve Track A
    let resolveA;
    let calls = 0;
    const app = {
        playlist: [
            { path: 'C:\\Music\\A.flac', title: 'Track A' },
            { path: 'C:\\Music\\B.flac', title: 'Track B' }
        ],
        currentTrackIndex: 0,
        api: {
            readMusicAudioFile: ({ path: p }) => {
                calls++;
                if (p.endsWith('A.flac')) return new Promise((r) => { resolveA = r; });
                return Promise.resolve({ ok: false, message: 'B 读不到' });
            }
        }
    };
    const pA = window.MusicSpectrum.open(app, 0);
    // Close first modal while Track A is still reading
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // Immediately reopen on Track B — must not be blocked by stale busy flag
    await window.MusicSpectrum.open(app, 1);
    assert.equal(calls, 2);
    const dialogs = window.document.querySelectorAll('.mspec');
    const latestStatus = dialogs[dialogs.length - 1].querySelector('.mspec-status').textContent;
    assert.equal(latestStatus, 'B 读不到');

    // Now stale Track A resolves — must NOT overwrite Track B's status
    resolveA({ ok: false, message: '过期的 A 错误' });
    await pA;
    assert.equal(dialogs[dialogs.length - 1].querySelector('.mspec-status').textContent, 'B 读不到');
    window.close();
});

test('empty musicStats table short-circuits lookups and resumes once a play is recorded', () => {
    const { app, stats, play } = setup();
    assert.equal(stats.get(app.playlist[0]), null);
    assert.equal(stats.affinity(app.playlist[0]), 0);
    assert.deepEqual(stats.top(5), []);
    assert.deepEqual(stats.lastPlayed(5), []);
    assert.deepEqual(stats.forgotten(), []);
    play(105);
    assert.equal(stats.get(app.playlist[0]).plays, 1);
    assert.ok(stats.affinity(app.playlist[0]) > 0);
    assert.deepEqual(stats.top(5, { minPlays: 1 }), ['C:\\Music\\A.flac']);
});

test('musicStats.flush skips redundant localStorage writes when clean and flushes unsaved seconds', () => {
    let t = 1_000_000_000;
    let writes = 0;
    const store = new Map();
    const storage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => { if (k === 'musicPlayStats' || k === 'musicListenLog') writes += 1; store.set(k, v); },
        removeItem: (k) => store.delete(k)
    };
    globalThis.document = { dispatchEvent() {} };
    globalThis.CustomEvent = class { constructor(type, init) { this.detail = init?.detail; } };
    const app = {
        playlist: [{ path: 'C:\\Music\\A.flac', duration: 200 }],
        currentTrackIndex: 0, isPlaying: false, isTrackLoading: false, lastKnownDuration: 200, pos: 0,
        playedSeconds: () => app.pos
    };
    const stats = setupMusicStats(app, { now: () => t, storage, setTimer: () => 1, clearTimer() {}, observe: false });
    stats.flush();
    assert.equal(writes, 0, 'clean flush performs zero storage writes');

    app.isPlaying = true;
    for (let i = 0; i < 5; i++) { t += 1000; app.pos += 1; stats.tick(); }
    stats.flush();
    assert.equal(writes, 2, 'flush with unsaved seconds writes stats and log once');
    stats.flush();
    assert.equal(writes, 2, 'second consecutive flush skips redundant writes');
});

test('Batch 58: stats/track-file/dupes dialogs yield Escape when a MusicDialog confirm is stacked above and clean up immediately on beforeunload', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
    try {
        const { window } = dom;
        const doc = window.document;
        window.requestAnimationFrame = (fn) => { fn(); return 1; };
        window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-stats-view.js'), 'utf8'));
        const app = {
            playlist: [],
            musicStats: { summary: () => ({ seconds: 0, plays: 0, activeDays: 0, hours: new Array(24).fill(0), tracks: [], daily: {} }) }
        };
        window.MusicStatsView.open(app);
        const statsOverlay = doc.querySelector('.music-stats-dialog');
        assert.ok(statsOverlay && statsOverlay.classList.contains('visible'));

        // Simulate a MusicDialog confirm stacked on top -> Escape must NOT dismiss underlying stats dialog
        const confirmOverlay = doc.createElement('div');
        confirmOverlay.className = 'dialog-overlay music-dialog visible';
        doc.body.appendChild(confirmOverlay);
        doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert.ok(statsOverlay.classList.contains('visible'), 'stats dialog yields Escape while a MusicDialog is open above it');
        confirmOverlay.remove();

        // beforeunload removes stats overlay synchronously without dangling timeout
        window.dispatchEvent(new window.Event('beforeunload'));
        assert.equal(doc.querySelector('.music-stats-dialog'), null, 'beforeunload removes overlay immediately');
    } finally {
        dom.window.close();
    }
});

test('Batch 73: stats skips redundant queue-change ticks for same track, MusicMotion ignores no-op set, and M3U throttles dragover/dragenter', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    // 1. music-stats onQueueChange short-circuits pure queue edits on unchanged playing track
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const prevDoc = globalThis.document;
    const prevCE = globalThis.CustomEvent;
    const prevMO = globalThis.MutationObserver;
    try {
        const { window } = dom;
        globalThis.document = window.document;
        globalThis.CustomEvent = window.CustomEvent;
        globalThis.MutationObserver = window.MutationObserver;
        let posCalls = 0;
        const app = {
            playlist: [{ path: 'C:\\Music\\A.flac', duration: 200 }, { path: 'C:\\Music\\B.flac', duration: 200 }],
            currentTrackIndex: 0,
            isPlaying: false,
            isTrackLoading: false,
            lastKnownDuration: 200,
            playedSeconds: () => { posCalls += 1; return 20; }
        };
        const store = new Map();
        const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
        setupMusicStats(app, { storage, setTimer: () => 1, clearTimer() {}, observe: true });
        const afterInit = posCalls;
        for (let i = 0; i < 10; i += 1) {
            window.document.dispatchEvent(new window.CustomEvent('music-queue-change'));
        }
        assert.equal(posCalls, afterInit, 'pure queue edits with unchanged track/play-state skip redundant tick()');
        app.currentTrackIndex = 1;
        window.document.dispatchEvent(new window.CustomEvent('music-queue-change'));
        assert.ok(posCalls > afterInit, 'switching track triggers tick() immediately on music-queue-change');

        // 2. MusicMotion.set skips redundant storage write when preference is unchanged
        let motionWrites = 0;
        const origSet = window.Storage.prototype.setItem;
        window.Storage.prototype.setItem = function (k, v) {
            if (k === 'musicReducedMotion') motionWrites += 1;
            return origSet.call(this, k, v);
        };
        window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-theme/music-motion.js'), 'utf8'));
        window.MusicMotion.set('system');
        assert.equal(motionWrites, 0, 'setting unchanged preference skips localStorage write');
        window.MusicMotion.set('on');
        window.MusicMotion.set('on');
        assert.equal(motionWrites, 1, 'setting new preference writes once and ignores duplicate');

        // 3. MusicM3u onDragEnter triggers showHint rAF only on depth 0->1 and onDragOver throttles timer resets
        let rafCalls = 0;
        let timeoutCalls = 0;
        window.requestAnimationFrame = () => { rafCalls += 1; return rafCalls; };
        window.cancelAnimationFrame = () => {};
        const origSetTimeout = window.setTimeout.bind(window);
        window.setTimeout = (fn, ms) => { timeoutCalls += 1; return origSetTimeout(fn, ms); };
        window.eval(fs.readFileSync(path.join(__dirname, '..', 'Musicmodules/music-m3u.js'), 'utf8'));
        const m3uApp = {
            api: { importMusicM3u: async () => ({ ok: false, canceled: true }), exportMusicM3u: async () => ({ ok: false, canceled: true }), getPathForFile: () => '' }
        };
        window.MusicM3u.setupMusicM3u(m3uApp);
        const mkDrag = (type) => {
            const ev = new window.Event(type, { bubbles: true });
            ev.dataTransfer = { types: ['Files'] };
            return ev;
        };
        window.document.dispatchEvent(mkDrag('dragenter'));
        window.document.dispatchEvent(mkDrag('dragenter'));
        window.document.dispatchEvent(mkDrag('dragenter'));
        assert.equal(rafCalls, 1, 'nested dragenter only schedules showHint rAF on initial 0->1 entry');
        const beforeOver = timeoutCalls;
        for (let i = 0; i < 5; i += 1) window.document.dispatchEvent(mkDrag('dragover'));
        assert.equal(timeoutCalls - beforeOver, 1, 'rapid dragover events throttle idle-hide timer re-arm');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        globalThis.document = prevDoc;
        globalThis.CustomEvent = prevCE;
        globalThis.MutationObserver = prevMO;
        dom.window.close();
    }
});

test('Batch 76: dupes normalizes playlist paths on remap/undo, folders batches queue removal, stats-view skips active-range re-render, and track-file resets copy failure', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    const doc = window.document;
    try {
        window.requestAnimationFrame = (fn) => { fn(0); return 0; };
        const toasts = [];
        window.MusicToast = { show: (o) => toasts.push(o) };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-radio.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-dupes.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-folders.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-stats-view.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-track-file.js'), 'utf8'));

        // 1. music-dupes: Windows slash/case normalization in customPlaylists remap & restore on undo
        const plSaved = [];
        const dupesApp = {
            playlist: [
                { path: 'C:\\Music\\Keep.flac', title: 'Same', artist: 'Art', duration: 200, bitrate: 1000, size: 1000 },
                { path: 'C:\\Music\\Drop.mp3', title: 'Same', artist: 'Art', duration: 200, bitrate: 128, size: 200 }
            ],
            currentTrackIndex: -1,
            customPlaylists: [
                { id: 'p1', name: 'Mix', tracks: ['c:/music/drop.mp3', 'C:\\Music\\Other.flac'] },
                { id: 'p2', name: 'Untouched', tracks: ['C:\\Music\\Other.flac'] }
            ],
            saveCustomPlaylists: () => plSaved.push(dupesApp.customPlaylists.map((p) => p.tracks.slice())),
            saveLibrary: () => {},
            renderPlaylist: () => {}
        };
        const p2Ref = dupesApp.customPlaylists[1].tracks;
        window.MusicDupes.open(dupesApp);
        doc.querySelector('.mdupes-remove').click();
        assert.deepEqual([...dupesApp.customPlaylists[0].tracks], ['C:\\Music\\Keep.flac', 'C:\\Music\\Other.flac'], 'Windows slash/case playlist path remapped to kept track');
        assert.equal(dupesApp.customPlaylists[1].tracks, p2Ref, 'unmodified playlist tracks array untouched');
        assert.equal(toasts.length, 1);
        toasts[0].action.run();
        assert.deepEqual([...dupesApp.customPlaylists[0].tracks], ['c:/music/drop.mp3', 'C:\\Music\\Other.flac'], 'undo restores original playlist tracks');

        // 2. music-folders: removeFolder batches manualQueue removals via app.queueBatch and guards re-entrancy
        let batchCalls = 0;
        const removedQueue = [];
        let resolveForget = null;
        let forgetCalls = 0;
        const t1 = { path: 'C:\\Music\\A\\1.flac', title: '1' };
        const t2 = { path: 'C:\\Music\\A\\2.flac', title: '2' };
        const t3 = { path: 'C:\\Music\\B\\3.flac', title: '3' };
        const foldersApp = {
            playlist: [t1, t2, t3],
            currentTrackIndex: 2,
            manualQueue: [t1, t3, t2],
            queueBatch: (fn) => { batchCalls += 1; fn(); },
            queueRemove: (i) => { removedQueue.push(i); foldersApp.manualQueue.splice(i, 1); },
            saveLibrary: () => {},
            renderPlaylist: () => {},
            api: {
                musicLibraryFolders: async ({ op }) => {
                    if (op === 'list') return { ok: true, folders: [{ path: 'C:\\Music\\A', exists: true }, { path: 'C:\\Music\\B', exists: true }] };
                    if (op === 'forget') { forgetCalls += 1; await new Promise((r) => { resolveForget = r; }); return { ok: true }; }
                    return { ok: true };
                }
            }
        };
        window.MusicDialog = { confirm: async () => true };
        window.MusicFolders.setupMusicFolders(foldersApp);
        foldersApp.openLibraryFolders();
        await new Promise((r) => setTimeout(r, 10));
        const rmBtn = doc.querySelector('.mfold-remove');
        assert.ok(rmBtn);
        rmBtn.click();
        rmBtn.click(); // concurrent second click ignored while removing
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(forgetCalls, 1, 're-entrancy guard blocks overlapping removeFolder clicks');
        resolveForget();
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(batchCalls, 1, 'manualQueue removals wrapped in a single app.queueBatch');
        assert.deepEqual(removedQueue, [2, 0], 'reverse-order removal deletes indices 2 then 0 safely');
        assert.deepEqual([...foldersApp.manualQueue], [t3]);
        window.dispatchEvent(new window.Event('beforeunload'));

        // 3. music-stats-view: clicking already-active range tab skips redundant summary/render
        let summaryCalls = 0;
        const statsApp = {
            playlist: [{ path: 'C:\\Music\\A.flac', title: 'A', artist: 'X' }],
            musicStats: {
                summary: () => {
                    summaryCalls += 1;
                    return { plays: 1, seconds: 60, activeDays: 1, hours: new Array(24).fill(0), tracks: [], daily: {} };
                }
            }
        };
        window.MusicStatsView.open(statsApp);
        const afterOpen = summaryCalls;
        const activeTab = doc.querySelector('.mstats-range button.active');
        assert.ok(activeTab);
        activeTab.click();
        assert.equal(summaryCalls, afterOpen, 'clicking already-active range tab skips redundant render');
        window.dispatchEvent(new window.Event('beforeunload'));

        // 4. music-track-file: failed copy resets button label from 复制失败 back to 复制路径
        const origTimer = window.setTimeout;
        const timers = [];
        window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
        Object.defineProperty(window.navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async () => { throw new Error('denied'); } }
        });
        const tfApp = { api: { showMusicInFolder: async () => ({ ok: true }) } };
        window.MusicTrackFile.setupMusicTrackFile(tfApp);
        tfApp.openTrackInfo({ path: 'C:\\Music\\A.flac', title: 'A', artist: 'X' });
        const copyBtn = [...doc.querySelectorAll('.minfo-actions .minfo-btn')].find((b) => b.textContent === '复制路径');
        assert.ok(copyBtn);
        copyBtn.click();
        await new Promise((r) => origTimer(r, 10));
        assert.equal(copyBtn.textContent, '复制失败');
        const resetTimer = timers.find((t) => t.ms === 1600);
        assert.ok(resetTimer, 'failed copy schedules 1600ms label reset timer');
        resetTimer.fn();
        assert.equal(copyBtn.textContent, '复制路径');
        window.setTimeout = origTimer;
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});

test('Batch 85: spectrum cached FFT & prefix-sum findCutoff match exact math, spectrum/stats mark data-closing=1, and M3U decodes GB18030/UTF16/BOM', () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    // 1. Spectrum cached FFT plan, prefix-sum findCutoff, and data-closing=1 on close
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        window.requestAnimationFrame = (fn) => { fn(0); return 0; };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-spectrum.js'), 'utf8'));
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-stats-view.js'), 'utf8'));

        // Verify radix-2 FFT accuracy against pure sine bin (k = 16 in N = 256)
        const N = 256;
        const re = new Float32Array(N);
        const im = new Float32Array(N);
        for (let i = 0; i < N; i += 1) re[i] = Math.cos((2 * Math.PI * 16 * i) / N);
        window.MusicSpectrum.fft(re, im);
        assert.ok(Math.abs(re[16] - N / 2) < 1e-3, `FFT bin 16 real peak expected ~128, got ${re[16]}`);
        assert.ok(Math.abs(im[16]) < 1e-3, `FFT bin 16 imag expected ~0, got ${im[16]}`);
        assert.ok(Math.abs(re[0]) < 1e-3, `FFT DC expected ~0, got ${re[0]}`);

        // Verify prefix-sum findCutoff locates sharp 16 kHz brickwall drop
        const sr = 44100;
        const bins = 2048;
        const avg = new Float32Array(bins);
        const cutBin = Math.round((16000 * 2 * bins) / sr);
        for (let k = 0; k < bins; k += 1) avg[k] = k < cutBin ? -20 : -95;
        const detected = window.MusicSpectrum.findCutoff(avg, sr);
        assert.ok(Math.abs(detected - 16000) < 350, `expected cutoff ~16000 Hz, got ${detected}`);

        // Verify spectrum and stats-view overlays mark data-closing="1" on close
        const app = {
            playlist: [{ path: 'C:\\Music\\A.flac', title: 'A', artist: 'X' }],
            currentTrackIndex: 0,
            api: { readMusicAudioFile: () => new Promise(() => {}) },
            musicStats: { summary: () => ({ plays: 1, seconds: 600, activeDays: 1, hours: new Array(24).fill(0), tracks: [], daily: { '2026-11-27': 600 } }) }
        };
        window.MusicSpectrum.setupMusicSpectrum(app);
        window.MusicStatsView.setupMusicStatsView(app);
        app.openSpectrum(0);
        const specOv = doc.querySelector('.mspec').closest('.dialog-overlay');
        specOv.querySelector('.mstats-close').click();
        assert.equal(specOv.dataset.closing, '1', 'music-spectrum marks data-closing=1 on close');

        app.openStatsView();
        const statsOv = doc.querySelector('.music-stats-dialog');
        statsOv.querySelector('.mstats-close').click();
        assert.equal(statsOv.dataset.closing, '1', 'music-stats-view marks data-closing=1 on close');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }

    // 2. M3U decodeM3u (BOM / UTF-16LE / UTF-16BE / GBK) & parseM3u hoisted regexes
    const m3u = require('../modules/ipc/musicM3u');
    const bomUtf8 = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('#EXTM3U\n#PLAYLIST:夜航\n#EXTINF:210,A - B\na.flac\n', 'utf8')]);
    assert.ok(m3u.decodeM3u(bomUtf8, 'x.m3u').startsWith('#EXTM3U'));
    const u16le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('#EXTM3U\nabc.mp3', 'utf16le')]);
    assert.equal(m3u.decodeM3u(u16le, 'x.m3u'), '#EXTM3U\nabc.mp3');
    const u16beBody = Buffer.from('#EXTM3U\nabc.mp3', 'utf16le');
    u16beBody.swap16();
    const u16be = Buffer.concat([Buffer.from([0xFE, 0xFF]), u16beBody]);
    assert.equal(m3u.decodeM3u(u16be, 'x.m3u'), '#EXTM3U\nabc.mp3');
    // GBK bytes for "中文" = 0xD6 0xD0 0xCE 0xC4
    const gbkBuf = Buffer.from([0x23, 0x50, 0x4C, 0x41, 0x59, 0x4C, 0x49, 0x53, 0x54, 0x3A, 0xD6, 0xD0, 0xCE, 0xC4]);
    assert.equal(m3u.decodeM3u(gbkBuf, 'legacy.m3u'), '#PLAYLIST:中文');
    const parsed = m3u.parseM3u('#EXTM3U\r\n#PLAYLIST:夜航\r\n#EXTINF:125,歌手 - 曲名\r\nsub/1.flac\r\nhttps://example.com/a.mp3\r\n', {
        baseDir: 'D:\\Music',
        platform: 'win32'
    });
    assert.equal(parsed.name, '夜航');
    assert.equal(parsed.skipped, 1);
    assert.deepEqual(parsed.entries, [{ path: 'D:\\Music\\sub\\1.flac', title: '歌手 - 曲名', duration: 125 }]);
});

test('Batch 92: stats summary single-pass firstDay/hours/plays, resume path normalization, and spectrum cached row LUT', () => {
    const day1 = '2026-11-20';
    const day2 = '2026-11-27';
    const baseMs = Date.parse('2026-11-27T12:00:00');
    const store = new Map([
        ['musicPlayStats', JSON.stringify({
            v: 1,
            t: {
                'c:/music/a.flac': [5, baseMs - 1000, 0, baseMs - 50000, 'C:\\Music\\A.flac'],
                'c:/music/b.flac': [2, baseMs - 2000, 1, baseMs - 60000, 'C:\\Music\\B.flac']
            }
        })],
        ['musicListenLog', JSON.stringify({
            v: 1,
            d: {
                [day1]: { s: Object.assign(new Array(24).fill(0), { 9: 120.4 }), p: { 'c:/music/a.flac': 2 } },
                [day2]: { s: Object.assign(new Array(24).fill(0), { 9: 80.2, 22: 59.6 }), p: { 'c:/music/b.flac': 1 } }
            }
        })],
        ['musicPlayResume', JSON.stringify({ path: 'c:/music/a.flac', position: 42, at: baseMs - 500 })]
    ]);
    const storage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k)
    };
    const app = {
        playlist: [{ path: 'C:\\Music\\A.flac', title: 'A', duration: 200 }],
        currentTrackIndex: 0,
        isPlaying: false,
        isTrackLoading: false,
        playedSeconds: () => 0
    };
    const stats = setupMusicStats(app, { now: () => baseMs, storage, setTimer: () => 1, clearTimer() {}, observe: false });
    const res = stats.resume();
    assert.ok(res && res.track === app.playlist[0] && res.position === 42, 'resume matches normalized slash/case track path');

    const allSum = stats.summary({ days: 0 });
    assert.equal(allSum.since, day1, 'since finds earliest day across full log');
    assert.equal(allSum.plays, 7, 'all-time summary uses total table plays');
    assert.equal(allSum.activeDays, 2);
    assert.equal(allSum.hours[9], 201, 'hours sums and rounds cleanly across days');
    assert.equal(allSum.hours[22], 60);
    assert.equal(allSum.tracks[0].path, 'C:\\Music\\A.flac');

    const recentSum = stats.summary({ days: 3 });
    assert.equal(recentSum.since, day1, 'since still records earliest log day even when filtered to recent days');
    assert.equal(recentSum.plays, 1, 'windowed summary only counts plays within days window');
    assert.equal(recentSum.activeDays, 1);
    assert.equal(recentSum.tracks.length, 1);
    assert.equal(recentSum.tracks[0].path, 'C:\\Music\\B.flac');
});

test('Batch 99: stats has/top/forgotten/pruning, spectrum focus-before-hide, grooveBus zero-listener fast path, matchScore & IR presets', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { JSDOM } = require('jsdom');

    // 1. music-stats: has(), top(), lastPlayed(), forgotten(), affinity(), and 400-day log pruning
    const baseMs = Date.parse('2026-11-27T12:00:00');
    const oldMs = baseMs - 45 * 86400000;
    const store = new Map([
        ['musicPlayStats', JSON.stringify({
            v: 1,
            t: {
                'c:/m/hot.flac': [6, baseMs - 1000, 0, oldMs, 'C:\\M\\Hot.flac'],
                'c:/m/old.flac': [4, oldMs, 0, oldMs - 1000, 'C:\\M\\Old.flac'],
                'c:/m/skip.flac': [0, 0, 2, 0, 'C:\\M\\Skip.flac']
            }
        })]
    ]);
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    const app = { playlist: [], currentTrackIndex: -1, isPlaying: false, isTrackLoading: false, playedSeconds: () => 0 };
    const stats = setupMusicStats(app, { now: () => baseMs, storage, setTimer: () => 1, clearTimer() {}, observe: false });
    assert.equal(stats.has('C:\\M\\Hot.flac'), true);
    assert.equal(stats.has({ path: 'c:/m/skip.flac' }), true, 'skipped-only track counts as known for has()');
    assert.equal(stats.has('C:\\M\\New.flac'), false);
    assert.deepEqual(stats.top(2, { minPlays: 2 }), ['C:\\M\\Hot.flac', 'C:\\M\\Old.flac']);
    assert.deepEqual(stats.lastPlayed(2), ['C:\\M\\Hot.flac', 'C:\\M\\Old.flac']);
    assert.deepEqual(stats.forgotten({ minPlays: 3, days: 30, limit: 5 }), ['C:\\M\\Old.flac']);
    assert.equal(stats.affinity('C:\\M\\Skip.flac'), 0);
    assert.ok(stats.affinity('C:\\M\\Hot.flac') > 0.4);

    // 2. music-spectrum: close() restores opener focus BEFORE removing .visible and avoids body.focus()
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        window.requestAnimationFrame = (fn) => { fn(0); return 0; };
        window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-spectrum.js'), 'utf8'));
        const opener = doc.getElementById('opener');
        opener.focus();
        const order = [];
        const origFocus = opener.focus.bind(opener);
        opener.focus = (opts) => { order.push('focus'); return origFocus(opts); };
        const specApp = {
            playlist: [{ path: 'C:\\M\\Hot.flac', title: 'Hot' }],
            currentTrackIndex: 0,
            api: { readMusicAudioFile: () => new Promise(() => {}) }
        };
        window.MusicSpectrum.setupMusicSpectrum(specApp);
        specApp.openSpectrum(0);
        const ov = doc.querySelector('.music-stats-dialog');
        const origRemove = ov.classList.remove.bind(ov.classList);
        ov.classList.remove = (...args) => { if (args.includes('visible')) order.push('hide'); return origRemove(...args); };
        ov.querySelector('.mstats-close').click();
        assert.deepEqual(order, ['focus', 'hide'], 'spectrum close restores opener focus before removing .visible');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }

    // 3. musicGrooveBus: validates and throttles with 0 subscribers, delivers copy when subscribed
    const grooveBus = require('../modules/services/musicGrooveBus');
    assert.equal(grooveBus.publish({ playing: true, data: [0.5], trackKey: 'a' }, 10000), true);
    assert.equal(grooveBus.publish({ playing: true, data: [0.5], trackKey: 'a' }, 10010), false, 'throttled within 40ms even with 0 listeners');
    assert.equal(grooveBus.publish({ playing: true, data: [2.0], trackKey: 'a' }, 10100), false, 'out-of-range sample rejected');
    const seen = [];
    const unsub = grooveBus.subscribe((snap) => seen.push(snap));
    assert.equal(grooveBus.publish({ playing: true, data: [0.25, 0.75], trackKey: 'k1' }, 10200), true);
    unsub();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { playing: true, trackKey: 'k1', data: [0.25, 0.75] });

    // 4. matchScore & musicEngineHandlers IR preset listing/lookup
    const { calculateMatchScore } = require('../modules/lyrics/matchScore');
    const exact = calculateMatchScore(
        { title: 'Starlight', artist: 'Aimer / Sawano', album: 'Dawn', durationMs: 240000 },
        { title: 'Starlight', artist: 'Aimer, Sawano', album: 'Dawn', durationMs: 240200 }
    );
    assert.equal(exact.score, 100);
    assert.equal(exact.artistMatched, true);

    const { registerMusicEngineHandlers } = require('../modules/ipc/musicEngineHandlers');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmusic-ir-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'Hall.A.wav'), '');
        fs.writeFileSync(path.join(tmpDir, 'Plate.FLAC'), '');
        fs.writeFileSync(path.join(tmpDir, '.wav'), '');
        fs.writeFileSync(path.join(tmpDir, 'notes.txt'), '');
        const handlers = new Map();
        registerMusicEngineHandlers({
            ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
            dialog: {},
            audioEngineApi: async () => ({}),
            webdavManager: {},
            irPresetDir: tmpDir
        });
        const list = await handlers.get('music-list-ir-presets')();
        assert.deepEqual(list.slice().sort(), ['Hall.A', 'Plate']);
        assert.equal(await handlers.get('music-get-ir-preset-path')({}, 'Hall.A'), path.join(tmpDir, 'Hall.A.wav'));
        assert.equal(await handlers.get('music-get-ir-preset-path')({}, 'notes'), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Batch 101: dupes/track-file/folders/stats-view restore opener focus before removing .visible and avoid body.focus()', async () => {
    const fs = require('node:fs');
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
    try {
        const { window } = dom;
        const doc = window.document;
        window.requestAnimationFrame = (fn) => { fn(0); return 0; };
        for (const f of ['music-dupes.js', 'music-track-file.js', 'music-folders.js', 'music-stats-view.js']) {
            window.eval(fs.readFileSync(path.join(__dirname, '../Musicmodules', f), 'utf8'));
        }
        const opener = doc.getElementById('opener');
        const origFocus = opener.focus.bind(opener);
        let bodyFocused = 0;
        const origBodyFocus = doc.body.focus.bind(doc.body);
        doc.body.focus = (...args) => { bodyFocused += 1; return origBodyFocus(...args); };

        const checkOrder = async (label, openFn, overlaySel, closeSel) => {
            const order = [];
            opener.focus = (opts) => { order.push('focus'); return origFocus(opts); };
            origFocus();
            await openFn();
            const ov = doc.querySelector(overlaySel);
            assert.ok(ov, `${label} mounted`);
            const origRemove = ov.classList.remove.bind(ov.classList);
            ov.classList.remove = (...args) => { if (args.includes('visible')) order.push('hide'); return origRemove(...args); };
            ov.querySelector(closeSel).click();
            assert.deepEqual(order, ['focus', 'hide'], `${label} restores opener focus before removing .visible`);
            ov.remove();
        };

        const baseApp = {
            playlist: [
                { path: 'C:\\M\\A.flac', title: 'Same', artist: 'X', duration: 200 },
                { path: 'C:\\M\\B.mp3', title: 'Same', artist: 'X', duration: 200 }
            ],
            currentTrackIndex: 0,
            api: { musicLibraryFolders: async () => ({ ok: true, folders: [] }), showMusicInFolder: async () => ({ ok: true }) },
            musicStats: { summary: () => ({ plays: 1, seconds: 60, activeDays: 1, hours: new Array(24).fill(0), tracks: [], daily: {} }) }
        };
        window.MusicTrackFile.setupMusicTrackFile(baseApp);
        window.MusicFolders.setupMusicFolders(baseApp);
        await checkOrder('MusicDupes', () => window.MusicDupes.open(baseApp), '.music-stats-dialog', '.mstats-close');
        await checkOrder('MusicTrackFile', () => baseApp.openTrackInfo(baseApp.playlist[0]), '.music-stats-dialog', '.mstats-close');
        await checkOrder('MusicFolders', async () => { baseApp.openLibraryFolders(); await new Promise((r) => setTimeout(r, 10)); }, '.music-stats-dialog', '.mstats-close');
        await checkOrder('MusicStatsView', () => window.MusicStatsView.open(baseApp), '.music-stats-dialog', '.mstats-close');

        // When opened with focus on document.body, closing blurs dialog element without calling body.focus()
        opener.focus = origFocus;
        doc.activeElement?.blur?.();
        bodyFocused = 0;
        window.MusicStatsView.open(baseApp);
        const ov = doc.querySelector('.music-stats-dialog');
        ov.querySelector('.mstats-close').click();
        assert.equal(bodyFocused, 0, 'closing dialog opened from body never calls body.focus()');
        window.dispatchEvent(new window.Event('beforeunload'));
    } finally {
        dom.window.close();
    }
});
