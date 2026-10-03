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

function ownedFixture() {
    const dom = new JSDOM('<main id="a"><article class="message-item" data-message-id="m"><div class="md-content"></div></article></main><main id="b"></main>');
    const keys = ['window', 'Element', 'IntersectionObserver', 'MutationObserver', 'requestAnimationFrame'];
    const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
    const frames = [];
    const pendingFrames = new Map();
    class Observer { observe() {} unobserve() {} disconnect() {} }
    globalThis.window = dom.window;
    globalThis.Element = dom.window.Element;
    globalThis.IntersectionObserver = Observer;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.requestAnimationFrame = callback => {
        frames.push(callback);
        pendingFrames.set(frames.length, callback);
        return frames.length;
    };
    dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
    const cancelFrame = id => { pendingFrames.delete(id); frames[id - 1] = null; };
    dom.window.cancelAnimationFrame = cancelFrame;
    const writes = [];
    dom.window.pretextBridge = { rememberHeight(id, height) { writes.push([id, height]); } };
    const item = dom.window.document.querySelector('article');
    let reads = 0;
    Object.defineProperty(item, 'offsetHeight', { configurable: true, get() { reads++; return 120; } });
    const a = dom.window.document.getElementById('a');
    const b = dom.window.document.getElementById('b');
    const owner = createVisibilityOptimizer();
    owner.initializeVisibilityOptimizer(a);
    const flush = () => {
        const pending = [...pendingFrames];
        for (const [id, callback] of pending) {
            if (!pendingFrames.has(id)) continue;
            cancelFrame(id);
            callback();
        }
    };
    const reset = () => { reads = 0; writes.length = 0; };
    return {
        owner, item, a, b, frames, flush, reset, writes, dom, cancelFrame,
        get reads() { return reads; },
        close() {
            owner.destroyVisibilityOptimizer();
            for (const key of keys) globalThis[key] = saved[key];
            dom.window.close();
        }
    };
}

test('height queue: relinquished connected message receives no deferred height writes', () => {
    const fixture = ownedFixture();
    try {
        fixture.owner.unobserveMessage(fixture.item);
        fixture.reset(); fixture.flush();
        assert.equal(fixture.reads, 0);
        assert.deepEqual(fixture.writes, []);
    } finally { fixture.close(); }
});

test('height queue: destroyed owner cannot measure retained DOM on its queued frame', () => {
    const fixture = ownedFixture();
    try {
        fixture.owner.destroyVisibilityOptimizer();
        fixture.reset(); fixture.flush();
        assert.equal(fixture.reads, 0);
        assert.deepEqual(fixture.writes, []);
    } finally { fixture.close(); }
});

test('height queue: replacing the observed root drops the previous height queue', () => {
    const fixture = ownedFixture();
    try {
        fixture.owner.initializeVisibilityOptimizer(fixture.b);
        fixture.reset(); fixture.flush();
        assert.equal(fixture.reads, 0);
        assert.deepEqual(fixture.writes, []);
    } finally { fixture.close(); }
});

test('height queue: frame from former owner cannot rewrite a transferred message', () => {
    const fixture = ownedFixture();
    const next = createVisibilityOptimizer();
    try {
        fixture.owner.unobserveMessage(fixture.item);
        fixture.b.appendChild(fixture.item);
        next.initializeVisibilityOptimizer(fixture.b);
        fixture.reset(); fixture.flush();
        assert.equal(fixture.writes.length, 1);
    } finally { next.destroyVisibilityOptimizer(); fixture.close(); }
});

test('height queue: destroy cancels its frame and reinitialization schedules independent work', () => {
    const fixture = ownedFixture();
    try {
        const formerFrame = fixture.frames[0];
        fixture.owner.destroyVisibilityOptimizer();
        assert.equal(fixture.frames.filter(Boolean).length, 0, 'destroy must cancel the owned frame');
        fixture.owner.initializeVisibilityOptimizer(fixture.a);
        assert.equal(fixture.frames.filter(Boolean).length, 1, 'new work needs a new frame');
        fixture.reset();
        formerFrame();
        assert.equal(fixture.reads, 0, 'late callback from the disposed generation must be inert');
        fixture.flush();
        assert.equal(fixture.reads, 1);
        assert.deepEqual(fixture.writes, [['m', 120]]);
    } finally { fixture.close(); }
});

test('height queue: root replacement cancels the old frame before scheduling the new root', () => {
    const fixture = ownedFixture();
    try {
        const formerFrame = fixture.frames[0];
        fixture.b.appendChild(fixture.item);
        fixture.owner.initializeVisibilityOptimizer(fixture.b);
        assert.equal(fixture.frames[0], null, 'the old root must release its frame');
        assert.equal(fixture.frames.filter(Boolean).length, 1);
        fixture.reset();
        formerFrame();
        assert.equal(fixture.reads, 0);
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120]]);
    } finally { fixture.close(); }
});

test('height queue: a bridge callback that relinquishes a measured message prevents its later write', () => {
    const fixture = ownedFixture();
    try {
        const second = fixture.item.cloneNode(true);
        second.dataset.messageId = 'second';
        Object.defineProperty(second, 'offsetHeight', { get: () => 240 });
        fixture.a.appendChild(second);
        fixture.owner.observeMessage(second);
        fixture.dom.window.pretextBridge.rememberHeight = (id, height) => {
            fixture.writes.push([id, height]);
            if (id === 'm') fixture.owner.unobserveMessage(second);
        };
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120]]);
        assert.equal(second.dataset.vcpMeasuredHeight, undefined);
    } finally { fixture.close(); }
});

test('height queue: resetting the owner during bridge writes discards the rest of the old batch', () => {
    const fixture = ownedFixture();
    try {
        const second = fixture.item.cloneNode(true);
        second.dataset.messageId = 'second';
        let height = 240;
        Object.defineProperty(second, 'offsetHeight', { get: () => height });
        fixture.a.appendChild(second);
        fixture.owner.observeMessage(second);
        fixture.dom.window.pretextBridge.rememberHeight = (id, measuredHeight) => {
            fixture.writes.push([id, measuredHeight]);
            if (id === 'm' && fixture.writes.length === 1) {
                fixture.owner.destroyVisibilityOptimizer();
                height = 360;
                fixture.owner.initializeVisibilityOptimizer(fixture.a);
            }
        };
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120]], 'old measurements must not leak into the new generation');
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120], ['m', 120], ['second', 360]]);
    } finally { fixture.close(); }
});

test('height queue: messages registered during bridge writes run in the next batch', () => {
    const fixture = ownedFixture();
    try {
        const second = fixture.item.cloneNode(true);
        second.dataset.messageId = 'second';
        Object.defineProperty(second, 'offsetHeight', { get: () => 240 });
        fixture.dom.window.pretextBridge.rememberHeight = (id, height) => {
            fixture.writes.push([id, height]);
            if (id === 'm') {
                fixture.a.appendChild(second);
                fixture.owner.observeMessage(second);
            }
        };
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120]]);
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120], ['second', 240]]);
    } finally { fixture.close(); }
});

test('height queue: a height read failure does not prevent measuring another message', () => {
    const fixture = ownedFixture();
    try {
        const broken = fixture.item.cloneNode(true);
        Object.defineProperty(broken, 'offsetHeight', { get() { throw Error('unavailable layout'); } });
        fixture.a.prepend(broken);
        fixture.owner.unobserveMessage(fixture.item);
        fixture.owner.observeMessage(broken);
        fixture.owner.observeMessage(fixture.item);
        fixture.flush();
        assert.equal(broken.dataset.vcpMeasuredHeight, undefined);
        assert.deepEqual(fixture.writes, [['m', 120]]);
    } finally { fixture.close(); }
});

test('height queue: global animation frame fallback is cancelled on destroy', () => {
    const fixture = ownedFixture();
    const savedCancel = globalThis.cancelAnimationFrame;
    try {
        fixture.owner.destroyVisibilityOptimizer();
        fixture.dom.window.requestAnimationFrame = undefined;
        globalThis.cancelAnimationFrame = fixture.cancelFrame;
        fixture.owner.initializeVisibilityOptimizer(fixture.a);
        assert.equal(fixture.frames.filter(Boolean).length, 1);
        fixture.owner.destroyVisibilityOptimizer();
        assert.equal(fixture.frames.filter(Boolean).length, 0);
    } finally { fixture.close(); globalThis.cancelAnimationFrame = savedCancel; }
});

test('height queue: timeout fallback is cancelled and stale callbacks cannot drain new work', () => {
    const fixture = ownedFixture();
    const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const timers = new Map();
    let timerId = 0;
    try {
        fixture.owner.destroyVisibilityOptimizer();
        fixture.dom.window.requestAnimationFrame = undefined;
        globalThis.requestAnimationFrame = undefined;
        globalThis.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
        globalThis.clearTimeout = id => timers.delete(id);
        fixture.owner.initializeVisibilityOptimizer(fixture.a);
        const frameTimer = [...timers.values()].find(timer => timer.delay === 16);
        assert.ok(frameTimer);
        fixture.owner.destroyVisibilityOptimizer();
        assert.equal([...timers.values()].some(timer => timer.delay === 16), false);
        fixture.owner.initializeVisibilityOptimizer(fixture.a);
        fixture.reset();
        frameTimer.callback();
        assert.equal(fixture.reads, 0);
        [...timers.values()].find(timer => timer.delay === 16).callback();
        assert.deepEqual(fixture.writes, [['m', 120]]);
    } finally {
        fixture.close();
        globalThis.setTimeout = saved.setTimeout;
        globalThis.clearTimeout = saved.clearTimeout;
    }
});

test('height queue: work registered during measurement remains in the next batch', () => {
    const fixture = ownedFixture();
    try {
        const second = fixture.item.cloneNode(true);
        second.dataset.messageId = 'second';
        Object.defineProperty(second, 'offsetHeight', { get: () => 240 });
        let registered = false;
        Object.defineProperty(fixture.item, 'offsetHeight', { get() {
            if (!registered) {
                registered = true;
                fixture.a.appendChild(second);
                fixture.owner.observeMessage(second);
            }
            return 120;
        } });
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120]]);
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120], ['second', 240]]);
    } finally { fixture.close(); }
});

test('height queue: resetting during measurement cannot erase the new root queue', () => {
    const fixture = ownedFixture();
    try {
        const second = fixture.item.cloneNode(true);
        second.dataset.messageId = 'second';
        Object.defineProperty(second, 'offsetHeight', { get: () => 240 });
        fixture.b.appendChild(second);
        Object.defineProperty(fixture.item, 'offsetHeight', { get() {
            fixture.owner.initializeVisibilityOptimizer(fixture.b);
            return 120;
        } });
        fixture.flush();
        assert.deepEqual(fixture.writes, []);
        fixture.flush();
        assert.deepEqual(fixture.writes, [['second', 240]]);
    } finally { fixture.close(); }
});

test('height queue: re-observing a measured message invalidates its old registration', () => {
    const fixture = ownedFixture();
    try {
        const second = fixture.item.cloneNode(true);
        second.dataset.messageId = 'second';
        let height = 240;
        Object.defineProperty(second, 'offsetHeight', { get: () => height });
        fixture.a.appendChild(second);
        fixture.owner.observeMessage(second);
        fixture.dom.window.pretextBridge.rememberHeight = (id, measuredHeight) => {
            fixture.writes.push([id, measuredHeight]);
            if (id === 'm') {
                fixture.owner.unobserveMessage(second);
                height = 360;
                fixture.owner.observeMessage(second);
            }
        };
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120]]);
        fixture.flush();
        assert.deepEqual(fixture.writes, [['m', 120], ['second', 360]]);
    } finally { fixture.close(); }
});
