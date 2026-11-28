/*
 * Random interaction stress on the real music window (fake engine with load latency):
 * clicks play/pause, next, previous, seeks, plays from the archive context, queues
 * tracks, rescans the library, removes tracks. After each burst it lets things settle
 * and checks invariants:
 *   - no page errors
 *   - the play button agrees with the engine (playing ⇔ engine playing)
 *   - the track shown is the track the engine has loaded
 *   - the engine never got a load for an undefined path
 *
 *   node tests/music-window-bench/stress.cjs [--steps=300] [--seed=1] [--n=80]
 */
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const STEPS = Number(args.steps) || 300;
const N = Number(args.n) || 80;
let seed = Number(args.seed) || 1;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const FAKE = ({ n }) => {
    const mk = (i) => ({ path: 'D:\\Music\\a' + (i % 7) + '\\t' + i + '.flac', title: 'T' + i, artist: 'A' + (i % 5), album: 'L' + (i % 7), duration: 200 });
    const tracks = Array.from({ length: n }, (_, i) => mk(i));
    const w = window;
    w.__fake = { tracks, mk, calls: [], scanComplete: null, playbackEnded: null };
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8, is_loading: false };
    w.__engine = state;
    let startedAt = 0;
    w.__loadDelay = 60;
    const tick = () => { if (state.is_playing) state.current_time = Math.min(state.duration, (performance.now() - startedAt) / 1000); };
    const later = (ms) => new Promise((r) => setTimeout(r, ms));
    const fns = {
        getMusicPlaylist: async () => tracks.map((t) => ({ ...t })),
        getCustomPlaylists: async () => [{ id: 'p1', name: 'P1', tracks: tracks.slice(0, 12).map((t) => t.path) }],
        getMusicState: async () => { await later(5 + Math.random() * 30); tick(); return { status: 'success', state: { ...state } }; },
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        musicLoad: async (t) => {
            w.__fake.calls.push(['load', t && t.path]);
            state.is_loading = true; state.is_playing = false;
            await later(w.__loadDelay * (0.5 + Math.random()));
            state.file_path = t && t.path; state.current_time = 0; state.is_loading = false;
            return { status: 'success', state: { ...state } };
        },
        musicPlay: async () => { await later(Math.random() * 40); w.__fake.calls.push(['play']); if (state.file_path) { state.is_playing = true; startedAt = performance.now() - state.current_time * 1000; } return { status: 'success', state: { ...state } }; },
        musicPause: async () => { await later(Math.random() * 40); w.__fake.calls.push(['pause']); tick(); state.is_playing = false; return { status: 'success', state: { ...state } }; },
        seekMusic: async (p) => { await later(Math.random() * 30); state.current_time = Number(p) || 0; startedAt = performance.now() - state.current_time * 1000; return { status: 'success', state: { ...state } }; },
        getMusicLyrics: async () => null, fetchMusicLyrics: async () => null,
        onMusicScanComplete: (fn) => { w.__fake.scanComplete = fn; return () => {}; }
    };
    // music.js keeps app in a closure; the dock is handed it at start-up.
    let dock;
    Object.defineProperty(window, 'initMusicDock', { configurable: true, get: () => dock, set: (fn) => { dock = (app, ...rest) => { window.app = app; return fn(app, ...rest); }; } });
    window.electronAPI = new Proxy({}, { get: (_, k) => { if (typeof k !== 'string') return undefined; if (fns[k]) return fns[k]; if (k.startsWith('on')) return () => () => {}; return async () => ({ status: 'success' }); } });
};

const ACTIONS = {
    toggle: () => document.getElementById('play-pause-btn').click(),
    next: () => app.nextTrack(),
    prev: () => app.prevTrack(),
    seek: () => app.seekTo(Math.random() * 190),
    pick: () => { const i = Math.floor(Math.random() * app.playlist.length); app.loadTrack(i, true); },
    context: () => { const list = app.playlist.filter((_, i) => i % 3 === 0); app.playFromContext(list, app.playlist.indexOf(list[Math.floor(Math.random() * list.length)]), { render: false }); },
    queue: () => app.queueAdd?.(app.playlist[Math.floor(Math.random() * app.playlist.length)]),
    rescan: () => window.__fake.scanComplete?.({ tracks: window.__fake.tracks.filter(() => Math.random() > 0.05).map((t) => ({ ...t })), folderPath: 'D:\\Music' }),
    mode: () => { app.currentPlayMode = Math.floor(Math.random() * app.playModes.length); },
    ended: () => { if (window.__engine.is_playing) { window.__engine.is_playing = false; app.stopStatePolling(); app.isPlaying = false; app.nextTrack(); } }
};
const WEIGHTS = { toggle: 6, next: 5, prev: 2, seek: 3, pick: 3, context: 2, queue: 2, rescan: 1, mode: 1, ended: 2 };

module.exports = { FAKE };
if (require.main === module) (async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.addInitScript(FAKE, { n: N });
    await page.goto(`http://127.0.0.1:${server.address().port}/Musicmodules/music.html`, { timeout: 120000, waitUntil: 'commit' });
    await page.waitForFunction(() => window.app && window.app.playlist && window.app.playlist.length, null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    // The archive's 3D scene keeps a software rasteriser busy; the player logic is the same in the classic view.
    await page.evaluate(() => document.querySelector('[data-act="classic"]')?.click());
    await page.waitForTimeout(500);
    const bag = Object.entries(WEIGHTS).flatMap(([k, w]) => Array(w).fill(k));
    const problems = [];
    let done = 0;
    while (done < STEPS) {
        const burst = 1 + Math.floor(rand() * 5);
        const names = [];
        for (let i = 0; i < burst && done < STEPS; i++, done++) {
            const name = bag[Math.floor(rand() * bag.length)];
            names.push(name);
            await page.evaluate(`(${ACTIONS[name].toString()})()`).catch((e) => errors.push(name + ': ' + String(e).slice(0, 200)));
            await page.waitForTimeout(Math.floor(rand() * 120));
        }
        await page.waitForTimeout(1600);
        const s = await page.evaluate(() => {
            const t = app.playlist[app.currentTrackIndex];
            const norm = (p) => (p || '').toLowerCase().replace(/\\/g, '/');
            return {
                uiPlaying: app.isPlaying === true, buttonPlaying: document.getElementById('play-pause-btn').classList.contains('is-playing'),
                enginePlaying: window.__engine.is_playing, loading: app.isTrackLoading,
                shown: t && t.path, engine: window.__engine.file_path, same: norm(t && t.path) === norm(window.__engine.file_path),
                badLoads: window.__fake.calls.filter((c) => c[0] === 'load' && !c[1]).length
            };
        });
        if (args.verbose) console.log(done, JSON.stringify(s));
        const where = `after [${names.join(', ')}] at step ${done}`;
        if (s.badLoads) problems.push(`${where}: engine got a load without a path`);
        if (!s.loading && s.uiPlaying !== s.enginePlaying) problems.push(`${where}: button says ${s.uiPlaying ? 'playing' : 'paused'}, engine ${s.enginePlaying ? 'playing' : 'paused'}`);
        if (s.uiPlaying !== s.buttonPlaying) problems.push(`${where}: state and button class disagree`);
        if (!s.loading && s.engine && !s.same) problems.push(`${where}: shows ${s.shown}, engine has ${s.engine}`);
    }
    console.log(`${STEPS} steps, seed ${args.seed || 1}: ${errors.length} page errors, ${problems.length} invariant violations`);
    [...new Set(errors)].slice(0, 10).forEach((e) => console.log('  error:', e));
    problems.slice(0, 15).forEach((p) => console.log('  ' + p));
    await browser.close();
    server.close();
    process.exitCode = errors.length || problems.length ? 1 : 0;
})();
