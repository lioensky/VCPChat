import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { collectToolBatchRanges } from '../modules/renderer/toolBatchRegions.js';
import { sanitizeToolDataHtml } from '../modules/renderer/toolDataHtml.js';
import { splitToolBatchDomains, composeToolBatchHtml } from '../modules/renderer/toolBatchDomains.js';
import { replaceMarkdownCodeDomains } from '../modules/renderer/markdownCodeDomainScanner.js';
import {
    TOOL_RESULT_START_MARKER,
    TOOL_RESULT_END_MARKER,
    collectClosedToolResultRanges,
} from '../modules/renderer/toolResultRegions.js';
import { parseJevToolUse } from '../modules/renderer/jevToolUse.js';

// Placeholders are put back with String.prototype.replace. A string second
// argument expands $&, $', $` and $$, so code and formulas that contain them
// came back changed. These inputs must come back exactly as written.
const require = createRequire(import.meta.url);
const { marked } = require('marked');
const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const between = (source, start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from !== -1 && to !== -1, `missing ${start}`);
    return source.slice(from, to);
};

const shellCode = "```bash\nIFS=$'\\n'\nprintf '%s' \"$$\"\n```";
const jsCode = "```js\nconst escaped = s.replace(/[.*+?]/g, '\\\\$&');\n```";

test('text viewer keeps $ patterns inside code blocks', () => {
    const functions = between(read('../modules/text-viewer.js'), '    function generateUniqueId()', '    // --- End: Ported functions ---');
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    try {
        const render = new Function(
            'document', 'window', 'collectToolBatchRanges', 'sanitizeToolDataHtml',
            'replaceMarkdownCodeDomains', 'TOOL_RESULT_START_MARKER', 'TOOL_RESULT_END_MARKER',
            'collectClosedToolResultRanges', 'parseJevToolUse', 'splitToolBatchDomains', 'composeToolBatchHtml',
            functions + '\nreturn renderViewerContent;'
        )(dom.window.document, { marked }, collectToolBatchRanges, sanitizeToolDataHtml,
            replaceMarkdownCodeDomains, TOOL_RESULT_START_MARKER, TOOL_RESULT_END_MARKER,
            collectClosedToolResultRanges, parseJevToolUse, splitToolBatchDomains, composeToolBatchHtml);
        const root = dom.window.document.createElement('div');
        root.innerHTML = render(`前文\n\n${shellCode}\n\n${jsCode}\n\n后文`, 'viewer-dollar');
        const codes = [...root.querySelectorAll('pre code')].map(node => node.textContent);
        assert.deepEqual(codes, [
            "IFS=$'\\n'\nprintf '%s' \"$$\"\n",
            "const escaped = s.replace(/[.*+?]/g, '\\\\$&');\n",
        ]);
    } finally {
        dom.window.close();
    }
});

test('notes keep $ patterns inside protected html blocks', () => {
    const functions = between(read('../Notemodules/notes.js'), '  function deIndentHtml(text)', '  function renderMarkdown(markdown)');
    const preprocess = new Function(functions + '\nreturn preprocessFullContent;')();
    const block = "```html\n<script>const price = '$$5'; const tail = \"$'\";</script>\n```";
    assert.equal(preprocess(`前文\n\n${block}\n\n后文`), `前文\n\n${block}\n\n后文`);
});

const loadForum = () => {
    const forum = read('../Forummodules/forum.js');
    const functions = between(forum, 'function scopeSelector(', '// ===== End ported functions =====')
        + between(forum, 'function escapeHtml(', '// ========== Custom Dialog Functions ==========');
    return new Function(
        'window', 'marked',
        functions + '\nreturn { renderMarkdownWithProtectedMath, enhanceMarkdown };'
    )({ marked }, marked);
};

test('forum keeps $$ display math', () => {
    const { renderMarkdownWithProtectedMath } = loadForum();
    const html = renderMarkdownWithProtectedMath('质能方程：\n\n$$E = mc^2$$\n\n结束');
    assert.match(html, /<p>\$\$E = mc\^2\$\$<\/p>/);
});

test('forum keeps $ patterns inside code blocks', () => {
    const { enhanceMarkdown } = loadForum();
    const markdown = `说明\n\n${shellCode}\n\n${jsCode}\n`;
    assert.equal(enhanceMarkdown(markdown), markdown);
});
