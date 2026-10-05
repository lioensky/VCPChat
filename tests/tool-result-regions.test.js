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

test('tool result hidden state detection, toggling, and context stripping', async () => {
    const {
        isToolResultHidden,
        setToolResultHidden,
        stripHiddenToolResults,
        collectClosedToolResultRanges
    } = await loadRegions();

    const normalBlock = `${START}\n- 工具名称: TestTool\n- 返回内容: normal output\n${END}`;
    const hiddenBlock1 = `${START} [HIDDEN]\n- 工具名称: TestTool\n- 返回内容: hidden output\n${END}`;
    const hiddenBlock2 = `${START}\n- 注入上下文: 隐藏\n- 工具名称: TestTool\n- 返回内容: hidden output\n${END}`;

    assert.equal(isToolResultHidden(normalBlock), false);
    assert.equal(isToolResultHidden(hiddenBlock1), true);
    assert.equal(isToolResultHidden(hiddenBlock2), true);

    // 测试将正常块切换为隐藏
    const toggledToHidden = setToolResultHidden(normalBlock, true);
    assert.equal(isToolResultHidden(toggledToHidden), true);
    assert.ok(toggledToHidden.startsWith(`${START} [HIDDEN]`));

    // 测试将隐藏块恢复为正常
    const restoredNormal = setToolResultHidden(toggledToHidden, false);
    assert.equal(isToolResultHidden(restoredNormal), false);
    assert.ok(!restoredNormal.includes('[HIDDEN]'));

    // 测试隐藏块在 collectClosedToolResultRanges 下依然被正常识别为闭合块
    const fullText = `前文\n\n${hiddenBlock1}\n\n后文`;
    const ranges = collectClosedToolResultRanges(fullText);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].closed, true);

    // 测试 stripHiddenToolResults 能够把隐藏块从上下文中完全剥离，效果等同于原删除操作
    const stripped = stripHiddenToolResults(fullText);
    assert.equal(stripped.trim(), '前文\n\n后文');

    // 正常块不应该被剥离
    const mixedText = `前文\n\n${normalBlock}\n\n中间\n\n${hiddenBlock1}\n\n后文`;
    const strippedMixed = stripHiddenToolResults(mixedText);
    assert.ok(strippedMixed.includes('normal output'));
    assert.ok(!strippedMixed.includes('hidden output'));
});