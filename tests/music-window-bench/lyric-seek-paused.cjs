/*
 * Seeking while paused (progress bar, system media overlay, clicking a lyric line)
 * must move the highlighted lyric line, and so must a small backward seek while playing.
 *
 *   node tests/music-window-bench/lyric-seek-paused.cjs
 */
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(path.join(__dirname, '..', '..'));

const FAKE = () => {
    const w = window;
    const tracks = [{ path: 'D:\\Music\\a.flac', title: 'a', artist: 'x' }];
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null };
    w.__state = state;
    const lrc = Array.from({ length: 20 }, (_, i) => `[00:${String(i * 5).padStart(2, '0')}.00]第${i}行\n[00:${String(i * 5).padStart(2, '0')}.00]line ${i}`).join('\n');
    const fns = {
        getMusicPlaylist: async () => tracks.map((t) => ({ ...t })),
        getCustomPlaylists: async () => [],
        getMusicState: async () => ({ status: 'success', state: { ...state } }),
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        musicLoad: async (t) => { state.file_path = t.path; return { status: 'success', state: { ...state } }; },
        seekMusic: async (s) => { state.current_time = s; return { status: 'success', state: { ...state } }; },
        musicPlay: async () => { state.is_playing = true; return { status: 'success' }; },
        musicPause: async () => { state.is_playing = false; return { status: 'success' }; },
        getMusicLyrics: async () => lrc
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
    await page.waitForFunction(() => window.app?.currentLyrics?.length === 20, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const activeIndex = () => page.evaluate(() => [...window.app.lyricsList.children].findIndex((li) => li.classList.contains('active')));
    const r = {};
    r.paused = await page.evaluate(() => window.app.isPlaying);
    await page.evaluate(() => window.app.seekTo(52));
    await page.waitForTimeout(500);
    r.afterPausedSeek = await activeIndex();
    r.indexAfterPausedSeek = await page.evaluate(() => window.app.currentLyricIndex);
    await page.evaluate(() => window.app.seekTo(12));
    await page.waitForTimeout(500);
    r.afterPausedSeekBack = await activeIndex();
    const checks = [
        ['starts paused', r.paused === false],
        ['paused seek forward moves the highlight to line 10', r.afterPausedSeek === 10 && r.indexAfterPausedSeek === 10],
        ['paused seek back moves the highlight to line 2', r.afterPausedSeekBack === 2],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!checks.every((c) => c[1])) console.log(JSON.stringify(r), errors);
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
