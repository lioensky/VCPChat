/*
 * Offline cost profile of the 3D lyric stages. Repeatable on any machine,
 * including one without a GPU: it does not time frames on the display, it
 * counts what one frame asks of the GPU and, with --timing, how long each
 * draw takes on the software rasteriser (a proxy for shader and fill cost).
 *
 *   node tests/music-stage-bench/profile.cjs [--only=diorama,tunnel] [--size=1280x720]
 *       [--dpr=1] [--timing] [--top=25] [--out=<file.json>] [--shots=<dir>]
 *
 * Per scenario it reports draw calls, triangles, instanced draws, render
 * target switches, shader programs, texture and render-target memory,
 * JavaScript time per frame and, with --timing, per-pass and per-object
 * rasteriser time. The fake player is harness.js; nothing touches app data.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const [WIDTH, HEIGHT] = /^\d+x\d+$/.test(args.size || '') ? args.size.split('x').map(Number) : [1280, 720];
const DPR = Number(args.dpr) || 1;
const TOP = Number(args.top) || 25;

const serve = () => require('./serve.cjs')(ROOT);

const tunnelBare = { showPlanets: false, showRings: false, showShips: false, showStations: false };
const SCENARIOS = [
    { name: 'diorama verse', mode: 'diorama', t: 30 },
    { name: 'diorama chorus', mode: 'diorama', t: 56 },
    { name: 'diorama interlude', mode: 'diorama', t: 120 },
    { name: 'diorama chorus, energy-saving', mode: 'diorama', t: 56, config: { quality: 'energy-saving' } },
    { name: 'diorama chorus, ultimate', mode: 'diorama', t: 56, config: { quality: 'ultimate' } },
    { name: 'tunnel planet', mode: 'tunnel', t: 35 },
    { name: 'tunnel rings', mode: 'tunnel', t: 46 },
    { name: 'tunnel rings, energy-saving', mode: 'tunnel', t: 46, config: { quality: 'energy-saving' } },
    { name: 'tunnel rings, ultimate', mode: 'tunnel', t: 46, config: { quality: 'ultimate' } },
    { name: 'tunnel rings, no bodies', mode: 'tunnel', t: 46, config: { modes: { tunnel: tunnelBare } } }
];

// Runs in the page before any script: counts what reaches WebGL.
const INSTRUMENT = () => {
    const C = WebGL2RenderingContext.prototype;
    const s = window.__gl = {
        on: false, draws: 0, instanced: 0, instances: 0, vertices: 0, fbBinds: 0, useProgram: 0,
        texBytes: new Map(), rbBytes: new Map(), programs: new Set(), timing: false, finishMs: 0
    };
    const BPP = { 0x1908: 4, 0x1907: 3, 0x1909: 1, 0x190A: 2, 0x1906: 1 };
    const bytesOf = (internal, type) => {
        // RGBA16F = 0x881A, RGBA32F = 0x8814, RGBA8 = 0x8058, DEPTH24_STENCIL8 = 0x88F0, DEPTH_COMPONENT24 = 0x81A6
        const table = { 0x881A: 8, 0x8814: 16, 0x8058: 4, 0x8C43: 4, 0x88F0: 4, 0x81A6: 4, 0x8CAC: 4, 0x8229: 1, 0x822B: 2, 0x822F: 4, 0x8230: 8, 0x881B: 6, 0x8051: 3, 0x8C41: 3 };
        if (table[internal]) return table[internal];
        const base = BPP[internal] || 4;
        return type === 0x140B || type === 0x8D61 ? base * 2 : type === 0x1406 ? base * 4 : base;
    };
    const bound = new WeakMap();
    let active2D = null;
    const wrap = (name, fn) => { const orig = C[name]; C[name] = function (...a) { return fn.call(this, orig, a); }; };
    wrap('bindTexture', function (orig, a) { if (a[0] === this.TEXTURE_2D) active2D = a[1]; return orig.apply(this, a); });
    const level0 = (tex, bytes) => { if (tex) s.texBytes.set(tex, bytes); };
    wrap('texImage2D', function (orig, a) {
        if (a[0] === this.TEXTURE_2D && a[1] === 0) {
            let w, h;
            if (a.length >= 8) { w = a[3]; h = a[4]; level0(active2D, w * h * bytesOf(a[2], a[7])); }
            else { const src = a[5]; w = src.naturalWidth || src.videoWidth || src.width; h = src.naturalHeight || src.videoHeight || src.height; level0(active2D, w * h * bytesOf(a[2], a[4]) * 1.33); }
        }
        return orig.apply(this, a);
    });
    wrap('texStorage2D', function (orig, a) { level0(active2D, a[3] * a[4] * bytesOf(a[2]) * (a[1] > 1 ? 1.33 : 1)); return orig.apply(this, a); });
    let activeRB = null;
    wrap('bindRenderbuffer', function (orig, a) { activeRB = a[1]; return orig.apply(this, a); });
    wrap('renderbufferStorage', function (orig, a) { if (activeRB) s.rbBytes.set(activeRB, a[2] * a[3] * bytesOf(a[1])); return orig.apply(this, a); });
    wrap('renderbufferStorageMultisample', function (orig, a) { if (activeRB) s.rbBytes.set(activeRB, a[3] * a[4] * bytesOf(a[2]) * Math.max(1, a[1])); return orig.apply(this, a); });
    wrap('bindFramebuffer', function (orig, a) { if (s.on) s.fbBinds++; return orig.apply(this, a); });
    wrap('useProgram', function (orig, a) { if (s.on) { s.useProgram++; s.programs.add(a[0]); } return orig.apply(this, a); });
    const count = (verts, inst) => { if (!s.on) return; s.draws++; s.vertices += verts * (inst || 1); if (inst) { s.instanced++; s.instances += inst; } };
    wrap('drawArrays', function (orig, a) { count(a[2]); return orig.apply(this, a); });
    wrap('drawElements', function (orig, a) { count(a[1]); return orig.apply(this, a); });
    wrap('drawArraysInstanced', function (orig, a) { count(a[2], a[3]); return orig.apply(this, a); });
    wrap('drawElementsInstanced', function (orig, a) { count(a[1], a[4]); return orig.apply(this, a); });
    void bound;
};

const sample = async (page, scenario) => {
    await page.goto(`${ORIGIN}/blank.html`);
    await page.evaluate(({ mode, config }) => {
        localStorage.clear();
        localStorage.setItem('musicStageMode', mode);
        if (config) localStorage.setItem('musicStageConfig', JSON.stringify(config));
    }, scenario);
    await page.goto(`${ORIGIN}/Musicmodules/harness.html?lyrics=song&duration=215&t=${scenario.t}`);
    await page.waitForTimeout(400);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForFunction(() => { try { return __h.snap().mode?.initialized; } catch { return false; } }, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    await page.evaluate((t) => { __h.seek(t); }, scenario.t);
    // Let streamed scenery settle, then catch the renderer on its way past.
    await page.waitForTimeout(2500);
    let cdp = null;
    if (args.cpu) { cdp = await page.context().newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    const result = await page.evaluate(async ({ timing, top, cpu }) => {
        const T = window.THREE || await import('/vendor/three.module.js');
        const gl = window.__gl;
        const renderers = new Set();
        const original = T.Scene.prototype.onBeforeRender;
        T.Scene.prototype.onBeforeRender = function (renderer, ...rest) { renderers.add(renderer); return original.call(this, renderer, ...rest); };
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
        await nextFrame(); await nextFrame();
        T.Scene.prototype.onBeforeRender = original;
        const renderer = [...renderers][0];
        if (!renderer) return { error: 'no renderer seen' };
        const ctx = renderer.getContext();
        const label = (object) => {
            const names = [];
            for (let o = object; o; o = o.parent) if (o.name) names.push(o.name);
            const g = object.geometry;
            const dims = g && g.parameters ? Object.values(g.parameters).filter((v) => typeof v === 'number').slice(0, 3).map((v) => +v.toFixed(1)).join('x') : '';
            const own = object.name ? '' : `${object.type}<${g ? g.type.replace('Geometry', '') : ''}${dims ? ' ' + dims : ''}>`;
            return [names.reverse().join('/'), own].filter(Boolean).join(':') || object.type;
        };
        // Per-object records for one frame.
        const records = new Map();
        const passes = [];
        let pass = null;
        const setRT = renderer.setRenderTarget;
        renderer.setRenderTarget = function (target, ...rest) {
            pass = { target: target ? `${target.width}x${target.height}${target.samples ? ` msaa${target.samples}` : ''}${target.isWebGLCubeRenderTarget ? ' cube' : ''}` : 'canvas', draws: 0, ms: 0, triangles: 0 };
            passes.push(pass);
            return setRT.call(this, target, ...rest);
        };
        const direct = renderer.renderBufferDirect;
        renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
            if (!pass) { pass = { target: 'canvas', draws: 0, ms: 0, triangles: 0 }; passes.push(pass); }
            let start = 0;
            if (timing) { ctx.finish(); start = performance.now(); }
            const before = gl.vertices;
            const result = direct.call(this, camera, scene, geometry, material, object, group);
            let ms = 0;
            if (timing) { ctx.finish(); ms = performance.now() - start; }
            const verts = gl.vertices - before;
            const key = `${pass.target === 'canvas' || /msaa/.test(pass.target) ? 'main' : 'aux ' + pass.target} | ${label(object)} [${material.name || material.type}${material.transparent ? ',blend' : ''}${material.side === 2 ? ',2side' : ''}]`;
            const r = records.get(key) || { key, draws: 0, verts: 0, ms: 0, instanced: 0 };
            r.draws++; r.verts += verts; r.ms += ms; if (object.isInstancedMesh) r.instanced++;
            records.set(key, r);
            pass.draws++; pass.ms += ms; pass.triangles += verts / 3;
            return result;
        };
        // Count three frames with the counters on and keep the middle one's split.
        // A frame the stage skips (frame cap, paused) draws nothing: count drawn ones only.
        const frames = [];
        for (let i = 0, tries = 0; frames.length < 3 && tries < 20; tries++) {
            Object.assign(gl, { on: true, draws: 0, instanced: 0, instances: 0, vertices: 0, fbBinds: 0, useProgram: 0 });
            gl.programs = new Set();
            records.clear(); passes.length = 0; pass = null;
            const started = performance.now();
            await nextFrame();
            ctx.finish();
            const wall = performance.now() - started;
            gl.on = false;
            if (!gl.draws) continue;
            i++;
            frames.push({
                draws: gl.draws, instancedDraws: gl.instanced, triangles: Math.round(gl.vertices / 3),
                fbBinds: gl.fbBinds, programSwitches: gl.useProgram, programsUsed: gl.programs.size, wallMs: wall,
                passes: passes.map((p) => ({ ...p, ms: +p.ms.toFixed(2), triangles: Math.round(p.triangles) })),
                objects: [...records.values()]
            });
        }
        renderer.renderBufferDirect = direct;
        renderer.setRenderTarget = setRT;
        // JavaScript time of the stage per frame (harness measures updateFrame).
        __h.frameTimes.length = 0;
        await new Promise((r) => setTimeout(r, cpu ? 6000 : 2000));
        const js = __h.frameTimes.map(([, c]) => c).sort((a, b) => a - b);
        const q = (p) => js.length ? js[Math.min(js.length - 1, Math.floor(js.length * p))] : 0;
        const frame = frames[1];
        const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
        const scene = [...renderers][0];
        void scene;
        return {
            ...frame,
            objects: undefined,
            topByTime: timing ? frame.objects.sort((a, b) => b.ms - a.ms).slice(0, top).map((o) => ({ ...o, ms: +o.ms.toFixed(2) })) : undefined,
            topByDraws: frame.objects.sort((a, b) => b.draws - a.draws).slice(0, top),
            topByTriangles: [...frame.objects].sort((a, b) => b.verts - a.verts).slice(0, 10).map((o) => ({ key: o.key, triangles: Math.round(o.verts / 3) })),
            textureMB: +(sum(gl.texBytes) / 1048576).toFixed(1),
            renderbufferMB: +(sum(gl.rbBytes) / 1048576).toFixed(1),
            programs: renderer.info.programs?.length,
            geometries: renderer.info.memory.geometries,
            textures: renderer.info.memory.textures,
            drawingBuffer: [ctx.drawingBufferWidth, ctx.drawingBufferHeight],
            jsMs: { p50: q(0.5), p95: q(0.95), max: js.at(-1) || 0, frames: js.length },
            errors: __h.errors.slice(0, 5)
        };
    }, { timing: Boolean(args.timing), top: TOP, cpu: Boolean(args.cpu) });
    if (cdp) {
        // Self time by function, the stage's own scripts first.
        const { profile } = await cdp.send('Profiler.stop');
        const self = new Map();
        const byId = new Map(profile.nodes.map((n) => [n.id, n]));
        const dt = profile.timeDeltas;
        profile.samples.forEach((id, i) => {
            const f = byId.get(id).callFrame;
            const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/(?=[^/]+$)/, '')}:${f.lineNumber + 1}`;
            self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
        });
        const total = [...self.values()].reduce((a, b) => a + b, 0);
        result.cpuSelfMs = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)
            .map(([k, v]) => `${v.toFixed(0).padStart(6)}ms ${(100 * v / total).toFixed(1).padStart(5)}% ${k}`);
        await cdp.detach();
    }
    return result;
};

let ORIGIN = '';
(async () => {
    const server = await serve();
    ORIGIN = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
    await context.addInitScript(INSTRUMENT);
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    const only = args.only ? args.only.split(',') : null;
    const results = [];
    for (const scenario of SCENARIOS) {
        if (only && !only.some((key) => scenario.name.includes(key))) continue;
        let result;
        try { result = { scenario: scenario.name, ...(await sample(page, scenario)) }; }
        catch (error) { result = { scenario: scenario.name, failed: String(error && error.stack || error) }; }
        if (args.shots) {
            fs.mkdirSync(path.resolve(args.shots), { recursive: true });
            await page.screenshot({ path: path.join(path.resolve(args.shots), `${scenario.name.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
        }
        results.push(result);
        const { topByTime, topByDraws, topByTriangles, passes, ...head } = result;
        console.log(JSON.stringify(head));
    }
    if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify({ size: [WIDTH, HEIGHT], dpr: DPR, timing: Boolean(args.timing), results }, null, 2));
    await browser.close();
    server.close();
})();
