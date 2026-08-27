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

test('interactive nested button targets the owning button and restores after async send failure', async () => {
    const dom = new JSDOM('<body><section id="chat"><button data-send="建议内容"><span class="icon">★</span><span>采用建议</span></button></section></body>');
    const root = dom.window.document.getElementById('chat');
    const calls = [];
    const processor = createContentProcessor();
    processor.initializeContentProcessor({
        chatMessagesDiv: root,
        messageCommands: {
            async handleSendMessage(text) {
                calls.push(text);
                throw new Error('controlled async failure');
            }
        },
        uiHelper: {}
    });
    processor.processInteractiveButtons(root);

    const button = root.querySelector('button');
    button.querySelector('.icon').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.deepEqual(calls, ['[[点击按钮:建议内容]]']);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, '★采用建议');
    processor.dispose();
    dom.window.close();
});

test('disabling AI buttons revokes existing bindings and re-enabling binds them again', async () => {
    const dom = new JSDOM('<body><section id="chat"><button data-send="建议">采用建议</button></section></body>');
    const root = dom.window.document.getElementById('chat');
    const calls = [];
    const processor = createContentProcessor();
    processor.initializeContentProcessor({
        chatMessagesDiv: root,
        messageCommands: { handleSendMessage: text => calls.push(text) },
        uiHelper: {}
    });
    const button = root.querySelector('button');

    processor.processInteractiveButtons(root, { enableAiMessageButtons: true });
    processor.processInteractiveButtons(root, { enableAiMessageButtons: false });
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, []);
    assert.equal(button.dataset.vcpInteractive, undefined);

    processor.processInteractiveButtons(root, { enableAiMessageButtons: true });
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, ['[[点击按钮:建议]]']);

    processor.dispose();
    dom.window.close();
});

test('CSS AST scoping recursively scopes nested rules and rejects external imports', () => {
    const processor = createContentProcessor();
    const scoped = processor.scopeCss(
        '@media (min-width: 1px) { body .card, :root > .panel { color: red; } } @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }',
        'message-scope'
    );

    assert.match(scoped, /@media/);
    assert.match(scoped, /#message-scope \.card/);
    assert.match(scoped, /#message-scope>\.panel|#message-scope > \.panel/);
    assert.match(scoped, /@keyframes pulse/);
    assert.match(scoped, /from\{opacity:0\}/);
    assert.equal(processor.scopeCss('@import url("https://example.test/x.css"); .card { color: red; }', 'message-scope'), '');
});

test('HTML code preview is sandboxed without same-origin authority', () => {
    const dom = new JSDOM('<body><section id="chat"><pre><code class="language-html"><script>parent.document.body.dataset.compromised="true"</script></code></pre></section></body>', {
        url: 'https://vcpchat.local/'
    });
    const root = dom.window.document.getElementById('chat');
    const processor = createContentProcessor();
    processor.initializeContentProcessor({ chatMessagesDiv: root, messageCommands: {}, uiHelper: {} });
    processor.processAllPreBlocksInContentDiv(root);

    const toggle = root.querySelector('.vcp-html-preview-toggle');
    assert.ok(toggle);
    toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const frame = root.querySelector('iframe.vcp-html-preview-frame');
    assert.ok(frame);
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(frame.getAttribute('sandbox').includes('allow-same-origin'), false);

    processor.dispose();
    dom.window.close();
});
