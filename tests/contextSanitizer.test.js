import test from 'node:test';
import assert from 'node:assert/strict';
import contextSanitizer from '../modules/contextSanitizer.js';

test('ContextSanitizer: 模型思考闭标同行输出答案（</think> 答案是 42）', () => {
    const input = [
        '<think>',
        '第一步：分析用户需求',
        '第二步：计算结果得出 42',
        '</think> 答案是 42。'
    ].join('\n');
    const cleaned = contextSanitizer.stripThoughtChains(input);
    assert.equal(cleaned, '答案是 42。', '闭标同行紧随的答案必须完整保留，思考链必须剥净');

    const vcpInput = [
        '[--- VCP元思考链 (Auto模式) ---]',
        '系统内部决策逻辑',
        '[--- 元思考链结束 ---] 操作已成功完成。'
    ].join('\n');
    const cleanedVCP = contextSanitizer.stripThoughtChains(vcpInput);
    assert.equal(cleanedVCP, '操作已成功完成。', 'VCP元思考链闭标同行散文必须保留');
});

test('ContextSanitizer: 单行思考标签不吃尾与否定预查有效性', () => {
    const singleLineWithProse = '<think>单行标签解释</think> 正常散文内容必须保留。';
    const cleanedSingle = contextSanitizer.stripThoughtChains(singleLineWithProse);
    assert.ok(cleanedSingle.includes('正常散文内容必须保留。'), '单行闭合思考标签后续正文绝不能丢失');

    const dangling = [
        '正文有效前言',
        '<think>',
        '模型在此处发生异常网络中断导致没有闭合标签'
    ].join('\n');
    const cleanedDangling = contextSanitizer.stripThoughtChains(dangling);
    assert.ok(!cleanedDangling.includes('<think>'));
    assert.ok(cleanedDangling.includes('正文有效前言'));
});

test('ContextSanitizer: CRLF 环境不残留 \\r 孤立字符', () => {
    const crlfDangling = '正常行第一行\r\n正常行第二行\r\n<think>\r\n未闭合截断内容';
    const cleanedDangling = contextSanitizer.stripThoughtChains(crlfDangling);
    assert.equal(cleanedDangling, '正常行第一行\r\n正常行第二行');
    assert.ok(!cleanedDangling.endsWith('\r'), '上一行行尾绝不能残留孤立 \\r (0x0D)');
});

test('ContextSanitizer: 代码块与工具块内部思考标签字面量保护', () => {
    const codeFenceInput = [
        'Before code fence.',
        '```javascript',
        '<think>',
        'inside fence should be preserved',
        '</think>',
        '```',
        'After fence.'
    ].join('\n');
    const cleaned = contextSanitizer.stripThoughtChains(codeFenceInput);
    assert.ok(cleaned.includes('inside fence should be preserved'));
    assert.ok(cleaned.includes('Before code fence.'));
    assert.ok(cleaned.includes('After fence.'));
});

test('ContextSanitizer: stripHiddenToolResults 保护围栏代码示例并正确剥离真实隐藏块', () => {
    const input = [
        '```markdown',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        'CODE_FENCE_EXAMPLE_KEEP',
        'VCP调用结果结束]]',
        '```',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        'REAL_HIDDEN_STRIP',
        'VCP调用结果结束]]',
        '正常结论'
    ].join('\n');
    const cleaned = contextSanitizer.stripHiddenToolResults(input);
    assert.ok(cleaned.includes('CODE_FENCE_EXAMPLE_KEEP'), '代码块内 [HIDDEN] 示例必须保留');
    assert.ok(!cleaned.includes('REAL_HIDDEN_STRIP'), '真实顶层 [HIDDEN] 块必须剥离');
    assert.ok(cleaned.includes('正常结论'));
});

test('ContextSanitizer: sanitizeMessages 保留 __vcpchatTimestampMeta 元数据 (P3-2)', () => {
    const meta = { messageId: 'm-1', role: 'assistant', timestamp: 1700000000000 };
    const msgs = [
        { role: 'assistant', content: '<p>old html</p>', __vcpchatTimestampMeta: meta },
        { role: 'assistant', content: 'latest' }
    ];
    const out = contextSanitizer.sanitizeMessages(msgs, 1);
    assert.equal(out[0].content, 'old html');
    assert.deepEqual(out[0].__vcpchatTimestampMeta, meta);
});

test('RT-P2-2b: containsRawVcpBlocks 保护成对外部标签与成对裸常驻药丸，禁止单边前缀绕过 Turndown', () => {
    const protectedCases = [
        '<p>外部调用：</p><tool_call id="1">{"name":"search"}</tool_call>',
        '<p>函数调用：</p><function_call name="run">{"x":1}</function_call>',
        '<p>裸药丸：</p>[系统提示:] 【VCP 工具调用协议规范】必须严格遵循【/VCP 工具调用协议规范】',
        '<p>成对工具块：</p><<<[TOOL_REQUEST]>>>\ntool_name:「始」Ls「末」\n<<<[END_TOOL_REQUEST]>>>',
    ];
    for (const raw of protectedCases) {
        assert.equal(contextSanitizer.containsRawVcpBlocks(raw), true, `containsRawVcpBlocks 必须识别: ${raw}`);
        assert.equal(contextSanitizer.sanitizeContent(raw), raw, `sanitizeContent 必须直通不进 Turndown: ${raw}`);
    }

    const normalRichCases = [
        '<p><strong>残损开标示例</strong>：<<<[START_TOOL_REQUEST]>>>\ntool_name:「始」Ls「末」</p>',
        '<p><strong>孤立尾标示例</strong>：<<<[END_TOOL_REQUEST]>>></p>',
        '<p><strong>单次标签</strong>：<tool_call id="1"> 未闭合</p>',
        '<p><strong>单次括号</strong>：[TOOL_CALL] 与 [FUNCTION_CALL]</p>',
    ];
    for (const html of normalRichCases) {
        assert.equal(contextSanitizer.containsRawVcpBlocks(html), false, `孤立/单次字面量不得跳过 Turndown: ${html}`);
        const sanitized = contextSanitizer.sanitizeContent(html);
        assert.ok(!sanitized.includes('<p>'), `普通富文本应经过 Turndown HTML->Markdown 净化: ${sanitized}`);
    }
});
