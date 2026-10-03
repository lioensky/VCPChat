import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bindChatNavigationIdle } from '../modules/ui-system/chat-navigation-idle.js';
import { createChatBackToBottom } from '../modules/ui-system/chat-back-to-bottom.js';
import { createConversationTurnNavigator } from '../modules/ui-system/conversation-turn-navigator.js';

function fixture() {
    const dom = new JSDOM(`<main>
        <div class="chat-messages-container"><div id="chatMessages">
            <div class="message-item user"><div class="md-content">一</div></div>
            <div class="message-item user"><div class="md-content">二</div></div>
        </div></div>
        <div class="chat-input-area"></div>
    </main>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const scroller = doc.querySelector('.chat-messages-container');
    Object.defineProperty(scroller, 'clientWidth', { value: 900 });
    const timers = new Map();
    let now = 0;
    let id = 0;
    dom.window.setTimeout = (callback, delay) => {
        timers.set(++id, { callback, at: now + delay });
        return id;
    };
    dom.window.clearTimeout = (key) => timers.delete(key);
    const tick = (ms) => {
        now += ms;
        for (const [key, timer] of [...timers]) {
            if (timer.at <= now) {
                timers.delete(key);
                timer.callback();
            }
        }
    };
    const fire = (target, type) => target.dispatchEvent(new dom.window.Event(type));
    return { dom, doc, scroller, tick, fire, timers };
}

test('both chat navigation controls fade 1.2 seconds after the last scroll', () => {
    const { dom, doc, scroller, tick, fire } = fixture();
    const bottom = createChatBackToBottom({
        document: doc,
        uiHelper: { captureChatScrollFollow: () => ({ followBottom: false }) }
    });
    const navigator = createConversationTurnNavigator({ document: doc });
    const elements = [bottom.mount(), navigator.mount()];
    const idle = () => elements.map(element => element.classList.contains('is-idle'));
    tick(1199);
    assert.deepEqual(idle(), [false, false]);
    fire(scroller, 'scroll');
    tick(1199);
    assert.deepEqual(idle(), [false, false]);
    tick(1);
    assert.deepEqual(idle(), [true, true]);
    fire(scroller, 'scroll');
    assert.deepEqual(idle(), [false, false]);
    bottom.dispose();
    navigator.dispose();
    dom.window.close();
});

test('hover and keyboard focus activate navigation and prevent fading until leaving', () => {
    const { dom, doc, scroller, tick, fire, timers } = fixture();
    const element = doc.createElement('button');
    doc.body.appendChild(element);
    const control = bindChatNavigationIdle({ element, scroller });
    tick(1200);
    assert.equal(element.classList.contains('is-idle'), true);
    fire(element, 'pointerenter');
    tick(5000);
    assert.equal(element.classList.contains('is-idle'), false);
    fire(element, 'pointerleave');
    tick(1199);
    assert.equal(element.classList.contains('is-idle'), false);
    tick(1);
    assert.equal(element.classList.contains('is-idle'), true);
    element.focus();
    tick(5000);
    assert.equal(element.classList.contains('is-idle'), false);
    element.blur();
    tick(1200);
    assert.equal(element.classList.contains('is-idle'), true);

    element.hidden = true;
    control.refresh();
    assert.equal(timers.size, 0);
    element.hidden = false;
    control.refresh();
    tick(1199);
    assert.equal(element.classList.contains('is-idle'), false);
    control.refresh();
    tick(1);
    assert.equal(element.classList.contains('is-idle'), true, 'ordinary refresh does not postpone fading');

    fire(scroller, 'scroll');
    control.dispose();
    assert.equal(timers.size, 0);
    tick(3000);
    fire(scroller, 'scroll');
    assert.equal(timers.size, 0, 'dispose removes scroll listeners');
    assert.equal(element.classList.contains('is-idle'), false);
    dom.window.close();
});