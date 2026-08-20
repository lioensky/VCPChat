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
});
