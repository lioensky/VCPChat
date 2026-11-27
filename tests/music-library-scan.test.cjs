const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanFolder, collectAudioFiles, fillFolderCovers } = require('../modules/musicLibraryScanner');

// 曲库扫描的三条约定：同时在读的文件有上限、没动过的文件不再读、结果按磁盘顺序且途中成批送出。
// 解析这一步换成假 worker，不依赖真实音频文件。

const FAKE_WORKER = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
parentPort.on('message', async ({ id, filePath }) => {
    await new Promise((r) => setTimeout(r, 4));
    if (/broken/.test(filePath)) return parentPort.postMessage({ status: 'error', id, error: 'bad file', path: filePath });
    if (/crash/.test(filePath)) process.exit(3);
    fs.appendFileSync(workerData.coverCachePath + '/parsed.log', filePath + '\\n');
    parentPort.postMessage({ status: 'success', id, data: { path: filePath, title: require('path').basename(filePath), albumArt: null } });
});`;

function library(names) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scan-test-'));
    const music = path.join(root, 'music');
    for (const name of names) {
        const file = path.join(music, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'x'.repeat(16));
    }
    const workerFile = path.join(root, 'fake-worker.js');
    fs.writeFileSync(workerFile, FAKE_WORKER);
    return { root, music, cache: path.join(root, 'covers'), workerFile };
}
const parsedLog = (lib) => { try { return fs.readFileSync(path.join(lib.cache, 'parsed.log'), 'utf8').trim().split('\n').filter(Boolean); } catch (_) { return []; } };

test('walks folders in a stable order and ignores other files', async () => {
    const lib = library(['b/2.flac', 'a/1.mp3', 'a/cover.jpg', 'a/sub/3.ogg', 'z.WAV', 'notes.txt']);
    const files = (await collectAudioFiles(lib.music)).map((f) => path.relative(lib.music, f).split(path.sep).join('/'));
    assert.deepEqual(files, ['z.WAV', 'a/1.mp3', 'a/sub/3.ogg', 'b/2.flac']);
});

test('returns tracks in disk order with size and mtime, batches them, throttles progress', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `d${String(i % 5)}/t${String(i).padStart(3, '0')}.mp3`);
    const lib = library(names);
    const batches = [];
    const progress = [];
    let started = null;
    const result = await scanFolder({
        folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile, workerCount: 3,
        onStart: (info) => { started = info; }, onProgress: (p) => progress.push(p), onBatch: (b) => batches.push(b)
    });
    assert.equal(started.total, 150);
    assert.equal(result.tracks.length, 150);
    assert.deepEqual(result.tracks.map((t) => t.path), await collectAudioFiles(lib.music));
    assert.ok(result.tracks.every((t) => t.size === 16 && Number.isFinite(t.mtimeMs)));
    assert.equal(batches.flat().length, 150, 'every parsed track is delivered in a batch exactly once');
    assert.ok(batches.length >= 3 && batches.length < 40, `batched, not one message per file (got ${batches.length})`);
    assert.ok(progress.length < 75, `progress is throttled (got ${progress.length} for 150 files)`);
    assert.deepEqual(progress.at(-1), { current: 150, total: 150, reused: 0 });
    assert.deepEqual(result.stats.parsed, 150);
});

test('never holds more files open than workers x perWorkerInFlight', async () => {
    const lib = library(Array.from({ length: 120 }, (_, i) => `t${i}.flac`));
    const wrapper = path.join(lib.root, 'counting-worker.js');
    // 每个 worker 把自己手里同时有几个文件记到日志里。
    fs.writeFileSync(wrapper, `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
let open = 0;
parentPort.on('message', async ({ id, filePath }) => {
    open++;
    fs.appendFileSync(workerData.coverCachePath + '/open.log', open + '\\n');
    await new Promise((r) => setTimeout(r, 3));
    open--;
    parentPort.postMessage({ status: 'success', id, data: { path: filePath, title: 't', albumArt: null } });
});`);
    await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: wrapper, workerCount: 2, tuning: { perWorkerInFlight: 2 } });
    const peaks = fs.readFileSync(path.join(lib.cache, 'open.log'), 'utf8').trim().split('\n').map(Number);
    assert.equal(peaks.length, 120);
    assert.ok(Math.max(...peaks) <= 2, `one worker held ${Math.max(...peaks)} files at once`);
});

test('a rescan reads only files that changed', async () => {
    const lib = library(['a/1.mp3', 'a/2.mp3', 'b/3.mp3']);
    const first = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile });
    assert.equal(parsedLog(lib).length, 3);
    fs.rmSync(path.join(lib.cache, 'parsed.log'));

    // 改一个、加一个、删一个
    const changed = path.join(lib.music, 'a', '2.mp3');
    fs.writeFileSync(changed, 'y'.repeat(40));
    fs.writeFileSync(path.join(lib.music, 'b', '4.mp3'), 'z');
    fs.rmSync(path.join(lib.music, 'a', '1.mp3'));
    const batches = [];
    const second = await scanFolder({
        folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile,
        knownTracks: first.tracks, onBatch: (b) => batches.push(...b)
    });
    assert.deepEqual(parsedLog(lib).map((f) => path.basename(f)).sort(), ['2.mp3', '4.mp3']);
    assert.deepEqual(second.tracks.map((t) => path.basename(t.path)), ['2.mp3', '3.mp3', '4.mp3']);
    assert.equal(second.stats.reused, 1);
    assert.equal(second.tracks.find((t) => t.path === changed).size, 40);
    assert.deepEqual(batches.map((t) => path.basename(t.path)).sort(), ['2.mp3', '4.mp3'], 'unchanged tracks are not sent again');
});

test('an unchanged track whose cached cover is gone is read again; tracks from old lists are read again', async () => {
    const lib = library(['1.mp3', '2.mp3', '3.mp3']);
    const first = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile });
    fs.rmSync(path.join(lib.cache, 'parsed.log'));
    const cover = path.join(lib.cache, 'kept.jpg');
    fs.writeFileSync(cover, 'img');
    const known = [
        { ...first.tracks[0], albumArt: path.join(lib.cache, 'missing.jpg') },
        { ...first.tracks[1], albumArt: cover },
        { path: first.tracks[2].path, title: 'old list entry without size' }
    ];
    const second = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile, knownTracks: known });
    assert.deepEqual(parsedLog(lib).map((f) => path.basename(f)).sort(), ['1.mp3', '3.mp3']);
    assert.equal(second.tracks[1].albumArt, cover);
});

test('unreadable files are skipped, a crashed worker does not hang the scan', async () => {
    const lib = library(['1.mp3', '2-broken.mp3', '3.mp3', '4-crash.mp3', '5.mp3', '6.mp3', '7.mp3', '8.mp3', '9.mp3']);
    const result = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile, workerCount: 2, tuning: { perWorkerInFlight: 1 } });
    assert.ok(result.stats.failed >= 2);
    assert.equal(result.stats.failed + result.tracks.length, 9);
    assert.ok(!result.tracks.some((t) => /broken|crash/.test(t.path)));
});

test('stops when aborted and an empty folder completes at once', async () => {
    const empty = library([]);
    fs.mkdirSync(empty.music, { recursive: true });
    const none = await scanFolder({ folderPath: empty.music, coverCachePath: empty.cache, workerFile: empty.workerFile });
    assert.deepEqual(none.tracks, []);

    const lib = library(Array.from({ length: 200 }, (_, i) => `t${i}.mp3`));
    const controller = new AbortController();
    const result = await scanFolder({
        folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile, workerCount: 1, signal: controller.signal,
        onBatch: () => controller.abort(), tuning: { batchSize: 4 }
    });
    assert.equal(result.stats.aborted, true);
    assert.ok(result.tracks.length < 200);
});

test('a known track that fails to read this time keeps its last result; an unreadable folder keeps its tracks', async () => {
    const lib = library(['1.mp3', '2.mp3']);
    const first = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile });
    // 第二首这次读失败（换成会报错的文件名代替「被占用」）：上次的结果留着
    const broken = path.join(lib.music, '2-broken.mp3');
    fs.renameSync(first.tracks[1].path, broken);
    const known = [first.tracks[0], { ...first.tracks[1], path: broken, size: -1 }];
    const second = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile, knownTracks: known });
    assert.deepEqual(second.tracks.map((t) => path.basename(t.path)), ['1.mp3', '2-broken.mp3']);
    assert.equal(second.stats.failed, 1);
    assert.equal(second.stats.kept, 1);

    // 整个文件夹读不到（移动硬盘拔了）：上次扫到的全留着，别的文件夹的不混进来
    const gone = path.join(lib.root, 'unplugged');
    const elsewhere = { path: path.join(lib.root, 'unplugged2', 'x.mp3'), title: 'x' };
    const third = await scanFolder({
        folderPath: gone, coverCachePath: lib.cache, workerFile: lib.workerFile,
        knownTracks: [{ path: path.join(gone, 'a', 'y.mp3'), title: 'y' }, elsewhere]
    });
    assert.deepEqual(third.tracks.map((t) => t.title), ['y']);
    assert.equal(third.stats.unreadable, 1);
});

test('fillFolderCovers caches parent directory reads across multi-disc folders', async () => {
    const reads = new Map();
    const readdir = async (dir) => {
        reads.set(dir, (reads.get(dir) || 0) + 1);
        const base = path.basename(dir).toLowerCase();
        if (base === 'album') return ['cover.jpg', 'CD1', 'CD2'];
        return ['01.flac', '02.flac'];
    };
    const root = path.join(path.sep, 'music', 'album');
    const tracks = [
        { path: path.join(root, 'CD1', '01.flac'), albumArt: null },
        { path: path.join(root, 'CD1', '02.flac'), albumArt: null },
        { path: path.join(root, 'CD2', '01.flac'), albumArt: null },
        { path: path.join(root, 'CD2', '02.flac'), albumArt: null }
    ];
    const filled = await fillFolderCovers(tracks, readdir);
    assert.equal(filled, 4);
    assert.ok(tracks.every((t) => t.albumArt === path.join(root, 'cover.jpg')));
    assert.equal(reads.get(root), 1, 'album parent directory should be read only once for both CD1 and CD2');
    assert.equal(reads.get(path.join(root, 'CD1')), 1);
    assert.equal(reads.get(path.join(root, 'CD2')), 1);
});

test('rescan deduplicates concurrent cover access checks for tracks sharing an album cover', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `alb/t${String(i).padStart(2, '0')}.mp3`);
    const lib = library(names);
    const first = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile });
    const sharedCover = path.join(lib.cache, 'shared-album.jpg');
    fs.writeFileSync(sharedCover, 'img');
    const known = first.tracks.map((t) => ({ ...t, albumArt: sharedCover }));
    let accessCount = 0;
    const origAccess = fs.promises.access;
    fs.promises.access = async (file, ...rest) => {
        if (file === sharedCover) accessCount++;
        return origAccess.call(fs.promises, file, ...rest);
    };
    try {
        const second = await scanFolder({ folderPath: lib.music, coverCachePath: lib.cache, workerFile: lib.workerFile, knownTracks: known });
        assert.equal(second.stats.reused, 12);
        assert.equal(accessCount, 1, 'shared cover path should only be checked once across concurrent tracks');
    } finally {
        fs.promises.access = origAccess;
    }
});

test('musicLibraryWatch ignores late fs.watch callbacks fired after stop()', async () => {
    const { createLibraryWatch } = require('../modules/musicLibraryWatch');
    let watchCb = null;
    let closed = false;
    const scheduled = [];
    const watcher = createLibraryWatch({
        scan: async () => ({ tracks: [], stats: {} }),
        readKnown: async () => [],
        readFolders: async () => ['/fake-music'],
        writeFolders: async () => {},
        send: () => {},
        exists: async () => true,
        watch: (_dir, cb) => {
            watchCb = cb;
            return {
                on() {},
                close() { closed = true; }
            };
        },
        setTimer: (fn, ms) => {
            const id = scheduled.length + 1;
            scheduled.push({ id, fn, ms, cleared: false });
            return id;
        },
        clearTimer: (id) => {
            const entry = scheduled.find((t) => t.id === id);
            if (entry) entry.cleared = true;
        },
        log: { log() {}, warn() {} }
    });
    watcher.start();
    assert.equal(scheduled.length, 1, 'initial start timer scheduled');
    await scheduled[0].fn();
    assert.equal(typeof watchCb, 'function', 'watcher attached to folder');
    const beforeStop = scheduled.length;
    watcher.stop();
    assert.equal(closed, true);
    // Simulate a late OS watcher event arriving after stop()
    watchCb('rename', 'new-track.flac');
    assert.equal(scheduled.length, beforeStop, 'late fs.watch callback after stop() must not schedule a debounce timer');
});

test('musicLibraryWatch rescanNow aborts if stop() runs while readFolders is pending and ignores remote URL schemes', async () => {
    const { createLibraryWatch, inferredDirs } = require('../modules/musicLibraryWatch');
    assert.deepEqual(
        inferredDirs([
            { path: 'https://nas.example/dav/a.flac' },
            { path: 'webdav://nas.example/b.flac' },
            { path: 'sftp://nas.example/c.flac' }
        ]),
        [],
        'remote URL schemes are not treated as local library folders'
    );

    let resolveFolders = null;
    let scanCalls = 0;
    const watcher = createLibraryWatch({
        scan: async () => { scanCalls += 1; return { tracks: [], stats: {} }; },
        readKnown: async () => [],
        readFolders: () => new Promise((r) => { resolveFolders = r; }),
        writeFolders: async () => {},
        send: () => {},
        exists: async () => true,
        watch: () => ({ on() {}, close() {} }),
        log: { log() {}, warn() {} }
    });
    const pending = watcher.rescanNow();
    watcher.stop();
    resolveFolders(['/fake-music']);
    await pending;
    assert.equal(scanCalls, 0, 'rescanNow must not launch scan() after stop() incremented generation');
});

test('Batch 56: pickFolderCover single-pass scan preserves priority and lexicographical tie-breaking', () => {
    const { pickFolderCover } = require('../modules/musicLibraryScanner');
    assert.equal(pickFolderCover(null), null);
    assert.equal(pickFolderCover([]), null);
    assert.equal(pickFolderCover(['track01.flac', 'notes.txt']), null);
    assert.equal(pickFolderCover(['front.png', 'folder.jpg', 'Cover.webp', 'cover.jpg']), 'Cover.webp', 'cover beats folder/front and lexicographical min matches Array.sort');
    assert.equal(pickFolderCover(['albumart_small.jpg', 'albumart_large.jpg', 'front.png']), 'front.png');
    assert.equal(pickFolderCover(['albumart_z.jpg', 'albumart_a.png']), 'albumart_a.png');
});

test('Batch 58: musicLibraryWatch.forgetFolder cancels pending debounce timers for the forgotten root', async () => {
    const { createLibraryWatch } = require('../modules/musicLibraryWatch');
    let nextId = 1;
    const activeTimers = new Map();
    let watchCb = null;
    let scanCalls = 0;
    const folders = ['/fake-music/album-a'];
    const watcher = createLibraryWatch({
        scan: async () => { scanCalls += 1; return { tracks: [], stats: {} }; },
        readKnown: async () => [],
        readFolders: async () => folders.slice(),
        writeFolders: async (next) => { folders.length = 0; folders.push(...next); },
        send: () => {},
        exists: async () => true,
        watch: (_dir, cb) => { watchCb = cb; return { on() {}, close() {} }; },
        setTimer: (fn) => { const id = nextId++; activeTimers.set(id, fn); return id; },
        clearTimer: (id) => { activeTimers.delete(id); },
        log: { log() {}, warn() {} }
    });
    watcher.start();
    // Fire start delay timer and let initial background scan settle
    const startFn = [...activeTimers.values()][0];
    activeTimers.clear();
    await startFn();
    await new Promise((r) => setTimeout(r, 20));
    scanCalls = 0;

    // Trigger file change inside watched folder -> schedules debounce timer
    assert.ok(typeof watchCb === 'function');
    watchCb('change', 'song.flac');
    assert.equal(activeTimers.size, 1, 'fs.watch schedules a debounce timer');

    // Forget the folder BEFORE debounce fires -> timer must be canceled
    await watcher.forgetFolder('/fake-music/album-a');
    assert.equal(activeTimers.size, 0, 'forgetFolder cancels pending debounce timer for forgotten folder');
    assert.equal(scanCalls, 0);
    watcher.stop();
});

test('Batch 59: musicLibraryWatch.forgetFolder closes active fs.watch handle for the forgotten folder only', async () => {
    const { createLibraryWatch } = require('../modules/musicLibraryWatch');
    const closedDirs = [];
    const activeTimers = [];
    const folders = ['/fake-music/a', '/fake-music/b'];
    const watcher = createLibraryWatch({
        scan: async () => ({ tracks: [], stats: {} }),
        readKnown: async () => [],
        readFolders: async () => folders.slice(),
        writeFolders: async (next) => { folders.length = 0; folders.push(...next); },
        send: () => {},
        exists: async () => true,
        watch: (dir) => ({ on() {}, close() { closedDirs.push(dir); } }),
        setTimer: (fn) => { activeTimers.push(fn); return activeTimers.length; },
        clearTimer: () => {},
        log: { log() {}, warn() {} }
    });
    watcher.start();
    await activeTimers[0]();
    await new Promise((r) => setTimeout(r, 20));

    await watcher.forgetFolder('/fake-music/a');
    assert.deepEqual(closedDirs, ['/fake-music/a'], 'forgetting /a closes only /a fs.watch handle');
    watcher.stop();
    assert.deepEqual(closedDirs, ['/fake-music/a', '/fake-music/b'], 'stop() closes remaining /b handle');
});

test('Batch 65: partial worker spawn failure settles already-spawned workers inFlight jobs without hanging', async () => {
    const Module = require('node:module');
    const workerThreads = require('node:worker_threads');
    const lib = library(Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, '0')}.mp3`));
    const files = await collectAudioFiles(lib.music);
    const known = files.map((filePath, i) => ({ path: filePath, title: `kept-${i}`, size: -1, mtimeMs: 0 }));

    let spawnCount = 0;
    const terminated = [];
    const FakeWorker = class extends require('node:events').EventEmitter {
        constructor() {
            super();
            spawnCount += 1;
            if (spawnCount === 2) throw new Error('EMFILE: synthetic spawn failure');
        }
        postMessage() {}
        terminate() { terminated.push(spawnCount); return Promise.resolve(0); }
    };

    const scannerPath = require.resolve('../modules/musicLibraryScanner');
    const savedCache = require.cache[scannerPath];
    const origLoad = Module._load;
    delete require.cache[scannerPath];
    Module._load = function (request, parent, isMain) {
        if (request === 'worker_threads' && parent && parent.filename === scannerPath) {
            return { ...workerThreads, Worker: FakeWorker };
        }
        return origLoad.apply(this, arguments);
    };
    let isolatedScanner;
    try {
        isolatedScanner = require(scannerPath);
    } finally {
        Module._load = origLoad;
        if (savedCache) require.cache[scannerPath] = savedCache;
        else delete require.cache[scannerPath];
    }

    const result = await isolatedScanner.scanFolder({
        folderPath: lib.music,
        coverCachePath: lib.cache,
        workerFile: lib.workerFile,
        workerCount: 2,
        knownTracks: known,
        tuning: { perWorkerInFlight: 3 }
    });
    assert.equal(spawnCount, 2, 'attempted to spawn 2 workers before failing');
    assert.equal(terminated.length, 1, 'already-spawned worker terminated cleanly');
    assert.equal(result.stats.failed, 12, 'all 12 jobs including worker #1 inFlight jobs settled as failed');
    assert.equal(result.stats.kept, 12, 'known tracks preserved for both inFlight and unqueued jobs');
    assert.equal(result.tracks.length, 12, 'no inFlight tracks dropped during partial spawn failure');
});

test('Batch 76: musicLibraryWatch recognizes modern/hi-res audio extensions aligned with scanner', async () => {
    const { createLibraryWatch } = require('../modules/musicLibraryWatch');
    let nextId = 1;
    const timers = new Map();
    let watchCb = null;
    const watcher = createLibraryWatch({
        scan: async () => ({ tracks: [], stats: {} }),
        readKnown: async () => [],
        readFolders: async () => ['/fake-music'],
        writeFolders: async () => {},
        send: () => {},
        exists: async () => true,
        watch: (_dir, cb) => { watchCb = cb; return { on() {}, close() {} }; },
        setTimer: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
        clearTimer: (id) => { timers.delete(id); },
        log: { log() {}, warn() {} }
    });
    watcher.start();
    const startFn = [...timers.values()][0];
    timers.clear();
    await startFn();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(typeof watchCb, 'function');

    // Non-audio files stay ignored
    watchCb('rename', 'cover.jpg');
    watchCb('rename', 'notes.txt');
    assert.equal(timers.size, 0, 'non-audio files do not schedule rescan');

    // Modern & hi-res extensions (opus, aac, alac, aif, aiff, dsf, dff, wv) trigger debounce rescan
    for (const name of ['track.opus', 'song.aac', 'master.alac', 'studio.aif', 'studio.aiff', 'sacd.dsf', 'sacd.dff', 'pack.wv']) {
        timers.clear();
        watchCb('rename', name);
        assert.equal(timers.size, 1, `watcher reacts to ${name}`);
    }
    watcher.stop();
});

test('Batch 80: musicLibraryWatch.changedSince skips remote URL tracks without miscounting them under local root', () => {
    const { changedSince } = require('../modules/musicLibraryWatch');
    const cwdRoot = process.cwd();
    const localTrack = { path: path.join(cwdRoot, 'song.flac'), size: 1000, mtimeMs: 5000 };
    const known = [
        localTrack,
        { path: 'https://nas.example/dav/remote.flac', isRemote: true, size: 2000, mtimeMs: 6000 },
        { path: 'webdav://nas.example/other.mp3', size: 3000, mtimeMs: 7000 }
    ];
    assert.equal(changedSince(known, [localTrack], cwdRoot), false, 'remote URLs are ignored by changedSince even when root is process.cwd()');
});

test('Batch 85: musicLibraryWatch collapseRoots and single-pass noteLibrarySaved exclude removed locals while skipping remotes', async () => {
    const { createLibraryWatch, collapseRoots } = require('../modules/musicLibraryWatch');
    const collapsed = collapseRoots(['/music/a/sub', '/music/a', '/music/b', '/music/b/deep']);
    assert.deepEqual(collapsed, ['/music/a', '/music/b'], 'collapseRoots deduplicates child directories regardless of order');

    let savedExcluded = null;
    const watcher = createLibraryWatch({
        scan: async () => ({ tracks: [], stats: {} }),
        readKnown: async () => [],
        readFolders: async () => [],
        writeFolders: async () => {},
        readExcluded: async () => ['/music/readded.flac', '/music/still-out.flac'],
        writeExcluded: async (list) => { savedExcluded = list; },
        fileExists: async (p) => p !== '/music/deleted-from-disk.flac',
        send: () => {},
        log: { log() {}, warn() {} }
    });
    const prev = [
        { path: '/music/kept.flac' },
        { path: '/music/removed-local.flac' },
        { path: '/music/deleted-from-disk.flac' },
        { path: 'https://nas.example/dav/removed-remote.flac', isRemote: true }
    ];
    const next = [
        { path: '/music/kept.flac' },
        { path: '/music/readded.flac' }
    ];
    await watcher.noteLibrarySaved(prev, next);
    assert.deepEqual(savedExcluded, ['/music/still-out.flac', '/music/removed-local.flac'], 'single-pass noteLibrarySaved drops re-added tracks, excludes existing removed locals, and skips deleted/remote paths');
});
