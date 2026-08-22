import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createVisibilityOptimizer } from '../modules/renderer/visibilityOptimizer.js';

test('visibility owners share only the realm interceptor and dispose independently', () => {
    const dom = new JSDOM('<main><section id="a"><article class="message-item"><span></span></article></section><section id="b"><article class="message-item"><span></span></article></section></main>');
    const previous = { window: globalThis.window, Element: globalThis.Element, IntersectionObserver: globalThis.IntersectionObserver, MutationObserver: globalThis.MutationObserver, requestAnimationFrame: globalThis.requestAnimationFrame };
    const observed = new Set();
    class FakeIntersectionObserver {
        observe(value) { observed.add(value); }
        unobserve(value) { observed.delete(value); }
        disconnect() {}
    }
    globalThis.window = dom.window;
    globalThis.Element = dom.window.Element;
    globalThis.IntersectionObserver = FakeIntersectionObserver;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    const nativeAnimate = () => ({ playState: 'running', pauseCalls: 0, pause() { this.pauseCalls += 1; }, play() {} });
    dom.window.Element.prototype.animate = nativeAnimate;
    try {
        const rootA = dom.window.document.getElementById('a');
        const rootB = dom.window.document.getElementById('b');
        const messageA = rootA.querySelector('.message-item');
        const messageB = rootB.querySelector('.message-item');
        const ownerA = createVisibilityOptimizer();
        const ownerB = createVisibilityOptimizer();
        ownerA.initializeVisibilityOptimizer(rootA);
        ownerB.initializeVisibilityOptimizer(rootB);
        const animationA = messageA.querySelector('span').animate([], {});
        const animationB = messageB.querySelector('span').animate([], {});
        ownerA.pauseMessageAnimations(messageA);
        ownerB.pauseMessageAnimations(messageB);
        assert.equal(animationA.pauseCalls, 1);
        assert.equal(animationB.pauseCalls, 1);

        ownerA.destroyVisibilityOptimizer();
        assert.notEqual(dom.window.Element.prototype.animate, nativeAnimate, 'disposing A must not remove B realm interceptor');
        const laterB = messageB.querySelector('span').animate([], {});
        ownerB.pauseMessageAnimations(messageB);
        assert.equal(laterB.pauseCalls, 1, 'disposing A must retain B interceptor ownership');
        ownerB.destroyVisibilityOptimizer();
        assert.equal(dom.window.Element.prototype.animate, nativeAnimate, 'last owner must restore native realm method');
        assert.equal(observed.size, 0);
    } finally {
        globalThis.window = previous.window;
        globalThis.Element = previous.Element;
        globalThis.IntersectionObserver = previous.IntersectionObserver;
        globalThis.MutationObserver = previous.MutationObserver;
        globalThis.requestAnimationFrame = previous.requestAnimationFrame;
        dom.window.close();
    }
});

test('dispose cancels the owned delayed scan before it can touch detached content', () => {
    const dom = new JSDOM('<main id="root"><article class="message-item"><div class="md-content"></div></article></main>');
    const previous = { window: globalThis.window, Element: globalThis.Element, IntersectionObserver: globalThis.IntersectionObserver, MutationObserver: globalThis.MutationObserver, requestAnimationFrame: globalThis.requestAnimationFrame };
    const pendingTimers = new Map();
    let nextTimerId = 1;
    class FakeIntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    const originalSetTimeout = dom.window.setTimeout.bind(dom.window);
    const originalClearTimeout = dom.window.clearTimeout.bind(dom.window);
    dom.window.setTimeout = callback => {
        const id = nextTimerId++;
        pendingTimers.set(id, callback);
        return id;
    };
    dom.window.clearTimeout = id => pendingTimers.delete(id);
    globalThis.window = dom.window;
    globalThis.Element = dom.window.Element;
    globalThis.IntersectionObserver = FakeIntersectionObserver;
    globalThis.MutationObserver = dom.window.MutationObserver;
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    dom.window.Element.prototype.animate = () => ({ playState: 'running', pause() {}, play() {} });
    try {
        const root = dom.window.document.getElementById('root');
        const message = root.querySelector('.message-item');
        let scans = 0;
        message.getAnimations = () => { scans += 1; return []; };
        const owner = createVisibilityOptimizer();
        owner.initializeVisibilityOptimizer(root);
        assert.equal(pendingTimers.size, 1);
        owner.destroyVisibilityOptimizer();
        assert.equal(pendingTimers.size, 0, 'dispose must cancel the Surface-owned delayed scan');
        for (const callback of pendingTimers.values()) callback();
        assert.equal(scans, 0);
    } finally {
        dom.window.setTimeout = originalSetTimeout;
        dom.window.clearTimeout = originalClearTimeout;
        globalThis.window = previous.window;
        globalThis.Element = previous.Element;
        globalThis.IntersectionObserver = previous.IntersectionObserver;
        globalThis.MutationObserver = previous.MutationObserver;
        globalThis.requestAnimationFrame = previous.requestAnimationFrame;
        dom.window.close();
    }
});
