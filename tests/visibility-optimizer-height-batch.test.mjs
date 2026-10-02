import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createVisibilityOptimizer } from '../modules/renderer/visibilityOptimizer.js';

// 长话题一次登记几十条消息：测量（读 offsetHeight）和固化（写 containIntrinsicSize）必须分成两批，
// 交替进行会让浏览器每条消息都同步重排一次。

function setup(count) {
    const items = Array.from({ length: count }, (_, i) => `<article class="message-item" data-message-id="m${i}"><div class="md-content"></div></article>`).join('');
    const dom = new JSDOM(`<main id="root">${items}</main>`);
    const previous = { window: globalThis.window, Element: globalThis.Element, IntersectionObserver: globalThis.IntersectionObserver, MutationObserver: globalThis.MutationObserver, requestAnimationFrame: globalThis.requestAnimationFrame };
    const frames = [];
    class FakeIntersectionObserver { observe() {} unobserve() {} disconnect() {} }
    globalThis.window = dom.window;
    globalThis.Element = dom.window.Element;
    globalThis.IntersectionObserver = FakeIntersectionObserver;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
    dom.window.Element.prototype.animate = () => ({ playState: 'running', pause() {}, play() {} });
    const log = [];
    for (const item of dom.window.document.querySelectorAll('.message-item')) {
        Object.defineProperty(item, 'offsetHeight', { configurable: true, get() { log.push(['read', item.dataset.messageId]); return 120; } });
        let intrinsic = '';
        Object.defineProperty(item.style, 'containIntrinsicSize', {
            get: () => intrinsic,
            set(value) { log.push(['write', item.dataset.messageId]); intrinsic = value; },
        });
    }
    const restore = () => {
        globalThis.window = previous.window;
        globalThis.Element = previous.Element;
        globalThis.IntersectionObserver = previous.IntersectionObserver;
        globalThis.MutationObserver = previous.MutationObserver;
        globalThis.requestAnimationFrame = previous.requestAnimationFrame;
        dom.window.close();
    };
    return { dom, frames, log, restore };
}

test('registering many messages measures them all before freezing any height', () => {
    const { dom, frames, log, restore } = setup(30);
    try {
        const root = dom.window.document.getElementById('root');
        const owner = createVisibilityOptimizer();
        owner.initializeVisibilityOptimizer(root);
        for (const item of root.querySelectorAll('.message-item')) owner.observeMessage(item);
        assert.equal(log.length, 0, 'registration itself must not force layout');
        assert.equal(frames.length, 1, 'one frame serves every registered message');

        frames.shift()();
        assert.equal(log.length, 60);
        assert.deepEqual(log.slice(0, 30).map(([kind]) => kind), Array(30).fill('read'));
        assert.deepEqual(log.slice(30).map(([kind]) => kind), Array(30).fill('write'));
        const first = root.querySelector('.message-item');
        assert.equal(first.style.containIntrinsicSize, 'auto 120px');
        assert.equal(first.dataset.vcpMeasuredHeight, '120');
        owner.destroyVisibilityOptimizer();
    } finally {
        restore();
    }
});

test('a message removed before the frame is skipped, and a zero height is not frozen', () => {
    const { dom, frames, log, restore } = setup(3);
    try {
        const root = dom.window.document.getElementById('root');
        const [gone, hidden, shown] = root.querySelectorAll('.message-item');
        Object.defineProperty(hidden, 'offsetHeight', { get() { log.push(['read', 'hidden']); return 0; } });
        const owner = createVisibilityOptimizer();
        owner.initializeVisibilityOptimizer(root);
        for (const item of [gone, hidden, shown]) owner.observeMessage(item);
        gone.remove();

        frames.shift()();
        assert.equal(log.some(([, id]) => id === 'm0'), false, 'detached message must not be measured');
        assert.equal(hidden.style.containIntrinsicSize, '', 'display:none content has no height worth freezing');
        assert.equal(shown.style.containIntrinsicSize, 'auto 120px');
        owner.destroyVisibilityOptimizer();
    } finally {
        restore();
    }
});
