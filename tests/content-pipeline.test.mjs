import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentPipeline, PIPELINE_MODES } from '../modules/renderer/contentPipeline.js';
import { TOOL_RESULT_START_MARKER, TOOL_RESULT_END_MARKER } from '../modules/renderer/toolResultRegions.js';

test('content pipeline keeps thought, tool, request and code protocols ordered and isolated', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /\[RESULT:[\s\S]*?\]/g,
        getToolRequestRegex: () => /<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/g,
        getCodeFenceRegex: () => /```[\s\S]*?```/g,
        processStartEndMarkers: value => value.replace('「始」', '<START>').replace('「末」', '<END>')
    });
    const toolResult = `${TOOL_RESULT_START_MARKER} **raw tool output** ${TOOL_RESULT_END_MARKER}`;
    const input = [
        '<think>\nprivate reasoning\n</think>',
        toolResult,
        '<<<[TOOL_REQUEST]>>> tool_name:「始」Demo「末」 <<<[END_TOOL_REQUEST]>>>',
        '```js\nconst marker = "not a tool result";\n```'
    ].join('\n');
    const result = pipeline.process(input, { mode: PIPELINE_MODES.FULL_RENDER });
    assert.equal(result.state.thoughtChainMap.size, 1);
    assert.equal(result.state.toolResultMap.size, 1);
    assert.equal(result.state.toolRequestMap.size, 1);
    assert.equal(result.state.codeBlockMap.size, 1);
    assert.deepEqual(result.meta.stepsApplied.slice(0, 6), [
        'strip-persona-backfill-tail',
        'strip-emotion-tags',
        'normalize-emoticon-urls',
        'protect-thought-chains',
        'protect-tool-results',
        'protect-tool-requests'
    ]);
    assert.match(result.state.toolRequestMap.values().next().value, /<START>Demo<END>/);
    const [toolResultPlaceholder, protectedToolResult] = result.state.toolResultMap.entries().next().value;
    assert.equal(protectedToolResult, toolResult);
    assert.ok(result.text.includes(toolResultPlaceholder));
    assert.ok(!result.text.includes(toolResult));
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
        'strip-emotion-tags',
        'normalize-emoticon-urls',
        'protect-code-blocks',
        'deindent-misinterpreted-code-blocks',
        'apply-common-content-processors',
        'normalize-adjacent-bold-boundaries',
        'restore-code-blocks'
    ]);
});

test('emotion tags never reach the rendered text, while tool results and code keep them as data', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/g,
        getCodeFenceRegex: () => /```[\s\S]*?```/g
    });
    const reply = '<!--emo:happy 0.8-->你好！\n```\n<!--emo:sad-->\n```\n'
        + '[[VCP调用结果信息汇总:\n内容: <!--emo:angry-->\nVCP调用结果结束]]\n<!--emo:shy-->再见';
    const full = pipeline.process(reply, { mode: PIPELINE_MODES.FULL_RENDER });
    assert.ok(!full.text.includes('emo:happy'));
    assert.ok(!full.text.includes('emo:shy'));
    assert.ok(full.text.includes('你好！'));
    const [, toolResult] = full.state.toolResultMap.entries().next().value;
    assert.match(toolResult, /emo:angry/);
    assert.ok(full.text.includes('<!--emo:sad-->'), 'code keeps the tag');

    const stream = pipeline.process('好的呀<!--emo:exc', { mode: PIPELINE_MODES.STREAM_FAST });
    assert.equal(stream.text, '好的呀');
});
