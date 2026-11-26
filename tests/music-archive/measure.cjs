/*
 * 档案页离线测量（不用 ?freeze3d，数的是场景真正画了几帧）：
 *   首次进入：曲库晚到、播放器再恢复上次那首时，相机是不是直接落在选中卡上（不从远处飞过来）；
 *   高分屏上的像素比上限；记住的位置重启后是否第一帧就落在那张卡上。
 * 帧率上限（操作时 / 静止 2 秒后 12 帧 / 被播放页盖住 0 帧）在 tests/music-archive-view.test.cjs 里用模拟时钟量：
 * 无头浏览器没有输入时计时器和 requestAnimationFrame 一秒只醒两三次，在这里量出来的帧数不可信。
 * node tests/music-archive/measure.cjs [--dpr=2]
 */
const path = require('node:path');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(__dirname, '..', '..');
(async () => {
  const server = await require('../music-stage-bench/serve.cjs')(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/tests/music-archive/harness.html`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const out = {};
  const dbg = (page) => page.evaluate(() => { const d = window.app.archiveView.debug(); return { sel: d.selected, lane: d.lane, row: d.row, scene: d.scene }; });

  // 1. 首次进入：曲库晚到 + 播放器恢复第 137 首
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: Number(args.dpr || 1) });
    await page.goto(base + '?n=300&late=137');
    await page.waitForFunction(() => window.__ready);
    const samples = [];
    for (let t = 0; t < 14; t++) {
      await page.waitForTimeout(100);
      const d = await dbg(page);
      samples.push({ t: (t + 1) * 100, sel: d.sel, cam: d.scene.cam, target: d.scene.target });
    }
    const after = samples.filter((s) => s.sel === 137);
    out.firstEntry = {
      landed: after.length > 0,
      offTarget: after.filter((s) => Math.abs(s.cam.lane - s.target.lane) > 0.001 || Math.abs(s.cam.row - s.target.row) > 0.001).length,
      samples: samples.filter((_, i) => i % 3 === 0)
    };
    out.dpr = (await dbg(page)).scene.dpr;
    await page.close();
  }
  // 2b. 高分屏：像素比 2 的屏幕上只按 1.5 画
  {
    const page = await browser.newPage({ viewport: { width: 360, height: 203 }, deviceScaleFactor: 2 });
    await page.goto(base + '?n=60');
    await page.waitForFunction(() => window.__ready);
    out.dprOnRetina = (await dbg(page)).scene.dpr;
    await page.close();
  }
  // 4. 记住的位置：重启后第一帧就在那一列那张卡上
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const place = JSON.stringify({ mode: 'archive', stage: false, col: 'playlist:c', row: 4, path: null });
    await page.goto(base + '?n=300&late=10&place=' + encodeURIComponent(place));
    await page.waitForFunction(() => window.__ready);
    await page.waitForTimeout(1500);
    const d = await page.evaluate(() => window.app.archiveView.debug());
    out.restore = { col: d.columns[d.lane % d.columns.length].id, row: d.row, cam: d.scene.cam, target: d.scene.target };
    await page.screenshot({ path: path.join(args.out || require('node:os').tmpdir(), 'restore-first.png') });
    await page.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  server.close();
})();
