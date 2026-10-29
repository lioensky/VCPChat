import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { collectToolBatchRanges } from '../modules/renderer/toolBatchRegions.js';
import { sanitizeToolDataHtml } from '../modules/renderer/toolDataHtml.js';
import { replaceMarkdownCodeDomains } from '../modules/renderer/markdownCodeDomainScanner.js';
import {
    TOOL_RESULT_START_MARKER,
    TOOL_RESULT_END_MARKER,
    collectClosedToolResultRanges,
} from '../modules/renderer/toolResultRegions.js';
import { parseJevToolUse } from '../modules/renderer/jevToolUse.js';

const require = createRequire(import.meta.url);
const { marked } = require('marked');
const source = readFileSync(new URL('../modules/text-viewer.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('    function generateUniqueId()'), source.indexOf('    // --- End: Ported functions ---'));

test('reading mode restores cards after Markdown without nested code or visible record IDs', () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    try {
        const render = new Function(
            'document', 'window', 'collectToolBatchRanges', 'sanitizeToolDataHtml',
            'replaceMarkdownCodeDomains', 'TOOL_RESULT_START_MARKER', 'TOOL_RESULT_END_MARKER',
            'collectClosedToolResultRanges', 'parseJevToolUse',
            functions + '\nreturn renderViewerContent;'
        )(dom.window.document, { marked }, collectToolBatchRanges, sanitizeToolDataHtml,
            replaceMarkdownCodeDomains, TOOL_RESULT_START_MARKER, TOOL_RESULT_END_MARKER,
            collectClosedToolResultRanges, parseJevToolUse);
        const id = '2026-10-29T12:51:34.979Z';
        const text = [
            '# 前文', '',
            `<<<[VCP_TOOL_BATCH_START:${id}]>>>`,
            '[[VCP调用结果信息汇总:',
            '- 工具名称: PowerShellExecutor',
            '- 执行状态: SUCCESS',
            '- 返回内容: 正常段落',
            '',
            '| A | B |', '| --- | --- |', '| 1 | 2 |',
            '', '```js', 'const value = 1;', '```',
            'VCP调用结果结束]]',
            '[本轮工具调用摘要:]PowerShellExecutor 调用成功 (记录ID: tcr-example)。[本轮工具调用摘要结束]',
            `<<<[VCP_TOOL_BATCH_END:${id}]>>>`,
            '', '## 后文',
        ].join('\n');
        const root = dom.window.document.createElement('div');
        root.innerHTML = render(text, 'viewer-test');
        const card = root.querySelector('.vcp-tool-result-bubble');
        assert.ok(card);
        assert.equal(card.closest('pre, code'), null);
        assert.equal(root.querySelector('pre pre, code code'), null);
        assert.equal(root.querySelectorAll('pre').length, 1);
        assert.equal(card.querySelectorAll('table').length, 1);
        assert.match(card.querySelector('pre code').textContent, /const value = 1/);
        assert.equal(root.querySelectorAll('.vcp-tool-call-summary-chip.status-success').length, 1);
        assert.doesNotMatch(root.textContent, /tcr-example|VCP_TOOL_BATCH|VCPVIEWERBATCH/);
        assert.match(root.querySelector('h2').textContent, /后文/);
        assert.match(text, /tcr-example/);
    } finally {
        dom.window.close();
    }
});