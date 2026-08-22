import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createImageHandler } from '../modules/renderer/imageHandler.js';

test('image handlers retain only their owning Surface transport', () => {
    const dom = new JSDOM('<body class="light-theme"><section id="a"></section><section id="b"></section></body>', { url: 'https://example.test/' });
    const callsA = [];
    const callsB = [];
    const rootA = dom.window.document.getElementById('a');
    const rootB = dom.window.document.getElementById('b');
    const handlerA = createImageHandler({ fixUrl: value => value });
    const handlerB = createImageHandler({ fixUrl: value => value });
    handlerA.initialize({ chatMessagesDiv: rootA, electronAPI: { openImageViewer: value => callsA.push(value), showImageContextMenu() {} } });
    handlerB.initialize({ chatMessagesDiv: rootB, electronAPI: { openImageViewer: value => callsB.push(value), showImageContextMenu() {} } });

    handlerA.setContentAndProcessImages(rootA, '<img src="/a.png" alt="A">', 'a');
    handlerB.setContentAndProcessImages(rootB, '<img src="/b.png" alt="B">', 'b');
    rootA.querySelector('img').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    rootB.querySelector('img').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    assert.equal(callsA.length, 1);
    assert.equal(callsA[0].title, 'A');
    assert.equal(callsA[0].theme, 'light');
    assert.equal(callsB.length, 1);
    assert.equal(callsB[0].title, 'B');
    const retiredImageA = rootA.querySelector('img');
    handlerA.dispose();
    retiredImageA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(callsA.length, 1, 'disposed image owner retained click authority');
    rootB.querySelector('img').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(callsB.length, 2, 'disposing one image owner affected another Surface');
    assert.throws(() => handlerA.setContentAndProcessImages(rootA, '', 'a'), /not initialized/);
    assert.doesNotThrow(() => handlerB.setContentAndProcessImages(rootB, '', 'b'));
});
