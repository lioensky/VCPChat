import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { moveMenuFocus } from '../modules/ui-system/side-pane/menu-position.js';

function menu() {
    const dom = new JSDOM('<button id="outside"></button><div role="menu"><button role="menuitem">a</button><button role="menuitem">b</button><button role="menuitem">c</button></div>');
    const doc = dom.window.document;
    const items = [...doc.querySelectorAll('[role="menuitem"]')];
    const press = key => {
        const event = new dom.window.KeyboardEvent('keydown', { key, cancelable: true });
        const handled = moveMenuFocus(event, items);
        return { handled, prevented: event.defaultPrevented, focused: doc.activeElement?.textContent };
    };
    return { doc, items, press };
}

test('menu arrow keys wrap and Home/End jump to the ends', () => {
    const { items, press } = menu();
    items[0].focus();
    assert.equal(press('ArrowUp').focused, 'c');
    assert.equal(press('ArrowDown').focused, 'a');
    assert.equal(press('End').focused, 'c');
    assert.equal(press('Home').focused, 'a');
});

test('with focus outside the items, ArrowUp goes to the last item and ArrowDown to the first', () => {
    const { doc, press } = menu();
    doc.getElementById('outside').focus();
    assert.equal(press('ArrowUp').focused, 'c');
    doc.getElementById('outside').focus();
    assert.equal(press('ArrowDown').focused, 'a');
});

test('other keys are left alone', () => {
    const { items, press } = menu();
    items[1].focus();
    assert.deepEqual(press('Enter'), { handled: false, prevented: false, focused: 'b' });
});
