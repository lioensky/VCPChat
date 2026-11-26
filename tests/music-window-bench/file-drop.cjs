/*
 * Files dragged in from the file manager must not make the music window navigate
 * away to that file: dragover and drop of Files are cancelled, internal drags are not,
 * and the dropped files are handed to the library by path.
 *
 *   node tests/music-window-bench/file-drop.cjs
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
        getPathForFile: (file) => 'C:\\Drop\\' + file.name,
        addMusicPaths: async (paths) => { w.__added = paths; return { files: paths.length }; },
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
        const fire = (type, withFile) => {
            const dt = new DataTransfer();
            if (withFile) dt.items.add(new File(['x'], 'song.mp3', { type: 'audio/mpeg' }));
            else dt.setData('text/plain', 'row');
            const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
            document.body.dispatchEvent(ev);
            return ev.defaultPrevented;
        };
        return { fileOver: fire('dragover', true), fileDrop: fire('drop', true), rowOver: fire('dragover', false), added: window.__added || null };
    });
    const checks = [
        ['file dragover is cancelled', r.fileOver],
        ['file drop is cancelled (no navigation)', r.fileDrop],
        ['internal drags are left to their own handlers', !r.rowOver],
        ['dropped files are added to the library by path', JSON.stringify(r.added) === JSON.stringify(['C:\\Drop\\song.mp3'])],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!checks.every((c) => c[1])) console.log(JSON.stringify(r, null, 1), errors);
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
