import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import searchManager from '../modules/searchManager.js';

const payload = '<style>.tool-payload { color: red }</style><script>window.leaked = true</script><img src="bad" onerror="window.leaked = true"><iframe srcdoc="bad"></iframe>';
const request = body => `<<<[TOOL_REQUEST]>>>\ntool_name:「始」Demo「末」,\ncontent:「始ESCAPE」${body}「末ESCAPE」\n<<<[END_TOOL_REQUEST]>>>`;
const result = body => `[[VCP调用结果信息汇总:\n${body}\nVCP调用结果结束]]`;

function fixture(t) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="results"></div><div id="pages"></div></body></html>');
    const oldDocument = globalThis.document;
    const oldFilter = globalThis.NodeFilter;
    globalThis.document = dom.window.document;
    globalThis.NodeFilter = dom.window.NodeFilter;
    t.after(() => {
        globalThis.document = oldDocument;
        globalThis.NodeFilter = oldFilter;
        dom.window.close();
    });
    const manager = {
        ...searchManager,
        elements: {
            resultsContainer: document.getElementById('results'),
            paginationContainer: document.getElementById('pages'),
        },
        state: { ...searchManager.state, currentQuery: 'tool-payload', searchResults: [] },
    };
    return { manager, dom };
}

const cases = {
    'tool request': request(payload),
    'tool result': result(payload),
    'nested tool result': result(result(payload) + payload),
    'request with literal end marker in ESCAPE field': request('<<<[END_TOOL_REQUEST]>>>' + payload),
    'unclosed request': '<<<[TOOL_REQUEST]>>>\ncontent:「始ESCAPE」' + payload,
    'unclosed result': '[[VCP调用结果信息汇总:' + payload,
    'atomic batch': '<<<[VCP_TOOL_BATCH_START:123]>>>' + payload + '<<<[VCP_TOOL_BATCH_END:123]>>>',
    'unclosed atomic batch': '<<<[VCP_TOOL_BATCH_START:123]>>>' + payload,
    'tilde code fence': '~~~html\n' + payload + '\n~~~',
    'long backtick fence': '````html\n```\n' + payload + '\n````',
    'unclosed code fence': '```html\n' + payload,
    'inline code': '`' + payload + '`',
};

for (const [name, source] of Object.entries(cases)) {
    test(`search seals ${name} before DOM insertion and CSS extraction`, t => {
        const { manager, dom } = fixture(t);
        manager.state.searchResults = [{
            role: 'assistant', content: source,
            context: { itemName: 'Demo', topicName: 'Topic' },
        }];
        manager.renderSearchResults();
        const root = manager.elements.resultsContainer;
        assert.equal(root.querySelector('script, style, img, iframe, [onerror]'), null);
        assert.equal(document.head.querySelector('style'), null);
        assert.equal(root.querySelector('code').textContent, source);
        assert.equal(root.querySelector('.search-highlight').textContent, 'tool-payload');
        assert.equal(dom.window.leaked, undefined);
    });
}

test('search retains ordinary HTML outside sealed tools and cleans scoped styles', t => {
    const { manager } = fixture(t);
    const source = '<b>before</b>' + request(payload) + '<style>.ordinary { color: blue }</style><i class="ordinary">after</i>';
    const html = manager.renderSearchContent(source, 'search-test');
    const root = document.createElement('div');
    root.innerHTML = html;
    assert.equal(root.querySelector('b').textContent, 'before');
    assert.equal(root.querySelector('i').textContent, 'after');
    assert.equal(root.querySelector('code').textContent, request(payload));
    const css = document.head.textContent;
    assert.ok(css.includes('ordinary'));
    assert.ok(!css.includes('tool-payload'));
    manager.clearScopedStyles();
    assert.equal(document.head.querySelector('style'), null);
});