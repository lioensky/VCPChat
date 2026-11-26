/*
 * The whole music window (real music.html, fake preload API) measured from outside:
 *
 *   start-up   time until the window reports ready, main-thread long tasks on the way, heap
 *   steady     calls to the main process per second, by name, and animation frames requested
 *              per second, by script — paused, playing, and playing with the window hidden
 *
 *   node tests/music-window-bench/window-bench.cjs [--n=600,5000] [--seconds=8] [--out=<file.json>]
 *
 * Software rendering: compare runs with each other, not with a real machine.
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const SIZES = String(args.n || '600,5000').split(',').map(Number);
const SECONDS = Number(args.seconds) || 8;

const FAKE = ({ n }) => {
    const tracks = Array.from({ length: n }, (_, i) => ({
        path: 'D:\\Music\\album' + (i % 400) + '\\t' + i + '.flac', title: '曲目 ' + (i + 1), artist: 'Artist ' + (i % 90),
        album: 'Album ' + (i % 400), duration: 200, sampleRate: 44100, bitsPerSample: 16, codec: 'FLAC', lossless: true
    }));
    const bench = window.__bench = { calls: {}, frames: {}, longTasks: [], marks: {}, t0: performance.now() };
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8 };
    let startedAt = 0;
    const tick = () => { if (state.is_playing) state.current_time = Math.min(200, (performance.now() - startedAt) / 1000); };
    const fns = {
        getMusicPlaylist: async () => tracks,
        getCustomPlaylists: async () => [],
        getMusicState: async () => { tick(); return { status: 'success', state: { ...state } }; },
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [],
        listWebdavServers: async () => [],
        musicLoad: async (t) => { state.file_path = t && t.path; state.current_time = 0; return { status: 'success', state: { ...state } }; },
        musicPlay: async () => { state.is_playing = true; startedAt = performance.now() - state.current_time * 1000; return { status: 'success', state: { ...state } }; },
        musicPause: async () => { tick(); state.is_playing = false; return { status: 'success', state: { ...state } }; },
        getMusicLyrics: async () => null, fetchMusicLyrics: async () => null,
        musicRendererReady: () => { bench.marks.ready = performance.now(); }
    };
    window.electronAPI = new Proxy({}, {
        get: (_, key) => {
            if (typeof key !== 'string') return undefined;
            if (key.startsWith('on')) return () => () => {};
            return (...a) => {
                bench.calls[key] = (bench.calls[key] || 0) + 1;
                return (fns[key] || (async () => ({ status: 'success' })))(...a);
            };
        }
    });
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
        const frame = (new Error().stack.split('\n')[2] || '').match(/([\w.-]+\.js)/);
        const who = frame ? frame[1] : 'other';
        bench.frames[who] = (bench.frames[who] || 0) + 1;
        return raf(cb);
    };
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) bench.longTasks.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (_) { /* not supported */ }
};

const perSecond = (before, after, seconds) => Object.fromEntries(Object.keys(after)
    .map((key) => [key, +(((after[key] || 0) - (before[key] || 0)) / seconds).toFixed(1)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]));

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const url = `http://127.0.0.1:${server.address().port}/Musicmodules/music.html`;
    const report = [];
    for (const n of SIZES) {
        const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
        const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
        await page.addInitScript(FAKE, { n });
        await page.goto(url, { timeout: 120000, waitUntil: 'commit' }); // software rendering can hold the load event for a long time
        await page.waitForFunction(() => window.__bench.marks.ready, null, { timeout: 120000 });
        await page.waitForTimeout(4000); // intro animation and first paints settle
        const start = await page.evaluate(() => ({
            readyMs: Math.round(window.__bench.marks.ready), domContentLoadedMs: Math.round(performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd),
            longTasks: window.__bench.longTasks.length, longTaskMs: window.__bench.longTasks.reduce((a, b) => a + b, 0), longestTaskMs: Math.max(0, ...window.__bench.longTasks),
            heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1), nodes: document.getElementsByTagName('*').length
        }));
        const snap = () => page.evaluate(() => ({ calls: { ...window.__bench.calls }, frames: { ...window.__bench.frames } }));
        const window_ = async (label, prepare) => {
            if (prepare) await prepare();
            await page.waitForTimeout(2500);
            const a = await snap();
            await page.waitForTimeout(SECONDS * 1000);
            const b = await snap();
            const calls = perSecond(a.calls, b.calls, SECONDS);
            const frames = perSecond(a.frames, b.frames, SECONDS);
            return { label, callsPerSecond: +Object.values(calls).reduce((x, y) => x + y, 0).toFixed(1), calls, framesPerSecond: +Object.values(frames).reduce((x, y) => x + y, 0).toFixed(1), frames };
        };
        const steady = [];
        steady.push(await window_('paused, archive view'));
        steady.push(await window_('playing, archive view', () => page.evaluate(() => document.getElementById('play-pause-btn')?.click())));
        steady.push(await window_('playing, window hidden', () => page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        })));
        report.push({ tracks: n, start, steady, errors });
        console.log(`\n${n} tracks: ready ${start.readyMs} ms, long tasks ${start.longTasks} (${start.longTaskMs} ms, longest ${start.longestTaskMs} ms), heap ${start.heapMB} MB, ${start.nodes} nodes${errors.length ? ', page errors: ' + errors.length : ''}`);
        for (const s of steady) {
            console.log(`  ${s.label.padEnd(24)} main-process calls ${String(s.callsPerSecond).padStart(5)}/s  ${JSON.stringify(s.calls)}`);
            console.log(`  ${''.padEnd(24)} frames requested   ${String(s.framesPerSecond).padStart(5)}/s  ${JSON.stringify(s.frames)}`);
        }
        if (errors.length) console.log('  errors:', errors.slice(0, 3).join(' | '));
        await browser.close();
    }
    if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
    server.close();
})();
