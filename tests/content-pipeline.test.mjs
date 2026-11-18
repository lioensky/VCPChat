import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
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

test('assistant reply address is display-only and hidden only as a complete terminal footer', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /unused/g,
    });
    const footer = '[该发言发送自topic_1794289544422话题]';
    const raw = `正文\n\n${footer}\r\n`;
    const render = (text, messageRole = 'assistant') =>
        pipeline.process(text, { mode: PIPELINE_MODES.FULL_RENDER, messageRole });
    assert.equal(render(raw).text, '正文');
    assert.equal(raw, `正文\n\n${footer}\r\n`, 'source remains unchanged');
    assert.equal(render(raw, 'user').text, raw);
    assert.equal(render(raw, 'system').text, raw);
    assert.equal(render(`${footer}\n后续正文`).text, `${footer}\n后续正文`);
    assert.equal(render(`正文\n[该发言发送自topic_123话题`).text, '正文\n[该发言发送自topic_123话题');
    assert.equal(render(footer).text, '');
    assert.equal(render('正文\n[该发言发送自topic_123_ab-c话题]').text, '正文');
    const code = `\`\`\`text\n${footer}\n\`\`\``;
    assert.equal(render(code).text, code);
    const inline = `示例：\`${footer}\``;
    assert.equal(render(inline).text, inline);
    const tool = `${TOOL_RESULT_START_MARKER}\n${footer}\n${TOOL_RESULT_END_MARKER}`;
    assert.equal([...render(tool).state.toolResultMap.values()][0], tool);
});

test('a stray ** in one paragraph does not flip bold markers in later paragraphs', () => {
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /unused/g,
    });
    const input = [
        '这个函数接受 **kwargs 形式的参数，调用时可以随意传关键字。',
        '',
        '1. **参数名**不能和位置参数重名。',
        '2. 传进来的是**字典**，顺序和调用时一致。',
    ].join('\n');
    for (const mode of [PIPELINE_MODES.FULL_RENDER, PIPELINE_MODES.STREAM_FAST]) {
        const html = new Marked({ gfm: true, breaks: true }).parse(pipeline.process(input, { mode }).text);
        const strong = [...html.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map(match => match[1]);
        assert.deepEqual(strong, ['参数名', '字典'], mode);
        assert.match(html, /接受 \*\*kwargs 形式/, 'the stray marker stays literal text');
    }
});

test('a raw <svg> with blank lines inside stays one picture through Markdown', async () => {
    const { compileRenderJob } = await import('../modules/renderer/renderWorkerRuntime.js');
    const svg = [
        '<svg viewBox="0 0 320 170" xmlns="http://www.w3.org/2000/svg">',
        '  <rect x="0" y="0" width="320" height="170" fill="#dde6f5"/>',
        '',
        '  <!-- 输出 -->',
        '  <text x="210" y="134">输出</text>',
        '  <rect x="190" y="106" width="110" height="44" fill="none" stroke="#d08f7f"/>',
        '</svg>',
    ].join('\n');
    const render = async text => (await compileRenderJob({ text, markdown: { gfm: true, breaks: true } })).parts.join('');

    const html = await render(`下面是示意图：\n\n${svg}\n\n图后面的**文字**。`);
    assert.ok(html.includes(svg), 'the svg source reaches the DOM unchanged');
    assert.doesNotMatch(html, /<p>\s*<text/, 'no svg element is wrapped in a paragraph');
    assert.match(html, /<strong>文字<\/strong>/, 'Markdown after the svg still renders');

    const pipeline = createContentPipeline({ getToolResultRegex: () => /unused/g });
    const sealed = text => pipeline.process(text, { mode: PIPELINE_MODES.FULL_RENDER }).state.rawScriptMap.size;
    assert.equal(sealed(`前文\n\n${svg}`), 1);
    assert.equal(sealed('前文\n\n<svg viewBox="0 0 10 10">\n  <rect/>\n\n  <text>写到一半'), 0, 'an unclosed svg (still streaming) is left as is');
    assert.equal(sealed('说起 <svg>\n\n标签时 </svg> 不算'), 0, 'an <svg> in the middle of a sentence is not a picture');
    assert.equal(sealed('<svg viewBox="0 0 9 9"><rect/></svg>'), 0, 'an svg without blank lines is already kept whole by marked');
    assert.equal(sealed(`\`\`\`html\n${svg}\n\`\`\``), 0, 'an svg inside a code fence stays code');
    const script = `<script>\nconst icon = \`\n${svg}\`;\n</script>`;
    const result = pipeline.process(script, { mode: PIPELINE_MODES.FULL_RENDER });
    assert.deepEqual([...result.state.rawScriptMap.values()], [script], 'an svg inside a script stays part of the script');
    const nested = '<svg viewBox="0 0 9 9"><svg x="1"><rect/></svg>\n\n<text>外层</text></svg>';
    assert.ok((await render(nested)).includes(nested), 'a nested <svg> does not end the outer one early');
});
