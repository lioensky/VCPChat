import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContentProcessor } from '../modules/renderer/contentProcessor.js';

test('interactive message buttons retain their Surface command and teardown owner', async () => {
    const dom = new JSDOM('<body><textarea id="messageInput"></textarea><section id="a"><button data-send="A">A</button></section><section id="b"><button data-send="B">B</button></section></body>');
    const rootA = dom.window.document.getElementById('a');
    const rootB = dom.window.document.getElementById('b');
    const callsA = [];
    const callsB = [];
    const processorA = createContentProcessor();
    const processorB = createContentProcessor();
    processorA.initializeContentProcessor({ chatMessagesDiv: rootA, messageCommands: { handleSendMessage: text => callsA.push(text) }, uiHelper: {} });
    processorB.initializeContentProcessor({ chatMessagesDiv: rootB, messageCommands: { handleSendMessage: text => callsB.push(text) }, uiHelper: {} });
    processorA.processInteractiveButtons(rootA);
    processorB.processInteractiveButtons(rootB);

    rootA.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    processorA.dispose();
    rootB.querySelector('button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.deepEqual(callsA, [], 'disposed Surface retained a scheduled button send');
    assert.deepEqual(callsB, ['[[点击按钮:B]]']);
    assert.equal(rootA.querySelector('button').dataset.vcpInteractive, undefined);
    assert.equal(rootB.querySelector('button').dataset.vcpInteractive, 'true');
});
