/*
 * With the archive view shown the classic list is hidden: removing a track must not rebuild
 * its thousands of rows then (that is most of the cost of a removal). It is drawn when the
 * classic view comes back, with the right tracks in the right order.
 *
 *   node tests/music-window-bench/archive-remove-cost.cjs [--n=3000] [--cpu=4]
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
    await page.waitForTimeout(6000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    const r = await page.evaluate(async () => {
        const app = window.app;
        const out = { archiveOn: document.body.classList.contains('music-archive-on'), sync: [] };
        const rowsBefore = app.playlistEl.children.length;
        const removed = [];
        for (let k = 0; k < 3; k++) {
            removed.push(app.playlist[200].path);
            const t = performance.now();
            app.removeTrackInScope(200, null);
            out.sync.push(Math.round(performance.now() - t));
            await new Promise((res) => setTimeout(res, 1200));
        }
        out.rowsUntouched = app.playlistEl.children.length === rowsBefore;
        document.querySelector('[data-act="classic"]')?.click();
        await new Promise((res) => setTimeout(res, 1500));
        // 经典列表只建看得见的行时，按它要显示的整组歌比
        const drawn = Array.from(app.playlistEl.children, (li) => app.playlist[Number(li.dataset.index)]);
        const shown = app.classicShownSongs ? app.classicShownSongs() : drawn;
        out.drawnValid = drawn.length > 0 && drawn.every((t) => t && shown.includes(t));
        out.rows = shown.length;
        out.n = app.playlist.length;
        out.allValid = shown.every(Boolean);
        out.removedGone = removed.every((p) => !shown.some((t) => t && t.path === p));
        const order = app.classicOrder();
        out.orderMatches = order.length === shown.length && order.every((t, i) => t === shown[i]);
        return out;
    });
    console.log(`remove one track with the archive shown (${N} tracks, CPU /${CPU}): ${r.sync.join(', ')} ms`);
    const checks = [
        ['archive view is shown', r.archiveOn],
        ['hidden classic list is not rebuilt on removal', r.rowsUntouched],
        ['classic list is drawn on return with every remaining track', r.rows === r.n && r.allValid && r.drawnValid],
        ['removed tracks are gone from the classic list', r.removedGone],
        ['classic play order matches what is shown', r.orderMatches],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!checks.every((c) => c[1])) console.log(JSON.stringify(r), errors);
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
