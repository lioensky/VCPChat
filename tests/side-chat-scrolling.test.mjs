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
    Object.defineProperty(root, 'clientHeight', { get: () => 500 });
    Object.defineProperty(root, 'scrollHeight', { get: () => scrollHeight });
    const scrolling = createSideChatScrolling({ store: { isDisposed: false }, doc: win.document, root });
    return { win, root, ro: observers[0], scrolling, grow: (px) => { scrollHeight += px; } };
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
