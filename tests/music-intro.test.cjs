// 进出舞台的过场接管了 stageHost.enter / exit / toggle：先盖住，再真正进出。
// 这里用假的舞台宿主和手动推进的帧，检查顺序、连按、降低动态三件事。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'Musicmodules/music-intro/music-intro.js'), 'utf8');

function setup({ reduced = false, startInStage = false } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <main class="music-stage" hidden><div class="music-stage-mode-root"></div></main>
    </body>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/?intro=off' });
    const { window } = dom;
    const doc = window.document;

    // 手动推进的时钟和帧
    let now = 1000;
    let frames = [];
    let frameId = 0;
    window.performance.now = () => now;
    window.requestAnimationFrame = (fn) => { frames.push({ id: ++frameId, fn }); return frameId; };
    window.cancelAnimationFrame = (id) => { frames = frames.filter((f) => f.id !== id); };
    window.Element.prototype.animate = function () { return { finished: Promise.resolve() }; };
    window.MusicMotion = { reduced: () => reduced };

    const stage = doc.querySelector('.music-stage');
    const log = [];
    const host = {
        active: false,
        modeId: 'luminous',
        enter() {
            if (host.active) return;
            host.active = true;
            stage.hidden = false;
            doc.body.classList.add('music-stage-active');
            log.push({ op: 'enter', covered: Boolean(doc.querySelector('.music-intro.is-transit')), frame: frameCount });
        },
        exit() {
            if (!host.active) return;
            host.active = false;
            stage.hidden = true;
            doc.body.classList.remove('music-stage-active');
            log.push({ op: 'exit', covered: Boolean(doc.querySelector('.music-intro.is-transit')), frame: frameCount });
        },
        toggle() { host.active ? host.exit() : host.enter(); },
        getDebugSnapshot: () => ({ hasModeInstance: host.active, mode: null })
    };
    if (startInStage) { host.active = true; stage.hidden = false; doc.body.classList.add('music-stage-active'); }
    const app = { stageHost: host, playlist: [{ title: 'a' }], currentTrackIndex: 0 };

    window.eval(source);
    const intro = window.MusicIntroLib.init(app);

    let frameCount = 0;
    // 推进 ms 毫秒：每 16ms 一帧，帧之间让微任务（MutationObserver、Promise）跑完
    const advance = async (ms) => {
        const end = now + ms;
        while (now < end) {
            now += 16;
            frameCount += 1;
            const batch = frames;
            frames = [];
            for (const f of batch) f.fn(now);
            await new Promise((resolve) => setImmediate(resolve));
        }
    };
    const leftovers = () => ({
        cover: doc.querySelectorAll('.music-intro').length,
        hold: ['mi-stage-hold-enter', 'mi-stage-hold-exit', 'mi-stage-snap', 'music-stage-entering', 'music-intro-playing']
            .filter((c) => doc.body.classList.contains(c))
    });
    return { window, doc, host, app, intro, log, advance, leftovers, stage, close: () => window.close() };
}

const CLEAN = { cover: 0, hold: [] };

test('进舞台：过场先上屏，之后才真正进入', async () => {
    const t = setup();
    t.host.enter();
    assert.equal(t.host.active, false, '调用后不立刻进入');
    assert.ok(t.doc.querySelector('.music-intro.is-transit'), '过场已经在');
    await t.advance(3000);
    assert.equal(t.host.active, true);
    assert.equal(t.log.length, 1);
    assert.equal(t.log[0].covered, true, '进入时过场盖着');
    assert.ok(t.log[0].frame >= 3, '至少画过几帧才进入');
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('退舞台：盖严之后才真正退出', async () => {
    const t = setup({ startInStage: true });
    t.host.exit();
    assert.equal(t.host.active, true, '调用后舞台还在');
    await t.advance(3000);
    assert.equal(t.host.active, false);
    assert.equal(t.log[0].op, 'exit');
    assert.equal(t.log[0].covered, true);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('连按 进、出、进（间隔 100ms）：最后在舞台里，没有残留', async () => {
    const t = setup();
    t.host.enter();
    await t.advance(100);
    t.host.exit();
    await t.advance(100);
    t.host.enter();
    await t.advance(4000);
    assert.equal(t.host.active, true);
    assert.equal(t.doc.body.classList.contains('music-stage-active'), true);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('连按 出、进、出（间隔 100ms）：最后回到常规，没有残留', async () => {
    const t = setup({ startInStage: true });
    t.host.exit();
    await t.advance(100);
    t.host.enter();
    await t.advance(100);
    t.host.exit();
    await t.advance(4000);
    assert.equal(t.host.active, false);
    assert.equal(t.stage.hidden, true);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('进到一半（已经进去、还没揭开）再退：最后回到常规', async () => {
    const t = setup();
    t.host.enter();
    await t.advance(600); // 过了闸门，宿主已经进入
    assert.equal(t.host.active, true);
    t.host.exit();
    await t.advance(4000);
    assert.equal(t.host.active, false);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('连着切换舞台（stageHost.toggle，底栏和快捷键都走它）：每切一次去向反一次', async () => {
    for (const [presses, expected] of [[1, true], [2, false], [3, true], [4, false]]) {
        const t = setup();
        for (let i = 0; i < presses; i += 1) {
            t.host.toggle();
            await t.advance(100);
        }
        await t.advance(4000);
        assert.equal(t.host.active, expected, `按 ${presses} 次`);
        assert.deepEqual(t.leftovers(), CLEAN, `按 ${presses} 次`);
        t.close();
    }
});

test('Esc 退出舞台也走过场', async () => {
    const t = setup({ startInStage: true });
    t.doc.body.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(t.host.active, true);
    assert.ok(t.doc.querySelector('.music-intro[data-intro="exit"]'));
    await t.advance(3000);
    assert.equal(t.host.active, false);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('降低动态：盖一层不动的纸色底，进出照常完成', async () => {
    const t = setup({ reduced: true });
    t.host.enter();
    const cover = t.doc.querySelector('.music-intro.is-transit');
    assert.ok(cover, '有遮罩');
    assert.equal(cover.dataset.still, '1', '是静态遮罩');
    await t.advance(1000);
    assert.equal(t.host.active, true);
    assert.equal(t.log[0].covered, true);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.host.exit();
    await t.advance(1000);
    assert.equal(t.host.active, false);
    assert.equal(t.log[1].covered, true);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('加载没好就一直盖着，好了才揭开', async () => {
    const t = setup();
    let ready = false;
    t.host.getDebugSnapshot = () => ({ hasModeInstance: true, mode: { initialized: ready, fallbackMode: false } });
    t.host.enter();
    await t.advance(3000);
    assert.equal(t.host.active, true);
    const cover = t.doc.querySelector('.music-intro.is-transit');
    assert.ok(cover, '还盖着');
    assert.ok(cover.hasAttribute('data-waiting'));
    assert.ok(t.doc.body.classList.contains('mi-stage-hold-enter'), '舞台还按着没露出来');
    ready = true;
    await t.advance(2000);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});
