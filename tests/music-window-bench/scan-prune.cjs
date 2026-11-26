/*
 * Rescan pruning in the real music window: a rescan of D:\\Music removes only
 * files under D:\\Music (not D:\\Music2), and a failed scan removes nothing.
 *
 *   node tests/music-window-bench/scan-prune.cjs
 */
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(path.join(__dirname, '..', '..'));

const FAKE = () => {
    const w = window;
    const old = [['D:\\Music\\a.flac', 'a'], ['D:\\Music\\gone.flac', 'g'], ['D:\\Music2\\b.flac', 'b']].map(([p, t]) => ({ path: p, title: t }));
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
        const paths = () => app.playlist.map((t) => t.path);
        window.__complete({ tracks: [], folderPath: 'D:\\Music', failed: true });
        const afterFailed = paths();
        window.__complete({ tracks: [{ path: 'D:\\Music\\a.flac', title: 'a', size: 1, mtimeMs: 1 }], folderPath: 'D:\\Music' });
        return { afterFailed, afterRescan: paths() };
    });
    const checks = [
        ['a failed scan removes nothing', r.afterFailed.length === 3],
        ['rescan drops the deleted file', !r.afterRescan.includes('D:\\Music\\gone.flac')],
        ['rescan of D:\\Music keeps D:\\Music2', r.afterRescan.includes('D:\\Music2\\b.flac')],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!checks.every((c) => c[1])) console.log(JSON.stringify(r, null, 1), errors);
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
