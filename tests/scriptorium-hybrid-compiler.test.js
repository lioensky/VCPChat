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

    const styleRegions = compiled.editRegions.filter((region) =>
        region.type === 'style'
    );
    assert.equal(
        styleRegions.length,
        1,
        'the complete top-level style element must remain one atomic edit region'
    );
    const styleSource = source.slice(
        styleRegions[0].sourceRange.start,
        styleRegions[0].sourceRange.end
    );
    assert.match(styleSource, /^<style>[\s\S]*<\/style>$/);
    assert.match(styleSource, /#ultimate-test-title/);
    assert.match(styleSource, /\.vdoc-test-signature/);
    assert.match(
        compiled.previewHtml,
        /data-vdoc-edit-type="style"[^>]*><style>[\s\S]*#ultimate-test-title[\s\S]*\.vdoc-test-signature[\s\S]*<\/style><\/div>/,
        'style edit regions may carry additional flow metadata while remaining atomic'
    );
    assert.doesNotMatch(
        compiled.previewHtml,
        /data-vdoc-edit-type="markdown"><p>#ultimate-test-title/,
        'CSS rules must not leak into visible Markdown paragraphs'
    );

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
    const markdownRegions = blockCompiled.editRegions.filter((region) =>
        region.type === 'markdown'
    );
    assert(
        markdownRegions.some((region) => {
            const raw = blockSource.slice(
                region.sourceRange.start,
                region.sourceRange.end
            );
            return raw.includes('# 标题')
                && raw.includes('- 列表二')
                && raw.includes('> 引用第二行')
                && raw.includes('| 琥珀 | 98 |');
        }),
        'adjacent Markdown tokens must form one stable editable source stream'
    );
    assert(
        blockCompiled.editRegions.some((region) =>
            region.type === 'html'
            && region.markdownTokenType === 'html'
        ),
        'a static HTML block must remain an independent HTML edit domain'
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
        assert(
            raw.trim()
            || (region.type === 'markdown' && /[\r\n]/.test(raw)),
            'only Markdown source-line regions may contain pure line breaks'
        );
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

    const projectedSource = [
        '> 第一条引用',
        '',
        '> **岛闭合规则：** 根 `<div>` 到 `</div>`',
        '',
        '普通段落',
    ].join('\n');
    const projected = compiler.compile(projectedSource);
    assert.equal(
        projected.source,
        projectedSource,
        'source-line projection must preserve original Markdown byte-for-byte'
    );
    assert.equal(
        (projected.previewHtml.match(/<blockquote>/g) || []).length,
        2,
        'blank-line projection must not turn later blockquotes into raw text'
    );
    assert.match(
        projected.previewHtml,
        /<blockquote>[\s\S]*<strong>岛闭合规则：<\/strong>[\s\S]*<\/blockquote>/,
        'complex quote semantics must survive blank-line projection'
    );
    assert.equal(
        (projected.previewHtml.match(/<code>/g) || []).length,
        2,
        'code spans containing HTML-like text must remain semantic code nodes'
    );
    assert(
        projected.previewHtml.includes('&' + 'lt;div&' + 'gt;')
        && projected.previewHtml.includes('&' + 'lt;/div&' + 'gt;'),
        'HTML-like code text must remain escaped'
    );
    assert.match(
        projected.previewHtml,
        /<p>普通段落<\/p>/,
        'Markdown following a projected blank line must still be parsed'
    );
    assert.equal(
        (
            projected.previewHtml.match(
                /data-vdoc-source-blank-line="true"/g
            ) || []
        ).length,
        2,
        'each source blank line must receive exactly one derived visual node'
    );

    const htmlSeparatedSource = [
        '<h1>标题一</h1>',
        '',
        '',
        '<h2>标题二</h2>',
    ].join('\n');
    const htmlSeparated = compiler.compile(htmlSeparatedSource);
    const pureLineRegion = htmlSeparated.editRegions.find((region) => {
        const raw = htmlSeparatedSource.slice(
            region.sourceRange.start,
            region.sourceRange.end
        );
        return region.type === 'markdown'
            && !raw.trim()
            && (raw.match(/\n/g) || []).length === 3;
    });
    assert(
        pureLineRegion,
        'pure line breaks between HTML domains must remain an editable region'
    );

    const livePreviewSource = [
        '## 标题',
        '> 引用',
        '- 列表',
        '1. 有序列表',
        '- [x] 已完成任务',
        '',
        '**粗体**、*斜体*、~~删除线~~、`**代码内星号**`。',
        String.raw`\*转义星号\*`,
    ].join('\n');
    const liveMarkers = compiler.markdownLiveMarkerRanges(livePreviewSource);
    const markersByKind = (kind) => liveMarkers.filter((marker) =>
        marker.kind === kind
    );
    assert.equal(markersByKind('heading').length, 1);
    assert.equal(markersByKind('quote').length, 1);
    assert.equal(markersByKind('list').length, 2);
    assert.equal(markersByKind('task-list').length, 1);
    assert.equal(markersByKind('strong').length, 2);
    assert.equal(markersByKind('emphasis').length, 2);
    assert.equal(markersByKind('strikethrough').length, 2);
    assert.equal(markersByKind('code').length, 2);
    liveMarkers.forEach((marker, index) => {
        assert(marker.end > marker.start);
        assert.equal(
            marker.delimiter,
            livePreviewSource.slice(marker.start, marker.end),
            'Live Preview markers must reference exact source characters'
        );
        if (index) {
            assert(
                marker.start >= liveMarkers[index - 1].end,
                'Live Preview marker ranges must be ordered and non-overlapping'
            );
        }
    });
    const codeLiteralStart = livePreviewSource.indexOf('**代码内星号**');
    const codeLiteralEnd = codeLiteralStart + '**代码内星号**'.length;
    assert.equal(
        liveMarkers.some((marker) =>
            marker.kind === 'strong'
            && marker.start >= codeLiteralStart
            && marker.end <= codeLiteralEnd
        ),
        false,
        'inline code content must not expose nested emphasis markers'
    );
    const escapedStart = livePreviewSource.indexOf(String.raw`\*转义星号\*`);
    assert.equal(
        liveMarkers.some((marker) =>
            marker.kind === 'emphasis' && marker.start >= escapedStart
        ),
        false,
        'escaped delimiters must remain ordinary source characters'
    );
    assert.doesNotMatch(
        compiler.compile(livePreviewSource).previewHtml,
        /vdoc-md-marker/,
        'Live Preview decoration must never leak into compiled preview HTML'
    );

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