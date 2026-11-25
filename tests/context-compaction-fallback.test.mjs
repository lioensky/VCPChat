import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextCompactionService, requestContextCompaction } from '../modules/chat/contextCompactionService.js';
import { createCheckpointMessage } from '../modules/chat/contextCompactionPrompts.js';
import { prepareCompactionState, validateCheckpoint } from '../modules/chat/contextCompactionState.js';
import { assembleRequestMessages } from '../modules/chat/chatContextPipeline.js';

const settings = {
    enableContextCompaction: true,
    contextCompactionModel: 'primary',
    contextCompactionFallbackModel: '  backup  ',
    vcpServerUrl: 'https://fixture.local/v1/chatvcp/completions',
};
const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
const upstreamError = '[UPSTREAM_ERROR] 上游API返回状态码 503，错误信息: {"error":{"message":"No available channel"}}';
const report = '  任务状态：中转曾报告 [UPSTREAM_ERROR]，已保留历史。 \n';
function sse(...parts) {
    const events = [...parts.map(content => ({ delta: { content } })), { delta: {}, finish_reason: 'stop' }];
    return new Response(events.map(choice => `data: ${JSON.stringify({ choices: [choice] })}\r\n\r\n`).join('')
        + 'data: [DONE]\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
const badSse = () => sse(' \n[UPSTREAM_', upstreamError.slice('[UPSTREAM_'.length));

function fixture(options = {}) {
    let history = [{ id: 'original', role: 'user', content: '必须保留原始历史' }];
    const calls = [];
    const interrupts = [];
    let writes = 0;
    const service = createContextCompactionService({
        timeoutMs: options.timeoutMs ?? 1000,
        historyMutationAuthority: {
            async mutate(_scope, callback) {
                writes++;
                if (options.commitError) throw options.commitError;
                history = callback(history);
                return { history };
            },
        },
        request: attempt => {
            if (options.request) return options.request(attempt);
            return requestContextCompaction({
                ...attempt,
                fetchImpl: async (_url, init) => {
                    const body = JSON.parse(init.body);
                    calls.push(body);
                    return options.reply?.(body) ?? (body.model === 'primary' ? badSse() : sse(report));
                },
            });
        },
        interruptRequest: id => { interrupts.push(id); },
    });
    return {
        calls, service, interrupts,
        history: () => structuredClone(history),
        writes: () => writes,
        run: (config = settings) => service.compact({ scope, history, settings: config }),
    };
}

test('200 SSE error split across deltas switches models with identical input and commits once', async () => {
    const f = fixture();
    const result = await f.run();
    assert.deepEqual(f.calls.map(call => call.model), ['primary', 'backup']);
    assert.deepEqual(f.calls[0].messages, f.calls[1].messages);
    assert.notEqual(f.calls[0].requestId, f.calls[1].requestId);
    assert.equal(f.writes(), 1);
    assert.equal(result.history.length, 2);
    assert.equal(result.message.contextCompaction.checkpoint, report);
});

test('capacity rejection retries backup without trimming; primary success never calls backup', async () => {
    const rejected = fixture({ reply: body => body.model === 'primary'
        ? Response.json({ error: { code: 'context_length_exceeded' } }, { status: 400 })
        : sse(report) });
    await rejected.run();
    assert.deepEqual(rejected.calls[0].messages, rejected.calls[1].messages);
    assert.equal(rejected.writes(), 1);
    const successful = fixture({ reply: () => sse(report) });
    await successful.run();
    assert.deepEqual(successful.calls.map(call => call.model), ['primary']);
    assert.equal(successful.writes(), 1);
});

test('no fallback or duplicate model never writes the false checkpoint', async () => {
    for (const fallback of ['', ' primary ']) {
        const f = fixture();
        const before = f.history();
        await assert.rejects(f.run({ ...settings, contextCompactionFallbackModel: fallback }), /错误信封/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.writes(), 0);
        assert.deepEqual(f.history(), before);
    }
});

test('both failures preserve history and retain per-model diagnostics', async () => {
    const f = fixture({ reply: body => body.model === 'primary' ? badSse() : new Response(null, { status: 503 }) });
    const before = f.history();
    await assert.rejects(f.run(), error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /primary：.*错误信封.*backup：.*503/);
        assert.match(error.compactionDiagnostic, /No available channel/);
        assert.match(error.compactionDiagnostic, /模型：backup/);
        return true;
    });
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.history(), before);
    assert.equal(f.service.isBusy(scope), false);
});

test('shared authentication failure and commit failure do not switch models', async () => {
    for (const status of [401, 403]) {
        const f = fixture({ reply: () => new Response(null, { status }) });
        await assert.rejects(f.run(), new RegExp(`HTTP ${status}`));
        assert.equal(f.calls.length, 1);
        assert.equal(f.writes(), 0);
    }
    const f = fixture({ reply: () => sse(report), commitError: new Error('历史已变化') });
    await assert.rejects(f.run(), /历史已变化/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.writes(), 1);
});

test('timeout aborts only the first attempt; cancelling the backup targets its own request ID', async () => {
    const attempts = [];
    let backupStarted;
    const ready = new Promise(resolve => { backupStarted = resolve; });
    let resolveLate;
    const late = new Promise(resolve => { resolveLate = resolve; });
    const f = fixture({
        timeoutMs: 15,
        request(attempt) {
            attempts.push(attempt);
            if (attempts.length === 2) backupStarted();
            return late;
        },
    });
    const pending = f.run();
    const rejected = assert.rejects(pending, /已取消/);
    await ready;
    assert.equal(attempts[0].signal.aborted, true);
    assert.equal(attempts[1].signal.aborted, false);
    assert.notEqual(attempts[0].requestId, attempts[1].requestId);
    assert.equal(f.service.cancel(scope), true);
    await rejected;
    resolveLate(report);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts[1].signal.aborted, true);
    assert.deepEqual(f.interrupts, attempts.map(attempt => attempt.requestId));
    assert.equal(f.writes(), 0);
});

test('error validation is anchored and works after joining text parts; valid reports stay verbatim', () => {
    for (const value of [
        ' upstream_stalled: no worker',
        ' \n{ "error": {"message":"bad channel"}}',
        [{ type: 'text', text: '[UPSTREAM_' }, { type: 'output_text', text: 'ERROR] 503' }],
    ]) assert.throws(() => validateCheckpoint(value), /错误信封/);
    assert.equal(validateCheckpoint(report), report);
    assert.equal(validateCheckpoint('<context_checkpoint>只有开头'), '<context_checkpoint>只有开头');
});

test('legacy bad checkpoints do not hide preceding context or leak into actual requests', async () => {
    const previous = createCheckpointMessage({ diaries: [], warnings: [], sourceCount: 1 }, '有效旧报告');
    const bad = {
        ...previous, id: 'checkpoint_bad', content: `[宿主包装]\n${upstreamError}`,
        contextCompaction: { ...previous.contextCompaction, checkpoint: upstreamError },
    };
    const old = { role: 'user', content: '原始历史' };
    const after = { role: 'assistant', content: '后续历史' };
    const latest = { role: 'user', content: '最新输入' };
    for (const boundary of [[], [previous]]) {
        const history = [old, ...boundary, after, bad, latest];
        const before = structuredClone(history);
        const state = prepareCompactionState(history);
        assert.deepEqual(state.messages.map(msg => msg.content), [
            boundary.length ? '有效旧报告' : old.content, after.content, latest.content,
        ]);
        const result = await assembleRequestMessages({
            history, agentConfig: {}, context: { agentId: 'a', topicId: 't' }, electronAPI: {},
        });
        const wire = JSON.stringify(result.messagesForVCP);
        assert.ok(wire.includes(boundary.length ? '有效旧报告' : old.content));
        assert.equal(wire.includes(old.content), !boundary.length);
        assert.ok(wire.includes(after.content));
        assert.ok(wire.includes(latest.content));
        assert.ok(!wire.includes('[UPSTREAM_ERROR]'));
        assert.deepEqual(history, before);
    }
});