import test from 'node:test';
import assert from 'node:assert/strict';
import {
    prepareCompactionState,
    extractDiaryText,
    stripCompactionResilienceMarkers
} from '../modules/chat/contextCompactionState.js';
import contextSanitizer from '../modules/contextSanitizer.js';
import vcpServerRoutes from '../modules/utils/vcpServerRoutes.js';
if (!globalThis.vcpServerRoutes) globalThis.vcpServerRoutes = vcpServerRoutes;

test('Batch 9 Client - contextCompactionState: unclosed DailyNote without receipt is preserved as unparsed and removed from text', () => {
    const unclosedRaw = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'fileName:「始」broken.txt「末」,',
        'Content:「始」This is an unclosed diary without end marker'
    ].join('\n');
    const unclosedDailyNote = [
        'Normal conversation before.',
        unclosedRaw
    ].join('\n');

    const state = prepareCompactionState([
        { role: 'assistant', content: unclosedDailyNote }
    ]);

    // 无纠偏回执拦截的未解析旧格式日记必须原样保留兜底（unparsed: true）
    assert.equal(state.diaries.length, 1, 'Unclosed DailyNote without receipt should be preserved as unparsed');
    assert.equal(state.diaries[0].unparsed, true);
    assert.equal(state.diaries[0].content, unclosedRaw);
    // 产生警告
    assert.ok(state.warnings.some(w => w.includes('日记内容无法解析，已原样保留整个日记块')), 'Warning should indicate raw diary fallback');
    // 待压缩文本中依然干净剔除坏块区间
    assert.ok(!state.messages[0].content.includes('<<<[TOOL_REQUEST]>>>'), 'Unclosed tool request must be stripped from text');
    assert.ok(!state.messages[0].content.includes('DailyNote'), 'DailyNote marker must be stripped from text');
    assert.ok(state.messages[0].content.includes('Normal conversation before.'), 'Normal conversation must be preserved');
});

test('Batch 9 Client - contextCompactionState: closed DailyNote with missing content without receipt is preserved as unparsed', () => {
    const closedBlock = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'fileName:「始」nocontent.txt「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const closedWithoutContent = [
        'Conversation line.',
        closedBlock
    ].join('\n');

    const state = prepareCompactionState([
        { role: 'assistant', content: closedWithoutContent }
    ]);

    assert.equal(state.diaries.length, 1, 'Missing content DailyNote without receipt should be preserved as unparsed');
    assert.equal(state.diaries[0].unparsed, true);
    assert.equal(state.diaries[0].content, closedBlock);
    assert.ok(state.warnings.some(w => w.includes('日记内容无法解析，已原样保留整个日记块')));
    assert.ok(!state.messages[0].content.includes('<<<[TOOL_REQUEST]>>>'));
    assert.ok(state.messages[0].content.includes('Conversation line.'));
});

test('Batch 9 Client - contextCompactionState: valid DailyNote create and update work properly', () => {
    const valid = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'fileName:「始」notes.txt「末」,',
        'Content:「始」hello $& world「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const update = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」update「末」,',
        'fileName:「始」notes.txt「末」,',
        'target:「始」$&「末」,',
        'replace:「始」$$「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const state = prepareCompactionState([
        { role: 'assistant', content: valid },
        { role: 'assistant', content: update }
    ]);

    assert.equal(state.diaries.length, 1);
    assert.equal(state.diaries[0].content, 'hello $$ world');
    assert.equal(state.warnings.length, 0);
});

test('Batch 9 Client - contextCompactionState: resilience guidance, errors and static pills are stripped from compacted text', () => {
    const textWithResilience = [
        'User text.',
        '[[VCP协议纠偏指导:',
        'block=deadbeef, reason=MALFORMED_TOOL_REQUEST',
        '请更正格式',
        '[[/VCP协议纠偏指导]]',
        '',
        '- [x] DailyNote -> 格式错误（未执行）：缺少必填字段',
        '(上轮未执行的异常工具调用已略去)',
        '[工具调用纠偏已归档]',
        '',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[系统提示:] 【VCP 工具调用协议规范】',
        '规范说明...',
        '【/VCP 工具调用协议规范】',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '',
        'Actual useful content to be preserved.'
    ].join('\n');

    const cleaned = stripCompactionResilienceMarkers(textWithResilience);
    assert.ok(!cleaned.includes('[[VCP协议纠偏指导:'), 'Guidance block must be stripped');
    assert.ok(!cleaned.includes('格式错误（未执行）'), 'Error summary item must be stripped');
    assert.ok(!cleaned.includes('【VCP 工具调用协议规范】'), 'Static pill must be stripped');
    assert.ok(!cleaned.includes('<<<[ROLE_DIVIDE_USER]>>>'), 'Empty ROLE_DIVIDE_USER must be stripped');
    assert.ok(!cleaned.includes('[工具调用纠偏已归档]'), 'Placeholder must be stripped');
    assert.ok(cleaned.includes('User text.'), 'User text preserved');
    assert.ok(cleaned.includes('Actual useful content to be preserved.'), 'Actual content preserved');

    // prepareCompactionState 也自动剥离
    const state = prepareCompactionState([
        { role: 'assistant', content: textWithResilience }
    ]);
    assert.ok(!state.messages[0].content.includes('[[VCP协议纠偏指导:'));
    assert.ok(!state.messages[0].content.includes('【VCP 工具调用协议规范】'));
    assert.ok(state.messages[0].content.includes('Actual useful content to be preserved.'));
});

test('Batch 9 Client - contextSanitizer: stripThoughtChains strips top-level thoughts while protecting tool requests, tool results, and code fences', () => {
    const sanitizer = contextSanitizer;

    const complexContent = [
        '<think>',
        'top level think 1',
        '</think>',
        '',
        '<thinking>',
        'top level thinking 2',
        '</thinking>',
        '',
        '<thought>',
        'top level thought 3',
        '</thought>',
        '',
        '<antthinking>',
        'top level antthinking 4',
        '</antthinking>',
        '',
        '[--- VCP元思考链 (Auto模式) ---]',
        'top level vcp thinking',
        '[--- 元思考链结束 ---]',
        '',
        '[--- VCP元思考链 ---]',
        'top level vcp thinking no colon',
        '[--- 元思考链结束 ---]',
        '',
        'Before code fence.',
        '```javascript',
        '// Code fence containing <think> literal',
        '<think>',
        'should NOT be stripped in code fence',
        '</think>',
        '```',
        '',
        'Before tool request.',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始」',
        '<think>',
        'should NOT be stripped in tool request parameter',
        '</think>',
        '[--- VCP元思考链 ---]',
        'inner vcp thought literal',
        '[--- 元思考链结束 ---]',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '',
        'Before tool request escape.',
        '<<<[TOOL_REQUEST_ESCAPE]>>>',
        'tool_name:「始ESCAPE」DailyNote「末ESCAPE」,',
        'Content:「始ESCAPE」<thought>\ninside escape\n</thought>「末ESCAPE」',
        '<<<[END_TOOL_REQUEST_ESCAPE]>>>',
        '',
        'Before tool results.',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: DailyNote',
        '- 返回内容: <think>inside tool result</think>',
        'VCP调用结果结束]]',
        '',
        'Final conversation text.'
    ].join('\n');

    const stripped = sanitizer.stripThoughtChains(complexContent);

    // 1. 顶层思考链必须被彻底剥除
    assert.ok(!stripped.includes('top level think 1'), 'Top-level <think> must be stripped');
    assert.ok(!stripped.includes('top level thinking 2'), 'Top-level <thinking> must be stripped');
    assert.ok(!stripped.includes('top level thought 3'), 'Top-level <thought> must be stripped');
    assert.ok(!stripped.includes('top level antthinking 4'), 'Top-level <antthinking> must be stripped');
    assert.ok(!stripped.includes('top level vcp thinking'), 'Top-level VCP thinking must be stripped');
    assert.ok(!stripped.includes('top level vcp thinking no colon'), 'Top-level un-coloned VCP thinking must be stripped');

    // 2. 代码围栏内部的 <think> 字面量必须完整保留（保证 OneRing 哈希一致）
    assert.ok(stripped.includes('should NOT be stripped in code fence'), 'Code fence <think> must be preserved');
    assert.ok(stripped.includes('```javascript'), 'Code fence header preserved');

    // 3. 工具请求参数内部的 <think> 与 [--- VCP元思考链 ---] 必须完整保留
    assert.ok(stripped.includes('should NOT be stripped in tool request parameter'), 'Tool parameter <think> must be preserved');
    assert.ok(stripped.includes('inner vcp thought literal'), 'Tool parameter VCP thought must be preserved');
    assert.ok(stripped.includes('<<<[TOOL_REQUEST]>>>'), 'Tool request header preserved');
    assert.ok(stripped.includes('<<<[END_TOOL_REQUEST]>>>'), 'Tool request closer preserved');

    // 4. 工具请求 ESCAPE 块内部思考字面量完整保留
    assert.ok(stripped.includes('inside escape'), 'Tool request escape content preserved');

    // 5. 工具结果块内部思考字面量完整保留
    assert.ok(stripped.includes('inside tool result'), 'Tool result content preserved');

    // 6. 普通文本保留
    assert.ok(stripped.includes('Final conversation text.'), 'Final text preserved');
});

test('Batch 9 Client - contextSanitizer: thought chain immediately followed by code fence is stripped without leaking (VULN-B9-01)', () => {
    const input = '<think>\ndeep thoughts\n</think>\n```js\nconsole.log(1);\n```\n';
    const stripped = contextSanitizer.stripThoughtChains(input);
    assert.ok(!stripped.includes('<think>'), 'Thinking tag must be stripped');
    assert.ok(!stripped.includes('deep thoughts'), 'Thinking content must be stripped');
    assert.ok(stripped.includes('```js\nconsole.log(1);\n```'), 'Code fence must be preserved');
});

test('Batch 9 Client - contextSanitizer: containsRawVcpBlocks recognizes batch, paired role divide, tool requests and guidance', () => {
    const sanitizer = contextSanitizer;

    assert.ok(sanitizer.containsRawVcpBlocks('<<<[VCP_TOOL_BATCH_START:123]>>>'));
    assert.ok(sanitizer.containsRawVcpBlocks('<<<[ROLE_DIVIDE_USER]>>>\nok\n<<<[END_ROLE_DIVIDE_USER]>>>'));
    assert.ok(sanitizer.containsRawVcpBlocks('[[VCP调用结果信息汇总:\n- 工具名称: Ls\nVCP调用结果结束]]'));
    assert.ok(sanitizer.containsRawVcpBlocks('[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=12345678]]'));
    assert.ok(sanitizer.containsRawVcpBlocks('<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>'));
    assert.ok(sanitizer.containsRawVcpBlocks('<<<[TOOL_REQUEST_ESCAPE]>>>...<<<[END_TOOL_REQUEST_ESCAPE]>>>'));
    assert.ok(sanitizer.containsRawVcpBlocks('<<<DailyNoteStart>>>...<<<DailyNoteEnd>>>'));
    assert.ok(!sanitizer.containsRawVcpBlocks('<<<[ROLE_DIVIDE_USER]>>>'));
    assert.ok(!sanitizer.containsRawVcpBlocks('[[VCP调用结果信息汇总: ...'));
    assert.ok(!sanitizer.containsRawVcpBlocks('[[VCP协议纠偏指导: ...'));
    assert.ok(!sanitizer.containsRawVcpBlocks('Plain message with no VCP markers.'));
});

test('Batch 9 Client - contextCompactionState: unclosed guidance does not swallow tail into EOF (VULN-B9-01)', () => {
    const textWithUnclosedGuidance = [
        'Normal conversation before.',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=0f03ddb2',
        '⚠️ 检测到你将目标插件名误填入了键名，但该标签由于各种原因未闭合',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '这是后续非常重要且不能被抹杀的正常对话文本！'
    ].join('\n');

    const cleaned = stripCompactionResilienceMarkers(textWithUnclosedGuidance);
    assert.ok(!cleaned.includes('[[VCP协议纠偏指导:'), 'Unclosed guidance tag must be stripped up to boundary');
    assert.ok(cleaned.includes('这是后续非常重要且不能被抹杀的正常对话文本！'), 'Subsequent dialogue text must NOT be swallowed');
});

test('Batch 9 Client - contextSanitizer: literal __VCP_MASK_PROTECTED_0__ is not poisoned by dynamic nonce (VULN-B9-02)', () => {
    const poisonedInput = [
        'User mentions __VCP_MASK_PROTECTED_0__ in normal text.',
        '<think>',
        'internal thinking here',
        '</think>',
        '```javascript',
        'const a = 1;',
        '```',
        'Discussion continues with __VCP_MASK_PROTECTED_0__ intact.'
    ].join('\n');

    const cleaned = contextSanitizer.stripThoughtChains(poisonedInput);
    assert.ok(!cleaned.includes('<think>'), 'Thinking tags must be stripped');
    assert.ok(!cleaned.includes('internal thinking here'), 'Thinking content must be stripped');
    assert.ok(cleaned.includes('```javascript\nconst a = 1;\n```'), 'Code block must be preserved');
    assert.ok(cleaned.includes('User mentions __VCP_MASK_PROTECTED_0__ in normal text.'), 'Literal __VCP_MASK_PROTECTED_0__ at beginning must not be replaced');
    assert.ok(cleaned.includes('Discussion continues with __VCP_MASK_PROTECTED_0__ intact.'), 'Literal __VCP_MASK_PROTECTED_0__ at end must not be replaced');
    assert.equal((cleaned.match(/__VCP_MASK_PROTECTED_0__/g) || []).length, 2, '__VCP_MASK_PROTECTED_0__ count must remain exactly 2');
});

test('Batch 9 Client - contextSanitizer: stripThoughtChains strips dangling truncated thought chains at tail (P2 Defect 2)', () => {
    const input = [
        '正常回复前文。',
        '[--- VCP元思考链: 正在分析并在中途截断...'
    ].join('\n');
    const cleaned = contextSanitizer.stripThoughtChains(input);
    assert.ok(!cleaned.includes('[--- VCP元思考链'), 'Dangling thought chain marker must be stripped');
    assert.ok(!cleaned.includes('正在分析并在中途截断'), 'Dangling thought chain content must be stripped');
    assert.ok(cleaned.includes('正常回复前文。'), 'Prefix text must be preserved');

    // 受保护区域（代码围栏与工具请求）内的未闭合字面量应被保护
    const protectedCodeFence = [
        '```markdown',
        '[--- VCP元思考链: 代码块内部字面量应保留',
        '```',
        '正文前文',
        '[--- VCP元思考链: 顶层截断内容'
    ].join('\n');
    const protectedCleaned = contextSanitizer.stripThoughtChains(protectedCodeFence);
    assert.ok(protectedCleaned.includes('[--- VCP元思考链: 代码块内部字面量应保留'), 'Protected code fence content must be preserved');
    assert.ok(!protectedCleaned.includes('顶层截断内容'), 'Top-level dangling thought must be stripped');
    assert.ok(protectedCleaned.includes('正文前文'), 'Prefix text before dangling thought must be preserved');
});

test('Batch 9 Client - contextCompactionState: stripCompactionResilienceMarkers strips trailing unclosed guidance without role divide markers (P2 Defect 3)', () => {
    const trailingUnclosed = [
        '正常会话消息。',
        '[[VCP协议纠偏指导: code=MALFORMED_TOOL_REQUEST block=abcd1234',
        '⚠️ 纠偏内容且在消息末尾未闭合，且后文无任何角色分割标记'
    ].join('\n');

    const cleaned = stripCompactionResilienceMarkers(trailingUnclosed);
    assert.ok(!cleaned.includes('[[VCP协议纠偏指导:'), 'Trailing unclosed guidance header must be stripped');
    assert.ok(!cleaned.includes('MALFORMED_TOOL_REQUEST'), 'Guidance body must be stripped');
    assert.ok(!cleaned.includes('纠偏内容且在消息末尾未闭合'), 'Guidance content must be stripped');
    assert.ok(cleaned.includes('正常会话消息。'), 'Preceding dialogue must be preserved');

    // 确保若后文有角色分割标记与重要文本，非贪婪匹配依然只截断到角色分割前，不吞噬后文
    const withRoleDivide = [
        '正常会话前文。',
        '[[VCP协议纠偏指导: code=UNCLOSED 未闭合',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '重要对话内容保留'
    ].join('\n');
    const cleanedDivide = stripCompactionResilienceMarkers(withRoleDivide);
    assert.ok(!cleanedDivide.includes('[[VCP协议纠偏指导:'), 'Guidance must be stripped');
    assert.ok(cleanedDivide.includes('重要对话内容保留'), 'Content after role divide must NOT be swallowed');
});

test('Batch 9 Client - contextSanitizer: stripThoughtChains strips dangling unclosed conventional thinking tags (VULN-B9-02)', () => {
    const input = [
        '正常回复前文。',
        '<think>',
        '正在分析并在中途截断无闭标...'
    ].join('\n');
    const cleaned = contextSanitizer.stripThoughtChains(input);
    assert.ok(!cleaned.includes('<think>'), 'Dangling <think> tag must be stripped');
    assert.ok(!cleaned.includes('正在分析并在中途截断无闭标'), 'Dangling thinking content must be stripped');
    assert.ok(cleaned.includes('正常回复前文。'), 'Prefix text must be preserved');

    // 测试 <antthinking> 与 <thought> 未闭合截断
    const inputAnt = '前置说明文本\n<antthinking>\n截断的未闭合思考';
    const cleanedAnt = contextSanitizer.stripThoughtChains(inputAnt);
    assert.ok(!cleanedAnt.includes('<antthinking>'), 'Dangling <antthinking> must be stripped');
    assert.ok(!cleanedAnt.includes('截断的未闭合思考'), 'Dangling antthinking content must be stripped');
    assert.ok(cleanedAnt.includes('前置说明文本'), 'Prefix preserved');

    // 受保护区域（代码围栏）内的未闭合字面量应被保护
    const protectedCodeFence = [
        '```markdown',
        '<think>',
        '代码块内部未闭合思考标签应保留',
        '```',
        '正文文本',
        '<think>',
        '顶层未闭合截断思考'
    ].join('\n');
    const protectedCleaned = contextSanitizer.stripThoughtChains(protectedCodeFence);
    assert.ok(protectedCleaned.includes('代码块内部未闭合思考标签应保留'), 'Protected code fence content must be preserved');
    assert.ok(!protectedCleaned.includes('顶层未闭合截断思考'), 'Top-level dangling conventional thought must be stripped');
    assert.ok(protectedCleaned.includes('正文文本'), 'Prefix text must be preserved');
});

test('Batch 9 Client - contextSanitizer: 模型思考闭标同行输出答案（</think> 答案是 42） (Remediation R14)', () => {
    // 1. 常规 <think> 标签闭标同行跟答案
    const inputConventional = [
        '<think>',
        '第一步：分析用户需求',
        '第二步：计算结果得出 42',
        '</think> 答案是 42。'
    ].join('\n');
    const cleanedConv = contextSanitizer.stripThoughtChains(inputConventional);
    assert.equal(cleanedConv, '答案是 42。', '闭标同行紧随的答案必须完整保留，思考链必须剥净');

    // 2. 带前置正文与同行闭标答案
    const inputWithPrefix = [
        '问答前言：',
        '<think>',
        '推导过程中...',
        '</think> 经过综合推导，最终结论为成功。'
    ].join('\n');
    const cleanedWithPrefix = contextSanitizer.stripThoughtChains(inputWithPrefix);
    assert.equal(cleanedWithPrefix, '问答前言：\n经过综合推导，最终结论为成功。', '前置正文与闭标同行正文均需保留');

    // 3. VCP 元思考链闭标同行跟答案
    const inputVCP = [
        '[--- VCP元思考链 (Auto模式) ---]',
        '系统内部决策逻辑',
        '[--- 元思考链结束 ---] 操作已成功完成。'
    ].join('\n');
    const cleanedVCP = contextSanitizer.stripThoughtChains(inputVCP);
    assert.equal(cleanedVCP, '操作已成功完成。', 'VCP元思考链闭标同行散文必须保留');

    // 4. 多段思考链同行闭标均正确剥离
    const multiInput = [
        '<think>',
        '思考一',
        '</think> 步骤一结论',
        '<think>',
        '思考二',
        '</think> 步骤二结论'
    ].join('\n');
    const cleanedMulti = contextSanitizer.stripThoughtChains(multiInput);
    assert.equal(cleanedMulti, '步骤一结论\n步骤二结论', '多个闭标同行正文均正确保留');
});

test('Batch 9 Client - contextSanitizer: 单行思考标签不吃尾与否定预查有效性 (Remediation R14)', () => {
    // 1. 单行闭合思考标签不导致后续散文被悬挂正则当作未闭合截断而吃尾至 EOF
    const singleLineWithProse = '<think>单行标签解释</think> 正常散文内容必须保留。';
    const cleanedSingle = contextSanitizer.stripThoughtChains(singleLineWithProse);
    assert.ok(cleanedSingle.includes('正常散文内容必须保留。'), '单行闭合思考标签后续正文绝不能丢失');

    // 2. 正文中提及技术标签不吃尾
    const docText = [
        '使用指南：',
        '模型输出格式应遵循规范，请勿手工插入 <think> 或 </think> 标签。',
        '后续详细段落仍然可见。'
    ].join('\n');
    const cleanedDoc = contextSanitizer.stripThoughtChains(docText);
    assert.ok(cleanedDoc.includes('使用指南：'), '指南前文保留');
    assert.ok(cleanedDoc.includes('后续详细段落仍然可见。'), '后续详细段落不被吃尾');

    // 3. 确实未闭合的悬挂思考标签（后文无闭标）正常截断
    const danglingNoCloser = [
        '正文有效前言',
        '<think>',
        '模型在此处发生异常网络中断导致没有闭合标签'
    ].join('\n');
    const cleanedDangling = contextSanitizer.stripThoughtChains(danglingNoCloser);
    assert.ok(!cleanedDangling.includes('<think>'), '未闭合标签剥离');
    assert.ok(!cleanedDangling.includes('模型在此处发生异常网络中断'), '未闭合内容截断');
    assert.ok(cleanedDangling.includes('正文有效前言'), '前文保留');

    // 4. VCP 思考链单行存在闭标时不吃尾
    const vcpSingle = '[--- VCP元思考链 ---] 中间无换行 [--- 元思考链结束 ---] 答案正常。';
    const cleanedVcpSingle = contextSanitizer.stripThoughtChains(vcpSingle);
    assert.ok(cleanedVcpSingle.includes('答案正常。'), 'VCP单行存在闭标时不吃尾');
});

test('Batch 9 Client - contextSanitizer: CRLF 环境不残留 \\r 孤立字符 (Remediation R14)', () => {
    // 1. CRLF 换行环境下截断悬挂思考链，上一行末尾不残留 \\r
    const crlfDangling = '正常行第一行\r\n正常行第二行\r\n<think>\r\n未闭合截断内容';
    const cleanedDangling = contextSanitizer.stripThoughtChains(crlfDangling);
    assert.ok(!cleanedDangling.includes('<think>'), '未闭合标签已剥离');
    assert.ok(!cleanedDangling.includes('未闭合截断内容'), '截断内容已剥离');
    assert.equal(cleanedDangling, '正常行第一行\r\n正常行第二行', 'CRLF换行格式完整保留且无多余残骸');
    assert.ok(!cleanedDangling.endsWith('\r'), '上一行行尾绝不能残留孤立 \\r (0x0D)');

    // 2. CRLF 换行环境下的 VCP 思考链截断
    const crlfVcpDangling = 'VCP前置说明\r\n[--- VCP元思考链 ---\r\n未闭合VCP思考';
    const cleanedVcpDangling = contextSanitizer.stripThoughtChains(crlfVcpDangling);
    assert.equal(cleanedVcpDangling, 'VCP前置说明', 'VCP截断剥离正常');
    assert.ok(!cleanedVcpDangling.endsWith('\r'), 'VCP截断上一行行尾绝不能残留孤立 \\r');

    // 3. CRLF 换行环境下的闭标同行输出
    const crlfClosed = '前言行\r\n<think>\r\n多行推导\r\n</think> CRLF同行答案';
    const cleanedClosed = contextSanitizer.stripThoughtChains(crlfClosed);
    assert.equal(cleanedClosed, '前言行\r\nCRLF同行答案', 'CRLF闭标同行答案正常保留');
});

test('Batch 9 Client Remediation R15: stripCompactionResilienceMarkers 不吞噬单行极简纠偏回执后续正文', () => {
    const textWithSingleReceipt = [
        '[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=12345678]]',
        '亲爱的用户，这是重要的正文内容，绝不能被吞噬。',
        '第二行正常正文。'
    ].join('\n');

    const stripped = stripCompactionResilienceMarkers(textWithSingleReceipt);
    assert.ok(!stripped.includes('[[VCP协议纠偏指导:'), '纠偏指导回执已剥离');
    assert.ok(!stripped.includes('MISSING_TOOL_NAME'), '错误码已剥离');
    assert.ok(stripped.includes('亲爱的用户，这是重要的正文内容，绝不能被吞噬。'), '后续正文完整保留');
    assert.ok(stripped.includes('第二行正常正文。'), '第二行正文保留');

    // 闭合全文块与单行回执共存
    const mixed = [
        '[[VCP协议纠偏指导:',
        'block=deadbeef, code=BAD_PAYLOAD',
        '[[/VCP协议纠偏指导]]',
        '中间正文。',
        '[[VCP协议纠偏指导: code=UNKNOWN_TOOL block=87654321]]',
        '尾部正文。'
    ].join('\n');
    const strippedMixed = stripCompactionResilienceMarkers(mixed);
    assert.ok(!strippedMixed.includes('BAD_PAYLOAD'));
    assert.ok(!strippedMixed.includes('UNKNOWN_TOOL'));
    assert.ok(strippedMixed.includes('中间正文。'));
    assert.ok(strippedMixed.includes('尾部正文。'));
});

test('Batch 9 Client Remediation R15: stripThoughtChains 行首技术散文不误吞至 EOF', () => {
    const proseWithThinkAtLineStart = [
        '技术分享：',
        '<think> 标签是用来进行推理思考的特殊标记。',
        '后续段落必须完整可见，不能被当作悬挂思考链吞噬。'
    ].join('\n');

    const cleaned = contextSanitizer.stripThoughtChains(proseWithThinkAtLineStart);
    assert.ok(cleaned.includes('技术分享：'), '前文保留');
    assert.ok(cleaned.includes('<think> 标签是用来进行推理思考的特殊标记。'), '行首散文完整保留');
    assert.ok(cleaned.includes('后续段落必须完整可见，不能被当作悬挂思考链吞噬。'), '后续段落完整保留');

    const proseWithVCPAtLineStart = [
        '关于协议：',
        '[--- VCP元思考链 ---] 是系统的元思考标记规范。',
        '结尾段落必须保留。'
    ].join('\n');

    const cleanedVcp = contextSanitizer.stripThoughtChains(proseWithVCPAtLineStart);
    assert.ok(cleanedVcp.includes('关于协议：'), '前文保留');
    assert.ok(cleanedVcp.includes('[--- VCP元思考链 ---] 是系统的元思考标记规范。'), 'VCP行首散文完整保留');
    assert.ok(cleanedVcp.includes('结尾段落必须保留。'), '结尾段落保留');
});

test('Batch 9 Client Remediation R18: stripThoughtChains 掩码保护区覆盖 <<<DailyNoteStart>>>...<<<DailyNoteEnd>>> 遗留日记', () => {
    const legacyDiaryWithThink = [
        '前置聊天内容',
        '<think>',
        '外部思考链必须被剥离',
        '</think>',
        '<<<DailyNoteStart>>>',
        '【2026-11-24 存量日记】',
        '<think>',
        '日记中记录的 AI 推理原文字面量',
        '</think>',
        '[--- VCP元思考链 (Auto模式) ---]',
        '日记中记录的元思考链字面量',
        '[--- 元思考链结束 ---]',
        '存量日记正文尾部',
        '<<<DailyNoteEnd>>>',
        '尾部正常交流消息'
    ].join('\n');

    const cleaned = contextSanitizer.stripThoughtChains(legacyDiaryWithThink);
    assert.ok(!cleaned.includes('外部思考链必须被剥离'), '顶层外部思考链必须剥离');
    assert.ok(cleaned.includes('<<<DailyNoteStart>>>'), '日记开始标记保留');
    assert.ok(cleaned.includes('<think>\n日记中记录的 AI 推理原文字面量\n</think>'), '日记内思考标签原样保留');
    assert.ok(cleaned.includes('[--- VCP元思考链 (Auto模式) ---]\n日记中记录的元思考链字面量\n[--- 元思考链结束 ---]'), '日记内VCP思考标签原样保留');
    assert.ok(cleaned.includes('<<<DailyNoteEnd>>>'), '日记结束标记保留');
    assert.ok(cleaned.includes('前置聊天内容'), '前置内容保留');
    assert.ok(cleaned.includes('尾部正常交流消息'), '尾部内容保留');
});

test('Batch 9 Client Remediation R19: stripCompactionResilienceMarkers 处理 block=unknown 等非标准指纹不吞噬后续正文 (Defect 1)', () => {
    const textWithUnknownBlock = [
        '[[VCP协议纠偏指导: code=MALFORMED_BLOCK_SYNTAX block=unknown]]',
        '亲爱的用户，这是重要的正文内容，绝不能被吞噬。',
        '第二行正常正文。'
    ].join('\n');

    const stripped = stripCompactionResilienceMarkers(textWithUnknownBlock);
    assert.ok(!stripped.includes('[[VCP协议纠偏指导:'), '纠偏指导回执已剥离');
    assert.ok(!stripped.includes('MALFORMED_BLOCK_SYNTAX'), '错误码已剥离');
    assert.ok(stripped.includes('亲爱的用户，这是重要的正文内容，绝不能被吞噬。'), '后续正文完整保留');
    assert.ok(stripped.includes('第二行正常正文。'), '第二行正文保留');

    // 自定义前缀/非标准字符指纹
    const textWithSlugBlock = [
        '[[VCP协议纠偏指导: code=UNCLOSED_BLOCK block=custom-block_01]]',
        '受保护的对话正文。'
    ].join('\n');
    const strippedSlug = stripCompactionResilienceMarkers(textWithSlugBlock);
    assert.ok(!strippedSlug.includes('UNCLOSED_BLOCK'));
    assert.ok(strippedSlug.includes('受保护的对话正文。'));
});

test('Batch 9 Client Remediation R19: stripThoughtChains 优先保护转义体「始ESCAPE」...「末ESCAPE」，防内部嵌套工具块导致外层掩码腰斩 (Defect 2)', () => {
    const toolWithNestedEscape = [
        '用户提问前文',
        '<think>',
        '外部思考过程必须被清理',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteEscapedFile「末」,',
        'path:「始」/test/sample.md「末」,',
        'content:「始ESCAPE」',
        '这是写进文件的说明：',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」InnerTool「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '内部技术说明包含思考标签：',
        '<think>',
        '这是嵌套在转义体内部的思考技术细节',
        '</think>',
        '[--- VCP元思考链 (Nested) ---]',
        '嵌套的VCP元思考',
        '[--- 元思考链结束 ---]',
        '「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '后续总结正文'
    ].join('\n');

    const cleaned = contextSanitizer.stripThoughtChains(toolWithNestedEscape);
    assert.ok(!cleaned.includes('外部思考过程必须被清理'), '顶层外部思考链必须剥离');
    assert.ok(cleaned.includes('content:「始ESCAPE」'), '转义体起始标记保留');
    assert.ok(cleaned.includes('<<<[TOOL_REQUEST]>>>\ntool_name:「始」InnerTool「末」\n<<<[END_TOOL_REQUEST]>>>'), '内部嵌套工具块完整保留');
    assert.ok(cleaned.includes('<think>\n这是嵌套在转义体内部的思考技术细节\n</think>'), '转义体内部思考标签100%保留');
    assert.ok(cleaned.includes('[--- VCP元思考链 (Nested) ---]\n嵌套的VCP元思考\n[--- 元思考链结束 ---]'), '转义体内部VCP元思考100%保留');
    assert.ok(cleaned.includes('「末ESCAPE」'), '转义体结束标记保留');
    assert.ok(cleaned.includes('<<<[END_TOOL_REQUEST]>>>'), '外层工具块闭合标保留');
    assert.ok(cleaned.includes('后续总结正文'), '外层后续总结正文保留');

    // 同样验证 {始ESCAPE}...{末ESCAPE}
    const curlyEscape = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」CurlyTool「末」,',
        'content:{始ESCAPE}',
        '<<<[TOOL_REQUEST]>>>\ninner\n<<<[END_TOOL_REQUEST]>>>',
        '<think>',
        '花括号转义体内部思考',
        '</think>',
        '{末ESCAPE}',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const cleanedCurly = contextSanitizer.stripThoughtChains(curlyEscape);
    assert.ok(cleanedCurly.includes('{始ESCAPE}'));
    assert.ok(cleanedCurly.includes('<think>\n花括号转义体内部思考\n</think>'));
    assert.ok(cleanedCurly.includes('{末ESCAPE}'));
});

test('Batch 9 Client Remediation R19: sanitizeContent 占位保护扩充全集思考标签 (<thought>, <thoughts>, <antthinking>) (Defect 3)', () => {
    const htmlWithThoughtTags = '<p>请看以下推理标签说明：<thought>这是thought标签内容</thought>以及<thoughts>这是thoughts内容</thoughts>和<antthinking attr="val">antthinking内容</antthinking>及<think>think内容</think></p>';
    const sanitized = contextSanitizer.sanitizeContent(htmlWithThoughtTags);
    assert.ok(sanitized.includes('<thought>这是thought标签内容</thought>'), '<thought> 标签保留');
    assert.ok(sanitized.includes('<thoughts>这是thoughts内容</thoughts>'), '<thoughts> 标签保留');
    assert.ok(sanitized.includes('<antthinking attr="val">antthinking内容</antthinking>'), '<antthinking> 标签保留');
    assert.ok(sanitized.includes('<think>think内容</think>'), '<think> 标签保留');
});

test('Batch 9 Client Remediation R20: 未闭合工具块跨界不吞噬真实思考链 (VULN-B9-01)', () => {
    const input = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」BrokenTool「末」',
        '<think>',
        '这是真实的秘密思考链内容，绝不能泄漏',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」ValidTool「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '正文结论'
    ].join('\n');

    const result = contextSanitizer.stripThoughtChains(input);
    assert.ok(!result.includes('这是真实的秘密思考链内容，绝不能泄漏'), '真实思考链必须被剥离');
    assert.ok(result.includes('tool_name:「始」BrokenTool「末」'), '未闭合工具块内容保留');
    assert.ok(result.includes('tool_name:「始」ValidTool「末」'), '闭合工具块内容保留');
    assert.ok(result.includes('正文结论'), '后续正文保留');

    // 同样验证未闭合工具结果块与未闭合遗留日记块跨界不吞噬思考链
    const inputRes = [
        '[[VCP调用结果信息汇总:',
        '- tool: Broken',
        '<think>',
        '结果后的思考链必须被清除',
        '</think>',
        '[[VCP调用结果信息汇总:\n- tool: Valid\nVCP调用结果结束]]'
    ].join('\n');
    const resultRes = contextSanitizer.stripThoughtChains(inputRes);
    assert.ok(!resultRes.includes('结果后的思考链必须被清除'), '工具结果跨界思考链必须剥离');

    const inputNote = [
        '<<<DailyNoteStart>>>',
        '# Unclosed note',
        '<think>',
        '日记后的思考链必须被清除',
        '</think>',
        '<<<DailyNoteStart>>>\n# Closed note\n<<<DailyNoteEnd>>>'
    ].join('\n');
    const resultNote = contextSanitizer.stripThoughtChains(inputNote);
    assert.ok(!resultNote.includes('日记后的思考链必须被清除'), '日记跨界思考链必须剥离');
});

test('Batch 9 Client Remediation R20: </think > 带空格闭标正常闭合不腰斩后随正文 (VULN-B9-02)', () => {
    const input = [
        '<think>',
        '这是包含在带空格闭标中的思考内容',
        '</think >',
        '这是重要正文，绝不能被腰斩吞噬！'
    ].join('\n');

    const result = contextSanitizer.stripThoughtChains(input);
    assert.ok(!result.includes('这是包含在带空格闭标中的思考内容'), '带空格闭标思考链被剥离');
    assert.ok(result.includes('这是重要正文，绝不能被腰斩吞噬！'), '后随正文完整保留，未被腰斩');

    const inputThought = [
        '<thought>',
        'thought思考',
        '</thought   >',
        'thought后随正文'
    ].join('\n');
    const resultThought = contextSanitizer.stripThoughtChains(inputThought);
    assert.ok(!resultThought.includes('thought思考'));
    assert.ok(resultThought.includes('thought后随正文'));
});

test('Batch 9 Client Remediation R20: 散文提及 [[VCP协议纠偏指导: 不吃尾 (VULN-B9-04)', () => {
    const prose = '用户提问：请问 [[VCP协议纠偏指导: 是什么意思？请帮我解释一下具体功能。';
    const stripped = stripCompactionResilienceMarkers(prose);
    assert.equal(stripped, prose, '普通散文提及纠偏指导关键字不得被正则吃尾清空');

    const truncatedWithCode = '正文前置\n[[VCP协议纠偏指导: code=UNKNOWN_TOOL block=fp123';
    const strippedCode = stripCompactionResilienceMarkers(truncatedWithCode);
    assert.ok(!strippedCode.includes('[[VCP协议纠偏指导: code=UNKNOWN_TOOL'), '真实截断指导被剥离');
    assert.ok(strippedCode.includes('正文前置'), '前置正文保留');

    const truncatedWithNewline = '正文前置\n[[VCP协议纠偏指导:\n- 格式错误（未执行）';
    const strippedNewline = stripCompactionResilienceMarkers(truncatedWithNewline);
    assert.ok(!strippedNewline.includes('[[VCP协议纠偏指导:'), '换行型截断指导被剥离');
    assert.ok(strippedNewline.includes('正文前置'), '前置正文保留');
});

test('Batch 9 Client Remediation R20: containsRawVcpBlocks 保护成对外部工具标签与VCP块，放行孤立单边字面量进 Turndown (VULN-B9-05)', () => {
    assert.ok(!contextSanitizer.containsRawVcpBlocks('<<<[TOOL_REQUEST>>>\ntool_name: foo'), '孤立未闭合前缀不跳过HTML净化');
    assert.ok(!contextSanitizer.containsRawVcpBlocks('<<<DailyNoteStart>>>\n# notes'), '孤立未闭合DailyNote不跳过HTML净化');
    assert.ok(!contextSanitizer.containsRawVcpBlocks('<p>讨论 <tool_call 或 [TOOL_CALL] 或 <function_call 或 [FUNCTION_CALL]</p>'), '单次字面量不跳过HTML净化');

    assert.ok(contextSanitizer.containsRawVcpBlocks('<tool_call>{"name": "test"}</tool_call>'), '成对 <tool_call> 豁免');
    assert.ok(contextSanitizer.containsRawVcpBlocks('<function_call>{"name": "test"}</function_call>'), '成对 <function_call> 豁免');
    assert.ok(contextSanitizer.containsRawVcpBlocks('[TOOL_CALL] test [/TOOL_CALL]'), '成对 [TOOL_CALL] 豁免');
    assert.ok(contextSanitizer.containsRawVcpBlocks('[FUNCTION_CALL] test [/FUNCTION_CALL]'), '成对 [FUNCTION_CALL] 豁免');

    const rawExternal = '<p>调用示例：<tool_call>{"name": "search"}</tool_call></p>';
    const sanitized = contextSanitizer.sanitizeContent(rawExternal);
    assert.equal(sanitized, rawExternal, '包含成对外部工具标签的内容直通返回，不被 Markdown 转义破坏');

    const richTextWithSingleLiteral = '<p><strong>加粗说明</strong>：文档中提到 [TOOL_CALL] 与 &lt;tool_call 语法。</p>';
    const sanitizedRich = contextSanitizer.sanitizeContent(richTextWithSingleLiteral);
    assert.ok(sanitizedRich.includes('**加粗说明**'), '普通富文本出现单次字面量不得跳过 Turndown HTML->Markdown 净化');
});

test('Batch 9 Client Remediation R22: Markdown 围栏缩进差异代码块内部 <think> 保护 (P2-02)', () => {
    const codeWithDiffIndent = [
        '顶层思考：',
        '<think>',
        '顶层真实思考链必须剥除',
        '</think>',
        '正文开始：',
        '  ```python',
        '# 代码块内技术演示：',
        '<think>',
        '这是代码块内的think内容，绝对不能剥除',
        '</think>',
        '```',
        '正文结束。'
    ].join('\n');

    const cleaned = contextSanitizer.stripThoughtChains(codeWithDiffIndent);
    assert.ok(!cleaned.includes('顶层真实思考链必须剥除'), '顶层思考链必须被剥离');
    assert.ok(cleaned.includes('<think>\n这是代码块内的think内容，绝对不能剥除\n</think>'), '缩进差异代码块内思考标签100%保留');
    assert.ok(cleaned.includes('正文开始：'), '正文保留');
    assert.ok(cleaned.includes('正文结束。'), '正文保留');

    const tildeDiffIndent = [
        '~~~js',
        '<think>',
        '波浪线代码块内部思考',
        '</think>',
        '   ~~~'
    ].join('\n');
    const cleanedTilde = contextSanitizer.stripThoughtChains(tildeDiffIndent);
    assert.ok(cleanedTilde.includes('<think>\n波浪线代码块内部思考\n</think>'), '波浪线缩进差异代码块内思考标签保留');
});

test('Batch 9 Client Remediation R22: 「始Escape」大小写转义体内部 <think> 保护 (P2-03)', () => {
    const mixedCaseEscape = [
        '顶层思考：',
        '<think>',
        '外部思考被删',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」CaseTool「末」,',
        'content:「始Escape」',
        '这是转义体内容：',
        '<think>',
        'Escape大小写转义体内部思考',
        '</think>',
        '「末Escape」',
        '<<<[END_TOOL_REQUEST]>>>',
        '后随正文。'
    ].join('\n');

    const cleaned = contextSanitizer.stripThoughtChains(mixedCaseEscape);
    assert.ok(!cleaned.includes('外部思考被删'), '外部思考剥离');
    assert.ok(cleaned.includes('「始Escape」'), '转义体头保留');
    assert.ok(cleaned.includes('<think>\nEscape大小写转义体内部思考\n</think>'), '大小写转义体内部思考保留');
    assert.ok(cleaned.includes('「末Escape」'), '转义体尾保留');
    assert.ok(cleaned.includes('后随正文。'), '后随正文保留');
});

test('Batch 9 Chief-Architect Audit Fix: 标准多行思考链闭合后不残留前导换行（保护存量 OneRing 哈希）且单行元思考链+换行正文绝不吞尾', () => {
    // 1. 标准多行 <think> 块紧跟换行正文，必须逐字节返回正文（绝不残留前导 \n 破坏 OneRing 哈希）
    const stdThink = '<think>\n内部思考推导\n</think>\n正式回复正文';
    assert.equal(contextSanitizer.stripThoughtChains(stdThink), '正式回复正文', '标准 <think> 闭合行末尾换行必须消费，不得残留前导 \\n');

    const stdVcp = '[--- VCP元思考链: "Nova" ---]\n内部思考推导\n[--- 元思考链结束 ---]\n正式回复正文';
    assert.equal(contextSanitizer.stripThoughtChains(stdVcp), '正式回复正文', '标准 VCP 元思考链闭合行末尾换行必须消费');

    // 2. 单行 VCP 元思考链 + 换行正式回复，绝不能被 danglingVCP 误判吞空
    const singleLineVcpWithNextLine = '[--- VCP元思考链: "Nova" ---] 简短思考 [--- 元思考链结束 ---]\n正式回复正文';
    assert.equal(contextSanitizer.stripThoughtChains(singleLineVcpWithNextLine), '正式回复正文', '单行 VCP 元思考链后换行正文必须 100% 保留');

    // 3. 自定义前缀 XML 标签 <thinking_step> 不得触发悬挂截断吃尾
    const customXml = '前文说明\n<thinking_step>\n这是业务 XML 节点而非思考链\n后续总结';
    assert.equal(contextSanitizer.stripThoughtChains(customXml), customXml, '非标准思考标签 <thinking_step> 不得误吞至 EOF');

    // 4. stripCompactionResilienceMarkers 保护围栏代码块内的协议纠偏示例文档
    const docWithFence = [
        '开发复盘：',
        '```markdown',
        '[[VCP协议纠偏指导: code=MISSING_MAID block=12345678]]',
        '示例内容',
        '[[/VCP协议纠偏指导]]',
        '```',
        '[[VCP协议纠偏指导: code=MISSING_MAID block=87654321]]',
        '真实顶层回执应剥除',
        '[[/VCP协议纠偏指导]]',
        '结论保留。'
    ].join('\n');
    const compacted = stripCompactionResilienceMarkers(docWithFence);
    assert.ok(compacted.includes('block=12345678'), '代码围栏内示例回执必须保留');
    assert.ok(!compacted.includes('block=87654321'), '顶层真实回执必须剥离');
    assert.ok(compacted.includes('结论保留。'));
});

test('Audit Remediation P0-2 & P1-4 (Client): contextCompactionState 剥除空错误壳与配对坏块、保护 FileOperator 截断正文、过滤 <think> 内假日记并支持 fuzzy DailyNote', () => {
    const sampleHistory = [
        '我想调用工具：',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」LinuxShellExecutor「末」,',
        'command:「始」ls「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<<<[VCP_TOOL_BATCH_START:2026-11-24T10:00:00.000+08:00]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=3fa9c2e1]]',
        '请补齐 tool_name！',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '[本轮工具调用摘要:]',
        'VCP工具调用 格式错误（未执行）。',
        '[本轮工具调用摘要结束]',
        '<<<[VCP_TOOL_BATCH_END:2026-11-24T10:00:00.000+08:00]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '好的，我重发正确回答：完成。'
    ].join('\n');
    const d1 = [], w1 = [];
    const comp1 = extractDiaryText(sampleHistory, d1, w1);
    assert.ok(!comp1.includes('<<<[TOOL_REQUEST]>>>'), '配对坏块必须连同凭条一并剥离');
    assert.ok(!comp1.includes('❌ ERROR'), '掏空的错误汇总僵尸壳必须彻底清除');
    assert.ok(!comp1.includes('[本轮工具调用摘要:]'), '空摘要壳必须彻底清除');
    assert.ok(!comp1.includes('<<<[ROLE_DIVIDE_USER]>>>'), '空 ROLE_DIVIDE_USER 外壳必须彻底清除');
    assert.ok(comp1.includes('好的，我重发正确回答：完成。'));

    const readFileMsg = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容: 规范文档内容：',
        '[[VCP协议纠偏指导: code=MISSING_TOOL_NAME',
        '重要业务代码 const IMPORTANT = 123;',
        'VCP调用结果结束]]',
        '正常结尾'
    ].join('\n');
    const strippedRF = stripCompactionResilienceMarkers(readFileMsg);
    assert.ok(strippedRF.includes('IMPORTANT = 123'), 'FileOperator 工具结果内代码不可被截断');
    assert.ok(strippedRF.includes('正常结尾'), '工具结果之后的正文不可被吃掉');

    const thinkDiary = [
        '<think>',
        '我在思考要不要写日记：',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始」这是思考里的假日记草稿「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '算了不写了。',
        '</think>',
        '你好！'
    ].join('\n');
    const d2 = [], w2 = [];
    const comp2 = extractDiaryText(thinkDiary, d2, w2);
    assert.equal(d2.length, 0, '<think> 内部草拟的 DailyNote 绝不可入库');
    assert.ok(!comp2.includes('我在思考要不要写日记'), '顶层 <think> 必须从压缩输入中剥离');
    assert.ok(comp2.includes('你好！'));

    const fuzzyDiary = [
        '<<[TOOL_REQUEST]>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始」模糊外框日记内容「末」',
        '<<[END_TOOL_REQUEST]>>'
    ].join('\n');
    const d3 = [], w3 = [];
    const comp3 = extractDiaryText(fuzzyDiary, d3, w3);
    assert.equal(d3.length, 1, 'fuzzy <<[TOOL_REQUEST]>> DailyNote 必须正常归档');
    assert.equal(d3[0].content, '模糊外框日记内容');
    assert.ok(!comp3.includes('<<[TOOL_REQUEST]>>'));
});

test('Audit Remediation P0-4 & P1-4 (Client): contextSanitizer 保护嵌套工具结果、防跨代码块 ESCAPE 泄漏、识别 fuzzy 块防 Turndown 毁坏', () => {
    const nestedResult = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容: 内嵌示例 [[VCP调用结果信息汇总:',
        '- 工具名称: Inner',
        'VCP调用结果结束]]',
        '文件后续内容：',
        '<think>',
        '这是被读取的文件内容，绝不能删除！',
        '</think>',
        'VCP调用结果结束]]'
    ].join('\n');
    const csOut = contextSanitizer.stripThoughtChains(nestedResult);
    assert.ok(csOut.includes('这是被读取的文件内容，绝不能删除！'), '嵌套工具结果内部的 <think> 必须完整保留');

    const escAcrossFence = '```text\n示例开头： 「始ESCAPE」\n```\n<think>\n真实的思考链，必须被剥离！\n</think>\n```text\n示例结尾： 「末ESCAPE」\n```\n最终回答';
    const csOut2 = contextSanitizer.stripThoughtChains(escAcrossFence);
    assert.ok(!csOut2.includes('真实的思考链，必须被剥离！'), '跨代码块 ESCAPE 不可保护中间真实顶层 <think>');
    assert.ok(csOut2.includes('最终回答'));

    const fuzzyBlock = '<<[TOOL_REQUEST]>>\ntool_name:「始」Ls「末」\n<<[END_TOOL_REQUEST]>>';
    assert.equal(contextSanitizer.containsRawVcpBlocks(fuzzyBlock), true, 'containsRawVcpBlocks 必须识别 fuzzy <<[TOOL_REQUEST]>>');
    assert.equal(contextSanitizer.sanitizeContent(fuzzyBlock), fuzzyBlock, 'sanitizeContent 必须直通保护 fuzzy 工具块');
});

test('Audit Remediation Step 7 (05_附表 §2.5 & §3.4): memoryProtocolProjection、idleChat 与 topicTitleManager 全量净化', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
    const idleChat = require('../modules/deskpet/idleChat');
    const topicTitleManager = require('../Groupmodules/topicTitleManager');

    const fuzzyAndNoise = [
        '<<[TOOL_REQUEST]>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始ESCAPE」保密参数 <<[END_TOOL_REQUEST]>>「末ESCAPE」',
        '<<[END_TOOL_REQUEST]>>',
        '[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=3fa9c2e1]]',
        '纠偏模板',
        '[[/VCP协议纠偏指导]]',
        '[系统提示:] 【VCP 工具调用协议规范】规范正文【/VCP 工具调用协议规范】',
        '真实对话结尾'
    ].join('\n');
    const projected = projectMemoryProtocols(fuzzyAndNoise);
    assert.ok(projected.includes('调用了 FileOperator 工具。'), 'fuzzy 工具块必须投影为调用轨迹');
    assert.ok(!projected.includes('保密参数'), 'ESCAPE 参数不可泄漏');
    assert.ok(!projected.includes('[[VCP协议纠偏指导:'), '纠偏指导不可泄漏');
    assert.ok(!projected.includes('【VCP 工具调用协议规范】'), '常驻药丸不可泄漏');
    assert.ok(projected.includes('真实对话结尾'));

    const idleMsgs = idleChat.buildMessages({
        config: { systemPrompt: 'Nova' },
        agentName: 'Nova',
        history: [{
            role: 'assistant',
            content: '<think>\nSECRET_THOUGHT\n</think>\n[[VCP调用结果信息汇总:[HIDDEN]\nSECRET_HIDDEN\nVCP调用结果结束]]\n[系统提示:] 【VCP 工具调用协议规范】PILL【/VCP 工具调用协议规范】\n可见聊天内容'
        }]
    });
    assert.equal(idleMsgs[1].content, '可见聊天内容');
    assert.equal(idleChat.cleanLine('<<[TOOL_REQUEST]>>tool_name:「始」Ls「末」<<[END_TOOL_REQUEST]>>'), null);

    const groupSummary = topicTitleManager.buildSummaryContent([
        { role: 'user', content: '帮我查一下' },
        { role: 'assistant', content: '<think>\nHIDDEN_THOUGHT\n</think>\n[[VCP协议纠偏指导: code=X block=11111111]]\nerr\n[[/VCP协议纠偏指导]]\n最终答复' }
    ], { userName: 'User' });
    assert.ok(!groupSummary.includes('HIDDEN_THOUGHT'));
    assert.ok(!groupSummary.includes('[[VCP协议纠偏指导:'));
    assert.ok(groupSummary.includes('最终答复'));
});

test('Audit Remediation Step 7 (05_附表 §3.4): topicSummarizer 浏览器安全清洗思考链与协议噪声（保护代码块）', async () => {
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    let requestBody;
    globalThis.window = {
        chatAPI: {
            async loadSettings() {
                return { vcpServerUrl: 'https://vcpchat.test/v1/chat/completions', vcpApiKey: 'key', userName: 'User' };
            },
        },
    };
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, async json() { return { choices: [{ message: { content: '安全标题' } }] }; } };
    };
    try {
        const moduleUrl = new URL('../modules/topicSummarizer.js', import.meta.url);
        moduleUrl.search = `?audit-remediation=${Date.now()}`;
        await import(moduleUrl.href);
        const title = await globalThis.window.summarizeTopicFromMessages([
            { role: 'user', content: '请帮忙分析' },
            { role: 'assistant', content: '<think>\nSECRET_TOPIC_THOUGHT\n</think>\n[[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=12345678]]\nerr\n[[/VCP协议纠偏指导]]\n```js\n<think>CODE_LITERAL</think>\n```\n结论完成' },
            { role: 'user', content: '好的' },
            { role: 'assistant', content: '收到' },
        ], 'Nova');
        assert.equal(title, '安全标题');
        const sentPrompt = requestBody.messages[0].content;
        assert.ok(!sentPrompt.includes('SECRET_TOPIC_THOUGHT'), 'topicSummarizer 必须剥离顶层思考链');
        assert.ok(!sentPrompt.includes('[[VCP协议纠偏指导:'), 'topicSummarizer 必须剥离协议纠偏');
        assert.ok(sentPrompt.includes('CODE_LITERAL'), 'topicSummarizer 必须保护代码围栏内部字面量');
        assert.ok(sentPrompt.includes('结论完成'));
    } finally {
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = prevFetch;
    }
});

test('Post-Commit Audit P1-1 (Client): contextCompactionState 精确指纹对账与 ESCAPE 载荷隔离，绝不误删第 2 跳合法 WriteFile', async () => {
    const { createHash } = await import('node:crypto');
    const sha1_8 = (s) => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);

    const brokenTurn1 = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」LinuxShellExecutor「末」,',
        'command:「始」ls「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const fp1 = sha1_8(brokenTurn1);

    const validTurn2 = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'path:「始」src/demo.js「末」,',
        'content:「始ESCAPE」',
        'const maid = "Nova";',
        'const marker = "「始」";',
        '「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const msgWithClosedFp = [
        brokenTurn1,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${fp1}]]`,
        '请补充 tool_name',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '好的我重试：',
        validTurn2,
    ].join('\n');

    const out1 = stripCompactionResilienceMarkers(msgWithClosedFp);
    assert.ok(!out1.includes('LinuxShellExecutor'), 'Turn 1 坏块必须被精确剥离');
    assert.ok(out1.includes('WriteFile'), 'Turn 2 合法 WriteFile 必须保留');
    assert.ok(out1.includes('const maid = "Nova";'), 'Turn 2 ESCAPE 正文必须完整保留');
    assert.ok(out1.includes('const marker = "「始」";'), 'Turn 2 ESCAPE 内单边「始」必须完整保留');

    // Case B: Turn 1 为未闭合块（指纹不对应任何闭合块），仍必须保护 Turn 2 含 ESCAPE 载荷的合法块
    const unclosedTurn1 = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」LinuxShellExecutor「末」',
    ].join('\n');
    const fpUnclosed = sha1_8(unclosedTurn1);
    const msgWithUnclosedFp = [
        '先试一次：',
        unclosedTurn1,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=${fpUnclosed}]]`,
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '好的我重试：',
        validTurn2,
    ].join('\n');

    const out2 = stripCompactionResilienceMarkers(msgWithUnclosedFp);
    assert.ok(!out2.includes('LinuxShellExecutor'), 'Turn 1 未闭合坏块必须被剥离');
    assert.ok(out2.includes('WriteFile'), 'Turn 2 合法 WriteFile 必须保留');
    assert.ok(out2.includes('const maid = "Nova";'), 'Turn 2 ESCAPE 正文必须完整保留');

    // Case C: 中文/Emoji UTF-8 SHA-1 黑名单语义坏块精确匹配（无语法坏特征但指纹命中）
    const semanticBroken = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」Nova角色「末」,',
        'maid:「始」FileOperator「末」,',
        'note:「始」测试中文😀「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const fpSemantic = sha1_8(semanticBroken);
    const msgSemantic = [
        semanticBroken,
        '<<<[ROLE_DIVIDE_USER]>>>',
        `[[VCP协议纠偏指导: code=INVALID_TOOL_NAME block=${fpSemantic}]]`,
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        validTurn2,
    ].join('\n');
    const out3 = stripCompactionResilienceMarkers(msgSemantic);
    assert.ok(!out3.includes('Nova角色'), 'UTF-8 指纹命中的黑名单坏块必须被精确剥离');
    assert.ok(out3.includes('const maid = "Nova";'), 'Turn 2 合法 ESCAPE 调用必须保留');
});

test('Post-Commit Audit P2-1 & P3-1 (Client): 单遍源码顺序扫描防跨工具块单边围栏泄漏 <think>，且行首约束保护 FileOperator 孤立字面量', () => {
    const twoToolsWithSplitFence = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」',
        '```js',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<think>',
        'REAL_THOUGHT_BETWEEN_TWO_TOOLS',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '最终答案。',
    ].join('\n');

    const csStripped = contextSanitizer.stripThoughtChains(twoToolsWithSplitFence);
    assert.ok(!csStripped.includes('REAL_THOUGHT_BETWEEN_TWO_TOOLS'), 'contextSanitizer 不得跨工具块配对单边围栏而泄漏真实 <think>');
    assert.ok(csStripped.includes('最终答案。'));

    const d = [], w = [];
    const compStripped = extractDiaryText(twoToolsWithSplitFence, d, w);
    assert.ok(!compStripped.includes('REAL_THOUGHT_BETWEEN_TWO_TOOLS'), 'contextCompactionState 不得跨工具块配对单边围栏而泄漏真实 <think>');
    assert.ok(compStripped.includes('最终答案。'));

    // P3-1: FileOperator 返回源码中，<think> 位于非行首孤立字面量 "[[VCP调用结果信息汇总:" 之前
    const fileOpWithInlineLiteral = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容:',
        '<think>',
        'FILE_THINK_MUST_SURVIVE',
        '</think>',
        'if (line.includes("[[VCP调用结果信息汇总:")) return true;',
        'VCP调用结果结束]]',
        '<think>',
        'TOP_LEVEL_THINK_MUST_STRIP',
        '</think>',
        '总结完成。',
    ].join('\n');

    const csFileOp = contextSanitizer.stripThoughtChains(fileOpWithInlineLiteral);
    assert.ok(csFileOp.includes('FILE_THINK_MUST_SURVIVE'), 'contextSanitizer 必须保护孤立非行首字面量前方的文件内 <think>');
    assert.ok(!csFileOp.includes('TOP_LEVEL_THINK_MUST_STRIP'), '顶层真实 <think> 必须剥离');

    const d2 = [], w2 = [];
    const compFileOp = extractDiaryText(fileOpWithInlineLiteral, d2, w2);
    assert.ok(compFileOp.includes('FILE_THINK_MUST_SURVIVE'), 'contextCompactionState 必须保护孤立非行首字面量前方的文件内 <think>');
    assert.ok(!compFileOp.includes('TOP_LEVEL_THINK_MUST_STRIP'), '顶层真实 <think> 必须剥离');
});

test('Post-Commit Audit P3-3 (Client): topicSummarizer 支持嵌套工具结果计数、[HIDDEN] 剥离与单遍围栏/工具块保护', async () => {
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    let requestBody;
    globalThis.window = {
        chatAPI: {
            async loadSettings() {
                return { vcpServerUrl: 'https://vcpchat.test/v1/chat/completions', vcpApiKey: 'key', userName: 'User' };
            },
        },
    };
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, async json() { return { choices: [{ message: { content: '嵌套清洗标题' } }] }; } };
    };
    try {
        const { createRequire } = await import('node:module');
        const req = createRequire(import.meta.url);
        const resolved = req.resolve('../modules/topicSummarizer.js');
        delete req.cache[resolved];
        req(resolved);
        const title = await globalThis.window.summarizeTopicFromMessages([
            { role: 'user', content: '请读取文件' },
            {
                role: 'assistant',
                content: [
                    '[[VCP调用结果信息汇总:[HIDDEN]',
                    'SECRET_HIDDEN_RESULT',
                    'VCP调用结果结束]]',
                    '[[VCP调用结果信息汇总:',
                    '- 工具名称: FileOperator',
                    '- 返回内容: 示例 [[VCP调用结果信息汇总:',
                    '- 工具名称: Inner',
                    'VCP调用结果结束]]',
                    '<think>NESTED_FILE_THINK_KEEP</think>',
                    'VCP调用结果结束]]',
                    '<<<[TOOL_REQUEST]>>>',
                    'tool_name:「始」WriteFile「末」,',
                    'content:「始」\n```js\n「末」',
                    '<<<[END_TOOL_REQUEST]>>>',
                    '<think>\nREAL_THOUGHT_BETWEEN_TWO_TOOLS\n</think>',
                    '<<<[TOOL_REQUEST]>>>',
                    'tool_name:「始」WriteFile「末」,',
                    'content:「始」\n```\n「末」',
                    '<<<[END_TOOL_REQUEST]>>>',
                    '最终回答保留。',
                ].join('\n'),
            },
            { role: 'user', content: '谢谢' },
            { role: 'assistant', content: '不客气' },
        ], 'Nova');
        assert.equal(title, '嵌套清洗标题');
        const sentPrompt = requestBody.messages[0].content;
        assert.ok(!sentPrompt.includes('SECRET_HIDDEN_RESULT'), '[HIDDEN] 工具结果必须剥离');
        assert.ok(sentPrompt.includes('NESTED_FILE_THINK_KEEP'), '嵌套工具结果内部内容必须完整保护');
        assert.ok(!sentPrompt.includes('REAL_THOUGHT_BETWEEN_TWO_TOOLS'), '跨工具块单边围栏间的真实 <think> 必须剥离');
        assert.ok(sentPrompt.includes('最终回答保留。'));
    } finally {
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = prevFetch;
    }
});

test('Post-Commit Audit Follow-up (Client): ROLE_DIVIDE_USER 内 FileOperator 含纠偏字面量不误删合法块，且 END 行尾约束防源码字面量提前闭合', async () => {
    const { createHash } = await import('node:crypto');
    const sha1_8 = (s) => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);

    // 1. 合法 FileOperator 工具块 + ROLE_DIVIDE_USER 内工具返回正文恰好引用 [[VCP协议纠偏指导: code=TEST block=<该合法块fp>]]
    const validFileOpCall = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」FileOperator「末」,',
        'command:「始」ReadFile「末」,',
        'path:「始」docs/resilience.md「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const fpValid = sha1_8(validFileOpCall);

    const msgWithDocLiteral = [
        validFileOpCall,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        `- 返回内容: 文档示例：[[VCP协议纠偏指导: code=TEST block=${fpValid}]]`,
        '以及字面量 <<<[END_ROLE_DIVIDE_USER]>>>',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '读取完成。',
    ].join('\n');

    const cleanedDoc = stripCompactionResilienceMarkers(msgWithDocLiteral);
    assert.ok(cleanedDoc.includes('docs/resilience.md'), '合法 FileOperator 调用绝不能被工具输出内的纠偏字面量误删');
    assert.ok(cleanedDoc.includes(`block=${fpValid}`), 'FileOperator 正常返回正文必须完整保留');
    assert.ok(cleanedDoc.includes('读取完成。'));

    // 2. P3-1 对称面：FileOperator 读取源码含 const END = "VCP调用结果结束]]"; 与后续文件内 <think>
    const fileOpWithInlineEnd = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容:',
        'const START = "[[VCP调用结果信息汇总:";',
        'const END = "VCP调用结果结束]]";',
        '<think>',
        'FILE_THINK_AFTER_END_LITERAL',
        '</think>',
        'VCP调用结果结束]]',
        '<think>',
        'TOP_LEVEL_THINK_MUST_STRIP_AFTER_END',
        '</think>',
        '汇总结尾。',
    ].join('\n');

    const csEnd = contextSanitizer.stripThoughtChains(fileOpWithInlineEnd);
    assert.ok(csEnd.includes('FILE_THINK_AFTER_END_LITERAL'), 'contextSanitizer 不得在 const END = "VCP调用结果结束]]"; 处提前闭合');
    assert.ok(!csEnd.includes('TOP_LEVEL_THINK_MUST_STRIP_AFTER_END'), '顶层 <think> 必须剥离');

    const dEnd = [], wEnd = [];
    const compEnd = extractDiaryText(fileOpWithInlineEnd, dEnd, wEnd);
    assert.ok(compEnd.includes('FILE_THINK_AFTER_END_LITERAL'), 'contextCompactionState 不得在 const END = "VCP调用结果结束]]"; 处提前闭合');
    assert.ok(!compEnd.includes('TOP_LEVEL_THINK_MUST_STRIP_AFTER_END'), '顶层 <think> 必须剥离');
});

test('Batch 9 Audit P0-1: 第 1 跳未闭 DailyNote 不得跨 ROLE_DIVIDE_USER 吞并第 2 跳合法 DailyNote，且已拒执行闭块不污染 diaries', async () => {
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { createHash } = await import('node:crypto');
    const sha1_8 = (s) => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);

    // 1. 第 1 跳未闭合 DailyNote + 回执 + 第 2 跳合法 DailyNote
    const jump1Unclosed = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'Content:「始」未闭合草稿',
    ].join('\n');
    const jump2Valid = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'fileName:「始」day2.txt「末」,',
        'Content:「始」第2跳正式日记「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const crossJumpSource = [
        '前置对话',
        jump1Unclosed,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '重试写入：',
        jump2Valid,
        '后置正文',
    ].join('\n');

    const scannedNames = [];
    replaceToolRequestBlocks(crossJumpSource, (raw) => {
        scannedNames.push(raw);
        return raw;
    }, { allowFuzzyStart: true, stopAtProtocolWalls: true });
    assert.equal(scannedNames.length, 1, 'stopAtProtocolWalls=true 必须跳过第1跳未闭块并完整扫描第2跳');
    assert.ok(scannedNames[0].includes('第2跳正式日记'));

    const d1 = [], w1 = [];
    const compacted1 = extractDiaryText(crossJumpSource, d1, w1);
    assert.equal(d1.length, 1, '第2跳合法 DailyNote 必须成功入库');
    assert.equal(d1[0].content, '第2跳正式日记');
    assert.ok(!compacted1.includes('未闭合草稿'), '第1跳未闭 DailyNote 必须剥离');
    assert.ok(!compacted1.includes('[[VCP协议纠偏指导:'), '回执必须剥离');
    assert.ok(compacted1.includes('前置对话') && compacted1.includes('重试写入：') && compacted1.includes('后置正文'));

    // 2. 第 1 跳为服务端明确拒绝执行的闭合 DailyNote（指纹命中），绝不进入 diaries
    const rejectedClosedDiary = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'fileName:「始」rejected.txt「末」,',
        'Content:「始」被服务端拒执行的假日记「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const fpRejected = sha1_8(rejectedClosedDiary);
    const rejectedHistory = [
        rejectedClosedDiary,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=INVALID_FIELD block=${fpRejected}]]`,
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        jump2Valid,
    ].join('\n');
    const d2 = [], w2 = [];
    const compacted2 = extractDiaryText(rejectedHistory, d2, w2);
    assert.equal(d2.length, 1, '只有第2跳合法 DailyNote 允许入 diaries');
    assert.equal(d2[0].content, '第2跳正式日记');
    assert.ok(!compacted2.includes('被服务端拒执行的假日记'));

    // 3. <tool_name>DailyNote</tool_name> 未闭合形式 + 第2跳合法 DailyNote
    const xmlUnclosed = [
        '<<<[TOOL_REQUEST]>>>',
        '<tool_name>DailyNote</tool_name>',
        '未闭合XML草稿',
        '',
        '中间正常段落必须保留。',
        jump2Valid,
    ].join('\n');
    const d3 = [], w3 = [];
    const compacted3 = extractDiaryText(xmlUnclosed, d3, w3);
    assert.equal(d3.filter(d => !d.unparsed).length, 1);
    assert.equal(d3.find(d => !d.unparsed).content, '第2跳正式日记');
    assert.equal(d3[0].unparsed, true, '无纠偏回执拦截的未解析旧日记保留 unparsed 兜底');
    assert.ok(!compacted3.includes('未闭合XML草稿'));
    assert.ok(compacted3.includes('中间正常段落必须保留。'));
});

test('Batch 9 Audit P0-2 & P1-5(3): 未闭块夹中间正文与第 2 跳合法 ReadFile、裸纠偏结果块均线性安全清除', () => {
    const validReadFile = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'command:「始」ReadFile「末」,',
        'path:「始」README.md「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const sandwiched = [
        '第一段前文',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」BrokenTool「末」',
        '',
        '这是夹在未闭块与回执之间的重要正文，绝对不能被正则吞掉！',
        validReadFile,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '尾部正文',
    ].join('\n');

    const cleaned1 = stripCompactionResilienceMarkers(sandwiched);
    assert.ok(!cleaned1.includes('BrokenTool'), '未闭合坏块必须被清除');
    assert.ok(cleaned1.includes('这是夹在未闭块与回执之间的重要正文，绝对不能被正则吞掉！'), '夹在中间的正文必须保留');
    assert.ok(cleaned1.includes('README.md'), '第2跳合法 ReadFile 必须完整保留');
    assert.ok(cleaned1.includes('尾部正文'));

    // 无 ROLE_DIVIDE_USER 外壳的裸纠偏结果块
    const bareGuidance = [
        '前文保留',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」BrokenBare「末」',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=cafebabe]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '后文保留',
    ].join('\n');
    const cleaned2 = stripCompactionResilienceMarkers(bareGuidance);
    assert.ok(!cleaned2.includes('BrokenBare'));
    assert.ok(!cleaned2.includes('cafebabe'));
    assert.ok(cleaned2.includes('前文保留') && cleaned2.includes('后文保留'));
});

test('Batch 9 Audit P1-1 & P1-2 & P1-3 & P2-5: idleChat ReDoS < 100ms、普通字段字面量 ESCAPE 不越界、单遍不瞬移、P1-3 行首尾与 P2-5 BATCH 豁免', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const idleChat = require('../modules/deskpet/idleChat');

    // 1. P1-1(a) & (b): n=20 对 ESCAPE 恶意输入无 ReDoS 且截断未闭合工具块
    const evilEscapePairs = '「始ESCAPE」payload「末ESCAPE」'.repeat(20);
    const t0 = performance.now();
    const evilOut = idleChat.cleanLine(`<<<[TOOL_REQUEST]>>>${evilEscapePairs}`);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 100, `idleChat.cleanLine ReDoS 防护超时: ${elapsedMs.toFixed(2)}ms`);
    assert.equal(evilOut, null, '纯未闭合工具块不得泄漏到桌宠气泡');

    const withProseAndUnclosed = idleChat.cleanLine('<!--emo:happy 0.7-->你好呀！\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」Ls「末」');
    assert.equal(withProseAndUnclosed?.text, '你好呀！');

    // 2. P1-1(c): 普通字段载荷内含字面量 「始ESCAPE」 不得开启块级 ESCAPE 吞掉后续 <think>
    const normalFieldLiteralEscape = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'note:「始」说明：普通字段里出现字面量「始ESCAPE」不是转义开关「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<think>',
        'REAL_THOUGHT_AFTER_LITERAL_ESCAPE',
        '</think>',
        '正常回复。',
    ].join('\n');
    const outNormalEsc = contextSanitizer.stripThoughtChains(normalFieldLiteralEscape);
    assert.ok(!outNormalEsc.includes('REAL_THOUGHT_AFTER_LITERAL_ESCAPE'), '普通字段内字面量「始ESCAPE」不得泄漏后续思考链');
    assert.ok(outNormalEsc.includes('正常回复。'));

    // 3. P1-2: 未闭合工具块夹在围栏代码块之前，绝不瞬移跳过中间闭合围栏
    const unclosedBeforeFence = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」Broken「末」',
        '<think>',
        'OUTSIDE_THOUGHT_MUST_STRIP',
        '</think>',
        '```js',
        '<think>',
        'FENCE_THOUGHT_MUST_KEEP',
        '</think>',
        '```',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」Valid「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '结尾',
    ].join('\n');
    const outNoTeleport = contextSanitizer.stripThoughtChains(unclosedBeforeFence);
    assert.ok(!outNoTeleport.includes('OUTSIDE_THOUGHT_MUST_STRIP'), '未闭块后的真实顶层思考链必须剥离');
    assert.ok(outNoTeleport.includes('FENCE_THOUGHT_MUST_KEEP'), '中间闭合围栏代码块内的 <think> 必须保留');

    // 4. P1-3 & P2-5: 行首散文 [[VCP调用结果信息汇总: 与行中 VCP调用结果结束]] 不错配，同一行 BATCH 标记豁免
    const inlineProseInfo = [
        '解释一下 [[VCP调用结果信息汇总: 标记的用法。',
        '<think>',
        'THOUGHT_MUST_STRIP_P1_3',
        '</think>',
        '以及 VCP调用结果结束]] 怎么使用。',
    ].join('\n');
    assert.ok(!contextSanitizer.stripThoughtChains(inlineProseInfo).includes('THOUGHT_MUST_STRIP_P1_3'));

    const sameLineBatchInfo = [
        '<<<[VCP_TOOL_BATCH_START:2026-11-24T10:00:00Z]>>>[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容: const END = "VCP调用结果结束]]";',
        '<think>KEEP_INSIDE_BATCH_INFO</think>',
        'VCP调用结果结束]]<<<[VCP_TOOL_BATCH_END:2026-11-24T10:00:00Z]>>>',
    ].join('\n');
    const outBatch = contextSanitizer.stripThoughtChains(sameLineBatchInfo);
    assert.ok(outBatch.includes('KEEP_INSIDE_BATCH_INFO'), 'P2-5 同行 BATCH 标记前后约束必须豁免，保护结果内 <think>');
});

test('Batch 9 Audit P1-4 & P1-5(2): 普通括号载荷含 tool_name =、FileOperator 未闭围栏、普通超时错误不误删、Cat V 坏块清除', async () => {
    const { createHash } = await import('node:crypto');
    const sha1_8 = (s) => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);

    // 1. P1-4(1): 第2跳合法 WriteFile 使用普通 「始」...「末」 且正文包含 tool_name = "..."
    const validNormalWriteFile = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」const tool_name = "demo"; const maid = "x";「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    // 2. P1-4(2): 前文 FileOperator 输出含未闭合围栏 ```js
    const msgP14 = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容:',
        '```js',
        'const unclosed = 1;',
        'VCP调用结果结束]]',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」BrokenCall「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${sha1_8('<<<[TOOL_REQUEST]>>>\nmaid:「始」BrokenCall「末」\n<<<[END_TOOL_REQUEST]>>>')}]]`,
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        validNormalWriteFile,
    ].join('\n');
    const outP14 = stripCompactionResilienceMarkers(msgP14);
    assert.ok(!outP14.includes('BrokenCall'), 'BrokenCall 坏块必须被剥离');
    assert.ok(outP14.includes('const tool_name = "demo";'), '普通括号载荷内的合法 WriteFile 绝不可被误删');

    // 3. P1-4(3): 无纠偏指导的普通 VCP工具调用 超时错误必须保留
    const timeoutErrMsg = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: 请求上游工具服务超时（30000ms），未生成结果。',
        'VCP调用结果结束]]',
        '已收到超时信息。',
    ].join('\n');
    const outTimeout = stripCompactionResilienceMarkers(timeoutErrMsg);
    assert.ok(outTimeout.includes('请求上游工具服务超时'), '普通超时错误绝不可被误判为纠偏回执而删空');

    // 4. P1-5(2): Category V 外部协议坏块连同回执一并剥除，同时保护围栏内示例
    const catV = [
        '```xml',
        '<tool_call>{"name": "fenceExample"}</tool_call>',
        '```',
        '<tool_call>{"name": "badExternal"}</tool_call>',
        '[FUNCTION_CALL]badFunc()[/FUNCTION_CALL]',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP协议纠偏指导: code=EXTERNAL_TOOL_SYNTAX block=deadbeef]]',
        '请使用 VCP 格式',
        '[[/VCP协议纠偏指导]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '继续后续回答。',
    ].join('\n');
    const outCatV = stripCompactionResilienceMarkers(catV);
    assert.ok(outCatV.includes('fenceExample'), '围栏代码块内示例保留');
    assert.ok(!outCatV.includes('badExternal'), 'Category V <tool_call> 坏块必须剥离');
    assert.ok(!outCatV.includes('badFunc'), 'Category V [FUNCTION_CALL] 坏块必须剥离');
    assert.ok(outCatV.includes('继续后续回答。'));
});

test('Batch 9 Audit P1-6 & P2-3 & P2-2 & P2-1 & P2-4: 隐藏块防护、混合摘要分号保真、多模态 topicSummarizer/topicTitleManager、memoryProtocolProjection 与 groupchat/jev', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const resilienceMask = require('../modules/shared/vcpResilienceMask');
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
    const topicTitleManager = require('../Groupmodules/topicTitleManager');
    const { buildDecisionRequest } = require('../Groupmodules/modes/jevDecisionMode');
    const fs = require('node:fs');
    const path = require('node:path');

    // 1. P1-6: stripHiddenToolResults 保护代码块 [HIDDEN] 与源码内 END 字面量
    const hiddenInput = [
        '```text',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        'IN_FENCE_HIDDEN',
        'VCP调用结果结束]]',
        '```',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容: const END = "VCP调用结果结束]]";',
        'VCP调用结果结束]]',
        '[[VCP调用结果信息汇总: <!--HIDDEN-->',
        'REAL_HIDDEN_BLOCK',
        'VCP调用结果结束]]',
        '正文保留',
    ].join('\n');
    const hiddenOut = contextSanitizer.stripHiddenToolResults(hiddenInput);
    assert.ok(hiddenOut.includes('IN_FENCE_HIDDEN'));
    assert.ok(hiddenOut.includes('const END = "VCP调用结果结束]]";'));
    assert.ok(!hiddenOut.includes('REAL_HIDDEN_BLOCK'));
    assert.ok(hiddenOut.includes('正文保留'));

    // 2. P2-3: 混合摘要分号保真 + 空壳剥离 + 普通散文不受伤
    const mixedSummary = '[本轮工具调用摘要:]ReadFile 调用成功；VCP工具调用 格式错误（未执行）；WriteFile 调用成功[本轮工具调用摘要结束]';
    const cleanedSummary = resilienceMask.stripErrorSummaryItemsInSummaryBlocks(mixedSummary);
    assert.equal(cleanedSummary, '[本轮工具调用摘要:]ReadFile 调用成功；WriteFile 调用成功[本轮工具调用摘要结束]');

    const allErrorSummary = '[本轮工具调用摘要:]VCP工具调用 格式错误（未执行）；DailyNote 执行失败（未执行）[本轮工具调用摘要结束]\n普通散文：如果看到 VCP工具调用 格式错误（未执行）；请重试。';
    const cleanedAllErr = resilienceMask.stripProtocolResilienceNoise(allErrorSummary);
    assert.ok(!cleanedAllErr.includes('[本轮工具调用摘要:]'));
    assert.ok(cleanedAllErr.includes('普通散文：如果看到 VCP工具调用 格式错误（未执行）；请重试。'), '普通散文绝不能被误伤');

    // 3. P2-2: 多模态 topicTitleManager 与 topicSummarizer
    const groupMM = topicTitleManager.buildSummaryContent([
        {
            role: 'assistant',
            content: [
                { type: 'text', text: '<think>\nMM_SECRET\n</think>\n多模态文本内容' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
        },
    ], { userName: 'User' });
    assert.ok(!groupMM.includes('MM_SECRET'));
    assert.ok(groupMM.includes('多模态文本内容'));

    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    let sentBody;
    globalThis.window = {
        VCPProtocolResilienceMask: resilienceMask,
        chatAPI: { async loadSettings() { return { vcpServerUrl: 'https://test/v1', vcpApiKey: 'k', userName: 'User' }; } },
    };
    globalThis.fetch = async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { ok: true, async json() { return { choices: [{ message: { content: '多模态标题' } }] }; } };
    };
    try {
        const resolved = require.resolve('../modules/topicSummarizer.js');
        delete require.cache[resolved];
        require(resolved);
        const mmTitle = await globalThis.window.summarizeTopicFromMessages([
            { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }] },
            { role: 'assistant', content: [{ type: 'text', text: '<think>\nSUM_MM_SECRET\n</think>\n识别完成' }] },
            { role: 'user', content: '谢谢' },
            { role: 'assistant', content: '不客气' },
        ], 'Nova');
        assert.equal(mmTitle, '多模态标题');
        assert.ok(!sentBody.messages[0].content.includes('SUM_MM_SECRET'));
        assert.ok(sentBody.messages[0].content.includes('识别完成'));
    } finally {
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = prevFetch;
    }

    // 4. P2-1: memoryProtocolProjection 记忆边界保真、括号配对、摘要过滤、截断纠偏清理
    const memInput = [
        '<<<[TOOL_REQUEST]>>>tool_name:「始」BrokenMem「末」',
        'text:「始」未闭合参数',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '这是后面非常重要的用户记忆，绝对不能被吃掉！',
        '[本轮工具调用摘要:]ReadFile 调用成功；VCP工具调用 格式错误（未执行）；WriteFile 调用成功[本轮工具调用摘要结束]',
        '[本轮工具调用摘要:]VCP工具调用 格式错误（未执行）[本轮工具调用摘要结束]',
    ].join('\n');
    const memOut = projectMemoryProtocols(memInput);
    assert.ok(memOut.includes('这是后面非常重要的用户记忆，绝对不能被吃掉！'));
    assert.ok(memOut.includes('工具调用摘要：ReadFile 调用成功；WriteFile 调用成功'));
    assert.equal((memOut.match(/工具调用摘要：/g) || []).length, 1);
    assert.ok(!memOut.includes('[[VCP协议纠偏指导:'));

    // 5. P2-4: jevDecisionMode 清洗 recentMessages & groupchat 剥离 __vcpContextCheckpoint
    const jevReq = buildDecisionRequest(
        [{ id: 'a1', name: 'Agent1' }],
        [{
            id: 'm1',
            role: 'assistant',
            name: 'Agent1',
            agentId: 'a1',
            content: '<think>\nJEV_SECRET\n</think>\n[[VCP调用结果信息汇总:[HIDDEN]\nJEV_HIDDEN\nVCP调用结果结束]]\n[[VCP协议纠偏指导: code=X block=11111111]]\n有效导航内容',
        }],
        { id: 'g1', name: 'G1', modeSettings: { jev: {} } }
    );
    assert.equal(jevReq.state.recentMessages[0].text, '有效导航内容');

    const groupChatSrc = fs.readFileSync(path.resolve(process.cwd(), 'Groupmodules/groupchat.js'), 'utf8');
    assert.match(groupChatSrc, /const\s*\{\s*__vcpchatTimestampMeta\s*,\s*__vcpContextCheckpoint\s*,\s*\.\.\.cleanMessage\s*\}\s*=\s*message\s*;/);

    // 6. main.html 注入顺序校验
    const mainHtml = fs.readFileSync(path.resolve(process.cwd(), 'main.html'), 'utf8');
    const maskIdx = mainHtml.indexOf('<script src="modules/shared/vcpResilienceMask.js"></script>');
    const sumIdx = mainHtml.indexOf('<script src="modules/topicSummarizer.js"></script>');
    const renIdx = mainHtml.indexOf('<script type="module" src="renderer.js"');
    assert.ok(maskIdx > 0 && sumIdx > maskIdx && renIdx > sumIdx, 'main.html 脚本加载顺序必须为 vcpResilienceMask -> topicSummarizer -> renderer');
});

test('Batch 9 Audit Review Follow-up: 普通字段内含字面协议标记+单层ESCAPE与跨工具结果未闭围栏防护', () => {
    // 1. 合法 WriteFile 普通字段内包含字面量 <<<[TOOL_REQUEST]>>> / <<<[END_TOOL_REQUEST]>>> 与单层 「始ESCAPE」...「末ESCAPE」及 <think> 字面量
    const validWriteWithLiterals = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」',
        '示例1：<<<[TOOL_REQUEST]>>> 与 <<<[END_TOOL_REQUEST]>>>',
        '「始ESCAPE」<<<[END_TOOL_REQUEST]>>>「末ESCAPE」',
        '<think>',
        'INSIDE_WRITEFILE_THINK_MUST_KEEP',
        '</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<think>',
        'OUTSIDE_THINK_MUST_STRIP',
        '</think>',
        '最终正文保留',
    ].join('\n');
    const out1 = contextSanitizer.stripThoughtChains(validWriteWithLiterals);
    assert.ok(out1.includes('INSIDE_WRITEFILE_THINK_MUST_KEEP'), '普通字段内含字面量协议标与单层ESCAPE时，<think> 字面量必须100%保留');
    assert.ok(!out1.includes('OUTSIDE_THINK_MUST_STRIP'), '工具块外顶层思考链必须剥离');
    assert.ok(out1.includes('最终正文保留'));

    // 2. FileOperator #1 含单边未闭 ```js + 中间真实 [HIDDEN] + FileOperator #2 含 ```
    const splitFenceAcrossTools = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容:',
        '```js',
        'const a = 1;',
        'VCP调用结果结束]]',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        'MIDDLE_HIDDEN_MUST_DELETE',
        'VCP调用结果结束]]',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容:',
        '```',
        'const b = 2;',
        'VCP调用结果结束]]',
        '结尾保留',
    ].join('\n');
    const out2 = contextSanitizer.stripHiddenToolResults(splitFenceAcrossTools);
    assert.ok(!out2.includes('MIDDLE_HIDDEN_MUST_DELETE'), '跨工具结果未闭围栏不得屏蔽中间真实 [HIDDEN] 结果');
    assert.ok(out2.includes('const a = 1;'), 'FileOperator #1 必须完好保留');
    assert.ok(out2.includes('const b = 2;'), 'FileOperator #2 必须完好保留');
    assert.ok(out2.includes('结尾保留'));
});

test('Batch 9 Audit Two-Track NEW-P0-1 & NEW-P0-2: 全量 HTML 加载、ESM 无 process 兜底、未闭 ESCAPE 跨跳防护', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');

    // 1. NEW-P0-1: 所有相关 HTML 入口都在前置加载 vcpResilienceMask.js
    const htmlChecks = [
        ['main.html', 'modules/shared/vcpResilienceMask.js', 'modules/topicSummarizer.js'],
        ['rust_assistant_engine/ui/assistant.html', '../../modules/shared/vcpResilienceMask.js', '../../modules/topicSummarizer.js'],
        ['Voicechatmodules/voicechat.html', '../modules/shared/vcpResilienceMask.js', '../modules/topicSummarizer.js'],
        ['tests/support/render-window.html', '../../modules/shared/vcpResilienceMask.js', '<script type="module">'],
    ];
    for (const [relPath, maskScript, nextAnchor] of htmlChecks) {
        const html = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
        const maskIdx = html.indexOf(maskScript);
        const nextIdx = html.indexOf(nextAnchor);
        assert.ok(maskIdx > 0 && nextIdx > maskIdx, `${relPath} 必须在 ${nextAnchor} 之前加载 ${maskScript}`);
    }

    // 2. NEW-P0-1: vcpResilienceMaskEsm.js 不依赖 process，且在无全局挂载时通过动态 import 自举
    const esmSrc = fs.readFileSync(path.resolve(process.cwd(), 'modules/shared/vcpResilienceMaskEsm.js'), 'utf8');
    assert.ok(!esmSrc.includes('typeof process'), 'vcpResilienceMaskEsm.js 不得限定 typeof process 才能加载');
    const prevMask = globalThis.VCPProtocolResilienceMask;
    delete globalThis.VCPProtocolResilienceMask;
    try {
        const freshEsm = await import(`../modules/shared/vcpResilienceMaskEsm.js?no-global=${Date.now()}`);
        assert.equal(typeof freshEsm.stripThoughtChains, 'function', '无全局预设时 ESM 桥接必须自举成功');
    } finally {
        if (prevMask !== undefined) globalThis.VCPProtocolResilienceMask = prevMask;
    }

    // 3. NEW-P0-2: 第1跳未闭 Content:「始ESCAPE」不得跨 ROLE_DIVIDE_USER 借用第2跳「末ESCAPE」
    const jump1UnclosedEsc = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'Content:「始ESCAPE」第1跳未闭ESCAPE草稿',
    ].join('\n');
    const jump2ValidEsc = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'fileName:「始」day2.txt「末」,',
        'Content:「始ESCAPE」第2跳正式ESCAPE日记「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const crossJumpEscSource = [
        '前置正文',
        jump1UnclosedEsc,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '重试写入：',
        jump2ValidEsc,
        '结尾正文',
    ].join('\n');

    const extractedBlocks = [];
    replaceToolRequestBlocks(crossJumpEscSource, (raw) => {
        extractedBlocks.push(raw);
        return raw;
    }, { allowFuzzyStart: true, stopAtProtocolWalls: true });
    assert.equal(extractedBlocks.length, 1, 'stopAtProtocolWalls 必须拒绝跨回执借用第2跳「末ESCAPE」，只匹配第2跳');
    assert.ok(extractedBlocks[0].includes('第2跳正式ESCAPE日记'));

    const dEsc = [], wEsc = [];
    const compEsc = extractDiaryText(crossJumpEscSource, dEsc, wEsc);
    assert.equal(dEsc.length, 1, '第2跳合法 ESCAPE DailyNote 必须成功归档');
    assert.equal(dEsc[0].content, '第2跳正式ESCAPE日记');
    assert.ok(!compEsc.includes('第1跳未闭ESCAPE草稿'), '第1跳未闭 ESCAPE 必须被剥除 (removedBad: true)');
    assert.ok(!compEsc.includes('UNCLOSED_ESCAPE'), '纠偏回执必须被剥除');
    assert.ok(compEsc.includes('前置正文') && compEsc.includes('结尾正文'));

    // 非 DailyNote 场景：第1跳未闭 ESCAPE + 回执 + 第2跳合法 WriteFile，第1跳必须清除且第2跳必须保留
    const writeJump2 = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始ESCAPE」const ok = true;\n<think>KEEP_IN_WRITE</think>\n「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const writeCrossJump = [
        '前文',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」BrokenEsc「末」,',
        'content:「始ESCAPE」第1跳未闭ESCAPE载荷',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=cafebabe]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        writeJump2,
    ].join('\n');
    const cleanedWriteCross = stripCompactionResilienceMarkers(writeCrossJump);
    assert.ok(!cleanedWriteCross.includes('第1跳未闭ESCAPE载荷'), '未闭 ESCAPE 坏块必须清除');
    assert.ok(cleanedWriteCross.includes('KEEP_IN_WRITE'), '第2跳合法 ESCAPE WriteFile 必须保留');

    // 单跳合法 WriteEscapedFile 内含字面 <<<[ROLE_DIVIDE_USER]>>> 示例必须完好保护
    const singleJumpDoc = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始ESCAPE」',
        '文档示例：<<<[ROLE_DIVIDE_USER]>>>',
        '<think>DOC_THINK_KEEP</think>',
        '「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    assert.ok(contextSanitizer.stripThoughtChains(singleJumpDoc).includes('DOC_THINK_KEEP'));

    // stripThoughtChains 在 step 1 掩码替换 INFO 块后，仍须拦截第1跳未闭 ESCAPE 跨回执借用第2跳，确保两跳间 <think> 100% 剥离
    const crossJumpWithThink = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」BrokenEsc「末」,',
        'content:「始ESCAPE」第1跳未闭ESCAPE',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=cafebabe]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<think>',
        'BETWEEN_JUMPS_SECRET_THOUGHT',
        '</think>',
        writeJump2,
    ].join('\n');
    const strippedCrossThink = contextSanitizer.stripThoughtChains(crossJumpWithThink);
    assert.ok(!strippedCrossThink.includes('BETWEEN_JUMPS_SECRET_THOUGHT'), '两跳之间的 <think> 必须被 100% 剥离');
    assert.ok(strippedCrossThink.includes('KEEP_IN_WRITE'), '第2跳合法 ESCAPE 内部内容必须保留');
});

test('Batch 9 Audit Two-Track NEW-P1 & NEW-P2: 普通字段防跨行首TOOL_REQUEST桥接、末行行内闭标、反引号跳过、前字段未闭畸形块、memory/idle/summary边界', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const resilienceMask = require('../modules/shared/vcpResilienceMask');
    const idleChat = require('../modules/deskpet/idleChat');
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');

    // 1. NEW-P1-1: BadTool 未闭普通字段后接 <think> 再接行首 GoodTool，不得桥接；行内字面 TOOL_REQUEST 仍放行
    const bridgeAttempt = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」BadTool「末」,',
        'content:「始」未闭普通字段',
        '<think>',
        'BRIDGE_THOUGHT_MUST_STRIP',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」GoodTool「末」,',
        'content:「始」<think>GOOD_TOOL_THINK_KEEP</think>「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const bridgeOut = contextSanitizer.stripThoughtChains(bridgeAttempt);
    assert.ok(!bridgeOut.includes('BRIDGE_THOUGHT_MUST_STRIP'), 'BadTool 未闭普通字段不得桥接合并 GoodTool 漏放思考链');
    assert.ok(bridgeOut.includes('GOOD_TOOL_THINK_KEEP'), 'GoodTool 内部思考链字面量必须保留');

    const inlineLiteralTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」行内示例：<<<[TOOL_REQUEST]>>>\n<think>INLINE_KEEP</think>「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    assert.ok(contextSanitizer.stripThoughtChains(inlineLiteralTool).includes('INLINE_KEEP'), '行内非行首字面 <<<[TOOL_REQUEST]>>> 不得早断');

    // 2. NEW-P1-2: 末行行内 VCP调用结果结束]] 闭标契约恢复
    const inlineEndHidden = [
        '前文',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        '- 工具名称: FileOperator',
        '- 返回内容: EOF_NO_NEWLINEVCP调用结果结束]]',
        '后文保留',
    ].join('\n');
    const outInlineHidden = contextSanitizer.stripHiddenToolResults(inlineEndHidden);
    assert.ok(!outInlineHidden.includes('EOF_NO_NEWLINE'), '末行行内闭标 [HIDDEN] 块必须剥离');
    assert.ok(outInlineHidden.includes('后文保留'));

    const inlineEndNormal = [
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容:',
        '<think>',
        'INLINE_END_KEEP',
        '</think>',
        'EOF_NO_NEWLINEVCP调用结果结束]]',
        '<think>',
        'TOP_STRIP',
        '</think>',
        '正文',
    ].join('\n');
    const outInlineNormal = contextSanitizer.stripThoughtChains(inlineEndNormal);
    assert.ok(outInlineNormal.includes('INLINE_END_KEEP'), '末行行内闭标正常结果内部必须受保护');
    assert.ok(!outInlineNormal.includes('TOP_STRIP'));

    // 3. NEW-P1-3: 反引号包裹与正文讨论的 <<<[TOOL_REQUEST]>>> / <tool_call> 不得被误删
    const apologyWithBackticks = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」BrokenCall「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${await (async () => {
            const { createHash } = await import('node:crypto');
            return createHash('sha1').update('<<<[TOOL_REQUEST]>>>\nmaid:「始」BrokenCall「末」\n<<<[END_TOOL_REQUEST]>>>').digest('hex').slice(0, 8);
        })()}]]`,
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '抱歉，我刚才写错了 `<<<[TOOL_REQUEST]>>>` 以及误用了 `<tool_call>` 标签。',
    ].join('\n');
    const outApology = stripCompactionResilienceMarkers(apologyWithBackticks);
    assert.ok(!outApology.includes('BrokenCall'), '坏块必须清除');
    assert.ok(outApology.includes('`<<<[TOOL_REQUEST]>>>`'), '道歉正文中的反引号 <<<[TOOL_REQUEST]>>> 绝不可误删');
    assert.ok(outApology.includes('`<tool_call>`'), '道歉正文中的反引号 <tool_call> 绝不可误删');

    // 4. NEW-P1-4: 前字段未闭 + 后字段闭合畸形块不可伪装成合法块逃脱
    const halfBrokenBlock = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'bad_field:「始」前字段未闭合',
        'command:「始」Write「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_FIELD block=unknown]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '保留结论',
    ].join('\n');
    const outHalfBroken = stripCompactionResilienceMarkers(halfBrokenBlock);
    assert.ok(!outHalfBroken.includes('前字段未闭合'), '前字段未闭+后字段闭合的畸形块必须被检出并清除');
    assert.ok(outHalfBroken.includes('保留结论'));

    // 5. NEW-P2-1: memoryProtocolProjection 遇 [[VCP调用结果信息汇总: 截断未闭 TOOL_REQUEST
    const memWithResultWall = [
        '<<<[TOOL_REQUEST]>>>tool_name:「始」MemTool「末」',
        'text:「始」未闭',
        '[[VCP调用结果信息汇总:\n结果秘密\nVCP调用结果结束]]',
        '后续记忆必须完好保留',
    ].join('\n');
    const memProjected = projectMemoryProtocols(memWithResultWall);
    assert.ok(memProjected.includes('调用了 MemTool 工具。'));
    assert.ok(memProjected.includes('后续记忆必须完好保留'));
    assert.ok(!memProjected.includes('结果秘密'));

    // 6. NEW-P2-2: idleChat 不截断反引号包裹的 <<<[TOOL_REQUEST]>>> 说明
    const idleBacktickLine = idleChat.cleanLine('<!--emo:happy 0.8-->写法应该是 `<<<[TOOL_REQUEST]>>>` 这样才对。');
    assert.equal(idleBacktickLine?.text, '写法应该是 `<<<[TOOL_REQUEST]>>>` 这样才对。');

    // 7. NEW-P2-3: 摘要过滤纯标点残留 + - 列表项按换行重拼
    const punctOnlySummary = '[本轮工具调用摘要:]VCP工具调用 格式错误（未执行）；。[本轮工具调用摘要结束]';
    assert.equal(resilienceMask.stripErrorSummaryItemsInSummaryBlocks(punctOnlySummary), '');
    assert.equal(projectMemoryProtocols(punctOnlySummary), '');

    const listSummary = [
        '[本轮工具调用摘要:]',
        '- [✓] ReadFile -> 成功',
        '- [x] DailyNote -> 格式错误（未执行）',
        '- [✓] WriteFile -> 成功',
        '[本轮工具调用摘要结束]',
    ].join('\n');
    const cleanedListSummary = resilienceMask.stripErrorSummaryItemsInSummaryBlocks(listSummary);
    assert.equal(
        cleanedListSummary,
        '[本轮工具调用摘要:]\n- [✓] ReadFile -> 成功\n- [✓] WriteFile -> 成功\n[本轮工具调用摘要结束]'
    );
    assert.equal(
        projectMemoryProtocols(listSummary),
        '工具调用摘要：- [✓] ReadFile -> 成功\n- [✓] WriteFile -> 成功'
    );
});

test('Batch 9 Audit Three-Track R3-P2-1, R3-P2-2 & R3-P3-1: 单行极简/无ROLE_DIVIDE跨跳ESCAPE、句尾同行未闭坏块、普通字段内单层ESCAPE', async () => {
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { createHash } = await import('node:crypto');
    const sha1_8 = (s) => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);

    // 1. R3-P2-1(a): ROLE_DIVIDE_USER 内含单行极简纠偏回执（无 INFO_START/INFO_END）时阻断跨跳借用「末ESCAPE」
    const singleLineReceiptCross = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始ESCAPE」第1跳未闭ESCAPE',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=deadbeef]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<think>',
        'SINGLE_RECEIPT_BETWEEN_JUMPS',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'Content:「始ESCAPE」第2跳单行回执后日记「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const dSingle = [], wSingle = [];
    const compSingle = extractDiaryText(singleLineReceiptCross, dSingle, wSingle);
    assert.equal(dSingle.length, 1);
    assert.equal(dSingle[0].content, '第2跳单行回执后日记');
    assert.ok(!compSingle.includes('第1跳未闭ESCAPE'));
    assert.ok(!contextSanitizer.stripThoughtChains(singleLineReceiptCross).includes('SINGLE_RECEIPT_BETWEEN_JUMPS'));

    // 2. R3-P2-1(b): 无 ROLE_DIVIDE_USER，仅裸 [[VCP调用结果信息汇总: ... [[VCP协议纠偏指导: ... VCP调用结果结束]] 或 BATCH 包裹
    const bareInfoCross = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始ESCAPE」裸回执第1跳未闭',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<think>',
        'BARE_INFO_BETWEEN_JUMPS',
        '</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'command:「始」create「末」,',
        'Content:「始ESCAPE」第2跳裸回执后日记「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const scannedBare = [];
    replaceToolRequestBlocks(bareInfoCross, (raw) => {
        scannedBare.push(raw);
        return raw;
    }, { allowFuzzyStart: true, stopAtProtocolWalls: true });
    assert.equal(scannedBare.length, 1);
    assert.ok(scannedBare[0].includes('第2跳裸回执后日记'));
    assert.ok(!contextSanitizer.stripThoughtChains(bareInfoCross).includes('BARE_INFO_BETWEEN_JUMPS'));

    const dBare = [], wBare = [];
    const compBare = extractDiaryText(bareInfoCross, dBare, wBare);
    assert.equal(dBare.length, 1);
    assert.equal(dBare[0].content, '第2跳裸回执后日记');
    assert.ok(!compBare.includes('裸回执第1跳未闭'));

    // 3. R3-P2-2: 句尾同行开启的未闭坏块（紧跟合法字段声明）必须清除，同时普通散文与反引号提及必须保留
    const inlineTailBroken = [
        '好的，我马上执行：<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」BrokenInline「末」',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '说明：协议标记 <<<[TOOL_REQUEST]>>> 与 `<<<[TOOL_REQUEST]>>>` 在讨论时不应被误删。',
    ].join('\n');
    const outInlineTail = stripCompactionResilienceMarkers(inlineTailBroken);
    assert.ok(!outInlineTail.includes('BrokenInline'), '句尾同行开启的未闭坏块必须被清除');
    assert.ok(outInlineTail.includes('协议标记 <<<[TOOL_REQUEST]>>> 与 `<<<[TOOL_REQUEST]>>>`'), '散文与反引号提及必须保留');

    // 4. R3-P3-1: 普通字段内含合法配对单层 「始ESCAPE」arg:「始」inner「末」「末ESCAPE」 时，绝不误判为未闭合坏块
    const nestedValidNormal = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」\n「始ESCAPE」\narg:「始」inner「末」\n「末ESCAPE」\n「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const brokenOther = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」BadFirst「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const fpBrokenOther = sha1_8(brokenOther);
    const mixedNestedMsg = [
        brokenOther,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=MISSING_TOOL_NAME block=${fpBrokenOther}]]`,
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        nestedValidNormal,
    ].join('\n');
    const outNestedValid = stripCompactionResilienceMarkers(mixedNestedMsg);
    assert.ok(!outNestedValid.includes('BadFirst'));
    assert.ok(outNestedValid.includes('arg:「始」inner「末」'), '普通字段内合法单层 ESCAPE 载荷绝不可触发未闭误判');
});

test('FP-P1-8: 同步服务端行首单行与同行开启 <think> 剥离（覆盖出站/压缩/桌宠/话题总结/JEV 第2跳，保留句中与工具/代码块内举例）', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const resilienceMask = require('../modules/shared/vcpResilienceMask');
    const idleChat = require('../modules/deskpet/idleChat');
    const topicTitleManager = require('../Groupmodules/topicTitleManager');
    const { buildDecisionRequest } = require('../Groupmodules/modes/jevDecisionMode');

    // 1. 核心规则验证：行首单行、同行开启多行、内含非行首 <think> 格式举例、第 2 跳单行思考链
    assert.equal(
        contextSanitizer.stripThoughtChains('<think>秘密</think>\n正文'),
        '正文',
        '行首单行 <think>秘密</think> 必须剥离'
    );
    assert.equal(
        contextSanitizer.stripThoughtChains('<think>L1\nL2</think>\n正文'),
        '正文',
        '行首同行开启多行 <think>L1\\nL2</think> 必须剥离'
    );
    assert.equal(
        contextSanitizer.stripThoughtChains('<think>检查 <think> 格式\nL2</think>\n正文'),
        '正文',
        '内部含非行首 <think> 字面量的同行开启多行块必须剥离'
    );

    const secondJumpSingleLine = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始」<think>TOOL_PARAM_THINK_KEEP</think>「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: WriteFile',
        '- 执行状态: ✅ SUCCESS',
        'VCP调用结果结束]]',
        '<think>第2跳单行秘密思考</think>',
        '第2跳正常回复正文',
    ].join('\n');
    const strippedSecondJump = contextSanitizer.stripThoughtChains(secondJumpSingleLine);
    assert.ok(!strippedSecondJump.includes('第2跳单行秘密思考'), '第2跳单行思考链必须剥离');
    assert.ok(strippedSecondJump.includes('TOOL_PARAM_THINK_KEEP'), '工具参数内 <think> 必须保留');
    assert.ok(strippedSecondJump.includes('第2跳正常回复正文'), '第2跳正文必须保留');

    // 2. 代码块内与句中行内举例必须 100% 保留
    const inlineAndFence = [
        '请勿使用 <think>demo</think> 标签',
        '说明：<think>x</think> 是思考标签',
        '```xml',
        '<think>FENCE_INLINE_KEEP</think>',
        '```',
    ].join('\n');
    const strippedProtected = contextSanitizer.stripThoughtChains(inlineAndFence);
    assert.ok(strippedProtected.includes('请勿使用 <think>demo</think> 标签'), '句中行内举例必须保留');
    assert.ok(strippedProtected.includes('说明：<think>x</think> 是思考标签'), '冒号后行内举例必须保留');
    assert.ok(strippedProtected.includes('<think>FENCE_INLINE_KEEP</think>'), '代码围栏内单行 <think> 必须保留');

    // 3. 上下文压缩（prepareCompactionState）
    const compactionState = prepareCompactionState([
        {
            role: 'assistant',
            content: '<think>压缩单行秘密</think>\n<thought>L1\nL2</thought>\n压缩保留正文\n说明：<think>x</think> 是思考标签',
        },
    ]);
    assert.ok(!compactionState.messages[0].content.includes('压缩单行秘密'));
    assert.ok(!compactionState.messages[0].content.includes('L1\nL2'));
    assert.ok(compactionState.messages[0].content.includes('压缩保留正文'));
    assert.ok(compactionState.messages[0].content.includes('说明：<think>x</think> 是思考标签'));

    // 4. 桌宠闲聊（buildMessages 与 cleanLine 第 2 跳单行思考）
    const idleMsgs = idleChat.buildMessages({
        config: { systemPrompt: 'Nova' },
        agentName: 'Nova',
        history: [{
            role: 'assistant',
            content: '<<<[TOOL_REQUEST]>>>\ntool_name:「始」Ls「末」\n<<<[END_TOOL_REQUEST]>>>\n<think>桌宠第2跳单行思考</think>\n桌宠可见正文',
        }],
    });
    assert.ok(!idleMsgs[1].content.includes('桌宠第2跳单行思考'));
    assert.ok(idleMsgs[1].content.includes('桌宠可见正文'));
    const idleClean = idleChat.cleanLine('<think>桌宠单行</think>\n<!--emo:happy 0.7-->你好呀！');
    assert.equal(idleClean?.text, '你好呀！');
    const idleClean2 = idleChat.cleanLine('<!--emo:happy 0.7-->\n<think>桌宠单行2</think>\n第二句你好！');
    assert.equal(idleClean2?.text, '第二句你好！');

    // 5. 群聊话题总结（topicTitleManager）与 JEV 决策（jevDecisionMode）
    const groupSummary = topicTitleManager.buildSummaryContent([
        { role: 'user', content: '请问' },
        { role: 'assistant', content: '<think>话题单行秘密</think>\n群聊可见答复\n请勿使用 <think>demo</think> 标签' },
    ], { userName: 'User' });
    assert.ok(!groupSummary.includes('话题单行秘密'));
    assert.ok(groupSummary.includes('群聊可见答复'));
    assert.ok(groupSummary.includes('请勿使用 <think>demo</think> 标签'));

    const jevReq = buildDecisionRequest(
        [{ id: 'a1', name: 'Agent1' }],
        [{
            id: 'm1',
            role: 'assistant',
            name: 'Agent1',
            agentId: 'a1',
            content: '<think>JEV同行开启\n第二行</think>\nJEV可见消息',
        }],
        { id: 'g1', name: 'G1', modeSettings: { jev: {} } }
    );
    assert.equal(jevReq.state.recentMessages[0].text, 'JEV可见消息');

    // 6. 单聊话题总结（topicSummarizer）
    const prevWindow = globalThis.window;
    const prevFetch = globalThis.fetch;
    let sentBody;
    globalThis.window = {
        VCPProtocolResilienceMask: resilienceMask,
        chatAPI: { async loadSettings() { return { vcpServerUrl: 'https://test/v1', vcpApiKey: 'k', userName: 'User' }; } },
    };
    globalThis.fetch = async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { ok: true, async json() { return { choices: [{ message: { content: '单行思考剥离标题' } }] }; } };
    };
    try {
        const resolved = require.resolve('../modules/topicSummarizer.js');
        delete require.cache[resolved];
        require(resolved);
        const title = await globalThis.window.summarizeTopicFromMessages([
            { role: 'user', content: '请帮忙' },
            { role: 'assistant', content: '<think>单聊总结单行秘密</think>\n单聊总结正文\n说明：<think>x</think> 是思考标签' },
            { role: 'user', content: '好的' },
            { role: 'assistant', content: '完成' },
        ], 'Nova');
        assert.equal(title, '单行思考剥离标题');
        assert.ok(!sentBody.messages[0].content.includes('单聊总结单行秘密'));
        assert.ok(sentBody.messages[0].content.includes('单聊总结正文'));
        assert.ok(sentBody.messages[0].content.includes('说明：<think>x</think> 是思考标签'));
    } finally {
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevFetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = prevFetch;
    }
});

test('FP-P2-8: contextCompactionState 剥离 Category V 无外框裸字段簇且保护代码围栏、反引号、正常散文与第 2 跳合法调用', async () => {
    const { createHash } = await import('node:crypto');
    const sha1_8 = (s) => createHash('sha1').update(s.trim()).digest('hex').slice(0, 8);

    // 1. 精确 SHA-1 指纹命中 + 保留前后散文、反引号举例、代码围栏与第 2 跳合法调用
    const bareCluster1 = [
        'maid:「始」Nova「末」,',
        'tool_name:「始」FileOperator「末」',
        'command:「始」ls_bare_broken「末」',
    ].join('\n');
    const fpBare1 = sha1_8(bareCluster1);

    const validJump2 = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」FileOperator「末」,',
        'command:「始」ls_valid_jump2「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const msgCatV = [
        '前文对话：我来帮你查看目录。',
        bareCluster1,
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        `- 返回内容: [[VCP协议纠偏指导: code=CATEGORY_V block=${fpBare1}]]`,
        '请使用 <<<[TOOL_REQUEST]>>> 外框包裹',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '抱歉，我重新规范格式后调用：',
        validJump2,
        '```text',
        'maid:「始」Nova「末」,',
        'tool_name:「始」FenceDemo「末」',
        '```',
        '说明：请勿在正文裸写 `maid:「始」Nova「末」` 字段。',
        '后文正常总结保留。',
    ].join('\n');

    const cleanedCatV = stripCompactionResilienceMarkers(msgCatV);
    assert.ok(cleanedCatV.includes('前文对话：我来帮你查看目录。'), '前文散文必须保留');
    assert.ok(!cleanedCatV.includes('ls_bare_broken'), '裸字段簇必须被剥离');
    assert.ok(!cleanedCatV.includes(`block=${fpBare1}`), 'CATEGORY_V 纠偏回执必须剥离');
    assert.ok(cleanedCatV.includes('ls_valid_jump2'), '第2跳带外框合法调用必须完整保留');
    assert.ok(cleanedCatV.includes('FenceDemo'), '代码围栏内裸字段示例必须保留');
    assert.ok(cleanedCatV.includes('`maid:「始」Nova「末」`'), '反引号内行内举例必须保留');
    assert.ok(cleanedCatV.includes('后文正常总结保留。'), '后文散文必须保留');

    // 2. block=unknown + 多行 ESCAPE 裸字段 + 花括号混用 + 同行逗号分隔裸字段
    const msgMixedBare = [
        '先看说明：注意格式规范。',
        'tool_name:{始}WriteFile{末},',
        'maid:{始}Nova{末},',
        'content:「始ESCAPE」',
        '裸字段内的多行转义内容',
        '「末ESCAPE」',
        '紧随其后的正常对话：请核对以上内容。',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP协议纠偏指导: code=CATEGORY_V block=unknown]]',
        '[[/VCP协议纠偏指导]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '结尾正常消息。',
    ].join('\n');

    const cleanedMixed = stripCompactionResilienceMarkers(msgMixedBare);
    assert.ok(cleanedMixed.includes('先看说明：注意格式规范。'));
    assert.ok(!cleanedMixed.includes('WriteFile'), '花括号+ESCAPE裸字段簇必须剥离');
    assert.ok(!cleanedMixed.includes('裸字段内的多行转义内容'), '裸字段内多行ESCAPE载荷必须剥离');
    assert.ok(cleanedMixed.includes('紧随其后的正常对话：请核对以上内容。'), '裸字段之后的紧邻散文绝不可误删');
    assert.ok(cleanedMixed.includes('结尾正常消息。'));

    // 3. NEW-P1-2: 裸字段内未闭合 「始ESCAPE」 绝不可跨 <<<[ROLE_DIVIDE_USER]>>> 硬墙借用后文散文的 「末ESCAPE」 与 「末」
    const msgBareEscapeCrossWall = [
        '前文说明保留。',
        'tool_name:「始」FileOperator「末」, content:「始」\n「始ESCAPE」未闭合裸转义',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=CATEGORY_V block=unknown]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '重要正文不可被跨墙吞噬：「末ESCAPE」 和 「末」 只是普通说明文字。',
    ].join('\n');
    const cleanedCrossWall = stripCompactionResilienceMarkers(msgBareEscapeCrossWall);
    assert.ok(cleanedCrossWall.includes('前文说明保留。'));
    assert.ok(
        cleanedCrossWall.includes('重要正文不可被跨墙吞噬：「末ESCAPE」 和 「末」 只是普通说明文字。'),
        '裸字段内未闭 ESCAPE 不得跨硬墙借用后文散文闭合标导致吞噬正文'
    );
});

test('RT-P2-3: 无指纹 MISSING_MAID 与 DUPLICATE_KEY_CONFLICT 闭合坏块在 prepareCompactionState + auditCheckpointFidelity 联测中被清除且不污染锚点，同值口吃复述与第 2 跳合法块保留', async () => {
    const { auditCheckpointFidelity } = await import('../modules/chat/contextCompactionFidelity.js');

    // 1. MISSING_MAID（无指纹 block=unknown）坏块内的虚假路径不得残留进压缩消息，也不得污染 fidelity.missing.path
    const brokenMissingMaid = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'path:「始」/fake/broken/missing_maid_secret.ts「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const validJump2 = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」FileOperator「末」,',
        'path:「始」src/real/valid_target.js「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const historyMissingMaid = [
        {
            role: 'assistant',
            content: [
                brokenMissingMaid,
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[[VCP调用结果信息汇总:',
                '- 工具名称: VCP工具调用',
                '- 执行状态: ❌ ERROR',
                '- 返回内容: [[VCP协议纠偏指导: code=MISSING_MAID block=unknown]]',
                '[[/VCP协议纠偏指导]]',
                'VCP调用结果结束]]',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
                '已补全 maid 重试：',
                validJump2,
            ].join('\n'),
        },
    ];
    const state1 = prepareCompactionState(historyMissingMaid);
    assert.ok(!state1.messages[0].content.includes('/fake/broken/missing_maid_secret.ts'), '无指纹 MISSING_MAID 坏块必须被清除');
    assert.ok(state1.messages[0].content.includes('src/real/valid_target.js'), '第2跳合法块必须保留');
    const fidelity1 = auditCheckpointFidelity(state1.messages, '摘要保留了 src/real/valid_target.js');
    assert.deepEqual(fidelity1.missing.path, [], '虚假坏块路径不得进入 fidelity.missing.path');

    // 2. DUPLICATE_KEY_CONFLICT（无指纹）冲突坏块被清除；同值口吃复述不算冲突且保留
    const brokenConflict = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」FileOperator「末」,',
        'TOOL_NAME:「始」DailyNote「末」,',
        'path:「始」/fake/conflict/dead_path.ts「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const stutterValid = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」WriteFile「末」,',
        'tool_name:「始」WriteFile「末」,',
        'path:「始」src/real/stutter_ok.js「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');

    const historyConflict = [
        {
            role: 'assistant',
            content: [
                brokenConflict,
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[[VCP调用结果信息汇总:',
                '- 工具名称: VCP工具调用',
                '- 执行状态: ❌ ERROR',
                '- 返回内容: [[VCP协议纠偏指导: code=DUPLICATE_KEY_CONFLICT]]',
                '[[/VCP协议纠偏指导]]',
                'VCP调用结果结束]]',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
                stutterValid,
            ].join('\n'),
        },
    ];
    const state2 = prepareCompactionState(historyConflict);
    assert.ok(!state2.messages[0].content.includes('/fake/conflict/dead_path.ts'), '无指纹 DUPLICATE_KEY_CONFLICT 坏块必须被清除');
    assert.ok(state2.messages[0].content.includes('src/real/stutter_ok.js'), '同值口吃复述不算冲突，必须保留');
    const fidelity2 = auditCheckpointFidelity(state2.messages, '摘要保留了 src/real/stutter_ok.js');
    assert.deepEqual(fidelity2.missing.path, [], '冲突坏块路径不得进入 fidelity.missing.path');
});

test('RT2-P1-3: 渲染与 TTS 主链路启用 stopAtProtocolWalls，第 1 跳未闭工具请求绝不跨纠偏回执吞掉第 2 跳正文与合法工具卡片，且单跳 WriteEscapedFile 无误伤', async () => {
    const { Marked } = await import('marked');
    const { JSDOM } = await import('jsdom');
    const { createContentPipeline, PIPELINE_MODES } = await import('../modules/renderer/contentPipeline.js');
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { createRenderTemplateCompiler } = await import('../modules/renderer/renderTemplateCompiler.js');
    const { speechSourceToText, createStableSpeechStream } = await import('../modules/renderer/streamSpeech.js');

    const crossJumpInput = [
        '先读一下文件：',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'path:「始」/tmp/broken_unclosed_file.txt',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '请补充结束标记',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '抱歉，我补齐结束标记后改用命令查看：',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」LinuxShellExecutor「末」,',
        'command:「始」ls -la「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '第2跳全部输出完成。',
    ].join('\n');

    // 1. contentPipeline（先 protectToolResults 再 protectToolRequests）：回执占位符不被吞，第 2 跳正文与合法 LinuxShellExecutor 完整保留
    const pipeline = createContentPipeline({
        getToolResultRegex: () => /\[\[VCP调用结果信息汇总:[\s\S]*?VCP调用结果结束\]\]/g,
        getToolRequestRegex: () => /(?<!`)<<<\[TOOL_REQUEST\]>>>[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>(?!`)/g,
        getCodeFenceRegex: () => /```[\s\S]*?```/g,
        replaceToolRequestBlocks,
    });
    const pipelineRes = pipeline.process(crossJumpInput, { mode: PIPELINE_MODES.FULL_RENDER });
    assert.equal(pipelineRes.state.toolResultMap.size, 1, '第 1 跳纠偏回执占位符必须完整保留在 toolResultMap');
    assert.equal(pipelineRes.state.toolRequestMap.size, 1, '仅第 2 跳合法 LinuxShellExecutor 进入 toolRequestMap');
    const [resultPlaceholder] = pipelineRes.state.toolResultMap.keys();
    const [, requestContent] = pipelineRes.state.toolRequestMap.entries().next().value;
    assert.ok(pipelineRes.text.includes(resultPlaceholder), '回执占位符绝不能被未闭第 1 跳吞掉');
    assert.ok(pipelineRes.text.includes('抱歉，我补齐结束标记后改用命令查看：'), '第 2 跳说明正文必须完整保留');
    assert.ok(pipelineRes.text.includes('第2跳全部输出完成。'), '第 2 跳尾随正文必须完整保留');
    assert.match(requestContent, /LinuxShellExecutor/);
    assert.doesNotMatch(requestContent, /FileOperator|VCP协议纠偏指导/);

    // 2. renderTemplateCompiler 完整 HTML 渲染：精准产出 LinuxShellExecutor 工具卡片且保留回执与第 2 跳正文
    const escapeHtml = s => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const lazyTools = [];
    const compiler = createRenderTemplateCompiler({
        mainRendererReferences: {
            markedInstance: new Marked(),
            globalSettingsRef: { get: () => ({}) },
        },
        contentProcessor: {
            escapeHtml,
            processStartEndMarkers: s => s,
            deIndentMisinterpretedCodeBlocks: s => s,
            deIndentToolRequestBlocks: s => s,
            applyContentProcessors: s => s,
        },
        registerLazyTool: entry => {
            lazyTools.push(entry);
            return `lazy-${lazyTools.length}`;
        },
    });
    const renderedHtml = compiler.renderMarkdownToHtmlUncached(crossJumpInput);
    assert.match(renderedHtml, /<span class="vcp-tool-name-highlight">LinuxShellExecutor<\/span>/, '必须渲染第 2 跳合法 LinuxShellExecutor 卡片');
    assert.match(renderedHtml, /VCP工具调用|UNCLOSED_TOOL_BLOCK/, '纠偏回执内容不得被未闭第 1 跳吞掉');
    assert.match(renderedHtml, /抱歉，我补齐结束标记后改用命令查看：/);
    assert.match(renderedHtml, /第2跳全部输出完成。/);

    // 3. streamSpeech TTS 链路：第 1 跳未闭块与第 2 跳工具块均不泄漏，第 2 跳正文不吞音
    const doc = new JSDOM('').window.document;
    const spokenText = speechSourceToText(crossJumpInput, doc);
    assert.doesNotMatch(spokenText, /FileOperator|broken_unclosed_file|LinuxShellExecutor|ls -la|UNCLOSED_TOOL_BLOCK/);
    assert.match(spokenText, /先读一下文件：/);
    assert.match(spokenText, /抱歉，我补齐结束标记后改用命令查看：/);
    assert.match(spokenText, /第2跳全部输出完成。/);

    const speechStream = createStableSpeechStream({ document: doc });
    const streamedBlocks = [...speechStream.push(crossJumpInput), ...speechStream.finish()];
    const streamedJoined = streamedBlocks.map(b => b.text).filter(Boolean).join('\n');
    assert.match(streamedJoined, /抱歉，我补齐结束标记后改用命令查看：/);
    assert.match(streamedJoined, /第2跳全部输出完成。/);

    // 4. 单跳合法 WriteEscapedFile 载荷含 <<<[ROLE_DIVIDE_USER]>>> 与示例标记无误伤
    const singleJumpEscaped = [
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」WriteEscapedFile「末」,',
        'content:「始ESCAPE」',
        '文档示例：<<<[ROLE_DIVIDE_USER]>>>',
        '<<<[END_TOOL_REQUEST]>>>',
        '「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '单跳写入完成。',
    ].join('\n');
    const singleRes = pipeline.process(singleJumpEscaped, { mode: PIPELINE_MODES.FULL_RENDER });
    assert.equal(singleRes.state.toolRequestMap.size, 1, '单跳合法 WriteEscapedFile 必须完整识别');
    const [, singleReq] = singleRes.state.toolRequestMap.entries().next().value;
    assert.match(singleReq, /WriteEscapedFile/);
    assert.match(singleReq, /文档示例：<<<\[ROLE_DIVIDE_USER\]>>>/);
    assert.ok(singleRes.text.includes('单跳写入完成。'));
});

test('RT2-FUP-P2-1: streamSpeech 跨跳未闭 ESCAPE 与无 ROLE_DIVIDE_USER 外壳裸回执均不吞第 2 跳语音正文', async () => {
    const { JSDOM } = await import('jsdom');
    const { speechSourceToText, createStableSpeechStream } = await import('../modules/renderer/streamSpeech.js');
    const doc = new JSDOM('').window.document;

    // 1. 跨跳未闭 ESCAPE + ROLE_DIVIDE_USER 内含 VCP_TOOL_BATCH + 第 2 跳合法 ESCAPE
    const batchCrossEscape = [
        '第一句开场白。',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始ESCAPE」第1跳未闭ESCAPE秘密',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<<<[VCP_TOOL_BATCH_START:2026-11-24T11:00:00Z]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[VCP_TOOL_BATCH_END:2026-11-24T11:00:00Z]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳语音说明：我已修复转义闭合符。',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」WriteFile「末」,',
        'content:「始ESCAPE」第2跳安全写入载荷「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '全部完成。',
    ].join('\n');

    const spoken1 = speechSourceToText(batchCrossEscape, doc);
    assert.doesNotMatch(spoken1, /第1跳未闭ESCAPE秘密|第2跳安全写入载荷|UNCLOSED_ESCAPE|VCP_TOOL_RESULT/);
    assert.match(spoken1, /第一句开场白。/);
    assert.match(spoken1, /第2跳语音说明：我已修复转义闭合符。/);
    assert.match(spoken1, /全部完成。/);

    // 2. 无 ROLE_DIVIDE_USER 外壳的裸 [[VCP调用结果信息汇总:...]] + 跨跳未闭 ESCAPE 与未闭普通字段
    const bareReceiptCrossEscape = [
        '裸回执前文。',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」,',
        'content:「始ESCAPE」裸回执前未闭ESCAPE秘密',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=cafebabe]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '裸回执后第2跳语音正文保留。',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」WriteFile「末」,',
        'content:「始ESCAPE」第2跳合法ESCAPE载荷「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '裸回执尾句保留。',
    ].join('\n');

    const spoken2 = speechSourceToText(bareReceiptCrossEscape, doc);
    assert.doesNotMatch(spoken2, /裸回执前未闭ESCAPE秘密|第2跳合法ESCAPE载荷|cafebabe|VCP_TOOL_RESULT/);
    assert.match(spoken2, /裸回执前文。/);
    assert.match(spoken2, /裸回执后第2跳语音正文保留。/);
    assert.match(spoken2, /裸回执尾句保留。/);

    const bareNormalUnclosed = [
        '普通前文。',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'path:「始」/secret/unclosed_bare_path',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '裸回执普通未闭后第2跳语音必须保留。',
    ].join('\n');

    const spoken3 = speechSourceToText(bareNormalUnclosed, doc);
    assert.doesNotMatch(spoken3, /unclosed_bare_path|FileOperator|deadbeef|VCP_TOOL_RESULT/);
    assert.match(spoken3, /普通前文。/);
    assert.match(spoken3, /裸回执普通未闭后第2跳语音必须保留。/);

    const stream = createStableSpeechStream({ document: doc });
    const streamOut = [...stream.push(bareReceiptCrossEscape), ...stream.finish()]
        .map(b => b.text).filter(Boolean).join('\n');
    assert.match(streamOut, /裸回执后第2跳语音正文保留。/);
    assert.match(streamOut, /裸回执尾句保留。/);
});

test('RT2-FUP-P2-2: modelTrajectoryModel.extractToolCalls 与 messageRenderer TTS 启用 stopAtProtocolWalls 不吞回执与第 2 跳正文', async () => {
    const { extractToolCalls } = await import('../modules/ui-system/side-pane/modelTrajectoryModel.js');
    const { JSDOM } = await import('jsdom');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    const crossJumpTrajectory = [
        '准备执行：',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'path:「始」/tmp/broken_unclosed.txt',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳说明正文必须保留。',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,',
        'tool_name:「始」LinuxShellExecutor「末」,',
        'command:「始」pwd「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '执行结尾正文。',
    ].join('\n');

    const extracted = extractToolCalls(crossJumpTrajectory);
    assert.equal(extracted.toolCalls.length, 1, '第 1 跳未闭块绝不能跨墙合并吞掉第 2 跳工具调用');
    assert.equal(extracted.toolCalls[0].toolName, 'LinuxShellExecutor');
    assert.ok(extracted.text.includes('[[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]'), '回执正文不得被未闭第 1 跳吞掉');
    assert.ok(extracted.text.includes('第2跳说明正文必须保留。'), '第 2 跳说明正文必须完整保留');
    assert.ok(extracted.text.includes('执行结尾正文。'), '结尾正文必须保留');

    // 验证 messageRenderer.extractSpeakableTextFromContentElement 裸回执跨跳未闭 ESCAPE 不吞第 2 跳正文
    const dom = new JSDOM('<!doctype html><body></body>');
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevImage = globalThis.Image;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Image = dom.window.Image;
    try {
        const { createMessageRenderer } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'modules/messageRenderer.js')).href
        );
        const renderer = createMessageRenderer({
            streamManager: { dispose: async () => {} },
            enableContextMenu: false,
            enableMiddleClick: false,
            initializeStreamProjection: false,
            exposeGlobalCommands: false,
        });
        const content = dom.window.document.createElement('div');
        content.className = 'md-content';
        content.textContent = [
            '前文可朗读。',
            '<<<[TOOL_REQUEST]>>>tool_name:「始」WriteFile「末」,content:「始ESCAPE」未闭载荷',
            '[[VCP调用结果信息汇总:- 工具名称: VCP工具调用\n- 执行状态: ❌ ERROR\n- 返回内容: 纠偏回执VCP调用结果结束]]',
            '第2跳朗读正文保留。',
            '<<<[TOOL_REQUEST]>>>maid:「始」Nova「末」,tool_name:「始」WriteFile「末」,content:「始ESCAPE」第2跳秘密「末ESCAPE」<<<[END_TOOL_REQUEST]>>>',
            '后文可朗读。',
        ].join('\n');
        const speakable = renderer.extractSpeakableTextFromContentElement(content);
        assert.match(speakable, /前文可朗读/);
        assert.match(speakable, /第2跳朗读正文保留/);
        assert.match(speakable, /后文可朗读/);
        assert.doesNotMatch(speakable, /第2跳秘密|VCP_TOOL_RESULT/);

        const batchContent = dom.window.document.createElement('div');
        batchContent.className = 'md-content';
        batchContent.textContent = [
            '批次前文可朗读。',
            '<<<[TOOL_REQUEST]>>>tool_name:「始」WriteFile「末」,content:「始ESCAPE」未闭批次载荷',
            '<<<[VCP_TOOL_BATCH_START:2026-11-24T11:20:00Z]>>>[[VCP调用结果信息汇总:- 工具名称: VCP工具调用\n- 返回内容: 批次纠偏VCP调用结果结束]]<<<[VCP_TOOL_BATCH_END:2026-11-24T11:20:00Z]>>>',
            '批次后第2跳正文保留。',
            '<<<[TOOL_REQUEST]>>>maid:「始」Nova「末」,tool_name:「始」WriteFile「末」,content:「始ESCAPE」批次第2跳秘密「末ESCAPE」<<<[END_TOOL_REQUEST]>>>',
            '批次尾句可朗读。',
        ].join('\n');
        const batchSpeakable = renderer.extractSpeakableTextFromContentElement(batchContent);
        assert.match(batchSpeakable, /批次前文可朗读/);
        assert.match(batchSpeakable, /批次后第2跳正文保留/);
        assert.match(batchSpeakable, /批次尾句可朗读/);
        assert.doesNotMatch(batchSpeakable, /批次第2跳秘密|VCP_TOOL_RESULT/);
        renderer.disposeRendererResources();
    } finally {
        dom.window.close();
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevImage === undefined) delete globalThis.Image;
        else globalThis.Image = prevImage;
    }
});

test('RT3-P1-1: topicRiverQuote 全面净化思考链、纠偏回执、协议药丸、未闭第 1 跳与 ROLE_DIVIDE 外框并保护代码围栏', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');

    const pollutedHistory = [
        {
            role: 'assistant',
            name: 'Nova',
            content: [
                '<think>RIVER_SECRET_SINGLE_LINE</think>',
                '<antthinking>\nRIVER_SECRET_ANTTHINKING\n</antthinking>',
                '[--- VCP元思考链 (Auto) ---]\nRIVER_SECRET_VCP_THOUGHT\n[--- 元思考链结束 ---]',
                '```xml\n<think>FENCE_THINK_KEEP</think>\n```',
                '第一跳前文。',
                '<<<[TOOL_REQUEST]>>>tool_name:「始」FileOperator「末」,path:「始」/secret/unclosed_river',
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[[VCP调用结果信息汇总:',
                '- 工具名称: VCP工具调用',
                '- 执行状态: ❌ ERROR',
                '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
                '纠偏指导秘密文本',
                '[[/VCP协议纠偏指导]]',
                'VCP调用结果结束]]',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[系统提示:] 【VCP 工具调用协议规范】常驻药丸秘密【/VCP 工具调用协议规范】',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
                '<<<[TOOL_REQUEST]>>>maid:「始」Nova「末」,tool_name:「始」WriteFile「末」,content:「始ESCAPE」SECRET_WRITE_PAYLOAD「末ESCAPE」<<<[END_TOOL_REQUEST]>>>',
                '第2跳跨话题可见正文。',
            ].join('\n'),
        },
        {
            role: 'assistant',
            name: 'Nova',
            content: [
                '合法工具前文。',
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[[VCP调用结果信息汇总:',
                '- 工具名称: FileOperator',
                '- 执行状态: ✅ SUCCESS',
                '- 返回内容: 正常文件内容输出',
                'VCP调用结果结束]]',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
                '合法工具后文。',
            ].join('\n'),
        },
    ];

    const formatted = await formatTopicRiverQuote(pollutedHistory);
    assert.doesNotMatch(
        formatted,
        /RIVER_SECRET|unclosed_river|VCP协议纠偏指导|纠偏指导秘密文本|VCP工具调用（工具结果）|常驻药丸秘密|SECRET_WRITE_PAYLOAD|ROLE_DIVIDE_/
    );
    const parsed = extractTopicRiverQuote(`外层消息\n\n${formatted}`);
    assert.ok(parsed && parsed.rows.length >= 2);
    const joined = parsed.rows.map(r => `${r.name || ''}:${r.content}`).join('\n');
    assert.match(joined, /FENCE_THINK_KEEP/);
    assert.match(joined, /第一跳前文。/);
    assert.match(joined, /第2跳跨话题可见正文。/);
    assert.match(joined, /FileOperator:正常文件内容输出/);
    assert.match(joined, /合法工具前文。/);
    assert.match(joined, /合法工具后文。/);
});

test('RT3-P1-2: forwardMessageOwner 转发前净化思考链、未闭坏块、纠偏回执、协议药丸与 ROLE_DIVIDE 外框', async () => {
    const { createForwardMessageOwner, sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');

    const dirtyOriginal = [
        '<think>FORWARD_SECRET_SINGLE</think>',
        '<thought>\nFORWARD_SECRET_THOUGHT\n</thought>',
        '[--- VCP元思考链 ---]\nFORWARD_SECRET_VCP\n[--- 元思考链结束 ---]',
        '```js\n<think>FORWARD_FENCE_KEEP</think>\n```',
        '转发可见前文。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」FileOperator「末」,content:「始ESCAPE」未闭ESCAPE秘密',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<<<[VCP_TOOL_BATCH_START:2026-11-24T12:00:00Z]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_ESCAPE block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[VCP_TOOL_BATCH_END:2026-11-24T12:00:00Z]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<<<[TOOL_REQUEST]>>>maid:「始」Nova「末」,tool_name:「始」WriteFile「末」,content:「始ESCAPE」第2跳转发秘密「末ESCAPE」<<<[END_TOOL_REQUEST]>>>',
        '[系统提示:] 【VCP 工具调用协议规范】转发裸药丸秘密【/VCP 工具调用协议规范】',
        '转发可见后文。',
    ].join('\n');

    const sanitized = sanitizeForwardedContent(dirtyOriginal);
    assert.doesNotMatch(
        sanitized,
        /FORWARD_SECRET|未闭ESCAPE秘密|VCP协议纠偏指导|第2跳转发秘密|转发裸药丸秘密|ROLE_DIVIDE_|VCP_TOOL_BATCH|TOOL_REQUEST/
    );
    assert.match(sanitized, /FORWARD_FENCE_KEEP/);
    assert.match(sanitized, /转发可见前文。/);
    assert.match(sanitized, /转发可见后文。/);

    const nodes = new Map();
    const make = id => ({
        id, value: '', disabled: false, innerHTML: '', dataset: {}, style: {}, children: [],
        classList: { add() {}, remove() {} },
        append(...xs) { this.children.push(...xs); },
        appendChild(x) { this.children.push(x); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    });
    for (const id of ['forwardTargetList', 'forwardTargetSearch', 'forwardAdditionalComment', 'confirmForwardBtn']) nodes.set(id, make(id));
    const li = make('li');
    const documentRef = { getElementById: id => nodes.get(id), createElement: () => li };
    const sent = [];
    const owner = createForwardMessageOwner({
        documentRef,
        chatAPI: {
            getAllItems: async () => ({ success: true, items: [{ id: 'target1', type: 'agent', name: 'Target' }] }),
            getOriginalMessageContent: async () => ({ success: true, content: dirtyOriginal }),
        },
        chatManager: { handleForwardMessage: async (...args) => sent.push(args) },
        uiHelperFunctions: { openModal: () => {}, closeModal: () => {}, showToastNotification: () => {} },
        getConversation: () => ({ item: { id: 'a1', type: 'agent' }, topicId: 't1' }),
    });
    await owner.show({ id: 'm1', role: 'assistant', name: 'Nova' });
    li.onclick();
    await owner.confirm();
    assert.equal(sent.length, 1);
    const forwardedText = sent[0][1];
    assert.doesNotMatch(forwardedText, /FORWARD_SECRET|VCP协议纠偏指导|ROLE_DIVIDE_|转发裸药丸秘密|第2跳转发秘密/);
    assert.match(forwardedText, /转发可见前文。/);
    assert.match(forwardedText, /转发可见后文。/);
});

test('RT3-P2-1: emotionTags 屏蔽全部思维链/协议回执区域且在未闭第 1 跳遇硬墙立即退出并放行第 2 跳情绪与单跳 WriteEscapedFile', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanChunks = (text, step = text.length) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    const shielded = [
        '<thought>\n<!--emo:angry 0.9-->\n</thought>',
        '<thoughts>\n<!--emo:sad 0.9-->\n</thoughts>',
        '<antthinking>\n<!--emo:fear 0.9-->\n</antthinking>',
        '[--- VCP元思考链 (Auto) ---]\n<!--emo:disgust 0.9-->\n[--- 元思考链结束 ---]',
        '<<<[ROLE_DIVIDE_USER]>>>\n<!--emo:surprised 0.9-->\n<<<[END_ROLE_DIVIDE_USER]>>>',
        '<<<[VCP_TOOL_BATCH_START:2026-11-24T12:00:00Z]>>>\n<!--emo:angry 0.9-->\n<<<[VCP_TOOL_BATCH_END:2026-11-24T12:00:00Z]>>>',
        '说明：行内提及 <thought> 标签。\n<!--emo:happy 0.8-->真实开心回复。',
    ].join('\n');
    for (const step of [shielded.length, 3, 1]) {
        const res = scanChunks(shielded, step);
        assert.deepEqual(res.tags, ['happy'], `step=${step}`);
        assert.match(res.text, /说明：行内提及 <thought> 标签。/);
        assert.match(res.text, /真实开心回复。/);
        assert.doesNotMatch(res.text, /2026-11-24T12:00:00Z|]>>>/);
    }

    const unclosedToolWithEmo = [
        '<<<[TOOL_REQUEST]>>>tool_name:「始」FileOperator「末」,path:「始」/unclosed',
        '<<<[ROLE_DIVIDE_USER]>>>[[VCP调用结果信息汇总:<!--emo:sad 0.9-->VCP调用结果结束]]<<<[END_ROLE_DIVIDE_USER]>>>',
        '<!--emo:happy 0.9-->第2跳恢复正常情绪与正文！',
    ].join('\n');
    for (const step of [unclosedToolWithEmo.length, 5, 1]) {
        const res = scanChunks(unclosedToolWithEmo, step);
        assert.deepEqual(res.tags, ['happy'], `unclosed step=${step}`);
        assert.match(res.text, /第2跳恢复正常情绪与正文！/);
    }

    const singleJumpEscaped = [
        '<<<[TOOL_REQUEST]>>>maid:「始」Nova「末」,tool_name:「始」WriteEscapedFile「末」,content:「始ESCAPE」',
        '文档示例：<<<[ROLE_DIVIDE_USER]>>>\n<!--emo:angry 0.9-->\n<<<[END_ROLE_DIVIDE_USER]>>>',
        '「末ESCAPE」<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:calm 0.7-->写入完成。',
    ].join('\n');
    for (const step of [singleJumpEscaped.length, 4, 1]) {
        const res = scanChunks(singleJumpEscaped, step);
        assert.deepEqual(res.tags, ['calm'], `single escaped step=${step}`);
        assert.match(res.text, /写入完成。/);
    }
});

test('RT3-P2-2: streamStableBoundary & vcpDocumentScanner 阻断跨墙合并且不腰斩单跳流式 WriteEscapedFile', async () => {
    const { tokenizeVcpDocument } = await import('../modules/renderer/vcpDocumentScanner.js');
    const { findExplicitStablePrefix } = await import('../modules/renderer/streamStableBoundary.js');

    const docSrc = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'path:「始」/unclosed',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: err VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳散文。',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」',
        '<<<[END_TOOL_REQUEST]>>>',
    ].join('\n');
    const regions = tokenizeVcpDocument(docSrc, { mode: 'final' });
    const markdownSlices = regions.filter(r => r.kind === 'markdown').map(r => docSrc.slice(r.start, r.end)).join('');
    assert.match(markdownSlices, /第2跳散文。/, 'vcpDocumentScanner 不得被未闭第 1 跳吞掉第 2 跳散文');
    assert.ok(regions.some(r => r.kind === 'tool-result'), '工具结果必须独立成区');

    const streamingEscaped = [
        '前文段落。\n\n',
        '<<<[TOOL_REQUEST]>>>\n',
        'maid:「始」Nova「末」,\n',
        'tool_name:「始」WriteEscapedFile「末」,\n',
        'content:「始ESCAPE」\n',
        '示例1\n',
        '<<<[END_ROLE_DIVIDE_USER]>>>\n',
        '尚未写完的载荷',
    ].join('');
    const cutoff = findExplicitStablePrefix(streamingEscaped);
    assert.ok(
        cutoff <= streamingEscaped.indexOf('<<<[TOOL_REQUEST]>>>'),
        `单跳 WriteEscapedFile 内部字面 END_ROLE_DIVIDE_USER 不得提前封口 (cutoff=${cutoff})`
    );

    const streamingFence = [
        '前文段落。\n\n',
        '```markdown\n<<<[TOOL_REQUEST]>>>\n```\n',
        '<<<[TOOL_REQUEST]>>>\nmaid:「始」Nova「末」,tool_name:「始」WriteEscapedFile「末」,content:「始ESCAPE」\n<<<[END_ROLE_DIVIDE_USER]>>>\n未闭合',
    ].join('');
    const fenceCutoff = findExplicitStablePrefix(streamingFence);
    assert.ok(
        fenceCutoff <= streamingFence.indexOf('<<<[TOOL_REQUEST]>>>\nmaid:'),
        `闭合代码围栏后的单跳 WriteEscapedFile 内部 END_ROLE_DIVIDE_USER 不得提前封口 (cutoff=${fenceCutoff})`
    );

    const realCrossJump = [
        '<<<[TOOL_REQUEST]>>>\ntool_name:「始」WriteEscapedFile「末」,\ncontent:「始ESCAPE」未闭载荷\n',
        '<<<[ROLE_DIVIDE_USER]>>>\n[[VCP调用结果信息汇总:\n- 执行状态: ❌ ERROR\nVCP调用结果结束]]\n<<<[END_ROLE_DIVIDE_USER]>>>\n',
        '第2跳正文',
    ].join('');
    const crossCutoff = findExplicitStablePrefix(realCrossJump);
    assert.equal(crossCutoff, realCrossJump.indexOf('第2跳正文'), '真实跨跳回执结束行必须正常封口');
});

test('RT3-P2-3: messageRenderer 与 VChatAutoTTS 对未闭第 1 跳（含 DOM 化回执墙）兜底剥离且不吞第 2 跳语音', async () => {
    const { JSDOM } = await import('jsdom');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');
    const { pathToFileURL } = await import('node:url');

    const dom = new JSDOM('<!doctype html><body></body>');
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevImage = globalThis.Image;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Image = dom.window.Image;

    try {
        const { createMessageRenderer } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'modules/messageRenderer.js')).href
        );
        const renderer = createMessageRenderer({
            streamManager: { dispose: async () => {} },
            enableContextMenu: false,
            enableMiddleClick: false,
            initializeStreamProjection: false,
            exposeGlobalCommands: false,
        });

        const content = dom.window.document.createElement('div');
        content.className = 'md-content';
        content.innerHTML = [
            '<p>开场白保留。</p>',
            '<p>&lt;&lt;&lt;[TOOL_REQUEST]&gt;&gt;&gt;tool_name:「始」FileOperator「末」,path:「始」/secret/unclosed_dom_path</p>',
            '<div class="vcp-role-divider" data-vcp-block-type="role-divider">USER</div>',
            '<div class="vcp-tool-result-bubble" data-vcp-block-type="tool-result">[[VCP调用结果信息汇总: 机密回执 VCP调用结果结束]]</div>',
            '<p>第2跳语音正文必须完整保留。</p>',
            '<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use">工具气泡机密</div>',
            '<p>结尾语音保留。</p>',
        ].join('');
        const speakable = renderer.extractSpeakableTextFromContentElement(content);
        assert.match(speakable, /开场白保留。/);
        assert.match(speakable, /第2跳语音正文必须完整保留。/);
        assert.match(speakable, /结尾语音保留。/);
        assert.doesNotMatch(speakable, /unclosed_dom_path|机密回执|工具气泡机密|VCP_TOOL_RESULT/);

        const pluginSrc = fs.readFileSync(
            path.resolve(process.cwd(), 'VCPDistributedServer/Plugin/VChatAutoTTS/plugin.js'),
            'utf8'
        );
        for (const withRenderer of [true, false]) {
            const pluginDom = new JSDOM(
                '<!doctype html><body><main id="chatMessages"></main></body>',
                { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' }
            );
            const pWin = pluginDom.window;
            const registered = new Map();
            pWin.VCPFrontendPlugins = { register: (p) => registered.set(p.id, p), get: (id) => registered.get(id) };
            pWin.VCPMainChatState = { snapshot: () => ({ selectedItem: { type: 'agent', id: 'a1' } }) };
            pWin.localStorage.setItem('vchatAutoTts.settings.v1', JSON.stringify({ a1: { enabled: true, includeCode: false } }));
            const spokenCalls = [];
            pWin.chatAPI = {
                getAgentConfig: async () => ({ ttsVoicePrimary: 'v1' }),
                sovitsSpeak: (payload) => spokenCalls.push(payload),
            };
            if (withRenderer) pWin.messageRenderer = renderer;
            pWin.eval(pluginSrc);

            const msgEl = pWin.document.createElement('div');
            msgEl.className = 'message-item assistant streaming';
            msgEl.dataset.messageId = `m-tts-${withRenderer}`;
            msgEl.dataset.agentId = 'a1';
            msgEl.innerHTML = `<div class="md-content">
                <p>自动朗读前文。</p>
                <p>&lt;&lt;[TOOL_REQUEST]&gt;&gt;tool_name:「始」FileOperator「末」,path:「始」/secret/tts_unclosed</p>
                <div class="vcp-tool-result-bubble">结果气泡机密</div>
                <pre><code>const codeSecret = 1;</code></pre>
                <p>第2跳自动朗读保留。</p>
            </div>`;
            pWin.document.getElementById('chatMessages').appendChild(msgEl);
            await new Promise(r => setTimeout(r, 30));
            msgEl.classList.remove('streaming');
            await new Promise(r => setTimeout(r, 800));
            assert.equal(spokenCalls.length, 1, `withRenderer=${withRenderer} 必须触发朗读`);
            assert.match(spokenCalls[0].text, /自动朗读前文。/);
            assert.match(spokenCalls[0].text, /第2跳自动朗读保留。/);
            assert.doesNotMatch(spokenCalls[0].text, /tts_unclosed|结果气泡机密|codeSecret|VCP_TOOL_RESULT/);
            pWin.VCPFrontendPlugins.get('vchat-auto-tts')?.destroy?.();
            pluginDom.window.close();
        }
        renderer.disposeRendererResources();
    } finally {
        dom.window.close();
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevImage === undefined) delete globalThis.Image;
        else globalThis.Image = prevImage;
    }
});

test('RT3-P2-4: conversation-scope 隔离工具结果文档示例与代码围栏，不污染 commands 与 projectIds 且保留真实工具结果中的工程 ID', async () => {
    const { collectConversationScope } = await import('../modules/ui-system/conversation-scope.js');

    const history = [
        {
            role: 'assistant',
            content: [
                '```text',
                '<<<[TOOL_REQUEST]>>>',
                'tool_name:「始」PowerShellExecutor「末」,',
                'command:「始」rm -rf /fake/fence_cmd「末」',
                '<<<[END_TOOL_REQUEST]>>>',
                '```',
                '<<<[TOOL_REQUEST]>>>',
                'maid:「始」Nova「末」,',
                'tool_name:「始」PowerShellExecutor「末」,',
                'command:「始」git status「末」',
                '<<<[END_TOOL_REQUEST]>>>',
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[[VCP调用结果信息汇总:',
                '- 工具名称: FileOperator',
                '- 执行状态: ✅ SUCCESS',
                '- 返回内容: 文档示例：',
                '<<<[TOOL_REQUEST]>>>',
                'tool_name:「始」PowerShellExecutor「末」,',
                'command:「始」evil_doc_cmd「末」',
                '<<<[END_TOOL_REQUEST]>>>',
                '<<<[TOOL_REQUEST]>>>',
                'tool_name:「始」ProjectForge「末」,',
                'projectId:「始」pfake99「末」',
                '<<<[END_TOOL_REQUEST]>>>',
                'VCP调用结果结束]]',
                '[[VCP调用结果信息汇总:',
                '- 工具名称: ProjectForge',
                '- 执行状态: ✅ SUCCESS',
                '- 返回内容: ## ✅ 工程已创建：真实工程\n- projectId：`preal1`\n- 根目录：D:\\real',
                'VCP调用结果结束]]',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
            ].join('\n'),
        },
    ];

    const scope = collectConversationScope(history);
    assert.deepEqual([...scope.commands], ['git status'], '代码围栏与 FileOperator 返回文档内的 PowerShellExecutor 示例绝不能污染 commands');
    assert.deepEqual(scope.projectIds, ['preal1'], 'FileOperator 返回文档内的假 ProjectForge 示例不得污染 projectIds，真实 ProjectForge 结果工程 ID 必须保留');
});

test('Step1 Client Regression 1: contextCompactionState 区分旧格式未解析日记原样保留与回执拦截坏块跳过', () => {
    const legacyNoContent = [
        '前置对话',
        '<<<DailyNoteStart>>>',
        'Maid: Nova',
        'Date: 2025-01-01',
        '旧格式手写日记正文',
        '<<<DailyNoteEnd>>>',
        '后续对话'
    ].join('\n');
    const sLegacy = prepareCompactionState([{ role: 'assistant', content: legacyNoContent }]);
    assert.equal(sLegacy.diaries.length, 1, '无回执的旧格式未解析日记不得静默丢失');
    assert.equal(sLegacy.diaries[0].unparsed, true);
    assert.ok(sLegacy.diaries[0].content.includes('旧格式手写日记正文'));
    assert.ok(sLegacy.warnings.some(w => w.includes('日记内容无法解析，已原样保留整个日记块')));

    const badWithReceipt = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始」被回执拦截的未闭合坏块',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '后续保留正文'
    ].join('\n');
    const sRejected = prepareCompactionState([{ role: 'assistant', content: badWithReceipt }]);
    assert.equal(sRejected.diaries.length, 0, '被纠偏回执对账拦截的坏日记块必须跳过');
    assert.ok(sRejected.messages[0].content.includes('后续保留正文'));
});

test('Step1 Client Regression 2: forwardMessageOwner 保护代码围栏与行内反引号中的未闭合 ROLE_DIVIDE_USER，绝不吞掉后半截正文', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const content = [
        '前半段正文。',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '这是代码围栏里的未闭合协议示例',
        '```',
        '行内提及 `<<<[ROLE_DIVIDE_USER]>>>` 也不应吞尾。',
        '后半段重要正文必须 100% 保留！'
    ].join('\n');
    const sanitized = sanitizeForwardedContent(content);
    assert.ok(sanitized.includes('前半段正文。'));
    assert.ok(sanitized.includes('这是代码围栏里的未闭合协议示例'));
    assert.ok(sanitized.includes('`<<<[ROLE_DIVIDE_USER]>>>`'));
    assert.ok(sanitized.includes('后半段重要正文必须 100% 保留！'));
});

test('Step1 Client Regression 3: topicRiverQuote 引用含协议文档代码块时完整保留围栏内药丸与 ROLE_DIVIDE 字面量', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');

    const quote = await formatTopicRiverQuote([
        {
            role: 'assistant',
            name: 'Nova',
            content: [
                '以下是协议文档示例：',
                '```markdown',
                '<<<[ROLE_DIVIDE_USER]>>>',
                '[系统提示:] 【VCP 工具调用协议规范】示例正文【/VCP 工具调用协议规范】',
                '<<<[END_ROLE_DIVIDE_USER]>>>',
                '```',
                '真实顶层裸药丸应清除：[系统提示:] 【VCP 工具调用协议规范】真实药丸要删【/VCP 工具调用协议规范】',
                '文档总结保留。'
            ].join('\n')
        }
    ]);
    const parsed = extractTopicRiverQuote(`外层\n\n${quote}`);
    const body = parsed.rows[0].content;
    assert.ok(body.includes('<<<[ROLE_DIVIDE_USER]>>>'), '代码块内 ROLE_DIVIDE_USER 字面量必须保留');
    assert.ok(body.includes('【VCP 工具调用协议规范】示例正文【/VCP 工具调用协议规范】'), '代码块内协议规范示例必须保留');
    assert.ok(!body.includes('真实药丸要删'), '顶层真实裸药丸仍须清除');
    assert.ok(body.includes('文档总结保留。'));
});

test('Step1 Client Regression 4: emotionTags 句中随口提及未闭合 VCP 静默域标记不吞掉后续情绪标签与正文', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanWithStep = (text, step) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    const reply = [
        '这里介绍一下 [--- VCP元思考链 的格式，以及 <<<[ROLE_DIVIDE_USER]>>> 和 <<<[VCP_TOOL_BATCH_START: 格式说明。',
        '<!--emo:happy 0.85-->接着输出正常带情绪的正文！'
    ].join('\n');

    for (const step of [reply.length, 4, 1]) {
        const res = scanWithStep(reply, step);
        assert.deepEqual(res.tags, ['happy'], `step=${step}: 句中字面量不得吞掉后续情绪标签`);
        assert.ok(res.text.includes('接着输出正常带情绪的正文！'), `step=${step}: 后续正文必须保留`);
    }
});

test('Step2 Client Regression 1 (P1): toolRequestScanner stopAtProtocolWalls 放行行中协议字面量与行首自包含示例，且不破坏跨跳防吞噬', async () => {
    const { replaceToolRequestBlocks, readToolRequestField, findUnclosedToolRequest } = await import('../modules/renderer/toolRequestScanner.js');

    // 1. 行中提及 <<<[TOOL_REQUEST]>>> 与 <<<[ROLE_DIVIDE_USER]>>> 的合法非 ESCAPE 工具调用
    const inlineLiteralReq = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始」VCP协议说明：使用 <<<[TOOL_REQUEST]>>> 发起调用，并用 <<<[ROLE_DIVIDE_USER]>>> 与 [[VCP调用结果信息汇总: 隔离。「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '后续正文保留。'
    ].join('\n');
    const parsedCalls = [];
    const replaced = replaceToolRequestBlocks(inlineLiteralReq, (full, body) => {
        parsedCalls.push(readToolRequestField(body, 'Content'));
        return '[CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(parsedCalls.length, 1, '行中字面量不得导致合法非 ESCAPE 工具调用被误判为 incomplete-field');
    assert.ok(parsedCalls[0].includes('<<<[ROLE_DIVIDE_USER]>>>'));
    assert.ok(replaced.includes('[CARD]') && replaced.includes('后续正文保留。'));

    // 2. 字段内含行首自包含 <<<[TOOL_REQUEST]>>> ... <<<[END_TOOL_REQUEST]>>> 示例（在 「末」 前完整闭合且无回执墙）
    const selfContainedExampleReq = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」,',
        'Content:「始」示例用法：',
        '<<<[TOOL_REQUEST]>>>',
        '示例内容不含结束定界符',
        '<<<[END_TOOL_REQUEST]>>>',
        '以上示例结束。',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '文档写入完成。'
    ].join('\n');
    const exampleCalls = [];
    const replacedExample = replaceToolRequestBlocks(selfContainedExampleReq, (full, body) => {
        exampleCalls.push(readToolRequestField(body, 'Content'));
        return '[DOC_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(exampleCalls.length, 1, '行首自包含示例对不得误触发刹车');
    assert.ok(exampleCalls[0].includes('以上示例结束。'));
    assert.ok(replacedExample.includes('[DOC_CARD]') && replacedExample.includes('文档写入完成。'));

    // 3. 一致性检查：Jump 1 遇 ROLE_DIVIDE_USER 墙后文残留孤立 <<<[END_TOOL_REQUEST]>>>，findUnclosedToolRequest({ stopAtProtocolWalls: true }) 仍须判为未闭合
    const brokenWithTrailingEnd = [
        '前置正文。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」SecretTool「末」,content:「始」绝密未闭载荷',
        '<<<[ROLE_DIVIDE_USER]>>>[[VCP调用结果信息汇总: err VCP调用结果结束]]<<<[END_ROLE_DIVIDE_USER]>>>',
        '正常散文末尾恰好出现孤立尾标字面量 <<<[END_TOOL_REQUEST]>>> 结束。'
    ].join('\n');
    const afterReplace = replaceToolRequestBlocks(brokenWithTrailingEnd, () => '\n', { stopAtProtocolWalls: true });
    const unclosed = findUnclosedToolRequest(afterReplace, { stopAtProtocolWalls: true });
    assert.ok(unclosed && unclosed.startIndex >= brokenWithTrailingEnd.indexOf('<<<[TOOL_REQUEST]>>>'), 'stopAtProtocolWalls=true 必须阻止跨越 ROLE_DIVIDE_USER 墙借用后文孤立尾标');
});

test('Step2 Client Regression 2 (P1): memoryProtocolProjection 放行行中字面量与行首自包含示例，不拆成两条伪调用', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');

    const inlineDoc = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」,',
        'Content:「始」VCP说明：使用 <<<[TOOL_REQUEST]>>> 示例 <<<[END_TOOL_REQUEST]>>> 与 <<<[ROLE_DIVIDE_USER]>>> 隔离。「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const out1 = projectMemoryProtocols(inlineDoc);
    assert.equal((out1.match(/调用了/g) || []).length, 1, '行中字面量不得把单个工具调用拆成两条伪调用');
    assert.ok(!out1.includes('「末」'), '不得泄漏字段尾定界符 「末」');

    const multilineExample = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」,',
        'Content:「始」文档片段：',
        '<<<[TOOL_REQUEST]>>>',
        'demo line',
        '<<<[END_TOOL_REQUEST]>>>',
        '片段结束。',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const out2 = projectMemoryProtocols(multilineExample);
    assert.equal((out2.match(/调用了 WriteDoc 工具/g) || []).length, 1, '行首自包含示例不得拆出第二条伪调用');
    assert.ok(!out2.includes('「末」'), '不得泄漏 「末」');
});

test('Step2 Client Regression 3 (P1 & P2): forwardMessageOwner/topicRiverQuote 随机 nonce 零碰撞与扫描器一致性防泄漏', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');

    const collisionInput = [
        '正文包含静态占位符字面量 <!--VCP_TOOL_RESULT_0--> 与 __VCP_FWD_INLINE_0__ 和 `__VCP_FWD_INLINE_0__`。',
        '另有 `__VCP_RIVER_INLINE_0__` 与 __VCP_RIVER_INLINE_0__ 均应原样保留。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」Secret「末」,content:「始」UNCLOSED_LEAK_GUARD',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:\n- 工具名称: VCP工具调用\n- 执行状态: ❌ ERROR\n- 返回内容: ok\nVCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '正常散文末尾有字面尾标 <<<[END_TOOL_REQUEST]>>> 后文保留。'
    ].join('\n');

    const fwd = sanitizeForwardedContent(collisionInput);
    assert.ok(fwd.includes('<!--VCP_TOOL_RESULT_0-->'), 'forwardMessageOwner 不得误删正文中的 <!--VCP_TOOL_RESULT_0-->');
    assert.ok(fwd.includes('__VCP_FWD_INLINE_0__'), 'forwardMessageOwner 不得篡改 __VCP_FWD_INLINE_0__');
    assert.ok(fwd.includes('`__VCP_FWD_INLINE_0__`'), 'forwardMessageOwner 不得篡改行内代码 `__VCP_FWD_INLINE_0__`');
    assert.ok(!fwd.includes('UNCLOSED_LEAK_GUARD'), '跨墙未闭载荷不得因后文孤立 <<<[END_TOOL_REQUEST]>>> 泄漏');
    assert.ok(fwd.includes('后文保留。'));

    const speech = speechSourceToText(collisionInput);
    assert.ok(!speech.includes('UNCLOSED_LEAK_GUARD'), 'streamSpeech 跨墙未闭载荷不得泄漏');
    assert.ok(speech.includes('后文保留。'));

    const quote = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: collisionInput }]);
    const parsed = extractTopicRiverQuote(`外层\n\n${quote}`);
    const body = parsed.rows.map(r => r.content).join('\n');
    assert.ok(body.includes('__VCP_RIVER_INLINE_0__'), 'topicRiverQuote 不得篡改 __VCP_RIVER_INLINE_0__');
    assert.ok(body.includes('`__VCP_RIVER_INLINE_0__`'), 'topicRiverQuote 不得篡改行内代码 `__VCP_RIVER_INLINE_0__`');
    assert.ok(!body.includes('UNCLOSED_LEAK_GUARD'), 'topicRiverQuote 跨墙未闭载荷不得泄漏');
    assert.ok(body.includes('后文保留。'));
});

test('Step3 Client Regression 1 (P1): messageRenderer 与 VChatAutoTTS 保护 includeCode 代码节点与句中 <<<[TOOL_REQUEST]>>> 字面量不截断后文', async () => {
    const { JSDOM } = await import('jsdom');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    const dom = new JSDOM('<!doctype html><body></body>');
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevImage = globalThis.Image;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Image = dom.window.Image;

    try {
        const { createMessageRenderer } = await import(
            pathToFileURL(path.resolve(process.cwd(), 'modules/messageRenderer.js')).href
        );
        const renderer = createMessageRenderer({
            streamManager: { dispose: async () => {} },
            enableContextMenu: false,
            enableMiddleClick: false,
            initializeStreamProjection: false,
            exposeGlobalCommands: false,
        });

        const htmlCode = '<p>协议以如下标记开头：</p><pre><code>&lt;&lt;&lt;[TOOL_REQUEST]&gt;&gt;&gt;</code></pre><p>后面的重要正文结论必须朗读。</p>';
        const htmlInline = '<p>注意协议标记以 &lt;&lt;&lt;[TOOL_REQUEST]&gt;&gt;&gt; 开头，后面的重要正文结论必须朗读。</p>';

        for (const html of [htmlCode, htmlInline]) {
            const el = dom.window.document.createElement('div');
            el.className = 'md-content';
            el.innerHTML = html;
            const out = renderer.extractSpeakableTextFromContentElement(el);
            assert.ok(out.includes('<<<[TOOL_REQUEST]>>>'), `messageRenderer 必须保留字面量: ${out}`);
            assert.ok(out.includes('后面的重要正文结论必须朗读。'), `messageRenderer 不得截断后文: ${out}`);
        }

        const pluginSrc = fs.readFileSync(
            path.resolve(process.cwd(), 'VCPDistributedServer/Plugin/VChatAutoTTS/plugin.js'),
            'utf8'
        );
        for (const withRenderer of [true, false]) {
            for (const [label, html] of [['code', htmlCode], ['inline', htmlInline]]) {
                const pluginDom = new JSDOM(
                    '<!doctype html><body><main id="chatMessages"></main></body>',
                    { url: 'https://vcpchat.local/main.html', runScripts: 'outside-only' }
                );
                const pWin = pluginDom.window;
                const registered = new Map();
                pWin.VCPFrontendPlugins = { register: (p) => registered.set(p.id, p), get: (id) => registered.get(id) };
                pWin.VCPMainChatState = { snapshot: () => ({ selectedItem: { type: 'agent', id: 'a1' } }) };
                pWin.localStorage.setItem('vchatAutoTts.settings.v1', JSON.stringify({ a1: { enabled: true, includeCode: true } }));
                const spokenCalls = [];
                pWin.chatAPI = {
                    getAgentConfig: async () => ({ ttsVoicePrimary: 'v1' }),
                    sovitsSpeak: (payload) => spokenCalls.push(payload),
                };
                if (withRenderer) pWin.messageRenderer = renderer;
                pWin.eval(pluginSrc);

                const msgEl = pWin.document.createElement('div');
                msgEl.className = 'message-item assistant streaming';
                msgEl.dataset.messageId = `m-s3-${withRenderer}-${label}`;
                msgEl.dataset.agentId = 'a1';
                msgEl.innerHTML = `<div class="md-content">${html}</div>`;
                pWin.document.getElementById('chatMessages').appendChild(msgEl);
                await new Promise(r => setTimeout(r, 30));
                msgEl.classList.remove('streaming');
                await new Promise(r => setTimeout(r, 800));
                assert.equal(spokenCalls.length, 1, `withRenderer=${withRenderer}, ${label}: 必须触发朗读`);
                assert.ok(spokenCalls[0].text.includes('<<<[TOOL_REQUEST]>>>'), `withRenderer=${withRenderer}, ${label}: 保留代码/句中字面量`);
                assert.ok(spokenCalls[0].text.includes('后面的重要正文结论必须朗读。'), `withRenderer=${withRenderer}, ${label}: 不得截断后文`);
                pWin.VCPFrontendPlugins.get('vchat-auto-tts')?.destroy?.();
                pluginDom.window.close();
            }
        }
        renderer.disposeRendererResources();
    } finally {
        dom.window.close();
        if (prevWindow === undefined) delete globalThis.window;
        else globalThis.window = prevWindow;
        if (prevDocument === undefined) delete globalThis.document;
        else globalThis.document = prevDocument;
        if (prevImage === undefined) delete globalThis.Image;
        else globalThis.Image = prevImage;
    }
});

test('Step3 Client Regression 2 (P1): toolRequestScanner 与 memoryProtocolProjection 放行非 ESCAPE 字段内严格成对纯示例 ROLE_DIVIDE', async () => {
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');

    const pureRoleExampleReq = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始」文档示例：',
        '<<<[ROLE_DIVIDE_USER]>>>',
        'user text',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '示例结束。',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '后续正文保留。'
    ].join('\n');

    const bodies = [];
    const replaced = replaceToolRequestBlocks(pureRoleExampleReq, (full, body) => {
        bodies.push(readToolRequestField(body, 'content'));
        return '[FILE_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(bodies.length, 1, '纯文档 ROLE_DIVIDE_USER 示例不得拦死合法非 ESCAPE 工具调用');
    assert.ok(bodies[0].includes('user text'));
    assert.ok(replaced.includes('[FILE_CARD]') && replaced.includes('后续正文保留。'));

    const projected = projectMemoryProtocols(pureRoleExampleReq);
    assert.equal((projected.match(/调用了 FileOperator 工具/g) || []).length, 1, 'memoryProtocolProjection 必须投影为单次调用');
    assert.ok(!projected.includes('「末」'), 'memoryProtocolProjection 不得泄漏 「末」');
    assert.ok(projected.includes('后续正文保留。'));

    // 包含真实回执标记的 ROLE_DIVIDE_USER 仍必须触发刹车
    const realReceiptBroken = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始」未闭载荷',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:\n- 工具名称: VCP工具调用\nVCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const brokenReplaced = replaceToolRequestBlocks(realReceiptBroken, () => '[BAD]', { stopAtProtocolWalls: true });
    assert.ok(!brokenReplaced.includes('[BAD]'), '含真实回执外壳的 ROLE_DIVIDE_USER 仍必须触发刹车');
});

test('Step3 Client Regression 3 (P2): forwardMessageOwner 与 topicRiverQuote 支持 CommonMark 多反引号行内代码掩码', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');

    const multiTickInput = '请看语法 ``【VCP 工具调用协议规范】示例说明【/VCP 工具调用协议规范】`` 以及结尾。';
    const fwd = sanitizeForwardedContent(multiTickInput);
    assert.equal(fwd, multiTickInput, 'forwardMessageOwner 必须 100% 保留 CommonMark 双反引号行内代码');

    const quote = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: multiTickInput }]);
    const parsed = extractTopicRiverQuote(`外层\n\n${quote}`);
    assert.equal(parsed.rows[0].content, multiTickInput, 'topicRiverQuote 必须 100% 保留 CommonMark 双反引号行内代码');
});

test('Step4 Client Regression 1 (P1): forwardMessageOwner 与 topicRiverQuote 正文句中提及 <<<[TOOL_REQUEST]>>> 不截断后续正文，且仍剥离真实未闭块', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');

    const proseMention = '注意：千万不要把 <<<[TOOL_REQUEST]>>> 直接写在普通回复里。\n\n以下是今天真正的工作总结：全部任务已完成。';
    const fwdProse = sanitizeForwardedContent(proseMention);
    assert.ok(fwdProse.includes('注意：千万不要把 <<<[TOOL_REQUEST]>>> 直接写在普通回复里。'), 'forwardMessageOwner 句中提及字面量不得截断');
    assert.ok(fwdProse.includes('以下是今天真正的工作总结：全部任务已完成。'), 'forwardMessageOwner 后续工作总结必须保留');

    const quoteProse = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: proseMention }]);
    const parsedProse = extractTopicRiverQuote(`外层\n\n${quoteProse}`);
    assert.equal(parsedProse.rows[0].content, proseMention, 'topicRiverQuote 句中提及字面量不得截断全文');

    // 前有句中普通散文，后有真实未闭合工具块时，仍须跳过前者并剥离后者
    const mixedProseThenReal = [
        '说明：请勿在普通回复中直接写 <<<[TOOL_REQUEST]>>> 字面量。',
        '正常中间段落保留。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」Secret「末」,content:「始」REAL_UNCLOSED_TAIL_LEAK',
    ].join('\n');
    const fwdMixed = sanitizeForwardedContent(mixedProseThenReal);
    assert.ok(fwdMixed.includes('说明：请勿在普通回复中直接写 <<<[TOOL_REQUEST]>>> 字面量。'));
    assert.ok(fwdMixed.includes('正常中间段落保留。'));
    assert.ok(!fwdMixed.includes('REAL_UNCLOSED_TAIL_LEAK'), '后方真实未闭合块仍须剥离');

    // topicRiverQuote 遭遇后方 ROLE_DIVIDE_USER / 另一未闭合 TOOL_REQUEST 硬墙时不吞掉后方合法工具块与可见结论
    const riverWall = [
        '说明：句中提及 <<<[TOOL_REQUEST]>>> 字面量。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」Broken「末」,content:「始」BROKEN_UNCLOSED',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」Valid「末」,content:「始」VALID_PAYLOAD「末」<<<[END_TOOL_REQUEST]>>>',
        '末尾可见结论。'
    ].join('\n');
    const quoteWall = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: riverWall }]);
    const parsedWall = extractTopicRiverQuote(`外层\n\n${quoteWall}`);
    const wallJoined = parsedWall.rows.map(r => r.content).join('\n');
    assert.ok(wallJoined.includes('说明：句中提及 <<<[TOOL_REQUEST]>>> 字面量。'));
    assert.ok(!wallJoined.includes('BROKEN_UNCLOSED'));
    assert.ok(!wallJoined.includes('VALID_PAYLOAD'));
    assert.ok(wallJoined.includes('末尾可见结论。'));
});

test('Step4 Client Regression 2 (P1): forwardMessageOwner 完整保留闭合 Markdown 代码围栏内的工具结果示例', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const docWithToolResultFence = [
        '下面是工具返回格式说明：',
        '```text',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Demo',
        'VCP调用结果结束]]',
        '```',
        '真实工具结果应剥离：',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: RealSecretTool',
        '- 返回内容: SECRET_RESULT_SHOULD_STRIP',
        'VCP调用结果结束]]',
        '说明结尾。'
    ].join('\n');

    const fwd = sanitizeForwardedContent(docWithToolResultFence);
    assert.ok(fwd.includes('- 工具名称: Demo'), '闭合代码围栏内的工具结果示例不得被 collectToolDataRanges 掏空');
    assert.ok(fwd.includes('[[VCP调用结果信息汇总:'), '闭合代码围栏内的工具结果头必须保留');
    assert.ok(!fwd.includes('SECRET_RESULT_SHOULD_STRIP'), '围栏外真实工具结果仍须剥离');
    assert.ok(fwd.includes('说明结尾。'));
});

test('Step4.5 Client Refactor Regression: 共享原语收敛后 streamSpeech/idleChat/projectForgeTopicSurface 句中散文不截断且保护闭合代码块', async () => {
    const { speechSourceToText, cleanSpeechSource } = await import('../modules/renderer/streamSpeech.js');
    const { containsProjectForgeRequest } = await import('../modules/renderer/projectForgeTopicSurface.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const idleChat = require('../modules/deskpet/idleChat');
    const mask = require('../modules/shared/vcpResilienceMask');
    const maskEsm = await import('../modules/shared/vcpResilienceMaskEsm.js');

    // 1. 共享原语 CJS 与 ESM 导出一致
    for (const fn of ['createUniqueMaskPrefix', 'maskInlineBackticks', 'unmaskInlineBackticks', 'shouldStripUnclosedToolRequest']) {
        assert.equal(typeof mask[fn], 'function', `CJS 必须导出 ${fn}`);
        assert.equal(typeof maskEsm[fn], 'function', `ESM 必须导出 ${fn}`);
    }

    // 2. streamSpeech 句中提及 <<<[TOOL_REQUEST]>>> 与双反引号 <<<[ROLE_DIVIDE_USER]>>> 不截断后续语音正文
    const speechProse = [
        '注意不要在普通句子里写 <<<[TOOL_REQUEST]>>>，也不要写 ``<<<[ROLE_DIVIDE_USER]>>>`` 标记。',
        '```text',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: UnclosedInFence',
        '```',
        '真正需要朗读的后续总结正文必须 100% 保留。'
    ].join('\n');
    const spoken = speechSourceToText(speechProse);
    assert.ok(spoken.includes('注意不要在普通句子里写'), 'streamSpeech 句中散文提及不得截断前文');
    assert.ok(spoken.includes('真正需要朗读的后续总结正文必须 100% 保留。'), 'streamSpeech 后续语音与闭合围栏后文本不得被吞');
    assert.ok(!cleanSpeechSource('<<<[TOOL_REQUEST]>>>tool_name:「始」Secret「末」\n<!--VCP_TOOL_RESULT_0-->\n不应该泄露的尾部').includes('不应该泄露的尾部'), '静态占位符字面量不得充当假回执墙放行未闭合工具载荷');

    // 3. idleChat.cleanLine 句中提及 <<<[TOOL_REQUEST]>>> 与双反引号字面量不截断，且真未闭行首块仍截断
    const idleProse = '<!--emo:happy-->记住别把 <<<[TOOL_REQUEST]>>> 放进普通闲聊，``测试代码`` 今天天气真好呀！';
    const idleOut = idleChat.cleanLine(idleProse);
    assert.ok(idleOut && idleOut.text.includes('今天天气真好呀！'), 'idleChat 句中提及不得截断后续闲聊');

    const idleBroken = '先看看\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」Secret「末」';
    const idleBrokenOut = idleChat.cleanLine(idleBroken);
    assert.equal(idleBrokenOut.text, '先看看', 'idleChat 行首真实未闭合块仍必须截断');

    const idleMultiTickPair = '记得用 `` <<<[TOOL_REQUEST]>>> `` 开头，并用 `` <<<[END_TOOL_REQUEST]>>> `` 结尾哦！';
    const idleMultiTickOut = idleChat.cleanLine(idleMultiTickPair);
    assert.equal(idleMultiTickOut.text, idleMultiTickPair, 'idleChat 多反引号行内代码里的成对协议标记不得被误删');

    // 4. projectForgeTopicSurface 句中提及 <<<[TOOL_REQUEST]>>> 不阻塞识别后方真实未闭合 ProjectForge 调用
    const pfMixed = [
        '提示：不要随意写 <<<[TOOL_REQUEST]>>> 在正文里。',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」ProjectForge「末」,',
        'command:「始」create'
    ].join('\n');
    assert.equal(containsProjectForgeRequest(pfMixed), true, '句中提及不得阻塞识别后方真实未闭合 ProjectForge 请求');
});

test('Step5 Client Regression 1 (P1): maskInlineBackticks 严格单行，颜文字孤立反引号绝不跨行配对掩码真实 TOOL_REQUEST/ROLE_DIVIDE_USER', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');
    const idleChat = require('../modules/deskpet/idleChat');

    const emoticonCrossLineTool = [
        '好的呀 (・`ω´・)',
        '<<<[TOOL_REQUEST]>>>',
        'maid:「始」Nova「末」,tool_name:「始」Calc「末」,expr:「始」`1+1`「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '计算结束！'
    ].join('\n');

    const idleOut = idleChat.cleanLine(emoticonCrossLineTool);
    assert.ok(idleOut && !idleOut.text.includes('TOOL_REQUEST') && !idleOut.text.includes('Calc'), 'idleChat 颜文字跨行不得掩码真实 TOOL_REQUEST');
    assert.ok(idleOut.text.includes('计算结束！'));

    const speechOut = speechSourceToText(emoticonCrossLineTool);
    assert.ok(!speechOut.includes('TOOL_REQUEST') && !speechOut.includes('Calc'), 'streamSpeech 颜文字跨行不得掩码真实 TOOL_REQUEST');
    assert.ok(speechOut.includes('计算结束！'));

    const fwdToolOut = sanitizeForwardedContent(emoticonCrossLineTool);
    assert.ok(!fwdToolOut.includes('TOOL_REQUEST') && !fwdToolOut.includes('Calc'), 'forwardMessageOwner 颜文字跨行不得掩码真实 TOOL_REQUEST');
    assert.ok(fwdToolOut.includes('计算结束！'));

    const emoticonCrossLineRole = [
        '开心 (・`ω´・)',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '秘密度假指令 `secret_cmd`',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '公开正文保留。'
    ].join('\n');

    const fwdRoleOut = sanitizeForwardedContent(emoticonCrossLineRole);
    assert.ok(!fwdRoleOut.includes('secret_cmd') && !fwdRoleOut.includes('ROLE_DIVIDE_USER'), 'forwardMessageOwner 颜文字跨行不得掩码真实 ROLE_DIVIDE_USER');
    assert.ok(fwdRoleOut.includes('公开正文保留。'));

    const speechRoleOut = speechSourceToText(emoticonCrossLineRole);
    assert.ok(!speechRoleOut.includes('secret_cmd') && !speechRoleOut.includes('ROLE_DIVIDE_USER'), 'streamSpeech 颜文字跨行不得掩码真实 ROLE_DIVIDE_USER');
    assert.ok(speechRoleOut.includes('公开正文保留。'));

    const riverQuote = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: emoticonCrossLineRole }]);
    const parsedRiver = extractTopicRiverQuote(`外层\n\n${riverQuote}`);
    const riverBody = parsedRiver.rows.map(r => r.content).join('\n');
    assert.ok(!riverBody.includes('ROLE_DIVIDE_USER'), 'topicRiverQuote 颜文字跨行不得掩码真实 ROLE_DIVIDE_USER');
    assert.ok(riverBody.includes('公开正文保留。'));
});

test('Step5 Client Regression 2 (P1): 非 ESCAPE 字段内严格闭合 Markdown 代码围栏中的单行协议标记不误判损坏，含回执假围栏仍刹车', async () => {
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');

    const legalFenceInsideField = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始」',
        '```markdown',
        '<<<[TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        'Done!'
    ].join('\n');

    const extractedFields = [];
    const scanned = replaceToolRequestBlocks(legalFenceInsideField, (full, body) => {
        extractedFields.push(readToolRequestField(body, 'content'));
        return '[CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(extractedFields.length, 1, '字段内闭合代码围栏中的单行协议开标不得破坏工具调用');
    assert.ok(extractedFields[0].includes('<<<[TOOL_REQUEST]>>>'));
    assert.ok(scanned.includes('[CARD]') && scanned.includes('Done!'));

    const fwd = sanitizeForwardedContent(legalFenceInsideField);
    assert.equal(fwd, 'Done!', 'forwardMessageOwner 不得泄漏半截 「末」<<<[END_TOOL_REQUEST]>>>');

    const speech = speechSourceToText(legalFenceInsideField);
    assert.equal(speech, 'Done!', 'streamSpeech 不得吞掉后文 Done!');

    const projected = projectMemoryProtocols(legalFenceInsideField);
    assert.equal((projected.match(/调用了 FileOperator 工具/g) || []).length, 1);
    assert.ok(!projected.includes('「末」') && projected.includes('Done!'));

    // 未闭合假围栏或围栏内含真实服务端回执仍必须触发刹车
    const receiptInsideFenceBroken = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始」',
        '```markdown',
        '[[VCP调用结果信息汇总: err VCP调用结果结束]]',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const brokenRes = replaceToolRequestBlocks(receiptInsideFenceBroken, () => '[SHOULD_NOT_MATCH]', { stopAtProtocolWalls: true });
    assert.ok(!brokenRes.includes('[SHOULD_NOT_MATCH]'), '围栏内含真实服务端回执时仍须触发刹车');
});

test('Step6 Client Regression 1 (P1): emotionTags 载荷内闭合围栏与纯示例成对 ROLE_DIVIDE_USER 放行，不泄漏 <!--emo--> 与 「末」', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanWithStep = (text, step) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    // 1. 非 ESCAPE 工具载荷内的闭合 Markdown 围栏包含未闭合 <<<[ROLE_DIVIDE_USER]>>> 与 <!--emo:angry-->
    const fenceInsideTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」,',
        'content:「始」',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<!--emo:angry 1.0-->',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->写入完成！'
    ].join('\n');

    for (const step of [fenceInsideTool.length, 4, 1]) {
        const res = scanWithStep(fenceInsideTool, step);
        assert.deepEqual(res.tags, ['happy'], `fence step=${step}: 不得提前退出工具域泄漏 angry，并放行后续 happy`);
        assert.equal(res.text.trim(), '写入完成！', `fence step=${step}: 不得泄漏 「末」 或吞掉正文`);
    }

    // 2. 非 ESCAPE 工具载荷内行首成对纯示例 <<<[ROLE_DIVIDE_USER]>>>...<<<[END_ROLE_DIVIDE_USER]>>>
    const pairedRoleInsideTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」,',
        'content:「始」',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '示例角色文本',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<!--emo:angry 1.0-->',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:calm 0.8-->完成。'
    ].join('\n');

    for (const step of [pairedRoleInsideTool.length, 3, 1]) {
        const res = scanWithStep(pairedRoleInsideTool, step);
        assert.deepEqual(res.tags, ['calm'], `paired role step=${step}: 不得提前退出泄漏 angry`);
        assert.equal(res.text.trim(), '完成。', `paired role step=${step}: 不得泄漏 「末」`);
    }
});

test('Step6 Client Regression 2 (P1): stripUnclosedToolRequestsSafe 保护后方闭合代码围栏与行内反引号，不撕裂围栏也不吞语音', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');

    // 1. 前部未闭合工具请求 + 后部真回执 + 后部含 <<<[TOOL_REQUEST]>>>/<<<[ROLE_DIVIDE_USER]>>> 的闭合代码围栏和行内反引号
    const unclosedThenReceiptAndFence = [
        '前文保留。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」Secret「末」,content:「始」UNCLOSED_SECRET',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '请看代码围栏示例：',
        '```text',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name: "DemoInFence"',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '```',
        '以及行内代码 ``<<<[ROLE_DIVIDE_USER]>>>`` 说明。',
        '后文结论必须完整保留！'
    ].join('\n');

    const fwd = sanitizeForwardedContent(unclosedThenReceiptAndFence);
    assert.ok(!fwd.includes('UNCLOSED_SECRET'));
    assert.ok(fwd.includes('DemoInFence'), 'forwardMessageOwner 不得撕裂后方闭合代码围栏');
    assert.ok(fwd.includes('``<<<[ROLE_DIVIDE_USER]>>>``'), 'forwardMessageOwner 不得破坏行内双反引号');
    assert.ok(fwd.includes('后文结论必须完整保留！'));

    const speech = speechSourceToText(unclosedThenReceiptAndFence);
    assert.ok(!speech.includes('UNCLOSED_SECRET'));
    assert.ok(!speech.includes('DemoInFence'), 'streamSpeech 闭合代码围栏不得被墙撕裂而泄漏内部工具块');
    assert.ok(speech.includes('后文结论必须完整保留！'), 'streamSpeech 后文结论必须完整保留');

    const quote = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: unclosedThenReceiptAndFence }]);
    const parsed = extractTopicRiverQuote(`外层\n\n${quote}`);
    const riverBody = parsed.rows.map(r => r.content).join('\n');
    assert.ok(!riverBody.includes('UNCLOSED_SECRET'));
    assert.ok(riverBody.includes('DemoInFence'), 'topicRiverQuote 不得撕裂后方闭合代码围栏');
    assert.ok(riverBody.includes('``<<<[ROLE_DIVIDE_USER]>>>``'), 'topicRiverQuote 不得破坏行内双反引号');
    assert.ok(riverBody.includes('后文结论必须完整保留！'));

    // 2. 前部未闭合工具请求后无真实回执，仅跟随含协议标记的闭合围栏 -> 截断至未闭合起点，绝不撕裂围栏泄漏围栏内标签
    const unclosedThenOnlyFence = [
        '开头正文。',
        '<<<[TOOL_REQUEST]>>>tool_name:「始」Secret「末」,content:「始」UNCLOSED_TAIL',
        '```text',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<<<[TOOL_REQUEST]>>>FENCE_SHOULD_NOT_LEAK',
        '```'
    ].join('\n');
    const speechOnlyFence = speechSourceToText(unclosedThenOnlyFence);
    assert.equal(speechOnlyFence, '开头正文。', 'streamSpeech 不得把围栏内 <<<[ROLE_DIVIDE_USER]>>> 当墙而泄漏 FENCE_SHOULD_NOT_LEAK');
    const fwdOnlyFence = sanitizeForwardedContent(unclosedThenOnlyFence);
    assert.equal(fwdOnlyFence, '开头正文。', 'forwardMessageOwner 不得在围栏内部刹车撕裂围栏');
});

test('Step7 Client Regression 1 (P1): emotionTags 载荷内纯文档工具结果围栏放行，且真实回执破墙后的孤立闭合反引号不再吞第 2 跳正文与情绪', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanWithStep = (text, step) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    // 1. 合法 WriteDoc 工具载荷内闭合围栏包含纯文档型 [[VCP调用结果信息汇总:...VCP调用结果结束]]
    const docSummaryFenceTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」',
        '```md',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Demo',
        '<!--emo:angry 1.0-->',
        'VCP调用结果结束]]',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->完成！'
    ].join('\n');

    for (const step of [docSummaryFenceTool.length, 4, 1]) {
        const res = scanWithStep(docSummaryFenceTool, step);
        assert.deepEqual(res.tags, ['happy'], `doc summary fence step=${step}: 不得提前退出工具域泄漏 angry，并放行后续 happy`);
        assert.equal(res.text.trim(), '完成！', `doc summary fence step=${step}: 不得吞掉正文或泄漏 「末」`);
    }

    // 2a. 围栏内真实回执破墙（ROLE_DIVIDE_USER + VCP协议纠偏指导）后残留孤立 ```，不得误开新 code 域吞掉第 2 跳正文
    const brokenRoleFenceThenHop2 = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->第2跳正文必须保留！'
    ].join('\n');

    for (const step of [brokenRoleFenceThenHop2.length, 4, 1]) {
        const res = scanWithStep(brokenRoleFenceThenHop2, step);
        assert.deepEqual(res.tags, ['happy'], `broken role fence step=${step}: 孤立闭合围栏不得吞掉第 2 跳 happy`);
        assert.ok(res.text.includes('第2跳正文必须保留！'), `broken role fence step=${step}: 第 2 跳正文必须保留`);
    }

    // 2b. 围栏内含裸 [[VCP调用结果信息汇总: ... [[VCP协议纠偏指导:...]] ... VCP调用结果结束]] 破墙后残留孤立围栏
    const brokenBareReceiptFenceThenHop2 = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」',
        '```md',
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[VCP协议纠偏指导: code=ERR block=abcd1234]]',
        'VCP调用结果结束]]',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:calm 0.8-->第2跳裸回执正文保留！'
    ].join('\n');

    for (const step of [brokenBareReceiptFenceThenHop2.length, 4, 1]) {
        const res = scanWithStep(brokenBareReceiptFenceThenHop2, step);
        assert.deepEqual(res.tags, ['calm'], `broken bare receipt fence step=${step}: 孤立闭合围栏不得吞掉第 2 跳 calm`);
        assert.ok(res.text.includes('第2跳裸回执正文保留！'), `broken bare receipt fence step=${step}: 第 2 跳正文必须保留`);
    }
});

test('Step7 Client Regression 2 (P1): vcpResilienceMask 对齐行首墙/安全闭合围栏/成对纯示例，idleChat 与 stripThoughtChains 不误伤', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const idleChat = require('../modules/deskpet/idleChat');
    const contextSanitizer = require('../modules/contextSanitizer');
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');

    // 1. 非 ESCAPE 工具载荷行中散文提及 <<<[ROLE_DIVIDE_USER]>>>
    const inlineRoleProse = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」不要在正文里写 <<<[ROLE_DIVIDE_USER]>>> 哦！',
        '<think>inside_inline</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.8-->你好，世界！'
    ].join('\n');
    const idleInline = idleChat.cleanLine(inlineRoleProse);
    assert.ok(idleInline && idleInline.text.includes('你好，世界！'), 'idleChat: 行中提及 ROLE_DIVIDE_USER 不得击穿工具块导致返回 null');
    assert.ok(!idleInline.text.includes('WriteDoc') && !idleInline.text.includes('inside_inline'));
    const thoughtInline = contextSanitizer.stripThoughtChains(`<think>outer</think>\n${inlineRoleProse}`);
    assert.ok(!thoughtInline.includes('outer'), 'stripThoughtChains: 外层思维链必须剥离');
    assert.ok(thoughtInline.includes('<think>inside_inline</think>'), 'stripThoughtChains: 工具内 <think> 必须受保护');

    // 2. 非 ESCAPE 工具载荷内闭合围栏包含 <<<[ROLE_DIVIDE_USER]>>> 与文档型 [[VCP调用结果信息汇总:...VCP调用结果结束]]
    const fencePayloadTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '```',
        '```md',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Demo',
        '<think>inside_doc_fence</think>',
        'VCP调用结果结束]]',
        '```',
        '<think>inside_after_fence</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:calm 0.7-->围栏外正文保留！'
    ].join('\n');
    const docFields = [];
    const scannedDoc = replaceToolRequestBlocks(fencePayloadTool, (_full, body) => {
        docFields.push(readToolRequestField(body, 'content'));
        return '[DOC_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(docFields.length, 1, 'toolRequestScanner: 文档型汇总围栏必须放行');
    assert.ok(scannedDoc.includes('[DOC_CARD]') && scannedDoc.includes('围栏外正文保留！'));

    const idleFence = idleChat.cleanLine(fencePayloadTool);
    assert.ok(idleFence && idleFence.text.includes('围栏外正文保留！'), 'idleChat: 字段内闭合文档围栏不得破墙吞尾');
    const thoughtFence = contextSanitizer.stripThoughtChains(`<think>outer_fence</think>\n${fencePayloadTool}`);
    assert.ok(!thoughtFence.includes('outer_fence'));
    assert.ok(thoughtFence.includes('<think>inside_doc_fence</think>'), 'stripThoughtChains: 围栏文档内 <think> 必须受保护');
    assert.ok(thoughtFence.includes('<think>inside_after_fence</think>'), 'stripThoughtChains: 围栏后工具内 <think> 必须受保护');

    // 3. 非 ESCAPE 工具载荷内成对纯示例 ROLE_DIVIDE_USER 与自闭合 TOOL_REQUEST 示例
    const pairedExamplesTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」示例一：',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '纯用户示例正文',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '示例二：',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name: "DemoTool"',
        '<<<[END_TOOL_REQUEST]>>>',
        '<think>inside_paired</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->成对示例外正文保留！'
    ].join('\n');
    const idlePaired = idleChat.cleanLine(pairedExamplesTool);
    assert.ok(idlePaired && idlePaired.text.includes('成对示例外正文保留！'), 'idleChat: 字段内成对纯示例不得破墙返回 null');
    const thoughtPaired = contextSanitizer.stripThoughtChains(`<think>outer_paired</think>\n${pairedExamplesTool}`);
    assert.ok(!thoughtPaired.includes('outer_paired'));
    assert.ok(thoughtPaired.includes('<think>inside_paired</think>'), 'stripThoughtChains: 成对示例后工具内 <think> 必须受保护');

    // 4. 围栏内含真实回执外壳（[[VCP调用结果信息汇总:...]] + <<<[ROLE_DIVIDE_USER]>>>）仍必须触发刹车，不得把围栏外后方伪装成受保护工具块
    const brokenReceiptWithThought = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」, ',
        'content:「始」',
        '```markdown',
        '[[VCP调用结果信息汇总: err VCP调用结果结束]]',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '```',
        '<think>should_be_stripped_after_broken_fence</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const brokenThoughtOut = contextSanitizer.stripThoughtChains(brokenReceiptWithThought);
    assert.ok(!brokenThoughtOut.includes('should_be_stripped_after_broken_fence'), '含真实回执假围栏仍须触发刹车，围栏外 <think> 不得被当成受保护工具载荷');
});

test('Step8 Client Regression (P1): 第 1 跳未闭代码围栏不得跨越协议墙配对第 2 跳闭合围栏而吞掉第 2 跳正文与代码块', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { findUnclosedToolRequest } = await import('../modules/renderer/toolRequestScanner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');
    const mask = require('../modules/shared/vcpResilienceMask');

    // 1. 第 1 跳未闭合 TOOL_REQUEST 内有未闭合 ```js，跨越 ROLE_DIVIDE_USER 工具回执墙后接第 2 跳正文与合法 ```python 代码块
    const crossWallWithReceipt = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」',
        '```js',
        'const incomplete = 1;',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: err_secret_payload',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳正文：',
        '```python',
        'print(42)',
        '```',
        '收尾文字！'
    ].join('\n');

    const fwd = sanitizeForwardedContent(crossWallWithReceipt);
    assert.ok(!fwd.includes('incomplete') && !fwd.includes('err_secret_payload'), 'forwardMessageOwner 必须剥离第 1 跳未闭载荷与工具回执');
    assert.ok(fwd.includes('第2跳正文：'), 'forwardMessageOwner 必须保留第 2 跳正文');
    assert.ok(fwd.includes('```python\nprint(42)\n```'), 'forwardMessageOwner 必须完整保留第 2 跳合法 python 代码块');
    assert.ok(fwd.includes('收尾文字！'), 'forwardMessageOwner 必须保留收尾文字');

    const speech = speechSourceToText(crossWallWithReceipt);
    assert.ok(!speech.includes('incomplete') && !speech.includes('err_secret_payload'), 'streamSpeech 必须剥离第 1 跳未闭载荷与工具回执');
    assert.ok(speech.includes('第2跳正文：'), 'streamSpeech 必须保留第 2 跳正文');
    assert.ok(!speech.includes('print(42)'), 'streamSpeech 闭合 python 代码块仍须剥离，不得因伪围栏错位而泄漏');
    assert.ok(speech.includes('收尾文字！'), 'streamSpeech 必须保留收尾文字');

    const riverQuote = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: crossWallWithReceipt }]);
    const parsedRiver = extractTopicRiverQuote(`外层\n\n${riverQuote}`);
    const riverBody = parsedRiver.rows.map(r => r.content).join('\n');
    assert.ok(!riverBody.includes('incomplete'), 'topicRiverQuote 不得保留第 1 跳未闭载荷');
    assert.ok(riverBody.includes('第2跳正文：'), 'topicRiverQuote 必须保留第 2 跳正文');
    assert.ok(riverBody.includes('print(42)'), 'topicRiverQuote 必须保留第 2 跳 python 代码块');
    assert.ok(riverBody.includes('收尾文字！'), 'topicRiverQuote 必须保留收尾文字');

    // 2. 第 1 跳未闭 ```js 跨占位符 <!--VCP_TOOL_RESULT_0--> 或无汇总块的 ROLE_DIVIDE_USER 外壳
    const crossPlaceholderDirect = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」',
        '```js',
        'const leaked_draft = true;',
        '<!--VCP_TOOL_RESULT_0-->',
        '第2跳直出正文：',
        '```python',
        'print(42)',
        '```',
        '收尾保留！'
    ].join('\n');
    const strippedDirect = mask.stripUnclosedToolRequestsSafe(crossPlaceholderDirect, findUnclosedToolRequest, {
        extraWallPattern: '<!--VCP_TOOL_RESULT_\\d+-->',
    });
    assert.ok(!strippedDirect.includes('leaked_draft'), 'stripUnclosedToolRequestsSafe 必须截断第 1 跳未闭载荷');
    assert.ok(strippedDirect.includes('<!--VCP_TOOL_RESULT_0-->'), '占位墙必须保留供后续步骤处理');
    assert.ok(strippedDirect.includes('第2跳直出正文：') && strippedDirect.includes('print(42)') && strippedDirect.includes('收尾保留！'),
        'stripUnclosedToolRequestsSafe 不得因未闭围栏跨墙配对而吞掉第 2 跳');

    const crossBareRole = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」',
        '```js',
        'const leaked_role_draft = true;',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '系统回执',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳角色后正文：',
        '```python',
        'print(42)',
        '```',
        '收尾保留！'
    ].join('\n');
    const fwdBareRole = sanitizeForwardedContent(crossBareRole);
    assert.ok(!fwdBareRole.includes('leaked_role_draft'));
    assert.ok(fwdBareRole.includes('第2跳角色后正文：') && fwdBareRole.includes('print(42)') && fwdBareRole.includes('收尾保留！'));
    const speechBareRole = speechSourceToText(crossBareRole);
    assert.ok(!speechBareRole.includes('leaked_role_draft'));
    assert.ok(speechBareRole.includes('第2跳角色后正文：') && speechBareRole.includes('收尾保留！'));
});

test('Step9 Client Regression 1 (P1): 工具结果内含闭合 Markdown 代码块时外层工具结果不得被跳过剥离而泄漏原文', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');

    const resultWithInnerFence = [
        '准备读取文件：',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容: 文件内容如下：',
        '```js',
        'console.log("TOP_SECRET_FILE_CONTENT");',
        '```',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '读取完成，核心结论在此！'
    ].join('\n');

    const fwd = sanitizeForwardedContent(resultWithInnerFence);
    assert.ok(!fwd.includes('TOP_SECRET_FILE_CONTENT') && !fwd.includes('VCP调用结果信息汇总'),
        'forwardMessageOwner 必须剥离内部含代码块的外层工具结果');
    assert.ok(fwd.includes('准备读取文件：') && fwd.includes('读取完成，核心结论在此！'));

    const speech = speechSourceToText(resultWithInnerFence);
    assert.ok(!speech.includes('TOP_SECRET_FILE_CONTENT') && !speech.includes('FileOperator'),
        'streamSpeech 必须剥离内部含代码块的外层工具结果');
    assert.ok(speech.includes('准备读取文件：') && speech.includes('读取完成，核心结论在此！'));
});

test('Step9 Client Regression 2 (P1): maskProtectedRegions 与 collectProtocolLiteralCodeRanges 不得让第 1 跳未闭围栏跨墙遮住第 2 跳工具块或正文', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { formatTopicRiverQuote } = require('../modules/services/topicRiverQuote');
    const { extractTopicRiverQuote } = await import('../modules/renderer/renderTemplateCompiler.js');
    const mask = require('../modules/shared/vcpResilienceMask');

    const crossWallWithJump2Tool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」',
        '```js',
        'const leaked_jump1 = 1;',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: WriteFile',
        '- 执行状态: ❌ ERROR',
        '- 返回内容: [[VCP协议纠偏指导: code=UNCLOSED_TOOL_BLOCK block=deadbeef]]',
        '[[/VCP协议纠偏指导]]',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳重试正文：',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」RealTool「末」, ',
        'content:「始」SECOND_HOP_TOOL_SECRET「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '```python',
        'print(42)',
        '```',
        '第2跳最终结论！'
    ].join('\n');

    // 1. maskProtectedRegions 不得跨墙把第 1 跳 ROLE_DIVIDE_USER 塞进保护围栏
    const maskedOut = mask.maskProtectedRegions(crossWallWithJump2Tool);
    assert.ok(maskedOut.text.includes('<<<[ROLE_DIVIDE_USER]>>>'),
        'maskProtectedRegions 不得把跨墙伪围栏里的 ROLE_DIVIDE_USER 掩码吞掉');
    assert.ok(!maskedOut.masks.some(m => m.content.includes('leaked_jump1') && m.content.includes('print(42)')),
        'maskProtectedRegions 不得生成跨墙伪围栏');

    // 2. replaceToolRequestBlocks 必须剥离第 2 跳真实工具请求，同时保护第 2 跳 python 围栏
    const replaced = replaceToolRequestBlocks(crossWallWithJump2Tool, () => '[J2_CARD]', { stopAtProtocolWalls: true });
    assert.ok(replaced.includes('[J2_CARD]'), '第 2 跳真实工具块不得被第 1 跳跨墙伪围栏遮盖而漏匹配');
    assert.ok(!replaced.includes('SECOND_HOP_TOOL_SECRET'));
    assert.ok(replaced.includes('```python\nprint(42)\n```'));

    // 3. forwardMessageOwner 与 topicRiverQuote 不泄漏第 1 跳/ROLE_DIVIDE/第 2 跳工具载荷且保留第 2 跳正文与 python 代码块
    const fwd = sanitizeForwardedContent(crossWallWithJump2Tool);
    assert.ok(!fwd.includes('leaked_jump1') && !fwd.includes('SECOND_HOP_TOOL_SECRET') && !fwd.includes('ROLE_DIVIDE_USER'));
    assert.ok(fwd.includes('第2跳重试正文：') && fwd.includes('```python\nprint(42)\n```') && fwd.includes('第2跳最终结论！'));

    const riverQuote = await formatTopicRiverQuote([{ role: 'assistant', name: 'Nova', content: crossWallWithJump2Tool }]);
    const parsedRiver = extractTopicRiverQuote(`外层\n\n${riverQuote}`);
    const riverBody = parsedRiver.rows.map(r => r.content).join('\n');
    assert.ok(!riverBody.includes('leaked_jump1') && !riverBody.includes('SECOND_HOP_TOOL_SECRET') && !riverBody.includes('ROLE_DIVIDE_USER'));
    assert.ok(riverBody.includes('第2跳重试正文：') && riverBody.includes('print(42)') && riverBody.includes('第2跳最终结论！'));
});

test('Step9 Client Regression 3 (P1): stripThoughtChains 未闭合思考链遇到工具调用/回执/掩码边界立即刹车，不吞第 2 跳正文', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const danglingThinkThenJump2 = [
        '<think>',
        '思考中忘了闭合标签...',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」payload_inside_tool「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: WriteFile',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容: ok',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '最终结论：任务已完成。'
    ].join('\n');

    const outThink = contextSanitizer.stripThoughtChains(danglingThinkThenJump2);
    assert.ok(!outThink.includes('思考中忘了闭合标签'), '未闭合 <think> 必须被剥离');
    assert.ok(outThink.includes('payload_inside_tool') && outThink.includes('<<<[END_TOOL_REQUEST]>>>'),
        '未闭合 <think> 不得吞掉后方工具调用');
    assert.ok(outThink.includes('最终结论：任务已完成。'), '未闭合 <think> 不得吞掉第 2 跳最终结论');

    const danglingVcpThenJump2 = [
        '开场白。',
        '[--- VCP元思考链 (Auto) ---]',
        '元思考中忘了闭合...',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: ok VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '元思考后最终答案！'
    ].join('\n');

    const outVcp = contextSanitizer.stripThoughtChains(danglingVcpThenJump2);
    assert.ok(!outVcp.includes('元思考中忘了闭合'), '未闭合 VCP 元思考链必须被剥离');
    assert.ok(outVcp.includes('开场白。') && outVcp.includes('元思考后最终答案！'),
        '未闭合 VCP 元思考链不得吞掉后方回执与第 2 跳正文');
});

test('Step9 Client Regression 4 (P1): 非 ESCAPE 字段内孤立无回执结构的单行 [[VCP调用结果信息汇总: test 不误判协议墙', async () => {
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');
    const { findExplicitStablePrefix } = await import('../modules/renderer/streamStableBoundary.js');
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');

    const isolatedSummaryDocTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」, ',
        'content:「始」',
        'Here is a line starting with:',
        '[[VCP调用结果信息汇总: test',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '写入完成，这是给用户的正文。'
    ].join('\n');

    const fields = [];
    const scanned = replaceToolRequestBlocks(isolatedSummaryDocTool, (_full, body) => {
        fields.push(readToolRequestField(body, 'content'));
        return '[FILE_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(fields.length, 1, 'toolRequestScanner 不得将孤立 [[VCP调用结果信息汇总: test 误判协议墙');
    assert.ok(fields[0].includes('[[VCP调用结果信息汇总: test'));
    assert.ok(scanned.includes('[FILE_CARD]') && scanned.includes('写入完成，这是给用户的正文。'));

    const cutoff = findExplicitStablePrefix(isolatedSummaryDocTool);
    assert.ok(cutoff >= isolatedSummaryDocTool.indexOf('<<<[END_TOOL_REQUEST]>>>') + '<<<[END_TOOL_REQUEST]>>>'.length,
        `streamStableBoundary 不得卡死在 0 (cutoff=${cutoff})`);

    const fwd = sanitizeForwardedContent(isolatedSummaryDocTool);
    assert.equal(fwd, '写入完成，这是给用户的正文。', 'forwardMessageOwner 不得吞掉工具调用后的正文');

    const speech = speechSourceToText(isolatedSummaryDocTool);
    assert.equal(speech, '写入完成，这是给用户的正文。', 'streamSpeech 不得吞掉工具调用后的正文');

    const projected = projectMemoryProtocols(isolatedSummaryDocTool);
    assert.ok(projected.includes('调用了 FileOperator 工具。') && projected.includes('写入完成，这是给用户的正文。'),
        'memoryProtocolProjection 必须投影单次 FileOperator 调用并保留正文');
    assert.ok(!projected.includes('「末」'));
});

test('Step10 Client Regression 1 (P1): 4 反引号/波浪线合法双围栏内含配平 ROLE_DIVIDE 不拆分，真实跨墙拆分绝不残留外层闭合行导致 searchManager 绕过封印', async () => {
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { default: searchManager } = await import('../modules/searchManager.js');

    // 1. 4 反引号合法闭合围栏同时包含配平 ```js...``` 与配平 ROLE_DIVIDE_USER...END_ROLE_DIVIDE_USER + 后方真实工具调用与 <img onerror>
    const fourTickDocThenRealTool = [
        '````markdown',
        '```js',
        'const sample = 1;',
        '```',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '文档角色示例',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '````',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」<img src=x onerror=alert(1)>「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const replacedDoc = replaceToolRequestBlocks(fourTickDocThenRealTool, () => '[REAL_TOOL]', { stopAtProtocolWalls: true });
    assert.ok(replacedDoc.includes('文档角色示例') && replacedDoc.includes('[REAL_TOOL]'),
        '4 反引号合法双围栏不得误拆，且后方真实 TOOL_REQUEST 必须被识别');
    assert.ok(!replacedDoc.includes('<img src=x onerror=alert(1)>'));

    const searchHtmlDoc = searchManager.renderSearchContent(fourTickDocThenRealTool, 'r10-doc');
    assert.ok(!/<img\b/i.test(searchHtmlDoc), 'searchManager 不得未转义输出原生 <img> 标签');
    assert.ok(searchHtmlDoc.includes('&lt;img src=x onerror=alert(1)&gt;'));

    // 2. 真实跨墙拆分（3 反引号跨 <!--VCP_TOOL_RESULT_0--> 或 ROLE_DIVIDE_USER）后绝不残留外层闭合行吞掉后方工具与 searchManager 转义
    const crossSplitThenRealTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」Secret「末」, ',
        'content:「始」',
        '```js',
        'const draft = 1;',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: err VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳说明',
        '```',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」<img src=x onerror=alert(1)>「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');

    const replacedSplit = replaceToolRequestBlocks(crossSplitThenRealTool, () => '[REAL_TOOL_AFTER_SPLIT]', { stopAtProtocolWalls: true });
    assert.ok(replacedSplit.includes('[REAL_TOOL_AFTER_SPLIT]'),
        '跨墙拆分不得把外层闭合 ``` 残留进 tail 而吞掉后方真实工具调用');
    assert.ok(!replacedSplit.includes('<img src=x onerror=alert(1)>'));

    const searchHtmlSplit = searchManager.renderSearchContent(crossSplitThenRealTool, 'r10-split');
    assert.ok(!/<img\b/i.test(searchHtmlSplit), 'searchManager 在跨墙拆分后仍必须严格转义后续工具内 HTML');
});

test('Step10 Client Regression 2 (P1): findFenceRangesOutsideProtocolWalls 严格仅在真实跨墙时拆分，且绝不残留外层闭合行破坏 Block 2', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');
    const mask = require('../modules/shared/vcpResilienceMask');

    // 1. 无前置未闭工具的 3 反引号与 4 反引号配平文档块，紧跟 Block 2 (<think> 示例) 与真实工具调用
    const benignFencesThenBlock2 = [
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Demo',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '````markdown',
        '```js',
        'console.log(1);',
        '```',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '示例角色',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '````',
        '```text',
        '<think>keep_in_block2</think>',
        '```',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」HiddenTool「末」, ',
        'content:「始」TOOL_SECRET_BODY「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '最终可见结论！'
    ].join('\n');

    const thoughtOut = contextSanitizer.stripThoughtChains(benignFencesThenBlock2);
    assert.ok(thoughtOut.includes('<think>keep_in_block2</think>'), 'Block 2 围栏内 <think> 示例不得因外层闭合行残留而失效');
    assert.ok(thoughtOut.includes('示例角色') && thoughtOut.includes('最终可见结论！'));

    const fwdOut = sanitizeForwardedContent(benignFencesThenBlock2);
    assert.ok(!fwdOut.includes('TOOL_SECRET_BODY') && !fwdOut.includes('HiddenTool'), '外层真实工具调用必须剥离');
    assert.ok(fwdOut.includes('示例角色') && fwdOut.includes('最终可见结论！'));

    // 2. 真实跨墙拆分（后无内层围栏）后紧跟 Block 2 (<think> 示例)：Block 2 必须完好保留
    const splitWithoutRightFenceThenBlock2 = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」Draft「末」, ',
        'content:「始」',
        '```js',
        'const incomplete = 1;',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: err VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳散文',
        '```',
        '```text',
        '<think>block2_after_split_must_stay</think>',
        '```'
    ].join('\n');
    const rangesAfterSplit = mask.findFenceRangesOutsideProtocolWalls(splitWithoutRightFenceThenBlock2);
    assert.equal(rangesAfterSplit.length, 1, '跨墙拆分不得把外层闭合行当新开标偷配 Block 2');
    const thoughtSplit = contextSanitizer.stripThoughtChains(splitWithoutRightFenceThenBlock2);
    assert.ok(thoughtSplit.includes('<think>block2_after_split_must_stay</think>'),
        '跨墙拆分后 Block 2 围栏内 <think> 必须受保护');
});

test('Step10 Client Regression 3 (P1): 字段内不含纠偏/批次、且 ROLE_DIVIDE 与工具结果各自配平的闭合围栏放行', async () => {
    const { extractFileChanges } = await import('../modules/ui-system/message-file-changes.js');
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
    const { prepareCompactionState } = await import('../modules/chat/contextCompactionState.js');

    const balancedRoleResultInFenceTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」, ',
        'command:「始」WriteFile「末」, ',
        'path:「始」/tmp/vcp-doc.md「末」, ',
        'content:「始」',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Demo',
        '<!--emo:sad 0.9-->',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->文档写入完成！'
    ].join('\n');

    const withReceipt = `${balancedRoleResultInFenceTool}\n<<<[ROLE_DIVIDE_USER]>>>\n[[VCP调用结果信息汇总:\n- 工具名称: FileOperator\n- 执行状态: ✅ SUCCESS\n- 返回内容: ok\nVCP调用结果结束]]\n<<<[END_ROLE_DIVIDE_USER]>>>`;
    const fileChanges = extractFileChanges(withReceipt);
    assert.equal(fileChanges.length, 1, 'extractFileChanges 必须识别含配平角色+结果文档围栏的 FileOperator 调用');
    assert.equal(fileChanges[0].path, '/tmp/vcp-doc.md');

    const projected = projectMemoryProtocols(balancedRoleResultInFenceTool);
    assert.ok(projected.includes('调用了 FileOperator 工具。') && projected.includes('文档写入完成！'));
    assert.ok(!projected.includes('「末」'), 'memoryProtocolProjection 不得截断泄漏 「末」');

    const compacted = prepareCompactionState([{ role: 'assistant', content: balancedRoleResultInFenceTool }]);
    assert.ok(!compacted.renderedTranscript?.includes?.('「末」') && JSON.stringify(compacted).includes('文档写入完成！'));

    const scanner = createEmotionTagScanner();
    const events = [...scanner.push(balancedRoleResultInFenceTool), ...scanner.finish()];
    const tags = events.filter(e => e.type === 'tag').map(e => e.emotion);
    const textOut = events.filter(e => e.type === 'text').map(e => e.text).join('');
    assert.deepEqual(tags, ['happy'], 'emotionTags 不得提前退出工具域泄漏 sad');
    assert.equal(textOut.trim(), '文档写入完成！');
});

test('Step10 Client Regression 4 (P2): 含代码块思考链闭标同行有正文且右侧紧跟回答时完整剥离，不漏后半段与 </think>', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const thinkWithFenceAndInlineClose = [
        '<think>',
        'Check code:',
        '```js',
        'const secret = 1;',
        '```',
        'Result is 42.</think> Answer: 42'
    ].join('\n');

    assert.equal(
        contextSanitizer.stripThoughtChains(thinkWithFenceAndInlineClose),
        'Answer: 42',
        '含围栏且闭标同行两侧有字面的思考链必须剥净至 </think>，仅保留右侧回答'
    );

    const vcpWithFenceAndInlineClose = [
        '[--- VCP元思考链: "Nova" ---]',
        'Check:',
        '```js',
        'const a = 2;',
        '```',
        'Done.[--- 元思考链结束 ---] Final reply'
    ].join('\n');
    assert.equal(contextSanitizer.stripThoughtChains(vcpWithFenceAndInlineClose), 'Final reply');
});

test('Step11 Client Regression 1 (P1): 思考链内未闭合围栏不得跨越 </think> 与正文代码块配对而吞掉整条回复', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const thinkUnclosedFenceThenBodyFence = [
        '<think>',
        '模型思考中草稿：',
        '```js',
        'const x = 1;',
        '</think>',
        '正式回复正文！',
        '```python',
        'print(42)',
        '```'
    ].join('\n');
    const outThink = contextSanitizer.stripThoughtChains(thinkUnclosedFenceThenBodyFence);
    assert.ok(!outThink.includes('模型思考中草稿') && !outThink.includes('const x = 1;'),
        '<think> 内未闭代码草稿必须随思考链一起剥离');
    assert.ok(outThink.includes('正式回复正文！') && outThink.includes('```python\nprint(42)\n```'),
        '思考链外正文与合法 python 代码块必须 100% 保留');

    const vcpThinkUnclosedFence = [
        '[--- VCP元思考链: "Nova" ---]',
        '草稿：',
        '```js',
        'const draft = 1;',
        '[--- 元思考链结束 ---]',
        '正式元思考回复！',
        '```python',
        'print(99)',
        '```'
    ].join('\n');
    const outVcp = contextSanitizer.stripThoughtChains(vcpThinkUnclosedFence);
    assert.ok(!outVcp.includes('const draft = 1;') && outVcp.includes('正式元思考回复！') && outVcp.includes('```python\nprint(99)\n```'));

    const docFenceOutsideThink = [
        '文档说明：',
        '```markdown',
        '<think>example</think>',
        '</think>',
        '```',
        '正文保留！'
    ].join('\n');
    const outDoc = contextSanitizer.stripThoughtChains(docFenceOutsideThink);
    assert.ok(outDoc.includes('<think>example</think>') && outDoc.includes('</think>') && outDoc.includes('正文保留！'),
        '思考链外部正常文档代码块内的 <think>/<\\/think> 示例必须完好保护');
});

test('Step11 Client Regression 2 (P1): 反引号围栏内 ~~~ 与孤立 END_ROLE_DIVIDE 不误拆，外开围栏撞墙保留前半段', async () => {
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');
    const mask = require('../modules/shared/vcpResilienceMask');

    // 触发 A：闭合 ```text 内含 <think>、<<<[TOOL_REQUEST]>>> 与孤立 <<<[END_ROLE_DIVIDE_USER]>>>
    const triggerA = [
        '```text',
        '<think>keep me</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DemoA「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '后文A保留。'
    ].join('\n');
    assert.ok(contextSanitizer.stripThoughtChains(triggerA).includes('<think>keep me</think>'),
        '触发 A: 孤立 END_ROLE_DIVIDE_USER 不得拆毁闭合围栏导致 <think> 裸奔');
    assert.equal(replaceToolRequestBlocks(triggerA, () => '[SHOULD_NOT_REPLACE]', { stopAtProtocolWalls: true }), triggerA,
        '触发 A: 孤立 END_ROLE_DIVIDE_USER 不得拆毁闭合围栏导致 TOOL_REQUEST 裸奔');

    // 触发 B：闭合 ```markdown 反引号围栏内含 ~~~ 分隔线、<think>、TOOL_REQUEST 与汇总块
    const triggerB = [
        '```markdown',
        '<think>example</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DemoB「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '~~~',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: DemoB',
        'VCP调用结果结束]]',
        '```',
        '后文B保留。'
    ].join('\n');
    assert.ok(contextSanitizer.stripThoughtChains(triggerB).includes('<think>example</think>'),
        '触发 B: 反引号围栏内 ~~~ 分隔线不得被误判为未闭内层围栏');
    assert.equal(replaceToolRequestBlocks(triggerB, () => '[SHOULD_NOT_REPLACE]', { stopAtProtocolWalls: true }), triggerB,
        '触发 B: 围栏内 TOOL_REQUEST 示例必须完整保留');

    // 合法外开围栏撞上真实纠偏指导硬墙时，前半段 <think> 与 TOOL_REQUEST 示例不得丢掉开标而裸奔
    const outerOpenHitHardReceipt = [
        '```text',
        '<think>keep_in_front</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DocExample「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--VCP_TOOL_RESULT_0-->',
        '```'
    ].join('\n');
    assert.equal(
        replaceToolRequestBlocks(outerOpenHitHardReceipt, () => '[SHOULD_NOT_REPLACE]', { stopAtProtocolWalls: true }),
        outerOpenHitHardReceipt,
        '外层合法打开的围栏在硬墙前半段不得丢失外开标而导致 TOOL_REQUEST 裸奔'
    );
    const rangesOuter = mask.findFenceRangesOutsideProtocolWalls(outerOpenHitHardReceipt, {
        extraWallPattern: '<!--VCP_TOOL_RESULT_\\d+-->',
    });
    assert.ok(rangesOuter.some(r => outerOpenHitHardReceipt.slice(r.start, r.end).includes('<think>keep_in_front</think>')),
        '外层合法打开的围栏在硬墙前半段必须保留 <think> 围栏掩码');
});

test('Step11 Client Regression 3 (P2): emotionTags 流式分片下正常 ESCAPE 内含 ROLE_DIVIDE+汇总不早退，真实跨跳双 ESCAPE 仍刹车', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanWithStep = (text, step) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    const validEscapedWithRoleReceipt = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始ESCAPE」',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: ok VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<!--emo:sad 0.9-->',
        '「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.8-->完成'
    ].join('\n');

    for (const step of [validEscapedWithRoleReceipt.length, 7, 1]) {
        const res = scanWithStep(validEscapedWithRoleReceipt, step);
        assert.deepEqual(res.tags, ['happy'], `valid ESCAPE step=${step}: 流式分片不得提前退出泄漏 sad`);
        assert.equal(res.text.trim(), '完成', `valid ESCAPE step=${step}: 不得泄漏 「末ESCAPE」`);
    }

    const crossJumpDoubleEscape = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始ESCAPE」未闭合第一跳',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: err VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteEscapedFile「末」,',
        'content:「始ESCAPE」<!--emo:angry 0.9-->「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:calm 0.7-->第2跳完成'
    ].join('\n');

    for (const step of [crossJumpDoubleEscape.length, 7, 1]) {
        const res = scanWithStep(crossJumpDoubleEscape, step);
        assert.deepEqual(res.tags, ['calm'], `cross-jump ESCAPE step=${step}: 跨跳二次始ESCAPE必须正确刹车放行第2跳 calm`);
        assert.equal(res.text.trim(), '第2跳完成');
    }
});

test('Step12 Client Regression (P1): stripThoughtChains 行内反引号 </think> 与闭合围栏内行中 "a</think>b" 不误闭合/不误拆', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    // 用例 1：思考链内含行内 `</think>` 后接未闭 ```js 跨行首 </think> 到正文合法 ```js
    const inlineTickThinkThenCrossClose = [
        '<think>',
        'Check `</think>` tag.',
        '```js',
        'const broken = 1;',
        '</think>',
        'Answer:',
        '```js',
        'const ok = 2;',
        '```'
    ].join('\n');
    assert.equal(
        contextSanitizer.stripThoughtChains(inlineTickThinkThenCrossClose),
        'Answer:\n```js\nconst ok = 2;\n```',
        '用例 1: 行内 `</think>` 不得提前闭合思考链或腰斩正文'
    );

    // 用例 2：思考链内合法闭合代码块含行中字面量 "a</think>b"，其后接内层 <think>inner</think> 与 Answer.
    const innerCodeLiteralClose = [
        '<think>',
        '```js',
        'const s = "a</think>b";',
        '```',
        '<think>',
        'inner',
        '</think>',
        'Answer.'
    ].join('\n');
    assert.equal(
        contextSanitizer.stripThoughtChains(innerCodeLiteralClose),
        'Answer.',
        '用例 2: 闭合代码块内行中 "a</think>b" 不得触发 thoughtSplit，且外层思考链与内层思考链必须整体剥净'
    );
});

test('Step13 Client Regression 1 (P1): findActiveThoughtAt 非独立开标与前置工具/日记/ESCAPE 内 <think> 不得误拆后续合法代码围栏', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    // 用例 A：非独立行首开标 <think> is a reasoning tag. 后接含 <think>...</think> 的合法 XML 代码围栏
    const proseThinkThenXmlFence = [
        '<think> is a reasoning tag.',
        '',
        'Here is an XML example:',
        '```xml',
        '<think>',
        '  hello',
        '</think>',
        '```',
        '',
        'Done.'
    ].join('\n');
    assert.equal(
        contextSanitizer.stripThoughtChains(proseThinkThenXmlFence),
        proseThinkThenXmlFence,
        '用例 A: 非独立开标 <think> is a reasoning tag. 不得激活 splitAtThoughtClose 破坏后方 XML 示例围栏'
    );

    // 用例 B：前置闭合 TOOL_REQUEST / DailyNote / 顶层 ESCAPE 内含独立行首 <think>，后接含 <think>...</think> 的正常代码围栏
    const preBlocksWithThinkThenFence = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始」',
        '<think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<DailyNoteStart>>>',
        '<think>',
        '<<<DailyNoteEnd>>>',
        '「始ESCAPE」',
        '<think>',
        '「末ESCAPE」',
        '```xml',
        '<think>',
        '  hello',
        '</think>',
        '```',
        '保留结论。'
    ].join('\n');
    const outB = contextSanitizer.stripThoughtChains(preBlocksWithThinkThenFence);
    assert.ok(outB.includes('```xml\n<think>\n  hello\n</think>\n```'),
        '用例 B: 前置闭合工具/日记/ESCAPE 内的 <think> 不得误激活后续代码围栏的 splitAtThoughtClose');
    assert.ok(outB.includes('保留结论。'));
});

test('Step13 Client Regression 2 (P1): stripHiddenToolResults 禁止未闭围栏跨跳偷配绕过 [HIDDEN] 隐私剥离', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const crossWallHiddenLeak = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteFile「末」, ',
        'content:「始」',
        '```js',
        'const draft = 1;',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        '- 工具名称: SecretTool',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容: SECRET_DATA',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '第2跳回复：',
        '```js',
        'const b = 2;',
        '```',
        '公开正文。'
    ].join('\n');

    const stripped = contextSanitizer.stripHiddenToolResults(crossWallHiddenLeak);
    assert.ok(!stripped.includes('SECRET_DATA') && !stripped.includes('SecretTool'),
        'stripHiddenToolResults 不得因未闭围栏跨跳偷配而跳过真实 [HIDDEN] 工具结果导致隐私泄漏');
    assert.ok(stripped.includes('```js\nconst b = 2;\n```') && stripped.includes('公开正文。'),
        '第 2 跳合法闭合代码块与正文必须完整保留');
});

test('Step14 Client Regression 1 (P1): findCrossWallMatch 行首 VCP_TOOL_BATCH_START 无条件硬墙拆分，防未闭围栏跨批泄漏 [HIDDEN]', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const unclosedFenceAcrossBatch = [
        '```js',
        'const leaked_draft = 1;',
        '<<<[VCP_TOOL_BATCH_START:b1]>>>',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        '- 工具名称: SecretTool',
        '- 返回内容: TOP_SECRET',
        'VCP调用结果结束]]',
        '<<<[VCP_TOOL_BATCH_END:b1]>>>',
        '```',
        'Final answer'
    ].join('\n');

    const hiddenStripped = contextSanitizer.stripHiddenToolResults(unclosedFenceAcrossBatch);
    assert.ok(!hiddenStripped.includes('TOP_SECRET') && !hiddenStripped.includes('SecretTool'),
        'stripHiddenToolResults 遇到行首 VCP_TOOL_BATCH_START 必须硬墙拆分并剥离 [HIDDEN] 结果');
    assert.ok(hiddenStripped.includes('Final answer'));

    const fwd = sanitizeForwardedContent(unclosedFenceAcrossBatch);
    assert.ok(!fwd.includes('TOP_SECRET') && !fwd.includes('SecretTool'),
        'forwardMessageOwner 不得因跨批伪围栏泄漏 TOP_SECRET');
    assert.ok(fwd.includes('Final answer'));
});

test('Step14 Client Regression 2 (P1): 严格思考标签头正则，不误吞 <thinking about you> 与自闭合 <think />', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const proseAttrWord = 'Hello!\n<thinking about you>\nImportant body text.';
    assert.equal(
        contextSanitizer.stripThoughtChains(proseAttrWord),
        proseAttrWord,
        '<thinking about you> 不得被误判为未闭合思考链而吞掉正文'
    );

    const selfClosingThink = 'Before\n<think />\nAfter';
    assert.equal(
        contextSanitizer.stripThoughtChains(selfClosingThink),
        selfClosingThink,
        '自闭合 <think /> 不得被误判为未闭合思考链而吞掉 After'
    );

    const validAttrThink = '<think type="main">\nsecret\n</think>\nVisible reply';
    assert.equal(
        contextSanitizer.stripThoughtChains(validAttrThink),
        'Visible reply',
        '带合法 attr=value 属性的 <think type="main"> 仍须正常剥离'
    );
});

test('Step14 Client Regression 3 (P1): 同行自闭合 <think>...</think> Keep this prose! 绝不跨行错配后方 </think> 吞掉中间段落', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const inlineClosedThenLaterThink = [
        '<think>ok</think> Keep this prose!',
        'Middle paragraph.',
        '<think>',
        'second',
        '</think>',
        'End.'
    ].join('\n');

    assert.equal(
        contextSanitizer.stripThoughtChains(inlineClosedThenLaterThink),
        '<think>ok</think> Keep this prose!\nMiddle paragraph.\nEnd.',
        '同行已自闭合的 <think>ok</think> 行必须跳过，保留 Keep this prose! 与 Middle paragraph.'
    );
});

test('Step15 Client Regression 1 (P1): 非 ESCAPE 字段内自包含闭合纯文档型 [[VCP调用结果信息汇总:...VCP调用结果结束]] 放行', async () => {
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
    const contextSanitizer = require('../modules/contextSanitizer');

    const selfContainedDocSummaryTool = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始」',
        'Log:',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: Calc',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容: 42',
        '<!--emo:sad 0.9-->',
        '<think>keep_inside_tool</think>',
        'VCP调用结果结束]]',
        'Everything ok!',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->Done.'
    ].join('\n');

    const fields = [];
    const scanned = replaceToolRequestBlocks(selfContainedDocSummaryTool, (_full, body) => {
        fields.push(readToolRequestField(body, 'content'));
        return '[TOOL_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(fields.length, 1, 'toolRequestScanner 必须放行字段内自包含纯文档型汇总块');
    assert.ok(fields[0].includes('Everything ok!') && scanned.includes('[TOOL_CARD]') && scanned.includes('Done.'));

    assert.equal(sanitizeForwardedContent(selfContainedDocSummaryTool), '<!--emo:happy 0.9-->Done.', 'forwardMessageOwner 必须剥离工具块并保留 Done.');
    assert.equal(speechSourceToText(selfContainedDocSummaryTool), 'Done.', 'streamSpeech 必须剥离工具块并保留 Done.');

    const projected = projectMemoryProtocols(selfContainedDocSummaryTool);
    assert.ok(projected.includes('调用了 FileOperator 工具。') && projected.includes('Done.') && !projected.includes('「末」'));

    const thoughtOut = contextSanitizer.stripThoughtChains(selfContainedDocSummaryTool);
    assert.ok(thoughtOut.includes('<think>keep_inside_tool</think>'), 'vcpResilienceMask 必须保护工具载荷内 <think>');

    for (const step of [selfContainedDocSummaryTool.length, 7, 1]) {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < selfContainedDocSummaryTool.length; i += step) {
            events.push(...scanner.push(selfContainedDocSummaryTool.slice(i, i + step)));
        }
        events.push(...scanner.finish());
        assert.deepEqual(events.filter(e => e.type === 'tag').map(e => e.emotion), ['happy'],
            `emotionTags step=${step}: 自包含汇总示例不得早退泄漏 sad`);
        assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join('').trim(), 'Done.');
    }

    // 含真实纠偏指导的回执仍必须触发刹车
    const brokenWithGuidance = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」,',
        'content:「始」unclosed',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: VCP工具调用',
        '- 返回内容: [[VCP协议纠偏指导: code=ERR block=12345678]]',
        'VCP调用结果结束]]',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const brokenScanned = replaceToolRequestBlocks(brokenWithGuidance, () => '[BAD]', { stopAtProtocolWalls: true });
    assert.ok(!brokenScanned.includes('[BAD]'), '含纠偏指导的汇总块仍须触发刹车');
});

test('Step15 Client Regression 2 (P1): stripHiddenToolResults 修复前置未闭围栏跨入无 ROLE_DIVIDE_USER 包裹的 [HIDDEN] 截断围栏', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const truncatedHiddenWithoutRole = [
        '```',
        'unclosed',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        '- 工具名称: Secret',
        '- 返回内容:',
        '```',
        'SECRET_VALUE',
        'VCP调用结果结束]]',
        'Public text'
    ].join('\n');

    const stripped = contextSanitizer.stripHiddenToolResults(truncatedHiddenWithoutRole);
    assert.ok(!stripped.includes('SECRET_VALUE') && !stripped.includes('Secret'),
        'stripHiddenToolResults 不得因前部未闭围栏截断 [HIDDEN] 汇总而泄漏 SECRET_VALUE');
    assert.ok(stripped.includes('Public text'));
});

test('Step15 Client Regression 3 (P1): emotionTags VCP_TOOL_BATCH_START 必须按 batchId 精确配对 VCP_TOOL_BATCH_END', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');

    const batchId = '2026-11-27T03:00:00Z';
    const batchWithTemplateEndLiteral = [
        `<<<[VCP_TOOL_BATCH_START:${batchId}]>>>`,
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 返回内容: 源码片段 `<<<[VCP_TOOL_BATCH_END:${id}]>>>` 与 `<<<[VCP_TOOL_BATCH_END:other-batch]>>>`',
        'SECRET_AFTER_LITERAL <!--emo:angry 1.0-->',
        'VCP调用结果结束]]',
        `<<<[VCP_TOOL_BATCH_END:${batchId}]>>>`,
        '<!--emo:happy 0.9-->批次安全结束！'
    ].join('\n');

    for (const step of [batchWithTemplateEndLiteral.length, 7, 1]) {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < batchWithTemplateEndLiteral.length; i += step) {
            events.push(...scanner.push(batchWithTemplateEndLiteral.slice(i, i + step)));
        }
        events.push(...scanner.finish());
        assert.deepEqual(events.filter(e => e.type === 'tag').map(e => e.emotion), ['happy'],
            `batchId exact match step=${step}: 不得在字面量 VCP_TOOL_BATCH_END 处提前退出泄漏 angry`);
        const textOut = events.filter(e => e.type === 'text').map(e => e.text).join('');
        assert.ok(!textOut.includes('SECRET_AFTER_LITERAL') && !textOut.includes(']>>>'),
            `batchId exact match step=${step}: 不得泄漏 SECRET_AFTER_LITERAL 与协议尾标`);
        assert.equal(textOut.trim(), '批次安全结束！');
    }
});

test('Step16 Client C1 Regression 1 (P1): 屏蔽行内反引号伪造 TOOL_REQUEST/DailyNote/ESCAPE 保护域，消除 <think> 与 [HIDDEN] 泄漏', async () => {
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    // 复现 1a：行内 `「始ESCAPE」` 与 `「末ESCAPE」` 夹 <think>
    const inlineEscapeAroundThink = [
        '请使用 `「始ESCAPE」` 包裹参数。',
        '<think>',
        '内部推理机密',
        '</think>',
        '并用 `「末ESCAPE」` 闭合。'
    ].join('\n');
    const outEscapeThink = contextSanitizer.stripThoughtChains(inlineEscapeAroundThink);
    assert.ok(!outEscapeThink.includes('内部推理机密') && !outEscapeThink.includes('<think>'),
        '行内反引号里的 「始ESCAPE」...「末ESCAPE」 不得伪造保护域导致 <think> 泄漏');
    assert.ok(outEscapeThink.includes('`「始ESCAPE」`') && outEscapeThink.includes('`「末ESCAPE」`'));

    // 复现 1b：行内 `<<<DailyNoteStart>>>` 与 `<<<DailyNoteEnd>>>` 夹 <think>
    const inlineDailyAroundThink = [
        '请使用 `<<<DailyNoteStart>>>` 与 `<<<DailyNoteEnd>>>` 包裹日记。',
        '<think>',
        '日记外推理机密',
        '</think>',
        '保留结论。'
    ].join('\n');
    const outDailyThink = contextSanitizer.stripThoughtChains(inlineDailyAroundThink);
    assert.ok(!outDailyThink.includes('日记外推理机密') && !outDailyThink.includes('<think>'));
    assert.ok(outDailyThink.includes('`<<<DailyNoteStart>>>`') && outDailyThink.includes('保留结论。'));

    // 复现 2：带空格行内反引号 `example <<<[TOOL_REQUEST]>>> ` 与 ` <<<[END_TOOL_REQUEST]>>> example` 夹 [HIDDEN]
    const inlineToolAroundHidden = [
        '用法：`example <<<[TOOL_REQUEST]>>> `',
        '[[VCP调用结果信息汇总: [HIDDEN]',
        '- 工具名称: SecretTool',
        '- 返回内容: SECRET_TOKEN_123',
        'VCP调用结果结束]]',
        '以及 ` <<<[END_TOOL_REQUEST]>>> example`'
    ].join('\n');
    const fwd = sanitizeForwardedContent(inlineToolAroundHidden);
    assert.ok(!fwd.includes('SECRET_TOKEN_123') && !fwd.includes('SecretTool'),
        'forwardMessageOwner 不得因带空格行内反引号伪造 TOOL_REQUEST 保护域而泄漏 SECRET_TOKEN_123');
    assert.ok(fwd.includes('`example <<<[TOOL_REQUEST]>>> `') && fwd.includes('` <<<[END_TOOL_REQUEST]>>> example`'));

    const speech = speechSourceToText(inlineToolAroundHidden);
    assert.ok(!speech.includes('SECRET_TOKEN_123') && !speech.includes('SecretTool'),
        'streamSpeech 不得因带空格行内反引号伪造 TOOL_REQUEST 保护域而泄漏 SECRET_TOKEN_123');
});

test('Step16 Client C1 Regression 2 (P1): 字段内闭合围栏放行按 batchId 严格配对闭合的 VCP_TOOL_BATCH_START/END', async () => {
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');

    const contentBeforeToolNameWithBatchFence = [
        '<<<[TOOL_REQUEST]>>>',
        'content:「始」',
        '```text',
        '<<<[VCP_TOOL_BATCH_START:b1]>>>',
        'ok',
        '<!--emo:sad 0.9-->',
        '<<<[VCP_TOOL_BATCH_END:b1]>>>',
        '```',
        '「末」,',
        'tool_name:「始」FileOperator「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<!--emo:happy 0.9-->完成。'
    ].join('\n');

    const fields = [];
    const scanned = replaceToolRequestBlocks(contentBeforeToolNameWithBatchFence, (_full, body) => {
        fields.push(readToolRequestField(body, 'tool_name'));
        return '[FILE_OP_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.deepEqual(fields, ['FileOperator'], 'toolRequestScanner 必须放行配平 VCP_TOOL_BATCH 围栏并识别后续 tool_name');
    assert.ok(scanned.includes('[FILE_OP_CARD]') && scanned.includes('完成。'));

    const projected = projectMemoryProtocols(contentBeforeToolNameWithBatchFence);
    assert.ok(projected.includes('调用了 FileOperator 工具。') && projected.includes('完成。'));
    assert.ok(!projected.includes('「末」'), 'memoryProtocolProjection 不得丢失工具名或泄漏 「末」');

    const scanner = createEmotionTagScanner();
    const events = [...scanner.push(contentBeforeToolNameWithBatchFence), ...scanner.finish()];
    assert.deepEqual(events.filter(e => e.type === 'tag').map(e => e.emotion), ['happy'],
        'emotionTags 不得因字段内配平批次围栏提前退出泄漏 sad');
    assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join('').trim(), '完成。');
});

test('Step17 Client C2 Regression (P1): 前置闭合围栏与多词行内反引号内的 TOOL_REQUEST 字面量不得误置前置未闭工具标志', async () => {
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    // 1. 前序闭合代码块内含未闭 TOOL_REQUEST 字面量 + 后续闭合围栏含 ROLE_DIVIDE_USER + <think> / TOOL_REQUEST
    const priorFenceWithLiteralTool = [
        '```js',
        'const marker = "<<<[TOOL_REQUEST]>>>\ntool_name:「始」Demo「末」";',
        '```',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<think>keep_in_doc_fence</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DocExample「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '后文保留！'
    ].join('\n');

    assert.equal(
        replaceToolRequestBlocks(priorFenceWithLiteralTool, () => '[SHOULD_NOT_REPLACE]', { stopAtProtocolWalls: true }),
        priorFenceWithLiteralTool,
        'toolRequestScanner: 前序闭合围栏中的 TOOL_REQUEST 字面量不得误拆后续文档围栏'
    );
    const thoughtFromFence = contextSanitizer.stripThoughtChains(priorFenceWithLiteralTool);
    assert.ok(thoughtFromFence.includes('<think>keep_in_doc_fence</think>'),
        'vcpResilienceMask: 前序闭合围栏中的 TOOL_REQUEST 字面量不得误拆后续围栏导致 <think> 被剥');
    const fwdFromFence = sanitizeForwardedContent(priorFenceWithLiteralTool);
    assert.ok(fwdFromFence.includes('DocExample') && fwdFromFence.includes('后文保留！'));

    // 2. 前序多词行内反引号内含未闭 TOOL_REQUEST 字面量 + 后续闭合围栏含 ROLE_DIVIDE_USER + <think> / TOOL_REQUEST
    const priorInlineWithLiteralTool = [
        '说明：`const ex = "<<<[TOOL_REQUEST]>>> tool_name:「始」Demo「末」";` 仅作展示。',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<think>keep_after_inline</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」InlineDocExample「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '行内测试后文保留！'
    ].join('\n');

    assert.equal(
        replaceToolRequestBlocks(priorInlineWithLiteralTool, () => '[SHOULD_NOT_REPLACE]', { stopAtProtocolWalls: true }),
        priorInlineWithLiteralTool,
        'toolRequestScanner: 前序多词行内反引号中的 TOOL_REQUEST 字面量不得误拆后续文档围栏'
    );
    const thoughtFromInline = contextSanitizer.stripThoughtChains(priorInlineWithLiteralTool);
    assert.ok(thoughtFromInline.includes('<think>keep_after_inline</think>'),
        'vcpResilienceMask: 前序多词行内反引号中的 TOOL_REQUEST 字面量不得误拆后续围栏导致 <think> 被剥');
    const fwdFromInline = sanitizeForwardedContent(priorInlineWithLiteralTool);
    assert.ok(fwdFromInline.includes('InlineDocExample') && fwdFromInline.includes('行内测试后文保留！'));
});

test('Step18 Client C3 Regression 1 (P1): 非 ESCAPE 字段内放行非新调用的行首孤立 TOOL_REQUEST 与配平 VCP_TOOL_BATCH，真实跨块仍刹车', async () => {
    const { replaceToolRequestBlocks, readToolRequestField } = await import('../modules/renderer/toolRequestScanner.js');
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { speechSourceToText } = await import('../modules/renderer/streamSpeech.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { projectMemoryProtocols } = require('../VCPDistributedServer/shared/memoryProtocolProjection');
    const contextSanitizer = require('../modules/contextSanitizer');

    // 1. 字段内行首孤立 <<<[TOOL_REQUEST]>>> + 普通散文
    const isolatedToolHeaderDoc = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」, ',
        'Content:「始」',
        '笔记内容：',
        '<<<[TOOL_REQUEST]>>>',
        '这是协议头。',
        '<think>keep_in_note</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '日记已记录！'
    ].join('\n');

    const fields = [];
    const scanned = replaceToolRequestBlocks(isolatedToolHeaderDoc, (_full, body) => {
        fields.push(readToolRequestField(body, 'Content'));
        return '[NOTE_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(fields.length, 1, 'toolRequestScanner 必须放行字段内行首孤立协议头');
    assert.ok(fields[0].includes('这是协议头。') && scanned.includes('[NOTE_CARD]') && scanned.includes('日记已记录！'));
    assert.equal(sanitizeForwardedContent(isolatedToolHeaderDoc), '日记已记录！');
    assert.equal(speechSourceToText(isolatedToolHeaderDoc), '日记已记录！');
    assert.ok(contextSanitizer.stripThoughtChains(isolatedToolHeaderDoc).includes('<think>keep_in_note</think>'));
    const projectedNote = projectMemoryProtocols(isolatedToolHeaderDoc);
    assert.ok(projectedNote.includes('调用了 DailyNote 工具。') && projectedNote.includes('日记已记录！') && !projectedNote.includes('「末」'));

    // 2. 字段内紧跟真实字段声明的未闭块仍必须刹车
    const realNewToolAfterUnclosed = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DailyNote「末」, ',
        'Content:「始」未闭合载荷',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」RealJump2「末」',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    const realScanned = replaceToolRequestBlocks(
        realNewToolAfterUnclosed,
        (full) => (full.includes('DailyNote') ? '[BAD_MERGED]' : '[JUMP2_OK]'),
        { stopAtProtocolWalls: true }
    );
    assert.ok(!realScanned.includes('[BAD_MERGED]') && realScanned.includes('[JUMP2_OK]'),
        '紧跟真实字段声明的跨块 TOOL_REQUEST 仍必须刹车，绝不得吞并第 1 跳与第 2 跳');

    // 3. 字段内按 batchId 严格配对闭合的 VCP_TOOL_BATCH_START/END 放行
    const pairedBatchInField = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」FileOperator「末」, ',
        'Content:「始」',
        '<<<[VCP_TOOL_BATCH_START:b1]>>>',
        '批次回执示例',
        '<<<[VCP_TOOL_BATCH_END:b1]>>>',
        '<think>keep_after_batch</think>',
        '「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '批次文档保存完成！'
    ].join('\n');
    const batchFields = [];
    const scannedBatch = replaceToolRequestBlocks(pairedBatchInField, (_full, body) => {
        batchFields.push(readToolRequestField(body, 'Content'));
        return '[BATCH_DOC_CARD]';
    }, { stopAtProtocolWalls: true });
    assert.equal(batchFields.length, 1);
    assert.ok(scannedBatch.includes('[BATCH_DOC_CARD]') && scannedBatch.includes('批次文档保存完成！'));
    assert.ok(contextSanitizer.stripThoughtChains(pairedBatchInField).includes('<think>keep_after_batch</think>'));
    const projectedBatch = projectMemoryProtocols(pairedBatchInField);
    assert.ok(projectedBatch.includes('调用了 FileOperator 工具。') && projectedBatch.includes('批次文档保存完成！') && !projectedBatch.includes('「末」'));
});

test('Step18 Client C3 Regression 2 (P1): 前置闭合 ESCAPE 字段内 TOOL_REQUEST 不得误置前置未闭工具标志', async () => {
    const { replaceToolRequestBlocks } = await import('../modules/renderer/toolRequestScanner.js');
    const { sanitizeForwardedContent } = await import('../modules/renderer/forwardMessageOwner.js');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const contextSanitizer = require('../modules/contextSanitizer');

    const priorEscapeThenFence = [
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」WriteDoc「末」, ',
        'content:「始ESCAPE」',
        '示例：',
        '<<<[TOOL_REQUEST]>>>',
        '「末ESCAPE」',
        '<<<[END_TOOL_REQUEST]>>>',
        '```markdown',
        '<<<[ROLE_DIVIDE_USER]>>>',
        '<think>keep_after_escape_tool</think>',
        '<<<[TOOL_REQUEST]>>>',
        'tool_name:「始」DocSample「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '```',
        '正常总结保留！'
    ].join('\n');

    const replaced = replaceToolRequestBlocks(priorEscapeThenFence, (full) => (
        full.includes('WriteDoc') ? '[WRITE_DOC]' : '[SHOULD_NOT_REPLACE]'
    ), { stopAtProtocolWalls: true });
    assert.ok(replaced.includes('[WRITE_DOC]') && !replaced.includes('[SHOULD_NOT_REPLACE]'),
        '前置 ESCAPE 内的字面 TOOL_REQUEST 不得误拆后续闭合文档围栏');
    assert.ok(replaced.includes('DocSample'));

    assert.ok(contextSanitizer.stripThoughtChains(priorEscapeThenFence).includes('<think>keep_after_escape_tool</think>'),
        'vcpResilienceMask 不得被前置 ESCAPE 误导而拆毁后续代码块中的 <think>');
    const fwd = sanitizeForwardedContent(priorEscapeThenFence);
    assert.ok(fwd.includes('DocSample') && fwd.includes('正常总结保留！'));
});

test('Step18 Client C3 Regression 3 (P1): emotionTags ROLE_DIVIDE_USER 跳过嵌套结果/批次/围栏中的 END_ROLE_DIVIDE_USER 字面量', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanWithStep = (text, step) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    const roleWithNestedEndLiteral = [
        '<<<[ROLE_DIVIDE_USER]>>>',
        '[[VCP调用结果信息汇总:',
        '- 工具名称: FileOperator',
        '- 执行状态: ✅ SUCCESS',
        '- 返回内容: 文件源码包含：',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        'SECRET_DATA <!--emo:angry 0.9-->',
        'VCP调用结果结束]]',
        '<<<[END_ROLE_DIVIDE_USER]>>>',
        '<!--emo:happy 0.9-->真实安全回复！'
    ].join('\n');

    for (const step of [roleWithNestedEndLiteral.length, 7, 1]) {
        const res = scanWithStep(roleWithNestedEndLiteral, step);
        assert.deepEqual(res.tags, ['happy'], `step=${step}: 不得在结果内 END_ROLE_DIVIDE_USER 字面量处早退泄漏 angry`);
        assert.ok(!res.text.includes('SECRET_DATA') && !res.text.includes('END_ROLE_DIVIDE_USER'),
            `step=${step}: 不得泄漏 SECRET_DATA`);
        assert.equal(res.text.trim(), '真实安全回复！');
    }
});

test('Step18 Client C3 Regression 4 (P2): emotionTags 严格校验 [--- VCP元思考链 与 <thought> 独立整行开标', async () => {
    const { createEmotionTagScanner } = await import('../modules/emotion/emotionTags.js');
    const scanWithStep = (text, step) => {
        const scanner = createEmotionTagScanner();
        const events = [];
        for (let i = 0; i < text.length; i += step) events.push(...scanner.push(text.slice(i, i + step)));
        events.push(...scanner.finish());
        return {
            tags: events.filter(e => e.type === 'tag').map(e => e.emotion),
            text: events.filter(e => e.type === 'text').map(e => e.text).join(''),
        };
    };

    const nonStandaloneVcpAndThought = [
        '[--- VCP元思考链 ---] 是系统思考链标记。',
        '<thought> 是思考标签。',
        '<!--emo:happy 0.8-->正常回复。'
    ].join('\n');

    for (const step of [nonStandaloneVcpAndThought.length, 7, 1]) {
        const res = scanWithStep(nonStandaloneVcpAndThought, step);
        assert.deepEqual(res.tags, ['happy'], `step=${step}: 同行带散文的思考标记不得吞掉后续 happy`);
        assert.ok(res.text.includes('正常回复。') && res.text.includes('是系统思考链标记'),
            `step=${step}: 正常正文必须全部保留`);
    }

    const inlineClosedVcp = '[--- VCP元思考链 ---] 内部思考 <!--emo:angry 0.9--> [--- 元思考链结束 ---]\n<!--emo:calm 0.7-->同行闭合保留。';
    for (const step of [inlineClosedVcp.length, 7, 1]) {
        const res = scanWithStep(inlineClosedVcp, step);
        assert.deepEqual(res.tags, ['calm'], `inline VCP step=${step}: 同行闭合元思考链仍须屏蔽内部 angry 并放行 calm`);
        assert.equal(res.text.trim(), '同行闭合保留。');
    }
});
