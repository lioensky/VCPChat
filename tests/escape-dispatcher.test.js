const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { EscapeDispatcher } = require('../modules/ui-system/next-shell/escape-dispatcher.js');

test('Escape closes only the highest-priority active owner', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const dispatcher = new EscapeDispatcher({ document: dom.window.document });
    dispatcher.mount();
    const closed = [];
    dispatcher.register({ priority: 10, close: () => { closed.push('low'); return true; } });
    dispatcher.register({ priority: 20, close: () => { closed.push('high'); return true; } });
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dom.window.document.dispatchEvent(event);
    assert.deepEqual(closed, ['high']);
    assert.equal(event.defaultPrevented, true);
    dispatcher.dispose();
    dom.window.close();
});

test('Escape ignores handled events and disposal retracts owners', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const dispatcher = new EscapeDispatcher({ document: dom.window.document });
    dispatcher.mount();
    let count = 0;
    dispatcher.register({ close: () => { count += 1; return true; } });
    const handled = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    dom.window.document.dispatchEvent(handled);
    assert.equal(count, 0);
    dispatcher.dispose();
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(count, 0);
    dom.window.close();
});
