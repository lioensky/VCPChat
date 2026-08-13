'use strict';

const assert = require('node:assert/strict');
const markedModule = require('../node_modules/marked/lib/marked.cjs');
global.marked = markedModule.marked || markedModule;
const compiler = require('../ScriptoriumModules/vdoc-hybrid-compiler.js');

const cases = [
    {
        name: '普通单换行',
        source: '甲\n乙',
        expectedBreaks: 1,
    },
    {
        name: 'Markdown 硬换行',
        source: '甲  \n乙',
        expectedBreaks: 1,
    },
    {
        name: '连续普通换行',
        source: '甲\n\n乙',
        expectedBreaks: 0,
        expectedRegions: 2,
    },
    {
        name: '连续硬换行（中间仅两个空格）',
        source: '甲  \n  \n乙',
        expectedBreaks: 0,
        expectedRegions: 2,
    },
    {
        name: '连续硬换行（中间零宽占位）',
        source: '甲  \n\u200B  \n乙',
        expectedBreaks: 2,
    },
    {
        name: '三次连续硬换行（零宽占位）',
        source: '甲  \n\u200B  \n\u200B  \n乙',
        expectedBreaks: 3,
    },
    {
        name: '编辑器一次 Enter 后',
        source: '甲  \n\u200B',
        expectedBreaks: 1,
    },
    {
        name: '编辑器两次 Enter 后',
        source: '甲  \n\u200B  \n\u200B',
        expectedBreaks: 2,
    },
    {
        name: '编辑器三次 Enter 后',
        source: '甲  \n\u200B  \n\u200B  \n\u200B',
        expectedBreaks: 3,
    },
];

function visible(value) {
    return String(value)
        .replace(/\u200B/g, '⟦ZWSP⟧')
        .replace(/ /g, '·')
        .replace(/\n/g, '↵\n');
}

function countBreaks(html) {
    return (String(html).match(/<br\s*\/?>/gi) || []).length;
}

function compactRegions(result) {
    return result.editRegions.map((region) => ({
        ordinal: region.ordinal,
        type: region.type,
        token: region.markdownTokenType,
        flowKind: region.flowKind,
        range: [
            region.sourceRange.start,
            region.sourceRange.end,
        ],
        source: visible(result.source.slice(
            region.sourceRange.start,
            region.sourceRange.end
        )),
    }));
}

let failed = false;

for (const testCase of cases) {
    const lexerTokens = global.marked.lexer(testCase.source, {
        gfm: true,
        breaks: true,
        async: false,
    });
    const result = compiler.compile(testCase.source);
    const actualBreaks = countBreaks(result.html);
    const previewBreaks = countBreaks(result.previewHtml);

    console.log(`\n=== ${testCase.name} ===`);
    console.log('SOURCE:\n' + visible(testCase.source));
    console.log('TOKENS:', lexerTokens.map((token) => ({
        type: token.type,
        raw: visible(token.raw || ''),
    })));
    console.log('EDIT REGIONS:', compactRegions(result));
    console.log('HTML:', visible(result.html));
    console.log('PREVIEW HTML:', visible(result.previewHtml));
    console.log(
        `BR: html=${actualBreaks}, preview=${previewBreaks}, expected=${testCase.expectedBreaks}`
    );

    try {
        assert.equal(
            actualBreaks,
            testCase.expectedBreaks,
            `${testCase.name} 的正式 HTML 换行数量不符`
        );
        assert.equal(
            previewBreaks,
            testCase.expectedBreaks,
            `${testCase.name} 的预览 HTML 换行数量不符`
        );
        const expectedRegions = testCase.expectedRegions || 1;
        assert.equal(
            result.editRegions.length,
            expectedRegions,
            `${testCase.name} 被拆成了 ${result.editRegions.length} 个编辑区域`
        );
        if (expectedRegions === 1) {
            assert.deepEqual(
                result.editRegions[0].sourceRange,
                { start: 0, end: testCase.source.length },
                `${testCase.name} 的编辑区域未覆盖完整源码`
            );
        }
        console.log('RESULT: PASS');
    } catch (error) {
        failed = true;
        console.error('RESULT: FAIL');
        console.error(error.message);
    }
}

if (failed) {
    process.exitCode = 1;
} else {
    console.log('\nALL LINE-BREAK DIAGNOSTICS PASSED');
}