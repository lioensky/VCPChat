import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { createHostedToolCallCard, renderHostedAssistantSegments } from '../modules/renderer/hostedToolCallRendering.js';

const { marked } = createRequire(import.meta.url)('marked');
const args = JSON.stringify({ tool_name: '<em>Lookup</em>', query: '<img src="test">\nnext line\\n', limit: 2 });
const call = id => ({
    id, type: 'function', function: { name: 'vcptools', arguments: args },
});

test('saved hosted calls render between their text segments with original parallel IDs', t => {
    const dom = new JSDOM();
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const root = document.createElement('div');
    const history = JSON.parse(JSON.stringify([
        { content: '## A' }, { tool_calls: [call('a'), call('b')] },
        { content: '## 回执一\n\n### B' }, { tool_calls: [call('c')] },
        { content: '## 回执二\n\n### C' },
    ]));
    root.innerHTML = renderHostedAssistantSegments(history, source => marked.parse(source), document);
    assert.deepEqual([...root.children].map(node => node.dataset.vcpToolCallId || node.textContent),
        ['A', 'a', 'b', '回执一', 'B', 'c', '回执二', 'C']);
    const card = root.querySelector('[data-vcp-block-type="tool-use"]');
    const payload = card.querySelector('template').content;
    assert.equal(payload.querySelector('pre').textContent, 'tool_name: <em>Lookup</em>\nquery: <img src="test">\n  next line\\n\nlimit: 2');
    assert.equal(history[1].tool_calls[0].function.arguments, args);
    assert.equal(card.querySelector('.vcp-tool-name-highlight').textContent, '<em>Lookup</em>');
    assert.equal(card.querySelector('em, img'), null);
    assert.equal(payload.querySelector('img'), null);
});

test('FC-only and an unclosed source segment cannot swallow a hosted call', t => {
    const dom = new JSDOM();
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const root = document.createElement('div');
    const fc = { tool_calls: [call('a')] };
    root.innerHTML = renderHostedAssistantSegments([fc], () => assert.fail('FC is not Markdown'), document);
    assert.equal(root.firstElementChild.dataset.vcpToolCallId, 'a');
    for (const content of ['<pre>open', '<!-- open', '<textarea>open', '<plaintext>open']) {
        root.innerHTML = renderHostedAssistantSegments([{ content }, fc, { content: '<h2>after</h2>' }],
            source => source, document);
        assert.equal(root.querySelector('.vcp-hosted-tool-call').parentElement, root);
        assert.equal(root.querySelector('h2').parentElement, root);
    }
});

const diary = (id, fields, name = 'vcptools') => ({
    id, type: 'function', function: { name, arguments: JSON.stringify({ tool_name: 'DailyNote', ...fields }) },
});

test('native DailyNote uses the shared card in live and reopened mixed batches', t => {
    const dom = new JSDOM();
    t.after(() => dom.window.close());
    const { window } = dom;
    const { document } = window;
    window.marked = marked;
    const calls = [
        diary('note', { command: 'create', valet: 'Kerr', Date: '2026-11-26', fileName: '<b>今晚</b>', folder: 'Kerr的知识', Content: '**第一段**\n\n第二段\\n保留\n\n<script>throw 0</script>', Tag: 'FC, 日记' }),
        call('lookup'),
        diary('edit', { command: 'update', maid: 'Nova', target: '旧 **内容**', replace: '新内容' }),
    ];
    const original = JSON.stringify(calls);
    const live = createHostedToolCallCard(document, calls);
    const reopened = document.createElement('div');
    reopened.innerHTML = renderHostedAssistantSegments([{ tool_calls: JSON.parse(original) }], source => marked.parse(source), document);
    assert.deepEqual([...live.children].map(card => card.outerHTML), [...reopened.children].map(card => card.outerHTML));
    assert.deepEqual([...live.children].map(card => card.dataset.vcpToolCallId), ['note', 'lookup', 'edit']);
    const [note, lookup, edit] = live.children;
    assert.ok(note.matches('.maid-diary-bubble.valet-diary-bubble'));
    assert.equal(note.querySelector('.diary-title').textContent, '<b>今晚</b>');
    assert.equal(note.querySelector('.diary-date').textContent, '2026-11-26');
    assert.equal(note.querySelector('.diary-folder-name').textContent, 'Kerr的知识');
    assert.equal(note.querySelector('.diary-content strong').textContent, '第一段');
    assert.ok(note.querySelector('.diary-content').textContent.includes('第二段\\n保留'));
    assert.match(note.querySelector('.diary-content').textContent, /Tag:FC, 日记/);
    assert.equal(note.querySelector('script'), null);
    assert.ok(lookup.matches('.vcp-tool-use-bubble'));
    assert.ok(edit.matches('[data-vcp-block-type="maid-diary-update"]'));
    assert.equal(edit.querySelector('.diary-update-before strong').textContent, '内容');
    assert.equal(edit.querySelector('.diary-update-after .diary-update-content').textContent.trim(), '新内容');
    assert.equal(JSON.stringify(calls), original);
});

test('unsupported DailyNote operations and malformed or external calls stay generic', t => {
    const dom = new JSDOM();
    t.after(() => dom.window.close());
    const batch = createHostedToolCallCard(dom.window.document, [
        diary('unknown', { command: 'remove', Content: 'example' }),
        diary('external', { command: 'create', Content: 'example' }, 'another_function'),
        diary('incomplete', { command: 'create' }),
        { id: 'invalid', function: { name: 'vcptools', arguments: '{' } },
    ]);
    assert.equal(batch.querySelectorAll('.vcp-tool-use-bubble').length, 4);
});