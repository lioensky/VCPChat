'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/ui-helpers.js', 'utf8');

function createFixture() {
    const dom = new JSDOM(
        '<!doctype html><html><body><div class="chat-messages-container"><div id="chatMessages"></div></div></body></html>',
        { runScripts: 'outside-only', url: 'https://vcpchat.local/' }
    );
    const { window } = dom;
    const container = window.document.querySelector('.chat-messages-container');

    let scrollHeight = 1000;
    let clientHeight = 400;
    let scrollTop = 600;
    let nextFrameId = 1;
    const animationFrames = new Map();
    const resizeObservers = [];

    Object.defineProperties(container, {
        scrollHeight: {
            configurable: true,
            get: () => scrollHeight,
        },
        clientHeight: {
            configurable: true,
            get: () => clientHeight,
        },
        scrollTop: {
            configurable: true,
            get: () => scrollTop,
            set: value => {
                scrollTop = Number(value);
            },
        },
        offsetWidth: {
            configurable: true,
            get: () => 500,
        },
        clientWidth: {
            configurable: true,
            get: () => 485,
        },
    });
    container.getBoundingClientRect = () => ({
        left: 0,
        right: 500,
        top: 0,
        bottom: 400,
        width: 500,
        height: 400,
    });

    window.requestAnimationFrame = callback => {
        const id = nextFrameId++;
        animationFrames.set(id, callback);
        return id;
    };
    window.cancelAnimationFrame = id => {
        animationFrames.delete(id);
    };

    window.ResizeObserver = class ResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            resizeObservers.push(this);
        }

        observe(target) {
            this.targets.push(target);
        }

        disconnect() {
            this.targets = [];
        }

        trigger() {
            this.callback(this.targets.map(target => ({ target })), this);
        }
    };

    window.eval(source);

    const flushAnimationFrames = () => {
        let guard = 0;
        while (animationFrames.size > 0) {
            if (++guard > 20) throw new Error('animation frame queue did not settle');
            const current = [...animationFrames.entries()];
            animationFrames.clear();
            current.forEach(([, callback]) => callback(window.performance.now()));
        }
    };

    const triggerResize = () => {
        assert.equal(resizeObservers.length, 1, 'chat state must own exactly one resize observer');
        resizeObservers[0].trigger();
    };

    return {
        dom,
        window,
        container,
        uiHelper: window.uiHelperFunctions,
        flushAnimationFrames,
        triggerResize,
        setGeometry(next) {
            if (next.scrollHeight !== undefined) scrollHeight = next.scrollHeight;
            if (next.clientHeight !== undefined) clientHeight = next.clientHeight;
            if (next.scrollTop !== undefined) scrollTop = next.scrollTop;
        },
        geometry: () => ({ scrollHeight, clientHeight, scrollTop }),
    };
}

test('async content growth keeps following the bottom without treating layout as user intent', () => {
    const fixture = createFixture();

    const initial = fixture.uiHelper.captureChatScrollFollow();
    assert.equal(initial.followBottom, true);

    fixture.setGeometry({ scrollHeight: 1500 });
    fixture.container.dispatchEvent(new fixture.window.Event('scroll'));
    assert.equal(
        fixture.uiHelper.captureChatScrollFollow().followBottom,
        true,
        'layout-driven distance from bottom must not revoke follow intent'
    );

    fixture.triggerResize();
    fixture.flushAnimationFrames();

    assert.equal(fixture.geometry().scrollTop, 1100);
    assert.equal(fixture.uiHelper.isNearChatBottom(), true);
    fixture.dom.window.close();
});

test('an upward wheel gesture revokes bottom follow and blocks later async growth compensation', () => {
    const fixture = createFixture();
    fixture.uiHelper.captureChatScrollFollow();

    fixture.setGeometry({ scrollTop: 350 });
    fixture.container.dispatchEvent(new fixture.window.WheelEvent('wheel', { deltaY: -120 }));

    const interrupted = fixture.uiHelper.captureChatScrollFollow();
    assert.equal(interrupted.followBottom, false);

    fixture.setGeometry({ scrollHeight: 1600 });
    fixture.triggerResize();
    fixture.flushAnimationFrames();

    assert.equal(
        fixture.geometry().scrollTop,
        350,
        'content growth must not pull a user who is reading older messages back to the bottom'
    );
    fixture.dom.window.close();
});

test('a small upward wheel step inside the bottom threshold cannot be relocked by its scroll event', () => {
    const fixture = createFixture();
    fixture.uiHelper.captureChatScrollFollow();

    // 用户从精确底部向上滚动很小一步，仍落在 50px 的“接近底部”阈值内。
    fixture.container.dispatchEvent(new fixture.window.WheelEvent('wheel', { deltaY: -10 }));
    fixture.setGeometry({ scrollTop: 590 });
    fixture.container.dispatchEvent(new fixture.window.Event('scroll'));

    assert.equal(
        fixture.uiHelper.captureChatScrollFollow().followBottom,
        false,
        'the wheel unlock intent must win over near-bottom geometry'
    );

    // 即使这一刻流式文本或图片继续增高，也不能取消刚刚发生的用户上滚。
    fixture.setGeometry({ scrollHeight: 1400 });
    fixture.triggerResize();
    fixture.flushAnimationFrames();

    assert.equal(fixture.geometry().scrollTop, 590);
    assert.equal(fixture.uiHelper.captureChatScrollFollow().followBottom, false);
    fixture.dom.window.close();
});

test('returning to the bottom re-enables continuous follow for subsequent async growth', () => {
    const fixture = createFixture();
    fixture.uiHelper.captureChatScrollFollow();

    fixture.setGeometry({ scrollTop: 300 });
    fixture.container.dispatchEvent(new fixture.window.WheelEvent('wheel', { deltaY: -100 }));
    assert.equal(fixture.uiHelper.captureChatScrollFollow().followBottom, false);

    fixture.setGeometry({ scrollTop: 600 });
    fixture.container.dispatchEvent(new fixture.window.WheelEvent('wheel', { deltaY: 100 }));
    fixture.flushAnimationFrames();
    assert.equal(fixture.uiHelper.captureChatScrollFollow().followBottom, true);

    fixture.setGeometry({ scrollHeight: 1400 });
    fixture.triggerResize();
    fixture.flushAnimationFrames();

    assert.equal(fixture.geometry().scrollTop, 1000);
    assert.equal(fixture.uiHelper.isNearChatBottom(), true);
    fixture.dom.window.close();
});

test('a stale resize compensation cannot override a newer user scroll generation', () => {
    const fixture = createFixture();
    fixture.uiHelper.captureChatScrollFollow();

    fixture.setGeometry({ scrollHeight: 1400 });
    fixture.triggerResize();

    fixture.setGeometry({ scrollTop: 400 });
    fixture.container.dispatchEvent(new fixture.window.WheelEvent('wheel', { deltaY: -100 }));
    fixture.flushAnimationFrames();

    assert.equal(fixture.geometry().scrollTop, 400);
    assert.equal(fixture.uiHelper.captureChatScrollFollow().followBottom, false);
    fixture.dom.window.close();
});