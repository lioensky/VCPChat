const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function setup({ reduce = false, low = false } = {}) {
    const dom = new JSDOM(`<!doctype html><body class="${reduce ? 'music-reduce-motion' : ''}"><div id="music-dock-root" class="${low ? 'md-fl-low' : 'md-fl-on'}"></div><div class="menu" style="position:fixed"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let now = 0;
    const frames = [];
    window.performance.now = () => now;
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const menu = window.document.querySelector('.menu');
    menu.getBoundingClientRect = () => ({ left: 100, top: 200, width: 220, height: 300, right: 320, bottom: 500 });
    const run = (ms) => { now += ms; const due = frames.splice(0); due.forEach((fn) => fn()); };
    return { window, doc: window.document, menu, run };
}

test('a menu grows out of the point it was opened from, then the liquid layer is removed', async () => {
    const { window, doc, menu, run } = setup();
    assert.equal(window.MusicFluid.enabled(), true);
    const done = window.MusicFluid.bud(menu, { x: 110, y: 205 });
    assert.ok(menu.classList.contains('mf-budding'), 'content waits for the liquid');
    const goo = doc.querySelector('svg.mf-goo');
    assert.ok(goo, 'a temporary liquid layer is drawn');
    assert.equal(goo.querySelector('circle').getAttribute('cx'), '110.0', 'the drop sits on the opening point');
    run(150);
    const w1 = Number(goo.querySelector('rect').getAttribute('width'));
    assert.ok(w1 > 28 && w1 < 220, 'the body is still growing');
    run(150);
    assert.ok(!menu.classList.contains('mf-budding'), 'content shows before the liquid finishes');
    run(200);
    await done;
    assert.equal(doc.querySelector('svg.mf-goo'), null, 'nothing is left drawing afterwards');
});

test('opening again mid-way cancels the first growth instead of stacking layers', () => {
    const { window, doc, menu, run } = setup();
    window.MusicFluid.bud(menu, { x: 110, y: 205 });
    run(100);
    window.MusicFluid.bud(menu, { x: 300, y: 480 });
    assert.equal(doc.querySelectorAll('svg.mf-goo').length, 1);
    run(600);
    assert.equal(doc.querySelectorAll('svg.mf-goo').length, 0);
});

test('reduced motion and the low quality tier skip the liquid entirely', async () => {
    for (const opts of [{ reduce: true }, { low: true }]) {
        const { window, doc, menu } = setup(opts);
        assert.equal(window.MusicFluid.enabled(), false);
        await window.MusicFluid.bud(menu, { x: 110, y: 205 });
        assert.equal(doc.querySelector('svg.mf-goo'), null);
        assert.ok(!menu.classList.contains('mf-budding'));
    }
});

test('a selection marker flows to its new place: the leading edge arrives first, the trailing edge follows', () => {
    const { window, doc, run } = setup();
    const mark = doc.createElement('i');
    doc.body.appendChild(mark);
    window.MusicFluid.slide(mark, { left: 0, width: 40 }, { key: 'tabs' });
    assert.equal(parseFloat(mark.style.left), 0, 'first placement is instant');
    const fresh = doc.createElement('i'); // 那一排重画了，标记是新元素
    doc.body.appendChild(fresh);
    window.MusicFluid.slide(fresh, { left: 200, width: 40 }, { key: 'tabs' });
    run(120);
    const left = parseFloat(fresh.style.left), width = parseFloat(fresh.style.width);
    assert.ok(left > 0 && left < 200, 'still on its way');
    assert.ok(width > 40, `stretched while moving (${width})`);
    run(400);
    assert.equal(parseFloat(fresh.style.left), 200);
    assert.equal(parseFloat(fresh.style.width), 40);
});

test('a dialog opened anywhere grows out of the last press, without the opening code knowing', async () => {
    const dom = new JSDOM(`<!doctype html><body><div class="dialog-overlay"><div class="dialog"></div></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const frames = [];
    let now = 0;
    window.performance.now = () => now;
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const doc = window.document;
    if (doc.readyState === 'loading') await new Promise((r) => doc.addEventListener('DOMContentLoaded', r, { once: true }));
    const panel = doc.querySelector('.dialog');
    panel.getBoundingClientRect = () => ({ left: 400, top: 200, width: 340, height: 180, right: 740, bottom: 380 });
    doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 90, clientY: 600 }));
    doc.querySelector('.dialog-overlay').classList.add('visible');
    await new Promise((r) => setTimeout(r, 0)); // 等 MutationObserver
    frames.splice(0).forEach((fn) => fn());
    const goo = doc.querySelector('svg.mf-goo');
    assert.ok(goo, 'liquid drawn for the dialog');
    assert.equal(goo.querySelector('circle').getAttribute('cx'), '90.0');
    // 关掉再开，又会长一次；没关的时候改别的类不会重来
    for (let i = 0; i < 40; i++) { now += 50; frames.splice(0).forEach((fn) => fn()); }
    assert.equal(doc.querySelector('svg.mf-goo'), null);
    doc.querySelector('.dialog-overlay').classList.add('other');
    await new Promise((r) => setTimeout(r, 0));
    frames.splice(0).forEach((fn) => fn());
    assert.equal(doc.querySelector('svg.mf-goo'), null, 'no regrowth while it stays open');
    // 关掉：面板此时已经量不到大小，靠打开时记下的样子缩回一滴，流回刚按下的「取消」
    await Promise.resolve();
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
    doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 700, clientY: 360 }));
    doc.querySelector('.dialog-overlay').classList.remove('visible');
    await new Promise((r) => setTimeout(r, 0));
    const back = doc.querySelector('svg.mf-goo');
    assert.ok(back, 'liquid drawn for the closing dialog');
    assert.equal(back.querySelector('rect').getAttribute('width'), '340.0', 'starts from the open size');
    for (let i = 0; i < 20; i++) { now += 50; frames.splice(0).forEach((fn) => fn()); }
    assert.equal(doc.querySelector('svg.mf-goo'), null, 'layer removed after melting');
});

test('slide also runs vertically (top/height), leading edge first, and lands exactly', () => {
    const { window, doc, run } = setup();
    const drop = doc.createElement('i');
    doc.body.appendChild(drop);
    window.MusicFluid.slide(drop, { top: 0, height: 30 }, { key: 'lyr', axis: 'y' });
    assert.equal(parseFloat(drop.style.top), 0);
    assert.equal(parseFloat(drop.style.height), 30);
    assert.equal(drop.style.left, '', 'vertical slide leaves left alone');
    window.MusicFluid.slide(drop, { top: 60, height: 30 }, { key: 'lyr', axis: 'y', lead: 200, trail: 400 });
    run(100);
    const top = parseFloat(drop.style.top), h = parseFloat(drop.style.height);
    assert.ok(top + h > 60, 'the lower edge has already reached past the target top');
    assert.ok(h > 30, 'stretched while flowing');
    run(400);
    assert.equal(parseFloat(drop.style.top), 60);
    assert.equal(parseFloat(drop.style.height), 30);
});

test('a watched menu melts back to the item that was clicked when it closes, and only after it finished growing', async () => {
    const dom = new JSDOM(`<!doctype html><body><div class="context-menu"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const frames = [];
    let now = 0;
    window.performance.now = () => now;
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    const timers = [];
    window.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    window.clearTimeout = () => {};
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const doc = window.document;
    if (doc.readyState === 'loading') await new Promise((r) => doc.addEventListener('DOMContentLoaded', r, { once: true }));
    const menu = doc.querySelector('.context-menu');
    menu.getBoundingClientRect = () => ({ left: 300, top: 120, width: 200, height: 260, right: 500, bottom: 380 });
    const tick = () => new Promise((r) => window.queueMicrotask ? window.queueMicrotask(r) : Promise.resolve().then(r));
    // 关得太快（还没长完）：不画
    menu.classList.add('visible'); await tick();
    menu.classList.remove('visible'); await tick();
    assert.equal(doc.querySelector('svg.mf-goo'), null);
    // 长完再关：缩回一滴，流向点的那一项
    menu.classList.add('visible'); await tick();
    timers.splice(0).forEach((fn) => fn());
    doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 360, clientY: 200 }));
    menu.classList.remove('visible'); await tick();
    const goo = doc.querySelector('svg.mf-goo');
    assert.ok(goo, 'melting drawn');
    assert.equal(goo.querySelector('circle').getAttribute('cx'), '360.0');
    for (let i = 0; i < 20; i++) { now += 40; frames.splice(0).forEach((fn) => fn()); }
    assert.equal(doc.querySelector('svg.mf-goo'), null);
});

test('MusicFluidSelect clamps tall menu height before placement, forwards label clicks, and skips disabled hover focus', () => {
    const dom = new JSDOM(`<!doctype html><body><label for="tall-sel">预设</label><select id="tall-sel"><option value="a">第一项</option><option value="b" disabled>不可选</option><option value="c">第三项</option></select></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const doc = window.document;
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
    window.CSS = { escape: (s) => String(s) };
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-select.js'), 'utf8'));
    const select = doc.getElementById('tall-sel');
    window.MusicFluidSelect.dress(select);
    const trigger = doc.querySelector('.mfs-trigger');
    assert.ok(trigger, 'custom trigger created');
    trigger.getBoundingClientRect = () => ({ left: 100, top: 200, right: 260, bottom: 232, width: 160, height: 32 });
    // 模拟高菜单在 maxHeight 之前撑到 540px，但下方空间有 458px（足够放下 360px 限高后的菜单）
    const origOffsetH = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() { return this.classList?.contains('mfs-menu') ? (parseInt(this.style.maxHeight, 10) || 540) : 0; }
    });
    try {
        doc.querySelector('label[for="tall-sel"]').click();
        const menu = doc.querySelector('.mfs-menu');
        assert.ok(menu, 'clicking associated <label for> opens the fluid select menu');
        assert.equal(menu.style.maxHeight, '360px');
        assert.equal(menu.style.top, '238px', 'tall menu opens below trigger once clamped by maxHeight');
        const disabledItem = menu.querySelector('[aria-disabled="true"]');
        const firstItem = menu.querySelector('.mfs-item');
        assert.equal(doc.activeElement, firstItem);
        disabledItem.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true }));
        assert.equal(doc.activeElement, firstItem, 'hovering a disabled option does not steal focus');
        doc.querySelector('label[for="tall-sel"]').click();
        assert.equal(doc.querySelector('.mfs-menu'), null, 'clicking associated label again closes open menu');
    } finally {
        if (origOffsetH) Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', origOffsetH);
    }
});
