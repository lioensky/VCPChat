import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentRuntime } from '../modules/chat/contentRuntime.js';
import { createMermaidPlaceholderTransform, decodeHtmlEntities } from '../modules/chat/contentTransforms.js';

test('ContentRuntime delegates full/stream modes and extracts protocol chunks', () => {
    const calls = [];
    const runtime = createContentRuntime({ pipeline: { process: (text, options) => { calls.push(options.mode); return { text }; } } });
    assert.equal(runtime.processFull('a').text, 'a');
    assert.equal(runtime.processStream('b').text, 'b');
    assert.deepEqual(calls, ['full-render', 'stream-fast']);
    assert.equal(runtime.extractChunkText({ choices: [{ delta: { content: 'x' } }] }), 'x');
    assert.equal(runtime.extractChunkText({ error: 'json_parse_error', raw: 'bad' }), '');
});

test('ContentRuntime stream assembler has explicit append/reset state', () => {
    const runtime = createContentRuntime({ pipeline: { process: () => ({ text: '' }) } });
    const assembler = runtime.createStreamAssembler('a');
    assert.equal(assembler.append('b'), 'ab');
    assert.equal(assembler.text, 'ab');
    assert.equal(assembler.reset(), '');
});

test('ContentRuntime creates a frozen render model without DOM or Electron access', () => {
    const runtime = createContentRuntime({ pipeline: {
        process(text, options) { return { text: `${options.mode}:${text}`, state: Object.freeze({}) }; }
    } });
    const model = runtime.createRenderModel({ content: 'hello', role: 'user', id: 'm1' });
    assert.equal(model.message.id, 'm1');
    assert.equal(model.text, 'full-render:hello');
    assert.equal(Object.isFrozen(model), true);
    assert.equal(Object.isFrozen(model.message), true);
});

test('ContentRuntime normalizes attachment protocol data before any DOM consumer sees it', () => {
    const runtime = createContentRuntime({ pipeline: { process: (text) => ({ text, state: {} }) } });
    const message = runtime.normalizeMessage({ content: 'x', attachments: [
        { type: 'image/png', src: 'file:///x.png', name: 'x.png' },
        null,
        { src: 42 }
    ] });
    assert.equal(message.attachments.length, 2);
    assert.equal(message.attachments[1].type, 'application/octet-stream');
    assert.equal(message.attachments[1].name, '未命名附件');
    assert.equal(Object.isFrozen(message.attachments), true);
});

test('content transforms keep Mermaid conversion DOM-free and decode entities deterministically', () => {
    assert.equal(decodeHtmlEntities('&lt;div&gt;&#x41;&#65;&lt;/div&gt;'), '<div>AA</div>');
    const transform = createMermaidPlaceholderTransform();
    const output = transform('```mermaid\ngraph TD\nA-->B\n```');
    assert.match(output, /mermaid-placeholder/);
    assert.match(output, /data-mermaid-code=/);

    const fourTick = transform('````mermaid\nflowchart TD\n  A-->B\n````');
    assert.match(fourTick, /^<div class="mermaid-placeholder"/);

    const nestedExample = transform('````markdown\n```mermaid\nflowchart TD\n  A -> B\n```\n````');
    assert.ok(!nestedExample.includes('mermaid-placeholder'));

    const codeFlowchart = transform('<pre><code class="language-mermaid">flowchart TD\n  A--&gt;B\n</code></pre>');
    assert.ok(!codeFlowchart.includes('<pre>'), 'pre wrapper around mermaid code should be stripped cleanly');
    assert.ok(decodeURIComponent(codeFlowchart.match(/data-mermaid-code="([^"]+)"/)[1]).startsWith('flowchart TD'));

    const boldInLabel = transform('```mermaid\nflowchart TD\n  A["**重要**节点"] --> B["2**10"]\n```');
    assert.ok(!boldInLabel.includes('*'), 'asterisk in data-mermaid-code must be percent-encoded against pipeline bold fixer');
    assert.equal(
        decodeURIComponent(boldInLabel.match(/data-mermaid-code="([^"]+)"/)[1]),
        'flowchart TD\n  A["**重要**节点"] --> B["2**10"]'
    );

    const proseCode = transform('<table><tr><td><code>graph database</code> 和 <code>flowchart node</code></td></tr></table>');
    assert.ok(!proseCode.includes('mermaid-placeholder'));
    assert.ok(proseCode.includes('<code>graph database</code>'));

    const tightHtmlCodeBold = transform('<pre><code class="language-mermaid">flowchart TD\nA--&gt;B</code></pre>\n**粗体**');
    assert.ok(tightHtmlCodeBold.includes('</div>\n\n**粗体**'));

    const withFollowingBold = transform('说明：\n```mermaid\nflowchart TD\nA-->B\n```\n\n**后续粗体**');
    assert.ok(withFollowingBold.includes('</div>\n\n**后续粗体**'));

    const tightFollowingHeading = transform('说明：\n```mermaid\nflowchart TD\nA-->B\n```\n### 总结\n- 项目1');
    assert.ok(tightFollowingHeading.includes('</div>\n\n### 总结\n- 项目1'));

    const crlfBlock = transform('前文\r\n\r\n```mermaid\r\nflowchart TD\r\n  A-->B\r\n```\r\n\r\n**CRLF粗体**\r\n');
    assert.match(crlfBlock, /mermaid-placeholder/);
    assert.ok(crlfBlock.includes('</div>\r\n\r\n**CRLF粗体**'));
});
