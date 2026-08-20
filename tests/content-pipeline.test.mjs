import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentPipeline, PIPELINE_MODES } from '../modules/renderer/contentPipeline.js';

test('content pipeline keeps thought, tool, request and code protocols ordered and isolated', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /\[RESULT:[\s\S]*?\]/g,
        getToolRequestRegex: () => /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g,
        getCodeFenceRegex: () => /```[\s\S]*?```/g,
        processStartEndMarkers: value => value.replace('「始」', '<START>').replace('「末」', '<END>')
    });
    const input = [
        '<think>\nprivate reasoning\n</think>',
        '[RESULT: **raw tool output**]',
        '<<<[TOOL_REQUEST]>>> tool_name:「始」Demo「末」 <<<[END_TOOL_REQUEST]>>>',
        '```js\nconst marker = "not a tool result";\n```'
    ].join('\n');
    const result = pipeline.process(input, { mode: PIPELINE_MODES.FULL_RENDER });
    assert.equal(result.state.thoughtChainMap.size, 1);
    assert.equal(result.state.toolResultMap.size, 1);
    assert.equal(result.state.toolRequestMap.size, 1);
    assert.equal(result.state.codeBlockMap.size, 1);
    assert.deepEqual(result.meta.stepsApplied.slice(0, 5), [
        'strip-persona-backfill-tail',
        'normalize-emoticon-urls',
        'protect-thought-chains',
        'protect-tool-results',
        'protect-tool-requests'
    ]);
    assert.match(result.state.toolRequestMap.values().next().value, /<START>Demo<END>/);
});

test('stream-fast protocol path is intentionally lightweight and does not create protection maps', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /\[RESULT:[\s\S]*?\]/g,
        getCodeFenceRegex: () => /```[\s\S]*?```/g
    });
    const result = pipeline.process('[RESULT: partial]', { mode: PIPELINE_MODES.STREAM_FAST });
    assert.equal(result.state.toolResultMap, null);
    assert.equal(result.state.codeBlockMap, null);
    assert.deepEqual(result.meta.stepsApplied, [
        'strip-persona-backfill-tail',
        'normalize-emoticon-urls',
        'deindent-misinterpreted-code-blocks',
        'apply-common-content-processors',
        'normalize-adjacent-bold-boundaries'
    ]);
});
