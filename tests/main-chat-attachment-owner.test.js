import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import { createMainChatAttachmentOwner } from '../modules/renderer/mainChatAttachmentOwner.js';

test('pending attachment removal updates immutable owner state and reprojects preview', () => {
    const projections = [];
    const owner = createMainChatAttachmentOwner({
        renderPreview(files, removeAttachmentAt) {
            projections.push({ files, removeAttachmentAt });
        },
    });

    const first = { originalName: 'first.txt' };
    const second = { originalName: 'second.txt' };
    owner.ref.append(first);
    owner.ref.append(second);
    owner.syncPreview();

    assert.equal(Object.isFrozen(owner.get()), true);
    assert.deepEqual(owner.get(), [first, second]);
    assert.equal(projections.length, 1);
    assert.equal(typeof projections[0].removeAttachmentAt, 'function');

    assert.equal(projections[0].removeAttachmentAt(0), true);
    assert.deepEqual(owner.get(), [second]);
    assert.equal(Object.isFrozen(owner.get()), true);
    assert.equal(projections.length, 2);
    assert.deepEqual(projections[1].files, [second]);

    assert.equal(owner.removeAt(9), false);
    assert.deepEqual(owner.get(), [second]);
    assert.equal(projections.length, 2);
});

test('attachment preview remove button delegates to owner without submitting its form', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
        <form id="composer"><div id="attachmentPreviewArea"></div></form>
    </body></html>`, {
        runScripts: 'outside-only',
        url: 'https://vcpchat.local/',
    });
    const { window } = dom;
    window.eval(fs.readFileSync('modules/ui-helpers.js', 'utf8'));

    const preview = window.document.getElementById('attachmentPreviewArea');
    let submitCount = 0;
    window.document.getElementById('composer').addEventListener('submit', event => {
        event.preventDefault();
        submitCount += 1;
    });

    const owner = createMainChatAttachmentOwner({
        renderPreview(files, removeAttachmentAt) {
            window.uiHelperFunctions.updateAttachmentPreview(files, preview, removeAttachmentAt);
        },
    });
    owner.ref.set([
        {
            file: { name: 'remove-me.txt', type: 'text/plain', size: 9 },
            originalName: 'remove-me.txt',
            localPath: 'file:///tmp/remove-me.txt',
        },
    ]);
    owner.syncPreview();

    const removeButton = preview.querySelector('.file-preview-remove-btn');
    assert.equal(removeButton.type, 'button');
    assert.doesNotThrow(() => removeButton.click());
    assert.deepEqual(owner.get(), []);
    assert.equal(preview.querySelector('.attachment-preview-item'), null);
    assert.equal(preview.style.display, 'none');
    assert.equal(submitCount, 0);

    dom.window.close();
});