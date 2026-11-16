import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Marked } from 'marked';
import { applyMarkdownPolicy, hasOnlyMarkdownPolicyTokenizer, markdownWorkerOptions } from '../modules/renderer/markdownPolicy.js';
import { createContentProcessor } from '../modules/renderer/contentProcessor.js';
import { createContentPipeline, PIPELINE_MODES } from '../modules/renderer/contentPipeline.js';
import { compileRenderJob } from '../modules/renderer/renderWorkerRuntime.js';

const realm = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../vendor/marked.min.js', import.meta.url), 'utf8'), realm);
const url = 'http://example.com/images/Kerr表情包/耶~.png';
const image = `<img src="${url}" width="85">`;

for (const [name, Constructor] of [['npm', Marked], ['vendor', realm.marked.Marked]]) {
    test(`${name}: single tildes stay literal; double tildes retain Markdown`, () => {
        const parser = applyMarkdownPolicy(new Constructor({ gfm: true }));
        const first = parser.defaults.tokenizer;
        applyMarkdownPolicy(parser);
        assert.equal(parser.defaults.tokenizer, first);
        assert.equal(parser.parse('~文本~').trim(), '<p>~文本~</p>');
        assert.match(parser.parse('~~文本~~'), /<del>文本<\/del>/);
        assert.doesNotMatch(parser.parse('~a~ ~~b~~ ~c~'), /<del>a|<del>c/);
        assert.match(parser.parse('~~**bold**~~'), /<del><strong>bold<\/strong><\/del>/);
        assert.ok(parser.parse(image).includes(url));
        assert.ok(parser.parse('`耶~.png`').includes('<code>耶~.png</code>'));
        assert.ok(parser.parse('```txt\n耶~.png\n```').includes('耶~.png'));
        assert.ok(parser.parse('[link](https://example.com/a~b?q=~x~)').includes('https://example.com/a~b?q=~x~'));
        assert.match(parser.parse('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>/);
        assert.equal(hasOnlyMarkdownPolicyTokenizer(parser), true);
        assert.doesNotThrow(() => structuredClone(markdownWorkerOptions(parser)));
        parser.use({ tokenizer: { codespan() { return false; } } });
        assert.equal(hasOnlyMarkdownPolicyTokenizer(parser), false);
    });
}

test('common preprocessing never inserts spaces into tilde source', () => {
    const processor = createContentProcessor();
    assert.equal(processor.applyContentProcessors(image), image);
});

test('real Worker compiler keeps image URL and applies double-tilde policy', async () => {
    const result = await compileRenderJob({
        text: `~文本~ ~~删除~~\n\n${image}`,
        markdown: { gfm: true, breaks: true },
    });
    const html = result.parts.join('');
    assert.ok(html.includes('~文本~'));
    assert.match(html, /<del>删除<\/del>/);
    assert.ok(html.includes(url));
    assert.ok(!html.includes('耶~ .png'));
});
test('stream-fast and full pipeline preserve tilde-bearing image attributes', () => {
    const processor = createContentProcessor();
    const pipeline = createContentPipeline({
        applyContentProcessors: processor.applyContentProcessors,
    });
    for (const mode of [PIPELINE_MODES.STREAM_FAST, PIPELINE_MODES.FULL_RENDER]) {
        const result = pipeline.process(image, { mode });
        assert.ok(result.text.includes(url), `${mode} must preserve URL`);
        assert.ok(!result.text.includes('耶~ .png'));
    }
});