const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');


// jsdom 没有 Element.animate：记下每次动画的关键帧和参数，finished 由测试手动结束
function fakeAnimate(window) {
    const log = [];
    window.Element.prototype.animate = function (frames, opts) {
        let resolve;
        const finished = new Promise((r) => { resolve = r; });
        const a = { el: this, frames, opts, cancelled: false, finished, finish: () => resolve(), cancel() { a.cancelled = true; resolve(); } };
        log.push(a);
        return a;
    };
    return log;
}

function setup({ reduce = false, low = false } = {}) {
    const dom = new JSDOM(`<!doctype html><body class="${reduce ? 'music-reduce-motion' : ''}"><div id="music-dock-root" class="${low ? 'md-fl-low' : 'md-fl-on'}"></div><div class="menu" style="position:fixed"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let now = 0;
    const frames = [];
    window.performance.now = () => now;
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    const anims = fakeAnimate(window);
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const menu = window.document.querySelector('.menu');
    menu.getBoundingClientRect = () => ({ left: 100, top: 200, width: 220, height: 300, right: 320, bottom: 500 });
    const run = (ms) => { now += ms; const due = frames.splice(0); due.forEach((fn) => fn()); };
    return { window, doc: window.document, menu, run, anims };
}

test('a menu opens from the point it was opened from: scales up and fades in on itself, no extra layer', async () => {
    const { window, doc, menu, anims } = setup();
    assert.equal(window.MusicFluid.enabled(), true);
    const done = window.MusicFluid.bud(menu, { x: 110, y: 205 });
    assert.equal(doc.querySelector('svg'), null, 'no temporary liquid layer');
    assert.equal(anims.length, 1);
    assert.equal(anims[0].el, menu);
    assert.equal(anims[0].frames[0].opacity, 0);
    assert.match(anims[0].frames[0].transform, /scale\(\.96\)/);
    assert.equal(anims[0].frames[1].transform, 'none');
    assert.ok(anims[0].opts.duration <= 240, 'short');
    assert.equal(menu.style.transformOrigin, '10px 5px', 'grows from where it was opened');
    anims[0].finish();
    await done;
});

test('opening again mid-way cancels the first animation instead of stacking', () => {
    const { window, menu, anims } = setup();
    window.MusicFluid.bud(menu, { x: 110, y: 205 });
    window.MusicFluid.bud(menu, { x: 300, y: 480 });
    assert.equal(anims.length, 2);
    assert.equal(anims[0].cancelled, true);
    assert.equal(menu.style.transformOrigin, '200px 280px');
});

test('reduced motion only fades, without scaling', async () => {
    const { window, doc, menu, anims } = setup({ reduce: true });
    assert.equal(window.MusicFluid.enabled(), false);
    window.MusicFluid.bud(menu, { x: 110, y: 205 });
    assert.equal(doc.querySelector('svg'), null);
    assert.equal(anims.length, 1);
    assert.equal(anims[0].frames[0].transform, undefined);
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

test('a dialog opened anywhere opens from the last press and closes back toward the button that was pressed', async () => {
    const dom = new JSDOM(`<!doctype html><body><div class="dialog-overlay"><div class="dialog"></div></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const frames = [];
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    const anims = fakeAnimate(window);
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const doc = window.document;
    if (doc.readyState === 'loading') await new Promise((r) => doc.addEventListener('DOMContentLoaded', r, { once: true }));
    const panel = doc.querySelector('.dialog');
    panel.getBoundingClientRect = () => ({ left: 400, top: 200, width: 340, height: 180, right: 740, bottom: 380 });
    doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 90, clientY: 600 }));
    doc.querySelector('.dialog-overlay').classList.add('visible');
    await new Promise((r) => setTimeout(r, 0)); // 等 MutationObserver
    frames.splice(0).forEach((fn) => fn());
    assert.equal(anims.length, 1, 'the panel animates');
    assert.equal(anims[0].el, panel);
    assert.equal(panel.style.transformOrigin, '0px 180px', 'from the corner nearest the press');
    anims[0].finish();
    await new Promise((r) => setTimeout(r, 0));
    doc.querySelector('.dialog-overlay').classList.add('other');
    await new Promise((r) => setTimeout(r, 0));
    frames.splice(0).forEach((fn) => fn());
    assert.equal(anims.length, 1, 'no replay while it stays open');
    // 关掉：用打开时记下的副本朝刚按下的「取消」缩一点、淡出，结束就拿掉
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
    doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 700, clientY: 360 }));
    doc.querySelector('.dialog-overlay').classList.remove('visible');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(anims.length, 2);
    const ghost = anims[1].el;
    assert.notEqual(ghost, panel);
    assert.equal(ghost.style.width, '340px', 'the copy has the open size');
    assert.equal(anims[1].frames[1].opacity, 0);
    anims[1].finish();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(ghost.isConnected, false, 'copy removed afterwards');
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

test('a watched pop-up (sort menu) fades out toward the press after it finished opening; too-quick closes skip it', async () => {
    const dom = new JSDOM(`<!doctype html><body><div class="sort-menu" hidden><button>A</button></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const timers = [];
    window.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    window.clearTimeout = () => {};
    const anims = fakeAnimate(window);
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const doc = window.document;
    const menu = doc.querySelector('.sort-menu');
    menu.getBoundingClientRect = () => ({ left: 300, top: 120, width: 200, height: 260, right: 500, bottom: 380 });
    window.MusicFluid.watchPop(menu);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    menu.hidden = false; await tick();
    menu.hidden = true; await tick();
    assert.equal(anims.length, 0, 'closed before it finished opening: nothing drawn');
    menu.hidden = false; await tick();
    timers.splice(0).forEach((fn) => fn());
    doc.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, clientX: 360, clientY: 200 }));
    menu.hidden = true; await tick();
    assert.equal(anims.length, 1);
    assert.equal(anims[0].el.style.transformOrigin, '60px 80px');
    anims[0].finish(); await tick();
    assert.equal(anims[0].el.isConnected, false);
});
