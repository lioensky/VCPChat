/*
 * The classic list with a very large library (default 20000 tracks): the DOM keeps only
 * the rows near the viewport, and every list behaviour still works on rows far away:
 * clicking, the context menu, the playing highlight, scrolling to the playing track,
 * play order, sorting, search, removal. Reports the main-thread cost of each step.
 *
 *   node tests/music-window-bench/classic-big-list.cjs [--n=20000] [--cpu=4]
 */
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const N = Number(args.n) || 20000;
const CPU = Number(args.cpu) || 4;

const FAKE = ({ n }) => {
    const tracks = Array.from({ length: n }, (_, i) => ({
        path: 'D:\\Music\\a' + (i % 400) + '\\t' + i + '.flac', title: 'Song ' + String(i).padStart(5, '0'), artist: 'Artist ' + (i % 90), album: 'Album ' + (i % 400), duration: 100 + (i % 300)
    }));
    const w = window;
    w.__long = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
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
        musicLoad: async (t) => { state.file_path = t.path; state.current_time = 0; w.__loaded = t.path; return { status: 'success', state: { ...state } }; },
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
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

    const rows = [];
    const step = async (name, fn, settle = 1500) => {
        await page.evaluate(() => { window.__long.length = 0; window.__t0 = performance.now(); });
        const sync = await page.evaluate(`(async () => { const t = performance.now(); await (${fn})(); return performance.now() - t; })()`);
        await page.waitForTimeout(settle);
        const r = await page.evaluate(() => {
            const longs = window.__long.filter((l) => l.at >= window.__t0);
            return { longest: Math.round(Math.max(0, ...longs.map((l) => l.ms))), total: Math.round(longs.reduce((s, l) => s + l.ms, 0)), dom: window.app.playlistEl.children.length };
        });
        console.log(`${name.padEnd(30)} sync ${String(Math.round(sync)).padStart(5)} ms  longest ${String(r.longest).padStart(5)} ms  long total ${String(r.total).padStart(6)} ms  rows in DOM ${r.dom}`);
        rows.push({ name, sync: Math.round(sync), ...r });
        return r;
    };
    const classic = await step('classic view', () => document.querySelector('[data-act="classic"]')?.click(), 3000);
    await step('scroll to the middle', async () => { const l = window.app.playlistEl; l.scrollTop = l.scrollHeight / 2; l.dispatchEvent(new Event('scroll')); await new Promise((r) => requestAnimationFrame(() => r())); });
    // 视口里的某一行：点它、右键它，拿到的必须是那一行显示的歌
    const visible = await page.evaluate(() => {
        const l = window.app.playlistEl, box = l.getBoundingClientRect();
        const li = Array.from(l.children).find((x) => { const r = x.getBoundingClientRect(); return r.top > box.top + 40 && r.bottom < box.bottom; });
        if (!li) return null;
        const r = li.getBoundingClientRect();
        return { x: r.left + 30, y: r.top + r.height / 2, title: li.querySelector('.cl-title')?.textContent || li.textContent };
    });
    let clicked = null, menu = null;
    if (visible) {
        await page.mouse.click(visible.x, visible.y);
        await page.waitForTimeout(800);
        clicked = await page.evaluate(() => window.app.playlist[window.app.currentTrackIndex]?.title);
        // 点播会把正在放的那首滚到四分之一处，右键前重新找一行
        Object.assign(visible, await page.evaluate(() => {
            const l = window.app.playlistEl, box = l.getBoundingClientRect();
            const li = Array.from(l.children).find((x) => { const r = x.getBoundingClientRect(); return r.top > box.top + 40 && r.bottom < box.bottom && !x.classList.contains('active'); });
            const r = li.getBoundingClientRect();
            return { x: r.left + 30, y: r.top + r.height / 2, menuTitle: li.querySelector('.cl-title')?.textContent || li.textContent };
        }));
        await page.mouse.click(visible.x, visible.y, { button: 'right' });
        await page.waitForTimeout(300);
        menu = await page.evaluate(() => window.app.playlist[window.app.contextMenuTrackIndex]?.title);
        await page.keyboard.press('Escape');
    }
    const deep = N - 7;
    await page.evaluate((i) => window.app.loadTrack(i, false), deep);
    await page.waitForTimeout(1200);
    const deepShown = await page.evaluate(() => {
        const l = window.app.playlistEl, box = l.getBoundingClientRect();
        const li = l.querySelector('li.active');
        if (!li) return { found: false };
        const r = li.getBoundingClientRect();
        return { found: true, inView: r.top >= box.top - 1 && r.bottom <= box.bottom + 1, title: li.querySelector('.cl-title')?.textContent };
    });
    const order = await page.evaluate(() => { const o = window.app.classicOrder(); return { n: o.length, first: o[0]?.title, last: o[o.length - 1]?.title }; });
    await step('sort by title, descending', async () => { const b = document.querySelector('.music-list-sort.is-title'); b.click(); b.click(); });
    const sortedTop = await page.evaluate(() => { const l = window.app.playlistEl; l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); return new Promise((r) => requestAnimationFrame(() => r(l.querySelector('li .cl-title')?.textContent))); });
    await step('sort back to added order', async () => { document.querySelector('.music-list-sort.is-added').click(); });
    await step('search "song 1999"', async () => { const s = window.app.searchInput; s.value = 'song 1999'; s.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 400)); });
    const found = await page.evaluate(() => Array.from(window.app.playlistEl.children, (li) => li.querySelector('.cl-title')?.textContent || li.textContent));
    await step('search clear', async () => { const s = window.app.searchInput; s.value = ''; s.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 400)); });
    const removeAt = 3;
    const removedTitle = await page.evaluate((i) => window.app.playlist[i].title, removeAt);
    await step('remove one track', (`() => window.app.removeTrackInScope(${removeAt}, null)`));
    const afterRemove = await page.evaluate((t) => ({ n: window.app.playlist.length, gone: !window.app.classicOrder().some((x) => x.title === t) }), removedTitle);

    const maxRows = Math.max(...rows.map((r) => r.dom));
    const checks = [
        ['DOM keeps a window of rows, not the whole library', maxRows < 400],
        ['clicking a visible row plays that row', Boolean(visible) && clicked === visible.title],
        ['right-clicking a visible row targets that row', Boolean(visible) && menu === visible.menuTitle],
        ['playing a track near the end scrolls it into view and highlights it', deepShown.found && deepShown.inView && deepShown.title === 'Song ' + String(deep).padStart(5, '0')],
        ['play order covers the whole list', order.n === N && order.first === 'Song 00000' && order.last === 'Song ' + String(N - 1).padStart(5, '0')],
        ['descending title sort puts the last song first', sortedTop === 'Song ' + String(N - 1).padStart(5, '0')],
        ['search shows the matching songs', found.includes('Song 01999') && found.every((t) => /1999/.test(t))],
        ['removed track is gone', afterRemove.n === N - 1 && afterRemove.gone],
        ['no page errors', errors.length === 0]
    ];
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!checks.every((c) => c[1])) console.log(JSON.stringify({ visible, clicked, menu, deepShown, order, sortedTop, found: found.slice(0, 3), afterRemove }), errors);
    if (args.out) require('node:fs').writeFileSync(args.out, JSON.stringify({ n: N, cpu: CPU, rows }, null, 2));
    await browser.close();
    server.close();
    process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
})();
