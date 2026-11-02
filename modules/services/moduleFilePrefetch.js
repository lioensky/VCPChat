'use strict';
// read the files a later synchronous require() will need on other threads, before it runs. Windows
// Defender scans a file on its first open; inside require() that wait blocks Chat's main thread, so every window stops
// responding . Reading the files first moves the scan off the main thread,
// and require() then finds them scanned and cached.
// Measured on a machine with an NVMe SSD: the disk is not the cost. A first open takes about
// 13 ms per file whatever its size, a re-read 0.13 ms. Scans run in parallel, so four threads take a quarter of the time.
// The lists name files only: nothing in them is executed, and entries outside the Chat folder are ignored.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_FILES = 5000;
const CHAT_ROOT = path.resolve(__dirname, '../..');

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

function parseList(text, root) {
    const list = JSON.parse(text);
    if (!Array.isArray(list?.files)) return [];
    return list.files.filter(entry => typeof entry === 'string' && inside(root, path.resolve(root, entry)))
        .slice(0, MAX_FILES);
}

async function readList(listPath, root) {
    try {
        return parseList(await fs.promises.readFile(listPath, 'utf8'), root);
    } catch {
        return [];
    }
}

// own threads with blocking reads. Asynchronous reads took every thread of libuv's pool for the
// 8-15 s of a start, so all other file work in the main process queued behind the scans, and each read needed several
// turns of the main thread, so a busy main thread slowed the prefetch in turn.
const READER = `
const fs = require('fs');
const { parentPort, workerData: { paths, cursor, deadline } } = require('worker_threads');
const next = new Int32Array(cursor);
const failed = [];
while (Date.now() < deadline) {
    const index = Atomics.add(next, 0, 1);
    if (index >= paths.length) break;
    try { fs.readFileSync(paths[index]); } catch { failed.push(index); }
}
parentPort.postMessage(failed);
`;

async function readOnThreads(paths, { concurrency = 4, budgetMs = 15000 } = {}) {
    const failed = new Set();
    if (!paths.length) return { read: 0, failed };
    const cursor = new SharedArrayBuffer(4);
    const deadline = Date.now() + budgetMs;
    const readers = Array.from({ length: Math.min(concurrency, paths.length) }, () => new Promise(resolve => {
        const worker = new Worker(READER, { eval: true, workerData: { paths, cursor, deadline } });
        worker.once('message', list => { for (const index of list) failed.add(index); });
        worker.once('error', resolve);
        worker.once('exit', resolve);
    }).catch(() => { /* No thread: require() reads the files itself, as if they were not listed. */ }));
    await Promise.all(readers);
    return { read: Math.min(Atomics.load(new Int32Array(cursor), 0), paths.length), failed };
}

async function prefetchFiles(listPath, { root, concurrency = 4, budgetMs = 15000 } = {}) {
    const started = Date.now();
    const entries = await readList(listPath, root);
    const { read, failed } = await readOnThreads(entries.map(entry => path.resolve(root, entry)), { concurrency, budgetMs });
    // Gone since last session (an updated package) drops out; entries past the time budget stay listed for next time.
    const kept = entries.filter((_entry, index) => !failed.has(index));
    return { files: entries.length, read, missing: failed.size, ms: Date.now() - started, kept };
}

// Remembers the Chat files loaded after creation, merged with `previous`. save() is synchronous so it can run while
// the app quits; the list is small (a few hundred paths).
function createLoadRecorder(listPath, { root, previous = [], cache = require.cache } = {}) {
    const before = new Set(Object.keys(cache));
    // In load order, so threads stay ahead of a require() running at the same time. require() also opens the package.json
    // beside each module first, and a native add-on loads the DLLs beside it, all on the main thread like the module.
    function loaded() {
        const dirs = new Set();
        const files = new Set();
        for (const relative of Object.keys(cache).filter(file => !before.has(file)).map(file => inside(root, file)).filter(Boolean)) {
            for (let dir = path.dirname(relative); dir !== '.' && !dirs.has(dir); dir = path.dirname(dir)) {
                dirs.add(dir);
                const manifest = path.join(dir, 'package.json');
                if (fs.existsSync(path.join(root, manifest))) files.add(manifest);
            }
            files.add(relative);
            if (relative.endsWith('.node')) {
                const dir = path.dirname(relative);
                for (const name of fs.readdirSync(path.join(root, dir))) if (name.endsWith('.dll')) files.add(path.join(dir, name));
            }
        }
        return [...files].map(relative => relative.split(path.sep).join('/'));
    }
    function save() {
        const files = new Set([...previous, ...loaded()]);
        const temporary = `${listPath}.${process.pid}.tmp`;
        fs.mkdirSync(path.dirname(listPath), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ savedAt: new Date().toISOString(), files: [...files].slice(0, MAX_FILES) }));
        fs.renameSync(temporary, listPath);
        return files.size;
    }
    return { save, loaded };
}

function startupCacheDir() {
    const isolated = process.env.VCPCHAT_APP_DATA_DIR?.trim();
    return path.join(isolated ? path.resolve(isolated) : path.join(CHAT_ROOT, 'AppData'), 'StartupCache');
}

// main.js loads its modules on the main thread before the first window, one scan after another, and
// electron-ready took 4-5 s on cold starts instead of 0.5 s. Threads now read ahead of those require() calls, from the
// list the last start left. The event loop does not turn until the calls end, so nothing here may wait for it.
function readAheadOfStartup(name, { root = CHAT_ROOT, dir = startupCacheDir(), cache = require.cache, budgetMs = 15000 } = {}) {
    const listPath = path.join(dir, `${name}-modules.json`);
    let entries = [];
    try { entries = parseList(fs.readFileSync(listPath, 'utf8'), root); } catch { /* First start, or an unreadable list. */ }
    const reading = readOnThreads(entries.map(entry => path.resolve(root, entry)), { concurrency: 4, budgetMs });
    const recorder = createLoadRecorder(listPath, { root, cache });
    const listed = new Set(entries);
    return {
        reading,
        save() {
            const loaded = recorder.loaded();
            if (loaded.length !== listed.size || loaded.some(file => !listed.has(file))) recorder.save();
        },
    };
}

// a feature that loads a large library on first use reads that library's files first, from the list
// its last use left, so the require() inside `run` does not scan on the main thread. Only the first use in a session
// reads or records; the very first use on a machine has no list and loads as before.
const warmups = new Map();

async function withWarmModules(name, run, { root = CHAT_ROOT, dir = startupCacheDir(), budgetMs = 8000 } = {}) {
    const first = !warmups.has(name);
    const listPath = path.join(dir, `${name}-modules.json`);
    if (first) warmups.set(name, prefetchFiles(listPath, { root, budgetMs }).catch(() => ({ kept: [] })));
    const { kept } = await warmups.get(name);
    if (!first) return run();
    const recorder = createLoadRecorder(listPath, { root, previous: kept });
    try {
        return await run();
    } finally {
        try {
            if (recorder.loaded().some(file => !kept.includes(file))) recorder.save();
        } catch (error) {
            console.warn(`[Main] Could not save the module list ${name}:`, error.code || error.message);
        }
    }
}

// The files a feature's last use recorded, as absolute paths, for reading ahead of that feature.
async function listedFiles(name, { root = CHAT_ROOT, dir = startupCacheDir() } = {}) {
    return (await readList(path.join(dir, `${name}-modules.json`), root)).map(entry => path.resolve(root, entry));
}

module.exports = { prefetchFiles, createLoadRecorder, readAheadOfStartup, withWarmModules, readOnThreads, listedFiles, MAX_FILES };
