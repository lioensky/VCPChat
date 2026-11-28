/*
 * Cost and still frames of the lyric stages other than the 3D ones.
 *
 *   node tests/music-stage-bench/stage2d.cjs [--only=luminous,fume] [--secs=6] [--config='{...}']
 *       main-thread work per frame, split by kind (script, style, layout,
 *       paint, commit — commit is mostly waiting on the GPU here), elements
 *       restyled per frame, and the stage's own JS per frame.
 *       PAUSE=1 measures a paused stage.
 *   node tests/music-stage-bench/stage2d.cjs --shots=<dir> [--times=31,56]
 *       deterministic stills: paused, jumped away and back to each time so
 *       every mode rebuilds at exactly that moment; CSS animations paused,
 *       the window intro cover hidden. AUDIO=1 holds a fixed non-zero
 *       spectrum. Compare two checkouts with ROOT=<repo>.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, '..', '..'));
const serve = require(path.join(ROOT, 'tests/music-stage-bench/serve.cjs'));
const MODES = (args.only || 'luminous,partita,cadenza,fume,tempera,sonnet,starborn').split(',');
const SECS = Number(args.secs || 6);
const LYR = args.lyrics || 'song';
const [W, H] = (args.size || '1280x720').split('x').map(Number);
const T0 = Number(args.t || 30);
const KINDS = {
    script: ['FunctionCall', 'EvaluateScript', 'v8.run', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'RunMicrotasks'],
    style: ['UpdateLayoutTree', 'ScheduleStyleRecalculation'],
    layout: ['Layout'],
    prepaint: ['PrePaint'],
    paint: ['Paint', 'PaintImage', 'Layerize'],
    commit: ['Commit', 'CompositeLayers', 'UpdateLayer'],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, ns]) => ns.map(n => [n, k])));

// 真实歌词：LRC=路径 --lyrics=custom。同一时刻的两行当作原文 + 翻译
const customLyrics = () => {
    if (!process.env.LRC) return null;
    const rows = new Map();
    fs.readFileSync(process.env.LRC, 'utf8').split(/\r?\n/).forEach((line) => {
        const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
        if (!m) return;
        const time = +(Number(m[1]) * 60 + Number(m[2])).toFixed(3);
        const text = m[3].trim();
        if (!rows.has(time)) rows.set(time, []);
        if (text) rows.get(time).push(text);
    });
    return [...rows].filter(([, t]) => t.length).sort((a, b) => a[0] - b[0])
        .map(([time, [original, translation = '']]) => ({ time, original, translation }));
};
const newPage = async (browser) => {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: Number(process.env.DPR || 1) });
    const lyrics = customLyrics();
    if (lyrics) await page.addInitScript(l => { window.__customLyrics = l; }, lyrics);
    return page;
};

const run = async (browser, origin, mode, config) => {
    const page = await newPage(browser);
    await page.goto(`${origin}/blank.html`);
    await page.evaluate(([m, c]) => {
        localStorage.clear();
        localStorage.setItem('musicStageMode', m);
        if (c) localStorage.setItem('musicStageConfig', JSON.stringify(c));
    }, [mode, config || null]);
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=${LYR}&duration=215&t=${T0}`);
    await page.waitForTimeout(600);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForTimeout(3000);
    await page.evaluate(t => { __h.seek(t); __h.frameTimes.length = 0; }, T0);
    await page.waitForTimeout(800);
    const cdp = await page.context().newCDPSession(page);
    const events = [];
    cdp.on('Tracing.dataCollected', e => events.push(...e.value));
    const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
    if (process.env.PAUSE) { await page.evaluate(() => __h.pause()); await page.waitForTimeout(2500); }
    await page.evaluate(() => { __h.frameTimes.length = 0; });
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
    await page.waitForTimeout(SECS * 1000);
    await cdp.send('Tracing.end');
    await done;
    const ft = await page.evaluate(() => ({ f: __h.frameTimes.slice(), e: __h.errors.slice(0, 3) }));
    // main thread of the renderer: thread named CrRendererMain
    const main = events.find(e => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
    const sums = {}; let count = {};
    // Avoid double counting nested: only top-level per kind (sum X events of that name; nested same-kind rare)
    for (const e of events) {
        if (!main || e.pid !== main.pid || e.tid !== main.tid || e.ph !== 'X') continue;
        const k = KIND_OF.get(e.name); if (!k) continue;
        if (k === 'script' && e.name !== 'FireAnimationFrame' && e.name !== 'TimerFire' && e.name !== 'EventDispatch') continue;
        sums[k] = (sums[k] || 0) + (e.dur || 0) / 1000; count[k] = (count[k] || 0) + 1;
    }
    const style = events.filter(e => main && e.pid === main.pid && e.tid === main.tid && e.name === 'UpdateLayoutTree' && e.ph === 'X');
    const elems = style.reduce((s, e) => s + (e.args?.elementCount || 0), 0);
    const nf = Math.max(1, ft.f.length); const per = v => +(v / nf).toFixed(2);
    const costs = ft.f.map(([, c]) => c).sort((a, b) => a - b);
    const q = p => costs.length ? costs[Math.min(costs.length - 1, Math.floor(costs.length * p))] : 0;
    await page.close();
    return {
        mode, frames: ft.f.length,
        msPerFrame: Object.fromEntries(Object.keys(KINDS).map(k => [k, per(sums[k] || 0)])),
        gpuish: +(((sums.commit || 0)) / SECS).toFixed(1), paintPerSec: +((sums.paint || 0) / SECS).toFixed(1), styleRecalcs: per(count.style || 0), styledElemsPerFrame: Math.round(elems / nf), fps: +(ft.f.length / SECS).toFixed(1), layouts: per(count.layout || 0),
        jsFrame: { p50: q(0.5), p95: q(0.95), max: costs.at(-1) || 0 }, errors: ft.e
    };
};

const shots = async (browser, origin, mode, dir, times, config) => {
    fs.mkdirSync(dir, { recursive: true });
    const page = await newPage(browser);
    if (process.env.STAGE_LOG) { page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text().slice(0, 1500)); }); page.on('pageerror', e => console.error('[pageerror]', String(e).slice(0, 1500))); }
    await page.goto(`${origin}/blank.html`);
    await page.evaluate(([m, c]) => { localStorage.clear(); localStorage.setItem('musicStageMode', m); if (c) localStorage.setItem('musicStageConfig', JSON.stringify(c)); }, [mode, config || null]);
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=${LYR}&duration=215&t=${times[0]}`);
    await page.waitForTimeout(600);
    // LIGHT=1: the app's light theme.
    if (process.env.LIGHT) await page.evaluate(() => { __h.app.currentTheme = 'light'; document.body.classList.add('light-theme'); });
    // COVER=/assets/x.jpg: give the track that cover.
    if (process.env.COVER) await page.evaluate(c => { const tr = __h.app.playlist?.[__h.app.currentTrackIndex]; if (tr) tr.albumArt = location.origin + c; }, process.env.COVER);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.addStyleTag({ content: '#music-intro-cover{display:none!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important}' });
    await page.waitForTimeout(3000);
    for (const t of times) {
        // Freeze: jump away and back so every mode rebuilds at exactly t.
        await page.evaluate(([x, audio]) => {
            __h.pause();
            if (audio) __h.app.currentVisualizerData = Array.from({ length: 128 }, (_, i) => i < 13 ? 0.85 : 0.55 - i / 400);
            __h.seek(x - 5);
        }, [t, Boolean(process.env.AUDIO)]);
        await page.waitForTimeout(400);
        await page.evaluate(x => { __h.seek(x); }, t);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(dir, `${mode}-${String(t).replace('.', '_')}.png`) });
    }
    await page.close();
};

(async () => {
    const server = await serve(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const config = args.config ? JSON.parse(args.config) : null;
    const out = [];
    for (const m of MODES) {
        if (args.shots) { await shots(browser, origin, m, args.shots, (args.times || '30,33.2,56,57.5').split(',').map(Number), config); continue; }
        const r = await run(browser, origin, m, config);
        out.push(r);
        console.log(JSON.stringify(r));
    }
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
    await browser.close(); server.close();
})();
