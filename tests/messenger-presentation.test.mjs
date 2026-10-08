import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../modules/renderer/messenger-presentation.js', import.meta.url), 'utf8');

async function setup(t) {
    const dom = new JSDOM(`<!doctype html><body class="chat-presentation-messenger">
        <div class="chat-messages-container"><div id="chatMessages">
            <div class="message-item assistant"><div class="sender-name">Nova</div><div class="md-content">Old topic</div></div>
        </div></div><div class="chat-input-card"></div></body>`, {
        pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://vcpchat.local/'
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    window.ResizeObserver = class { observe() {} disconnect() {} };
    window.matchMedia = () => ({ matches: true });
    const copied = [];
    Object.defineProperty(window.navigator, 'clipboard', { value: { async writeText(value) { copied.push(value); } } });
    const item = window.document.querySelector('.message-item');
    Object.defineProperty(item.querySelector('.md-content'), 'innerText', { get: () => 'Old topic' });
    window.eval(source);
    await new Promise(resolve => window.setTimeout(resolve, 40));
    item.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    return { window, item, copied, bar: window.document.querySelector('.messenger-hover-actions') };
}

test('removing the hovered message revokes toolbar actions before the next click', async t => {
    const { window, item, copied, bar } = await setup(t);
    item.remove();
    bar.querySelector('[data-messenger-action="copy"]').click();
    await Promise.resolve();
    assert.deepEqual(copied, [], 'a detached old-topic message must not remain an action target');
    await new Promise(resolve => window.setTimeout(resolve, 30));
    assert.equal(bar.classList.contains('is-visible'), false);
});

test('switching presentation revokes actions and removes hidden buttons from keyboard navigation', async t => {
    const { window, copied, bar } = await setup(t);
    window.document.body.classList.remove('chat-presentation-messenger');
    bar.querySelector('[data-messenger-action="copy"]').click();
    await Promise.resolve();
    assert.deepEqual(copied, []);
    assert.equal(bar.inert, true);
    assert.equal(bar.getAttribute('aria-hidden'), 'true');
});

test('visible message actions copy current content and hide on scroll', async t => {
    const { window, copied, bar } = await setup(t);
    assert.equal(bar.inert, false);
    bar.querySelector('[data-messenger-action="copy"]').click();
    await Promise.resolve();
    assert.deepEqual(copied, ['Old topic']);
    window.document.querySelector('.chat-messages-container').dispatchEvent(new window.Event('scroll'));
    assert.equal(bar.classList.contains('is-visible'), false);
    assert.equal(bar.inert, true);
});
