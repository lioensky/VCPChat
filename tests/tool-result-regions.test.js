'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const START = '[[VCP调用结果信息汇总:';
const END = 'VCP调用结果结束]]';

const loadRegions = () => import('../modules/renderer/toolResultRegions.js');
const loadScanner = () => import('../modules/renderer/toolRequestScanner.js');
const loadDesktopPush = () => import('../modules/renderer/desktopPushConsumer.js');

// 复现场景：AI 读取渲染器源码，工具结果内直接包含两个标记常量的字面量。
const SOURCE_LITERAL_PAYLOAD = [
    `export const TOOL_RESULT_START_MARKER = '${START}';`,
    `export const TOOL_RESULT_END_MARKER = '${END}';`,
].join('\n');

const wrapToolResult = (body) => `${START}\n- 工具名称: FileReader\n- 返回内容: ${body}\n${END}`;

test('nested literal markers are absorbed into the outermost tool result', async () => {
    const { collectToolResultRanges } = await loadRegions();
    const text = `前文\n${wrapToolResult(SOURCE_LITERAL_PAYLOAD)}\n后文`;
    const ranges = collectToolResultRanges(text);

    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].closed, true);
    assert.equal(ranges[0].start, text.indexOf(START));
    assert.equal(ranges[0].end, text.lastIndexOf(END) + END.length);
    assert.equal(text.slice(ranges[0].end), '\n后文');
});

test('explicitly nested start/end pairs close only at depth zero', async () => {
    const { collectToolResultRanges } = await loadRegions();
    const text = `${START}\n${START}\ninner\n${END}\nouter tail\n${END}\nafter`;
    const ranges = collectToolResultRanges(text);

    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].closed, true);
    assert.equal(text.slice(ranges[0].end), '\nafter');
});

test('stray end marker at depth zero is ignored and sequential results stay separate', async () => {
    const { collectToolResultRanges } = await loadRegions();
    const text = `孤立 ${END} 文本\n${START}a${END}\n中间\n${START}b${END}`;
    const ranges = collectToolResultRanges(text);

    assert.equal(ranges.length, 2);
    assert.ok(ranges.every(range => range.closed));
    assert.equal(text.slice(ranges[0].start, ranges[0].end), `${START}a${END}`);
    assert.equal(text.slice(ranges[1].start, ranges[1].end), `${START}b${END}`);
});

test('unbalanced inner start keeps the outer tool result open to the stream tail', async () => {
    const { collectToolResultRanges } = await loadRegions();
    const text = `${START}\n${START}\ninner\n${END}\n仍在流式中`;
    const ranges = collectToolResultRanges(text);

    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].closed, false);
    assert.equal(ranges[0].end, text.length);
});

test('stream scanner treats a nested closed tool result as closed', async () => {
    const { findUnclosedToolResult, findEarliestUnclosedToolBlock } = await loadScanner();
    const text = `前文\n${wrapToolResult(SOURCE_LITERAL_PAYLOAD)}\n后文`;

    assert.equal(findUnclosedToolResult(text), null);
    assert.equal(findEarliestUnclosedToolBlock(text), null);
});

test('desktop push inside a nested tool result is data, even when split char by char', async () => {
    const { createDesktopPushConsumer } = await loadDesktopPush();
    const pushed = [];
    const consumer = createDesktopPushConsumer({
        electronAPI: { desktopPush: payload => pushed.push(payload) },
        logger: {},
    });

    const payload = `${SOURCE_LITERAL_PAYLOAD}\n<<<[DESKTOP_PUSH]>>><div>data</div><<<[DESKTOP_PUSH_END]>>>`;
    const toolResult = wrapToolResult(payload);
    let output = '';
    for (const char of toolResult) output += consumer.processToken('m1', char);

    assert.equal(output, toolResult, 'tool result data must pass through untouched');
    assert.equal(pushed.length, 0);

    // 外层工具结果闭合后，真实的推送块恢复协议含义并被拦截出聊天正文。
    const after = consumer.processToken('m1', '\n<<<[DESKTOP_PUSH]>>><div>real</div><<<[DESKTOP_PUSH_END]>>>');
    assert.equal(after, '\n');
    consumer.dispose();
});