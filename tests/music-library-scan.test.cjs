const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanFolder, collectAudioFiles } = require('../modules/musicLibraryScanner');

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
