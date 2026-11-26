/*
 * 档案页静止时不再排帧：用真实的场景代码（three 照常加载，只把 WebGL 渲染器、环境贴图烘焙和 2D 画布换成空实现），
 * rAF 和时钟打桩，一帧一帧往前推，数请求了多少次 rAF。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const read = (p) => fs.readFileSync(p, 'utf8');

function setup({ playing = false, lyrics = false, fluid = false } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="music-archive-view" hidden></div><button id="music-archive-return"></button></body>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.console.warn = () => {};
    w.innerWidth = 1600; w.innerHeight = 900;
    // jsdom 没有 ResizeObserver（本机版歌词栏用它跟随尺寸），给个空实现
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    // 虚拟时钟
    const clock = { now: 1000, queue: [], timers: [], id: 0, raf: 0, bySource: {} };
    w.performance.now = () => clock.now;
    const realDate = w.Date.now;
    const epoch = realDate();
    w.Date.now = () => epoch + clock.now;
    w.requestAnimationFrame = (cb) => {
        clock.raf++;
        const src = ((new Error().stack.split('\n')[2] || '').match(/at (\S+)/) || [])[1] || '?';
        clock.bySource[src] = (clock.bySource[src] || 0) + 1;
        clock.queue.push([++clock.id, cb]);
        return clock.id;
    };
    w.cancelAnimationFrame = (id) => { clock.queue = clock.queue.filter((q) => q[0] !== id); };
    w.setTimeout = (fn, ms = 0) => { clock.timers.push({ id: ++clock.id, at: clock.now + ms, fn }); return clock.id; };
    w.clearTimeout = (id) => { clock.timers = clock.timers.filter((t) => t.id !== id); };
    w.setInterval = (fn, ms = 0) => { clock.timers.push({ id: ++clock.id, at: clock.now + ms, every: Math.max(1, ms), fn }); return clock.id; };
    w.clearInterval = w.clearTimeout;
    const advance = (ms) => {
        const end = clock.now + ms;
        while (clock.now < end) {
            clock.now += 1000 / 60;
            for (const t of clock.timers.slice()) {
                if (t.at > clock.now || !clock.timers.includes(t)) continue;
                if (t.every) t.at += t.every; else clock.timers = clock.timers.filter((x) => x !== t);
                t.fn();
            }
            const q = clock.queue; clock.queue = [];
            for (const [, cb] of q) cb(clock.now);
        }
    };
    const count = (ms) => { clock.raf = 0; clock.bySource = {}; advance(ms); return clock.raf; };

    // 2D 画布：什么都不画
    const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {})), set: (t, k, v) => { t[k] = v; return true; } });
    w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
    w.eval(read('vendor/three.min.js'));
    // 渲染器：不碰 WebGL
    w.THREE = Object.assign(Object.create(w.THREE), {
        WebGLRenderer: class {
            constructor({ canvas }) { this.domElement = canvas; this.shadowMap = {}; this.capabilities = { getMaxAnisotropy: () => 1, maxTextureSize: 4096 }; this.info = { render: { calls: 0, triangles: 0 }, programs: [] }; this.draws = 0; w.__renderer = this; }
            setPixelRatio() {} getPixelRatio() { return 1; } setSize() {} render() { this.draws++; } dispose() {} forceContextLoss() {} compile() {}
        },
        PMREMGenerator: class { fromScene() { return { texture: null, dispose() {} }; } compileEquirectangularShader() {} dispose() {} }
    });
    w.eval(read('Musicmodules/music-app-hooks.js'));
    for (const n of ['model', 'scene', 'index', 'list', 'lyrics']) w.eval(read(`Musicmodules/music-archive/archive-${n}.js`));
    if (fluid) w.eval(read(fluid));
    w.eval(read('Musicmodules/music-archive/archive-view.js'));
    const tracks = Array.from({ length: 120 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: i % 2 ? 'Aki' : 'Ren', album: 'A' + (i % 3) }));
    const app = {
        playlist: tracks, customPlaylists: [{ id: 'p', name: '夜间散步', tracks: ['/m/5', '/m/7', '/m/9'] }],
        currentTrackIndex: 0, isPlaying: playing, lastKnownCurrentTime: 12, lastStateUpdateTime: epoch + clock.now,
        currentLyrics: lyrics ? Array.from({ length: 30 }, (_, i) => ({ time: i * 4, text: '第 ' + i + ' 句' })) : [],
        loadTrack() {}, playTrack() {}, pauseTrack() {}, renderPlaylist() {}, seekTo() {},
        stageHost: { active: false, enter() {} }
    };
    const view = w.MusicArchive.init(app, { pinyinSrc: false });
    const key = (k) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    return { w, app, view, clock, advance, count, key, close: () => { view.destroy(); w.close(); } };
}

test('暂停、没有输入：选中的涟漪走完后，一次 rAF 都不排，也不再画', () => {
    const f = setup({ playing: false, lyrics: true });
    assert.ok(f.w.__renderer, '用的是真实场景代码');
    f.view.setListOpen(true);
    f.key('ArrowDown'); f.key('ArrowRight');
    assert.ok(f.count(1000) >= 50, '操作后在画');
    f.advance(2600); // 换选中时那一圈涟漪要走 3.3 秒，走完才算没有动画
    const draws = f.w.__renderer.draws;
    assert.equal(f.count(2000), 0, JSON.stringify(f.clock.bySource));
    assert.equal(f.count(10000), 0, JSON.stringify(f.clock.bySource));
    assert.equal(f.w.__renderer.draws, draws);
    // 有输入就醒，停稳后再睡
    f.key('ArrowDown');
    assert.ok(f.count(500) >= 25);
    f.advance(3000);
    assert.equal(f.count(2000), 0);
    f.close();
});

// 卡放回阵列（浏览）时才起伏；取出端详时照参考播放器不起伏，见下一条
const browse = (f) => { const sc = f.view.scene; const set = sc.setDetail; sc.setDetail = () => set(false); set(false); };

test('取出端详时背景不起伏、不跳：卡停稳后不再画，放回后又起伏', () => {
    const f = setup({ playing: true, lyrics: true });
    f.key('ArrowDown');
    f.advance(6000);
    assert.equal(f.count(2000), 0, JSON.stringify(f.clock.bySource));
    browse(f);
    f.view.refresh();
    f.advance(6000);
    assert.ok(f.count(1000) > 0, '放回后又起伏');
    f.close();
});

test('播放中才有静止后的缓慢起伏（12 帧）；一暂停就收住，之后归零；再播放又醒', () => {
    const f = setup({ playing: true, lyrics: true });
    browse(f);
    f.key('ArrowDown');
    f.advance(6000);
    const before = f.w.__renderer.draws;
    f.advance(2000);
    const fps = (f.w.__renderer.draws - before) / 2;
    assert.ok(fps >= 11 && fps <= 13, '静止时 12 帧，实际 ' + fps);
    f.app.isPlaying = false;
    f.view.refresh();
    f.advance(5000);
    assert.equal(f.count(2000), 0, JSON.stringify(f.clock.bySource));
    f.app.isPlaying = true; f.app.lastStateUpdateTime = f.w.Date.now();
    f.view.refresh();
    f.advance(4000);
    assert.ok(f.count(1000) > 0, '播放后又动起来');
    f.close();
});

test('暂停时歌词不走表：没有周期定时器在跑（时钟除外）', () => {
    const f = setup({ playing: false, lyrics: true });
    f.advance(3000);
    const every = f.clock.timers.filter((t) => t.every).map((t) => t.every);
    assert.deepEqual(every, [1000], '只剩一秒一次的时钟');
    f.close();
});

const FLUID = process.env.MUSIC_FLUID_MARKER || (fs.existsSync('Musicmodules/music-dock/music-fluid-marker.js') ? 'Musicmodules/music-dock/music-fluid-marker.js' : '');
test('有流体小滴时也一样：暂停静止后 rAF 为 0', { skip: !FLUID && '没有流体标记模块' }, () => {
    const f = setup({ playing: false, lyrics: true, fluid: FLUID });
    f.view.setListOpen(true);
    f.key('ArrowDown'); f.key('ArrowRight'); f.key('ArrowDown');
    f.advance(4000);
    assert.equal(f.count(3000), 0, JSON.stringify(f.clock.bySource));
    f.close();
});
