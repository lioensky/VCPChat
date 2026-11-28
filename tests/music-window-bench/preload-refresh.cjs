/*
 * The engine decodes the next song ahead of time and switches to it on its own
 * when the current one ends. When the play mode or the library changes after
 * that, the preloaded song must be replaced, or the engine plays the old choice
 * (or a song that was just removed). The fake engine copies the real one: a
 * finished preload ignores further queue_next until cancel_preload.
 *
 *   node tests/music-window-bench/preload-refresh.cjs
 */
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(path.join(__dirname, '..', '..'));

const FAKE = () => {
    const tracks = Array.from({ length: 6 }, (_, i) => ({ path: 'D:\\Music\\t' + i + '.flac', title: 'T' + i, duration: 200 }));
    const w = window;
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8 };
    w.__engine = state;
    w.__pending = null;
    w.__calls = [];
    window.confirm = () => true;
    const fns = {
        getMusicPlaylist: async () => tracks,
        getCustomPlaylists: async () => [],
        getMusicState: async () => ({ status: 'success', state: { ...state } }),
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        getAudioEngineEndpoint: async () => ({ state: 'ready', wsUrl: 'ws://127.0.0.1:9/ws' }),
        musicLoad: async (t) => { w.__calls.push(['load', t.path]); w.__pending = null; state.file_path = t.path; state.current_time = 0; return { status: 'success', state: { ...state } }; },
        musicPlay: async () => { state.is_playing = true; return { status: 'success', state: { ...state } }; },
        musicPause: async () => { state.is_playing = false; return { status: 'success', state: { ...state } }; },
        queueNextMusicTrack: async ({ path }) => { w.__calls.push(['queue', path]); if (!w.__pending) w.__pending = path; return { status: 'success' }; },
        cancelMusicPreload: async () => { w.__calls.push(['cancel']); w.__pending = null; return { status: 'success' }; },
        getMusicLyrics: async () => null
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
    await page.waitForFunction(() => window.app?.playlist?.length === 6, null, { timeout: 120000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.querySelector('[data-act="classic"]')?.click());

    const results = [];
    const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
    const settle = () => page.waitForTimeout(1800);
    // playing t1 in list repeat, engine asks for the next song
    const preloadFor = async (index) => {
        await page.evaluate(async (i) => { app.setPlayMode('repeat'); await app.loadTrack(i, true); }, index);
        await settle();
        await page.evaluate(() => app.handleNeedsPreload());
        await settle();
    };

    await preloadFor(1);
    check('list repeat preloads the next song', await page.evaluate(() => window.__pending) === 'D:\\Music\\t2.flac', await page.evaluate(() => window.__pending));

    await page.evaluate(() => app.setPlayMode('repeat-one'));
    await settle();
    let pending = await page.evaluate(() => window.__pending);
    check('switching to repeat-one replaces it with the same song', pending === 'D:\\Music\\t1.flac', pending);

    await page.evaluate(() => app.setPlayMode('repeat'));
    await settle();
    pending = await page.evaluate(() => window.__pending);
    check('switching back to list repeat preloads the next song again', pending === 'D:\\Music\\t2.flac', pending);

    await page.evaluate(() => app.queuePlayNext(app.playlist[4]));
    await settle();
    pending = await page.evaluate(() => window.__pending);
    check('"play next" after the preload replaces it', pending === 'D:\\Music\\t4.flac', pending);
    await page.evaluate(() => app.queueRemove(0));
    await settle();

    // 移除前有确认框（MusicDialog）；这里直接确认。
    await page.evaluate(() => { if (window.MusicDialog) window.MusicDialog.confirm = async () => true; return app.removeTrackInScope(2, null); });
    await settle();
    pending = await page.evaluate(() => window.__pending);
    check('removing the preloaded song preloads the one after it', pending === 'D:\\Music\\t3.flac', pending);

    // the engine was faster than the refresh and switched to the removed song anyway
    await page.evaluate(() => { window.__calls.length = 0; app.syncTrackIndexByPath('D:\\Music\\t2.flac'); });
    await settle();
    const r = await page.evaluate(() => ({ calls: window.__calls, current: app.playlist[app.currentTrackIndex]?.path }));
    check('a switch to a removed song moves on to the next one', r.current === 'D:\\Music\\t3.flac' && r.calls.some((c) => c[0] === 'load' && c[1] === 'D:\\Music\\t3.flac'), r);

    check('no page errors', !errors.length, errors);
    await browser.close();
    server.close();
    process.exitCode = results.every(Boolean) ? 0 : 1;
})();
