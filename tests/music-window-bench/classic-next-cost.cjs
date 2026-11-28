/*
 * In the classic view the archive view is hidden; switching tracks must not make it lay
 * itself out (each track change touches body style, which the archive watches).
 *
 *   node tests/music-window-bench/classic-next-cost.cjs [--n=3000] [--cpu=4]
 */
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const N = Number(args.n) || 3000;
const CPU = Number(args.cpu) || 4;

const FAKE = ({ n }) => {
    const tracks = Array.from({ length: n }, (_, i) => ({
        path: 'D:\\Music\\album' + (i % 400) + '\\t' + i + '.flac', title: '曲目 ' + (i + 1), artist: 'Artist ' + (i % 90), album: 'Album ' + (i % 400), duration: 200
    }));
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8 };
    const fns = {
        getMusicPlaylist: async () => tracks,
        getCustomPlaylists: async () => [],
        getMusicState: async () => ({ status: 'success', state: { ...state } }),
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        getAudioEngineEndpoint: async () => ({ state: 'ready', wsUrl: 'ws://127.0.0.1:9/ws' }),
        musicLoad: async (t) => { state.file_path = t.path; state.current_time = 0; return { status: 'success', state: { ...state } }; },
        musicPlay: async () => { state.is_playing = true; return { status: 'success', state: { ...state } }; },
        musicPause: async () => { state.is_playing = false; return { status: 'success', state: { ...state } }; },
        getMusicLyrics: async () => null
    };
    let dock;
    Object.defineProperty(window, 'initMusicDock', { configurable: true, get: () => dock, set: (fn) => { dock = (app, ...rest) => { window.app = app; return fn(app, ...rest); }; } });
    window.electronAPI = new Proxy({}, { get: (_, k) => { if (typeof k !== 'string') return undefined; if (fns[k]) return fns[k]; if (k.startsWith('on')) return () => () => {}; return async () => ({ status: 'success' }); } });
};

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    await page.addInitScript(FAKE, { n: N });
    await page.goto(`http://127.0.0.1:${server.address().port}/Musicmodules/music.html`, { timeout: 180000, waitUntil: 'commit' });
    await page.waitForFunction((n) => window.app?.playlist?.length === n && window.app.archiveView, N, { timeout: 180000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => document.querySelector('[data-act="classic"]')?.click());
    await page.waitForTimeout(2500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    await page.evaluate(async () => { for (let i = 0; i < 5; i++) { window.app.nextTrack(); await new Promise((r) => setTimeout(r, 300)); } });
    await page.waitForTimeout(1500);
    const { profile } = await cdp.send('Profiler.stop');
    const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
    let archiveResize = 0, total = 0;
    (profile.samples || []).forEach((id, i) => {
        const cf = byId.get(id).callFrame;
        const ms = (profile.timeDeltas[i] || 0) / 1000;
        if (cf.functionName !== '(idle)' && cf.functionName !== '(program)') total += ms;
        if (cf.functionName === 'resize' && /archive-view\.js$/.test(cf.url)) archiveResize += ms;
    });
    const archiveShown = await page.evaluate(() => document.body.classList.contains('music-archive-on'));
    console.log(`5 track changes in classic view: script ${total.toFixed(0)} ms, hidden archive layout ${archiveResize.toFixed(0)} ms`);
    const checks = [
        ['classic view is active', !archiveShown],
        ['hidden archive view does no layout on track change', archiveResize < 5],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
