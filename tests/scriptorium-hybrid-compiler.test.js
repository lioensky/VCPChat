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
    assert.deepEqual(
        compiled.dependencies,
        ['anime', 'three'],
        'fixture declares both Anime.js and Three.js programmable-island dependencies'
    );
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

    const mixedHeadingSource = [
        '# Markdown 总章',
        '',
        '总章导语。',
        '',
        'Setext 子章',
        '-----------',
        '',
        '子章正文。',
        '',
        '<h3 class="native-heading">HTML 小节 <em>强调</em></h3>',
        '',
        'HTML 小节正文。',
        '',
        '```html',
        '<h1>代码示例不是章节</h1>',
        '```',
        '',
        '<style>',
        'h1::before { content: "<h1>样式不是章节</h1>"; }',
        '</style>',
        '',
        '<div data-vdoc-island="chapter-widget">',
        '    <h2>岛内章节标题</h2>',
        '    <p>岛内正文。</p>',
        '</div>',
        '',
        '# 下一总章',
        '',
        '结尾。',
    ].join('\n');
    const mixedHeadings = compiler.compile(mixedHeadingSource).headings;
    assert.deepEqual(
        mixedHeadings.map(({ level, text }) => ({ level, text })),
        [
            { level: 1, text: 'Markdown 总章' },
            { level: 2, text: 'Setext 子章' },
            { level: 3, text: 'HTML 小节 强调' },
            { level: 2, text: '岛内章节标题' },
            { level: 1, text: '下一总章' },
        ],
        'Markdown、Setext 和真实 HTML 标题必须形成同一份语义目录'
    );
    assert.equal(
        mixedHeadings.some((heading) =>
            /代码示例|样式不是章节/.test(heading.text)
        ),
        false,
        '代码围栏和样式内容中的伪标题不得进入目录'
    );
    mixedHeadings.forEach((heading, index) => {
        assert.equal(heading.index, index);
        assert(heading.id);
        assert(heading.startLine >= 1);
        assert(heading.endLine >= heading.startLine);
        assert(heading.characterCount > 0);
        assert(heading.contentCharacterCount >= 0);
        assert(
            heading.sourceRange.end > heading.sourceRange.start,
            '每个目录项必须携带可直接读取的章节源码范围'
        );
        assert.equal(
            mixedHeadingSource.slice(
                heading.headingRange.start,
                heading.headingRange.end
            ).includes(heading.text.split(' ')[0]),
            true
        );
    });
    assert.equal(
        mixedHeadingSource.slice(
            mixedHeadings[0].sourceRange.start,
            mixedHeadings[0].sourceRange.end
        ).includes('# 下一总章'),
        false,
        '一级章节范围必须在下一个同级标题前结束'
    );
    assert.equal(
        mixedHeadingSource.slice(
            mixedHeadings[0].sourceRange.start,
            mixedHeadings[0].sourceRange.end
        ).includes('岛内章节标题'),
        true,
        '上级章节范围应包含其下属标题'
    );
    assert.equal(
        mixedHeadingSource.slice(
            mixedHeadings[1].sourceRange.start,
            mixedHeadings[1].sourceRange.end
        ).includes('岛内章节标题'),
        false,
        '同级章节范围必须在下一个同级标题前结束'
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

    const paragraphBreakSource = [
        '短尾',
        '↵',
        '↵',
        '下一行',
    ].join('\n');
    const paragraphBreakCompiled = compiler.compile(paragraphBreakSource);
    assert.equal(
        paragraphBreakCompiled.source,
        paragraphBreakSource,
        '显式回车占位协议不得改写原始 Markdown 源码'
    );
    assert.equal(
        (
            paragraphBreakCompiled.html.match(
                /data-vdoc-paragraph-break-placeholder="true"/g
            ) || []
        ).length,
        2,
        '每个独占行 ↵ 都必须编译为一个可圈选的回车占位节点'
    );
    assert.equal(
        (paragraphBreakCompiled.html.match(/<br\s*\/?>/g) || []).length,
        3,
        '连续 ↵ 行必须绕过 Markdown 空白归一化并保留全部真换行'
    );
    assert.match(
        paragraphBreakCompiled.html,
        /data-vdoc-paragraph-break-placeholder="true"[^>]*>↵<\/span>/,
        '渲染态必须保留真实 ↵ 文本，使拖选和源码使用相同语义'
    );
    assert.equal(
        compiler.markdownLiveMarkerRanges(paragraphBreakSource)
            .filter((marker) => marker.kind === 'paragraph-break').length,
        2,
        '编辑态必须为每个独占行 ↵ 建立精确源码标记'
    );
    const literalParagraphSign = compiler.compile('正文↵符号');
    assert.doesNotMatch(
        literalParagraphSign.html,
        /data-vdoc-paragraph-break-placeholder/,
        '正文中的普通 ↵ 不得被误判为回车占位符'
    );
    assert.match(literalParagraphSign.html, /正文↵符号/);

    const inlineHtmlLiteralSource = [
        '正文说明：`<style>`、`<div data-vdoc-island="fake">fake</div>` 都是代码字面量。',
        '',
        '<style>',
        '.real-style { color: green; }',
        '</style>',
        '',
        '<div data-vdoc-island="real-island">',
        '    <div class="real-style">真实岛</div>',
        '</div>',
    ].join('\n');
    const inlineHtmlLiteralCompiled = compiler.compile(inlineHtmlLiteralSource);
    assert.deepEqual(
        inlineHtmlLiteralCompiled.islands.map((island) => island.id),
        ['real-island'],
        'inline code 中的 data-vdoc-island 字面量不得进入 HTML 岛扫描器'
    );
    assert.equal(
        inlineHtmlLiteralCompiled.editRegions.filter((region) =>
            region.type === 'style'
        ).length,
        1,
        'inline code 中的伪 <style> 不得与后续真实 </style> 跨域匹配'
    );
    assert.match(
        inlineHtmlLiteralCompiled.html,
        /<code>&lt;style&gt;<\/code>/,
        'inline style 字面量必须保留为 Markdown code'
    );
    assert.match(
        inlineHtmlLiteralCompiled.html,
        /<code>&lt;div data-vdoc-island=&quot;fake&quot;&gt;fake&lt;\/div&gt;<\/code>/,
        'inline div 岛字面量必须保留为 Markdown code'
    );
    const realStyleRegion = inlineHtmlLiteralCompiled.editRegions.find(
        (region) => region.type === 'style'
    );
    assert.match(
        inlineHtmlLiteralSource.slice(
            realStyleRegion.sourceRange.start,
            realStyleRegion.sourceRange.end
        ),
        /^<style>[\s\S]*\.real-style[\s\S]*<\/style>$/,
        '真实 style 原子范围不得包含前方正文'
    );

    const htmlCommentLiteralSource = [
        '<!-- 文档说明中的 <style> 标签不是样式块，<h1>伪目录</h1> 也不是标题 -->',
        '',
        '<style>',
        '.real-comment-safe-style { color: teal; }',
        '</style>',
        '',
        '<!-- <div data-vdoc-island="fake-comment-island"><div></div></div> -->',
        '<div data-vdoc-island="real-comment-safe-island">',
        '    <!-- </div><style>.fake { color: red; }</style><h2>伪岛内标题</h2> -->',
        '    <div class="real-comment-safe-style">',
        '        <h2>真实岛内标题</h2>',
        '    </div>',
        '</div>',
    ].join('\n');
    const htmlCommentLiteralCompiled = compiler.compile(htmlCommentLiteralSource);
    assert.deepEqual(
        htmlCommentLiteralCompiled.islands.map((island) => island.id),
        ['real-comment-safe-island'],
        'HTML 注释中的 data-vdoc-island 与 div 闭合标签不得进入岛扫描器'
    );
    const commentSafeStyles = htmlCommentLiteralCompiled.editRegions.filter(
        (region) => region.type === 'style'
    );
    assert.equal(
        commentSafeStyles.length,
        1,
        'HTML 注释中的伪 style 不得与后续真实 </style> 跨域匹配'
    );
    assert.equal(
        htmlCommentLiteralSource.slice(
            commentSafeStyles[0].sourceRange.start,
            commentSafeStyles[0].sourceRange.end
        ),
        [
            '<style>',
            '.real-comment-safe-style { color: teal; }',
            '</style>',
        ].join('\n')
    );
    assert.deepEqual(
        htmlCommentLiteralCompiled.headings.map(({ level, text }) => ({ level, text })),
        [{ level: 2, text: '真实岛内标题' }],
        'HTML 注释中的伪标题不得进入语义目录'
    );
    assert.equal(
        htmlCommentLiteralCompiled.diagnostics.some((item) =>
            item.ruleId === 'island-unclosed'
        ),
        false,
        '岛内注释中的伪 </div> 不得提前闭合真实根岛'
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