/*
 * Does the stage give back what it takes? Runs a mode through the things a
 * listener does for an evening (plays, seeks, changes track, reloads lyrics,
 * leaves the stage and comes back, changes mode) and after each round of the
 * same action samples, with the garbage collected first:
 *
 *   heap     JavaScript heap in use
 *   nodes    DOM nodes in the document
 *   gl       live WebGL objects (created minus deleted), by kind
 *   contexts WebGL contexts still alive
 *   rss      memory of the whole browser, GPU process included (software
 *            rendering keeps its textures and render targets there)
 *   three    geometries and textures three.js still tracks
 *
 * A number that keeps climbing round after round is a leak; one that settles
 * is a cache. Repeatable without a GPU.
 *
 *   node tests/music-stage-bench/leak.cjs [--root=<repo>] [--mode=tunnel] [--only=play,tracks]
 *       [--rounds=8] [--size=640x360] [--out=<file.json>]
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const MODE = args.mode || 'tunnel';
const ROUNDS = Number(args.rounds) || 8;
const [WIDTH, HEIGHT] = /^\d+x\d+$/.test(args.size || '') ? args.size.split('x').map(Number) : [640, 360];

// Runs in the page before any script: keeps count of what WebGL holds.
const INSTRUMENT = () => {
    // Counted per context: a context that is thrown away takes everything it held with it.
    const KINDS = [
        ['texture', 'createTexture', 'deleteTexture'], ['buffer', 'createBuffer', 'deleteBuffer'],
        ['framebuffer', 'createFramebuffer', 'deleteFramebuffer'], ['renderbuffer', 'createRenderbuffer', 'deleteRenderbuffer'],
        ['vertexArray', 'createVertexArray', 'deleteVertexArray'], ['program', 'createProgram', 'deleteProgram']
    ];
    const counts = new WeakMap();
    const contexts = [];
    const of = (context) => {
        if (!counts.has(context)) { counts.set(context, Object.fromEntries(KINDS.map(([kind]) => [kind, 0]))); contexts.push(new WeakRef(context)); }
        return counts.get(context);
    };
    const C = WebGL2RenderingContext.prototype;
    for (const [kind, make, drop] of KINDS) {
        const create = C[make];
        const remove = C[drop];
        const owned = new WeakSet();
        C[make] = function (...a) { const object = create.apply(this, a); if (object) { of(this)[kind]++; owned.add(object); } return object; };
        C[drop] = function (object) { if (object && owned.has(object)) { of(this)[kind]--; owned.delete(object); } return remove.call(this, object); };
    }
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const context = getContext.call(this, type, ...rest);
        if (context && /webgl/.test(type)) of(context);
        return context;
    };
    window.__live = () => {
        const total = Object.fromEntries(KINDS.map(([kind]) => [kind, 0]));
        total.contexts = 0;
        for (const ref of contexts) {
            const context = ref.deref();
            if (!context || context.isContextLost()) continue;
            total.contexts++;
            for (const [kind] of KINDS) total[kind] += counts.get(context)[kind];
        }
        return total;
    };
    // Timers and frames that are still scheduled.
    const timers = window.__timers = { interval: new Set(), listeners: 0 };
    const setI = window.setInterval; const clearI = window.clearInterval;
    window.setInterval = (...a) => { const id = setI(...a); timers.interval.add(id); return id; };
    window.clearInterval = (id) => { timers.interval.delete(id); return clearI(id); };
    const add = EventTarget.prototype.addEventListener; const remove = EventTarget.prototype.removeEventListener;
    const registry = new WeakMap();
    const keyOf = (type, options) => `${type}:${typeof options === 'boolean' ? options : Boolean(options && options.capture)}`;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (listener && (this === window || this === document || this === document.body)) {
            const map = registry.get(this) || new Map(); registry.set(this, map);
            const set = map.get(keyOf(type, options)) || new Set(); map.set(keyOf(type, options), set);
            if (!set.has(listener)) { set.add(listener); timers.listeners++; }
        }
        return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
        const set = registry.get(this)?.get(keyOf(type, options));
        if (set && set.delete(listener)) timers.listeners--;
        return remove.call(this, type, listener, options);
    };
};

const sampleIn = () => {
    if (window.gc) { window.gc(); window.gc(); }
    let three = {};
    try { const m = __h.snap().mode || {}; three = { geometries: m.geometries, textures: m.textures, programs: m.programs }; } catch { /* stage closed */ }
    const live = window.__live();
    return {
        heapMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(2),
        nodes: document.getElementsByTagName('*').length,
        canvases: document.getElementsByTagName('canvas').length,
        listeners: window.__timers.listeners, intervals: window.__timers.interval.size,
        ...live, ...three, errors: __h.errors.length
    };
};

// Resident memory of every process under this one: the browser, its renderers and its GPU process.
const rssMB = () => {
    const rows = require('node:child_process').execSync('ps -eo pid=,ppid=,rss=').toString().trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number));
    const family = new Set([process.pid]);
    for (let grew = true; grew;) { grew = false; for (const [pid, parent] of rows) if (family.has(parent) && !family.has(pid)) { family.add(pid); grew = true; } }
    return +(rows.filter(([pid]) => family.has(pid) && pid !== process.pid).reduce((sum, row) => sum + row[2], 0) / 1024).toFixed(0);
};
const wait = (page, ms) => page.waitForTimeout(ms);
const ACTIONS = {
    // Keeps playing, further into the song each round, and round again from the top.
    play: async (page, round) => { await page.evaluate((t) => __h.seek(t), (20 + round * 22) % 200); await wait(page, 6000); },
    // The listener drags the progress bar about.
    seeks: async (page) => { for (const t of [30, 150, 56, 200, 12, 120]) { await page.evaluate((s) => __h.seek(s), t); await wait(page, 700); } },
    tracks: async (page, round) => { await page.evaluate((i) => __h.track(i), round % 2); await wait(page, 2500); },
    // The player hands over a fresh lyric array with the same words, as a reload does.
    lyrics: async (page) => { for (let i = 0; i < 6; i++) { await page.evaluate(() => __h.setLyrics('song')); await wait(page, 500); } },
    // The same, as often as the player polls its engine.
    'lyrics every poll': async (page) => {
        await page.evaluate(() => { window.__churn = setInterval(() => __h.setLyrics('song'), 250); });
        await wait(page, 5000);
        await page.evaluate(() => clearInterval(window.__churn));
    },
    pause: async (page) => { await page.evaluate(() => __h.pause()); await wait(page, 1200); await page.evaluate(() => __h.play()); await wait(page, 1200); },
    'leave and return': async (page) => {
        await page.evaluate(() => __h.app.stageHost.exit?.()); await wait(page, 900);
        await page.evaluate(() => __h.app.stageHost.enter()); await wait(page, 2600);
    },
    'change mode': async (page, round, mode) => {
        await page.evaluate((m) => __h.app.stageHost.setMode?.(m), round % 2 ? mode : 'luminous'); await wait(page, 2500);
    },
    resize: async (page, round) => { await page.setViewportSize({ width: WIDTH + (round % 2) * 160, height: HEIGHT + (round % 2) * 90 }); await wait(page, 1500); }
};

const slope = (values) => {
    // Per round, over the second half: the first rounds fill caches.
    const tail = values.slice(Math.floor(values.length / 2));
    return tail.length > 1 ? (tail.at(-1) - tail[0]) / (tail.length - 1) : 0;
};

(async () => {
    const server = await require('./serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.addInitScript(INSTRUMENT);
    const only = args.only ? args.only.split(',') : null;
    const report = [];
    for (const [name, action] of Object.entries(ACTIONS)) {
        if (only && !only.includes(name)) continue;
        const page = await context.newPage();
        page.setDefaultTimeout(180000);
        await page.goto(`${origin}/blank.html`);
        await page.evaluate((mode) => { localStorage.clear(); localStorage.setItem('musicStageMode', mode); }, MODE);
        await page.goto(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=20`);
        await wait(page, 400);
        await page.evaluate(() => __h.app.stageHost.enter());
        await page.waitForFunction(() => { try { return __h.snap().mode?.initialized; } catch { return false; } }, null, { polling: 500 });
        await wait(page, 3000);
        const sample = async () => ({ ...(await page.evaluate(sampleIn)), rssMB: rssMB() });
        const samples = [await sample()];
        for (let round = 0; round < ROUNDS; round++) {
            await action(page, round, MODE);
            samples.push(await sample());
        }
        const keys = ['heapMB', 'rssMB', 'nodes', 'canvases', 'listeners', 'intervals', 'texture', 'buffer', 'framebuffer', 'renderbuffer', 'vertexArray', 'program', 'contexts', 'geometries', 'textures'];
        const growth = Object.fromEntries(keys.map((key) => [key, +slope(samples.map((s) => s[key] ?? 0)).toFixed(2)]));
        const climbing = Object.entries(growth).filter(([key, value]) => value > (key === 'rssMB' ? 4 : key === 'heapMB' ? 0.25 : 0.4)).map(([key, value]) => `${key} +${value}/round`);
        report.push({ action: name, climbing, first: samples[0], last: samples.at(-1), heap: samples.map((s) => s.heapMB), rss: samples.map((s) => s.rssMB), growth });
        console.log(`${name.padEnd(18)} heap ${samples.map((s) => s.heapMB.toFixed(0)).join(' ')} MB  rss ${samples.map((s) => s.rssMB).join(' ')} MB  ${climbing.length ? 'CLIMBING: ' + climbing.join(', ') : 'settles'}`);
        await page.close();
    }
    if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify({ mode: MODE, rounds: ROUNDS, report }, null, 2));
    await browser.close();
    server.close();
})();
