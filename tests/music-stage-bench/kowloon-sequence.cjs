/*
 * 町景镜头表：打印导演按段落排出的镜头，再在每个镜头的 1/4 和 3/4 处各拍一张，
 * 拼成一张联系表，方便看整首歌的调度。
 *   node tests/music-stage-bench/kowloon-sequence.cjs [--out=dir] [--size=640x360] [--max=24]
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v]; }));
const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const OUT = path.resolve(args.out || path.join(ROOT, 'artifacts', 'kowloon-sequence'));
const [W, H] = (args.size || '640x360').split('x').map(Number);
(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const server = await require('./serve.cjs')(ROOT);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/blank.html`);
    // --mode=sandbox 看沙盒截面在各段落的样子；默认看分镜运镜。
    await page.evaluate((cameraMode) => {
        localStorage.clear(); localStorage.setItem('musicStageMode', 'kowloon');
        localStorage.setItem('musicStageConfig', JSON.stringify({ modes: { kowloon: { cameraMode } } }));
    }, args.mode || 'auto');
    await page.goto(`${origin}/Musicmodules/harness.html?lyrics=song&duration=215&t=1`);
    await page.waitForTimeout(400);
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForFunction(() => { try { return __h.snap().mode?.initialized; } catch { return false; } }, null, { timeout: 180000 });
    await page.evaluate(() => __h.pause && __h.pause());
    const plan = await page.evaluate(() => MusicStageKowloonManager.debugInstance().debugPlan());
    console.log(plan.phases.map(p => `${p.start.toFixed(1)}–${p.end.toFixed(1)} ${p.phase}`).join('\n'));
    console.log(plan.shots.map(s => `#${s.index} ${s.start.toFixed(1)}–${s.end.toFixed(1)} ${s.phase} ${s.id}`).join('\n'));
    const shots = plan.shots.slice(0, Number(args.max) || 24);
    const files = [];
    for (const shot of shots) {
        for (const k of [0.25, 0.75]) {
            const t = shot.start + (shot.end - shot.start) * k;
            await page.evaluate((t) => { __h.seek(t); MusicStageKowloonManager.debugInstance().debugSetShot(null); }, t);
            await page.waitForTimeout(350);
            const file = path.join(OUT, `${String(shot.index).padStart(2, '0')}-${shot.phase}-${shot.id}-${k}.png`);
            await page.screenshot({ path: file });
            files.push({ file: path.basename(file), label: `#${shot.index} ${shot.phase} · ${shot.id} · ${t.toFixed(0)}s` });
        }
    }
    // 联系表：一行一个镜头（开头、结尾两帧）。
    const sheet = await browser.newPage({ viewport: { width: W * 2 + 24, height: 100 } });
    await sheet.setContent(`<body style="margin:8px;background:#111;color:#ddd;font:12px sans-serif">${
        shots.map((s, i) => `<div style="margin-bottom:6px">${files[i * 2].label}<br>${[0, 1].map(j =>
            `<img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, files[i * 2 + j].file)).toString('base64')}" width="${W}" style="margin-right:4px">`).join('')}</div>`).join('')}</body>`);
    await sheet.screenshot({ path: path.join(OUT, 'sheet.png'), fullPage: true });
    await browser.close();
    server.close();
})().catch(e => { console.error(e); process.exit(1); });
