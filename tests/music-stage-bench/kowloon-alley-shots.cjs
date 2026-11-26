/*
 * 町景巷道截图：和 kowloon-shots.cjs 同一套页面，多几个开关。
 *   node tests/music-stage-bench/kowloon-alley-shots.cjs [--out=dir] [--size=1280x720] [--t=30]
 *       [--shots=alley-walk@0.3,street,...] [--quality=standard] [--rain=off|light|heavy]
 *       [--only-alley] [--light] [--bench]
 * --bench 每个机位强制画 8 帧，比较巷道模块开/关（含积水反射）的单帧耗时（软件光栅，只看比例）。
 * --only-alley 只留巷道模块自己的东西（看地面、雨、电线时用）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const OUT = path.resolve(args.out || path.join(ROOT, 'artifacts', 'kowloon-alley'));
const [W, H] = (args.size || '1280x720').split('x').map(Number);
const SHOTS = (args.shots || 'alley-walk@0.3,alley-puddle@0.5,alley-rise@0.5,street-enter@0.3,street,iso').split(',');
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await require('./serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', m => { if (/error|warn/i.test(m.type()) && !/deprecated|parallel_shader|404/.test(m.text())) console.log('[page]', m.type(), m.text().slice(0, 600)); });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/blank.html`);
    await page.evaluate(({ quality, rain, light }) => {
        localStorage.clear();
        localStorage.setItem('musicStageMode', 'kowloon');
        localStorage.setItem('musicStageConfig', JSON.stringify({ quality, modes: { kowloon: { rain } } }));
        if (light) localStorage.setItem('theme', 'light');
    }, { quality: args.quality || 'standard', rain: args.rain || 'light', light: Boolean(args.light) });
    const t = Number(args.t || 30);
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=${t}`);
    await page.waitForTimeout(400);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForFunction(() => { try { const m = __h.snap().mode; return m?.initialized || m?.fallbackMode; } catch { return false; } }, null, { timeout: 180000 });
    await page.evaluate(() => __h.pause && __h.pause());
    await page.evaluate(({ rain, only }) => {
        const alley = MusicStageKowloonAlley.debugInstance();
        if (!alley) return;
        alley.setOptions({ rain });
        if (only) {
            const { scene, root } = alley.debug();
            scene.children.forEach(c => { if (c !== root && !c.isCamera) c.visible = false; });
        }
    }, { rain: args.rain || 'light', only: Boolean(args['only-alley']) });
    for (const shot of SHOTS) {
        const [id, tt] = shot.split('@');
        await page.evaluate(({ id, tt }) => MusicStageKowloonManager.debugInstance().debugSetShot(id, tt === undefined ? 0.5 : Number(tt)), { id, tt });
        await page.waitForTimeout(600);
        const file = path.join(OUT, `${shot.replace('@', '-')}.png`);
        await page.screenshot({ path: file });
        const snap = await page.evaluate(() => __h.snap().mode);
        const alley = await page.evaluate(() => MusicStageKowloonAlley.debugInstance()?.stats());
        if (args.bench) {
            const timing = await page.evaluate(({ id, tt }) => {
                const m = MusicStageKowloonManager.debugInstance();
                const alley = MusicStageKowloonAlley.debugInstance();
                const gl = alley.debug().renderer.getContext();
                const px = new Uint8Array(4);
                // Read a pixel back after each frame so the GPU has really finished it.
                const run = () => { const t0 = performance.now(); for (let i = 0; i < 8; i++) { m.debugSetShot(id, (tt === undefined ? 0.5 : Number(tt)) + i * 1e-4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } return (performance.now() - t0) / 8; };
                run();
                const on = run();
                const { root, tierName } = alley.debug();
                root.visible = false; alley.setOptions({ reflections: false });
                const off = run();
                root.visible = true; alley.setOptions({ reflections: true }); alley.setTier(tierName);
                return { on: +on.toFixed(1), off: +off.toFixed(1) };
            }, { id, tt });
            console.log(shot, 'frame ms with alley', timing.on, 'without', timing.off);
        }
        console.log(shot, JSON.stringify({ draws: snap.drawCalls, tris: snap.triangles, camera: snap.camera, alley: alley && {
            draws: alley.alleyDrawCalls, tris: alley.alleyTriangles, rain: alley.rainStreaks, fog: +alley.fogDensity.toFixed(4), reflection: alley.reflection } }));
    }
    await browser.close();
    server.close();
})().catch(e => { console.error(e); process.exit(1); });
