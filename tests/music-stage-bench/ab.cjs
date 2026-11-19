/*
 * A/B cost of stage features on the software rasteriser. Each variant runs
 * the same song position with one thing changed (a config value or a style
 * rule), and the mean frame interval is compared against the variant called
 * "base". Software rendering is slow, so only the ratios mean anything; they
 * are repeatable and need no GPU, which is the point.
 *
 *   node tests/music-stage-bench/ab.cjs [--mode=diorama] [--t=56] [--size=1600x900]
 *       [--quality=standard] [--frames=40] [--set=overlays|edge|cover|scene|all] [--wallpaper]
 *       [--out=<file.json>]
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const [WIDTH, HEIGHT] = /^\d+x\d+$/.test(args.size || '') ? args.size.split('x').map(Number) : [1600, 900];
const MODE = args.mode || 'diorama';
const AT = Number(args.t) || 56;
const FRAMES = Number(args.frames) || 40;
const QUALITY = args.quality || 'standard';

const overlaysOff = '.music-stage-backdrop,.music-stage-edge-spectrum{display:none!important}*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
const SETS = {
    overlays: [
        { name: 'base' },
        { name: 'no cover backdrop', css: '.music-stage-backdrop{display:none!important}' },
        { name: 'no edge spectrum', css: '.music-stage-edge-spectrum{display:none!important}' },
        { name: 'no backdrop-filter', css: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' },
        { name: 'scene only', css: overlaysOff }
    ],
    edge: [
        { name: 'base' },
        { name: 'no edge spectrum', css: '.music-stage-edge-spectrum{display:none!important}' },
        { name: 'edge: no flow ring', css: '.music-stage-edge-flow{display:none!important}' },
        { name: 'edge: no canvas glow', css: '.music-stage-edge-spectrum-canvas{filter:none!important}' },
        { name: 'edge: no canvas', css: '.music-stage-edge-spectrum-canvas{display:none!important}' },
        { name: 'edge: no corners', css: '.music-stage-edge-corners{display:none!important}' },
        { name: 'edge: no group opacity', css: '.music-stage-edge-spectrum{opacity:1!important;transition:none!important}' },
        { name: 'edge: no group/contain', css: '.music-stage-edge-spectrum{opacity:1!important;transition:none!important;contain:none!important;overflow:visible!important}' },
        { name: 'edge: canvas+ring only', css: '.music-stage-edge-spectrum{opacity:1!important;transition:none!important}.music-stage-edge-flow,.music-stage-edge-corners{display:none!important}' }
    ],
    cover: [
        { name: 'base' },
        { name: 'no cover backdrop', css: '.music-stage-backdrop{display:none!important}' },
        { name: 'cover: still', css: '.music-stage-backdrop-layer{transform:scale(1.13)!important}' },
        { name: 'cover: no blur', css: '.music-stage-backdrop-layer,.music-stage-backdrop::before{filter:none!important}' },
        { name: 'cover: no noise', css: '.music-stage-backdrop-noise{display:none!important}' },
        { name: 'cover: no shade', css: '.music-stage-shade{display:none!important}' }
    ],
    scene: [
        { name: 'base', css: overlaysOff },
        { name: 'no post-processing', css: overlaysOff, stage: { postProcess: false } },
        { name: 'no water reflection', css: overlaysOff, stage: { waterReflection: false } },
        { name: 'energy-saving', css: overlaysOff, quality: 'energy-saving' },
        { name: 'ultimate', css: overlaysOff, quality: 'ultimate' }
    ]
};
SETS.all = [...SETS.overlays, ...SETS.scene.slice(1)];

const run = async (page, origin, variant) => {
    const config = { quality: variant.quality || QUALITY, ...(variant.config || {}) };
    if (variant.stage) config.modes = { [MODE]: variant.stage };
    await page.goto(`${origin}/blank.html`);
    await page.evaluate(({ mode, config }) => {
        localStorage.clear();
        localStorage.setItem('musicStageMode', mode);
        localStorage.setItem('musicStageConfig', JSON.stringify(config));
    }, { mode: MODE, config });
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=${AT}`);
    await page.waitForTimeout(400);
    // A theme wallpaper, as most themes have one: the stage blurs it behind the 2D modes.
    if (args.wallpaper) await page.addStyleTag({ content: 'body{background-image:url("/assets/musicdark.jpeg")}' });
    await page.evaluate(() => __h.app.stageHost.enter());
    if (variant.css) await page.addStyleTag({ content: variant.css });
    if (variant.script) await page.evaluate(variant.script);
    await page.waitForTimeout(3500);
    await page.evaluate((t) => __h.seek(t), AT);
    await page.waitForTimeout(800);
    return page.evaluate((count) => new Promise((resolve) => {
        const gaps = [];
        let last = 0;
        const step = (now) => {
            if (last) gaps.push(now - last);
            last = now;
            if (gaps.length < count) requestAnimationFrame(step);
            else {
                gaps.sort((a, b) => a - b);
                resolve({ mean: gaps.reduce((a, b) => a + b, 0) / gaps.length, p50: gaps[gaps.length >> 1] });
            }
        };
        requestAnimationFrame(step);
    }), FRAMES);
};

(async () => {
    const server = await require('./serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await (await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })).newPage();
    page.setDefaultTimeout(180000);
    const variants = SETS[args.set || 'all'];
    const rows = [];
    for (const variant of variants) {
        const result = await run(page, origin, variant);
        rows.push({ variant: variant.name, meanMs: +result.mean.toFixed(1), p50Ms: +result.p50.toFixed(1) });
    }
    const base = rows.find((row) => row.variant === 'base')?.meanMs || rows[0].meanMs;
    for (const row of rows) {
        row.vsBase = `${Math.round(100 * row.meanMs / base)}%`;
        console.log(`${row.variant.padEnd(22)} ${String(row.meanMs).padStart(7)} ms  ${row.vsBase}`);
    }
    if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify({ mode: MODE, t: AT, size: [WIDTH, HEIGHT], quality: QUALITY, rows }, null, 2));
    await browser.close();
    server.close();
})();
