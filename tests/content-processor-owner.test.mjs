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

test('HTML code preview stays sandboxed and a quick return leaves its source visible', async () => {
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
    toggle.click();
    assert.equal(root.querySelector('iframe'), null);
    assert.equal(root.querySelector('pre').hasAttribute('data-vcp-has-timeout'), false);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.notEqual(root.querySelector('pre').style.display, 'none');

    processor.dispose();
    dom.window.close();
});

test('long code blocks keep the side view and copy buttons side by side in one toolbar', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
    const dom = new JSDOM(`<body><div id="chat"><div class="md-content"><pre><code class="language-js">${lines}</code></pre></div></div></body>`);
    const root = dom.window.document.getElementById('chat');
    const processor = createContentProcessor();
    processor.initializeContentProcessor({ chatMessagesDiv: root, messageCommands: {}, uiHelper: {} });
    const previousDocument = globalThis.document;
    globalThis.document = dom.window.document;
    try {
        processor.processRenderedContent(root.querySelector('.md-content'), {});
    } finally {
        globalThis.document = previousDocument;
    }

    const pre = root.querySelector('pre');
    const toolbars = pre.querySelectorAll(':scope > .vcp-codeblock-actions');
    assert.equal(toolbars.length, 1);
    assert.deepEqual(
        [...toolbars[0].children].map(button => button.getAttribute('aria-label')),
        ['侧边副屏查看', '复制代码'],
        'each button pinned to the same corner on its own lets the copy button cover the side view button'
    );
    processor.dispose();
    dom.window.close();
});

test('quote highlighting leaves button labels untouched', () => {
    const dom = new JSDOM('<body><div id="m"><p>说 "你好" 吧</p><button>工具 · "query"</button></div></body>');
    const root = dom.window.document.getElementById('m');
    createContentProcessor().highlightAllPatternsInMessage(root);
    assert.equal(root.querySelectorAll('p .highlighted-quote').length, 1);
    assert.equal(root.querySelector('button').innerHTML, '工具 · "query"');
});


test('Chinese paragraph normalization preserves list continuations, quotes and short indentation', () => {
    const processor = createContentProcessor();
    const source = '- 列表\n  中文子段落\n    中文续行\n\n普通正文\n  中文短缩进\n    中文误缩进\n> 引用\n  > 中文引用';
    assert.equal(processor.deIndentMisinterpretedCodeBlocks(source),
        '- 列表\n  中文子段落\n    中文续行\n\n普通正文\n  中文短缩进\n中文误缩进\n> 引用\n  > 中文引用');
});

test('preview cleanup never enumerates every syntax-highlighted descendant', () => {
    const dom = new JSDOM('<div><pre><code><span>code</span></code></pre></div>');
    const root = dom.window.document.querySelector('div');
    const nativeQuery = root.querySelectorAll.bind(root);
    root.querySelectorAll = selector => {
        assert.notEqual(selector, '*');
        return nativeQuery(selector);
    };
    createContentProcessor().cleanupPreviewsInContent(root);
    dom.window.close();
});

test('scopeCss preserves body.light-theme qualifiers outside scopeId and skips auto-adaptation when explicit', () => {
    const processor = createContentProcessor();
    const scoped = processor.scopeCss(
        '.card { background: rgba(10, 20, 35, 0.45); color: #7dd3fc; } body.light-theme .card, body[data-vcp-theme="light"] > .panel { background: #ffffff; color: #1b211f; }',
        'message-scope'
    );

    assert.match(scoped, /body\.light-theme #message-scope \.card/);
    assert.match(scoped, /body\[data-vcp-theme="?light"?\] #message-scope>\.panel|body\[data-vcp-theme="?light"?\] #message-scope > \.panel/);
    assert.doesNotMatch(scoped, /#message-scope\.light-theme/);
    assert.equal(scoped.match(/body\.light-theme/g)?.length, 1);
});

test('scopeCss generates light-theme overrides for dark glass cards while keeping vivid button text white', () => {
    const processor = createContentProcessor();
    const scoped = processor.scopeCss(`
        .wrap { background: rgba(10, 20, 35, 0.45); color: var(--primary-text, #e2e8f0); border: 1px solid rgba(56, 189, 248, 0.28); }
        .card { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.09); }
        .title { color: #7dd3fc; }
        .code { background: rgba(0, 0, 0, 0.3); color: #a5f3fc; }
        .cta { background: #0284c7; color: #ffffff; }
    `, 'msg-1');

    assert.match(scoped, /body\.light-theme #msg-1 \.wrap/);
    assert.match(scoped, /body\[data-vcp-theme="?light"?\] #msg-1 \.wrap/);
    assert.match(scoped, /body\.light-theme #msg-1 \.card[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.72\)/);
    assert.match(scoped, /body\.light-theme #msg-1 \.code[^}]*background:\s*rgba\(27,\s*33,\s*31,\s*0\.06\)/);
    assert.doesNotMatch(scoped, /body\.light-theme #msg-1 \.title[^}]*#7dd3fc/i);
    assert.doesNotMatch(scoped, /body\.light-theme #msg-1 \.cta/);
});
