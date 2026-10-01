import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatDuration, finishReasonLabel, effectiveFinishReason, sourceLabel, extractToolCalls, expandMessage, buildOutputRows, buildTimeline,
    summarizeRecords, buildSearchIndex, findTextMatches, normalizeQuery, messagePreview, messageContent, toolHasError, toolMetadata,
    inputRowKey, outputRowKey
} from '../modules/ui-system/side-pane/modelTrajectoryModel.js';

const REQ = (name, body = '') => `<<<[TOOL_REQUEST]>>>\ntool_name:「始」${name}「末」,\n${body}\n<<<[END_TOOL_REQUEST]>>>`;
const RES = (name, status, content) => `[[VCP调用结果信息汇总:- 工具名称: ${name}\n- 执行状态: ${status}\n- 返回内容: ${content}VCP调用结果结束]]`;
const msg = (role, text) => ({ role, parts: [{ kind: 'text', text }] });
const record = (id, messages, response = null, extra = {}) => ({ id, requestId: id, startedAt: 1000, durationMs: 1500, source: { kind: 'main' }, model: { modelId: 'm1' }, request: { messages }, response, ...extra });

test('duration and labels follow ZCode formatting', () => {
    assert.equal(formatDuration(850), '850ms');
    assert.equal(formatDuration(8540), '8.54s');
    assert.equal(formatDuration(12340), '12.3s');
    assert.equal(formatDuration(undefined), '—');
    assert.equal(finishReasonLabel('tool_calls'), '工具调用');
    assert.equal(finishReasonLabel('length'), '达到长度限制');
    assert.equal(finishReasonLabel('weird'), 'weird');
    assert.equal(sourceLabel({ kind: 'title' }), '标题生成');
    assert.equal(sourceLabel(undefined), '主会话');
});

test('TOOL_REQUEST blocks in assistant text become tool calls and are removed from the prose', () => {
    const { text, toolCalls } = extractToolCalls(`先看看。\n${REQ('FileOperator', 'command:「始」ReadFile「末」,\nfilePath:「始」C:/a.txt「末」')}\n稍等。`);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].toolName, 'FileOperator');
    assert.match(toolCalls[0].input, /command: ReadFile/);
    assert.match(toolCalls[0].input, /filePath: C:\/a\.txt/);
    assert.ok(!toolCalls[0].input.includes('tool_name'));
    assert.equal(text, '先看看。\n\n稍等。'.replace('\n\n', '\n\n'));
    assert.deepEqual(extractToolCalls('没有工具'), { text: '没有工具', toolCalls: [] });
});

test('VCP result blocks inside a user message become separate tool messages, failures are errors', () => {
    const expanded = expandMessage(msg('user', `${RES('FileOperator', 'success', '内容A')}\n${RES('DailyNote', 'error', 'boom')}\n谢谢`));
    assert.deepEqual(expanded.map(m => m.role), ['tool', 'tool', 'user']);
    assert.equal(toolMetadata(expanded[0]).names, 'FileOperator');
    assert.equal(toolHasError(expanded[0]), false);
    assert.equal(toolHasError(expanded[1]), true);
    assert.match(messageContent(expanded[1]), /boom/);
    assert.match(messagePreview(expanded[0]), /内容A/);
    assert.equal(expandMessage(msg('user', '普通消息')).length, 1);
    assert.deepEqual(expandMessage(null), []);
});

test('output rows: reasoning, prose, and tool calls from both OpenAI tool_calls and request blocks', () => {
    const rows = buildOutputRows({
        reasoningText: '想想', text: `好的\n${REQ('A', 'x:「始」1「末」')}`,
        toolCalls: [{ kind: 'tool-call', toolCallId: 'call_9', toolName: 'native', input: { q: 1 } }]
    });
    assert.deepEqual(rows.map(r => r.key), ['reasoning', 'message', 'tool-call:0', 'tool-call:1']);
    assert.equal(rows[0].visualRole, 'reasoning');
    assert.equal(rows[2].visualRole, 'tool-call');
    assert.equal(toolMetadata(rows[2].message).ids, '9');
    assert.deepEqual(buildOutputRows(null), []);
});

test('timeline shows the full context first, then only new non-assistant messages; title calls stay whole', () => {
    const first = record('r1', [msg('system', 'sys'), msg('user', 'hi')]);
    const second = record('r2', [msg('system', 'sys'), msg('user', 'hi'), msg('assistant', '好'), msg('user', `${RES('T', 'success', 'ok')}`)]);
    const title = record('r3', [msg('user', '总结标题')], null, { source: { kind: 'title' } });
    const third = record('r4', [msg('system', 'sys'), msg('user', 'hi'), msg('assistant', '好'), msg('user', 'x'), msg('assistant', 'y'), msg('user', 'next')]);
    const items = buildTimeline([first, second, title, third]);
    assert.equal(items[0].inputMessages.length, 2);
    assert.deepEqual(items[1].inputMessages.map(m => m.role), ['tool']);
    assert.equal(items[2].inputMessages.length, 1, 'title prompt is never hidden');
    assert.deepEqual(items[3].inputMessages.map(m => m.role), ['user'], 'delta continues across the title call, assistants dropped');
    assert.equal(buildTimeline([first, record('r5', [msg('user', 'same')])])[1].inputMessages.length, 1, 'shrunk history falls back to full');
    assert.equal(buildTimeline([first, record('r6', first.request.messages)])[1].inputMessages.length, 0, 'same length: nothing new');
    assert.deepEqual(buildTimeline([]), []);
});

test('summary adds tokens, flags estimates and lists models once', () => {
    const summary = summarizeRecords([
        record('a', [], { usage: { totalTokens: 100 } }), record('b', [], { usage: { totalTokens: 50, estimated: true } }),
        record('c', [], null, { model: { modelId: 'm2' } }), record('d', [])
    ]);
    assert.deepEqual(summary, { totalTokens: 150, estimated: true, models: ['m1', 'm2'] });
});

test('search folds whitespace and case, maps back to source offsets, and reaches tool names', () => {
    assert.equal(normalizeQuery('  Hello   World '), 'hello world');
    assert.deepEqual(findTextMatches('say  HELLO\n world, hello world', 'hello world'), [{ sourceStart: 5, sourceEnd: 17 }, { sourceStart: 19, sourceEnd: 30 }]);
    assert.deepEqual(findTextMatches('abc', ''), []);
    const items = buildTimeline([
        record('r1', [msg('user', 'find the NEEDLE here')], { text: `ok\n${REQ('FileOperator', 'k:「始」another needle「末」')}`, toolCalls: [] })
    ]);
    const index = buildSearchIndex(items, 'needle');
    assert.equal(index.matches.length, 2);
    assert.equal(index.matches[0].expansionKey, inputRowKey(items[0], 0));
    assert.equal(index.matches[1].expansionKey, outputRowKey(items[0], items[0].outputRows[1]));
    assert.equal(buildSearchIndex(items, 'fileoperator').matches[0].field, 'tool-name');
    assert.deepEqual(buildSearchIndex(items, '   ').matches, []);
});

test('a VCP server error relayed as a normal stream is not reported as a clean finish', () => {
    // 真实记录：上游连不上时服务器返回 200，正文是 [ERROR] 文本，finish_reason 仍是 stop
    const relayed = { finishReason: 'stop', text: '[ERROR] 代理服务器在连接上游API时失败: Fetch failed after all retries.' };
    assert.equal(effectiveFinishReason(relayed), 'error');
    assert.equal(finishReasonLabel(effectiveFinishReason(relayed)), '服务端报错');
    assert.equal(effectiveFinishReason({ finishReason: 'stop', text: '你好 [ERROR] 只是正文里提到' }), 'stop');
    assert.equal(effectiveFinishReason({ finishReason: 'length', text: '[ERROR] x' }), 'length');
    assert.equal(effectiveFinishReason(undefined), undefined);
});
