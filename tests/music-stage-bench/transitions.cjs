/*
 * How the 3D stages behave at the three moments a listener notices a stall:
 * entering the stage, a new song starting, and switching to another stage.
 * Software rendering, so absolute times are inflated; compare runs, not machines.
 *
 *   node tests/music-stage-bench/transitions.cjs [--only=diorama,tunnel] [--size=1280x720]
 *
 * For each moment it reports the wall time until the new picture is drawn and
 * the longest main-thread task and frame gap inside that window.
 */
const path = require('node:path');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const [WIDTH, HEIGHT] = /^\d+x\d+$/.test(args.size || '') ? args.size.split('x').map(Number) : [1280, 720];
const MODES = (args.only || 'diorama,tunnel').split(',');

const OBSERVE = () => {
    window.__tasks = [];
    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__tasks.push([e.startTime, e.duration]);
        }).observe({ type: 'longtask', buffered: true });
    } catch { /* no long task timing */ }
    window.__gaps = [];
    let last = 0;
    const loop = (now) => { if (last) window.__gaps.push([last, now - last]); last = now; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
};

const windowStats = (page, from, to) => page.evaluate(([a, b]) => {
    const tasks = window.__tasks.filter(([s]) => s >= a && s <= b).map(([, d]) => d);
    const gaps = window.__gaps.filter(([s]) => s >= a && s <= b).map(([, d]) => d);
    return {
        longestTask: Math.round(Math.max(0, ...tasks)),
        taskTotal: Math.round(tasks.reduce((s, d) => s + d, 0)),
        longestGap: Math.round(Math.max(0, ...gaps))
    };
}, [from, to]);

const until = async (page, fn, arg, timeout = 120000) => {
    await page.waitForFunction(fn, arg, { timeout, polling: 16 });
    return page.evaluate(() => performance.now());
};

(async () => {
    const { default: serve } = { default: require('./serve.cjs') };
    const server = await serve(ROOT);
    const ORIGIN = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const results = [];
    try {
        for (const mode of MODES) {
            const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
            await page.addInitScript(OBSERVE);
            await page.goto(`${ORIGIN}/blank.html`);
            await page.evaluate((m) => { localStorage.clear(); localStorage.setItem('musicStageMode', m); }, mode);
            await page.goto(`${ORIGIN}/Musicmodules/harness.html?lyrics=song&duration=215&t=20`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.__h?.app?.stageHost, null, { timeout: 60000 });
            await page.waitForTimeout(800);
            const idle = await page.evaluate(() => performance.now());
            // 1. Enter.
            const t0 = await page.evaluate(() => { __h.app.stageHost.enter(); return performance.now(); });
            const t1 = await until(page, () => { try { return __h.snap().mode?.initialized; } catch { return false; } });
            await page.waitForTimeout(1500);
            const enter = { ms: Math.round(t1 - t0), ...(await windowStats(page, t0, t1 + 500)) };
            // 2. Next song.
            // The harness hands the new lyrics over 0.3 s after the track changes.
            const s0 = await page.evaluate(() => { __h.track(1); return performance.now(); });
            await page.waitForTimeout(3000);
            const song = await windowStats(page, s0, s0 + 3000);
            // 3. Switch to the other 3D stage and back.
            const other = mode === 'diorama' ? 'tunnel' : 'diorama';
            const w0 = await page.evaluate((m) => { __h.app.stageHost.setMode(m); return performance.now(); }, other);
            const w1 = await until(page, (m) => { const s = __h.snap(); return s.modeId === m && s.mode?.initialized; }, other);
            const sw = { to: other, ms: Math.round(w1 - w0), ...(await windowStats(page, w0, w1 + 500)) };
            const errors = await page.evaluate(() => __h.errors.slice(0, 5));
            results.push({ mode, enter, song, switch: sw, errors, idleTasks: (await windowStats(page, 0, idle)).taskTotal });
            await page.close();
        }
    } finally {
        await browser.close();
        server.close();
    }
    console.log(JSON.stringify(results, null, 2));
})();
