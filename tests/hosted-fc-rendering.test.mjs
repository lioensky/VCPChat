import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { renderHostedAssistantSegments } from '../modules/renderer/hostedToolCallRendering.js';

const { marked } = createRequire(import.meta.url)('marked');
const args = JSON.stringify({ tool_name: '<em>Lookup</em>', query: '<img src="test">' });
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
    assert.deepEqual([...root.children].map(node => node.classList.contains('vcp-hosted-tool-call-batch')
        ? [...node.querySelectorAll('details')].map(card => card.dataset.vcpToolCallId)
        : node.textContent), ['A', ['a', 'b'], '回执一', 'B', ['c'], '回执二', 'C']);
    assert.equal(root.querySelector('details pre').textContent, args);
    assert.match(root.querySelector('summary').textContent, /<em>Lookup<\/em>/);
    assert.equal(root.querySelector('details img, details em'), null);
});

test('FC-only and an unclosed source segment cannot swallow a hosted call', t => {
    const dom = new JSDOM();
    t.after(() => dom.window.close());
    const { document } = dom.window;
    const root = document.createElement('div');
    const fc = { tool_calls: [call('a')] };
    root.innerHTML = renderHostedAssistantSegments([fc], () => assert.fail('FC is not Markdown'), document);
    assert.equal(root.firstElementChild.querySelector('details').dataset.vcpToolCallId, 'a');
    for (const content of ['<pre>open', '<!-- open', '<textarea>open', '<plaintext>open']) {
        root.innerHTML = renderHostedAssistantSegments([{ content }, fc, { content: '<h2>after</h2>' }],
            source => source, document);
        assert.equal(root.querySelector('.vcp-hosted-tool-call-batch').parentElement, root);
        assert.equal(root.querySelector('h2').parentElement, root);
    }
});