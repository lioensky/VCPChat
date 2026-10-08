import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatBackToBottom } from '../modules/ui-system/chat-back-to-bottom.js';

const EVENT = 'vcp-chat-follow-change';
const flushMutations = () => new Promise(resolve => setTimeout(resolve, 0));

function makeChat({ following = true, messageCount = 1 } = {}) {
    const dom = new JSDOM(`<!doctype html><body>
        <div class="chat-messages-container"><div id="chatMessages"></div></div>
        <div class="chat-input-area vcp-ui-scope"><div class="chat-input-card"></div></div>
    </body>`);
    const doc = dom.window.document;
    const scroller = doc.querySelector('.chat-messages-container');
    const messages = doc.getElementById('chatMessages');
    const addMessage = () => {
        const item = doc.createElement('div');
        item.className = 'message-item';
        messages.appendChild(item);
    };
    for (let i = 0; i < messageCount; i += 1) addMessage();
    const calls = [];
    const uiHelper = {
        CHAT_FOLLOW_CHANGE_EVENT: EVENT,
        captureChatScrollFollow: () => ({ followBottom: following }),
        resetChatScrollFollow: () => calls.push('reset'),
        scrollToBottom: (options) => calls.push(['scrollToBottom', options])
    };
    const announce = (followBottom) => scroller.dispatchEvent(new dom.window.CustomEvent(EVENT, { detail: { followBottom } }));
    return { dom, doc, scroller, messages, addMessage, uiHelper, calls, announce };
}

test('mounts above the composer and stays hidden while following', () => {
    const { dom, doc, uiHelper } = makeChat();
    const control = createChatBackToBottom({ document: doc, uiHelper });
    const button = control.mount();
    assert.equal(button.parentElement, doc.querySelector('.chat-input-area'));
    assert.equal(button.parentElement.firstElementChild, button);
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), '回到底部');
    assert.equal(button.hidden, true);
    control.dispose();
    dom.window.close();
});

test('shows when follow is released and hides again when it comes back', () => {
    const { dom, doc, uiHelper, announce } = makeChat();
    const control = createChatBackToBottom({ document: doc, uiHelper });
    const button = control.mount();
    announce(false);
    assert.equal(button.hidden, false);
    announce(true);
    assert.equal(button.hidden, true);
    control.dispose();
    dom.window.close();
});

test('starts visible when mounted away from the bottom, but never on an empty chat', async () => {
    const { dom, doc, messages, addMessage, uiHelper } = makeChat({ following: false, messageCount: 0 });
    const control = createChatBackToBottom({ document: doc, uiHelper });
    const button = control.mount();
    assert.equal(button.hidden, true, 'nothing to go back to');
    addMessage();
    await flushMutations();
    assert.equal(button.hidden, false);
    messages.replaceChildren();
    await flushMutations();
    assert.equal(button.hidden, true);
    control.dispose();
    dom.window.close();
});

test('click re-enables follow and forces a scroll to the bottom', () => {
    const { dom, doc, uiHelper, calls, announce } = makeChat();
    const control = createChatBackToBottom({ document: doc, uiHelper });
    const button = control.mount();
    announce(false);
    button.click();
    assert.deepEqual(calls, ['reset', ['scrollToBottom', { force: true }]]);
    control.dispose();
    dom.window.close();
});

test('dispose removes the button and stops listening', () => {
    const { dom, doc, scroller, uiHelper, announce } = makeChat();
    const control = createChatBackToBottom({ document: doc, uiHelper, scroller });
    control.mount();
    control.dispose();
    assert.equal(doc.querySelector('.vcp-back-to-bottom'), null);
    assert.equal(control.element, null);
    announce(false); // 不应抛错
    dom.window.close();
});

test('does nothing without the chat shell', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const control = createChatBackToBottom({ document: dom.window.document, uiHelper: {} });
    assert.equal(control.mount(), null);
    control.dispose();
    dom.window.close();
});
