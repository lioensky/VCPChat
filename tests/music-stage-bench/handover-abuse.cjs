/*
 * Interrupts a 3D stage's song handover and mode switch in every way a
 * listener can (skipping on, skipping back, seeking, pausing, switching the
 * stage, hiding the window) and checks that each one settles: one mode,
 * no handover or switch left open, no veil or leaving class left on, no errors.
 * Software rendering, so it waits generously.
 *
 *   node tests/music-stage-bench/handover-abuse.cjs [--only=diorama,tunnel]
 */
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', '..');
const MODES = (process.argv.find((a) => a.startsWith('--only=')) || '--only=diorama,tunnel').slice(7).split(',');
let failed = 0;
const SC = {
  rapidSkip: [['track',1],[150],['track',0],[150],['track',1],[150],['track',0],[150],['track',1]],
  seekDuringHandover: [['track',1],[600],['seek',90]],
  pauseDuringHandover: [['track',1],[400],['pause'],[3000],['play']],
  skipBackDuringHandover: [['track',1],[100],['track',0]],
  switchDuringHandover: [['track',1],[300],['mode','other'],[200],['mode','self']],
  hiddenDuringHandover: [['track',1],[200],['hide'],[1500],['show']],
  quickSwitch: [['mode','other'],[50],['mode','self'],[50],['mode','other'],[100],['mode','self']],
};
(async () => {
  const server = await require('./serve.cjs')(ROOT);
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const MODE of MODES) for (const [name, steps] of Object.entries(SC)) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(`${ORIGIN}/blank.html`);
    await page.evaluate((m) => { localStorage.clear(); localStorage.setItem('musicStageMode', m); }, MODE);
    await page.goto(`${ORIGIN}/Musicmodules/harness.html?lyrics=song&duration=215&t=20`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__h?.app?.stageHost, null, { timeout: 60000 });
    await page.evaluate(() => __h.app.stageHost.enter());
    await page.waitForFunction(() => __h.snap().mode?.initialized, null, {timeout:120000});
    await page.waitForTimeout(1500);
    const other = MODE === 'diorama' ? 'tunnel' : 'diorama';
    for (const [op, arg] of steps) {
      if (op === undefined || typeof op === 'number') { await page.waitForTimeout(op); continue; }
      await page.evaluate(([op, arg, self, other]) => {
        if (op === 'track') __h.track(arg); else if (op === 'seek') __h.seek(arg);
        else if (op === 'pause') __h.pause(); else if (op === 'play') __h.play();
        else if (op === 'mode') __h.app.stageHost.setMode(arg === 'other' ? other : self);
        else if (op === 'hide' || op === 'show') { Object.defineProperty(document, 'visibilityState', { value: op === 'hide' ? 'hidden' : 'visible', configurable: true }); Object.defineProperty(document, 'hidden', { value: op === 'hide', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
      }, [op, arg, MODE, other]);
    }
    await page.waitForTimeout(12000);
    const r = await page.evaluate(() => { const s = __h.snap(); const root = document.querySelector('.music-stage-mode-root');
      return { modeId: s.modeId, init: s.mode?.initialized, songHandover: s.songHandover, handover: s.mode?.handover, switching: s.switching,
        songLeaving: !!document.querySelector('.is-song-leaving'), veil: !!document.querySelector('.stage-handover-veil.is-showing'),
        modes: root?.children.length, track: __h.app.currentTrackIndex, compiled: s.mode?.lyricLines ?? s.mode?.lines, errors: __h.errors.slice(0,3) }; });
    // Left alone long enough, every handover has finished and nothing is left half-shown.
    const ok = r.modeId === MODE && r.init && !r.songHandover && !r.switching && !r.songLeaving && !r.veil && r.modes === 1 && !r.errors.length;
    if (!ok) failed += 1;
    console.log(ok ? 'ok  ' : 'FAIL', MODE, name, JSON.stringify(r));
    await page.close();
  }
  await browser.close(); server.close();
  process.exitCode = failed ? 1 : 0;
})();
