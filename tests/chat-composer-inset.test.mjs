import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatComposerInset } from '../modules/ui-system/chat-composer-inset.js';

function makeShell({ following = true } = {}) {
    const dom = new JSDOM(`<!doctype html><body><main class="main-content">
        <div class="chat-messages-container vcp-ui-scope"><div id="chatMessages"></div></div>
        <footer class="chat-input-area vcp-ui-scope"></footer>
    </main></body>`);
    const { window } = dom;
    const doc = window.document;
    const observers = [];
    window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.targets = []; }
    };
    const main = doc.querySelector('main');
    const scroller = doc.querySelector('.chat-messages-container');
    const dock = doc.querySelector('.chat-input-area');
    let dockHeight = 100;
    let scrollbar = 15;
    dock.getBoundingClientRect = () => ({ height: dockHeight });
    Object.defineProperty(scroller, 'offsetWidth', { get: () => 1000 });
    Object.defineProperty(scroller, 'clientWidth', { get: () => 1000 - scrollbar });
    const calls = [];
    const uiHelper = {
        captureChatScrollFollow: () => ({ followBottom: following }),
        scrollToBottom: (options) => calls.push(options)
    };
    return {
        dom, doc, main, scroller, dock, uiHelper, calls, observers,
        setDockHeight(value) { dockHeight = value; },
        setFollowing(value) { following = value; },
        fire() { observers.forEach(observer => observer.callback([])); }
    };
}

test('mounts the overlay class and publishes composer height and scrollbar width', () => {
    const shell = makeShell();
    const control = createChatComposerInset({ document: shell.doc, uiHelper: shell.uiHelper });
    assert.equal(control.mount(), true);
    assert.equal(shell.main.classList.contains('vcp-chat-composer-overlay'), true);
    assert.equal(shell.main.style.getPropertyValue('--vcp-chat-composer-inset'), '100px');
    assert.equal(shell.main.style.getPropertyValue('--vcp-chat-scrollbar-size'), '15px');
    assert.deepEqual(shell.observers[0].targets, [shell.dock, shell.scroller]);
    assert.deepEqual(shell.calls, [{ force: true, immediate: true }], 'a following view stays pinned once the overlay applies');
    control.dispose();
    shell.dom.window.close();
});

test('a taller composer keeps a following view pinned but leaves a reader where they are', () => {
    const shell = makeShell();
    const control = createChatComposerInset({ document: shell.doc, uiHelper: shell.uiHelper });
    control.mount();
    shell.calls.length = 0;

    shell.fire();
    assert.equal(shell.calls.length, 0, 'unchanged height does nothing');

    shell.setDockHeight(160);
    shell.fire();
    assert.equal(shell.main.style.getPropertyValue('--vcp-chat-composer-inset'), '160px');
    assert.equal(shell.calls.length, 1);

    shell.setFollowing(false);
    shell.setDockHeight(100);
    shell.fire();
    assert.equal(shell.main.style.getPropertyValue('--vcp-chat-composer-inset'), '100px');
    assert.equal(shell.calls.length, 1);
    control.dispose();
    shell.dom.window.close();
});

test('dispose restores the stacked layout', () => {
    const shell = makeShell();
    const control = createChatComposerInset({ document: shell.doc, uiHelper: shell.uiHelper });
    control.mount();
    control.dispose();
    assert.equal(shell.main.classList.contains('vcp-chat-composer-overlay'), false);
    assert.equal(shell.main.style.getPropertyValue('--vcp-chat-composer-inset'), '');
    assert.equal(shell.observers[0].targets.length, 0);
    shell.dom.window.close();
});

test('leaves the layout alone without the chat shell', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const control = createChatComposerInset({ document: dom.window.document });
    assert.equal(control.mount(), false);
    control.dispose();
    dom.window.close();
});


test('fade background is a sibling, aligned to its source and cleaned up on dispose', () => {
    const shell = makeShell();
    shell.main.style.backgroundImage = 'linear-gradient(red, blue)';
    shell.main.style.backgroundSize = 'cover';
    shell.main.getBoundingClientRect = () => ({ left: 30, top: 40, width: 800, height: 600 });
    const control = createChatComposerInset({ document: shell.doc, uiHelper: shell.uiHelper });
    control.mount();
    const fade = shell.main.querySelector('.vcp-chat-composer-backdrop-fade');
    assert.equal(fade.parentElement, shell.scroller.parentElement);
    assert.equal(fade.nextElementSibling, shell.dock);
    assert.equal(fade.contains(shell.scroller), false);
    assert.equal(fade.getAttribute('aria-hidden'), 'true');
    const plane = fade.lastElementChild;
    assert.equal(plane.style.backgroundImage, 'linear-gradient(red, blue)');
    assert.equal(plane.style.width, '800px');
    assert.equal(plane.style.left, '0px');
    shell.main.style.backgroundImage = 'linear-gradient(black, white)';
    shell.fire();
    assert.equal(plane.style.backgroundImage, 'linear-gradient(black, white)');
    control.dispose();
    assert.equal(shell.main.querySelector('.vcp-chat-composer-backdrop-fade'), null);
    shell.dom.window.close();
});
