import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { installMainComposer } from './helpers/main-composer.mjs';

function setup(value = '', options = {}) {
    const dom = new JSDOM('<textarea id="messageInput"></textarea>');
    const input = dom.window.document.getElementById('messageInput');
    input.value = value;
    let inputs = 0;
    input.addEventListener('input', () => inputs++);
    const composer = installMainComposer(dom.window, options);
    const insert = (text, opts) => composer.commands.execute('composer.insert-text', text, opts);
    return { dom, input, composer, insert, inputs: () => inputs };
}

test('composer.insert-text appends on a new line or as a new paragraph', () => {
    const { dom, input, insert, inputs } = setup('draft');
    assert.deepEqual(insert('one'), { inserted: true });
    assert.equal(input.value, 'draft\none');
    input.value = 'ends with newline\n';
    insert('two');
    assert.equal(input.value, 'ends with newline\ntwo');

    input.value = 'draft  \n';
    insert('para', { gap: 'paragraph' });
    assert.equal(input.value, 'draft\n\npara');
    input.value = '';
    insert('first', { gap: 'paragraph' });
    assert.equal(input.value, 'first');
    assert.equal(inputs(), 4);
    assert.equal(dom.window.document.activeElement, input);
    dom.window.close();
});

test('composer.insert-text refuses when the main chat moved to another conversation', () => {
    let item = { id: 'agent-b' };
    let topic = 't1';
    const { dom, input, insert, inputs } = setup('keep', { selectedItem: () => item, topicId: () => topic });
    const expect = { itemId: 'agent-a', topicId: 't1' };
    assert.deepEqual(insert('x', { expect }), { inserted: false, reason: 'item-mismatch' });
    item = { id: 'agent-a' };
    topic = 't2';
    assert.deepEqual(insert('x', { expect }), { inserted: false, reason: 'topic-mismatch' });
    assert.equal(input.value, 'keep');
    assert.equal(inputs(), 0);
    topic = 't1';
    assert.deepEqual(insert('x', { expect }), { inserted: true });
    dom.window.close();
});

test('composer.insert-text reports a missing or disabled composer and empty text', async () => {
    const { dom, input, insert, composer } = setup();
    assert.deepEqual(insert(''), { inserted: false, reason: 'empty' });
    input.disabled = true;
    assert.deepEqual(insert('x'), { inserted: false, reason: 'no-composer' });
    input.disabled = false;
    input.remove();
    assert.deepEqual(insert('x'), { inserted: false, reason: 'no-composer' });

    // 主输入框的主人卸载后命令随之注销
    await composer.dispose();
    assert.equal(composer.commands.get('composer.insert-text'), null);
    dom.window.close();
});
