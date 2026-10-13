import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectMarkdownCodeDomains } from '../modules/renderer/markdownCodeDomainScanner.js';

const moduleUrl = new URL('../modules/renderer/streamManager.js', import.meta.url);
let source = fs.readFileSync(moduleUrl, 'utf8');
source = source.replace(/from\s+(['"])(\.[^'"]+)\1/g,
    (_, quote, relative) => `from ${quote}${new URL(relative, moduleUrl).href}${quote}`);
source = source.replace(/    attachStreamProjection,\r?\n/,
    '    probeStable: findExplicitStablePrefix,\n    attachStreamProjection,\n');
const { createStreamProjection } = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const scan = createStreamProjection().probeStable;
assert.equal(typeof scan, 'function');

test('complete emoticons never capture subsequent protocols or inline code', () => {
    for (const face of ['(`・ω・´)ゞ', '(・`ω´・)', '(`･ω･´)']) {
        const text = `正文 ${face}\n\n<<<[ROLE_DIVIDE_USER]>>>\n内容\n<<<[END_ROLE_DIVIDE_USER]>>>\n\n后文 \`<style>\`。`;
        const domains = collectMarkdownCodeDomains(text, { includeUnclosedInline: true });
        assert.equal(domains.length, 1);
        assert.equal(text.slice(domains[0].start, domains[0].end), '`<style>`');
        assert.ok(scan(text) > 0);
    }
});

test('inline code may cross a line but never a paragraph boundary', () => {
    assert.equal(collectMarkdownCodeDomains('`a\nb`').length, 1);
    assert.equal(collectMarkdownCodeDomains('`a\n\nb`').length, 0);
    assert.equal(collectMarkdownCodeDomains('`a\r\n \r\nb`').length, 0);
    assert.equal(collectMarkdownCodeDomains('`unfinished', { includeUnclosedInline: true })[0].closed, false);
});

test('unfinished structures do not suppress preceding safe paragraphs', () => {
    for (const tail of ['`unfinished', '```js\nx', '<div>\n---\n```js\nx\n```\n']) {
        assert.equal(scan('A\n\nB\n\n' + tail), 3);
    }
});

test('outer div owns inner explicit delimiters and code-looking text', () => {
    assert.equal(scan('<div>\nA\n---\nB'), 0);
    assert.equal(scan('<div>\n```js\nx\n```\nB'), 0);
    const island = '<div>\n```js\nx\n```\n</div>';
    assert.equal(scan(island), island.length);
    assert.equal(scan('```html\n<div>\n'), 0);
});

test('CRLF and comparisons allow paragraph stabilization', () => {
    assert.equal(scan('A\r\n\r\nB\r\n\r\nC'), 5);
    assert.equal(scan('a < b\n\nsecond\n\nthird'), 7);
});

test('EOF fence closing line cannot commit until newline seals it', () => {
    const prefix = '```js\nx\n```';
    assert.equal(scan(prefix), 0);
    assert.equal(scan(prefix + 'oops'), 0);
    assert.equal(scan(prefix + '\n'), prefix.length + 1);
    assert.equal(scan('---'), 0);
});

test('char-wise emoticon output resumes stable progress and preserves monotonic cutoffs', () => {
    const text = 'A “quote” @tag\n\nB\n\n(`・ω・´)ゞ\n\n---\n\nC\n\nD';
    let cutoff = 0;
    for (let end = 1; end <= text.length; end++) {
        const next = scan(text.slice(0, end), cutoff);
        assert.ok(next >= cutoff && next <= end);
        cutoff = next;
    }
    assert.ok(cutoff > text.indexOf('ゞ'));
});

test('atomic role receipt commits through the last standalone USER end line', () => {
    const end = '<<<[END_ROLE_DIVIDE_USER]>>>';
    const receipt = '<<<[ROLE_DIVIDE_USER]>>>\n'
        + '[[VCP调用结果信息汇总:\n工具载荷中的定位符:\n'
        + end + '\n更多工具内容\nVCP调用结果结束]]\n'
        + '[本轮工具调用摘要:]成功[本轮工具调用摘要结束]\n'
        + end + '\n';
    assert.equal(scan(receipt + '模型继续输出'), receipt.length);
});

test('trusted receipt seal overrides unmatched payload syntax only for stabilization', () => {
    const end = '<<<[END_ROLE_DIVIDE_USER]>>>';
    for (const payload of [
        '[[VCP调用结果信息汇总:\n[[VCP调用结果信息汇总:\n不配对字面量\nVCP调用结果结束]]',
        '```js\n未闭合围栏',
        '<div>\n未闭合 HTML',
    ]) {
        const receipt = payload + '\n' + end + '\n';
        assert.equal(scan(receipt + '后续正文'), receipt.length);
    }
});

test('standalone receipt seal requires a completed line and rejects inline mentions', () => {
    const end = '<<<[END_ROLE_DIVIDE_USER]>>>';
    assert.equal(scan(end), 0);
    assert.equal(scan(end + '不是独立行\n'), 0);
    assert.equal(scan('引用 ' + end + '\n'), 0);
    const paddedLine = ' \t' + end + ' \t\r\n';
    assert.equal(scan(paddedLine), paddedLine.length);
});

test('trusted receipt cutoff stays monotonic during subsequent model output', () => {
    const receipt = '工具回执\n<<<[END_ROLE_DIVIDE_USER]>>>\n';
    let cutoff = scan(receipt);
    assert.equal(cutoff, receipt.length);
    for (const tail of ['后', '后文\n\n第二段\n\n第三段', '后文\n\n第二段\n\n第三段`未闭合']) {
        const text = receipt + tail;
        const next = scan(text, cutoff);
        assert.ok(next >= cutoff && next <= text.length);
        cutoff = next;
    }
});