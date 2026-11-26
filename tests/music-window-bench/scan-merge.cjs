/*
 * Library scan results arriving in the real music window: batches during the
 * scan, then the complete list. Checks disk order, object identity of tracks
 * shown early, the playing track, and two folders scanned at the same time.
 *
 *   node tests/music-window-bench/scan-merge.cjs
 */
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(path.join(__dirname, '..', '..'));

const FAKE = () => {
    const w = window;
    const old = [0, 1, 2].map((i) => ({ path: 'E:\\Old\\o' + i + '.flac', title: 'O' + i }));
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null };
    const fns = {
        getMusicPlaylist: async () => old.map((t) => ({ ...t })),
        getCustomPlaylists: async () => [],
        getMusicState: async () => ({ status: 'success', state: { ...state } }),
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        musicLoad: async (t) => { state.file_path = t.path; return { status: 'success', state: { ...state } }; },
        saveMusicPlaylist: async (p) => { w.__saved = p.map((t) => t.path); return { success: true }; },
        getMusicLyrics: async () => null,
        onMusicScanBatch: (fn) => { (w.__batches ||= []).push(fn); w.__batch = (d) => w.__batches.forEach((f) => f(d)); return () => {}; },
        onMusicScanComplete: (fn) => { (w.__completes ||= []).push(fn); w.__complete = (d) => w.__completes.forEach((f) => f(d)); return () => {}; }
    };
    let dock;
    Object.defineProperty(window, 'initMusicDock', { configurable: true, get: () => dock, set: (fn) => { dock = (app, ...rest) => { window.app = app; return fn(app, ...rest); }; } });
    window.electronAPI = new Proxy({}, { get: (_, k) => { if (typeof k !== 'string') return undefined; if (fns[k]) return fns[k]; if (k.startsWith('on')) return () => () => {}; return async () => ({ status: 'success' }); } });
};

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.addInitScript(FAKE);
    await page.goto(`http://127.0.0.1:${server.address().port}/Musicmodules/music.html`, { timeout: 120000, waitUntil: 'commit' });
    await page.waitForFunction(() => window.app?.playlist?.length === 3 && window.__batch, null, { timeout: 120000 });
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => {
        const mk = (dir, i) => ({ path: dir + '\\t' + i + '.flac', title: dir.slice(-1) + i, size: 10, mtimeMs: 1 });
        const A = [0, 1, 2, 3].map((i) => mk('D:\\A', i));
        const B = [0, 1, 2].map((i) => mk('D:\\B', i));
        // A and B scanned at the same time; batches arrive out of disk order and interleaved
        window.__batch({ tracks: [A[2], A[0]], folderPath: 'D:\\A' });
        window.__batch({ tracks: [B[1]], folderPath: 'D:\\B' });
        const earlyA2 = app.playlist.find((t) => t.path === A[2].path);
        const earlyB1 = app.playlist.find((t) => t.path === B[1].path);
        app.currentTrackIndex = app.playlist.indexOf(earlyA2); // user started an early track
        window.__batch({ tracks: [A[3], A[1]], folderPath: 'D:\\A' });
        window.__complete({ tracks: A.map((t) => ({ ...t, title: t.title + '!' })), folderPath: 'D:\\A' });
        const afterA = app.playlist.map((t) => t.path);
        const keptB1 = app.playlist.includes(earlyB1);
        window.__batch({ tracks: [B[0], B[2]], folderPath: 'D:\\B' });
        window.__complete({ tracks: B.map((t) => ({ ...t })), folderPath: 'D:\\B' });
        return {
            afterA, keptB1, final: app.playlist.map((t) => t.path), saved: window.__saved,
            sameObject: app.playlist.includes(earlyA2) && app.playlist.includes(earlyB1),
            updated: earlyA2.title, playing: app.playlist[app.currentTrackIndex].path
        };
    });
    const expect = ['E:\\Old\\o0.flac', 'E:\\Old\\o1.flac', 'E:\\Old\\o2.flac', 'D:\\A\\t0.flac', 'D:\\A\\t1.flac', 'D:\\A\\t2.flac', 'D:\\A\\t3.flac', 'D:\\B\\t0.flac', 'D:\\B\\t1.flac', 'D:\\B\\t2.flac'];
    const checks = [
        ['B track shown early survives A completing', r.keptB1],
        ['final order is disk order per folder', JSON.stringify(r.final) === JSON.stringify(expect)],
        ['saved list equals shown list', JSON.stringify(r.saved) === JSON.stringify(r.final)],
        ['tracks shown early keep their object', r.sameObject],
        ['early track got the final metadata', r.updated === 'A2!'],
        ['playing index still points at the playing track', r.playing === 'D:\\A\\t2.flac'],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!checks.every((c) => c[1])) console.log(JSON.stringify(r, null, 1), errors);
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
