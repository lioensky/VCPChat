/*
 * 开场与过场的离线截图：node tests/music-intro/shots.cjs [--out=dir] [--light]
 * 用 freeze() 把动画停在某一帧，看每一段写的字。
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(args.out || path.join(require('node:os').tmpdir(), 'music-intro-shots'));
const FRAMES = [['full', 1.0], ['full', 4.4], ['full', 5.0], ['full', 5.9], ['full', 6.9], ['full', 8.6], ['enter', 0.3], ['exit', 0.2], ['switch', 0.16]];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/Musicmodules/music-theme/music-tokens.css">
    <link rel="stylesheet" href="/Musicmodules/music-intro/music-intro.css"></head>
    <body class="${'light' in args ? 'light-theme' : ''}" style="margin:0;background:var(--ar-paper,#11181b)">
    <script>window.electronAPI = { loadSettings: async () => ({ userName: '测试用户' }) };</script>
    <script src="/Musicmodules/music-intro/music-intro.js"></script></body></html>`;
  fs.writeFileSync(path.join(ROOT, 'tests/music-intro/harness.html'), html);
  const server = await require('../music-stage-bench/serve.cjs')(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/tests/music-intro/harness.html?intro=off`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.evaluate(() => { window.app = { playlist: Array.from({ length: 570 }, (_, i) => ({ title: 'T' + i })), currentTrackIndex: 0 }; window.api = window.MusicIntroLib.init(window.app); });
  await page.waitForTimeout(300);
  for (const [kind, t] of FRAMES) {
    await page.evaluate(([k, at]) => { document.querySelectorAll('.music-intro').forEach((n) => n.remove()); window.api.freeze(k, at, { file: '水面旧磁带', label: '镜台' }); }, [kind, t]);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `${kind}-${t}${'light' in args ? '-light' : ''}.png`) });
  }
  console.log('done', errors.join(' | '));
  await browser.close();
  server.close();
})();
