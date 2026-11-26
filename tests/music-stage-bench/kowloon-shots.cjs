/*
 * 町景截图：固定几个机位各拍一张，再打印绘制调用和三角面。
 *   node tests/music-stage-bench/kowloon-shots.cjs [--out=dir] [--size=1600x900] [--t=30]
 *       [--shots=iso,street,screen,roof] [--quality=standard]
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const OUT = path.resolve(args.out || path.join(ROOT, 'artifacts', 'kowloon'));
const [W, H] = (args.size || '1600x900').split('x').map(Number);
const SHOTS = (args.shots || 'iso,street,screen,roof').split(/;|,(?=[a-z])/);  // sbx: 机位里有逗号，用分号隔开
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await require('./serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', m => { if (/error|warn/i.test(m.type()) && !/deprecated/.test(m.text())) console.log('[page]', m.type(), m.text().slice(0, 400)); });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/blank.html`);
    await page.evaluate(({ quality, extra }) => {
        localStorage.clear();
        localStorage.setItem('musicStageMode', 'kowloon');
        localStorage.setItem('musicStageConfig', JSON.stringify({ quality, modes: { kowloon: JSON.parse(extra || '{}') } }));
    }, { quality: args.quality || 'standard', extra: args.kowloon || '' });
    const t = Number(args.t || 30);
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=${t}`);
    await page.waitForTimeout(400);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForFunction(() => { try { const m = __h.snap().mode; return m?.initialized || m?.fallbackMode; } catch { return false; } }, null, { timeout: 180000 });
    await page.evaluate(() => __h.pause && __h.pause());
    for (const shot of SHOTS) {
        // 自定义机位：cam:x,y,z>x,y,z
        if (shot.startsWith('cam:')) {
            const [a, b] = shot.slice(4).split('>').map(v => v.split(',').map(Number));
            await page.evaluate(({ a, b }) => MusicStageKowloonManager.debugInstance().debugSetShot({ position: a, look: b }), { a, b });
            await page.waitForTimeout(600);
            const file = path.join(OUT, `cam-${SHOTS.indexOf(shot)}.png`);
            await page.screenshot({ path: file });
            console.log(shot, file);
            continue;
        }
        const [id, tt] = shot.split('@');
        // sandbox@秒：不固定机位，把进度拖到那一秒，看沙盒截面在那个段落的样子。
        // sbx:方位角,仰角,画面半高,x,y,z：沙盒截面里自定角度。
        if (id === 'sandbox' || id.startsWith('sbx:')) {
            await page.evaluate(({ id, tt }) => {
                const m = MusicStageKowloonManager.debugInstance();
                if (id === 'sandbox') { m.debugSetShot(null); __h.seek(Number(tt || 30)); return; }
                const [az, el, size, x = 4, y = 13, z = 40] = id.slice(4).split(',').map(Number);
                const a = az * Math.PI / 180, e = el * Math.PI / 180, d = size / Math.tan(15 * Math.PI / 180);
                m.debugSetShot({ position: [x + Math.sin(a) * Math.cos(e) * d, y + Math.sin(e) * d, z + Math.cos(a) * Math.cos(e) * d], look: [x, y, z], fov: 30, ortho: true });
            }, { id, tt });
            await page.waitForTimeout(900);
            const file = path.join(OUT, `${shot.replace(/[@:,]/g, '-')}.png`);
            await page.screenshot({ path: file });
            const snap = await page.evaluate(() => __h.snap().mode);
            console.log(shot, file, JSON.stringify({ draws: snap.drawCalls, tris: snap.triangles, programs: snap.programs, lights: snap.lights, shot: snap.shot, sandbox: snap.sandbox, fallback: snap.fallbackMode }));
            continue;
        }
        if (args.time) await page.evaluate((t) => MusicStageKowloonManager.debugInstance().debugTime(t), Number(args.time));
        await page.evaluate(({ id, tt }) => MusicStageKowloonManager.debugInstance().debugSetShot(id, tt === undefined ? 0.5 : Number(tt)), { id, tt });
        await page.waitForTimeout(600);
        const file = path.join(OUT, `${shot.replace('@', '-')}.png`);
        await page.screenshot({ path: file });
        if (args.probe) {
            // --probe=x,y;x,y（0–1 屏幕坐标）：打出命中的网格名，排查哪个模块画的东西。
            const pts = args.probe.split(';').map(v => v.split(',').map(Number));
            console.log((await page.evaluate((pts) => {
                const { scene, camera, T } = MusicStageKowloonManager.debugInstance().debugScene();
                const rc = new T.Raycaster();
                return pts.map(([x, y]) => {
                    rc.setFromCamera(new T.Vector2(x * 2 - 1, 1 - y * 2), camera);
                    const hit = rc.intersectObjects(scene.children, true)[0];
                    if (!hit) return `${x},${y}: -`;
                    let o = hit.object, chain = [];
                    while (o) { chain.push(o.name || o.type); o = o.parent; }
                    return `${x},${y}: d=${hit.distance.toFixed(1)} ${chain.join('<')} inst=${hit.instanceId ?? ''} n=${hit.face ? hit.face.normal.toArray().map(v => v.toFixed(2)) : ''} p=${hit.point.toArray().map(v => v.toFixed(2))} ${hit.face && !hit.instanceId && hit.object.geometry.attributes.aFace ? ['aFace', 'aInfo'].map(k => { const a = hit.object.geometry.attributes[k]; return [hit.face.a, hit.face.b, hit.face.c].map(i => a ? Array.from({ length: a.itemSize }, (_, j) => a.array[i * a.itemSize + j].toFixed(2)).join('/') : '').join(' '); }).join(' | ') : ''}`;
                });
            }, pts)).join("\n"));
        }
        const snap = await page.evaluate(() => __h.snap().mode);
        console.log(shot, JSON.stringify({ draws: snap.drawCalls, tris: snap.triangles, programs: snap.programs, lights: snap.lights, fallback: snap.fallbackMode }));
    }
    console.log(JSON.stringify(await page.evaluate(() => __h.snap().mode)).slice(0, 800));
    await browser.close();
    server.close();
})().catch(e => { console.error(e); process.exit(1); });
