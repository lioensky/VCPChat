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

test('舞台模式下拉展开时按 Esc 让给菜单，不直接退出舞台', async () => {
    const t = setup({ startInStage: true });
    const picker = t.doc.createElement('nav');
    picker.className = 'music-stage-mode-switcher is-open';
    t.doc.body.appendChild(picker);
    t.doc.body.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(t.doc.querySelector('.music-intro[data-intro="exit"]'), null);
    await t.advance(500);
    assert.equal(t.host.active, true);
    picker.classList.remove('is-open');
    t.doc.body.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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

test('完整开场在非打字区间跳过 getComputedTextLength，且不重复写相同 stroke-dasharray', async () => {
    const t = setup();
    let measureCalls = 0;
    const origCreateNS = t.doc.createElementNS.bind(t.doc);
    t.doc.createElementNS = (ns, tag) => {
        const node = origCreateNS(ns, tag);
        if (tag === 'text') {
            node.getComputedTextLength = () => { measureCalls += 1; return (node.textContent || '').length * 10; };
        }
        return node;
    };
    t.intro.replay();
    await t.advance(3000); // 跨越 access（0.4~1.0s）后继续运行到 3.0s
    const afterAccess = measureCalls;
    assert.ok(afterAccess > 0 && afterAccess <= 10, `expected bounded textWidth calls during access typing, got ${afterAccess}`);
    await t.advance(500); // 3.0~3.5s 既不在 access 也不在 auth 区间，不应再量文本宽度
    assert.equal(measureCalls, afterAccess, 'no textWidth calls outside access/auth windows');
    t.intro.skip();
    await t.advance(50);
    t.close();
});

test('输入法组合态按 Esc 不误退舞台，beforeunload 立即清理活跃过场', async () => {
    const t = setup({ startInStage: true });
    const composingEsc = new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(composingEsc, 'isComposing', { value: true });
    t.doc.body.dispatchEvent(composingEsc);
    assert.equal(t.doc.querySelector('.music-intro[data-intro="exit"]'), null, 'IME composing Escape must not trigger exit');
    assert.equal(t.host.active, true);

    t.host.exit();
    assert.ok(t.doc.querySelector('.music-intro.is-transit'));
    t.window.dispatchEvent(new t.window.Event('beforeunload'));
    assert.equal(t.doc.querySelectorAll('.music-intro').length, 0, 'beforeunload removes transit overlay immediately');
    await t.advance(50);
    assert.deepEqual(t.leftovers(), CLEAN, 'beforeunload cleans active transit overlay and body classes');
    t.close();
});

test('降低动态且无 Element.animate 时，过场降级为定时器正常收尾', async () => {
    const t = setup({ reduced: true });
    t.window.Element.prototype.animate = undefined;
    t.host.enter();
    await t.advance(100);
    await new Promise((r) => setTimeout(r, 420));
    await t.advance(100);
    assert.equal(t.host.active, true);
    assert.deepEqual(t.leftovers(), CLEAN);
    t.close();
});

test('Batch 62: music-intro skips redundant per-frame root/wipe attribute writes when values are unchanged', async () => {
    const t = setup();
    t.intro.replay();
    const root = t.doc.querySelector('.music-intro');
    assert.ok(root);
    let waitingToggleCalls = 0;
    const origToggleAttr = root.toggleAttribute.bind(root);
    root.toggleAttribute = (name, force) => {
        if (name === 'data-waiting') waitingToggleCalls += 1;
        return origToggleAttr(name, force);
    };
    const wipe = root.querySelector('.mi-wipe');
    let wipeOpWrites = 0;
    const origWipeStyle = wipe.style;
    const origSet = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(origWipeStyle), 'opacity')?.set;
    if (origSet) {
        Object.defineProperty(origWipeStyle, 'opacity', {
            configurable: true,
            get() { return this.getPropertyValue('opacity'); },
            set(v) { wipeOpWrites += 1; return origSet.call(this, v); }
        });
    }
    await t.advance(600);
    assert.equal(waitingToggleCalls, 1, 'data-waiting toggled only once while waiting stays false');
    if (origSet) assert.equal(wipeOpWrites, 1, 'mi-wipe opacity written once while wipe stays 0');
    t.intro.skip();
    await t.advance(50);
    t.close();
});

test('Batch 73: music-intro guards settled mark transform and scan letter-spacing writes', async () => {
    const t = setup();
    t.intro.replay();
    const root = t.doc.querySelector('.music-intro');
    const mark = root.querySelectorAll('svg > g')[1];
    let markWrites = 0;
    const origSetAttr = mark.setAttribute.bind(mark);
    mark.setAttribute = (name, val) => {
        if (name === 'transform') markWrites += 1;
        return origSetAttr(name, val);
    };
    await t.advance(4100);
    const afterSettle = markWrites;
    await t.advance(1000);
    assert.equal(markWrites, afterSettle, 'settled mark group skips redundant transform attribute writes');
    t.intro.skip();
    await t.advance(50);
    t.close();
});
