/*
 * The engine dies while a song is playing and main restarts it: the music window
 * must load the same song again, jump back to where it was and keep playing
 * (or stay paused if it was paused), without the user doing anything.
 *
 *   node tests/music-window-bench/engine-restart.cjs
 */
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(path.join(__dirname, '..', '..'));

const FAKE = () => {
    const tracks = Array.from({ length: 10 }, (_, i) => ({ path: 'D:\\Music\\t' + i + '.flac', title: 'T' + i, duration: 200 }));
    const w = window;
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8 };
    let startedAt = 0;
    w.__engine = state;
    w.__calls = [];
    const tick = () => { if (state.is_playing) state.current_time = Math.min(200, (performance.now() - startedAt) / 1000); };
    const fns = {
        getMusicPlaylist: async () => tracks,
        getCustomPlaylists: async () => [],
        getMusicState: async () => { tick(); return { status: 'success', state: { ...state } }; },
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        getAudioEngineEndpoint: async () => ({ state: 'ready', wsUrl: 'ws://127.0.0.1:9/ws' }),
        onAudioEngineStatus: (fn) => { w.__status = fn; return () => {}; },
        musicLoad: async (t) => { w.__calls.push(['load', t.path]); await new Promise((r) => setTimeout(r, 50)); state.file_path = t.path; state.current_time = 0; state.is_playing = false; return { status: 'success', state: { ...state } }; },
        musicPlay: async () => { w.__calls.push(['play']); state.is_playing = true; startedAt = performance.now() - state.current_time * 1000; return { status: 'success', state: { ...state } }; },
        musicPause: async () => { w.__calls.push(['pause']); tick(); state.is_playing = false; return { status: 'success', state: { ...state } }; },
        seekMusic: async (p) => { w.__calls.push(['seek', Math.round(p)]); state.current_time = Number(p); startedAt = performance.now() - state.current_time * 1000; return { status: 'success', state: { ...state } }; },
        getMusicLyrics: async () => null
    };
    let dock;
    Object.defineProperty(window, 'initMusicDock', { configurable: true, get: () => dock, set: (fn) => { dock = (app, ...rest) => { window.app = app; return fn(app, ...rest); }; } });
    window.electronAPI = new Proxy({}, { get: (_, k) => { if (typeof k !== 'string') return undefined; if (fns[k]) return fns[k]; if (k.startsWith('on')) return () => () => {}; return async () => ({ status: 'success' }); } });
};

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const results = [];
    for (const wasPlaying of [true, false]) {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
        await page.addInitScript(FAKE);
        await page.goto(`http://127.0.0.1:${server.address().port}/Musicmodules/music.html`, { timeout: 120000, waitUntil: 'commit' });
        await page.waitForFunction(() => window.app?.playlist?.length && window.__status, null, { timeout: 120000 });
        await page.waitForTimeout(2500);
        await page.evaluate(() => document.querySelector('[data-act="classic"]')?.click());
        await page.evaluate(async (play) => {
            await app.loadTrack(3, true);
            await new Promise((r) => setTimeout(r, 300));
            await app.seekTo(84);
            if (!play) await app.pauseTrack();
        }, wasPlaying);
        await page.waitForTimeout(1200);
        // the engine dies and comes back: it has nothing loaded
        await page.evaluate(() => {
            Object.assign(window.__engine, { is_playing: false, file_path: null, current_time: 0 });
            window.__calls.length = 0;
            window.__status({ state: 'failed', message: 'crashed' });
            window.__status({ state: 'starting' });
            window.__status({ state: 'ready', wsUrl: 'ws://127.0.0.1:9/ws' });
        });
        await page.waitForTimeout(2500);
        const r = await page.evaluate(() => ({ calls: window.__calls, engine: { ...window.__engine }, ui: app.isPlaying, title: app.playlist[app.currentTrackIndex].path }));
        const ok = r.engine.file_path === 'D:\\Music\\t3.flac' && r.engine.current_time >= 80 && r.engine.is_playing === wasPlaying && r.ui === wasPlaying
            && r.calls.findIndex((c) => c[0] === 'seek') < (r.calls.findIndex((c) => c[0] === 'play') === -1 ? Infinity : r.calls.findIndex((c) => c[0] === 'play'));
        results.push(ok && !errors.length);
        console.log(`${ok && !errors.length ? 'PASS' : 'FAIL'} engine restart while ${wasPlaying ? 'playing' : 'paused'}: ${JSON.stringify(r.calls)} engine ${JSON.stringify(r.engine)} ui playing ${r.ui}${errors.length ? ' errors ' + errors.join(' | ') : ''}`);
        // a fresh window that sees starting → ready must not reload anything
        await page.close();
    }
    {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
        await page.addInitScript(FAKE);
        await page.goto(`http://127.0.0.1:${server.address().port}/Musicmodules/music.html`, { timeout: 120000, waitUntil: 'commit' });
        await page.waitForFunction(() => window.app?.playlist?.length && window.__status, null, { timeout: 120000 });
        await page.waitForTimeout(2500);
        const before = await page.evaluate(() => window.__calls.length);
        await page.evaluate(() => { window.__status({ state: 'ready', wsUrl: 'ws://127.0.0.1:9/ws' }); });
        await page.waitForTimeout(800);
        const after = await page.evaluate(() => window.__calls.length);
        results.push(after === before);
        console.log(`${after === before ? 'PASS' : 'FAIL'} a ready without a prior loss does nothing (${after - before} calls)`);
    }
    await browser.close();
    server.close();
    process.exitCode = results.every(Boolean) ? 0 : 1;
})();
