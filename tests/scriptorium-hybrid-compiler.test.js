'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.marked = require('marked');

const compiler = require('../ScriptoriumModules/vdoc-hybrid-compiler.js');

function run() {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'test.md'),
        'utf8'
    );
    const compiled = compiler.compile(source);

    assert.equal(compiled.format, 'markdown-hybrid');
    assert.equal(compiled.source, source, 'compiler must preserve source byte-for-byte');
    assert.equal(compiled.sourceHash, compiler.simpleHash(source));
    assert.equal(compiled.islands.length, 3);
    assert.deepEqual(
        compiled.islands.map((island) => island.id),
        [
            'anime-orbit-garden',
            'three-dimensional-text-card',
            'interactive-paginated-table',
        ]
    );
    assert(compiled.islands.every((island) => island.closed));
    assert.deepEqual(compiled.dependencies, ['anime']);
    assert.equal(
        compiled.diagnostics.filter((item) => item.level === 'refuse').length,
        0
    );
    assert.equal((compiled.html.match(/data-vdoc-math=/g) || []).length, 3);
    assert.equal((compiled.html.match(/data-vdoc-mermaid=/g) || []).length, 1);
    assert.match(compiled.html, /<h2>8\. 最后一段 Markdown<\/h2>/);
    assert.match(
        compiled.html,
        /文档的最后一段仍然是普通 Markdown/
    );
    assert.doesNotMatch(
        compiled.html,
        /data-vdoc-(?:text|block|container)=/,
        'ordinary Markdown blocks must not receive persistent editing IDs'
    );
    assert(
        compiled.blocks.some((block) => block.type === 'markdown')
        && compiled.blocks.some((block) => block.type === 'island')
        && compiled.blocks.some((block) => block.type === 'mermaid')
        && compiled.blocks.some((block) => block.type === 'math-inline')
        && compiled.blocks.some((block) => block.type === 'math-display'),
        'temporary block index should describe every syntax domain present in test.md'
    );
    compiled.blocks.forEach((block, index) => {
        assert(block.sourceRange.start >= 0);
        assert(block.sourceRange.end <= source.length);
        assert(block.sourceRange.end >= block.sourceRange.start);
        if (index) {
            assert(
                block.sourceRange.start >= compiled.blocks[index - 1].sourceRange.end,
                'temporary source ranges must be ordered and non-overlapping'
            );
        }
        assert.equal(
            compiler.simpleHash(source.slice(
                block.sourceRange.start,
                block.sourceRange.end
            )),
            block.sourceHash,
            'block hash must describe the exact original source range'
        );
    });

    const isolatedCode = [
        '```javascript',
        'const price = "$not_math$";',
        '```',
        '',
        '正文公式 $x + 1$。',
    ].join('\n');
    const isolated = compiler.compile(isolatedCode);
    assert.equal(
        (isolated.html.match(/data-vdoc-math=/g) || []).length,
        1,
        'LaTeX scanner must not inspect fenced code'
    );
    assert.match(isolated.html, /\$not_math\$/);
    assert(
        isolated.blocks.some((block) => block.type === 'code'),
        'ordinary fenced code must receive a code block index entry'
    );

    const blockSource = [
        '# 标题',
        '',
        '- 列表一',
        '- 列表二',
        '',
        '> 引用第一行',
        '> 引用第二行',
        '',
        '| 名称 | 分数 |',
        '| --- | ---: |',
        '| 琥珀 | 98 |',
        '',
        '<section class="static-card">',
        '    <strong>静态 HTML</strong>',
        '</section>',
        '',
        '结尾段落。',
    ].join('\n');
    const blockCompiled = compiler.compile(blockSource);
    const tokenRegions = blockCompiled.editRegions.filter((region) =>
        region.markdownTokenType
    );
    assert(
        tokenRegions.some((region) => region.markdownTokenType === 'heading'),
        'heading should receive its own lexer-backed edit region'
    );
    assert(
        tokenRegions.some((region) =>
            region.markdownTokenType === 'list'
            && blockSource.slice(
                region.sourceRange.start,
                region.sourceRange.end
            ).includes('- 列表二')
        ),
        'a continuous Markdown list must remain one edit region'
    );
    assert(
        tokenRegions.some((region) =>
            region.markdownTokenType === 'blockquote'
            && blockSource.slice(
                region.sourceRange.start,
                region.sourceRange.end
            ).includes('> 引用第二行')
        ),
        'a continuous blockquote must remain one edit region'
    );
    assert(
        tokenRegions.some((region) => region.markdownTokenType === 'table'),
        'a GFM table must receive one lexer-backed edit region'
    );
    assert(
        tokenRegions.some((region) =>
            region.type === 'html'
            && region.markdownTokenType === 'html'
        ),
        'a static HTML block must be classified as an HTML edit domain'
    );
    assert.equal(
        blockCompiled.diagnostics.some((item) =>
            item.ruleId === 'markdown-edit-region-lex-failed'
        ),
        false,
        'valid Markdown must not fall back to blank-line edit boundaries'
    );
    blockCompiled.editRegions.forEach((region, index) => {
        const raw = blockSource.slice(
            region.sourceRange.start,
            region.sourceRange.end
        );
        assert(raw.trim(), 'edit regions must not contain whitespace only');
        assert.equal(
            compiler.simpleHash(raw),
            region.sourceHash,
            'edit region hashes must cover exact source ranges'
        );
        if (index) {
            assert(
                region.sourceRange.start
                    >= blockCompiled.editRegions[index - 1].sourceRange.end,
                'edit regions must be ordered and non-overlapping'
            );
        }
    });

    const duplicated = compiler.validate([
        '<div data-vdoc-island="same"></div>',
        '',
        '<div data-vdoc-island="same"></div>',
    ].join('\n'));
    assert.equal(duplicated.valid, false);
    assert(
        duplicated.diagnostics.some((item) =>
            item.ruleId === 'island-id-duplicate'
        )
    );

    const unclosed = compiler.validate(
        '<div data-vdoc-island="broken"><div>内容</div>'
    );
    assert.equal(unclosed.valid, false);
    assert(
        unclosed.diagnostics.some((item) =>
            item.ruleId === 'island-unclosed'
        )
    );

    console.log('[ScriptoriumHybridCompiler] PASSED', {
        blocks: compiled.blocks.length,
        islands: compiled.islands.length,
        math: (compiled.html.match(/data-vdoc-math=/g) || []).length,
        mermaid: (compiled.html.match(/data-vdoc-mermaid=/g) || []).length,
    });
}

try {
    run();
} catch (error) {
    console.error('[ScriptoriumHybridCompiler] FAILED', error);
    process.exitCode = 1;
}