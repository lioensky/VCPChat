import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSideChatMessageActions } from '../modules/renderer/side-chat/message-actions.js';

// Side chat messages could only be edited, copied, regenerated or deleted
// through a right-click menu, and neither the messages nor the menu items
// could take focus. The list now works like the topic list: one tab stop,
// arrow keys between messages, Shift+F10 for the menu, Escape back.

function mount() {
    const dom = new JSDOM('<!doctype html><body><div class="side-chat-messages-container" tabindex="-1"></div><textarea></textarea></body>');
    const doc = dom.window.document;
    const root = doc.querySelector('.side-chat-messages-container');
    const history = [
        { id: 'q1', role: 'user', content: 'first question' },
        { id: 'a1', role: 'assistant', content: 'first answer' },
        { id: 'q2', role: 'user', content: 'second question' }
    ];
    for (const message of history) {
        const item = doc.createElement('div');
        item.className = `message-item ${message.role}`;
        item.dataset.messageId = message.id;
        const content = doc.createElement('div');
        content.className = 'md-content';
        content.textContent = message.content;
        item.append(content);
        root.append(item);
    }
    const edits = [];
    const owner = createSideChatMessageActions({
        store: { isDisposed: false },
        chatCapabilities: { uiHelper: { showToastNotification() {} } },
        descriptor: { parent: {}, child: {} },
        doc,
        root,
        textarea: doc.querySelector('textarea'),
        getHistory: () => history,
        saveHistory: async () => ({ success: true }),
        removeMessage: async () => {},
        isBusy: () => false,
        editMessage: (_item, message) => edits.push(message.id),
        regenerate: () => {},
        updateEmptyState() {},
        pinToBottomIfSticky() {}
    });
    const items = () => [...root.querySelectorAll('.message-item')];
    const key = (target, name, init = {}) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
    const keyboardMenu = target => target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    return { dom, doc, root, owner, items, key, keyboardMenu, edits };
}

test('side chat messages are one tab stop with arrow, Home and End navigation', () => {
    const { dom, doc, owner, items, key } = mount();
    try {
        const stops = () => items().filter(item => item.tabIndex === 0).map(item => item.dataset.messageId);
        assert.deepEqual(stops(), ['q2'], 'the newest message is the tab stop');
        items()[2].focus();
        key(doc.activeElement, 'ArrowUp');
        assert.equal(doc.activeElement.dataset.messageId, 'a1');
        assert.deepEqual(stops(), ['a1'], 'the tab stop follows focus');
        key(doc.activeElement, 'Home');
        assert.equal(doc.activeElement.dataset.messageId, 'q1');
        key(doc.activeElement, 'End');
        assert.equal(doc.activeElement.dataset.messageId, 'q2');
    } finally {
        owner.dispose();
        dom.window.close();
    }
});

test('Shift+F10 on a message opens a focusable menu that Escape closes back to the message', () => {
    const { dom, doc, owner, items, key, keyboardMenu, edits } = mount();
    try {
        const answer = items()[1];
        answer.focus();
        keyboardMenu(answer);
        const menu = doc.getElementById('chatContextMenu');
        assert.ok(menu, 'the menu opens without a pointer');
        assert.equal(menu.getAttribute('role'), 'menu');
        const menuItems = [...menu.querySelectorAll('[role="menuitem"]')];
        assert.ok(menuItems.length > 1);
        assert.equal(doc.activeElement, menuItems[0], 'focus moves into the menu');
        key(doc.activeElement, 'ArrowDown');
        assert.equal(doc.activeElement, menuItems[1]);
        key(doc.activeElement, 'End');
        assert.equal(doc.activeElement, menuItems.at(-1));
        key(doc.activeElement, 'Escape');
        assert.equal(doc.getElementById('chatContextMenu'), null);
        assert.equal(doc.activeElement, answer, 'Escape returns focus to the message');

        keyboardMenu(answer);
        const edit = doc.querySelector('#chatContextMenu [data-side-chat-action="edit"]');
        assert.equal(doc.activeElement, edit);
        key(edit, 'Enter');
        assert.deepEqual(edits, ['a1'], 'Enter runs the focused menu item');
        assert.equal(doc.getElementById('chatContextMenu'), null);
    } finally {
        owner.dispose();
        dom.window.close();
    }
});
