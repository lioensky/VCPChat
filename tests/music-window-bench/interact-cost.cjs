/*
 * Main-thread cost of everyday actions on a big library (real music.html, fake engine):
 * next track, search typing, switching list kinds and sorts, queueing, removing a track,
 * rescanning. Reports wall time and the long tasks (> 50 ms) each action causes.
 *
 *   node tests/music-window-bench/interact-cost.cjs [--n=5000] [--cpu=4] [--settle=20000]
 *
 * Software rendering and CPU throttling: compare runs with each other, not with a real machine.
 */
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const N = Number(args.n) || 5000;
const CPU = Number(args.cpu) || 4;

const FAKE = ({ n }) => {
    const tracks = Array.from({ length: n }, (_, i) => ({
        path: 'D:\\Music\\album' + (i % 400) + '\\t' + i + '.flac', title: '曲目 ' + (i + 1) + (i % 7 ? '' : ' Live'), artist: 'Artist ' + (i % 90),
        album: 'Album ' + (i % 400), duration: 200, sampleRate: 44100, bitsPerSample: 16, codec: 'FLAC', lossless: true
    }));
    window.__tracks = tracks;
    const w = window;
    w.__long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    const state = { is_playing: false, current_time: 0, duration: 200, file_path: null, volume: 0.8 };
    window.confirm = () => true;
    const fns = {
        getMusicPlaylist: async () => tracks,
        getCustomPlaylists: async () => [{ id: 'p', name: 'L', tracks: tracks.slice(0, 300).map((t) => t.path) }],
        getMusicState: async () => ({ status: 'success', state: { ...state } }),
        getMusicPendingTrack: async () => null,
        getCurrentTheme: async () => 'dark',
        getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
        listMusicIrPresets: async () => [], listWebdavServers: async () => [],
        getAudioEngineEndpoint: async () => ({ state: 'ready', wsUrl: 'ws://127.0.0.1:9/ws' }),
        musicLoad: async (t) => { state.file_path = t.path; state.current_time = 0; return { status: 'success', state: { ...state } }; },
        musicPlay: async () => { state.is_playing = true; return { status: 'success', state: { ...state } }; },
        musicPause: async () => { state.is_playing = false; return { status: 'success', state: { ...state } }; },
        onMusicScanComplete: (fn) => { (w.__completes ||= []).push(fn); return () => {}; },
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
    // 拼音表到了以后档案页要分片重算全部检索条目；软件渲染下要十几秒。没等完就量，
    // 头几步（删歌、排序、选行）会把这次重算算进去，数字大好几倍。
    await page.waitForFunction(() => window.pinyinPro, null, { timeout: 180000 }).catch(() => {});
    await page.waitForTimeout(Number(args.settle) || 20000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

    const measure = async (name, fn, settleMs = 1200) => {
        await page.evaluate(() => { window.__long.length = 0; window.__t0 = performance.now(); });
        // 同步部分的耗时单独记：档案页的 3D 场景在软件渲染下一帧就要几秒，长任务里分不出是谁。
        const sync = await page.evaluate(`(async () => { const f = (${fn.toString()}); const t = performance.now(); const p = f(); const s = performance.now() - t; await p; return s; })()`);
        await page.waitForTimeout(settleMs);
        const r = await page.evaluate(() => {
            const longs = window.__long.filter((l) => l.at >= window.__t0);
            return { longest: Math.round(Math.max(0, ...longs.map((l) => l.ms))), total: Math.round(longs.reduce((s, l) => s + l.ms, 0)), count: longs.length };
        });
        r.sync = Math.round(sync);
        console.log(`${name.padEnd(34)} sync ${String(r.sync).padStart(5)} ms  long tasks ${String(r.count).padStart(2)}  longest ${String(r.longest).padStart(5)} ms  total ${String(r.total).padStart(5)} ms`);
        return { name, ...r };
    };
    // --profile=<action name>：只对那一步录 CPU 分析，打印自身耗时最多的函数
    const profileTarget = args.profile || null;
    const profiled = async (name, run) => {
        if (name !== profileTarget) return run();
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
        const out = await run();
        const { profile } = await cdp.send('Profiler.stop');
        const self = new Map();
        const dt = profile.timeDeltas || [];
        const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
        (profile.samples || []).forEach((id, i) => {
            const cf = byId.get(id).callFrame;
            const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`;
            self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
        });
        [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top) || 15).forEach(([k, ms]) => console.log(`   ${ms.toFixed(0).padStart(6)} ms  ${k}`));
        return out;
    };
    const rows = [];
    const profiledMeasure = (name, fn, settle) => profiled(name, () => measure(name, fn, settle));
    rows.push(await profiledMeasure('load + play track 10', async () => { await app.loadTrack(10, true); }));
    rows.push(await profiledMeasure('playing, archive, 5 s', async () => { await new Promise((r) => setTimeout(r, 5000)); }, 100));
    rows.push(await profiledMeasure('next track x5', async () => { for (let i = 0; i < 5; i++) { app.nextTrack(); await new Promise((r) => setTimeout(r, 150)); } }, 2000));
    rows.push(await profiledMeasure('archive search: type "live"', async () => {
        const list = app.archiveView.list;
        for (const s of ['l', 'li', 'liv', 'live']) { list.typeInto(s); await new Promise((r) => setTimeout(r, 120)); }
    }, 2000));
    rows.push(await profiledMeasure('archive search: clear', async () => { app.archiveView.list.typeInto(''); }));
    for (const kind of ['album', 'artist', 'all']) {
        rows.push(await profiledMeasure(`archive kind: ${kind}`, new Function(`app.archiveView.list.setKind('${kind}')`), 1500));
    }
    rows.push(await profiledMeasure('archive sort: artist', () => app.archiveView.setSort('artist'), 2000));
    rows.push(await profiledMeasure('archive sort: title', () => app.archiveView.setSort('title'), 2000));
    rows.push(await profiledMeasure('archive select next row x40', () => { const v = app.archiveView; const d = v.debug(); for (let i = 1; i <= 40; i++) v.select(d.lane, d.row + i); }, 1500));
    rows.push(await profiledMeasure('queue add x20', () => { for (let i = 100; i < 120; i++) app.queueAdd(app.playlist[i]); }));
    rows.push(await profiledMeasure('remove one track', () => app.removeTrackInScope(200, null), 2000));
    rows.push(await profiledMeasure('rescan complete (same 5000)', () => {
        for (const fn of window.__completes || []) fn({ tracks: window.__tracks.map((t) => ({ ...t })), folderPath: 'D:\\Music' });
    }, 3000));
    rows.push(await profiledMeasure('classic view', () => document.querySelector('[data-act="classic"]')?.click(), 2000));
    rows.push(await profiledMeasure('playing, classic, 5 s', async () => { await app.playTrack?.(); await new Promise((r) => setTimeout(r, 5000)); }, 100));
    rows.push(await profiledMeasure('classic search: type "live"', async () => {
        for (const s of ['l', 'li', 'liv', 'live']) { app.searchInput.value = s; app.searchInput.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 120)); }
    }, 2000));
    rows.push(await profiledMeasure('classic search: clear', () => { app.searchInput.value = ''; app.searchInput.dispatchEvent(new Event('input')); }, 2000));
    rows.push(await profiledMeasure('next track x5 (classic)', async () => { for (let i = 0; i < 5; i++) { app.nextTrack(); await new Promise((r) => setTimeout(r, 150)); } }, 2000));
    console.log(errors.length ? 'page errors: ' + errors.join(' | ') : 'no page errors');
    if (args.out) require('node:fs').writeFileSync(args.out, JSON.stringify({ n: N, cpu: CPU, rows }, null, 2));
    await browser.close();
    server.close();
})();
