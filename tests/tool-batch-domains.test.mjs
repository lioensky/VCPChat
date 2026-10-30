import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { splitToolBatchDomains, transformToolBatchText, composeToolBatchHtml } from '../modules/renderer/toolBatchDomains.js';

const { marked } = createRequire(import.meta.url)('marked');
const batch = '<<<[VCP_TOOL_BATCH_START:offset+08:00]>>>inside<<<[VCP_TOOL_BATCH_END:offset+08:00]>>>';

test('domains preserve raw bytes and authorized role shells without sharing regex state', () => {
    const source = 'BEGIN\n<<<[ROLE_DIVIDE_USER]>>>\n' + batch + '\n<<<[END_ROLE_DIVIDE_USER]>>>\nEND';
    const domains = splitToolBatchDomains(source);
    assert.deepEqual(domains.map(domain => domain.type), ['text', 'role', 'batch', 'role', 'text']);
    assert.equal(domains.map(domain => domain.source).join(''), source);
    assert.equal(transformToolBatchText(source, text => text.replace(/BEGIN[\s\S]*END/g, 'wrong').replace(/inside/g, 'wrong')), source);
    assert.equal(transformToolBatchText(source, text => text.replace(/BEGIN/g, 'changed')).includes('changed'), true);
});

test('each HTML fragment closes before composition even for comments and raw text elements', () => {
    const dom = new JSDOM();
    try {
        for (const opener of ['<pre>before', '<!-- before', '<style>before', '<script>before', '<textarea>before', '<plaintext>before', '<div><b>before']) {
            const domains = splitToolBatchDomains(opener + batch + '<h2>after</h2>');
            const html = composeToolBatchHtml(domains, domain => domain.type === 'batch'
                ? '<div class="receipt">receipt</div>' : domain.source, dom.window.document);
            const root = dom.window.document.createElement('div');
            root.innerHTML = html;
            assert.equal(root.querySelector('.receipt')?.parentElement, root, opener);
            assert.equal(root.querySelector('h2')?.parentElement, root, opener);
        }
    } finally {
        dom.window.close();
    }
});

test('Markdown fences, emphasis and math-like delimiters cannot pair across batches', () => {
    const dom = new JSDOM();
    try {
        for (const [before, after] of [['```js\nbefore\n', '\n```\n'], ['`before', 'after`'], ['**before', 'after**']]) {
            const parsed = [];
            const html = composeToolBatchHtml(splitToolBatchDomains(before + batch + after), domain => {
                if (domain.type === 'batch') return '<div class="receipt">receipt</div>';
                parsed.push(domain.source);
                return marked.parse(domain.source);
            }, dom.window.document);
            assert.deepEqual(parsed, [before, after]);
            const root = dom.window.document.createElement('div');
            root.innerHTML = html;
            assert.equal(root.querySelector('.receipt').closest('pre, code, strong'), null);
        }
        assert.equal(transformToolBatchText('$$before' + batch + 'after$$',
            text => text.replace(/\$\$[\s\S]*?\$\$/g, 'wrong')), '$$before' + batch + 'after$$');
        assert.throws(() => composeToolBatchHtml([], () => '', null), TypeError);
    } finally {
        dom.window.close();
    }
});