import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Marked } from 'marked';
import { applyMarkdownPolicy, bareLinkEnd, hasOnlyMarkdownPolicyTokenizer, markdownWorkerOptions } from '../modules/renderer/markdownPolicy.js';
import { compileRenderJob } from '../modules/renderer/renderWorkerRuntime.js';

const realm = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../vendor/marked.min.js', import.meta.url), 'utf8'), realm);
const links = html => [...html.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(([, href, label]) => [href, label]);

const cases = [
    ['Jina 封了 www.microsoft.com，没能核对。', [['http://www.microsoft.com', 'www.microsoft.com']]],
    ['看 https://example.com/a?b=1，然后继续。', [['https://example.com/a?b=1', 'https://example.com/a?b=1']]],
    ['原文在 https://arxiv.org/abs/2605.23904。后面这句不是链接。', [['https://arxiv.org/abs/2605.23904', 'https://arxiv.org/abs/2605.23904']]],
    ['链接（https://x.org/p）后面', [['https://x.org/p', 'https://x.org/p']]],
    ['见“https://x.org/q”。', [['https://x.org/q', 'https://x.org/q']]],
    ['见 https://example.com后面直接是中文', [['https://example.com', 'https://example.com']]],
    ['中文路径 https://zh.wikipedia.org/wiki/中文 保留', [['https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87', 'https://zh.wikipedia.org/wiki/中文']]],
    ['English https://example.com/path, then text.', [['https://example.com/path', 'https://example.com/path']]],
    ['mail me@x.com，好', [['mailto:me@x.com', 'me@x.com']]],
    ['[标题](https://example.com/中文，说明) 写法不受影响', [['https://example.com/%E4%B8%AD%E6%96%87%EF%BC%8C%E8%AF%B4%E6%98%8E', '标题']]],
];

for (const [name, Constructor] of [['npm', Marked], ['vendor', realm.marked.Marked]]) {
    test(`${name}: a bare link in Chinese text ends at sentence punctuation`, () => {
        const parser = applyMarkdownPolicy(new Constructor({ gfm: true, breaks: true }));
        for (const [text, expected] of cases) assert.deepEqual(links(parser.parse(text)), expected, text);
        assert.equal(hasOnlyMarkdownPolicyTokenizer(parser), true, 'the policy alone still allows the Worker path');
        assert.doesNotThrow(() => structuredClone(markdownWorkerOptions(parser)));
    });
}

test('a CJK character inside the host name ends the link', () => {
    assert.equal(bareLinkEnd('www.例子.com/x'), 4);
    assert.equal(bareLinkEnd('https://example.com/路径，后文'), 'https://example.com/路径'.length);
});

test('real Worker compiler applies the same link end', async () => {
    const result = await compileRenderJob({
        text: '我查了一下，Jina 封了 www.microsoft.com，没能核对。两个号暂时都不写定。',
        markdown: { gfm: true, breaks: true },
    });
    assert.deepEqual(links(result.parts.join('')), [['http://www.microsoft.com', 'www.microsoft.com']]);
});
