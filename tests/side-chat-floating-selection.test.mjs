import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFloatingSelectionButton } from '../modules/renderer/floatingSelectionButton.js';

function setup() {
    const dom = new JSDOM(`<body>
        <div id="chatMessages"><div class="message-item" data-message-id="m1"><p id="main">hello world text</p></div></div>
        <aside><div class="side-chat-surface"><div class="message-item" data-message-id="s1"><p id="side">side reply text</p></div></div></aside>
        <button id="floatingSelectionSideChatBtn" hidden></button>
    </body>`, { pretendToBeVisual: true });
    const { window } = dom;
    window.Range.prototype.getBoundingClientRect = () => ({ left: 100, top: 200, width: 50, height: 10 });
    const opened = [];
    window.openSideChatWithSelection = async (payload) => { opened.push(payload); };
    const handle = createFloatingSelectionButton({ doc: window.document, win: window, notify() {} });
    const btn = window.document.getElementById('floatingSelectionSideChatBtn');
    const select = (id) => {
        const range = window.document.createRange();
        range.selectNodeContents(window.document.getElementById(id));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        window.document.dispatchEvent(new window.Event('selectionchange'));
    };
    return { window, handle, btn, select, opened };
}

test('floating ask button shows only for main chat selections, not side chat messages', async () => {
    const { btn, select, opened } = setup();
    select('main');
    assert.equal(btn.hidden, false);
    btn.click();
    await Promise.resolve();
    assert.deepEqual(opened.map((p) => p.message.id), ['m1']);
    select('side');
    assert.equal(btn.hidden, true);
});

test('floating ask button hides when any container scrolls or the window resizes', () => {
    const { window, btn, select, handle } = setup();
    select('main');
    assert.equal(btn.hidden, false);
    window.document.getElementById('chatMessages').dispatchEvent(new window.Event('scroll'));
    assert.equal(btn.hidden, true);
    select('main');
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(btn.hidden, true);
    handle.dispose();
    btn.hidden = false;
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(btn.hidden, false);
});
