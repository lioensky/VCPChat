/*
 * 音乐窗口长时间续播：用 stress.cjs 的假引擎，让歌一首接一首「放完」自动续下一首几百次，
 * 每首都带一份 80 行的歌词。每隔一段强制 GC 后记 JS 堆、DOM 节点数、事件监听数、定时器相关的指标。
 *
 *   node tests/music-window-bench/renderer-soak.cjs [--rounds=400] [--view=archive|classic] [--n=200]
 */
const path = require('node:path');
const { chromium } = require('playwright');
const { FAKE } = require('./stress.cjs');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const ROUNDS = Number(args.rounds) || 400;
const N = Number(args.n) || 200;

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await page.addInitScript(FAKE, { n: N });
    await page.addInitScript(() => {
        // 每首都有歌词，让歌词列表每次换歌都重建。
        const lrc = Array.from({ length: 80 }, (_, i) => `[${String(Math.floor(i * 2.5 / 60)).padStart(2, '0')}:${String((i * 2.5) % 60).padStart(5, '0')}]第 ${i} 行歌词`).join('\n');
        const wrap = () => {
            const api = window.electronAPI;
            if (!api) return setTimeout(wrap, 0);
            window.electronAPI = new Proxy(api, { get: (t, k) => (k === 'getMusicLyrics' ? async () => lrc : t[k]) });
        };
        wrap();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/Musicmodules/music.html`, { timeout: 120000, waitUntil: 'commit' });
    await page.waitForFunction(() => window.app && window.app.playlist && window.app.playlist.length, null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    if (args.view === 'classic') await page.evaluate(() => document.querySelector('[data-act="classic"]')?.click());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const sample = async (round) => {
        await cdp.send('HeapProfiler.collectGarbage');
        const heap = await cdp.send('Runtime.getHeapUsage');
        const { metrics } = await cdp.send('Performance.getMetrics');
        const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
        const extra = await page.evaluate(() => ({
            lyricLis: document.querySelectorAll('#lyrics-list li').length,
            history: app.getHistory ? app.getHistory(10000).length : -1
        }));
        return { round, heapMb: +(heap.usedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents, frames: m.Frames, ...extra };
    };

    await page.evaluate(() => app.loadTrack(0, true));
    await page.waitForTimeout(800);
    const rows = [await sample(0)];
    const every = Math.max(1, Math.floor(ROUNDS / 8));
    const started = Date.now();
    for (let i = 1; i <= ROUNDS; i++) {
        const before = await page.evaluate(() => window.__fake.calls.filter((c) => c[0] === 'load').length);
        // 和 WebSocket 的 playback_ended 走同一个处理：停轮询、置为未播放、nextTrack。
        await page.evaluate(() => { window.__engine.is_playing = false; app.stopStatePolling(); app.isPlaying = false; app.playPauseBtn.classList.remove('is-playing'); app.nextTrack(); });
        await page.waitForFunction((n) => window.__fake.calls.filter((c) => c[0] === 'load').length > n && !app.isTrackLoading && window.__engine.is_playing, before, { timeout: 15000 })
            .catch(() => errors.push(`round ${i}: next song did not start`));
        await page.waitForTimeout(60);
        if (i % every === 0) rows.push(await sample(i));
    }
    console.log(`${ROUNDS} auto-continues in ${((Date.now() - started) / 1000).toFixed(0)} s, ${errors.length} errors`);
    console.table(rows);
    [...new Set(errors)].slice(0, 8).forEach((e) => console.log('  error:', e));
    await browser.close();
    server.close();
})();
