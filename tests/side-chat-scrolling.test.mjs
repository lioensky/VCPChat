import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createSideChatScrolling } from '../modules/renderer/side-chat/scrolling.js';

// jsdom 没有布局：用假的 ResizeObserver 手动触发「某个元素长高了」
function setup() {
    const dom = new JSDOM('<div id="root"><div class="message-item">old</div></div>');
    const win = dom.window;
    const observers = [];
    win.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
        observe(el) { this.targets.add(el); }
        unobserve(el) { this.targets.delete(el); }
        disconnect() { this.targets.clear(); }
        fire(el) { if (this.targets.has(el)) this.cb([{ target: el }]); }
    };
    const root = win.document.getElementById('root');
    let scrollHeight = 1000;
    let hidden = false;
    Object.defineProperty(root, 'clientHeight', { get: () => hidden ? 0 : 500 });
    Object.defineProperty(root, 'scrollHeight', { get: () => hidden ? 0 : scrollHeight });
    const scrolling = createSideChatScrolling({ store: { isDisposed: false }, doc: win.document, root });
    // display:none 的容器：尺寸和 scrollTop 都读成 0
    const hide = () => { hidden = true; root.scrollTop = 0; };
    return { win, root, ro: observers[0], scrolling, grow: (px) => { scrollHeight += px; }, hide };
}

test('a reply that grows after the last pin is still followed to the bottom', async () => {
    const { win, root, ro, scrolling, grow } = setup();
    root.scrollTop = 500;
    const reply = win.document.createElement('div');
    root.appendChild(reply);
    await new Promise(r => setTimeout(r, 0)); // MutationObserver 回调
    grow(22); // 流式结束后整段重排多出来的高度
    ro.fire(reply);
    assert.equal(root.scrollTop, root.scrollHeight);
    scrolling.dispose();
    assert.equal(ro.targets.size, 0);
});

test('existing messages are observed and removed ones are released', async () => {
    const { win, root, ro, scrolling } = setup();
    const first = root.firstElementChild;
    assert.ok(ro.targets.has(first));
    first.remove();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(!ro.targets.has(first));
    scrolling.dispose();
});

test('content growth does not pull a reader who scrolled up back down', async () => {
    const { win, root, ro, scrolling, grow } = setup();
    root.scrollTop = 500;
    root.dispatchEvent(new win.Event('scroll'));
    root.scrollTop = 100;
    root.dispatchEvent(new win.Event('scroll'));
    assert.equal(scrolling.isSticky(), false);
    grow(300);
    ro.fire(root.firstElementChild);
    assert.equal(root.scrollTop, 100);
    scrolling.dispose();
});

test('a wheel tick up during streaming detaches before the next growth pins back down', () => {
    const { win, root, ro, scrolling, grow } = setup();
    root.scrollTop = 500;
    root.dispatchEvent(new win.Event('scroll'));
    root.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -40 }));
    grow(30); // 新 token 先于滚轮的 scroll 事件到达
    ro.fire(root.firstElementChild);
    assert.equal(root.scrollTop, 500);
    assert.equal(scrolling.isSticky(), false);
    scrolling.dispose();
});

test('a small scroll up within the bottom threshold still detaches; scrolling back down re-attaches', () => {
    const { win, root, scrolling } = setup();
    root.scrollTop = 500;
    root.dispatchEvent(new win.Event('scroll'));
    root.scrollTop = 470;
    root.dispatchEvent(new win.Event('scroll'));
    assert.equal(scrolling.isSticky(), false);
    root.scrollTop = 490;
    root.dispatchEvent(new win.Event('scroll'));
    assert.equal(scrolling.isSticky(), true);
    scrolling.dispose();
});

test('keyboard and touch scroll-up intents detach, but arrow keys inside the composer do not', () => {
    const { win, root, scrolling } = setup();
    const input = win.document.createElement('textarea');
    root.appendChild(input);
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(scrolling.isSticky(), true);
    root.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    assert.equal(scrolling.isSticky(), false);
    scrolling.resume();
    const touch = (type, y) => { const e = new win.Event(type); e.touches = [{ clientY: y }]; root.dispatchEvent(e); };
    touch('touchstart', 100);
    touch('touchmove', 140);
    assert.equal(scrolling.isSticky(), false);
    scrolling.dispose();
});

test('a remount after sleep keeps the reader the same distance from the bottom while older batches render above', async () => {
    const before = setup();
    before.root.scrollTop = 500;
    before.root.dispatchEvent(new before.win.Event('scroll'));
    before.root.scrollTop = 200;
    before.root.dispatchEvent(new before.win.Event('scroll'));
    const saved = before.scrolling.capture();
    assert.deepEqual(saved, { stick: false, fromBottom: 800 });
    before.scrolling.dispose();

    const after = setup();
    after.root.scrollTop = 0;
    after.scrolling.restore(saved);
    assert.equal(after.root.scrollTop, 200);
    after.grow(400); // 较早的消息分批插到上面
    after.ro.fire(after.root);
    after.root.dispatchEvent(new after.win.Event('scroll'));
    assert.equal(after.root.scrollTop, 600, 'still 800px from the bottom');
    assert.equal(after.scrolling.isSticky(), false);

    after.root.dispatchEvent(new after.win.WheelEvent('wheel', { deltaY: 40 }));
    after.root.scrollTop = 650;
    after.root.dispatchEvent(new after.win.Event('scroll'));
    after.grow(100);
    after.ro.fire(after.root);
    assert.equal(after.root.scrollTop, 650, 'once the reader scrolls, growth no longer moves them');
    after.scrolling.dispose();
});

test('a view that sleeps while hidden still keeps the distance it had when it was last shown', () => {
    const { win, root, scrolling, hide } = setup();
    root.scrollTop = 500;
    root.dispatchEvent(new win.Event('scroll'));
    root.scrollTop = 200;
    root.dispatchEvent(new win.Event('scroll'));
    hide(); // 切到别的标签；休眠要到隐藏之后才发生
    assert.deepEqual(scrolling.capture(), { stick: false, fromBottom: 800 });
    scrolling.dispose();
});

// 每条消息 100px 高、按顺序排列的列表，矩形跟着 scrollTop 走
function setupList(ids) {
    const dom = new JSDOM('<div id="root"></div>');
    const win = dom.window;
    const observers = [];
    win.ResizeObserver = class {
        constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this); }
        observe(el) { this.targets.add(el); }
        unobserve(el) { this.targets.delete(el); }
        disconnect() { this.targets.clear(); }
        fire() { this.cb([]); }
    };
    const root = win.document.getElementById('root');
    let scrollTop = 0;
    let hidden = false;
    const items = () => [...root.children];
    Object.defineProperty(root, 'clientHeight', { get: () => hidden ? 0 : 300 });
    Object.defineProperty(root, 'scrollHeight', { get: () => hidden ? 0 : items().length * 100 });
    Object.defineProperty(root, 'scrollTop', {
        get: () => hidden ? 0 : scrollTop,
        set: v => { scrollTop = Math.max(0, Math.min(v, items().length * 100 - 300)); }
    });
    root.getBoundingClientRect = () => ({ top: 0, bottom: 300 });
    const make = id => {
        const el = win.document.createElement('div');
        el.dataset.messageId = id;
        el.getBoundingClientRect = () => { const top = items().indexOf(el) * 100 - scrollTop; return { top, bottom: top + 100 }; };
        return el;
    };
    ids.forEach(id => root.appendChild(make(id)));
    const scrolling = createSideChatScrolling({ store: { isDisposed: false }, doc: win.document, root });
    return { win, root, ro: observers[0], scrolling, make, hide: () => { hidden = true; } };
}

test('a remount lands on the message the reader was looking at, and the list stays hidden until it is there', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m_${i}`);
    const before = setupList(ids);
    before.root.dispatchEvent(new before.win.WheelEvent('wheel', { deltaY: -40 }));
    before.root.scrollTop = 350;
    before.root.dispatchEvent(new before.win.Event('scroll'));
    before.hide();
    const saved = before.scrolling.capture();
    assert.deepEqual(saved, { stick: false, fromBottom: 650, anchor: { id: 'm_3', offset: -50 } });
    before.scrolling.dispose();

    // 重挂：先渲染最新两条，较早的分批插到上面
    const after = setupList(['m_8', 'm_9']);
    after.scrolling.restore(saved);
    assert.equal(after.root.style.visibility, 'hidden');
    for (const id of ['m_7', 'm_6', 'm_5', 'm_4']) after.root.prepend(after.make(id));
    after.ro.fire();
    assert.equal(after.root.style.visibility, 'hidden', 'm_3 is not mounted yet');
    for (const id of ['m_3', 'm_2', 'm_1', 'm_0']) after.root.prepend(after.make(id));
    after.ro.fire();
    assert.equal(after.root.style.visibility, '');
    assert.equal(after.root.scrollTop, 350);
    after.scrolling.dispose();
});

test('a remount whose anchor message is missing shows the list as soon as the reader scrolls', async () => {
    const after = setupList(['m_8', 'm_9']);
    after.scrolling.restore({ stick: false, fromBottom: 100, anchor: { id: 'gone', offset: 0 } });
    assert.equal(after.root.style.visibility, 'hidden');
    after.root.dispatchEvent(new after.win.WheelEvent('wheel', { deltaY: 40 }));
    assert.equal(after.root.style.visibility, '', 'scrolling shows the list at once');
    after.scrolling.dispose();
});

test('a view that was following the bottom comes back following it', () => {
    const { scrolling } = setup();
    assert.deepEqual(scrolling.capture(), { stick: true });
    scrolling.dispose();
});

test('a view put to sleep while hidden saves where the reader was, not the zeros a display:none box reports', () => {
    const { win, root, scrolling, hide } = setup();
    root.scrollTop = 500;
    root.dispatchEvent(new win.Event('scroll'));
    root.scrollTop = 300;
    root.dispatchEvent(new win.Event('scroll'));
    hide();
    assert.deepEqual(scrolling.capture(), { stick: false, fromBottom: 700 });
    scrolling.dispose();
});

test('a remounted view that sleeps again before the reader scrolls keeps the restored place', () => {
    const { scrolling, hide } = setup();
    scrolling.restore({ stick: false, fromBottom: 700 });
    hide();
    assert.deepEqual(scrolling.capture(), { stick: false, fromBottom: 700 });
    scrolling.dispose();
});
