/*
 * What the music window pays at start-up just to have its scripts: loads the
 * <script src> list of Musicmodules/music.html one by one into a blank page
 * and times each (fetch from localhost + compile + top-level run).
 *
 *   node tests/music-window-bench/script-cost.cjs [--runs=5] [--throttle=4]
 *
 * Prints the median total, the cost by group and the heaviest scripts.
 * Scripts whose top level needs the real window (preload API) may throw;
 * the time until they throw still counts and the error is listed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const RUNS = Number(args.runs) || 5;
const THROTTLE = Number(args.throttle) || 1;
const html = fs.readFileSync(path.join(ROOT, 'Musicmodules/music.html'), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
const groupOf = (src) => /pixi|three\.min|socket\.io/.test(src) ? 'libraries'
    : src.startsWith('music-stage/') ? 'stage (3D and 2D modes)'
    : /^music-(archive|dock|theme|intro)\//.test(src) ? src.split('/')[0] : 'player';
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
    const server = await require('../music-stage-bench/serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    const perScript = new Map(scripts.map((s) => [s, []]));
    const totals = [];
    for (let run = 0; run < RUNS; run++) {
        const page = await browser.newPage();
        if (THROTTLE > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
        await page.goto(`${origin}/Musicmodules/blank.html`).catch(() => {});
        await page.goto(`${origin}/blank.html`);
        await page.evaluate(() => { history.replaceState(null, '', '/Musicmodules/x.html'); });
        const times = await page.evaluate(async (list) => {
            const out = [];
            for (const src of list) {
                const t0 = performance.now();
                await new Promise((resolve) => {
                    const el = document.createElement('script');
                    el.src = src; el.onload = el.onerror = resolve;
                    document.head.appendChild(el);
                });
                out.push(performance.now() - t0);
            }
            return out;
        }, scripts);
        times.forEach((ms, i) => perScript.get(scripts[i]).push(ms));
        totals.push(times.reduce((a, b) => a + b, 0));
        await page.close();
    }
    const rows = scripts.map((src) => ({ src, ms: median(perScript.get(src)), kb: (() => { try { return Math.round(fs.statSync(path.join(ROOT, 'Musicmodules', src)).size / 1024); } catch (_) { return 0; } })() }));
    const groups = {};
    for (const row of rows) { const g = groups[groupOf(row.src)] ||= { ms: 0, kb: 0, n: 0 }; g.ms += row.ms; g.kb += row.kb; g.n++; }
    console.log(`scripts ${scripts.length}, median total ${median(totals).toFixed(0)} ms (cpu throttle ${THROTTLE}x, ${RUNS} runs)`);
    for (const [name, g] of Object.entries(groups).sort((a, b) => b[1].ms - a[1].ms)) console.log(`  ${name.padEnd(26)} ${g.ms.toFixed(0).padStart(5)} ms  ${String(g.kb).padStart(5)} KB  ${g.n} files`);
    console.log('heaviest:');
    for (const row of rows.sort((a, b) => b.ms - a.ms).slice(0, 8)) console.log(`  ${row.ms.toFixed(1).padStart(6)} ms  ${String(row.kb).padStart(5)} KB  ${row.src}`);
    await browser.close();
    server.close();
})();
