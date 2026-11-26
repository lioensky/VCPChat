/*
 * 真实 music.html 的离线冒烟：加载完整页面，electronAPI 用假实现（不碰真实数据），
 * 验证档案页默认显示、点卡/回车会调用 loadTrack 并进入舞台、Esc 回到档案页、经典视图切换。
 *   node tests/music-archive/real-window.cjs [--out=dir] [--n=600]
 */
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(args.out || path.join(require('node:os').tmpdir(), 'music-archive-shots'));
const N = Number(args.n || 600);

const FAKE = ({ n, light }) => {
  const tracks = Array.from({ length: n }, (_, i) => ({ path: 'D:\\Music\\t' + i + '.flac', title: '曲目 ' + (i + 1) + '.flac', artist: ['Aki', 'Ren', 'Lumi'][i % 3], album: ['Low Tide', '窗边', 'Static Bloom', '夜行列车'][i % 4] }));
  const playlists = [{ id: 'p1', name: '海边线路', tracks: tracks.slice(0, 18).map((t) => t.path) }, { id: 'p2', name: '夜间散步', tracks: tracks.slice(20, 33).map((t) => t.path) }];
  window.__calls = [];
  const state = { is_playing: false, current_time: 0, duration: 200, file_path: null };
  const fns = {
    getMusicPlaylist: async () => tracks,
    getCustomPlaylists: async () => playlists,
    getMusicState: async () => ({ state }),
    getMusicPendingTrack: async () => null,
    getCurrentTheme: async () => (light ? 'light' : 'dark'),
    getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } }),
    listMusicIrPresets: async () => [],
    listWebdavServers: async () => [],
    musicLoad: async (t) => { window.__calls.push(['musicLoad', t && t.path]); state.file_path = t && t.path; return { status: 'success', state }; },
    musicPlay: async () => { window.__calls.push(['musicPlay']); state.is_playing = true; return { status: 'success', state }; },
    musicPause: async () => { state.is_playing = false; return { status: 'success', state }; },
    getMusicLyrics: async () => null, fetchMusicLyrics: async () => null
  };
  const handler = { get: (_, k) => fns[k] || (k.startsWith('on') ? () => () => {} : async () => ({ status: 'success' })) };
  window.electronAPI = new Proxy({}, handler);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await require('../music-stage-bench/serve.cjs')(ROOT);
  const url = `http://127.0.0.1:${server.address().port}/Musicmodules/music.html`;
  // 每个主题开一个新的浏览器（连 GPU 进程一起新开）：软件渲染下前一页关掉后，
  // GPU 进程里排着的绘制命令还要再跑一阵，同一个浏览器里紧接着开的下一页会被它拖慢到加载超时。
  const launch = () => chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const results = [];
  const check = (name, ok, extra = '') => { results.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
  for (const light of [false, true]) {
    const browser = await launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(FAKE, { n: N, light });
    await page.goto(url, { timeout: 90000 });
    await page.waitForFunction(() => window.app?.archiveView || document.querySelector('.archive-hud'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const tag = light ? 'light' : 'dark';
    const d0 = await page.evaluate(() => {
      const v = document.getElementById('music-archive-view');
      return { shown: v && !v.hidden, bodyOn: document.body.classList.contains('music-archive-on'), files: document.querySelector('[data-ref="files"]')?.textContent, cols: document.querySelector('[data-ref="colT"]')?.textContent };
    });
    check(tag + ': archive is the default view', d0.shown && d0.bodyOn, JSON.stringify(d0));
    await page.screenshot({ path: path.join(OUT, `real-${tag}.png`), timeout: 90000 });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    const d1 = await page.evaluate(() => ({ calls: window.__calls.slice(), stage: document.body.classList.contains('music-stage-active'), filtered: Array.isArray(window.__appFiltered) }));
    check(tag + ': Enter loads the selected track of the playlist column', d1.calls.some((c) => c[0] === 'musicLoad' && c[1] === 'D:\\Music\\t2.flac'), JSON.stringify(d1.calls.slice(-3)));
    check(tag + ': Enter opens the stage page', d1.stage);
    await page.screenshot({ path: path.join(OUT, `real-${tag}-stage.png`), timeout: 90000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    const d2 = await page.evaluate(() => ({ stage: document.body.classList.contains('music-stage-active'), shown: !document.getElementById('music-archive-view').hidden }));
    check(tag + ': Esc returns to the archive', !d2.stage && d2.shown);
    await page.evaluate(() => document.querySelector('[data-act="classic"]').click()); // 软件渲染下 page.click 等不到稳定帧
    await page.waitForTimeout(600);
    const d3 = await page.evaluate(() => ({ off: document.body.classList.contains('music-archive-off'), hidden: document.getElementById('music-archive-view').hidden, ret: getComputedStyle(document.getElementById('music-archive-return')).display }));
    check(tag + ': classic view hides the archive and shows the return button', d3.off && d3.hidden && d3.ret !== 'none');
    await page.screenshot({ path: path.join(OUT, `real-${tag}-classic.png`), timeout: 90000 });
    await page.evaluate(() => document.getElementById('music-archive-return').click());
    await page.waitForTimeout(500);
    check(tag + ': return button brings the archive back', await page.evaluate(() => !document.getElementById('music-archive-view').hidden));
    check(tag + ': no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    // 关页时档案页的 3D 场景要彻底停掉：触发 pagehide 后渲染循环、画布和 WebGL 上下文都不在了
    const gone = await page.evaluate(async () => {
      const canvas = document.querySelector('#music-archive-view canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      // 停掉之后一秒内档案页不该再请求任何一帧
      let frames = 0;
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = (cb) => { if (/archive-view/.test(new Error().stack)) frames++; return raf(cb); };
      await new Promise((r) => setTimeout(r, 1000));
      return { hadCanvas: Boolean(canvas), canvasLeft: Boolean(document.querySelector('#music-archive-view canvas')), contextLost: gl ? gl.isContextLost() : null, frames };
    });
    check(tag + ': pagehide stops and releases the 3D scene', gone.hadCanvas && !gone.canvasLeft && gone.contextLost !== false && gone.frames === 0, JSON.stringify(gone));
    await context.close();
    await browser.close();
  }
  server.close();
  process.exitCode = results.every((r) => r[1]) ? 0 : 1;
})();
