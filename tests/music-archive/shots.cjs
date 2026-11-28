/*
 * 档案页离线截图：node tests/music-archive/shots.cjs [--out=dir] [--size=1600x900]
 * 用假播放器（harness.html），不碰真实数据。
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(args.out || path.join(require('node:os').tmpdir(), 'music-archive-shots'));
const [W, H] = (args.size || '1600x900').split('x').map(Number);
const CASES = (args.cases || 'dark,light,dark-dock,light-narrow,light-narrow-list,dark-search,light-pinyin,dark-nolist,light-empty').split(',');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await require('../music-stage-bench/serve.cjs')(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/tests/music-archive/harness.html`;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const name of CASES) {
    const narrow = name.includes('narrow');
    // --size=760x600：指定窗口大小（不给时窄窗口是 900×700）
    const size = args.size ? args.size.split('x').map(Number) : null;
    const page = await browser.newPage({ viewport: { width: size ? size[0] : narrow ? 900 : W, height: size ? size[1] : narrow ? 700 : H }, deviceScaleFactor: Number(args.dpr || 1) });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    const qs = new URLSearchParams();
    if (name.includes('light')) qs.set('light', '');
    if (name.includes('dock')) qs.set('dock', '118');
    if (name.includes('empty')) qs.set('empty', '');
    if (name.includes('playing')) qs.set('playing', '');
    if (name.includes('nolyr')) qs.set('nolyrics', ''); else if (name.includes('lyrics')) qs.set('lyrics', '');
    if (name.includes('plzero')) qs.set('emptypl', '');
    if (name.includes('long')) qs.set('long', '');
    if (args.n) qs.set('n', args.n);
    await page.goto(base + '?' + qs.toString(), { timeout: 120000 });
    await page.waitForFunction(() => window.__ready);
    await page.waitForTimeout(400);
    if (name.includes('nolist') || name.includes('narrow-list')) await page.evaluate(() => document.querySelector('[data-act="list"]').click());
    if (name.includes('kind-')) { const k = name.split('kind-')[1].split('-')[0]; await page.evaluate((k) => document.querySelector('[data-kind="' + k + '"]').click(), k); await page.waitForTimeout(1500); }
    if (name.includes('sortmenu')) { await page.evaluate(() => document.querySelector('[data-l="sortBtn"]').click()); await page.waitForTimeout(2600); await page.screenshot({ path: path.join(OUT, name + '.png') }); await page.close(); continue; }
    if (name.includes('sortartist')) { await page.evaluate(() => document.querySelector('[data-l="sortBtn"]').click()); await page.evaluate(() => document.querySelector('[data-sort="artist"]').click()); }
    if (name.includes('cover')) {
      // 假封面（离线截图拿不到本地文件）：一张渐变加几何图形的画
      await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = c.height = 480;
        const g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 480, 480); grad.addColorStop(0, '#7fb3c8'); grad.addColorStop(1, '#e9c9a8');
        g.fillStyle = grad; g.fillRect(0, 0, 480, 480);
        g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(320, 170, 70, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#2f4a55'; g.fillRect(0, 330, 480, 150);
        g.fillStyle = '#f4efe8'; g.font = '700 54px sans-serif'; g.fillText('LOW TIDE', 36, 420);
        const el = document.querySelector('.archive-cover');
        el.style.backgroundImage = 'url(' + c.toDataURL() + ')'; el.classList.add('on');
      });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      await page.close();
      continue;
    }
    if (name.includes('scan')) await page.evaluate(() => { window.__scan(0, 1280); window.__scan(437, 1280); });
    if (name.includes('nomatch')) { await page.keyboard.press('/'); await page.keyboard.type('zzqx'); await page.waitForTimeout(300); }
    else if (name.includes('plzero')) {
      // 目录切到歌单分类，阵列走到那个空歌单
      await page.evaluate(() => { document.querySelector('[data-kind="playlist"]').click(); const v = window.app.archiveView; const k = v.debug().columns.findIndex((c) => c.id === 'playlist:e'); for (let i = 0; i < k; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    }
    else if (name.includes('multi')) {
      // 多选三行，在其中一行上右键打开批量菜单
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.archive-list-row')];
        rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        rows[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        rows[5].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        const box = rows[3].getBoundingClientRect();
        rows[3].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 150, clientY: box.top + 20 }));
      });
    }
    else if (name.includes('plshelf')) {
      // 歌单分类 + 拖起一行（歌单架出现），第一个歌单标题上的按钮显出来
      await page.evaluate(() => {
        document.querySelector('[data-kind="playlist"]').click();
        const row = document.querySelector('.archive-list-row');
        const b = row.getBoundingClientRect();
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: b.left + 60, clientY: b.top + 10 }));
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: b.left + 160, clientY: b.top + 14 }));
        const acts = document.querySelector('.archive-list-group .acts'); if (acts) acts.style.opacity = 1;
      });
    }
    else if (name.includes('scan') || name.includes('nolyr')) { /* 停在原处 */ }
    else if (name.includes('search')) { await page.keyboard.press('/'); await page.keyboard.type('站台'); await page.waitForTimeout(300); }
    else if (name.includes('pinyin')) { await page.waitForFunction(() => window.pinyinPro); await page.keyboard.press('/'); await page.keyboard.type('hh'); await page.waitForTimeout(300); await page.keyboard.press('ArrowDown'); }
    else if (!name.includes('empty')) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); }
    if (name.includes('daily')) {
      // 假的每日推荐：曲库里隔一首挑一首，共 30 首；跳到最前面那一列
      await page.evaluate(() => { const lib = window.app.playlist; window.app.dailyMix = () => lib.filter((_, i) => i % 2).slice(0, 30); window.app.archiveView.refresh(); });
      await page.waitForTimeout(300);
      for (let i = 0; i < 30 && await page.evaluate(() => window.app.archiveView.debug().lane) !== 0; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(60); }
      await page.waitForTimeout(900);
    }
    if (name.includes('resume')) {
      // 假的听歌记录：上次第 8 首听到 2:13
      await page.evaluate(() => { const t = window.app.playlist[8]; window.app.musicStats = { resume: () => ({ track: t, position: 133, at: Date.now() }) }; document.dispatchEvent(new CustomEvent('music-stats-change')); });
      await page.waitForTimeout(300);
    }
    if (name.includes('detail')) {
      if (name.includes('like')) await page.evaluate(() => { window.app.isLiked = () => true; window.app.toggleLike = () => {}; });
      await page.evaluate(() => window.app.archiveView.openDetail());
      if (name.includes('art')) {
        // 假封面（离线截图拿不到本地文件），直接交给场景
        await page.evaluate(() => {
          const c = document.createElement('canvas'); c.width = c.height = 512;
          const g = c.getContext('2d');
          const grad = g.createLinearGradient(0, 0, 512, 512); grad.addColorStop(0, '#7fb3c8'); grad.addColorStop(1, '#e9c9a8');
          g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
          g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.arc(340, 180, 76, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#2f4a55'; g.fillRect(0, 350, 512, 162);
          g.fillStyle = '#f4efe8'; g.font = '700 58px sans-serif'; g.fillText('LOW TIDE', 36, 448);
          window.app.archiveView.scene.setCover('fake', c);
        });
      }
      await page.waitForFunction(() => { const d = window.app.archiveView.debug().scene; return d && d.detail >= 0.999 && d.clarity >= 1; }, null, { timeout: 60000 }).catch(() => {});
    }
    await page.waitForTimeout(2600);
    await page.screenshot({ path: path.join(OUT, name + (args.size ? '-' + args.size : '') + '.png') });
    const dbg = await page.evaluate(() => window.app.archiveView.debug());
    console.log(name, JSON.stringify({ lane: dbg.lane, row: dbg.row, sel: dbg.selected, scene: dbg.scene, cols: dbg.columns.length }), errors.length ? 'ERR ' + errors.join(' | ') : '');
    await page.close();
  }
  await browser.close();
  server.close();
})();
