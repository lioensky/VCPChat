import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    captureSelectionReference,
    validateReferenceList,
    MAX_SINGLE_REFERENCE_LENGTH,
    MAX_TOTAL_REFERENCE_LENGTH,
    MAX_REFERENCE_COUNT
} from '../modules/ui-system/side-pane/selection-reference.js';

test('captureSelectionReference handles empty selection or missing window', () => {
    assert.equal(captureSelectionReference(null).ok, false);

    const dom = new JSDOM('<p>Some text</p>');
    const res = captureSelectionReference(dom.window);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'EMPTY_SELECTION');
    dom.window.close();
});

test('captureSelectionReference extracts single message selection with provenance', () => {
    const html = `
      <div class="chat-messages">
        <div class="message-item" data-message-id="msg-42">
          <p id="targetText">Hello from VCPChat</p>
        </div>
      </div>
    `;
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const textNode = doc.getElementById('targetText').firstChild;

    const range = doc.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5); // "Hello"

    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const res = captureSelectionReference(dom.window);
    assert.equal(res.ok, true);
    assert.equal(res.reference.text, 'Hello');
    assert.equal(res.reference.sourceMessageId, 'msg-42');
    assert.ok(res.reference.id.startsWith('ref-'));
    dom.window.close();
});

test('captureSelectionReference rejects cross-message selections', () => {
    const html = `
      <div class="chat-messages">
        <div class="message-item" data-message-id="msg-1">
          <p id="m1">Message One</p>
        </div>
        <div class="message-item" data-message-id="msg-2">
          <p id="m2">Message Two</p>
        </div>
      </div>
    `;
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const range = doc.createRange();
    range.setStart(doc.getElementById('m1').firstChild, 0);
    range.setEnd(doc.getElementById('m2').firstChild, 5);

    const sel = dom.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const res = captureSelectionReference(dom.window);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'CROSS_MESSAGE_SELECTION');
    dom.window.close();
});

test('validateReferenceList enforces count, duplicates, and total length limits', () => {
    const list = [
        { id: '1', text: 'ref 1' },
        { id: '2', text: 'ref 2' }
    ];

    // Duplicate check
    const dupRes = validateReferenceList(list, { text: 'ref 1' });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.reason, 'DUPLICATE');

    // Valid addition
    const okRes = validateReferenceList(list, { text: 'ref 3' });
    assert.equal(okRes.ok, true);

    // Count limit check
    const maxList = Array.from({ length: MAX_REFERENCE_COUNT }, (_, i) => ({ id: String(i), text: `text ${i}` }));
    const countRes = validateReferenceList(maxList, { text: 'one more' });
    assert.equal(countRes.ok, false);
    assert.equal(countRes.reason, 'EXCEEDS_COUNT_LIMIT');

    // Total length check
    const single = { id: 'big-1', text: 'a'.repeat(MAX_SINGLE_REFERENCE_LENGTH) };
    const total = validateReferenceList([single, { id: 'big-2', text: 'b'.repeat(MAX_SINGLE_REFERENCE_LENGTH) }], { text: 'c' });
    assert.equal(total.ok, false);
    assert.equal(total.reason, 'EXCEEDS_TOTAL_LIMIT');

    const tooBig = validateReferenceList([], { text: 'a'.repeat(MAX_SINGLE_REFERENCE_LENGTH + 1) });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, 'EXCEEDS_SINGLE_LIMIT');
});
