import test from 'node:test';
import assert from 'node:assert/strict';
import {
    estimateTextTokens,
    measureContextTokens,
    shouldCompactContext,
} from '../modules/chat/contextCompactionService.js';
import { COMPACTION_KIND } from '../modules/chat/contextCompactionState.js';
import { createStreamTransientHistory, normalizeContextUsage } from '../modules/chat/streamTransientHistory.js';
import { createVcpStreamBridge } from '../modules/chat/vcpStreamBridge.js';

const checkpoint = text => ({
    id: 'cp', role: 'user', content: '',
    contextCompaction: { kind: COMPACTION_KIND, version: 1, checkpoint: text },
});

test('local estimate weighs Chinese characters double over a divisor of three', () => {
    assert.equal(estimateTextTokens(''), 0);
    assert.equal(estimateTextTokens('abcdef'), 2);
    assert.equal(estimateTextTokens('你好世界'), 3);
    assert.equal(estimateTextTokens('你好 ab'), Math.ceil((2 * 2 + 3) / 3));
});

test('without provider usage the system prompt and every message are estimated', () => {
    const measured = measureContextTokens([
        { id: 'u', role: 'user', content: 'abcdef' },
        { id: 'a', role: 'assistant', content: '你好世界' },
    ], 'abc');
    assert.deepEqual(measured, { total: 1 + 2 + 3, fixed: 1, source: 'estimate' });
});

test('the latest provider usage is the base and only the anchor reply and later messages are estimated', () => {
    const history = [
        { id: 'u1', role: 'user', content: 'x'.repeat(3000) },
        { id: 'a1', role: 'assistant', content: 'old', contextUsage: { inputTokens: 500, outputTokens: 10 } },
        { id: 'u2', role: 'user', content: 'y'.repeat(300) },
        { id: 'a2', role: 'assistant', content: 'abcdef', contextUsage: { inputTokens: 9000, outputTokens: 2 } },
        { id: 'u3', role: 'user', content: 'abc' },
    ];
    const measured = measureContextTokens(history, 'ignored once usage exists');
    assert.equal(measured.source, 'provider_usage');
    assert.equal(measured.total, 9000 + 2 + 1);
    // 基准覆盖的消息估算为 1000 + 1 + 100，剩下的是展开后的系统提示词等不可压缩部分。
    assert.equal(measured.fixed, 9000 - 1101);
});

test('messages edited or deleted before the anchor are re-estimated', () => {
    const history = [
        { id: 'u1', role: 'user', content: 'x'.repeat(3000) },
        { id: 'a1', role: 'assistant', content: 'abc', contextUsage: { inputTokens: 5000, prefixEstimate: 1000 } },
    ];
    // 未改动：与上游计数一致
    assert.equal(measureContextTokens(history, '').total, 5000 + 1);
    // 前文被删掉一大段：上游计数里的 1000 被换成现在的估算 100
    const edited = [{ ...history[0], content: 'x'.repeat(300) }, history[1]];
    assert.deepEqual(measureContextTokens(edited, ''), { total: 4000 + 100 + 1, fixed: 4000, source: 'provider_usage' });
});

test('finalize records the estimate of the messages a usage covers', async () => {
    let current = [{ id: 'u', role: 'user', content: 'abcdef' }, { id: 'a', role: 'assistant', content: '' }];
    const provider = createStreamTransientHistory({
        repository: { async getHistory() { return []; } },
        currentHistory: { get: () => current, replace: history => { current = history; } },
    });
    await provider.prepare({ id: 'a', role: 'assistant' }, { agentId: 'x', topicId: 't' }, { visible: true });
    const finalized = await provider.finalize({
        messageId: 'a', context: { agentId: 'x', topicId: 't' }, content: 'ok',
        finishReason: 'completed', usage: { inputTokens: 50 }, visible: true,
    });
    assert.deepEqual(finalized.message.contextUsage, { inputTokens: 50, prefixEstimate: 2 });
});

test('usage recorded before the newest checkpoint is not used as the base', () => {
    const measured = measureContextTokens([
        { id: 'a0', role: 'assistant', content: 'old', contextUsage: { inputTokens: 99999 } },
        checkpoint('abcdef'),
        { id: 'u', role: 'user', content: 'abc' },
    ], '');
    assert.deepEqual(measured, { total: 2 + 1, fixed: 0, source: 'estimate' });
});

test('attachments count their extracted text and images', () => {
    const measured = measureContextTokens([{
        id: 'u', role: 'user', content: '',
        attachments: [
            { name: 'a.txt', _fileManagerData: { extractedText: 'abcdef' } },
            { name: 'p', type: 'image/png' },
        ],
    }], '');
    assert.equal(measured.total, Math.ceil(11 / 3) + 765);
});

test('compaction triggers on provider usage but not when the fixed part alone is over budget', () => {
    const config = { contextTokenLimit: 1000, systemPrompt: '' };
    const conversation = inputTokens => [
        { id: 'u1', role: 'user', content: 'x'.repeat(1500) },
        { id: 'a1', role: 'assistant', content: 'ok', contextUsage: { inputTokens } },
    ];
    // 500 个估算 token 的历史 + 450 的固定开销：超过 850 的阈值，压缩历史有效。
    assert.equal(shouldCompactContext(conversation(950), config, ''), true);
    assert.equal(shouldCompactContext(conversation(700), config, ''), false);
    // 固定开销 1500 - 500 = 1000 已超过阈值，压缩历史无法降到预算内，不再每轮重压。
    assert.equal(shouldCompactContext(conversation(1500), config, ''), false);
});

test('normalizeContextUsage keeps only provider-reported input and output counts', () => {
    assert.equal(normalizeContextUsage(null), undefined);
    assert.equal(normalizeContextUsage({ inputTokens: 10, estimated: true }), undefined);
    assert.equal(normalizeContextUsage({ inputTokens: 0, outputTokens: 5 }), undefined);
    assert.deepEqual(normalizeContextUsage({ inputTokens: 1200, outputTokens: 30, totalTokens: 1230, cachedInputTokens: 800 }),
        { inputTokens: 1200, outputTokens: 30 });
    assert.deepEqual(normalizeContextUsage({ prompt_tokens: 900, completion_tokens: 4, total_tokens: 904 }),
        { inputTokens: 900, outputTokens: 4 });
});

test('finalized stream messages record provider usage and drop a previous one', async () => {
    let current = [
        { id: 'a', role: 'assistant', content: '' },
        { id: 'b', role: 'assistant', content: 'old', contextUsage: { inputTokens: 7 } },
    ];
    const provider = createStreamTransientHistory({
        repository: { async getHistory() { return []; } },
        currentHistory: { get: () => current, replace: history => { current = history; } },
    });
    const finalize = async (messageId, usage) => {
        await provider.prepare({ id: messageId, role: 'assistant' }, { agentId: 'x', topicId: 't' }, { visible: true });
        return provider.finalize({
        messageId, context: { agentId: 'x', topicId: 't' }, content: 'new',
        finishReason: 'completed', usage, visible: true,
        });
    };
    assert.deepEqual((await finalize('a', { inputTokens: 4321, outputTokens: 12 })).message.contextUsage,
        { inputTokens: 4321, outputTokens: 12, prefixEstimate: 0 });
    // 重新生成的回复没有上游用量时，不能沿用上一版回复的用量。
    assert.equal((await finalize('b', undefined)).message.contextUsage, undefined);
    assert.equal(Object.hasOwn(current[1], 'contextUsage'), true);
});

test('the stream bridge carries end-event usage into the terminal', async () => {
    const persisted = [];
    const bridge = createVcpStreamBridge({
        createConsumer: () => ({ persist: value => { persisted.push(value.terminal); return null; } }),
    });
    const context = { agentId: 'x', topicId: 't' };
    bridge.accept({ type: 'start', messageId: 'm', context });
    bridge.accept({ type: 'end', messageId: 'm', context, usage: { inputTokens: 88 } });
    for (let i = 0; i < 20 && !persisted.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(persisted[0]?.usage, { inputTokens: 88 });
    await bridge.dispose();
});

test('sends outside the full preflight are refused when the measured context exceeds the limit', async () => {
    const { assertContextWithinLimit } = await import('../modules/chat/contextCompactionService.js');
    const history = [
        { id: 'u1', role: 'user', content: 'x'.repeat(300) },
        { id: 'a1', role: 'assistant', content: 'ok', contextUsage: { inputTokens: 900, prefixEstimate: 100 } },
    ];
    assert.doesNotThrow(() => assertContextWithinLimit(history, { contextTokenLimit: 1000 }, 'abc'));
    assert.throws(() => assertContextWithinLimit(history, { contextTokenLimit: 1000 }, 'y'.repeat(600)), /估算 1101 token，超过上限 1000/);
    // 没有设置上限时不检查。
    assert.doesNotThrow(() => assertContextWithinLimit(history, {}, 'y'.repeat(60000)));
});

test('the send preflight counts server-side overhead known from provider usage', async () => {
    const { preflightContextSend } = await import('../modules/chat/contextCompactionService.js');
    const electronAPI = {};
    const history = [
        { id: 'u1', role: 'user', content: 'abc' },
        { id: 'a1', role: 'assistant', content: 'ok', contextUsage: { inputTokens: 5000, prefixEstimate: 1 } },
    ];
    const pendingMessage = { id: 'u2', role: 'user', content: 'next' };
    const run = (contextTokenLimit, extra = {}) => preflightContextSend({
        electronAPI, agentConfig: { contextTokenLimit, systemPrompt: 'sys', ...extra }, context: { agentId: 'x', topicId: 't' },
        history, pendingMessage,
    });
    // 客户端能看到的文本只有十几个 token，但上一轮上游实际收到了 5000。
    assert.equal((await run(100000)).tokens >= 5000, true);
    // 不可压缩的部分已经超过上限：直接报错，不白白发起压缩。
    await assert.rejects(run(4000), /超过上限 4000/);
    // 设了消息窗口时只发送部分历史，整段话题的用量基准不适用。
    assert.ok((await run(4000, { contextMessageWindowSize: 1 })).tokens < 100);
});

test('message window: the hard check measures only the messages that will be sent', async () => {
    const { assertContextWithinLimit } = await import('../modules/chat/contextCompactionService.js');
    const history = [];
    for (let i = 0; i < 40; i++) {
        history.push({ role: 'user', content: 'q'.repeat(288) });
        history.push({ role: 'assistant', content: 'a'.repeat(288), contextUsage: { inputTokens: 5000 + i * 200 } });
    }
    // The whole topic is far over the limit, with or without the provider count.
    assert.throws(() => assertContextWithinLimit(history, { contextTokenLimit: 3000 }, 'next'), /超过上限 3000/);
    // Only the newest 10 messages are sent: about 1000 tokens.
    assert.doesNotThrow(() => assertContextWithinLimit(history, { contextTokenLimit: 3000, contextMessageWindowSize: 10 }, 'next'));
    assert.throws(() => assertContextWithinLimit(history, { contextTokenLimit: 800, contextMessageWindowSize: 10 }, 'next'), /超过上限 800/);
});

test('provider count below the local estimate scales the covered messages instead of ignoring it', async () => {
    const { measureContextTokens } = await import('../modules/chat/contextCompactionService.js');
    // The server shortened old tool results: 700 estimated locally, 295 actually received.
    const history = [
        { role: 'user', content: 'x'.repeat(2100) },
        { role: 'assistant', content: 'ok', contextUsage: { inputTokens: 295, prefixEstimate: 700 } },
        { role: 'user', content: 'y'.repeat(288) },
    ];
    const measured = measureContextTokens(history);
    assert.equal(measured.source, 'provider_usage');
    assert.equal(measured.total, 295 + 1 + 96);
});

test('compaction request cuts oversized stored tool results, leaves everything else alone', async () => {
    const { buildCompactionMessages, limitToolResultsForCompaction } = await import('../modules/chat/contextCompactionPrompts.js');
    const block = body => `[[VCP调用结果信息汇总:\n- 工具名称: X\n- 返回内容: ${body}\nVCP调用结果结束]]`;
    const huge = `先读文件。\n${block('旧'.repeat(500000))}\n结论：保留 src/core/kbm.rs。`;
    const messages = buildCompactionMessages({ messages: [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: huge },
        { role: 'assistant', content: `短的 ${block('ok')}` },
    ] });
    const sent = messages[2].content;
    assert.ok(sent.length < 25000);
    assert.ok(sent.startsWith('先读文件。\n[[VCP调用结果信息汇总:\n- 工具名称: X'));
    assert.ok(sent.endsWith('VCP调用结果结束]]\n结论：保留 src/core/kbm.rs。'));
    assert.match(sent, /中段已截断 \d+ 个字符/);
    assert.equal(messages[3].content, `短的 ${block('ok')}`);
    // An emoji on the cut never leaves half a surrogate pair behind.
    assert.ok(limitToolResultsForCompaction(block(`${'a'.repeat(17999)}${'🔍'.repeat(20000)}`)).isWellFormed());
});

test('a request refused for exceeding the context limit is an error, a tool loop stopped half-way is not', async () => {
    const { createRequire } = await import('node:module');
    const { chatResponseError } = createRequire(import.meta.url)('../modules/chatRequestError.js');
    const chunk = stage => ({ vcp_incomplete: true, vcp_context_budget: { stage, estimated: 10, limit: 5 },
        choices: [{ index: 0, delta: { content: '[ERROR] 本次请求展开后估算 10 token，超过上下文上限 5，未发送给模型。' }, finish_reason: 'stop' }] });
    const refusal = chatResponseError(chunk('outbound'));
    assert.equal(refusal.isChatResponseError, true);
    assert.equal(refusal.message, '本次请求展开后估算 10 token，超过上下文上限 5，未发送给模型。');
    assert.equal(chatResponseError(chunk('tool_loop')), null);
    assert.equal(chatResponseError({ choices: [{ delta: { content: 'hi' } }] }), null);
});
